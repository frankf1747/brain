import { describe, it, expect } from "vitest";
import { compare, gate, type Baseline } from "../../src/eval/baseline.js";
import type { Report } from "../../src/eval/metrics.js";

function report(overrides: Partial<Report["overall"]> = {}, extra: Partial<Report> = {}): Report {
  return {
    n: 3,
    overall: { n: 3, recallAt1: 0.5, recallAt5: 0.8, recallAt10: 1, mrr: 0.9, ndcgAt10: null, ...overrides },
    byKind: {},
    negatives: { n: 0, abstentionRate: 0, falseAnswerRate: 0 },
    paraphrase: { n: 0, consistency: 0 },
    degradedFraction: 0,
    latencyMs: { p50: 10, p95: 20 },
    ...extra,
  };
}

const base: Baseline = { recordedAt: "2026-09-30T00:00:00Z", commit: "abc", report: report(), ranks: { q1: 1, q2: 2, q3: null } };

describe("compare", () => {
  it("lists metric deltas and the questions whose rank got worse", () => {
    const c = compare(base, report({ recallAt10: 0.9, mrr: 0.95 }), { q1: 1, q2: 3, q3: 2 });
    expect(c.deltas.recallAt10).toBeCloseTo(-0.1);
    expect(c.deltas.mrr).toBeCloseTo(0.05);
    expect(c.regressions).toEqual([{ id: "q2", before: 2, after: 3 }]);
    expect(c.improvements).toEqual([{ id: "q3", before: null, after: 2 }]);
  });
  it("treats a new miss as a regression", () => {
    const c = compare(base, report(), { q1: null, q2: 2, q3: null });
    expect(c.regressions).toEqual([{ id: "q1", before: 1, after: null }]);
  });
});

describe("gate", () => {
  it("passes when nothing dropped more than the tolerance", () => {
    expect(gate(compare(base, report({ recallAt10: 0.99, mrr: 0.89 }), base.ranks))).toEqual([]);
  });
  it("fails on a recall or MRR drop above 0.02, a lower abstention rate, or any degraded search", () => {
    const withNeg: Baseline = { ...base, report: report({}, { negatives: { n: 2, abstentionRate: 1, falseAnswerRate: 0 } }) };
    const failures = gate(compare(withNeg, report({ recallAt10: 0.9, mrr: 0.8 }, { negatives: { n: 2, abstentionRate: 0.5, falseAnswerRate: 0.5 }, degradedFraction: 0.1 }), base.ranks));
    expect(failures).toEqual([
      "recallAt10 dropped 0.100 (tolerance 0.02)",
      "mrr dropped 0.100 (tolerance 0.02)",
      "abstention rate fell from 1.00 to 0.50",
      "10% of searches ran degraded; must be 0",
    ]);
  });
});
