import { describe, it, expect } from "vitest";
import { assertTestDatabase, TEST_DATABASE_URL } from "../integration/helpers.js";

describe("integration test database guard", () => {
  it("defaults to a *_test database", () => {
    expect(new URL(TEST_DATABASE_URL).pathname).toMatch(/_test$/);
  });
  it("refuses the real database", () => {
    expect(() => assertTestDatabase("postgresql://postgres:postgres@127.0.0.1:55322/postgres")).toThrow(/must end in _test/);
    expect(() => assertTestDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_test")).not.toThrow();
  });
});
