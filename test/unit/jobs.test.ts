import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Ctx } from "../../src/ctx.js";
import type { PipelineResult, RunOptions } from "../../src/ingest/pipeline.js";

// The manager's only collaborator is runPipeline; each call is answered by hand so the clock can move in between.
const calls: { documentId: string; opts: RunOptions | undefined; finish: (r: PipelineResult) => void }[] = [];
vi.mock("../../src/ingest/pipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ingest/pipeline.js")>()),
  runPipeline: (_ctx: Ctx, documentId: string, opts?: RunOptions) =>
    new Promise<PipelineResult>((finish) => calls.push({ documentId, opts, finish })),
}));

const { JobManager } = await import("../../src/mcp/jobs.js");
const { DEFERRED_MESSAGE } = await import("../../src/ingest/pipeline.js");

const ctx = {} as Ctx;
const tick = () => new Promise((r) => setTimeout(r, 0));
const refused = (documentId: string): PipelineResult => ({
  documentId, stage: "summarized", error: "spend_cap: Voyage daily token cap reached", spendCap: true,
});
const deferred = (documentId: string): PipelineResult => ({ documentId, stage: "summarized", error: DEFERRED_MESSAGE, spendCap: true });

beforeEach(() => {
  calls.length = 0;
});

describe("JobManager on the Voyage daily cap", () => {
  it("blocks the rest of the UTC day after a real refusal", async () => {
    let now = new Date("2026-10-01T10:00:00Z");
    const logs: string[] = [];
    const jobs = new JobManager(ctx, (m) => logs.push(m), { now: () => now });
    jobs.start("a");
    calls[0].finish(refused("a"));
    await tick();
    jobs.start("b");
    expect(calls[1].opts?.voyageBlocked).toBe(true);
    calls[1].finish(deferred("b"));
    await tick();
    now = new Date("2026-10-02T00:00:01Z");
    jobs.start("c");
    expect(calls[2].opts?.voyageBlocked).toBe(false);
    calls[2].finish({ documentId: "c", stage: "done", error: null });
    await jobs.drain();
    expect(logs.filter((l) => l.includes("Voyage daily cap reached")).length).toBe(1);
  });

  it("a document deferred on day 1 that finishes after 00:00 UTC does not block day 2", async () => {
    let now = new Date("2026-10-01T23:59:00Z");
    const logs: string[] = [];
    const jobs = new JobManager(ctx, (m) => logs.push(m), { now: () => now });
    jobs.start("a");
    calls[0].finish(refused("a"));
    await tick();
    jobs.start("b"); // started blocked on day 1
    expect(calls[1].opts?.voyageBlocked).toBe(true);
    now = new Date("2026-10-02T00:00:05Z");
    calls[1].finish(deferred("b")); // returns on day 2
    await tick();
    jobs.start("c");
    expect(calls[2].opts?.voyageBlocked).toBe(false); // day 2 asks the ledger again
    calls[2].finish({ documentId: "c", stage: "done", error: null });
    await jobs.drain();
    expect(logs.filter((l) => l.includes("Voyage daily cap reached")).length).toBe(1);
  });
});
