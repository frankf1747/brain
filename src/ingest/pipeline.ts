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
}

/** Advances a document stage by stage until `until` (default done) or the first failure. */
export async function runPipeline(ctx: Ctx, documentId: string, opts: { until?: Stage } = {}): Promise<PipelineResult> {
  const target = opts.until ?? "done";
  for (;;) {
    const [job] = await ctx.sql<{ stage: Stage }[]>`select stage from brain.ingest_jobs where document_id = ${documentId}`;
    if (!job) throw new Error(`No ingest job for document ${documentId}`);
    const idx = STAGES.indexOf(job.stage);
    if (idx >= STAGES.indexOf(target)) return { documentId, stage: job.stage, error: null };
    const next = STAGES[idx + 1] as Exclude<Stage, "stored">;
    try {
      await RUNNERS[next](ctx, documentId);
      await ctx.sql`update brain.ingest_jobs set stage = ${next}, error = null, updated_at = now() where document_id = ${documentId}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.sql`update brain.ingest_jobs set error = ${message}, attempts = attempts + 1, updated_at = now() where document_id = ${documentId}`;
      return { documentId, stage: job.stage, error: message };
    }
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
