import type { Ctx } from "../ctx.js";
import { storeDocument, type StoreInput } from "./store.js";
import { withDocumentLock } from "./lock.js";
import type { Author } from "./author.js";
import { runChunk } from "./stages/chunk.js";
import { runSummarize } from "./stages/summarize.js";
import { runEmbed } from "./stages/embed.js";
import { runExtract } from "./stages/extract.js";
import { runResolve } from "./stages/resolve.js";

export const STAGES = ["stored", "chunked", "summarized", "embedded", "extracted", "resolved", "done"] as const;
export type Stage = (typeof STAGES)[number];

/** A stage may return a report (runResolve does); the pipeline ignores it. */
type Runner = (ctx: Ctx, documentId: string) => Promise<unknown>;
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
  const r = await withDocumentLock(ctx.sql, documentId, () => advance(ctx, documentId, until));
  return r.locked ? r.value : { documentId, stage: await currentStage(ctx, documentId), error: null, skipped: true };
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
    // The raw text is readable once chunked, and the enrichment once done; tell the mirror both times.
    if (next === "chunked" || next === "done") documentChanged(ctx, documentId);
  }
}

/** A change listener (the Obsidian mirror) must never fail or stall ingestion. */
function documentChanged(ctx: Ctx, documentId: string): void {
  try {
    ctx.onDocumentChanged?.(documentId);
  } catch (err) {
    process.stderr.write(`brain: document change hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export async function ingest(
  ctx: Ctx,
  input: StoreInput,
  opts: { until?: Stage } = {},
): Promise<PipelineResult & { created: boolean; id: string; author: Author }> {
  const { id, created, author } = await storeDocument(ctx.sql, input);
  const result = await runPipeline(ctx, id, opts);
  return { ...result, created, id: result.documentId, author };
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

/** Stages after which a skipped summary (redo from chunked) or skipped extraction (redo from embedded) has already been passed. */
const AFTER_CHUNKED: Stage[] = ["summarized", "embedded", "extracted", "resolved", "done"];
const AFTER_EMBEDDED: Stage[] = ["extracted", "resolved", "done"];

/**
 * Redoes enrichment that was skipped because the model refused or kept failing the schema: a stubbed
 * summary is redone from the chunked stage (which also redoes embedding and extraction), a skipped
 * extraction from the embedded stage. The reset happens only while holding the document's advisory
 * lock, so a document another runner holds is left alone and reported as skipped.
 */
export async function redoSkipped(ctx: Ctx, opts: { limit?: number } = {}): Promise<PipelineResult[]> {
  const docs = await ctx.sql<{ id: string }[]>`
    select d.id from brain.documents d join brain.ingest_jobs j on j.document_id = d.id
    where d.metadata->>'summary' = 'skipped' or d.metadata->>'extraction' = 'skipped'
    order by j.updated_at limit ${opts.limit ?? 1000}`;
  const out: PipelineResult[] = [];
  for (const { id } of docs) {
    if (!(await resetSkipped(ctx, id))) {
      out.push({ documentId: id, stage: await currentStage(ctx, id), error: null, skipped: true });
      continue;
    }
    out.push(await runPipeline(ctx, id));
  }
  return out;
}

/** Resets one document's stage and skip flags under its advisory lock. False when another runner holds the lock. */
async function resetSkipped(ctx: Ctx, documentId: string): Promise<boolean> {
  const r = await withDocumentLock(ctx.sql, documentId, () =>
    ctx.sql.begin(async (tx) => {
      const [doc] = await tx<{ summary: string | null; extraction: string | null }[]>`
        select metadata->>'summary' as summary, metadata->>'extraction' as extraction
        from brain.documents where id = ${documentId} for update`;
      if (!doc) return;
      const redoSummary = doc.summary === "skipped";
      if (!redoSummary && doc.extraction !== "skipped") return;
      // Redoing the summary redoes extraction too, so both flags go; otherwise only the extraction flag.
      await tx`
        update brain.documents
        set metadata = metadata - ${redoSummary ? ["summary", "extraction"] : ["extraction"]}::text[]
        where id = ${documentId}`;
      const to: Stage = redoSummary ? "chunked" : "embedded";
      const later = redoSummary ? AFTER_CHUNKED : AFTER_EMBEDDED;
      await tx`
        update brain.ingest_jobs set stage = ${to}, error = null, updated_at = now()
        where document_id = ${documentId} and stage = any(${later}::text[])`;
    }),
  );
  return r.locked;
}

export async function stageCounts(ctx: Ctx): Promise<{ stage: string; count: number; failed: number }[]> {
  const rows = await ctx.sql<{ stage: string; count: string; failed: string }[]>`
    select stage, count(*)::text as count, count(error)::text as failed from brain.ingest_jobs group by stage`;
  return STAGES.map((s) => {
    const r = rows.find((x) => x.stage === s);
    return { stage: s, count: Number(r?.count ?? 0), failed: Number(r?.failed ?? 0) };
  });
}
