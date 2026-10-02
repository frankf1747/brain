import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest, runPipeline } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { setAuthor, suppressedDocuments } from "../../src/ingest/set-author.js";
import { supersedeFact } from "../../src/graph/facts.js";
import type { ObsidianAutoProjector } from "../../src/obsidian/auto.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

// Shaped like the saved Databricks post: a stranger's first-person opinions, stored as an owner note.
const body = "I thought Databricks would save us money. I have run data platforms for eight years. Put cluster policies in place first. Cost governance is not optional.";
const post = {
  entities: [
    { key: "me", type: "person", name: "Frank Fu", aliases: [], untyped_hint: null, quote: "I" },
    { key: "db", type: "organization", name: "Databricks", aliases: [], untyped_hint: null, quote: "Databricks" },
    { key: "cg", type: "concept", name: "Databricks cost governance", aliases: [], untyped_hint: null, quote: "Cost governance is not optional" },
  ],
  relations: [{ from_key: "me", to_key: "cg", type: "related_to", confidence: 0.8, valid_from: null, valid_to: null, quote: "Cost governance is not optional" }],
  facts_about_self: [
    { predicate: "view_on", object_text: "Databricks cost governance is not optional", object_key: "cg", confidence: 0.8, valid_from: null, valid_to: null, quote: "Cost governance is not optional" },
    { predicate: "recommends", object_text: "cluster policies before the first workload", object_key: null, confidence: 0.8, valid_from: null, valid_to: null, quote: "Put cluster policies in place first" },
    { predicate: "has_experience_with", object_text: "Databricks cost governance", object_key: "cg", confidence: 0.8, valid_from: null, valid_to: null, quote: "I have run data platforms for eight years" },
  ],
};
const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Databricks costs", summary_line: "A post about Databricks costs.", summary: "S", occurred_at: null } : post;

const selfFacts = async () =>
  (await sql<{ predicate: string }[]>`
    select f.predicate from brain.facts f join brain.nodes n on n.id = f.subject_id where n.is_self order by f.predicate`).map((r) => r.predicate);
const selfEdges = async () =>
  (await sql<{ toName: string }[]>`
    select t.name as "toName" from brain.edges e join brain.nodes n on n.id = e.from_node join brain.nodes t on t.id = e.to_node
    where n.is_self`).map((r) => r.toName);

