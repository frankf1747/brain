import { describe, it, expect } from "vitest";
import { assertEvalDatabase, EVAL_DATABASE_URL } from "../../src/eval/db.js";

describe("eval database guard", () => {
  it("defaults to a *_eval database", () => {
    expect(new URL(EVAL_DATABASE_URL).pathname).toMatch(/_eval$/);
  });
  it("refuses the real and the test database", () => {
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/postgres")).toThrow(/must end in _eval/);
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_test")).toThrow(/must end in _eval/);
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_eval")).not.toThrow();
  });
});
