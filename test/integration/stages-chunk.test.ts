import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { storeDocument } from "../../src/ingest/store.js";
import { runChunk } from "../../src/ingest/stages/chunk.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const text = `# Intro\n\n${"Alpha beta gamma. ".repeat(40)}\n\n## More\n\n${"Delta epsilon. ".repeat(40)}`;

describe("runChunk", () => {
  it("writes sections and passages with parent links and exact offsets", async () => {
    const ctx = fakeCtx(sql);
    const { id } = await storeDocument(sql, { text, title: "T" });
    await runChunk(ctx, id);
    const rows = await sql<{ level: number; parent_id: string | null; content: string; char_start: number; char_end: number; heading_path: string[] }[]>`
      select level, parent_id, content, char_start, char_end, heading_path from brain.chunks where document_id = ${id} order by level, ordinal`;
    const sections = rows.filter((r) => r.level === 0);
    const passages = rows.filter((r) => r.level === 1);
    expect(sections.length).toBe(2);
    expect(passages.length).toBeGreaterThanOrEqual(2);
    for (const p of passages) expect(p.parent_id).not.toBeNull();
    for (const r of rows) expect(text.slice(r.char_start, r.char_end)).toBe(r.content);
    expect(sections[1].heading_path).toEqual(["Intro", "More"]);
  });

  it("is idempotent: re-running replaces rather than duplicates", async () => {
    const ctx = fakeCtx(sql);
    const { id } = await storeDocument(sql, { text });
    await runChunk(ctx, id);
    const before = await sql`select id from brain.chunks where document_id = ${id}`;
    await runChunk(ctx, id);
    const after = await sql`select id from brain.chunks where document_id = ${id}`;
    expect(after.length).toBe(before.length);
  });
});
