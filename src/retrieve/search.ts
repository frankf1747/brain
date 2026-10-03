import type postgres from "postgres";
import { config } from "../config.js";
import type { Ctx } from "../ctx.js";
import { toVector } from "../db.js";
import { reciprocalRankFusion } from "./fuse.js";
import { triggerTerms } from "./fallback.js";
import { detectEntities } from "./entities.js";
import { isSpendCap } from "../llm/errors.js";
import {
  candidateQueries, loadChunks, summaryDocuments, entityNeighbors, mentionedChunkIds, factsLayer, fallbackScan, fallbackWindow,
  type ChunkRow, type Filters,
} from "./layers.js";
import {
  hybridLayers, isDegraded, searchMode, toLoggedPassages,
  type Candidates, type Degraded, type EntityHit, type FactRow, type Passage, type SearchResult, type Timings,
} from "./contract.js";

export type {
  SearchResult, Passage, LoggedPassage, DocHit, Neighbor, EntityHit, FactRow, Degraded, Candidates, Timings, SearchMode, Layer, ScoreKind,
} from "./contract.js";

export interface SearchOptions {
  k?: number;
  sourceKinds?: string[];
  since?: Date;
  until?: Date;
  verifiedOnly?: boolean;
  includeFacts?: boolean;
  client?: string;
}

/** Milliseconds since `start` (a performance.now() value), unrounded so sums carry no rounding error. */
function elapsed(start: number): number {
  return performance.now() - start;
}

/** One decimal, applied once per timing after every stage has been added up. */
const tenth = (ms: number) => Math.round(ms * 10) / 10;

type HowFound = Pick<Passage, "score" | "scoreKind" | "layers" | "vectorRank" | "keywordRank" | "rerankRank" | "viaEntity">;

function chunkPassage(row: ChunkRow, how: HowFound): Passage {
  return {
    chunkId: row.id,
    documentId: row.document_id,
    title: row.document_title,
    sourceKind: row.source_kind,
    author: row.author,
    origin: row.origin,
    occurredAt: row.occurred_at ? row.occurred_at.toISOString() : null,
    headingPath: row.heading_path,
    content: row.content,
    charStart: row.char_start,
    charEnd: row.char_end,
    fallbackTerm: null,
    ...how,
  };
}

/**
 * One search over every layer (spec §3), returned as the evidence contract (spec §6.1) and logged to
 * brain.retrieval_log, whose id comes back as `retrievalId`. Timings are disjoint stages: entity detection runs
 * alongside the candidate SQL and is counted in sqlMs; graphMs is the neighbour and mention queries.
 */
