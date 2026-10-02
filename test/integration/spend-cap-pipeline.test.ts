import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx, meteredVoyage } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import type { Ctx } from "../../src/ctx.js";
import { ingest, retryFailed, runPipeline, DEFERRED_MESSAGE } from "../../src/ingest/pipeline.js";
import { ingestAll } from "../../src/ingest/batch.js";
import { setAuthor } from "../../src/ingest/set-author.js";
import { storeDocument } from "../../src/ingest/store.js";
import type { ReadResult } from "../../src/ingest/readers.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { runResolve } from "../../src/ingest/stages/resolve.js";
import { JobManager, BACKGROUND_SLOTS } from "../../src/mcp/jobs.js";
import { tokensToday } from "../../src/llm/ledger.js";
import { SpendCapError } from "../../src/llm/errors.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM
    ? { title: "Acme note", summary_line: "Applying to Acme.", summary: "The owner applied to Acme Corp.", occurred_at: null }
    : fakeExtraction;

/** A fake LLM with a real VoyageClient on the fake endpoint, metered in brain_test with the given cap. */
function cappedCtx(cap: number): { ctx: Ctx; calls: { path: string }[] } {
  const { voyage, calls } = meteredVoyage(sql, cap);
  return { ctx: { ...fakeCtx(sql, handler), embedder: voyage, reranker: voyage }, calls };
}

const job = async (id: string) =>
  (await sql<{ stage: string; error: string | null; attempts: number }[]>`
    select stage, error, attempts from brain.ingest_jobs where document_id = ${id}`)[0];
const ledgerStatuses = () =>
  sql<{ status: string; n: number }[]>`select status, count(*)::int as n from brain.provider_usage group by status order by status`;
const read = (origin: string, text: string): ReadResult => ({ text, title: null, mimeType: "text/plain", origin, metadata: {} });

/** Everything resolving a document wrote: its facts, edges and mentions (by id), and the fact event log. */
async function graphOf(documentId: string) {
  const facts = await sql<{ id: string; predicate: string; object_text: string; superseded_by: string | null }[]>`
    select f.id, f.predicate, f.object_text, f.superseded_by from brain.facts f
    join brain.chunks c on c.id = f.source_chunk_id where c.document_id = ${documentId} order by f.id`;
  const edges = await sql<{ id: string; type: string }[]>`
    select e.id, e.type from brain.edges e join brain.chunks c on c.id = e.evidence_chunk_id
    where c.document_id = ${documentId} order by e.id`;
  const mentions = await sql<{ chunk_id: string; node_id: string }[]>`
    select m.chunk_id, m.node_id from brain.mentions m join brain.chunks c on c.id = m.chunk_id
    where c.document_id = ${documentId} order by m.chunk_id, m.node_id`;
  const [events] = await sql<{ n: number }[]>`select count(*)::int as n from brain.fact_events`;
  return { facts: [...facts], edges: [...edges], mentions: [...mentions], events: events.n };
}

