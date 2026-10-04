import { z } from "zod";
import { EXTRACTOR_BY_PREFIX } from "../graph/supersede.js";

/**
 * The evidence contract (spec §6.1): what one search returned and how each passage was found. search() builds it,
 * brain_search renders it as text and returns it as structuredContent, brain.retrieval_log stores it (passages
 * without their text), and brain_explain replays it from the log. Every field is plain JSON (dates are ISO 8601
 * strings), so the same object is logged, sent and rendered without conversion.
 */

/** How a passage was found: the vector branch, the keyword branch, entity expansion, or the literal substring scan. */
export const LayerSchema = z.enum(["vector", "keyword", "graph", "fallback"]);

/** What `score` means: the reranker's relevance (0 to 1), a reciprocal-rank-fusion value (reranking skipped), or none. */
export const ScoreKindSchema = z.enum(["rerank", "rrf", "none"]);

/**
 * hybrid: vector and keyword candidates, reranked. keyword-only: the query embedding failed or was refused, so there
 * were no vector candidates and no rerank. fused-order: vector and keyword candidates, but the rerank failed or was
 * refused, so they are in reciprocal-rank-fusion order.
 */
export const SearchModeSchema = z.enum(["hybrid", "keyword-only", "fused-order"]);

export const PassageSchema = z.object({
  /** Null for a fallback passage: a window of the raw document, not a stored chunk. */
  chunkId: z.string().nullable(),
  documentId: z.string(),
  title: z.string().nullable(),
  sourceKind: z.string(),
  /** Who wrote the document: owner, other or unknown. */
  author: z.string(),
  origin: z.string().nullable(),
  /** The date the document is about (ISO 8601 date-time, as toISOString writes it), or null when it has none. */
  occurredAt: z.string().datetime({ offset: true }).nullable(),
  headingPath: z.array(z.string()),
  content: z.string(),
  /** The passage's character window in the document's raw text. */
  charStart: z.number().int(),
  charEnd: z.number().int(),
  /** Null exactly when scoreKind is "none" (graph and fallback passages). */
  score: z.number().nullable(),
  scoreKind: ScoreKindSchema,
  layers: z.array(LayerSchema),
  /** 1-based rank among the vector branch's candidates; null unless the vector branch found the passage. */
  vectorRank: z.number().int().nullable(),
  /** 1-based rank among the keyword branch's candidates; null unless the keyword branch found the passage. */
  keywordRank: z.number().int().nullable(),
  /** 1-based position in the reranker's output; null when the rerank did not run. */
  rerankRank: z.number().int().nullable(),
  /** The trigger term the literal scan matched; fallback passages only. */
  fallbackTerm: z.string().nullable(),
  /**
   * The entity named in the query whose mentions include this passage (the first one, if several do); set exactly
   * when layers includes "graph". A hybrid passage the graph also reached keeps its hybrid score and ranks.
   */
  viaEntity: z.object({ id: z.string(), name: z.string() }).nullable(),
});

/** A passage as brain.retrieval_log.results stores it: everything except the text. */
export const LoggedPassageSchema = PassageSchema.omit({ content: true });

export const DocHitSchema = z.object({
  documentId: z.string(),
  title: z.string().nullable(),
  sourceKind: z.string(),
  summary: z.string().nullable(),
  /** Reciprocal-rank-fusion value of the summary search. */
  score: z.number(),
});

export const NeighborSchema = z.object({ id: z.string(), type: z.string(), name: z.string(), depth: z.number().int() });

export const EntityHitSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  /** The canonicalised query span that matched this node. */
  matchedSpan: z.string(),
  neighbors: z.array(NeighborSchema),
});

export const FactRowSchema = z.object({
  id: z.string(),
  predicate: z.string(),
  objectText: z.string(),
  confidence: z.number().nullable(),
  verified: z.boolean(),
  /** extractor:<model> for an extracted fact, agent:<client> for brain_add_fact, the verifier's name after verify-fact. */
  verifiedBy: z.string().nullable(),
  /** The passage the extractor read it from; null for a fact the owner stated (or whose passage was re-chunked away). */
  sourceChunkId: z.string().nullable(),
  sourceDocumentId: z.string().nullable(),
  /** source_kind of the source document. */
  sourceKind: z.string().nullable(),
});

export const DegradedSchema = z.object({
  /** The query embedding failed or was refused: no vector candidates, keyword-only. */
  embedding: z.boolean(),
  /** No rerank ran on the candidates (it failed, was refused, or was skipped after the embedding failed). */
  rerank: z.boolean(),
  /** The Voyage daily cap refused the query embedding or the rerank. */
  capReached: z.boolean(),
});

export const CandidatesSchema = z.object({
  /** Passages the vector branch returned (0 in keyword-only mode). */
  vector: z.number().int(),
  /** Passages the keyword branch returned. */
  keyword: z.number().int(),
  /** Distinct passages after fusing the two branches: what the reranker scored or fused order cut from. */
  fused: z.number().int(),
});

/** Milliseconds, one decimal. Stages: the query embedding; candidate, passage, fact and fallback SQL; the rerank; graph expansion. */
export const TimingsSchema = z.object({
  embedMs: z.number(),
  sqlMs: z.number(),
  rerankMs: z.number(),
  graphMs: z.number(),
  /** The whole search up to the retrieval_log insert. */
  totalMs: z.number(),
});

