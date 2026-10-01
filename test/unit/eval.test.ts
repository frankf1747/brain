import { describe, it, expect } from "vitest";
import { kindFromFilename, toQuestionResult, firstExpectedRank, normalizeWhitespace, missingQuoteWarning } from "../../src/eval/run.js";
import type { GoldenItem } from "../../src/eval/golden.js";
import type { SearchResult } from "../../src/retrieve/search.js";

const item: GoldenItem = {
  id: "q05", question: "Why?", kind: "semantic", negative: false, source: "fixture", approved_at: "2026-09-30",
  expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot satisfy all three" }],
};

type P = { documentId: string; group: "hybrid" | "graph" | "fallback"; content: string; score: number; chunkId?: string | null };

function searchResult(passages: P[], degraded = false): SearchResult {
  return {
    query: "Why?",
    passages: passages.map((p, i) => ({ chunkId: p.chunkId === undefined ? `c${i}` : p.chunkId, documentId: p.documentId, documentTitle: null, sourceKind: "note", content: p.content, parentContent: null, headingPath: [], charStart: 0, charEnd: 0, score: p.score, group: p.group })),
    documents: [], entities: [], facts: [], usedFallback: false, topScore: passages[0]?.score ?? null, degraded,
  };
}

describe("toQuestionResult", () => {
  it("records ranked documents with origins, quote hits, top score and graph presence", () => {
    const res = searchResult([
      { documentId: "d1", group: "hybrid", content: "Demographic parity asks that positive rates match.", score: 0.4 },
      { documentId: "d2", group: "hybrid", content: "shows you cannot satisfy all three when base rates differ", score: 0.3 },
      { documentId: "d3", group: "graph", content: "x", score: 0 },
    ]);
    const origins = new Map([["d1", "/c/other.md"], ["d2", "/c/note--fairness-in-ml.md"], ["d3", null]]);
    const q = toQuestionResult(item, res, origins, 42, [], 2, [true]);
    expect(q.ranked.map((d) => d.documentId)).toEqual(["d1", "d2", "d3"]);
    expect(q.ranked.map((d) => d.containsQuote)).toEqual([false, true, false]);
    expect(q.topScore).toBe(0.4);
    expect(q.hasGraphPassage).toBe(true);
    expect(q.totalMs).toBe(42);
    expect(q.totalRelevant).toBe(2);
    expect(q.paraphraseDegraded).toEqual([true]);
    expect(firstExpectedRank(q)).toBe(2);
  });
  it("a passage counts as containing the quote only when it belongs to an expected document", () => {
    const res = searchResult([{ documentId: "d1", group: "hybrid", content: "you cannot satisfy all three", score: 0.4 }]);
    const q = toQuestionResult(item, res, new Map([["d1", "/c/other.md"]]), 1, [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(false);
  });
  it("matches quotes with whitespace runs collapsed on both sides", () => {
    const spaced: GoldenItem = { ...item, expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot  satisfy\nall three" }] };
    const res = searchResult([{ documentId: "d2", group: "hybrid", content: "you cannot\n\tsatisfy all   three here", score: 0.4 }]);
    const q = toQuestionResult(spaced, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), 1, [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(true);
  });
  it("a fallback window (no chunk) is never a relevant passage, since totalRelevant counts chunks", () => {
    const res = searchResult([{ documentId: "d2", group: "fallback", content: "you cannot satisfy all three", score: 0, chunkId: null }]);
    const q = toQuestionResult(item, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), 1, [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(false);
  });
  it("rank is null on a miss", () => {
    const q = toQuestionResult(item, searchResult([{ documentId: "d9", group: "hybrid", content: "x", score: 0.9 }]), new Map([["d9", "/c/z.md"]]), 1, [], 0, []);
    expect(firstExpectedRank(q)).toBeNull();
  });
  it("reads the source kind from the file name prefix", () => {
    expect(kindFromFilename("news--acme-series-b.md")).toBe("news");
    expect(kindFromFilename("plain.md")).toBe("note");
  });
});

describe("normalizeWhitespace", () => {
  it("collapses ASCII whitespace runs only, matching the SQL class, so an NBSP is kept", () => {
    expect(normalizeWhitespace("a \t\r\n\f\vb")).toBe("a b");
    expect(normalizeWhitespace("a\u00a0b")).toBe("a\u00a0b");
    expect(normalizeWhitespace("a \u00a0 b")).toBe("a \u00a0 b");
  });
  it("an NBSP in a quote does not match a plain space in a passage", () => {
    const nbsp: GoldenItem = { ...item, expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot\u00a0satisfy" }] };
    const res = searchResult([{ documentId: "d2", group: "hybrid", content: "you cannot satisfy all three", score: 0.4 }]);
    expect(toQuestionResult(nbsp, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), 1, [], 1, []).ranked[0].containsQuote).toBe(false);
  });
});

describe("missingQuoteWarning", () => {
  it("warns when an item has quotes but no passage of its expected documents contains one", () => {
    expect(missingQuoteWarning(item, 0)).toBe("eval: q05 quote not found in any passage of its expected documents");
    expect(missingQuoteWarning(item, 2)).toBeNull();
    expect(missingQuoteWarning({ ...item, expected: [{ origin: "a.md" }] }, 0)).toBeNull();
  });
});
