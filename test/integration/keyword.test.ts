import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { canonicalName } from "../../src/text/normalize.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

/** One document with one level-1 passage, written directly so the tsvector holds exactly this text. */
async function passage(title: string, content: string, headingPath: string[] = []): Promise<string> {
  const [d] = await sql<{ id: string }[]>`
    insert into brain.documents (content_hash, source_kind, title, raw_content)
    values (${"h-" + title}, 'note', ${title}, ${content}) returning id`;
  const [c] = await sql<{ id: string }[]>`
    insert into brain.chunks (document_id, level, ordinal, content, heading_path, token_count, char_start, char_end)
    values (${d.id}, 1, 0, ${content}, ${headingPath}, 5, 0, ${content.length}) returning id`;
  return c.id;
}

const units = async (q: string) =>
  (await sql<{ u: string[] }[]>`select array(select x::text from unnest(brain.query_units(${q})) x) as u`)[0].u;

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
    expect(await tsq("alpha & beta | gamma ! delta : eps ( zeta")).toBe("'alpha' | 'beta' | 'gamma' | 'delta' | 'ep' | 'zeta'");
    expect(await tsq("O'Neil's drill")).toBe("'neil' | 'drill'");
  });
  it("skips an empty quoted string without losing a later phrase", async () => {
    expect(await tsq('"" drill "zorblax industries"')).toBe("'zorblax' <-> 'industri' | 'drill'");
  });
  it("drops unquoted one-character lexemes but keeps longer ones and quoted phrases", async () => {
    expect(await tsq("X-90 drill")).toBe("'-90' | 'drill'");
    expect(await tsq("a b c")).toBeNull();
    expect(await tsq('"X-90" drill')).toBe("'x' <-> '-90' | 'drill'");
  });
});

describe("query_units", () => {
  it("returns one unit per phrase and per distinct stem, phrases first", async () => {
    expect(await units('"Zorblax Industries" drill drills Drill')).toEqual(["'zorblax' <-> 'industri'", "'drill'"]);
  });
  it("deduplicates a quoted single word against the same unquoted word", async () => {
    expect(await units('"drill" drill')).toEqual(["'drill'"]);
  });
  it("returns an empty array when nothing is left", async () => {
    expect(await units("what is the")).toEqual([]);
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
  it("ranks coverage of distinct question terms above repetition of one term", async () => {
    const p1 = await passage("One", "Zorblax released the drill in Austin");
    const p2 = await passage("Two", "Drill drill drill drill drill drill");
    const p3 = await passage("Three", "A drill.");
    const rows = await sql<{ chunk_id: string; keyword_rank: number }[]>`
      select chunk_id, keyword_rank from brain.hybrid_search('What did Zorblax release in Austin with a drill?', null::vector, 60, null::text[], null, null)`;
    const rank = new Map(rows.map((r) => [r.chunk_id, r.keyword_rank]));
    expect(rank.get(p1)).toBe(1);
    expect(rank.get(p2)).toBeLessThan(rank.get(p3)!);
  });
  it("finds a passage by a word that appears only in its heading path", async () => {
    const id = await passage("Garden", "Tomatoes need full sun.", ["Irrigation schedule"]);
    await passage("Other", "Tomatoes are red.");
    const rows = await sql<{ chunk_id: string }[]>`
      select chunk_id from brain.hybrid_search('irrigation', null::vector, 60, null::text[], null, null)`;
    expect(rows.map((r) => r.chunk_id)).toEqual([id]);
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

describe("canonical_text", () => {
  it("matches canonicalName", async () => {
    const [r] = await sql<{ t: string }[]>`select brain.canonical_text(${"  Acme’s  Corp., Inc! "}) as t`;
    expect(r.t).toBe("acmes corp inc");
  });
  it("agrees with canonicalName on tricky strings", async () => {
    // Known divergence, deliberately not asserted: JS \p{N} keeps "other numbers" (x², ½, ①) that
    // Postgres [[:alnum:]] treats as punctuation. Only aliases containing such characters are affected.
    const samples = [
      "O'Brien's", "Acme’s  Corp., Inc!", "café", "CAFÉ au lait", "東京 Tower", "東京タワー", "ZX-9000", "$115k", "rerank-2.5",
      "a...b///c", "  --  ", "naïve résumé", "Straße", "İstanbul", "ǅ", "٣٤٥", "e\u0301cole", "under_score", "tab\tsep\nnl", "emoji 🙂 ok", "ÀÉÎ", "ß", "ﬁsh",
    ];
    const diffs: string[] = [];
    for (const s of samples) {
      const [r] = await sql<{ t: string }[]>`select brain.canonical_text(${s}) as t`;
      if (r.t !== canonicalName(s)) diffs.push(`${JSON.stringify(s)}: sql=${JSON.stringify(r.t)} js=${JSON.stringify(canonicalName(s))}`);
    }
    expect(diffs).toEqual([]);
  });
});
