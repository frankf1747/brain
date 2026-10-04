import type { FactRow, Passage, SearchResult } from "../../src/retrieve/contract.js";

/** A hybrid passage found by both branches and reranked first; override any field. */
export function passage(over: Partial<Passage> = {}): Passage {
  return {
    chunkId: "c1",
    documentId: "d1",
    title: "Doc",
    sourceKind: "news",
    author: "other",
    origin: null,
    occurredAt: "2026-09-29T00:00:00.000Z",
    headingPath: [],
    content: "Body text",
    charStart: 0,
    charEnd: 9,
    score: 0.76,
    scoreKind: "rerank",
    layers: ["vector", "keyword"],
    vectorRank: 2,
    keywordRank: 5,
    rerankRank: 1,
    fallbackTerm: null,
    viaEntity: null,
    ...over,
  };
}

/** An extracted fact read from a stored passage; override any field. */
export function fact(over: Partial<FactRow> = {}): FactRow {
  return {
    id: "f1",
    predicate: "visa_status",
    objectText: "F-1 OPT",
    confidence: 0.9,
    verified: false,
    verifiedBy: "extractor:claude-test",
    sourceChunkId: "c9",
    sourceDocumentId: "d9",
    sourceKind: "note",
    ...over,
  };
}

/** A full hybrid search with no passages; override any field. */
export function searchResult(over: Partial<SearchResult> = {}): SearchResult {
  return {
    retrievalId: "r1",
    query: "q",
    k: 10,
    mode: "hybrid",
    degraded: { embedding: false, rerank: false, capReached: false },
    fallbackUsed: false,
    topScore: null,
    evidence: { level: "strong", basis: "rerank", threshold: 0.56 },
    passages: [],
    documents: [],
    entities: [],
    facts: [],
    candidates: { vector: 0, keyword: 0, fused: 0 },
    timings: { embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0.5, totalMs: 7 },
    ...over,
  };
}
