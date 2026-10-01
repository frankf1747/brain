import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { countRelevantPassages } from "../../src/eval/run.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

async function doc(origin: string, passages: string[]): Promise<string> {
  const [d] = await sql<{ id: string }[]>`
    insert into brain.documents (content_hash, origin, raw_content) values (${origin}, ${origin}, ${passages.join(" ")}) returning id`;
  const [parent] = await sql<{ id: string }[]>`
    insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end)
    values (${d.id}, 0, 0, ${passages.join(" ")}, 1, 0, 1) returning id`;
  for (let i = 0; i < passages.length; i++) {
    await sql`insert into brain.chunks (document_id, parent_id, level, ordinal, content, token_count, char_start, char_end)
      values (${d.id}, ${parent.id}, 1, ${i}, ${passages[i]}, 1, 0, 1)`;
  }
  return d.id;
}

describe("countRelevantPassages", () => {
  it("counts level-1 passages of the expected documents that contain a quote, whitespace-normalised", async () => {
    await doc("/corpus/note--a.md", ["the quote is here", "the  quote\nis here again", "unrelated"]);
    await doc("/corpus/other.md", ["the quote is here too"]);
    await doc("/corpus/xnote--a.md", ["the quote is here"]);
    expect(await countRelevantPassages(sql, [{ origin: "note--a.md", quote: "the quote is" }])).toBe(2);
  });
  it("collapses ASCII whitespace but not NBSP, like the TS side", async () => {
    await doc("/corpus/c.md", ["the\tquote\r\nis here", "the\u00a0quote is here"]);
    expect(await countRelevantPassages(sql, [{ origin: "c.md", quote: "the quote is" }])).toBe(1);
  });
  it("matches by document id and returns 0 without quotes", async () => {
    const id = await doc("/corpus/b.md", ["alpha beta", "beta gamma"]);
    expect(await countRelevantPassages(sql, [{ document_id: id, quote: "beta" }])).toBe(2);
    expect(await countRelevantPassages(sql, [{ document_id: id }])).toBe(0);
  });
});
