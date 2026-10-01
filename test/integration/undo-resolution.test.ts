import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { runChunk } from "../../src/ingest/stages/chunk.js";
import { runResolve, undoResolution } from "../../src/ingest/stages/resolve.js";
import { runExtract } from "../../src/ingest/stages/extract.js";
import { addFact, verifyFact, supersedeFact } from "../../src/graph/facts.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: null } : fakeExtraction;
const text = "I applied to Acme Corp in September. I am on F-1 OPT so sponsorship matters.";

async function counts(documentId: string) {
  const [r] = await sql<{ facts: number; edges: number; mentions: number; nodes: number }[]>`
    select (select count(*)::int from brain.facts) as facts,
           (select count(*)::int from brain.edges) as edges,
           (select count(*)::int from brain.mentions m join brain.chunks c on c.id = m.chunk_id where c.document_id = ${documentId}) as mentions,
           (select count(*)::int from brain.nodes) as nodes`;
  return r;
}

async function extractedFactId(): Promise<string> {
  return (await sql<{ id: string }[]>`select id from brain.facts where source_chunk_id is not null`)[0].id;
}

describe("undoResolution", () => {
  it("deletes the facts, edges and mentions a document produced and keeps the nodes", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    expect(await counts(id)).toEqual({ facts: 1, edges: 1, mentions: 2, nodes: 2 });
    const report = await undoResolution(sql, id);
    expect(report.facts).toEqual([expect.objectContaining({ predicate: "visa_status", objectText: "F-1 OPT" })]);
    expect(report.edges).toEqual([expect.objectContaining({ type: "applied_to", fromName: "Frank Fu", toName: "Acme Corp" })]);
    expect(report.mentions).toBe(2);
    expect(report.keptVerified).toEqual([]);
    expect(await counts(id)).toEqual({ facts: 0, edges: 0, mentions: 0, nodes: 2 });
    const events = await sql<{ event: string; document_id: string }[]>`select event, document_id from brain.fact_events`;
    expect(events).toEqual([{ event: "removed", document_id: id }]);
  });

  it("re-resolving after the author changes to other leaves nothing about the owner, and the nodes stay", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    await sql`update brain.documents set author = 'other' where id = ${id}`;
    const report = await runResolve(ctx, id);
    expect(report.undone.facts).toHaveLength(1);
    expect(report.suppressedSelfItems).toBe(2);
    expect(await counts(id)).toEqual({ facts: 0, edges: 0, mentions: 2, nodes: 2 });
  });

  it("re-running resolve on an unchanged document gives the same rows", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    await runResolve(ctx, id);
    await runResolve(ctx, id);
    expect(await counts(id)).toEqual({ facts: 1, edges: 1, mentions: 2, nodes: 2 });
  });

  it("keeps a fact the owner verified", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    const factId = await extractedFactId();
    expect(await verifyFact(sql, factId, "frank")).toBe(true);
    const report = await undoResolution(sql, id);
    expect(report.facts).toEqual([]);
    expect(report.keptVerified).toEqual([{ id: factId, predicate: "visa_status", objectText: "F-1 OPT" }]);
    expect((await counts(id)).facts).toBe(1);
  });

  it("makes a fact current again when the fact that superseded it is removed", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    const extracted = await extractedFactId();
    // What extractor supersession (Task 7) writes: an older fact points at the document's newer one.
    const { id: older } = await addFact(sql, { predicate: "visa_status", objectText: "J-1", by: "frank" });
    await sql`update brain.facts set superseded_by = ${extracted}, valid_to = current_date where id = ${older}`;
    const report = await undoResolution(sql, id);
    expect(report.restored).toEqual([older]);
    const [row] = await sql<{ superseded_by: string | null; valid_to: string | null }[]>`
      select superseded_by, valid_to::text as valid_to from brain.facts where id = ${older}`;
    expect(row).toEqual({ superseded_by: null, valid_to: null });
    const events = await sql<{ event: string; fact_id: string }[]>`select event, fact_id from brain.fact_events order by id`;
    expect(events).toEqual([{ event: "restored", fact_id: older }, { event: "removed", fact_id: extracted }]);
  });

  it("re-points a referrer past the removed fact to the next surviving one in its chain", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    const extracted = await extractedFactId();
    const { id: older } = await addFact(sql, { predicate: "visa_status", objectText: "J-1", by: "frank" });
    // The surviving end of the chain is another document's extracted fact. (Had the owner written it, the
    // removed fact would be kept as the record of a correction; see "keeps an extracted fact the owner corrected".)
    const { id: other } = await ingest(ctx, { text: text2, sourceKind: "note" });
    const newest = await factOf(other);
    await sql`update brain.facts set superseded_by = ${extracted} where id = ${older}`;
    await sql`update brain.facts set superseded_by = ${newest} where id = ${extracted}`;
    const report = await undoResolution(sql, id);
    expect(report.restored).toEqual([]);
    const [row] = await sql<{ superseded_by: string | null }[]>`select superseded_by from brain.facts where id = ${older}`;
    expect(row.superseded_by).toBe(newest);
  });

  it("re-chunking a resolved document removes what it produced instead of orphaning it", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    await runChunk(ctx, id);
    const [r] = await sql<{ facts: number; edges: number }[]>`
      select (select count(*)::int from brain.facts) as facts, (select count(*)::int from brain.edges) as edges`;
    expect(r).toEqual({ facts: 0, edges: 0 });
  });
});

