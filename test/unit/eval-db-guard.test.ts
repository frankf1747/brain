import { describe, it, expect } from "vitest";
import { assertEvalDatabase, EVAL_DATABASE_URL, EVAL_REAL_DATABASE_URL, evalDatabaseUrl, evalDatabaseHint } from "../../src/eval/db.js";

describe("eval database guard", () => {
  it("defaults to a *_eval database", () => {
    expect(new URL(EVAL_DATABASE_URL).pathname).toMatch(/_eval$/);
  });
  it("keeps the copy of the real base in its own *_eval database, apart from the fixtures", () => {
    expect(new URL(EVAL_REAL_DATABASE_URL).pathname).toMatch(/_eval$/);
    expect(EVAL_REAL_DATABASE_URL).not.toBe(EVAL_DATABASE_URL);
    expect(evalDatabaseUrl("fixtures")).toBe(EVAL_DATABASE_URL);
    expect(evalDatabaseUrl("real")).toBe(EVAL_REAL_DATABASE_URL);
  });
  it("says how to create a missing eval database, and leaves other errors alone", () => {
    const missing = Object.assign(new Error('database "brain_real_eval" does not exist'), { code: "3D000" });
    expect((evalDatabaseHint(missing, "real") as Error).message).toBe(
      'database "brain_real_eval" does not exist; create it with npm run eval:prepare-real, then npm run brain -- eval sync',
    );
    expect((evalDatabaseHint(missing, "fixtures") as Error).message).toMatch(/npm run eval:prepare, then npm run brain -- eval ingest$/);
    const other = new Error("boom");
    expect(evalDatabaseHint(other, "real")).toBe(other);
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