export async function search(ctx: Ctx, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  if (!query.trim()) throw new Error("Search query is empty");
  const started = performance.now();
  const { sql } = ctx;
  const k = opts.k ?? config.retrieval.defaultK;
  const filters: Filters = { kinds: opts.sourceKinds ?? null, since: opts.since ?? null, until: opts.until ?? null, verifiedOnly: opts.verifiedOnly ?? false };
  const degraded: Degraded = { embedding: false, rerank: false, capReached: false };
  const timings: Timings = { embedMs: 0, sqlMs: 0, rerankMs: 0, graphMs: 0, totalMs: 0 };

  // Layer 1a: the query embedding. Without it the search is keyword-only and nothing is reranked.
  let qvec: string | null = null;
  let t = performance.now();
  try {
    const [queryVector] = await (ctx.queryEmbedder ?? ctx.embedder).embed([query], "query");
    qvec = toVector(queryVector);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    degraded.embedding = true;
    degraded.rerank = true;
    if (isSpendCap(err)) {
      degraded.capReached = true;
      process.stderr.write(`brain: Voyage daily cap reached, keyword search only: ${message}\n`);
    } else {
      process.stderr.write(`brain: query embedding failed, keyword search only: ${message}\n`);
    }
  }
  timings.embedMs = elapsed(t);

  // Layer 1b: passage and summary candidates, alongside entity detection; then the fused passages' rows.
  t = performance.now();
  const [{ chunks: chunkCands, docs: docCands }, entityRefs] = await Promise.all([
    candidateQueries(sql, query, qvec, filters),
    detectEntities(sql, query),
  ]);
  const fused = reciprocalRankFusion(chunkCands.map((c) => ({ id: c.chunk_id, vectorRank: c.vector_rank, keywordRank: c.keyword_rank })));
  const rows = await loadChunks(sql, fused.map((f) => f.id));
  timings.sqlMs += elapsed(t);
  const present = fused.filter((f) => rows.has(f.id));
  const candidates: Candidates = {
    vector: chunkCands.filter((c) => c.vector_rank !== null).length,
    keyword: chunkCands.filter((c) => c.keyword_rank !== null).length,
    fused: present.length,
  };

  // Layer 2: rerank the fused candidates; fused order (RRF values) when the rerank cannot run.
  const fusedOrder = () => present.slice(0, k).map((f, index) => ({ index, score: f.fused }));
  let reranked: { index: number; score: number }[] = [];
  if (present.length && degraded.embedding) {
    // Voyage just failed for the query embedding; a rerank call would most likely fail too, after its own retries.
    reranked = fusedOrder();
  } else if (present.length) {
    t = performance.now();
    try {
      reranked = await (ctx.queryReranker ?? ctx.reranker).rerank(
        query,
        present.map((f) => {
          const r = rows.get(f.id)!;
          return (r.context_prefix ? r.context_prefix + "\n\n" : "") + r.content;
        }),
        k,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      degraded.rerank = true;
      if (isSpendCap(err)) {
        degraded.capReached = true;
        process.stderr.write(`brain: Voyage daily cap reached, keeping fused order: ${message}\n`);
      } else {
        process.stderr.write(`brain: reranking failed, keeping fused order: ${message}\n`);
      }
      reranked = fusedOrder();
    }
    timings.rerankMs = elapsed(t);
  }
  const passages: Passage[] = reranked.map((h, i) => {
    const f = present[h.index];
    return chunkPassage(rows.get(f.id)!, {
      score: h.score,
      scoreKind: degraded.rerank ? "rrf" : "rerank",
      layers: hybridLayers(f.vectorRank, f.keywordRank),
      vectorRank: f.vectorRank,
      keywordRank: f.keywordRank,
      rerankRank: degraded.rerank ? null : i + 1,
      viaEntity: null,
    });
  });
  // Rerank scores only: RRF values are on another scale and must never reach top_score or the fallback threshold.
  const rerankScores = passages.filter((p) => p.scoreKind === "rerank").map((p) => p.score as number);
  const topScore = rerankScores.length ? Math.max(...rerankScores) : null;

  // Layer 3: document summaries. The pool is candidateK per branch; fusion orders it and the caller sees the top k.
  t = performance.now();
  const documents = await summaryDocuments(
    sql,
    reciprocalRankFusion(docCands.map((d) => ({ id: d.document_id, vectorRank: d.vector_rank, keywordRank: d.keyword_rank }))).slice(0, k),
  );
  timings.sqlMs += elapsed(t);

  // Layer 4: graph expansion from entities named in the query, with budgets (spec §3.5). A mention that is already
  // listed (found by hybrid search, or by an earlier entity) stays at its place with its score and ranks: it gains
  // the graph layer and, if it has none yet, the entity; the first entity to reach a passage is the one it keeps.
  t = performance.now();
  const byChunk = new Map(passages.map((p) => [p.chunkId as string, p]));
  const entities: EntityHit[] = [];
  for (const ref of entityRefs) {
    entities.push({ id: ref.id, type: ref.type, name: ref.name, matchedSpan: ref.matchedSpan, neighbors: await entityNeighbors(sql, ref.id, filters.verifiedOnly) });
    const via = { id: ref.id, name: ref.name };
    const mentioned = await mentionedChunkIds(sql, ref.id, filters);
    const extra = await loadChunks(sql, mentioned.filter((id) => !byChunk.has(id)));
    for (const id of mentioned) {
      const listed = byChunk.get(id);
      if (listed) {
        if (!listed.layers.includes("graph")) listed.layers.push("graph");
        if (listed.viaEntity === null) listed.viaEntity = via;
        continue;
      }
      const row = extra.get(id);
      if (!row) continue;
      const p = chunkPassage(row, { score: null, scoreKind: "none", layers: ["graph"], vectorRank: null, keywordRank: null, rerankRank: null, viaEntity: via });
      passages.push(p);
      byChunk.set(id, p);
    }
  }
  timings.graphMs = elapsed(t);

  // Layer 5: facts about the owner (brain_orient and brain_get_facts still list every current fact).
  let facts: FactRow[] = [];
  if (opts.includeFacts !== false) {
    t = performance.now();
    facts = await factsLayer(sql, query, entityRefs.map((e) => e.id), filters.verifiedOnly);
    timings.sqlMs += elapsed(t);
  }

  // Fallback: literal substring scan for exact-string terms (codes, figures, versions), when the search was degraded
  // or the best rerank score is weak. Natural-language queries have no trigger terms and skip it. A degraded search
  // has no rerank score (topScore null), so it always scans.
  let fallbackUsed = false;
  const terms = triggerTerms(query);
  const weak = isDegraded(degraded) || topScore === null || topScore < config.retrieval.fallbackThreshold;
  if (terms.length && weak) {
    t = performance.now();
    const hits = await fallbackScan(sql, terms, filters);
    timings.sqlMs += elapsed(t);
    for (const h of hits) {
      fallbackUsed = true;
      const term = h.matched[0];
      const { start, end } = fallbackWindow(h.raw_content, term);
      passages.push({
        chunkId: null,
        documentId: h.id,
        title: h.title,
        sourceKind: h.source_kind,
        author: h.author,
        origin: h.origin,
        occurredAt: h.occurred_at ? h.occurred_at.toISOString() : null,
        headingPath: [],
        content: h.raw_content.slice(start, end),
        charStart: start,
        charEnd: end,
        score: null,
        scoreKind: "none",
        layers: ["fallback"],
        vectorRank: null,
        keywordRank: null,
        rerankRank: null,
        fallbackTerm: term,
        viaEntity: null,
      });
    }
  }

  const mode = searchMode(degraded);
  // The v1 columns stay filled for compatibility; results, degraded, candidates, timings, k and mode are v2 (spec §6.2);
  // facts (migration 012) lets brain_verify resolve F labels as this search showed them.
  const layers = [
    "hybrid", "summary", ...(entities.length ? ["graph"] : []), ...(facts.length ? ["facts"] : []), ...(fallbackUsed ? ["fallback"] : []),
    ...(isDegraded(degraded) ? ["degraded"] : []), ...(degraded.capReached ? ["cap_reached"] : []),
  ];
  const logFilters = { sourceKinds: filters.kinds, since: filters.since, until: filters.until, verifiedOnly: filters.verifiedOnly };
  const json = (v: unknown) => sql.json(v as postgres.JSONValue);
  timings.embedMs = tenth(timings.embedMs);
  timings.sqlMs = tenth(timings.sqlMs);
  timings.rerankMs = tenth(timings.rerankMs);
  timings.graphMs = tenth(timings.graphMs);
  timings.totalMs = tenth(elapsed(started));
  const [logged] = await sql<{ id: string }[]>`
    insert into brain.retrieval_log
      (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client, results, degraded, candidates, timings, k, mode, facts)
    values (${query}, ${json(logFilters)}, ${layers}::text[],
            ${passages.map((p) => p.chunkId).filter((id): id is string => id !== null)}::uuid[],
            ${entities.map((e) => e.id)}::uuid[], ${topScore}, ${fallbackUsed}, ${opts.client ?? "cli"},
            ${json(toLoggedPassages(passages))}, ${json(degraded)}, ${json(candidates)}, ${json(timings)}, ${k}, ${mode}, ${json(facts)})
    returning id`;

  return { retrievalId: logged.id, query, k, mode, degraded, fallbackUsed, topScore, passages, documents, entities, facts, candidates, timings };
}
