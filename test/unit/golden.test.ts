import { describe, it, expect } from "vitest";
import { parseGolden } from "../../src/eval/golden.js";

const ok = JSON.stringify({
  id: "q01", question: "What is the salary range?", kind: "keyword",
  expected: [{ origin: "job_description--acme-senior-data-analyst.md" }],
  source: "fixture", approved_at: "2026-09-30",
});

describe("parseGolden", () => {
  it("parses one item per non-empty line", () => {
    const items = parseGolden(`${ok}\n\n${ok.replace("q01", "q02")}\n`);
    expect(items.map((i) => i.id)).toEqual(["q01", "q02"]);
    expect(items[0].expected[0].origin).toBe("job_description--acme-senior-data-analyst.md");
    expect(items[0].negative).toBe(false);
  });
  it("rejects duplicate ids", () => {
    expect(() => parseGolden(`${ok}\n${ok}`)).toThrow(/duplicate id q01/);
  });
  it("requires expected documents unless the item is negative", () => {
    const empty = JSON.stringify({ id: "q03", question: "x", kind: "semantic", expected: [], source: "fixture", approved_at: "2026-09-30" });
    expect(() => parseGolden(empty)).toThrow(/q03.*expected/);
    const neg = JSON.stringify({ id: "q04", question: "x", kind: "negative", expected: [], negative: true, source: "fixture", approved_at: "2026-09-30" });
    expect(parseGolden(neg)[0].negative).toBe(true);
  });
  it("rejects a negative item that lists expected documents", () => {
    const bad = JSON.stringify({ id: "q05", question: "x", kind: "negative", expected: [{ origin: "a.md" }], negative: true, source: "fixture", approved_at: "2026-09-30" });
    expect(() => parseGolden(bad)).toThrow(/q05.*negative/);
  });
  it("includes the line number in the negative and expected errors", () => {
    const empty = JSON.stringify({ id: "q03", question: "x", kind: "semantic", expected: [], source: "fixture", approved_at: "2026-09-30" });
    expect(() => parseGolden(`${ok}\n${empty}`)).toThrow(/line 2.*q03.*expected/);
    const bad = JSON.stringify({ id: "q05", question: "x", kind: "negative", expected: [{ origin: "a.md" }], negative: true, source: "fixture", approved_at: "2026-09-30" });
    expect(() => parseGolden(`${ok}\n\n${bad}`)).toThrow(/line 3.*q05.*negative/);
  });
  it("requires kind negative exactly when negative is true", () => {
    const kindOnly = JSON.stringify({ id: "q06", question: "x", kind: "negative", expected: [{ origin: "a.md" }], source: "fixture", approved_at: "2026-09-30" });
    expect(() => parseGolden(kindOnly)).toThrow(/line 1.*q06.*kind/);
    const flagOnly = JSON.stringify({ id: "q07", question: "x", kind: "semantic", expected: [], negative: true, source: "fixture", approved_at: "2026-09-30" });
    expect(() => parseGolden(flagOnly)).toThrow(/line 1.*q07.*kind/);
  });
  it("rejects unknown keys on the item and on expected entries", () => {
    const extra = JSON.stringify({ ...JSON.parse(ok), expect: [] });
    expect(() => parseGolden(extra)).toThrow(/line 1.*expect/);
    const typo = JSON.stringify({ ...JSON.parse(ok), expected: [{ origin: "a.md", qoute: "x" }] });
    expect(() => parseGolden(typo)).toThrow(/line 1: expected\.0: .*qoute/);
  });
  it("names the field path in schema errors", () => {
    const bad = JSON.stringify({ ...JSON.parse(ok), kind: "bogus" });
    expect(() => parseGolden(bad)).toThrow(/line 1: kind: /);
  });
  it("reports the line number of invalid JSON", () => {
    expect(() => parseGolden(`${ok}\n{not json`)).toThrow(/line 2/);
  });
});
