import { describe, it, expect } from "vitest";
import { setRecallAtK, mrr, ndcgAt10, abstained, falseAnswer, summarize, type QuestionResult } from "../../src/eval/metrics.js";

const ranked = (...ids: string[]) => ids.map((documentId) => ({ documentId, origin: `/c/${documentId}.md`, containsQuote: false }));
const exp = (...origins: string[]) => origins.map((origin) => ({ origin: `${origin}.md` }));

function result(partial: Partial<QuestionResult>): QuestionResult {
  return {
    id: "q", kind: "keyword", negative: false, expected: [], ranked: [], totalRelevant: 0, topScore: 0.9, hasGraphPassage: false,
    degraded: false, totalMs: 10, timings: { embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0, totalMs: 10 },
    paraphraseRanked: [], paraphraseDegraded: [], ...partial,
  };
}

describe("set recall and MRR", () => {
  it("counts the fraction of expected documents in the top k", () => {
    expect(setRecallAtK(exp("a", "b"), ranked("a", "c", "d"), 10)).toBe(0.5);
    expect(setRecallAtK(exp("a", "b"), ranked("c", "a", "b"), 1)).toBe(0);
    expect(setRecallAtK(exp("a"), ranked("c", "a"), 5)).toBe(1);
  });
  it("takes the top k passages before deduplicating documents", () => {
    expect(setRecallAtK(exp("b"), ranked("a", "a", "b"), 2)).toBe(0);
    expect(setRecallAtK(exp("b"), ranked("a", "a", "b"), 3)).toBe(1);
  });
  it("matches by document id, exact origin, or origin suffix on a path boundary", () => {
    expect(setRecallAtK([{ document_id: "a" }], ranked("a"), 10)).toBe(1);
    expect(setRecallAtK([{ origin: "zzz.md" }], ranked("a"), 10)).toBe(0);
    expect(setRecallAtK([{ origin: "a.md" }], [{ documentId: "x", origin: "a.md", containsQuote: false }], 10)).toBe(1);
    expect(setRecallAtK([{ origin: "a.md" }], ranked("xa"), 10)).toBe(0);
  });
  it("mrr is one over the rank of the first expected document, deduplicated by document", () => {
    expect(mrr(exp("b"), ranked("a", "a", "b"))).toBe(0.5);
    expect(mrr(exp("z"), ranked("a"))).toBe(0);
  });
});

describe("nDCG@10", () => {
  it("is 1 when the only relevant passage is first and lower when it is third", () => {
    expect(ndcgAt10([true, false, false], 1)).toBe(1);
    expect(ndcgAt10([false, false, true], 1)).toBeCloseTo(1 / Math.log2(4));
    expect(ndcgAt10([false, false], 1)).toBe(0);
  });
  it("normalises by every relevant passage in the corpus, not only the retrieved ones", () => {
    const v = ndcgAt10([true, false, false], 3);
    expect(v).toBeLessThan(1);
    expect(v).toBeCloseTo(1 / (1 + 1 / Math.log2(3) + 1 / Math.log2(4)));
  });
  it("caps the ideal at 10 and is 0 when nothing is relevant", () => {
    expect(ndcgAt10(Array(10).fill(true), 15)).toBeCloseTo(1);
    expect(ndcgAt10([true], 0)).toBe(0);
  });
});

