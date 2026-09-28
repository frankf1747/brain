import { describe, it, expect, afterAll } from "vitest";
import { testDb } from "./helpers.js";
import { toVector } from "../../src/db.js";

const sql = testDb();
afterAll(() => sql.end());

describe("db", () => {
  it("round-trips a vector literal", async () => {
    const [row] = await sql<{ dims: number }[]>`select vector_dims(${toVector([0.1, 0.2, 0.3])}::vector) as dims`;
    expect(row.dims).toBe(3);
  });
  it("formats vectors without spaces", () => {
    expect(toVector([1, 2.5])).toBe("[1,2.5]");
  });
});
