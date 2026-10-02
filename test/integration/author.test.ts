import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { storeDocument } from "../../src/ingest/store.js";
import { defaultAuthor } from "../../src/ingest/author.js";
import { config } from "../../src/config.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const authorOf = async (id: string) => (await sql<{ author: string }[]>`select author from brain.documents where id = ${id}`)[0].author;

describe("documents.author", () => {
  it("defaults by source kind when the input names no author", async () => {
    const cases: [string, string][] = [
      ["resume", "owner"], ["note", "owner"], ["conversation", "owner"], ["paste", "owner"],
      ["news", "other"], ["paper", "other"], ["job_description", "other"], ["email", "other"],
      ["podcast", "unknown"],
    ];
    for (const [kind, expected] of cases) {
      const { id } = await storeDocument(sql, { text: `A ${kind} document.`, sourceKind: kind });
      expect([kind, await authorOf(id)]).toEqual([kind, expected]);
    }
  });

  it("treats a document stored without a kind as a paste written by the owner", async () => {
    const { id } = await storeDocument(sql, { text: "Pasted without a kind." });
    expect(await authorOf(id)).toBe("owner");
  });

  it("stores an explicit author instead of the default", async () => {
    const { id } = await storeDocument(sql, { text: "Someone else's post saved as a note.", sourceKind: "note", author: "other" });
    expect(await authorOf(id)).toBe("other");
  });

  it("keeps the author of an existing document when the same text is stored again", async () => {
    const a = await storeDocument(sql, { text: "same text", sourceKind: "note", author: "other" });
    const b = await storeDocument(sql, { text: "same text", sourceKind: "note" });
    expect(b.id).toBe(a.id);
    expect(await authorOf(a.id)).toBe("other");
  });

  it("refuses an author outside owner, other and unknown", async () => {
    await expect(storeDocument(sql, { text: "x", author: "someone" as never })).rejects.toThrow(/author must be one of owner, other, unknown/);
    await expect(sql`insert into brain.documents (content_hash, raw_content, author) values ('bad-author', 'x', 'someone')`).rejects.toThrow(/documents_author_check/);
  });

  it("has a SQL default_author that agrees with config.authorDefaults (the migration backfill uses it)", async () => {
    for (const kind of [...Object.keys(config.authorDefaults), "podcast", "", "Note"]) {
      const [row] = await sql<{ a: string }[]>`select brain.default_author(${kind}) as a`;
      expect([kind, row.a]).toEqual([kind, defaultAuthor(kind)]);
    }
  });

  it("backfills a row that predates the column by its source kind", async () => {
    // A row inserted without an author gets the column default, as every existing row did when 009 added the column.
    const [doc] = await sql<{ id: string }[]>`
      insert into brain.documents (content_hash, source_kind, raw_content) values ('pre-009', 'note', 'An old note.') returning id`;
    expect(await authorOf(doc.id)).toBe("unknown");
    await sql`update brain.documents set author = brain.default_author(source_kind) where id = ${doc.id}`;
    expect(await authorOf(doc.id)).toBe("owner");
  });
});

describe("fact_events", () => {
  it("exists with the columns supersession and undo write", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'brain' and table_name = 'fact_events' order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual(["id", "fact_id", "event", "by", "document_id", "detail", "created_at"]);
  });
});