const text2 = "Second note. I applied to Acme Corp again. I am on F-1 OPT still.";

/** The fact the document's resolution produced. */
async function factOf(documentId: string): Promise<string> {
  return (
    await sql<{ id: string }[]>`
      select f.id from brain.facts f join brain.chunks c on c.id = f.source_chunk_id where c.document_id = ${documentId}`
  )[0].id;
}

/** Copies a document's extracted fact under a new value, as a second fact from the same chunk. */
async function siblingFact(documentId: string, objectText: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into brain.facts (subject_id, predicate, object_text, confidence, source_chunk_id, verified_by)
    select subject_id, predicate, ${objectText}, confidence, source_chunk_id, verified_by from brain.facts where id = ${await factOf(documentId)}
    returning id`;
  return row.id;
}

async function currentValues(predicate: string): Promise<string[]> {
  return (
    await sql<{ object_text: string }[]>`
      select object_text from brain.facts where predicate = ${predicate} and superseded_by is null order by object_text`
  ).map((r) => r.object_text);
}

describe("undoResolution with supersession chains", () => {
  it("logs a re-point so a later undo restores the original valid_to", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id: a } = await ingest(ctx, { text, sourceKind: "note" });
    const { id: b } = await ingest(ctx, { text: text2, sourceKind: "note" });
    const f2 = await factOf(a);
    const f3 = await factOf(b);
    const { id: f1 } = await addFact(sql, { predicate: "visa_status", objectText: "J-1", by: "frank" });
    await sql`update brain.facts set superseded_by = ${f2}, valid_to = current_date where id = ${f1}`;
    await sql`
      insert into brain.fact_events (fact_id, event, by, detail)
      values (${f1}, 'superseded', 'test', ${sql.json({ superseded_by: f2, previous_valid_to: "2027-01-31" })})`;
    await sql`update brain.facts set superseded_by = ${f3} where id = ${f2}`;

    await undoResolution(sql, a);
    const [afterA] = await sql<{ superseded_by: string | null }[]>`select superseded_by from brain.facts where id = ${f1}`;
    expect(afterA.superseded_by).toBe(f3);
    const [repoint] = await sql<{ by: string; document_id: string; detail: unknown }[]>`
      select by, document_id, detail from brain.fact_events where fact_id = ${f1} and event = 'superseded' order by id desc limit 1`;
    expect(repoint).toEqual({ by: "resolve", document_id: a, detail: { superseded_by: f3, previous_valid_to: "2027-01-31" } });

    const report = await undoResolution(sql, b);
    expect(report.restored).toEqual([f1]);
    const [afterB] = await sql<{ superseded_by: string | null; valid_to: string | null }[]>`
      select superseded_by, valid_to::text as valid_to from brain.facts where id = ${f1}`;
    expect(afterB).toEqual({ superseded_by: null, valid_to: "2027-01-31" });
  });

  it("keeps an extracted fact the owner corrected, and re-resolving leaves the correction the only current value", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    const extracted = await factOf(id);
    const corrected = await supersedeFact(sql, extracted, { objectText: "H-1B", by: "frank" });
    const report = await runResolve(ctx, id);
    expect(report.undone.facts).toEqual([]);
    expect(report.undone.keptCorrected).toEqual([{ id: extracted, predicate: "visa_status", objectText: "F-1 OPT" }]);
    expect(await currentValues("visa_status")).toEqual(["H-1B"]);
    const [row] = await sql<{ superseded_by: string | null }[]>`select superseded_by from brain.facts where id = ${extracted}`;
    expect(row.superseded_by).toBe(corrected);
  });

  it("does not insert a second current copy of a verified fact after re-chunking", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    expect(await verifyFact(sql, await factOf(id), "frank")).toBe(true);
    await runChunk(ctx, id);
    await runExtract(ctx, id);
    await runResolve(ctx, id);
    expect(await currentValues("visa_status")).toEqual(["F-1 OPT"]);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from brain.facts where object_text = 'F-1 OPT'`;
    expect(n.n).toBe(1);
  });

  it("deletes a cycle among doomed facts and restores a fact that pointed into it", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    const d1 = await factOf(id);
    const d2 = await siblingFact(id, "H-1B");
    await sql`update brain.facts set superseded_by = ${d2} where id = ${d1}`;
    await sql`update brain.facts set superseded_by = ${d1} where id = ${d2}`;
    const { id: outside } = await addFact(sql, { predicate: "visa_status", objectText: "J-1", by: "frank" });
    await sql`update brain.facts set superseded_by = ${d1}, valid_to = current_date where id = ${outside}`;
    const report = await undoResolution(sql, id);
    expect(report.facts.map((f) => f.id).sort()).toEqual([d1, d2].sort());
    expect(report.restored).toEqual([outside]);
    expect(await currentValues("visa_status")).toEqual(["J-1"]);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from brain.facts`;
    expect(n.n).toBe(1);
  });

  it("re-points a referrer across a chain of two doomed facts to the surviving fact at its end", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id: a } = await ingest(ctx, { text, sourceKind: "note" });
    const { id: b } = await ingest(ctx, { text: text2, sourceKind: "note" });
    const d1 = await factOf(a);
    const d2 = await siblingFact(a, "H-1B");
    const survivor = await factOf(b);
    const { id: outside } = await addFact(sql, { predicate: "visa_status", objectText: "J-1", by: "frank" });
    await sql`update brain.facts set superseded_by = ${d1} where id = ${outside}`;
    await sql`update brain.facts set superseded_by = ${d2} where id = ${d1}`;
    await sql`update brain.facts set superseded_by = ${survivor} where id = ${d2}`;
    const report = await undoResolution(sql, a);
    expect(report.facts.map((f) => f.id).sort()).toEqual([d1, d2].sort());
    expect(report.restored).toEqual([]);
    const [row] = await sql<{ superseded_by: string | null }[]>`select superseded_by from brain.facts where id = ${outside}`;
    expect(row.superseded_by).toBe(survivor);
  });

  it("makes a kept verified fact current again when the same document's fact that superseded it is removed", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    const verified = await factOf(id);
    const doomed = await siblingFact(id, "H-1B");
    expect(await verifyFact(sql, verified, "frank")).toBe(true);
    await sql`update brain.facts set superseded_by = ${doomed}, valid_to = current_date where id = ${verified}`;
    const report = await undoResolution(sql, id);
    expect(report.keptVerified.map((f) => f.id)).toEqual([verified]);
    expect(report.facts.map((f) => f.id)).toEqual([doomed]);
    expect(report.restored).toEqual([verified]);
    expect(await currentValues("visa_status")).toEqual(["F-1 OPT"]);
  });

  it("undoing one of two documents with the same edge leaves the other's edge", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id: a } = await ingest(ctx, { text, sourceKind: "note" });
    const { id: b } = await ingest(ctx, { text: text2, sourceKind: "note" });
    const edgesOf = (doc: string) => sql<{ id: string }[]>`
      select e.id from brain.edges e join brain.chunks c on c.id = e.evidence_chunk_id where c.document_id = ${doc}`;
    expect(await edgesOf(a)).toHaveLength(1);
    const kept = await edgesOf(b);
    expect(kept).toHaveLength(1);
    const report = await undoResolution(sql, a);
    expect(report.edges).toHaveLength(1);
    expect(await edgesOf(a)).toHaveLength(0);
    expect(await edgesOf(b)).toEqual(kept);
  });
});
