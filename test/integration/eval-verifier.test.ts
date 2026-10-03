import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { runVerifierFile, verifierGate, verifierLine } from "../../src/eval/verifier.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("the verifier eval on eval/verifier.jsonl", () => {
  it("passes the gate (precision of supported at least 0.9) with real Postgres stems, and writes nothing", async () => {
    const run = (await runVerifierFile(sql, "eval/verifier.jsonl"))!;
    const misses = run.items.filter((i) => i.expected !== i.predicted).map((i) => `${i.id} ${i.case}: expected ${i.expected}, got ${i.predicted}`);
    expect([verifierLine(run.report), verifierGate(run.report)]).toEqual([verifierLine(run.report), []]);
    expect(run.report.precision).toBeGreaterThanOrEqual(0.9);
    // Every miss is one the set documents: the three known limits and the two notes that say "the verifier says partial".
    expect(misses).toEqual([
      "v10 exact: expected supported, got partial",
      "v48 unrelated: expected unsupported, got partial",
      "v61 known_limit: expected partial, got supported",
      "v62 known_limit: expected partial, got supported",
      "v63 known_limit: expected partial, got supported",
    ]);
    expect((await sql`select id from brain.verification_log`).length).toBe(0);
  });

  it("returns null for a missing file", async () => {
    expect(await runVerifierFile(sql, "eval/no-such-file.jsonl")).toBeNull();
  });
});
