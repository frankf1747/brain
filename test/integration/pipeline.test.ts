import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest, retryFailed, runPipeline } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { fakeExtraction } from "./fixtures.js";
import { toVector } from "../../src/db.js";
import { hashVector } from "../../src/llm/voyage.js";

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
});
