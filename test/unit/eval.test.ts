import { describe, it, expect } from "vitest";
import { kindFromFilename, toQuestionResult, firstExpectedRank } from "../../src/eval/run.js";
import type { GoldenItem } from "../../src/eval/golden.js";
import type { SearchResult } from "../../src/retrieve/search.js";

const item: GoldenItem = {
  id: "q05", question: "Why?", kind: "semantic", negative: false, source: "fixture", approved_at: "2026-09-30",
  expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot satisfy all three" }],
};

function searchResult(passages: { documentId: string; group: "hybrid" | "graph" | "fallback"; content: string; score: number }[]): SearchResult {
  return {
    query: "Why?",
    passages: passages.map((p) => ({ chunkId: "c", documentId: p.documentId, documentTitle: null, sourceKind: "note", content: p.content, parentContent: null, headingPath: [], charStart: 0, charEnd: 0, score: p.score, group: p.group })),
    documents: [], entities: [], facts: [], usedFallback: false, topScore: passages[0]?.score ?? null, degraded: false,
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
    const q = toQuestionResult(item, res, origins, 42, []);
    expect(q.ranked.map((d) => d.documentId)).toEqual(["d1", "d2", "d3"]);
    expect(q.ranked.map((d) => d.containsQuote)).toEqual([false, true, false]);
    expect(q.topScore).toBe(0.4);
    expect(q.hasGraphPassage).toBe(true);
    expect(q.totalMs).toBe(42);
    expect(firstExpectedRank(q)).toBe(2);
  });
  it("rank is null on a miss", () => {
    const q = toQuestionResult(item, searchResult([{ documentId: "d9", group: "hybrid", content: "x", score: 0.9 }]), new Map([["d9", "/c/z.md"]]), 1, []);
    expect(firstExpectedRank(q)).toBeNull();
  });
  it("reads the source kind from the file name prefix", () => {
    expect(kindFromFilename("news--acme-series-b.md")).toBe("news");
    expect(kindFromFilename("plain.md")).toBe("note");
  });
});
