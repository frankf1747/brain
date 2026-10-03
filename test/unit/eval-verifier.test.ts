import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVerifierSet, toClaim, verifierReport, verifierGate, verifierLine, renderVerifierRun, summarizeVerifierRun, knownLimitLine,
  loadVerifierBaseline, saveVerifierBaseline, VERIFIER_PRECISION_MIN, VERIFIER_FULL_TOLERANCE,
  type VerifierItem, type VerifierItemResult, type VerifierBaseline,
} from "../../src/eval/verifier.js";
import type { Verdict } from "../../src/verify/verify.js";

const item = (over: Partial<VerifierItem> = {}): VerifierItem => ({
  id: "v1", case: "exact", retrieval: { documents: ["news--acme-series-b.md"] }, claim: "Acme was founded in 2019.",
  cites: [{ label: "P1", text: "Acme was founded in 2019 and employs about 300 people." }], expected_verdict: "supported", note: "n", labelled_by: "agent:claude",
  ...over,
});

const pairs = (spec: [Verdict, Verdict, number][]) => spec.flatMap(([expected, predicted, n]) => Array.from({ length: n }, () => ({ expected, predicted })));

describe("verifierReport", () => {
  it("computes precision and recall of supported, accuracy, and the confusion matrix (rows labelled, columns verifier)", () => {
    const r = verifierReport(pairs([["supported", "supported", 18], ["supported", "partial", 2], ["partial", "supported", 2], ["partial", "partial", 6], ["unsupported", "unsupported", 2]]));
    expect(r.n).toBe(30);
    expect(r.precision).toBeCloseTo(18 / 20, 10);
    expect(r.recall).toBeCloseTo(18 / 20, 10);
    expect(r.accuracy).toBeCloseTo(26 / 30, 10);
    expect(r.confusion.supported).toEqual({ supported: 18, partial: 2, unsupported: 0, uncited: 0, bad_citation: 0 });
    expect(r.confusion.partial.supported).toBe(2);
  });

  it("leaves precision and recall undefined (null) when nothing is marked or labelled supported", () => {
    const r = verifierReport(pairs([["partial", "unsupported", 3]]));
    expect(r).toMatchObject({ n: 3, precision: null, recall: null, accuracy: 0 });
    expect(verifierReport([])).toMatchObject({ n: 0, precision: null, recall: null, accuracy: 0 });
  });
});

const result = (verdict: Verdict, support: number | null = 1) => ({
  claim: "c", labels: [], verdict, support, matchedTerms: [], missingTerms: [], missingNumbers: [], negationMismatch: false, missingPolarity: [], badLabels: [], cites: [],
});
/** Items from [case, expected, predicted, count] rows, ids v1, v2, … in order. */
function items(spec: [VerifierItem["case"], Verdict, Verdict, number][]): VerifierItemResult[] {
  let i = 0;
  return spec.flatMap(([c, expected, predicted, n]) =>
    Array.from({ length: n }, () => ({ id: `v${++i}`, case: c, expected, predicted, result: result(predicted) })));
}
const baselineFor = (precision: number | null, ids: string[]): VerifierBaseline => ({ recordedAt: "2026-10-03T00:00:00.000Z", commit: "abc1234", itemIds: ids, precision, recall: 1, accuracy: 1 });
// Regular: 9 of 9 supported right. Full: plus 4 known limits marked supported, so precision 9/13.
const healthy = items([["exact", "supported", "supported", 9], ["exact", "partial", "partial", 3], ["known_limit", "partial", "supported", 4], ["known_limit", "partial", "partial", 1]]);
const ids = healthy.map((i) => i.id);

describe("summarizeVerifierRun", () => {
  it("scores two views: regular (every case but known_limit) and full (every item)", () => {
    const run = summarizeVerifierRun(healthy);
    expect(run.regular).toMatchObject({ n: 12, precision: 1, recall: 1, accuracy: 1 });
    expect(run.full.n).toBe(17);
    expect(run.full.precision).toBeCloseTo(9 / 13, 10);
    expect(run.full.confusion.partial.supported).toBe(4);
    expect(run.regular.confusion.partial.supported).toBe(0);
  });
});

describe("verifierGate", () => {
  it("passes when regular precision is at least 0.9 and full precision is within 0.02 of the baseline", () => {
    expect(VERIFIER_PRECISION_MIN).toBe(0.9);
    expect(VERIFIER_FULL_TOLERANCE).toBe(0.02);
    const run = summarizeVerifierRun(healthy);
    expect(verifierGate(run, baselineFor(9 / 13, ids))).toEqual([]);
    expect(verifierGate(run, baselineFor(9 / 13 + 0.02, ids))).toEqual([]);
  });

  it("fails when regular precision of supported is below 0.9, or undefined", () => {
    const worse = summarizeVerifierRun(items([["exact", "supported", "supported", 8], ["exact", "partial", "supported", 2]]));
    expect(verifierGate(worse, baselineFor(0.8, worse.items.map((i) => i.id)))).toEqual(["verifier: regular precision of supported is 0.800, below 0.9"]);
    const none = summarizeVerifierRun(items([["exact", "supported", "partial", 3]]));
    expect(verifierGate(none, baselineFor(null, none.items.map((i) => i.id)))).toEqual(["verifier: no regular claim was marked supported, so its precision of supported is undefined"]);
  });

  it("fails when full precision drops more than 0.02 below the baseline", () => {
    const run = summarizeVerifierRun(healthy);
    expect(verifierGate(run, baselineFor(0.75, ids))).toEqual(["verifier: full precision of supported is 0.692, more than 0.02 below the baseline 0.750"]);
  });

  it("fails when the item set changed since the baseline", () => {
    const run = summarizeVerifierRun(healthy);
    expect(verifierGate(run, baselineFor(9 / 13, [...ids, "v99"]))).toEqual(["verifier set changed; review and run `eval verifier --accept`"]);
    expect(verifierGate(run, baselineFor(9 / 13, ids.slice(1)))).toEqual(["verifier set changed; review and run `eval verifier --accept`"]);
  });

  it("fails without a baseline, unless this run records one", () => {
    const run = summarizeVerifierRun(healthy);
    expect(verifierGate(run, null)).toEqual(["no verifier baseline at eval/verifier-baseline.json; record one with `eval verifier --accept`"]);
    expect(verifierGate(run, null, { accept: true })).toEqual([]);
    expect(verifierGate(run, baselineFor(0.99, ids), { accept: true })).toEqual([]);
  });
});