export const SearchResultSchema = z.object({
  /** brain.retrieval_log id; brain_explain(retrieval_id) replays this search. */
  retrievalId: z.string(),
  query: z.string(),
  k: z.number().int(),
  mode: SearchModeSchema,
  degraded: DegradedSchema,
  fallbackUsed: z.boolean(),
  /** The top rerank score; null when no rerank ran (degraded) or nothing was reranked. */
  topScore: z.number().nullable(),
  passages: z.array(PassageSchema),
  documents: z.array(DocHitSchema),
  entities: z.array(EntityHitSchema),
  facts: z.array(FactRowSchema),
  candidates: CandidatesSchema,
  timings: TimingsSchema,
});

/**
 * brain_search's structuredContent: the result with each passage's text left out, since the text content already
 * carries it. Measured on a synthetic worst case (k=30 plus 25 graph passages of 1,600 characters,
 * test/unit/search-output-size.test.ts), sending the full result made the text plus structuredContent about 235 KB;
 * without passage text it is about 146 KB, of which the text is about 106 KB.
 */
export const SearchOutputSchema = SearchResultSchema.extend({ passages: z.array(LoggedPassageSchema) });

export type Layer = z.infer<typeof LayerSchema>;
export type ScoreKind = z.infer<typeof ScoreKindSchema>;
export type SearchMode = z.infer<typeof SearchModeSchema>;
export type Passage = z.infer<typeof PassageSchema>;
export type LoggedPassage = z.infer<typeof LoggedPassageSchema>;
export type DocHit = z.infer<typeof DocHitSchema>;
export type Neighbor = z.infer<typeof NeighborSchema>;
export type EntityHit = z.infer<typeof EntityHitSchema>;
export type FactRow = z.infer<typeof FactRowSchema>;
export type Degraded = z.infer<typeof DegradedSchema>;
export type Candidates = z.infer<typeof CandidatesSchema>;
export type Timings = z.infer<typeof TimingsSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchOutput = z.infer<typeof SearchOutputSchema>;

export const NOT_DEGRADED: Degraded = { embedding: false, rerank: false, capReached: false };

export function isDegraded(d: Degraded): boolean {
  return d.embedding || d.rerank;
}

export function searchMode(d: Degraded): SearchMode {
  if (d.embedding) return "keyword-only";
  if (d.rerank) return "fused-order";
  return "hybrid";
}

/** The one-line reason for a degraded search (the four notes from Phase 3), or null for a hybrid search. */
export function degradedNote(d: Degraded): string | null {
  if (d.embedding) return d.capReached ? "Voyage daily cap reached; keyword-only results" : "query embedding failed; keyword-only results";
  if (d.rerank) return d.capReached ? "Voyage daily cap reached; results in fused order" : "reranking failed; results in fused order";
  return null;
}

/** The branches that returned a hybrid passage, vector first. */
export function hybridLayers(vectorRank: number | null, keywordRank: number | null): Layer[] {
  return [...(vectorRank !== null ? (["vector"] as const) : []), ...(keywordRank !== null ? (["keyword"] as const) : [])];
}

/** Found by the vector or keyword branch (as opposed to graph expansion or the literal scan). */
export function isHybrid(p: Pick<Passage, "layers">): boolean {
  return p.layers.includes("vector") || p.layers.includes("keyword");
}

/** What retrieval_log.results stores: each passage without its text, in rank order (index 0 is P1). */
export function toLoggedPassages(passages: Passage[]): LoggedPassage[] {
  return passages.map(({ content: _content, ...rest }) => rest);
}

/** What brain_search returns as structuredContent: the result without passage text (SearchOutputSchema). */
export function toSearchOutput(r: SearchResult): SearchOutput {
  return { ...r, passages: toLoggedPassages(r.passages) };
}

export type FactSource =
  | { kind: "document"; sourceKind: string; documentId: string }
  | { kind: "owner" }
  | { kind: "confirmed" }
  | { kind: "unlinked" };

/**
 * Where a fact came from. "document": the extractor read it from a passage that is still stored. "confirmed": no
 * stored source passage, and the owner verified it; verified is set only by verifyFact (`brain verify-fact`), which
 * also overwrites verified_by with the verifier's name, so who first wrote it is no longer known. "owner": no source
 * passage, unverified, and not written by the extractor (brain_add_fact, or set by hand). "unlinked": written by the
 * extractor, unverified, and its source passage is gone (re-chunked or deleted).
 */
export function factSource(f: Pick<FactRow, "sourceChunkId" | "sourceDocumentId" | "sourceKind" | "verified" | "verifiedBy">): FactSource {
  if (f.sourceChunkId && f.sourceDocumentId && f.sourceKind) return { kind: "document", sourceKind: f.sourceKind, documentId: f.sourceDocumentId };
  if (f.verified) return { kind: "confirmed" };
  if (!(f.verifiedBy ?? "").startsWith(EXTRACTOR_BY_PREFIX)) return { kind: "owner" };
  return { kind: "unlinked" };
}
