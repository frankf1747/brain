import { describe, it, expect } from "vitest";
import {
  parseVerifierSet, toClaim, verifierReport, verifierGate, verifierLine, renderVerifierRun, VERIFIER_PRECISION_MIN, type VerifierItem,
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

describe("verifierGate and verifierLine", () => {
  it("fails below 0.9 precision of supported, passes at exactly 0.9, and fails when precision is undefined", () => {
    expect(VERIFIER_PRECISION_MIN).toBe(0.9);
    expect(verifierGate(verifierReport(pairs([["supported", "supported", 9], ["partial", "supported", 1]])))).toEqual([]);
    expect(verifierGate(verifierReport(pairs([["supported", "supported", 8], ["partial", "supported", 2]])))).toEqual(["verifier: precision of supported is 0.800, below 0.9"]);
    expect(verifierGate(verifierReport(pairs([["supported", "partial", 3]])))).toEqual(["verifier: no claim was marked supported, so precision of supported is undefined"]);
  });

  it("prints n, precision, recall and accuracy on one line", () => {
    expect(verifierLine(verifierReport(pairs([["supported", "supported", 9], ["partial", "supported", 1], ["supported", "partial", 1]])))).toBe(
      "verifier  n=11  supported precision=0.90 recall=0.90  accuracy=0.82",
    );
    expect(verifierLine(verifierReport([]))).toBe("verifier  n=0  supported precision=n/a recall=n/a  accuracy=0.00");
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
  it("marks each item ok or MISS, prints the confusion matrix and the summary line", () => {
    const result = (verdict: Verdict, support: number | null) => ({
      claim: "c", labels: [], verdict, support, matchedTerms: [], missingTerms: [], missingNumbers: [], negationMismatch: false, badLabels: [], cites: [],
    });
    const items = [
      { id: "v1", case: "exact" as const, expected: "supported" as const, predicted: "supported" as const, result: result("supported", 1) },
      { id: "v2", case: "known_limit" as const, expected: "partial" as const, predicted: "supported" as const, result: result("supported", 0.75) },
    ];
    const lines = renderVerifierRun({ items, report: verifierReport(items) });
    expect(lines.slice(0, 2)).toEqual([
      "ok    v1    exact           supported 1.00",
      "MISS  v2    known_limit     expected partial, got supported 0.75",
    ]);
    expect(lines).toContain("confusion (rows: labelled, columns: verifier)");
    expect(lines).toContain("partial" + " ".repeat(6) + "            1            0            0            0            0");
    expect(lines.at(-1)).toBe("verifier  n=2  supported precision=0.50 recall=1.00  accuracy=0.50");
  });
});
