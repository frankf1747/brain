import { config } from "../config.js";
import type { Db } from "../db.js";
import type { DocHit, FactRow, Neighbor } from "./contract.js";

/**
 * The per-layer queries search() runs (spec §3). Each function is one SQL round trip (or one per entity) and knows
 * nothing about ranking, scores or the evidence contract; search.ts orchestrates them and builds the result.
 */

export interface Filters {
  kinds: string[] | null;
  since: Date | null;
  until: Date | null;
  verifiedOnly: boolean;
}

export interface ChunkCandidate {
  chunk_id: string;
  vector_rank: number | null;
  keyword_rank: number | null;
}

export interface DocCandidate {
  document_id: string;
  vector_rank: number | null;
  keyword_rank: number | null;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  content: string;
  heading_path: string[];
  context_prefix: string;
  char_start: number;
  char_end: number;
  document_title: string | null;
  source_kind: string;
  author: string;
  origin: string | null;
  occurred_at: Date | null;
}

/** The same date window hybrid_search and summary_search apply, for queries that read documents directly. */
function inDateRange(sql: Db, alias: string, since: Date | null, until: Date | null) {
  const at = sql`coalesce(${sql(alias)}.occurred_at, ${sql(alias)}.ingested_at)`;
  return sql`(${since}::timestamptz is null or ${at} >= ${since}::timestamptz)
    and (${until}::timestamptz is null or ${at} <= ${until}::timestamptz)`;
}

/**
 * Layer 1: passage candidates (hybrid_search) and document candidates (summary_search), candidateK per branch.
 * qvec null means keyword-only: hybrid_search returns no vector ranks.
 */
export async function candidateQueries(sql: Db, query: string, qvec: string | null, f: Filters): Promise<{ chunks: ChunkCandidate[]; docs: DocCandidate[] }> {
  // pgvector 0.8: with iterative scans the HNSW index keeps going until `limit k` rows satisfy the
  // source_kind/date filters; ef_search = greatest(4 * candidateK, 100) bounds the first pass (spec §3.1).
  // SET LOCAL needs a transaction; the two searches share its connection and run one after the other.
  const efSearch = Math.max(4 * config.retrieval.candidateK, 100);
  const [chunks, docs] = await sql.begin(async (tx) => {
    await tx.unsafe(`set local hnsw.iterative_scan = 'relaxed_order'; set local hnsw.ef_search = ${efSearch}`);
    return Promise.all([
      tx<ChunkCandidate[]>`
        select chunk_id, vector_rank, keyword_rank
        from brain.hybrid_search(${query}, ${qvec}::vector, ${config.retrieval.candidateK}, ${f.kinds}::text[], ${f.since}, ${f.until})`,
      tx<DocCandidate[]>`
        select document_id, vector_rank, keyword_rank
        from brain.summary_search(${query}, ${qvec}::vector, ${config.retrieval.candidateK}, ${f.kinds}::text[], ${f.since}, ${f.until})`,
    ]);
  });
  return { chunks, docs };
}

/** Passage rows with their document's title, kind, author, origin and date. */
export async function loadChunks(sql: Db, ids: string[]): Promise<Map<string, ChunkRow>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<ChunkRow[]>`
    select c.id, c.document_id, c.content, c.heading_path, c.context_prefix, c.char_start, c.char_end,
           d.title as document_title, d.source_kind, d.author, d.origin, d.occurred_at
    from brain.chunks c
    join brain.documents d on d.id = c.document_id
    where c.id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

/** Layer 3: the fused summary hits, in the given order, with their documents' summaries. */
export async function summaryDocuments(sql: Db, fused: { id: string; fused: number }[]): Promise<DocHit[]> {
  if (fused.length === 0) return [];
  const rows = await sql<{ id: string; title: string | null; source_kind: string; summary: string | null }[]>`
    select id, title, source_kind, summary from brain.documents where id = any(${fused.map((d) => d.id)}::uuid[])`;
  return fused
    .map((d) => {
      const r = rows.find((x) => x.id === d.id);
      return r ? { documentId: r.id, title: r.title, sourceKind: r.source_kind, summary: r.summary, score: d.fused } : null;
    })
    .filter((d): d is DocHit => d !== null);
}

/** Layer 4a: an entity's direct neighbours, strongest edge first, capped (spec §3.5). */
export async function entityNeighbors(sql: Db, nodeId: string, verifiedOnly: boolean): Promise<Neighbor[]> {
  return sql<Neighbor[]>`
    select nb.node_id as id, x.type, x.name, nb.depth
    from brain.neighbors(${nodeId}, 1, null) nb
    join brain.nodes x on x.id = nb.node_id
    left join brain.edges e on e.id = nb.via_edge
    where nb.depth > 0 and ${verifiedOnly ? sql`x.verified` : sql`true`}
    order by nb.depth, e.confidence desc nulls last, x.name
    limit ${config.graph.maxNeighbors}`;
}

/**
 * Layer 4b: passages that mention the entity (or a node merged into it), newest document first, capped.
 * A mention stored on a level-0 section (quote not located) maps to that section's first passage.
 */
export async function mentionedChunkIds(sql: Db, nodeId: string, f: Filters): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select c.id
    from (
      select distinct case when c0.level = 1 then c0.id
                           else (select p.id from brain.chunks p where p.parent_id = c0.id order by p.ordinal limit 1) end as id
      from brain.mentions m join brain.chunks c0 on c0.id = m.chunk_id
      where m.node_id = any(brain.node_members(${nodeId}))
    ) pm
    join brain.chunks c on c.id = pm.id
    join brain.documents d on d.id = c.document_id
    where (${f.kinds}::text[] is null or d.source_kind = any(${f.kinds}::text[]))
      and ${inDateRange(sql, "d", f.since, f.until)}
    order by coalesce(d.occurred_at, d.ingested_at) desc, c.ordinal, c.id
    limit ${config.graph.maxPassagesPerEntity}`;
  return rows.map((r) => r.id);
}

