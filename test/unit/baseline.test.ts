import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, gate, gateFailures, loadBaseline, saveBaseline, type Baseline } from "../../src/eval/baseline.js";
import type { Report } from "../../src/eval/metrics.js";

function report(overrides: Partial<Report["overall"]> = {}, extra: Partial<Report> = {}): Report {
  return {
    n: 3,
    overall: { n: 3, recallAt1: 0.5, recallAt5: 0.8, recallAt10: 1, mrr: 0.9, ndcgAt10: null, ...overrides },
    byKind: {},
    negatives: { n: 0, abstentionRate: 0, falseAnswerRate: 0 },
    paraphrase: { n: 0, consistency: 0, meanRecallDelta: 0 },
    degradedFraction: 0,
    latencyMs: { p50: 10, p95: 20 },
    ...extra,
  };
}

const ids = ["q1", "q2", "q3"];
const base: Baseline = { recordedAt: "2026-09-30T00:00:00Z", commit: "abc", goldenIds: ids, report: report(), ranks: { q1: 1, q2: 2, q3: null } };

describe("compare", () => {
  it("lists metric deltas and the questions whose rank got worse", () => {
    const c = compare(base, report({ recallAt10: 0.9, mrr: 0.95 }), { q1: 1, q2: 3, q3: 2 }, ids);
    expect(c.deltas.recallAt10).toBeCloseTo(-0.1);
    expect(c.deltas.mrr).toBeCloseTo(0.05);
    expect(c.regressions).toEqual([{ id: "q2", before: 2, after: 3 }]);
    expect(c.improvements).toEqual([{ id: "q3", before: null, after: 2 }]);
    expect(c.goldenChanged).toBe(false);
  });
  it("treats a new miss as a regression", () => {
    const c = compare(base, report(), { q1: null, q2: 2, q3: null }, ids);
    expect(c.regressions).toEqual([{ id: "q1", before: 1, after: null }]);
  });
  it("records whether the golden ids changed, ignoring order", () => {
    expect(compare(base, report(), base.ranks, ["q3", "q1", "q2"]).goldenChanged).toBe(false);
    expect(compare(base, report(), base.ranks, ["q1", "q2"]).goldenChanged).toBe(true);
    expect(compare(base, report(), base.ranks, ["q1", "q2", "q4"]).goldenChanged).toBe(true);
  });
});

describe("gate", () => {
  it("passes when nothing dropped more than the tolerance", () => {
    expect(gate(compare(base, report({ recallAt10: 0.99, mrr: 0.89 }), base.ranks, ids))).toEqual([]);
  });
  it("passes a drop of exactly the tolerance despite floating-point error", () => {
    expect(gate(compare(base, report({ recallAt10: 0.98, mrr: 0.88 }), base.ranks, ids))).toEqual([]);
  });
  it("fails on a recall or MRR drop above 0.02, a lower abstention rate, or any degraded search", () => {
    const withNeg: Baseline = { ...base, report: report({}, { negatives: { n: 2, abstentionRate: 1, falseAnswerRate: 0 } }) };
    const failures = gate(compare(withNeg, report({ recallAt10: 0.9, mrr: 0.8 }, { negatives: { n: 2, abstentionRate: 0.5, falseAnswerRate: 0.5 }, degradedFraction: 0.1 }), base.ranks, ids));
    expect(failures).toEqual([
      "recallAt10 dropped 0.100 (tolerance 0.02)",
      "mrr dropped 0.100 (tolerance 0.02)",
      "abstention rate fell from 1.00 to 0.50",
      "10% of searches ran degraded; must be 0",
    ]);
  });
  it("fails when the golden set changed since the baseline", () => {
    expect(gate(compare(base, report(), base.ranks, ["q1", "q2"]))).toEqual([
      "golden set changed since the baseline; review and run `eval run --accept`",
    ]);
  });
  it("fails when the baseline had negatives and the current run has none", () => {
    const withNeg: Baseline = { ...base, report: report({}, { negatives: { n: 2, abstentionRate: 1, falseAnswerRate: 0 } }) };
    expect(gate(compare(withNeg, report(), base.ranks, ids))).toEqual(["negative items disappeared"]);
  });
});

describe("loadBaseline", () => {
  it("round-trips a saved baseline and returns null when the file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseline-"));
    await saveBaseline(join(dir, "b.json"), base);
    expect(await loadBaseline(join(dir, "b.json"))).toEqual(base);
    expect(await loadBaseline(join(dir, "missing.json"))).toBeNull();
  });
  it("loads a baseline with per-stage latency, and one recorded before Phase 4 without it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseline-"));
    const p50p95 = { p50: 1, p95: 2 };
    const withStages: Baseline = { ...base, report: report({}, { stageLatencyMs: { embed: p50p95, sql: p50p95, rerank: p50p95, graph: p50p95 } }) };
    await saveBaseline(join(dir, "b.json"), withStages);
    expect(await loadBaseline(join(dir, "b.json"))).toEqual(withStages);
    const committed = await loadBaseline("eval/baseline.json");
    expect(committed).not.toBeNull();
    expect(committed!.report.stageLatencyMs).toBeUndefined();
  });
  it("throws a clear error on a malformed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseline-"));
    const p = join(dir, "bad.json");
    const { goldenIds: _omit, ...noIds } = base;
    await writeFile(p, JSON.stringify(noIds));
    await expect(loadBaseline(p)).rejects.toThrow(/malformed baseline.*goldenIds/);
    await writeFile(p, "{not json");
    await expect(loadBaseline(p)).rejects.toThrow(/malformed baseline/);
  });
});

describe("gateFailures", () => {
  const opts = { gate: true, accept: false, baselinePath: "eval/baseline.json" };
  it("fails the gate when there is no baseline to compare against", () => {
    expect(gateFailures(null, opts)).toEqual(["no baseline at eval/baseline.json; record one with `eval run --accept`"]);
  });
  it("does not fail without --gate, or when this run records the baseline with --accept", () => {
    expect(gateFailures(null, { ...opts, gate: false })).toEqual([]);
    expect(gateFailures(null, { ...opts, accept: true })).toEqual([]);
  });
  it("runs the gate on a comparison only with --gate", () => {
    const c = compare(base, report({ recallAt10: 0.9 }), base.ranks, ids);
    expect(gateFailures(c, opts)).toEqual(gate(c));
    expect(gateFailures(c, { ...opts, gate: false })).toEqual([]);
  });
});
