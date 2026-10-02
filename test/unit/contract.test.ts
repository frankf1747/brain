import { describe, it, expect } from "vitest";
import {
  SearchResultSchema, LoggedPassageSchema, searchMode, degradedNote, isDegraded, hybridLayers, isHybrid, toLoggedPassages, factSource,
} from "../../src/retrieve/contract.js";
import { passage, fact, searchResult } from "./search-fixture.js";

describe("search mode and degraded notes", () => {
  it("maps the degraded flags to the mode and the four Phase 3 notes", () => {
    const cases = [
      { d: { embedding: false, rerank: false, capReached: false }, mode: "hybrid", note: null },
      { d: { embedding: true, rerank: true, capReached: true }, mode: "keyword-only", note: "Voyage daily cap reached; keyword-only results" },
      { d: { embedding: true, rerank: true, capReached: false }, mode: "keyword-only", note: "query embedding failed; keyword-only results" },
      { d: { embedding: false, rerank: true, capReached: true }, mode: "fused-order", note: "Voyage daily cap reached; results in fused order" },
      { d: { embedding: false, rerank: true, capReached: false }, mode: "fused-order", note: "reranking failed; results in fused order" },
    ] as const;
    for (const c of cases) {
      expect(searchMode(c.d)).toBe(c.mode);
      expect(degradedNote(c.d)).toBe(c.note);
      expect(isDegraded(c.d)).toBe(c.mode !== "hybrid");
    }
  });
});

describe("layers", () => {
  it("names the branches that found a hybrid passage, vector first", () => {
    expect(hybridLayers(2, 5)).toEqual(["vector", "keyword"]);
    expect(hybridLayers(null, 1)).toEqual(["keyword"]);
    expect(hybridLayers(3, null)).toEqual(["vector"]);
    expect(hybridLayers(null, null)).toEqual([]);
  });

  it("tells hybrid passages from graph and fallback ones", () => {
    expect(isHybrid(passage())).toBe(true);
    expect(isHybrid(passage({ layers: ["keyword"] }))).toBe(true);
    expect(isHybrid(passage({ layers: ["graph"] }))).toBe(false);
    expect(isHybrid(passage({ layers: ["fallback"] }))).toBe(false);
  });
});

describe("toLoggedPassages", () => {
  it("keeps every field except the text, in order, including fallback passages without a chunk", () => {
    const fb = passage({ chunkId: null, documentId: "d2", layers: ["fallback"], score: null, scoreKind: "none", vectorRank: null, keywordRank: null, rerankRank: null, fallbackTerm: "X-90" });
    const logged = toLoggedPassages([passage(), fb]);
    expect(logged).toHaveLength(2);
    expect(logged[0]).not.toHaveProperty("content");
    const { content: _c, ...rest } = passage();
    expect(logged[0]).toEqual(rest);
    expect(logged[1]).toMatchObject({ chunkId: null, documentId: "d2", fallbackTerm: "X-90", layers: ["fallback"] });
    expect(logged.every((p) => LoggedPassageSchema.safeParse(p).success)).toBe(true);
  });
});

describe("factSource", () => {
  it("says a fact came from a document, from the owner, or from a passage that is gone", () => {
    expect(factSource(fact())).toEqual({ kind: "document", sourceKind: "note", documentId: "d9" });
    expect(factSource(fact({ sourceChunkId: null, sourceDocumentId: null, sourceKind: null, verifiedBy: "agent:claude-code" }))).toEqual({ kind: "owner" });
    expect(factSource(fact({ sourceChunkId: null, sourceDocumentId: null, sourceKind: null, verifiedBy: null }))).toEqual({ kind: "owner" });
    expect(factSource(fact({ sourceChunkId: null, sourceDocumentId: null, sourceKind: null, verifiedBy: "extractor:claude-test" }))).toEqual({ kind: "unlinked" });
    // Verified by the owner after extraction: still from its document.
    expect(factSource(fact({ verified: true, verifiedBy: "frank" }))).toEqual({ kind: "document", sourceKind: "note", documentId: "d9" });
  });
});

describe("SearchResultSchema", () => {
  it("accepts a full result and rejects anything that is not plain JSON", () => {
    const r = searchResult({ passages: [passage()], facts: [fact()], topScore: 0.76 });
    expect(SearchResultSchema.safeParse(r).success).toBe(true);
    const withDate = { ...r, passages: [{ ...passage(), occurredAt: new Date("2026-09-29T00:00:00Z") }] };
    expect(SearchResultSchema.safeParse(withDate).success).toBe(false);
    expect(SearchResultSchema.safeParse({ ...r, mode: "full" }).success).toBe(false);
    expect(SearchResultSchema.safeParse({ ...r, passages: [passage({ layers: ["hybrid" as never] })] }).success).toBe(false);
  });
});
