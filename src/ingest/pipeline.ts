import type { Ctx } from "../ctx.js";
import { storeDocument, type StoreInput } from "./store.js";
import { runChunk } from "./stages/chunk.js";
import { runSummarize } from "./stages/summarize.js";
import { runEmbed } from "./stages/embed.js";
import { runExtract } from "./stages/extract.js";
import { runResolve } from "./stages/resolve.js";

export const STAGES = ["stored", "chunked", "summarized", "embedded", "extracted", "resolved", "done"] as const;
export type Stage = (typeof STAGES)[number];

type Runner = (ctx: Ctx, documentId: string) => Promise<void>;
const RUNNERS: Record<Exclude<Stage, "stored">, Runner> = {
  chunked: runChunk,
  summarized: runSummarize,
  embedded: runEmbed,
  extracted: runExtract,
  resolved: runResolve,
  done: async () => {},
};

export interface PipelineResult {
  documentId: string;
  stage: Stage;
  error: string | null;
  /** True when another runner holds this document's lock, so this call did nothing. */
  skipped?: boolean;
}

/**
 * Each running pipeline pins one reserved connection (its advisory lock) and needs up to a few pooled
 * connections for its stage queries. With the pool at max 10 (src/db.ts), three at once leave room for
 * their stage queries and for other work; without a cap, as many pipelines as pool slots would each
 * reserve one and their stage queries would wait forever.
 */
export const MAX_CONCURRENT_PIPELINES = 3;

/** Process-wide counting semaphore: excess runPipeline calls wait for a slot instead of failing. */
let running = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT_PIPELINES) {
    running++;
    return;
  }
  // The releaser hands its slot straight to us, so `running` stays unchanged.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

async function currentStage(ctx: Ctx, documentId: string): Promise<Stage> {
  const [job] = await ctx.sql<{ stage: Stage }[]>`select stage from brain.ingest_jobs where document_id = ${documentId}`;
  if (!job) throw new Error(`No ingest job for document ${documentId}`);
  return job.stage;
}

/**
 * Advances a document stage by stage until `until` (default done) or the first failure.
 * Holds a per-document session advisory lock for the whole run; if another runner holds it,
 * returns the current stage with skipped: true and does nothing. At most MAX_CONCURRENT_PIPELINES
 * runs proceed at once per process; the rest wait their turn.
 */
export async function runPipeline(ctx: Ctx, documentId: string, opts: { until?: Stage } = {}): Promise<PipelineResult> {
  await acquireSlot();
  try {
    return await runLocked(ctx, documentId, opts.until ?? "done");
  } finally {
    releaseSlot();
  }
}

async function runLocked(ctx: Ctx, documentId: string, until: Stage): Promise<PipelineResult> {
  const reserved = await ctx.sql.reserve();
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtextextended(${documentId}::text, 0)) as locked`;
    if (!locked) return { documentId, stage: await currentStage(ctx, documentId), error: null, skipped: true };
    try {
      return await advance(ctx, documentId, until);
    } finally {
      await reserved`select pg_advisory_unlock(hashtextextended(${documentId}::text, 0))`;
    }
  } finally {
    reserved.release();
  }
}

async function advance(ctx: Ctx, documentId: string, target: Stage): Promise<PipelineResult> {
  for (;;) {
    const stage = await currentStage(ctx, documentId);
    const idx = STAGES.indexOf(stage);
    if (idx >= STAGES.indexOf(target)) return { documentId, stage, error: null };
    const next = STAGES[idx + 1] as Exclude<Stage, "stored">;
    try {
      await RUNNERS[next](ctx, documentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.sql`update brain.ingest_jobs set error = ${message}, attempts = attempts + 1, updated_at = now() where document_id = ${documentId}`;
      return { documentId, stage, error: message };
    }
    // Only advance from the stage this run started from, so a stage can never move backwards.
    const moved = await ctx.sql`
      update brain.ingest_jobs set stage = ${next}, error = null, updated_at = now()
      where document_id = ${documentId} and stage = ${stage}`;
    if (moved.count === 0) return { documentId, stage: await currentStage(ctx, documentId), error: null };
  }
}

export async function ingest(
  ctx: Ctx,
  input: StoreInput,
  opts: { until?: Stage } = {},
): Promise<PipelineResult & { created: boolean; id: string }> {
  const { id, created } = await storeDocument(ctx.sql, input);
  const result = await runPipeline(ctx, id, opts);
  return { ...result, created, id: result.documentId };
}

/** Re-runs every job that is not done, oldest first. */
export async function retryFailed(ctx: Ctx, opts: { stage?: Stage; limit?: number } = {}): Promise<PipelineResult[]> {
  const jobs = await ctx.sql<{ document_id: string }[]>`
    select document_id from brain.ingest_jobs
    where stage <> 'done' and (${opts.stage ?? null}::text is null or stage = ${opts.stage ?? null})
    order by updated_at limit ${opts.limit ?? 1000}`;
  const out: PipelineResult[] = [];
  for (const j of jobs) out.push(await runPipeline(ctx, j.document_id));
  return out;
}

export async function stageCounts(ctx: Ctx): Promise<{ stage: string; count: number; failed: number }[]> {
  const rows = await ctx.sql<{ stage: string; count: string; failed: string }[]>`
    select stage, count(*)::text as count, count(error)::text as failed from brain.ingest_jobs group by stage`;
  return STAGES.map((s) => {
    const r = rows.find((x) => x.stage === s);
    return { stage: s, count: Number(r?.count ?? 0), failed: Number(r?.failed ?? 0) };
  });
}