describe("pipeline on the Voyage daily cap", () => {
  it("stops before embedding with spend_cap, counts no attempt, and finishes on retry once the cap allows", async () => {
    const capped = cappedCtx(1);
    const res = await ingest(capped.ctx, { text: "I applied to Acme Corp. I am on F-1 OPT.", sourceKind: "note" });
    expect(res).toMatchObject({ stage: "summarized", spendCap: true });
    expect(res.error).toMatch(/^spend_cap: Voyage daily token cap reached/);
    expect(capped.calls).toEqual([]);
    const stopped = await job(res.id);
    expect(stopped).toMatchObject({ stage: "summarized", attempts: 0 });
    expect(stopped.error).toMatch(/^spend_cap: /);
    expect(await ledgerStatuses()).toEqual([{ status: "refused", n: 1 }]);

    const raised = cappedCtx(1_000_000);
    const [again] = await retryFailed(raised.ctx);
    expect(again).toMatchObject({ documentId: res.id, stage: "done", error: null });
    expect(again.spendCap).toBeUndefined();
    expect(raised.calls.some((c) => c.path === "/embeddings")).toBe(true);
    expect(await job(res.id)).toMatchObject({ stage: "done", error: null, attempts: 0 });
  });

  it("stops before resolving when the entity-name embedding would pass the cap", async () => {
    const open = cappedCtx(1_000_000);
    const { id } = await ingest(open.ctx, { text: "I applied to Acme Corp.", sourceKind: "note" }, { until: "extracted" });
    const capped = cappedCtx(await tokensToday(sql)); // nothing left today
    const r = await runPipeline(capped.ctx, id);
    expect(r).toMatchObject({ stage: "extracted", spendCap: true });
    expect(r.error).toMatch(/^spend_cap: Voyage daily token cap reached/);
    expect(capped.calls).toEqual([]);
    expect(await job(id)).toMatchObject({ stage: "extracted", attempts: 0 });
  });

  it("ingestAll asks the ledger once, then stops the remaining documents before embedding", async () => {
    const capped = cappedCtx(1);
    const res = await ingestAll(
      capped.ctx,
      [read("/a.md", "First note about apples."), read("/b.md", "Second note about pears."), read("/c.md", "Third note about plums.")],
      { toInput: (r) => ({ text: r.text, origin: r.origin, sourceKind: "note" }) },
      { done: () => {}, skip: () => {} },
    );
    expect(res.ok.map((o) => o.result.stage)).toEqual(["summarized", "summarized", "summarized"]);
    expect(res.ok.every((o) => o.result.spendCap)).toBe(true);
    expect(res.ok[0].result.error).toMatch(/^spend_cap: Voyage daily token cap reached/);
    expect(res.ok.slice(1).map((o) => o.result.error)).toEqual([DEFERRED_MESSAGE, DEFERRED_MESSAGE]);
    expect(await ledgerStatuses()).toEqual([{ status: "refused", n: 1 }]);
    expect(capped.calls).toEqual([]);
    for (const o of res.ok) expect((await job(o.result.id)).attempts).toBe(0);
  });

  it("retryFailed asks the ledger once, then defers the rest", async () => {
    const plain = fakeCtx(sql, handler);
    const ids: string[] = [];
    for (const t of ["Apples are red.", "Pears are green.", "Plums are purple."]) {
      ids.push((await ingest(plain, { text: t, sourceKind: "note" }, { until: "summarized" })).id);
    }
    const capped = cappedCtx(1);
    const results = await retryFailed(capped.ctx);
    expect(results.map((r) => r.documentId).sort()).toEqual([...ids].sort());
    expect(results.every((r) => r.spendCap && r.stage === "summarized")).toBe(true);
    expect(results.filter((r) => r.error === DEFERRED_MESSAGE).length).toBe(2);
    expect(await ledgerStatuses()).toEqual([{ status: "refused", n: 1 }]);
  });

  it("the background queue stops asking after a refusal and logs the cap once", async () => {
    const capped = cappedCtx(1);
    const ids: string[] = [];
    for (const t of ["Apples are red.", "Pears are green.", "Plums are purple."]) {
      const { id } = await storeDocument(sql, { text: t, sourceKind: "note" });
      await runPipeline(capped.ctx, id, { until: "chunked" });
      ids.push(id);
    }
    const logs: string[] = [];
    const jobs = new JobManager(capped.ctx, (m) => logs.push(m));
    for (const id of ids) jobs.start(id);
    await jobs.drain();
    for (const id of ids) {
      const j = await job(id);
      expect(j).toMatchObject({ stage: "summarized", attempts: 0 });
      expect(j.error).toMatch(/^spend_cap: /);
    }
    const [refused] = await ledgerStatuses();
    expect(refused.status).toBe("refused");
    // Documents already running when the first refusal lands ask once each; later ones do not ask.
    expect(refused.n).toBeGreaterThanOrEqual(1);
    expect(refused.n).toBeLessThanOrEqual(BACKGROUND_SLOTS);
    expect(capped.calls).toEqual([]);
    expect(logs.filter((l) => l.includes("Voyage daily cap reached")).length).toBe(1);
  });

  it("re-resolving refused by the cap keeps the previous resolution: facts, edges and mentions are untouched", async () => {
    const open = cappedCtx(1_000_000);
    const { id } = await ingest(open.ctx, { text: "I applied to Acme Corp. I am on F-1 OPT.", sourceKind: "note" });
    expect(await job(id)).toMatchObject({ stage: "done", error: null });
    const before = await graphOf(id);
    expect(before.facts.length).toBeGreaterThan(0);
    expect(before.edges.length).toBeGreaterThan(0);
    expect(before.mentions.length).toBeGreaterThan(0);

    const capped = cappedCtx(await tokensToday(sql)); // nothing left today
    await expect(runResolve(capped.ctx, id)).rejects.toBeInstanceOf(SpendCapError);
    expect(capped.calls).toEqual([]);
    expect(await graphOf(id)).toEqual(before);
  });

  it("set-author refused by the cap changes nothing: the author, the job and the graph stay as they were", async () => {
    const { id } = await ingest(fakeCtx(sql, handler), { text: "I applied to Acme Corp. I am on F-1 OPT.", sourceKind: "note" });
    const before = await graphOf(id);
    expect(before.facts.length).toBeGreaterThan(0);
    const capped = cappedCtx(1);
    await expect(setAuthor(capped.ctx, id, "other")).rejects.toThrow(
      /^author not changed \(still owner\): spend_cap: Voyage daily token cap reached/,
    );
    const [doc] = await sql<{ author: string }[]>`select author from brain.documents where id = ${id}`;
    expect(doc.author).toBe("owner");
    expect(await job(id)).toMatchObject({ stage: "done", error: null, attempts: 0 });
    expect(await graphOf(id)).toEqual(before);
    expect(capped.calls).toEqual([]);
    expect(await ledgerStatuses()).toEqual([{ status: "refused", n: 1 }]);

    // Once the cap allows, the same call goes through.
    const r = await setAuthor(cappedCtx(1_000_000).ctx, id, "other");
    expect(r).toMatchObject({ previous: "owner", author: "other", reresolved: true });
  });
});
