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
  /** The date the document is about (ISO 8601), or null when it has none. */
  occurredAt: z.string().nullable(),
  headingPath: z.array(z.string()),
  content: z.string(),
  /** The passage's character window in the document's raw text. */
  charStart: z.number().int(),
  charEnd: z.number().int(),
  /** Null exactly when scoreKind is "none" (graph and fallback passages). */
  score: z.number().nullable(),
  scoreKind: ScoreKindSchema,
  layers: z.array(LayerSchema),
  /** 1-based rank among the vector branch's candidates; hybrid passages only. */
  vectorRank: z.number().int().nullable(),
  /** 1-based rank among the keyword branch's candidates; hybrid passages only. */
  keywordRank: z.number().int().nullable(),
  /** 1-based position in the reranker's output; null when the rerank did not run. */
  rerankRank: z.number().int().nullable(),
  /** The trigger term the literal scan matched; fallback passages only. */
  fallbackTerm: z.string().nullable(),
  /** The entity named in the query whose mentions brought this passage in; graph passages only. */
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

export type FactSource =
  | { kind: "document"; sourceKind: string; documentId: string }
  | { kind: "owner" }
  | { kind: "unlinked" };

/**
 * Where a fact came from. "document": the extractor read it from a passage that is still stored. "owner": no source
 * passage and not written by the extractor (brain_add_fact, or set by hand). "unlinked": written by the extractor,
 * but its source passage is gone (re-chunked).
 */
export function factSource(f: Pick<FactRow, "sourceChunkId" | "sourceDocumentId" | "sourceKind" | "verifiedBy">): FactSource {
  if (f.sourceChunkId && f.sourceDocumentId && f.sourceKind) return { kind: "document", sourceKind: f.sourceKind, documentId: f.sourceDocumentId };
  if (!(f.verifiedBy ?? "").startsWith(EXTRACTOR_BY_PREFIX)) return { kind: "owner" };
  return { kind: "unlinked" };
}
