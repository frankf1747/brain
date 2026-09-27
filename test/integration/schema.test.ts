import { describe, it, expect, afterAll } from "vitest";
import { testDb } from "./helpers.js";

const sql = testDb();
afterAll(() => sql.end());

describe("core schema", () => {
  it("has the recall-layer tables", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'brain' order by table_name`;
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(["documents", "chunks", "ingest_jobs"]));
  });

  it("stores 1024-dimension embeddings on chunks", async () => {
    const [row] = await sql<{ atttypmod: number }[]>`
      select atttypmod from pg_attribute
      where attrelid = 'brain.chunks'::regclass and attname = 'embedding'`;
    expect(row.atttypmod).toBe(1024);
  });

  it("rejects a chunk level outside 0..1", async () => {
    await expect(sql`
      insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end)
      values (gen_random_uuid(), 2, 0, 'x', 1, 0, 1)`).rejects.toThrow();
  });
});
