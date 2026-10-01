import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { runChunk } from "../../src/ingest/stages/chunk.js";
import { runResolve, undoResolution } from "../../src/ingest/stages/resolve.js";
import { addFact, verifyFact } from "../../src/graph/facts.js";

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
    const { id: newest } = await addFact(sql, { predicate: "visa_status", objectText: "H-1B", by: "frank" });
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
