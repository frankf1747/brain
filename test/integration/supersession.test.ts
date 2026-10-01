import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { runResolve } from "../../src/ingest/stages/resolve.js";
import { setAuthor } from "../../src/ingest/set-author.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

function fact(predicate: string, object_text: string, quote: string) {
  return { predicate, object_text, object_key: null, confidence: 0.9, valid_from: null, valid_to: null, quote };
}
/** One fact per note, chosen by the note's text. */
const factsByText: Record<string, ReturnType<typeof fact>> = {
  "I live in Austin.": fact("lives_in", "Austin", "I live in Austin"),
  "I moved to Denver.": fact("lives_in", "Denver", "I moved to Denver"),
  "I know Python.": fact("skill", "Python", "I know Python"),
  "I know SQL.": fact("skill", "SQL", "I know SQL"),
};
const ctx = fakeCtx(sql, ({ system, user }) => {
  if (system === SUMMARY_SYSTEM) return { title: "Note", summary_line: "A note.", summary: "A note.", occurred_at: null };
  const key = Object.keys(factsByText).find((k) => user.includes(k));
  return { entities: [], relations: [], facts_about_self: key ? [factsByText[key]] : [] };
});

async function ownerNote(text: string, occurredAt: string): Promise<string> {
  return (await ingest(ctx, { text, sourceKind: "note", occurredAt: new Date(occurredAt) })).id;
}

async function factsFor(predicate: string) {
  return sql<{ id: string; object_text: string; superseded_by: string | null; valid_to: string | null }[]>`
    select id, object_text, superseded_by, valid_to::text as valid_to from brain.facts where predicate = ${predicate} order by created_at, id`;
}
const current = (rows: { object_text: string; superseded_by: string | null }[]) =>
  rows.filter((r) => r.superseded_by === null).map((r) => r.object_text).sort();
const events = () =>
  sql<{ fact_id: string; event: string; by: string; document_id: string | null; superseded_by: string | null }[]>`
    select fact_id, event, by, document_id, detail->>'superseded_by' as superseded_by from brain.fact_events order by id`;

describe("supersession by the extractor", () => {
  it("a newer owner note supersedes a single-valued fact and logs it", async () => {
    await ownerNote("I live in Austin.", "2026-06-01T12:00:00Z");
    const denverDoc = await ownerNote("I moved to Denver.", "2026-09-26T12:00:00Z");
    const rows = await factsFor("lives_in");
    expect(current(rows)).toEqual(["Denver"]);
    const austin = rows.find((r) => r.object_text === "Austin")!;
    const denver = rows.find((r) => r.object_text === "Denver")!;
    expect(austin.superseded_by).toBe(denver.id);
    expect(austin.valid_to).toBe("2026-09-26");
    expect(await events()).toEqual([{ fact_id: austin.id, event: "superseded", by: "extractor:fake", document_id: denverDoc, superseded_by: denver.id }]);
  });

  it("multi-valued predicates always add", async () => {
    await ownerNote("I know Python.", "2026-06-01T12:00:00Z");
    await ownerNote("I know SQL.", "2026-09-26T12:00:00Z");
    expect(current(await factsFor("skill"))).toEqual(["Python", "SQL"]);
    expect(await events()).toEqual([]);
  });

  it("an older note resolved later does not replace the newer value", async () => {
    await ownerNote("I moved to Denver.", "2026-09-26T12:00:00Z");
    await ownerNote("I live in Austin.", "2026-06-01T12:00:00Z");
    const rows = await factsFor("lives_in");
    expect(current(rows)).toEqual(["Denver"]);
    const austin = rows.find((r) => r.object_text === "Austin")!;
    const denver = rows.find((r) => r.object_text === "Denver")!;
    expect(austin.superseded_by).toBe(denver.id);
    expect((await events()).map((e) => [e.event, e.fact_id])).toEqual([["superseded", austin.id]]);
  });

  it("repeating the current value supersedes nothing", async () => {
    await ownerNote("I moved to Denver.", "2026-09-26T12:00:00Z");
    await ownerNote("I moved to Denver. Still here.", "2026-09-30T12:00:00Z");
    expect(current(await factsFor("lives_in"))).toEqual(["Denver", "Denver"]);
    expect(await events()).toEqual([]);
  });

  it("undoing the newer note makes the older value current again, as it was", async () => {
    await ownerNote("I live in Austin.", "2026-06-01T12:00:00Z");
    const denverDoc = await ownerNote("I moved to Denver.", "2026-09-26T12:00:00Z");
    const before = await factsFor("lives_in");
    const austin = before.find((r) => r.object_text === "Austin")!;
    const denver = before.find((r) => r.object_text === "Denver")!;
    const r = await setAuthor(ctx, denverDoc, "other");
    expect(r.restoredFacts).toEqual([austin.id]);
    expect(await factsFor("lives_in")).toEqual([{ id: austin.id, object_text: "Austin", superseded_by: null, valid_to: null }]);
    expect((await events()).map((e) => [e.event, e.fact_id])).toEqual([
      ["superseded", austin.id],
      ["restored", austin.id],
      ["removed", denver.id],
    ]);
  });

  it("re-resolving either note, in any order, keeps exactly one current value", async () => {
    const austinDoc = await ownerNote("I live in Austin.", "2026-06-01T12:00:00Z");
    const denverDoc = await ownerNote("I moved to Denver.", "2026-09-26T12:00:00Z");
    for (const doc of [austinDoc, denverDoc, austinDoc, denverDoc, denverDoc, austinDoc]) {
      await runResolve(ctx, doc);
      const rows = await factsFor("lives_in");
      expect(current(rows)).toEqual(["Denver"]);
      expect(rows.map((r) => r.object_text).sort()).toEqual(["Austin", "Denver"]);
      const austin = rows.find((r) => r.object_text === "Austin")!;
      expect(austin.superseded_by).toBe(rows.find((r) => r.object_text === "Denver")!.id);
    }
  });
});
