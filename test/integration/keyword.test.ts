import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const tsq = async (q: string) => (await sql<{ t: string | null }[]>`select brain.query_to_tsquery(${q})::text as t`)[0].t;

describe("query_to_tsquery", () => {
  it("ORs the stems of a natural-language question", async () => {
    expect(await tsq("What did Zorblax release in Texas this year?")).toBe("'zorblax' | 'releas' | 'texa' | 'year'");
  });
  it("keeps a quoted phrase as a phrase match and ORs it with the rest", async () => {
    expect(await tsq('"Zorblax Industries" drill')).toBe("'zorblax' <-> 'industri' | 'drill'");
  });
  it("returns null when only stopwords remain", async () => {
    expect(await tsq("what is the")).toBeNull();
    expect(await tsq('"the of" a')).toBeNull();
    expect(await tsq("")).toBeNull();
  });
  it("treats an unclosed quote as ordinary words", async () => {
    expect(await tsq('"unclosed drill')).toBe("'unclos' | 'drill'");
  });
  it("quotes lexemes so tsquery operators and apostrophes in the question are inert", async () => {
    expect(await tsq("a & b | c ! d : e ( f")).toBe("'b' | 'c' | 'd' | 'e' | 'f'");
    expect(await tsq("O'Neil's drill")).toBe("'o' | 'neil' | 'drill'");
  });
});

describe("weighted tsvector", () => {
  it("finds a passage by a word that appears only in the document title", async () => {
    const ctx = fakeCtx(sql, ({ system }) =>
      system === SUMMARY_SYSTEM
        ? { title: "Garden", summary_line: "Notes on tomatoes.", summary: "Tomato notes.", occurred_at: null }
        : { entities: [], relations: [], facts_about_self: [] },
    );
    await ingest(ctx, { text: "Tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
    const rows = await sql<{ chunk_id: string; keyword_rank: number | null }[]>`
      select chunk_id, keyword_rank from brain.hybrid_search('garden', null::vector, 60, null::text[], null, null)`;
    expect(rows.length).toBe(1);
    expect(rows[0].keyword_rank).toBe(1);
  });
  it("ranks a passage matching more of the question's terms above one matching fewer", async () => {
    const ctx = fakeCtx(sql);
    await ingest(ctx, { text: "Zorblax Industries released the ZX-9000 drill in Austin.", sourceKind: "news", title: "A" });
    await ingest(ctx, { text: "A drill is a tool.", sourceKind: "note", title: "B" });
    const rows = await sql<{ document_id: string; keyword_rank: number | null }[]>`
      select document_id, keyword_rank from brain.hybrid_search('What did Zorblax release in Austin?', null::vector, 60, null::text[], null, null) order by keyword_rank`;
    const [first] = await sql<{ id: string }[]>`select id from brain.documents where title = 'A'`;
    expect(rows[0].document_id).toBe(first.id);
    expect(rows.length).toBe(1); // "A drill is a tool" shares no stem with the question
  });
  it("summary_search finds a document by its title", async () => {
    const ctx = fakeCtx(sql, ({ system }) =>
      system === SUMMARY_SYSTEM
        ? { title: "Garden", summary_line: "Notes on tomatoes.", summary: "Tomato notes.", occurred_at: null }
        : { entities: [], relations: [], facts_about_self: [] },
    );
    await ingest(ctx, { text: "Tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
    const rows = await sql<{ keyword_rank: number | null }[]>`
      select keyword_rank from brain.summary_search('What about my garden?', null::vector, 60, null::text[], null, null)`;
    expect(rows.map((r) => r.keyword_rank)).toEqual([1]);
  });
});
