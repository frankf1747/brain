import type postgres from "postgres";
import { config } from "../config.js";
import type { Ctx } from "../ctx.js";
import { toVector, type Db } from "../db.js";
import { reciprocalRankFusion } from "./fuse.js";
import { triggerTerms } from "./fallback.js";
import { detectEntities, type EntityRef } from "./entities.js";

export interface SearchOptions {
  k?: number;
  sourceKinds?: string[];
  since?: Date;
  until?: Date;
  verifiedOnly?: boolean;
  includeFacts?: boolean;
  client?: string;
}

export type PassageGroup = "hybrid" | "graph" | "fallback";

export interface Passage {
  chunkId: string | null;
  documentId: string;
  documentTitle: string | null;
  sourceKind: string;
  /** Who wrote the passage's document: owner, other or unknown. */
  author: string;
  content: string;
  parentContent: string | null;
  headingPath: string[];
  charStart: number;
  charEnd: number;
  score: number;
  group: PassageGroup;
}

export interface DocHit {
  documentId: string;
  title: string | null;
  sourceKind: string;
  summary: string | null;
  score: number;
}

export interface Neighbor {
  id: string;
  type: string;
  name: string;
  depth: number;
}

export interface EntityHit extends EntityRef {
  neighbors: Neighbor[];
}

export interface FactRow {
  id: string;
  predicate: string;
  objectText: string;
  confidence: number | null;
  verified: boolean;
  sourceChunkId: string | null;
}

export interface SearchResult {
  query: string;
  passages: Passage[];
  documents: DocHit[];
  entities: EntityHit[];
  facts: FactRow[];
  usedFallback: boolean;
  topScore: number | null;
  /** True when the query embedding or the reranker failed and results come from keyword search and fused order. */
  degraded: boolean;
}

interface ChunkRow {
  id: string;
  document_id: string;
  content: string;
  heading_path: string[];
  context_prefix: string;
  char_start: number;
  char_end: number;
  parent_content: string | null;
  document_title: string | null;
  source_kind: string;
  author: string;
}

