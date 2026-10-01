import { describe, it, expect, afterAll } from "vitest";
import { assertEvalConnection } from "../../src/eval/db.js";
import { testDb } from "./helpers.js";

describe("assertEvalConnection", () => {
  const sql = testDb();
  afterAll(() => sql.end());

  it("refuses a live connection whose current_database() does not end in _eval", async () => {
    await expect(assertEvalConnection(sql)).rejects.toThrow(/brain_test.*_eval/);
  });
});
