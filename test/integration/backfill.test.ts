import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { storeDocument } from "../../src/ingest/store.js";
import { runPipeline } from "../../src/ingest/pipeline.js";
import { backfill } from "../../src/ingest/backfill.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const summary = { title: "Acme note", summary_line: "Applying to Acme.", summary: "The owner applied to Acme Corp.", occurred_at: null };

interface BatchRequest {
  custom_id: string;
  params: { system: string; messages: { content: string }[] };
}
type Reply = { text: string; stop_reason?: string } | { error: true };

/** Fake Batches API: every batch ends immediately; `reply` decides each request's result. */
function fakeClient(reply: (req: BatchRequest) => Reply) {
  const batches = new Map<string, BatchRequest[]>();
  const submitted: BatchRequest[] = [];
  const counts = { succeeded: 0, errored: 0, processing: 0, canceled: 0, expired: 0 };
  const client = {
    messages: {
      batches: {
        create: async ({ requests }: { requests: BatchRequest[] }) => {
          const id = `batch_${batches.size}`;
          batches.set(id, requests);
          submitted.push(...requests);
          return { id, processing_status: "ended", request_counts: counts };
        },
        retrieve: async (id: string) => ({ id, processing_status: "ended", request_counts: counts }),
        results: async (id: string) =>
          (async function* () {
            for (const req of batches.get(id) ?? []) {
              const r = reply(req);
              if ("error" in r) {
                yield { custom_id: req.custom_id, result: { type: "errored", error: { type: "error", error: { type: "api_error", message: "x" } } } };
              } else {
                yield {
                  custom_id: req.custom_id,
                  result: { type: "succeeded", message: { stop_reason: r.stop_reason ?? "end_turn", stop_details: null, content: [{ type: "text", text: r.text }] } },
                };
              }
            }
          })(),
      },
    },
  } as unknown as Anthropic;
  return { client, submitted };
}

const good = (req: BatchRequest): Reply =>
  req.params.system === SUMMARY_SYSTEM ? { text: JSON.stringify(summary) } : { text: JSON.stringify(fakeExtraction) };

async function job(id: string) {
  const [row] = await sql<{ stage: string; error: string | null }[]>`select stage, error from brain.ingest_jobs where document_id = ${id}`;
  return row;
}

describe("backfill", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("builds batch extraction requests with the same author header and rule as the online path", async () => {
    const ctx = fakeCtx(sql);
    await storeDocument(sql, { text: "I cut our Databricks bill in half. Cost governance matters.", sourceKind: "note", author: "other", origin: "https://example.test/post" });
    const { client, submitted } = fakeClient(good);
    await backfill(ctx, { client, pollMs: 1 });
    const extraction = submitted.find((r) => r.params.system !== SUMMARY_SYSTEM)!;
    expect(extraction.params.messages[0].content).toContain("Author: other");
    expect(extraction.params.messages[0].content).toContain("Origin: https://example.test/post");
    expect(extraction.params.system).toContain("who is not the owner");
  });

  it("submits valid custom ids and takes documents to done", async () => {
    const ctx = fakeCtx(sql);
    const a = await storeDocument(sql, { text: "I applied to Acme Corp. I am on F-1 OPT.", sourceKind: "note" });
    const b = await storeDocument(sql, { text: "A second note about Acme Corp.", sourceKind: "note" });
    const { client, submitted } = fakeClient(good);
    await backfill(ctx, { client, pollMs: 1 });
    expect(submitted.length).toBeGreaterThanOrEqual(4);
    for (const r of submitted) expect(r.custom_id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect((await job(a.id)).stage).toBe("done");
    expect((await job(b.id)).stage).toBe("done");
    expect(ctx.llm.calls.length).toBe(0);
  });

  it("advances a document that carries a stale error from an earlier online failure, and clears it", async () => {
    const ctx = fakeCtx(sql);
    const { id } = await storeDocument(sql, { text: "I applied to Acme Corp.", sourceKind: "note" });
    await runPipeline(ctx, id, { until: "chunked" });
    await sql`update brain.ingest_jobs set error = 'old online failure' where document_id = ${id}`;
    const { client } = fakeClient(good);
    await backfill(ctx, { client, pollMs: 1 });
    expect(await job(id)).toEqual({ stage: "done", error: null });
  });

  it("stubs a failed batch summary and skips a refused extraction, like the online path", async () => {
    const ctx = fakeCtx(sql);
    const { id } = await storeDocument(sql, { text: "# Quux call\n\nI applied to Acme Corp.", sourceKind: "note" });
    const { client } = fakeClient((req) =>
      req.params.system === SUMMARY_SYSTEM ? { text: "not json" } : { text: "", stop_reason: "refusal" },
    );
    await backfill(ctx, { client, pollMs: 1 });
    expect(await job(id)).toEqual({ stage: "done", error: null });
    const [doc] = await sql<{ summary_line: string; title: string; metadata: Record<string, string> }[]>`
      select summary_line, title, metadata from brain.documents where id = ${id}`;
    expect(doc.metadata.summary).toBe("skipped");
    expect(doc.metadata.extraction).toBe("skipped");
    expect(doc.summary_line).toContain("Quux call");
    expect(doc.title).toBe("Quux call");
  });

  it("records an errored request on the job and does not advance that document", async () => {
    const ctx = fakeCtx(sql);
    const { id } = await storeDocument(sql, { text: "I applied to Acme Corp.", sourceKind: "note" });
    const { client } = fakeClient((req) => (req.params.system === SUMMARY_SYSTEM ? { error: true } : good(req)));
    await backfill(ctx, { client, pollMs: 1 });
    const row = await job(id);
    expect(row.stage).toBe("chunked");
    expect(row.error).toMatch(/errored/);
  });

  it("does not submit a document whose lock another runner holds", async () => {
    const ctx = fakeCtx(sql);
    const locked = await storeDocument(sql, { text: "Locked note about Zorblax.", sourceKind: "note" });
    const free = await storeDocument(sql, { text: "Free note about Acme Corp.", sourceKind: "note" });
    await runPipeline(ctx, locked.id, { until: "chunked" });
    await runPipeline(ctx, free.id, { until: "chunked" });
    const holder = await sql.reserve();
    try {
      await holder`select pg_advisory_lock(hashtextextended(${locked.id}::text, 0))`;
      const { client, submitted } = fakeClient(good);
      await backfill(ctx, { client, pollMs: 1 });
      expect(submitted.some((r) => r.params.messages[0].content.includes("Zorblax"))).toBe(false);
      expect(submitted.some((r) => r.params.messages[0].content.includes("Acme Corp"))).toBe(true);
      expect((await job(locked.id)).stage).toBe("chunked");
      expect((await job(free.id)).stage).toBe("done");
    } finally {
      await holder`select pg_advisory_unlock(hashtextextended(${locked.id}::text, 0))`;
      holder.release();
    }
  });
});