async function loadChunks(sql: Db, ids: string[]): Promise<Map<string, ChunkRow>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<ChunkRow[]>`
    select c.id, c.document_id, c.content, c.heading_path, c.context_prefix, c.char_start, c.char_end,
           p.content as parent_content, d.title as document_title, d.source_kind, d.author
    from brain.chunks c
    left join brain.chunks p on p.id = c.parent_id
    join brain.documents d on d.id = c.document_id
    where c.id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

function toPassage(row: ChunkRow, score: number, group: PassageGroup): Passage {
  return {
    chunkId: row.id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    sourceKind: row.source_kind,
    author: row.author,
    content: row.content,
    parentContent: row.parent_content,
    headingPath: row.heading_path,
    charStart: row.char_start,
    charEnd: row.char_end,
    score,
    group,
  };
}

/** The same date window hybrid_search and summary_search apply, for queries that read documents directly. */
function inDateRange(sql: Db, alias: string, since: Date | null, until: Date | null) {
  const at = sql`coalesce(${sql(alias)}.occurred_at, ${sql(alias)}.ingested_at)`;
  return sql`(${since}::timestamptz is null or ${at} >= ${since}::timestamptz)
    and (${until}::timestamptz is null or ${at} <= ${until}::timestamptz)`;
}

export async function search(ctx: Ctx, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  if (!query.trim()) throw new Error("Search query is empty");
  const { sql } = ctx;
  const k = opts.k ?? config.retrieval.defaultK;
  const kinds = opts.sourceKinds ?? null;
  const since = opts.since ?? null;
  const until = opts.until ?? null;

  let degraded = false;
  let qvec: string | null = null;
  try {
    const [queryVector] = await (ctx.queryEmbedder ?? ctx.embedder).embed([query], "query");
    qvec = toVector(queryVector);
  } catch (err) {
    degraded = true;
    process.stderr.write(`brain: query embedding failed, keyword search only: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // pgvector 0.8: with iterative scans the HNSW index keeps going until `limit k` rows satisfy the
  // source_kind/date filters; ef_search = greatest(4 * candidateK, 100) bounds the first pass (spec §3.1).
  // SET LOCAL needs a transaction; the two searches share its connection and run one after the other.
  const efSearch = Math.max(4 * config.retrieval.candidateK, 100);
  const [[chunkCands, docCands], entityRefs] = await Promise.all([
    sql.begin(async (tx) => {
      await tx.unsafe(`set local hnsw.iterative_scan = 'relaxed_order'; set local hnsw.ef_search = ${efSearch}`);
      return Promise.all([
        tx<{ chunk_id: string; vector_rank: number | null; keyword_rank: number | null }[]>`
          select chunk_id, vector_rank, keyword_rank
          from brain.hybrid_search(${query}, ${qvec}::vector, ${config.retrieval.candidateK}, ${kinds}::text[], ${since}, ${until})`,
        tx<{ document_id: string; vector_rank: number | null; keyword_rank: number | null }[]>`
          select document_id, vector_rank, keyword_rank
          from brain.summary_search(${query}, ${qvec}::vector, ${config.retrieval.candidateK}, ${kinds}::text[], ${since}, ${until})`,
      ]);
    }),
    detectEntities(sql, query),
  ]);

  // Layer 2: fused candidates, reranked.
  const fused = reciprocalRankFusion(chunkCands.map((c) => ({ id: c.chunk_id, vectorRank: c.vector_rank, keywordRank: c.keyword_rank })));
  const rows = await loadChunks(sql, fused.map((f) => f.id));
  const present = fused.filter((f) => rows.has(f.id));
  const ordered = present.map((f) => rows.get(f.id)!);
  const fusedOrder = () => present.slice(0, k).map((f, index) => ({ index, score: f.fused }));
  let reranked: { index: number; score: number }[] = [];
  if (ordered.length && qvec === null) {
    // Voyage just failed for the query embedding; a rerank call would most likely fail too, after its own retries.
    reranked = fusedOrder();
  } else if (ordered.length) {
    try {
      reranked = await (ctx.queryReranker ?? ctx.reranker).rerank(
        query,
        ordered.map((r) => (r.context_prefix ? r.context_prefix + "\n\n" : "") + r.content),
        k,
      );
    } catch (err) {
      degraded = true;
      process.stderr.write(`brain: reranking failed, keeping fused order: ${err instanceof Error ? err.message : String(err)}\n`);
      reranked = fusedOrder();
    }
  }
  const passages: Passage[] = reranked.map((h) => toPassage(ordered[h.index], h.score, "hybrid"));
  const seen = new Set(passages.map((p) => p.chunkId));

  // Layer 3: document summaries.
  // The summary pool is candidateK per branch; fusion orders it and the caller sees the top k.
  const docFused = reciprocalRankFusion(
    docCands.map((d) => ({ id: d.document_id, vectorRank: d.vector_rank, keywordRank: d.keyword_rank })),
  ).slice(0, k);
  const docRows = docFused.length
    ? await sql<{ id: string; title: string | null; source_kind: string; summary: string | null }[]>`
        select id, title, source_kind, summary from brain.documents where id = any(${docFused.map((d) => d.id)}::uuid[])`
    : [];
  const documents: DocHit[] = docFused
    .map((d) => {
      const r = docRows.find((x) => x.id === d.id);
      return r ? { documentId: r.id, title: r.title, sourceKind: r.source_kind, summary: r.summary, score: d.fused } : null;
    })
    .filter((d): d is DocHit => d !== null);

  // Layer 4: graph expansion from entities named in the query, with budgets (spec §3.5).
  const entities: EntityHit[] = [];
  for (const ref of entityRefs) {
    const neighbors = await sql<Neighbor[]>`
      select nb.node_id as id, x.type, x.name, nb.depth
      from brain.neighbors(${ref.id}, 1, null) nb
      join brain.nodes x on x.id = nb.node_id
      left join brain.edges e on e.id = nb.via_edge
      where nb.depth > 0 and ${opts.verifiedOnly ? sql`x.verified` : sql`true`}
      order by nb.depth, e.confidence desc nulls last, x.name
      limit ${config.graph.maxNeighbors}`;
    entities.push({ ...ref, neighbors });
    // A mention stored on a level-0 section (quote not located) maps to that section's first passage.
    const mentioned = await sql<{ id: string }[]>`
      select c.id
      from (
        select distinct case when c0.level = 1 then c0.id
                             else (select p.id from brain.chunks p where p.parent_id = c0.id order by p.ordinal limit 1) end as id
        from brain.mentions m join brain.chunks c0 on c0.id = m.chunk_id
        where m.node_id = any(brain.node_members(${ref.id}))
      ) pm
      join brain.chunks c on c.id = pm.id
      join brain.documents d on d.id = c.document_id
      where (${kinds}::text[] is null or d.source_kind = any(${kinds}::text[]))
        and ${inDateRange(sql, "d", since, until)}
      order by coalesce(d.occurred_at, d.ingested_at) desc, c.ordinal, c.id
      limit ${config.graph.maxPassagesPerEntity}`;
    const newIds = mentioned.map((m) => m.id).filter((id) => !seen.has(id));
    const extra = await loadChunks(sql, newIds);
    for (const id of newIds) {
      const row = extra.get(id);
      if (!row) continue;
      passages.push(toPassage(row, 0, "graph"));
      seen.add(row.id);
    }
  }

  // Layer 5: facts whose predicate or value shares a stem with the query, or whose object node is a
  // detected entity, capped. Entity-linked facts rank first so the cap never drops them (spec §3.5).
  // brain_orient and brain_get_facts still list every current fact.
  let facts: FactRow[] = [];
  if (opts.includeFacts !== false) {
    const entityIds = entityRefs.map((e) => e.id);
    const rowsF = await sql<{ id: string; predicate: string; object_text: string; confidence: number | null; verified: boolean; source_chunk_id: string | null }[]>`
      select f.id, f.predicate, f.object_text, f.confidence, f.verified, f.source_chunk_id
      from brain.current_facts(null) f
      cross join (select brain.query_to_tsquery(${query}) as q) q
      where ((q.q is not null and to_tsvector('english', replace(f.predicate, '_', ' ') || ' ' || f.object_text) @@ q.q)
             or brain.canonical_node(f.object_node_id) = any(${entityIds}::uuid[]))
        and ${opts.verifiedOnly ? sql`f.verified` : sql`true`}
      order by coalesce(brain.canonical_node(f.object_node_id) = any(${entityIds}::uuid[]), false) desc, f.verified desc, f.confidence desc nulls last, f.created_at desc, f.id
      limit ${config.graph.maxFacts}`;
    facts = rowsF.map((f) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text, confidence: f.confidence, verified: f.verified, sourceChunkId: f.source_chunk_id }));
  }

  // Fallback: literal substring scan for exact-string terms (codes, figures, versions), when the search
  // was degraded or the best reranked hit is weak. Natural-language queries have no trigger terms and skip it.
  // In degraded mode scores are RRF values (or keyword-only), so the threshold means nothing: always scan.
  const topScore = passages.find((p) => p.group === "hybrid")?.score ?? null;
  let usedFallback = false;
  const terms = triggerTerms(query);
  const weak = degraded || topScore === null || topScore < config.retrieval.fallbackThreshold;
  if (terms.length && weak) {
    const hits = await sql<{ id: string; title: string | null; source_kind: string; author: string; raw_content: string; matched: string[]; n: number }[]>`
      select d.id, d.title, d.source_kind, d.author, d.raw_content,
             array(select t from unnest(${terms}::text[]) with ordinality u(t, o)
                   where d.raw_content ilike '%' || brain.like_literal(t) || '%' order by o) as matched,
             (select count(*)::int from unnest(${terms}::text[]) t where d.raw_content ilike '%' || brain.like_literal(t) || '%') as n
      from brain.documents d
      where (${kinds}::text[] is null or d.source_kind = any(${kinds}::text[]))
        and ${inDateRange(sql, "d", since, until)}
        and d.raw_content ilike any (array(select '%' || brain.like_literal(t) || '%' from unnest(${terms}::text[]) t))
      order by n desc, coalesce(d.occurred_at, d.ingested_at) desc
      limit 10`;
    for (const h of hits) {
      usedFallback = true;
      const term = h.matched[0];
      const at = Math.max(0, h.raw_content.toLowerCase().indexOf(term.toLowerCase()));
      const start = Math.max(0, at - 200);
      const end = Math.min(h.raw_content.length, at + term.length + 200);
      passages.push({
        chunkId: null,
        documentId: h.id,
        documentTitle: h.title,
        sourceKind: h.source_kind,
        author: h.author,
        content: h.raw_content.slice(start, end),
        parentContent: null,
        headingPath: [],
        charStart: start,
        charEnd: end,
        score: 0,
        group: "fallback",
      });
    }
  }

  const layers = ["hybrid", "summary", ...(entities.length ? ["graph"] : []), ...(facts.length ? ["facts"] : []), ...(usedFallback ? ["fallback"] : []), ...(degraded ? ["degraded"] : [])];
  const filters = { sourceKinds: kinds, since, until, verifiedOnly: opts.verifiedOnly ?? false };
  await sql`
    insert into brain.retrieval_log (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client)
    values (${query}, ${sql.json(filters as unknown as postgres.JSONValue)}, ${layers}::text[],
            ${passages.map((p) => p.chunkId).filter((id): id is string => id !== null)}::uuid[],
            ${entities.map((e) => e.id)}::uuid[], ${topScore}, ${usedFallback}, ${opts.client ?? "cli"})`;

  return { query, passages, documents, entities, facts, usedFallback, topScore, degraded };
}
