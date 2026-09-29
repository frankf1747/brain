import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest, retryFailed, runPipeline } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { fakeExtraction } from "./fixtures.js";
import { toVector } from "../../src/db.js";
import { hashVector } from "../../src/llm/voyage.js";
import { storeDocument } from "../../src/ingest/store.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const summary = { title: "Acme note", summary_line: "Applying to Acme.", summary: "The owner applied to Acme Corp and is on F-1 OPT.", occurred_at: null };

function handlerWith(state: { failExtract: boolean }) {
  return ({ system }: { system: string }) => {
    if (system === SUMMARY_SYSTEM) return summary;
    if (state.failExtract) throw new Error("boom");
    return fakeExtraction;
  };
}

describe("pipeline", () => {
  it("runs a document from store to done", async () => {
    const ctx = fakeCtx(sql, handlerWith({ failExtract: false }));
    const res = await ingest(ctx, { text: "I applied to Acme Corp. I am on F-1 OPT.", sourceKind: "note" });
    expect(res.created).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.error).toBeNull();
    const [{ n }] = await sql<{ n: string }[]>`select count(*)::text as n from brain.edges`;
    expect(Number(n)).toBe(1);
  });

  it("records a failure at the failing stage, keeps the document searchable, and retries to completion", async () => {
    const state = { failExtract: true };
    const ctx = fakeCtx(sql, handlerWith(state));
    const res = await ingest(ctx, { text: "I applied to Acme Corp. Zorblax is mentioned." });
    expect(res.stage).toBe("embedded");
    expect(res.error).toBe("boom");
    const [job] = await sql<{ attempts: number; error: string }[]>`select attempts, error from brain.ingest_jobs where document_id = ${res.id}`;
    expect(job.attempts).toBe(1);

    const hits = await sql`select * from brain.hybrid_search('Zorblax', ${toVector(hashVector("Zorblax"))}::vector, 10, null, null, null)`;
    expect(hits.length).toBeGreaterThan(0); // guarantee 1: retrievable before extraction

    state.failExtract = false;
    const retried = await retryFailed(ctx);
    expect(retried).toEqual([expect.objectContaining({ documentId: res.id, stage: "done", error: null })]);
  });

  it("stops at the requested stage", async () => {
    const ctx = fakeCtx(sql, handlerWith({ failExtract: false }));
    const res = await ingest(ctx, { text: "Only chunk me." }, { until: "chunked" });
    expect(res.stage).toBe("chunked");
    expect(ctx.llm.calls.length).toBe(0);
    const later = await runPipeline(ctx, res.id);
    expect(later.stage).toBe("done");
  });

  it("takes a heading-only note to done and makes the heading keyword-searchable", async () => {
    const ctx = fakeCtx(sql, handlerWith({ failExtract: false }));
    const res = await ingest(ctx, { text: "# Call about the Quuxworth offer" });
    expect(res.stage).toBe("done");
    expect(res.error).toBeNull();
    const hits = await sql`select * from brain.hybrid_search('Quuxworth', null::vector, 10, null, null, null)`;
    expect(hits.length).toBe(1);
  });

  it("runs a document once when two runners race, and the loser reports skipped", async () => {
    const text = "I applied to Acme Corp. I am on F-1 OPT.\n\nSecond paragraph about the interview loop.";
    const slow = async ({ system }: { system: string }) => {
      if (system === SUMMARY_SYSTEM) {
        await new Promise((r) => setTimeout(r, 300));
        return summary;
      }
      return fakeExtraction;
    };
    const ctx = fakeCtx(sql, slow);
    const { id } = await storeDocument(sql, { text, sourceKind: "note" });
    const results = await Promise.all([runPipeline(ctx, id), runPipeline(ctx, id)]);
    expect(results.filter((r) => r.skipped).length).toBe(1);
    const winner = results.find((r) => !r.skipped)!;
    expect(winner).toMatchObject({ documentId: id, stage: "done", error: null });

    const [job] = await sql<{ stage: string }[]>`select stage from brain.ingest_jobs where document_id = ${id}`;
    expect(job.stage).toBe("done");
    expect(ctx.llm.calls.filter((c) => c.system === SUMMARY_SYSTEM).length).toBe(1);
    const chunks = await sql<{ level: number; ordinal: number }[]>`select level, ordinal from brain.chunks where document_id = ${id}`;
    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map((c) => `${c.level}:${c.ordinal}`)).size).toBe(chunks.length);
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from brain.extractions where document_id = ${id}`;
    expect(Number(n)).toBeGreaterThan(0);

    // A later run finds nothing to do and is not blocked by a leaked lock.
    const again = await runPipeline(ctx, id);
    expect(again).toMatchObject({ stage: "done", error: null });
    expect(again.skipped).toBeFalsy();
  });

  it("releases the document lock after a stage fails", async () => {
    const state = { failExtract: true };
    const ctx = fakeCtx(sql, handlerWith(state));
    const { id } = await storeDocument(sql, { text: "I applied to Acme Corp. Zorblax is mentioned.", sourceKind: "note" });
    const first = await runPipeline(ctx, id);
    expect(first).toMatchObject({ stage: "embedded", error: "boom" });
    state.failExtract = false;
    const second = await runPipeline(ctx, id);
    expect(second.skipped).toBeFalsy();
    expect(second).toMatchObject({ stage: "done", error: null });
  });
});
