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
  it("refuses query parameters that postgres.js would forward to the server, naming the key", () => {
    // postgres.js copies unknown query params into the startup message, so this would connect to "postgres".
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_eval?database=postgres")).toThrow(/parameter "database"/);
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_eval?options=-c%20search_path%3Dx")).toThrow(/parameter "options"/);
  });
  it("allows sslmode, connect_timeout and application_name", () => {
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_eval?sslmode=disable&connect_timeout=5&application_name=eval")).not.toThrow();
  });
});