describe("setAuthor", () => {
  it("removes the facts and edges a document produced when it turns out someone else wrote it", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note", title: "Databricks costs" });
    expect(await selfFacts()).toEqual(["has_experience_with", "recommends", "view_on"]);
    expect(await selfEdges()).toEqual(["Databricks cost governance"]);
    let notified = 0;
    ctx.obsidian = { notify: () => void notified++ } as unknown as ObsidianAutoProjector;

    const r = await setAuthor(ctx, id, "other");

    expect(r).toMatchObject({ documentId: id, previous: "owner", author: "other", reresolved: true, suppressedSelfItems: 4 });
    expect(r.removedFacts.map((f) => f.predicate).sort()).toEqual(["has_experience_with", "recommends", "view_on"]);
    expect(r.removedEdges).toEqual([{ type: "related_to", fromName: "Frank Fu", toName: "Databricks cost governance" }]);
    expect(r.addedFacts).toEqual([]);
    expect(r.addedEdges).toEqual([]);
    expect(await selfFacts()).toEqual([]);
    expect(await selfEdges()).toEqual([]);
    const nodes = await sql<{ name: string }[]>`select name from brain.nodes where not is_self order by name`;
    expect(nodes.map((n) => n.name)).toEqual(["Databricks", "Databricks cost governance"]);
    const [doc] = await sql<{ author: string; n: number }[]>`
      select author, (metadata->>'suppressed_self_items')::int as n from brain.documents where id = ${id}`;
    expect(doc).toEqual({ author: "other", n: 4 });
    expect(notified).toBe(1);
  });

  it("re-applies the facts when the author is set back to owner", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note" });
    await setAuthor(ctx, id, "other");
    const r = await setAuthor(ctx, id, "owner");
    expect(r).toMatchObject({ previous: "other", author: "owner", reresolved: true, suppressedSelfItems: 0, removedFacts: [], removedEdges: [] });
    expect(r.addedFacts.map((f) => f.predicate).sort()).toEqual(["has_experience_with", "recommends", "view_on"]);
    expect(r.addedEdges).toEqual([{ type: "related_to", fromName: "Frank Fu", toName: "Databricks cost governance" }]);
    expect(await selfFacts()).toEqual(["has_experience_with", "recommends", "view_on"]);
    const [doc] = await sql<{ n: string | null }[]>`select metadata->>'suppressed_self_items' as n from brain.documents where id = ${id}`;
    expect(doc.n).toBeNull();
  });

  it("only records the author for a document that has not been resolved yet; the pipeline applies it later", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note" }, { until: "chunked" });
    const r = await setAuthor(ctx, id, "other");
    expect(r).toMatchObject({ previous: "owner", author: "other", reresolved: false });
    const [job] = await sql<{ stage: string }[]>`select stage from brain.ingest_jobs where document_id = ${id}`;
    expect(job.stage).toBe("chunked");
    await runPipeline(ctx, id);
    expect(await selfFacts()).toEqual([]);
    expect(await selfEdges()).toEqual([]);
    const [doc] = await sql<{ n: number }[]>`select (metadata->>'suppressed_self_items')::int as n from brain.documents where id = ${id}`;
    expect(doc.n).toBe(4);
  });

  it("does nothing when the document already has that author", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note" });
    const [before] = await sql<{ n: string }[]>`select count(*)::text as n from brain.fact_events`;
    let notified = 0;
    ctx.obsidian = { notify: () => void notified++ } as unknown as ObsidianAutoProjector;
    const r = await setAuthor(ctx, id, "owner");
    expect(r).toMatchObject({ documentId: id, previous: "owner", author: "owner", unchanged: true, reresolved: false, removedFacts: [], addedFacts: [] });
    expect(await selfFacts()).toEqual(["has_experience_with", "recommends", "view_on"]);
    const [after] = await sql<{ n: string }[]>`select count(*)::text as n from brain.fact_events`;
    expect(after.n).toBe(before.n); // no undo ran
    expect(notified).toBe(0);
  });

  it("leaves the job at extracted with the error when re-resolving fails, so a retry finishes it", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note", author: "other" });
    expect(await selfFacts()).toEqual([]);
    const working = ctx.embedder;
    ctx.embedder = { embed: async () => { throw new Error("embedder down"); } } as unknown as typeof ctx.embedder;

    await expect(setAuthor(ctx, id, "owner")).rejects.toThrow(
      "author changed to owner but re-resolving failed: embedder down; run `brain retry` to finish",
    );
    const [job] = await sql<{ stage: string; error: string | null; attempts: number }[]>`
      select stage, error, attempts from brain.ingest_jobs where document_id = ${id}`;
    expect(job).toMatchObject({ stage: "extracted", error: "embedder down", attempts: 1 });
    const [doc] = await sql<{ author: string }[]>`select author from brain.documents where id = ${id}`;
    expect(doc.author).toBe("owner");

    ctx.embedder = working;
    expect(await runPipeline(ctx, id)).toMatchObject({ stage: "done", error: null });
    expect(await selfFacts()).toEqual(["has_experience_with", "recommends", "view_on"]);
    expect(await selfEdges()).toEqual(["Databricks cost governance"]);
    const [done] = await sql<{ error: string | null }[]>`select error from brain.ingest_jobs where document_id = ${id}`;
    expect(done.error).toBeNull();
  });

  it("lists the facts it kept because the owner corrected them, and does not report them as added", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note" });
    const [viewOn] = await sql<{ id: string }[]>`select id from brain.facts where predicate = 'view_on'`;
    await supersedeFact(sql, viewOn.id, { objectText: "cost governance matters", by: "frank" });
    const r = await setAuthor(ctx, id, "other");
    expect(r.keptCorrected).toEqual([{ id: viewOn.id, predicate: "view_on", objectText: "Databricks cost governance is not optional" }]);
    expect(r.removedFacts.map((f) => f.predicate).sort()).toEqual(["has_experience_with", "recommends"]);
    expect(r.addedFacts).toEqual([]);
    const back = await setAuthor(ctx, id, "owner");
    expect(back.keptCorrected).toEqual(r.keptCorrected);
    expect(back.addedFacts.map((f) => f.predicate).sort()).toEqual(["has_experience_with", "recommends"]);
  });

  it("refuses an unknown document and one another runner holds", async () => {
    const ctx = fakeCtx(sql, handler);
    await expect(setAuthor(ctx, "00000000-0000-0000-0000-000000000000", "other")).rejects.toThrow(/not found/);
    await expect(setAuthor(ctx, "nope", "other")).rejects.toThrow(/not found/);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note" });
    const reserved = await sql.reserve();
    await reserved`select pg_advisory_lock(hashtextextended(${id}::text, 0))`;
    try {
      await expect(setAuthor(ctx, id, "other")).rejects.toThrow(`document ${id} is being processed; try again in a moment`);
      const [doc] = await sql<{ author: string }[]>`select author from brain.documents where id = ${id}`;
      expect(doc.author).toBe("owner");
    } finally {
      await reserved`select pg_advisory_unlock(hashtextextended(${id}::text, 0))`;
      reserved.release();
    }
    // Once the other runner lets go, the change goes through.
    expect(await setAuthor(ctx, id, "other")).toMatchObject({ author: "other", reresolved: true });
  });

  it("refuses an author outside owner, other and unknown", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note" });
    await expect(setAuthor(ctx, id, "someone" as never)).rejects.toThrow(/author must be one of/);
  });
});

describe("suppressedDocuments", () => {
  it("lists documents whose items about the owner were suppressed, largest count first", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note", author: "other" });
    await ingest(ctx, { text: "An owner note about Databricks.", sourceKind: "note" });
    expect(await suppressedDocuments(sql)).toEqual([expect.objectContaining({ documentId: id, author: "other", count: 4 })]);
  });
});
