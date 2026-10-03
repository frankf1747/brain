import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { runVerifierFile, verifierGate, verifierLine, knownLimitLine, loadVerifierBaseline } from "../../src/eval/verifier.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("the verifier eval on eval/verifier.jsonl", () => {
  it("passes the split gate with real Postgres stems, every miss a documented one, and writes nothing", async () => {
    const run = (await runVerifierFile(sql, "eval/verifier.jsonl"))!;
    const misses = run.items.filter((i) => i.expected !== i.predicted).map((i) => `${i.id} ${i.case}: expected ${i.expected}, got ${i.predicted}`);
    // Every miss is one the set documents: v10 and v48 (their notes say "the verifier says partial") and the known
    // limits, which are labelled with the true verdict so each one counts as a precision error.
    const knownLimits = [61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 79, 80, 81];
    expect(misses).toEqual([
      "v10 exact: expected supported, got partial",
      "v48 unrelated: expected unsupported, got partial",
      ...knownLimits.map((n) => `v${n} known_limit: expected partial, got supported`),
    ]);
    // Two views: regular (the cases the method is designed for) must stay at 0.9 precision of supported; full (the
    // documented limits included) must stay within 0.02 of eval/verifier-baseline.json.
    const baseline = await loadVerifierBaseline("eval/verifier-baseline.json");
    expect(verifierLine(run, baseline)).toEqual([
      "verifier regular n=80 supported precision=1.00 recall=0.97 accuracy=0.97 (gate ≥ 0.90)",
      "verifier full    n=101 supported precision=0.66 recall=0.97 accuracy=0.79 (baseline 0.66)",
    ]);
    expect(knownLimitLine(run)).toBe("known limits: 19 of 21 still marked supported (documented in README)");
    expect(verifierGate(run, baseline)).toEqual([]);
    expect((await sql`select id from brain.verification_log`).length).toBe(0);
  });

  it("returns null for a missing file", async () => {
    expect(await runVerifierFile(sql, "eval/no-such-file.jsonl")).toBeNull();
  });
});