describe("verifier lines", () => {
  it("prints the regular line with its gate, the full line with its baseline, and the known limits still passed", () => {
    const run = summarizeVerifierRun(healthy);
    expect(verifierLine(run, baselineFor(9 / 13, ids))).toEqual([
      "verifier regular n=12 supported precision=1.00 recall=1.00 accuracy=1.00 (gate ≥ 0.90)",
      "verifier full    n=17 supported precision=0.69 recall=1.00 accuracy=0.76 (baseline 0.69)",
    ]);
    expect(verifierLine(run, null)[1]).toBe("verifier full    n=17 supported precision=0.69 recall=1.00 accuracy=0.76 (no baseline)");
    expect(knownLimitLine(run)).toBe("known limits: 4 of 5 still marked supported (documented in README)");
    const empty = summarizeVerifierRun([]);
    expect(verifierLine(empty, null)[0]).toBe("verifier regular n=0 supported precision=n/a recall=n/a accuracy=0.00 (gate ≥ 0.90)");
  });
});

describe("verifier baseline file", () => {
  it("round-trips through save and load with sorted ids, returns null when missing, and rejects a malformed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verifier-baseline-"));
    const path = join(dir, "b.json");
    expect(await loadVerifierBaseline(path)).toBeNull();
    await saveVerifierBaseline(path, baselineFor(0.5, ["v2", "v10", "v1"]));
    expect(await loadVerifierBaseline(path)).toEqual(baselineFor(0.5, ["v1", "v10", "v2"]));
    await writeFile(path, JSON.stringify({ commit: "x" }));
    await expect(loadVerifierBaseline(path)).rejects.toThrow(/^malformed verifier baseline .*: .*eval verifier --accept/);
    await writeFile(path, "{");
    await expect(loadVerifierBaseline(path)).rejects.toThrow(/^malformed verifier baseline .*invalid JSON/);
  });
});

describe("parseVerifierSet and toClaim", () => {
  it("parses one item per line and rejects bad JSON, unknown keys, an unknown case and duplicate ids, with the line number", () => {
    const line = JSON.stringify(item());
    expect(parseVerifierSet(`${line}\n\n`)).toHaveLength(1);
    expect(() => parseVerifierSet("{")).toThrow(/^verifier line 1: invalid JSON/);
    expect(() => parseVerifierSet(`${line}\n${JSON.stringify({ ...item({ id: "v2" }), extra: 1 })}`)).toThrow(/^verifier line 2: .*extra/);
    expect(() => parseVerifierSet(JSON.stringify({ ...item(), case: "vibes" }))).toThrow(/^verifier line 1: case/);
    expect(() => parseVerifierSet(`${line}\n${line}`)).toThrow("verifier line 2: duplicate id v1");
  });

  it("turns passages, facts and missing labels into what the judge reads", () => {
    const c = toClaim(item({
      cites: [
        { label: "P1", text: "Base pay.", heading_path: ["Job", "Compensation"] },
        { label: "F1", predicate: "visa_status", object_text: "F-1 OPT" },
        { label: "P9", missing: true },
      ],
    }));
    expect(c).toEqual({
      text: "Acme was founded in 2019.",
      labels: ["P1", "F1", "P9"],
      cited: [{ label: "P1", kind: "passage", text: "Job > Compensation\nBase pay." }, { label: "F1", kind: "fact", text: "visa status: F-1 OPT" }],
      cites: [],
      badLabels: [{ label: "P9", reason: "not in the retrieval" }],
    });
  });
});

describe("renderVerifierRun", () => {
  it("marks each item ok or MISS, prints both confusion matrices and the summary lines", () => {
    const two = [
      { id: "v1", case: "exact" as const, expected: "supported" as const, predicted: "supported" as const, result: result("supported", 1) },
      { id: "v2", case: "known_limit" as const, expected: "partial" as const, predicted: "supported" as const, result: result("supported", 0.75) },
    ];
    const lines = renderVerifierRun(summarizeVerifierRun(two), null);
    expect(lines.slice(0, 2)).toEqual([
      "ok    v1    exact           supported 1.00",
      "MISS  v2    known_limit     expected partial, got supported 0.75",
    ]);
    expect(lines).toContain("confusion, regular (rows: labelled, columns: verifier)");
    expect(lines).toContain("confusion, full (rows: labelled, columns: verifier)");
    expect(lines).toContain("partial" + " ".repeat(6) + "            1            0            0            0            0");
    expect(lines.slice(-3)).toEqual([
      "verifier regular n=1 supported precision=1.00 recall=1.00 accuracy=1.00 (gate ≥ 0.90)",
      "verifier full    n=2 supported precision=0.50 recall=1.00 accuracy=0.50 (no baseline)",
      "known limits: 1 of 1 still marked supported (documented in README)",
    ]);
  });
});
