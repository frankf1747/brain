import { describe, it, expect } from "vitest";
import { judgeEvidence, isBareLiteralLookup } from "../../src/retrieve/evidence.js";
import { NOT_DEGRADED } from "../../src/retrieve/contract.js";

const hybrid = { degraded: NOT_DEGRADED };

describe("judgeEvidence", () => {
  it("is strong when the top rerank score reaches the threshold, weak below it", () => {
    expect(judgeEvidence({ ...hybrid, query: "Where do I live?", topScore: 0.56, passages: [] }, 0.56)).toEqual({ level: "strong", basis: "rerank", threshold: 0.56 });
    expect(judgeEvidence({ ...hybrid, query: "Where do I live?", topScore: 0.5586, passages: [] }, 0.56)).toEqual({ level: "weak", basis: "rerank", threshold: 0.56 });
  });
  it("is weak when nothing was reranked, even with graph passages", () => {
    expect(judgeEvidence({ ...hybrid, query: "Who is Marcus Hale?", topScore: null, passages: [{ content: "CEO Marcus Hale said" }] }, 0.56).level).toBe("weak");
  });
  it("is unknown when no rerank ran: keyword-only or fused order has no score to judge", () => {
    for (const degraded of [{ embedding: true, rerank: true, capReached: false }, { embedding: false, rerank: true, capReached: true }]) {
      expect(judgeEvidence({ degraded, query: "Where do I live?", topScore: null, passages: [{ content: "Denver" }] }, 0.56)).toEqual({ level: "unknown", basis: "no_rerank", threshold: 0.56 });
    }
  });
  it("is strong for a bare literal lookup whose every term appears in a passage, whatever the score or mode", () => {
    const passages = [{ content: "the X-90 prototype" }, { content: "Requisition req-4471 opened" }];
    expect(judgeEvidence({ ...hybrid, query: "X-90", topScore: 0.51, passages }, 0.56)).toEqual({ level: "strong", basis: "literal", threshold: 0.56 });
    expect(judgeEvidence({ ...hybrid, query: '"X-90" REQ-4471?', topScore: 0.2, passages }, 0.56).basis).toBe("literal");
    expect(judgeEvidence({ degraded: { embedding: true, rerank: true, capReached: false }, query: "X-90", topScore: null, passages }, 0.56).level).toBe("strong");
  });
  it("judges a bare literal lookup by its score when a term is missing from every passage", () => {
    expect(judgeEvidence({ ...hybrid, query: "X-90 ZX-9100", topScore: 0.51, passages: [{ content: "the X-90 prototype" }] }, 0.56)).toEqual({ level: "weak", basis: "rerank", threshold: 0.56 });
  });
});

describe("isBareLiteralLookup", () => {
  it("is true only when the query is nothing but trigger terms", () => {
    expect(isBareLiteralLookup("X-90")).toBe(true);
    expect(isBareLiteralLookup("$115k")).toBe(true);
    expect(isBareLiteralLookup('"churn model"')).toBe(true);
    expect(isBareLiteralLookup("REQ-4471, X-90")).toBe(true);
    expect(isBareLiteralLookup("What are the H-1B filing fees?")).toBe(false);
    expect(isBareLiteralLookup("Acme funding news")).toBe(false);
    expect(isBareLiteralLookup("")).toBe(false);
  });
});