describe("negatives", () => {
  it("abstains when the top score is below the threshold and no graph passage was added", () => {
    expect(abstained(result({ topScore: 0.1, hasGraphPassage: false }), 0.3)).toBe(true);
    expect(abstained(result({ topScore: null, hasGraphPassage: false }), 0.3)).toBe(true);
    expect(abstained(result({ topScore: 0.5, hasGraphPassage: false }), 0.3)).toBe(false);
    expect(abstained(result({ topScore: 0.1, hasGraphPassage: true }), 0.3)).toBe(false);
  });
  it("is a false answer only when the top score reaches the threshold", () => {
    expect(falseAnswer(result({ topScore: 0.3 }), 0.3)).toBe(true);
    expect(falseAnswer(result({ topScore: 0.1, hasGraphPassage: true }), 0.3)).toBe(false);
    expect(falseAnswer(result({ topScore: null }), 0.3)).toBe(false);
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
  it("a graph-only negative is neither abstained nor a false answer, so the rates need not sum to 1", () => {
    const r = summarize([
      result({ id: "a", negative: true, kind: "negative", topScore: 0.1 }),
      result({ id: "f", negative: true, kind: "negative", topScore: 0.8 }),
      result({ id: "g", negative: true, kind: "negative", topScore: 0.1, hasGraphPassage: true }),
    ], 0.3);
    expect(r.negatives.abstentionRate).toBeCloseTo(1 / 3);
    expect(r.negatives.falseAnswerRate).toBeCloseTo(1 / 3);
  });
  it("uses totalRelevant for nDCG", () => {
    const quoted = [{ origin: "a.md", quote: "q" }];
    const r = summarize([
      result({ id: "1", expected: quoted, ranked: [{ documentId: "a", origin: "/c/a.md", containsQuote: true }], totalRelevant: 3 }),
    ], 0.3);
    expect(r.overall.ndcgAt10).toBeLessThan(1);
  });
  it("reports p50 and p95 per search stage", () => {
    const t = (embedMs: number, sqlMs: number, rerankMs: number, graphMs: number) => ({ embedMs, sqlMs, rerankMs, graphMs, totalMs: embedMs + sqlMs + rerankMs + graphMs });
    const r = summarize([
      result({ id: "1", timings: t(100, 10, 200, 1) }),
      result({ id: "2", timings: t(120, 30, 250, 2) }),
      result({ id: "3", timings: t(400, 20, 220, 0) }),
    ], 0.3);
    expect(r.stageLatencyMs).toEqual({
      embed: { p50: 120, p95: 400 },
      sql: { p50: 20, p95: 30 },
      rerank: { p50: 220, p95: 250 },
      graph: { p50: 1, p95: 2 },
    });
  });
  it("counts paraphrase searches in the degraded fraction", () => {
    const r = summarize([
      result({ id: "1", expected: exp("a"), ranked: ranked("a"), paraphraseRanked: [ranked("a"), ranked("a"), ranked("a")], paraphraseDegraded: [true, false, false] }),
    ], 0.3);
    expect(r.degradedFraction).toBeCloseTo(1 / 4);
  });
});

describe("paraphrase consistency", () => {
  it("is the share of paraphrases whose top-10 finds the same set of expected entries", () => {
    const r = summarize([
      result({ id: "1", kind: "semantic", expected: exp("a"), ranked: ranked("a"), paraphraseRanked: [ranked("a"), ranked("b")] }),
    ], 0.3);
    expect(r.paraphrase.n).toBe(2);
    expect(r.paraphrase.consistency).toBe(0.5);
  });
  it("same recall but a different set is inconsistent", () => {
    const r = summarize([
      result({ id: "1", expected: exp("a", "b"), ranked: ranked("a"), paraphraseRanked: [ranked("b")] }),
    ], 0.3);
    expect(r.paraphrase.consistency).toBe(0);
    expect(r.paraphrase.meanRecallDelta).toBe(0);
  });
  it("both missing everything is consistent", () => {
    const r = summarize([result({ id: "1", expected: exp("a"), ranked: ranked("x"), paraphraseRanked: [ranked("y")] })], 0.3);
    expect(r.paraphrase.consistency).toBe(1);
  });
  it("meanRecallDelta is positive when the paraphrase does better", () => {
    const r = summarize([
      result({ id: "1", expected: exp("a", "b"), ranked: ranked("a"), paraphraseRanked: [ranked("a", "b")] }),
    ], 0.3);
    expect(r.paraphrase.meanRecallDelta).toBeCloseTo(0.5);
  });
});
