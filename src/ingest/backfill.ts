import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "../config.js";
import type { Ctx } from "../ctx.js";
import { runPipeline, SPEND_CAP_ADVICE } from "./pipeline.js";
import { SummarySchema, buildSummaryRequests, applySummary, applyStubSummary, type Summary } from "./stages/summarize.js";
import { ExtractionSchema, buildExtractionRequests, applyExtraction, markExtractionSkipped, type ExtractionRequest, type Extraction } from "./stages/extract.js";

export type BatchStage = "summarized" | "extracted";

/** The stage a document must be at to enter each batch stage. */
const PREVIOUS: Record<BatchStage, "chunked" | "embedded"> = { summarized: "chunked", extracted: "embedded" };

/** Batch custom ids must match ^[a-zA-Z0-9_-]{1,64}$; short per-batch indexes always do. */
export function batchCustomId(index: number): string {
  return `r${index}`;
}

export function parseBatchText<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when another runner (runPipeline) holds this document's advisory lock right now. */
async function isLocked(ctx: Ctx, documentId: string): Promise<boolean> {
  const reserved = await ctx.sql.reserve();
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtextextended(${documentId}::text, 0)) as locked`;
    if (locked) await reserved`select pg_advisory_unlock(hashtextextended(${documentId}::text, 0))`;
    return !locked;
  } finally {
    reserved.release();
  }
}

interface Pending {
  documentId: string;
  system: string;
  user: string;
  schema: z.ZodType<unknown>;
  apply: (payload: unknown) => Promise<void>;
  /** The online path's fallback for a refusal or unusable output (stub summary, skipped extraction). */
  fallback: () => Promise<void>;
}

/**
 * Submits one batch, applies its results, and advances every document in `documentIds` whose requests
 * all applied or fell back. Documents in `documentIds` with no requests advance too.
 */
async function runBatch(
  client: Anthropic,
  ctx: Ctx,
  stage: BatchStage,
  documentIds: string[],
  pending: Pending[],
  pollMs: number,
): Promise<{ applied: number; fellBack: number; failed: number }> {
  const byId = new Map(pending.map((p, i) => [batchCustomId(i), p]));
  const failedDocs = new Set<string>();
  let applied = 0;
  let fellBack = 0;
  let failed = 0;

  if (pending.length > 0) {
    const batch = await client.messages.batches.create({
      requests: [...byId].map(([customId, p]) => ({
        custom_id: customId,
        params: {
          model: config.anthropicModel,
          max_tokens: 16000,
          system: p.system,
          messages: [{ role: "user" as const, content: p.user }],
          output_config: { format: zodOutputFormat(p.schema) },
        },
      })),
    });
    console.log(`batch ${batch.id}: ${pending.length} requests for stage ${stage}`);

    let status = batch;
    while (status.processing_status !== "ended") {
      await sleep(pollMs);
      status = await client.messages.batches.retrieve(batch.id);
      console.log(`  ${status.request_counts.succeeded} ok, ${status.request_counts.errored} errored, ${status.request_counts.processing} processing`);
    }

    const seen = new Set<string>();
    for await (const result of await client.messages.batches.results(batch.id)) {
      const p = byId.get(result.custom_id);
      if (!p) continue;
      seen.add(result.custom_id);
      if (result.result.type === "succeeded") {
        const message = result.result.message;
        let text = "";
        for (const block of message.content) if (block.type === "text") text += block.text;
        // A refusal, truncation or unusable output falls back exactly as the online path does.
        const payload = message.stop_reason === "refusal" || message.stop_reason === "max_tokens" ? null : parseBatchText(p.schema, text);
        if (payload) {
          await p.apply(payload);
          applied++;
        } else {
          await p.fallback();
          fellBack++;
        }
      } else {
        failed++;
        failedDocs.add(p.documentId);
        await ctx.sql`
          update brain.ingest_jobs set error = ${`batch result ${result.result.type}`}, attempts = attempts + 1, updated_at = now()
          where document_id = ${p.documentId}`;
      }
    }
    for (const [customId, p] of byId) {
      if (seen.has(customId)) continue;
      failed++;
      failedDocs.add(p.documentId);
      await ctx.sql`
        update brain.ingest_jobs set error = 'batch result missing', attempts = attempts + 1, updated_at = now()
        where document_id = ${p.documentId}`;
    }
  }

  // Advance only documents with no failed request in this run, and only from the stage they were
  // at, so a concurrent runner can never be moved backwards. A stale error from earlier is cleared.
  for (const documentId of documentIds) {
    if (failedDocs.has(documentId)) continue;
    await ctx.sql`
      update brain.ingest_jobs set stage = ${stage}, error = null, updated_at = now()
      where document_id = ${documentId} and stage = ${PREVIOUS[stage]}`;
  }
  return { applied, fellBack, failed };
}

/**
 * Moves every unfinished document through summarize and extract via the Message Batches API,
 * running the cheap local stages (chunk, embed, resolve) online in between.
 */
export async function backfill(ctx: Ctx, opts: { client?: Anthropic; limit?: number; pollMs?: number } = {}): Promise<void> {
  const client = opts.client ?? new Anthropic();
  const limit = opts.limit ?? 500;
  const pollMs = opts.pollMs ?? 30_000;

  // 1. Get everything at least chunked.
  const stored = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'stored' limit ${limit}`;
  for (const j of stored) await runPipeline(ctx, j.document_id, { until: "chunked" });

  // 2. Summaries in one batch. Long documents (several requests) stay on the online path.
  const chunked = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'chunked' limit ${limit}`;
  // Documents a runPipeline call currently holds are left to that runner.
  const summaryDocs: string[] = [];
  const summaryPending: Pending[] = [];
  for (const j of chunked) {
    if (await isLocked(ctx, j.document_id)) continue;
    const reqs = await buildSummaryRequests(ctx.sql, j.document_id);
    if (reqs.length !== 1) continue;
    summaryDocs.push(j.document_id);
    summaryPending.push({
      documentId: j.document_id,
      system: reqs[0].system,
      user: reqs[0].user,
      schema: SummarySchema,
      apply: (payload) => applySummary(ctx.sql, j.document_id, payload as Summary),
      fallback: () => applyStubSummary(ctx.sql, j.document_id),
    });
  }
  const s = await runBatch(client, ctx, "summarized", summaryDocs, summaryPending, pollMs);
  console.log(`summaries: ${s.applied} applied, ${s.fellBack} stubbed, ${s.failed} failed`);

  // 3. Embeddings online (Voyage). After the daily cap refuses one document, the rest are deferred without asking again.
  let voyageBlocked = false;
  const summarized = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'summarized' limit ${limit}`;
  for (const j of summarized) {
    const r = await runPipeline(ctx, j.document_id, { until: "embedded", voyageBlocked });
    if (r.spendCap) voyageBlocked = true;
  }

  // 4. Extraction in one batch, one request per section.
  const embedded = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'embedded' limit ${limit}`;
  const extractDocs: string[] = [];
  const extractPending: Pending[] = [];
  for (const j of embedded) {
    if (await isLocked(ctx, j.document_id)) continue;
    extractDocs.push(j.document_id);
    const reqs: ExtractionRequest[] = await buildExtractionRequests(ctx.sql, j.document_id);
    for (const r of reqs) {
      extractPending.push({
        documentId: r.documentId,
        system: r.system,
        user: r.user,
        schema: ExtractionSchema,
        apply: (payload) => applyExtraction(ctx.sql, r, payload as Extraction, config.anthropicModel),
        fallback: () => markExtractionSkipped(ctx.sql, r.documentId),
      });
    }
  }
  const e = await runBatch(client, ctx, "extracted", extractDocs, extractPending, pollMs);
  console.log(`extractions: ${e.applied} applied, ${e.fellBack} skipped, ${e.failed} failed`);

  // 5. Resolve online (local plus name embeddings).
  const extracted = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'extracted' limit ${limit}`;
  for (const j of extracted) {
    const r = await runPipeline(ctx, j.document_id, { voyageBlocked });
    if (r.spendCap) voyageBlocked = true;
  }
  if (voyageBlocked) console.log(SPEND_CAP_ADVICE);
}
