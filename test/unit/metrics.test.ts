import { describe, it, expect } from "vitest";
import { setRecallAtK, mrr, ndcgAt10, abstained, summarize, type QuestionResult } from "../../src/eval/metrics.js";

const ranked = (...ids: string[]) => ids.map((documentId) => ({ documentId, origin: `/c/${documentId}.md`, containsQuote: false }));
const exp = (...origins: string[]) => origins.map((origin) => ({ origin: `${origin}.md` }));

function result(partial: Partial<QuestionResult>): QuestionResult {
  return { id: "q", kind: "keyword", negative: false, expected: [], ranked: [], topScore: 0.9, hasGraphPassage: false, degraded: false, totalMs: 10, paraphraseRanked: [], ...partial };
}

describe("set recall and MRR", () => {
  it("counts the fraction of expected documents in the top k", () => {
    expect(setRecallAtK(exp("a", "b"), ranked("a", "c", "d"), 10)).toBe(0.5);
    expect(setRecallAtK(exp("a", "b"), ranked("c", "a", "b"), 1)).toBe(0);
    expect(setRecallAtK(exp("a"), ranked("c", "a"), 5)).toBe(1);
  });
  it("matches by origin suffix or document id", () => {
    expect(setRecallAtK([{ document_id: "a" }], ranked("a"), 10)).toBe(1);
    expect(setRecallAtK([{ origin: "zzz.md" }], ranked("a"), 10)).toBe(0);
  });
  it("mrr is one over the rank of the first expected document, deduplicated by document", () => {
    expect(mrr(exp("b"), ranked("a", "a", "b"))).toBe(0.5);
    expect(mrr(exp("z"), ranked("a"))).toBe(0);
  });
});

describe("nDCG@10", () => {
  it("is 1 when the only relevant passage is first and lower when it is third", () => {
    expect(ndcgAt10([true, false, false])).toBe(1);
    expect(ndcgAt10([false, false, true])).toBeCloseTo(1 / Math.log2(4));
    expect(ndcgAt10([false, false])).toBe(0);
  });
});

describe("abstention", () => {
  it("abstains when the top score is below the threshold and no graph passage was added", () => {
    expect(abstained(result({ topScore: 0.1, hasGraphPassage: false }), 0.3)).toBe(true);
    expect(abstained(result({ topScore: null, hasGraphPassage: false }), 0.3)).toBe(true);
    expect(abstained(result({ topScore: 0.5, hasGraphPassage: false }), 0.3)).toBe(false);
    expect(abstained(result({ topScore: 0.1, hasGraphPassage: true }), 0.3)).toBe(false);
  });
});

describe("summarize", () => {
  it("reports overall and per-kind metrics, abstention, degraded fraction and latency", () => {
    const r = summarize([
      result({ id: "1", kind: "keyword", expected: exp("a"), ranked: ranked("a"), totalMs: 10 }),
      result({ id: "2", kind: "keyword", expected: exp("a"), ranked: ranked("b", "a"), totalMs: 30, degraded: true }),
      result({ id: "3", kind: "semantic", expected: exp("z"), ranked: ranked("b"), totalMs: 20 }),
      result({ id: "4", kind: "negative", negative: true, topScore: 0.1, totalMs: 5 }),
      result({ id: "5", kind: "negative", negative: true, topScore: 0.8, totalMs: 5 }),
    ], 0.3);
    expect(r.n).toBe(5);
    expect(r.overall.recallAt10).toBeCloseTo(2 / 3);
    expect(r.overall.recallAt1).toBeCloseTo(1 / 3);
    expect(r.overall.mrr).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(r.byKind.keyword.recallAt10).toBe(1);
    expect(r.byKind.semantic.mrr).toBe(0);
    expect(r.negatives.n).toBe(2);
    expect(r.negatives.abstentionRate).toBe(0.5);
    expect(r.negatives.falseAnswerRate).toBe(0.5);
    expect(r.degradedFraction).toBeCloseTo(1 / 5);
    expect(r.latencyMs.p50).toBe(10);
    expect(r.latencyMs.p95).toBe(30);
  });
  it("paraphrase consistency is the share of paraphrases whose top-10 covers the same expected documents", () => {
    const r = summarize([
      result({ id: "1", kind: "semantic", expected: exp("a"), ranked: ranked("a"), paraphraseRanked: [ranked("a"), ranked("b")] }),
    ], 0.3);
    expect(r.paraphrase.n).toBe(2);
    expect(r.paraphrase.consistency).toBe(0.5);
  });
});