/**
 * Layer 5: current facts about the owner whose predicate or value shares a stem with the query, or whose object
 * node is a detected entity, capped; entity-linked facts rank first so the cap never drops them (spec §3.5).
 * Each fact carries who recorded it and, for an extracted fact, the passage and document it came from.
 */
export async function factsLayer(sql: Db, query: string, entityIds: string[], verifiedOnly: boolean): Promise<FactRow[]> {
  const rows = await sql<{
    id: string; predicate: string; object_text: string; confidence: number | null; verified: boolean; verified_by: string | null;
    source_chunk_id: string | null; source_document_id: string | null; source_kind: string | null;
  }[]>`
    select f.id, f.predicate, f.object_text, f.confidence, f.verified, ff.verified_by, f.source_chunk_id,
           c.document_id as source_document_id, d.source_kind
    from brain.current_facts(null) f
    join brain.facts ff on ff.id = f.id
    left join brain.chunks c on c.id = f.source_chunk_id
    left join brain.documents d on d.id = c.document_id
    cross join (select brain.query_to_tsquery(${query}) as q) q
    where ((q.q is not null and to_tsvector('english', replace(f.predicate, '_', ' ') || ' ' || f.object_text) @@ q.q)
           or brain.canonical_node(f.object_node_id) = any(${entityIds}::uuid[]))
      and ${verifiedOnly ? sql`f.verified` : sql`true`}
    order by coalesce(brain.canonical_node(f.object_node_id) = any(${entityIds}::uuid[]), false) desc, f.verified desc, f.confidence desc nulls last, f.created_at desc, f.id
    limit ${config.graph.maxFacts}`;
  return rows.map((f) => ({
    id: f.id, predicate: f.predicate, objectText: f.object_text, confidence: f.confidence, verified: f.verified, verifiedBy: f.verified_by,
    sourceChunkId: f.source_chunk_id, sourceDocumentId: f.source_document_id, sourceKind: f.source_kind,
  }));
}

export interface FallbackHit {
  id: string;
  title: string | null;
  source_kind: string;
  author: string;
  origin: string | null;
  occurred_at: Date | null;
  raw_content: string;
  /** The trigger terms this document contains, in query order. */
  matched: string[];
  /** How many trigger terms it contains. */
  n: number;
}

/** Fallback: documents whose raw text contains a trigger term literally, most terms first, then newest; at most 10. */
export async function fallbackScan(sql: Db, terms: string[], f: Filters): Promise<FallbackHit[]> {
  return sql<FallbackHit[]>`
    select d.id, d.title, d.source_kind, d.author, d.origin, d.occurred_at, d.raw_content,
           array(select t from unnest(${terms}::text[]) with ordinality u(t, o)
                 where d.raw_content ilike '%' || brain.like_literal(t) || '%' order by o) as matched,
           (select count(*)::int from unnest(${terms}::text[]) t where d.raw_content ilike '%' || brain.like_literal(t) || '%') as n
    from brain.documents d
    where (${f.kinds}::text[] is null or d.source_kind = any(${f.kinds}::text[]))
      and ${inDateRange(sql, "d", f.since, f.until)}
      and d.raw_content ilike any (array(select '%' || brain.like_literal(t) || '%' from unnest(${terms}::text[]) t))
    order by n desc, coalesce(d.occurred_at, d.ingested_at) desc
    limit 10`;
}

/** 200 characters either side of the first case-insensitive occurrence of term, clipped to the document. */
export function fallbackWindow(raw: string, term: string): { start: number; end: number } {
  const at = Math.max(0, raw.toLowerCase().indexOf(term.toLowerCase()));
  return { start: Math.max(0, at - 200), end: Math.min(raw.length, at + term.length + 200) };
}
