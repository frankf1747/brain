import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "../config.js";
import type { Ctx } from "../ctx.js";
import { runPipeline } from "./pipeline.js";
import { SummarySchema, buildSummaryRequests, applySummary, type Summary } from "./stages/summarize.js";
import { ExtractionSchema, buildExtractionRequests, applyExtraction, type ExtractionRequest, type Extraction } from "./stages/extract.js";

export type BatchStage = "summarized" | "extracted";

export function makeCustomId(stage: BatchStage, documentId: string, sectionChunkId: string | null): string {
  return `${stage}|${documentId}|${sectionChunkId ?? ""}`;
}

export function parseCustomId(id: string): { stage: BatchStage; documentId: string; sectionChunkId: string | null } {
  const [stage, documentId, section] = id.split("|");
  return { stage: stage as BatchStage, documentId, sectionChunkId: section || null };
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

interface Pending {
  customId: string;
  system: string;
  user: string;
  schema: z.ZodType<unknown>;
  apply: (payload: unknown) => Promise<void>;
}

async function runBatch(client: Anthropic, ctx: Ctx, stage: BatchStage, pending: Pending[], pollMs: number): Promise<{ applied: number; failed: number }> {
  if (pending.length === 0) return { applied: 0, failed: 0 };
  const batch = await client.messages.batches.create({
    requests: pending.map((p) => ({
      custom_id: p.customId,
      params: {
        model: config.anthropicModel,
        max_tokens: 16000,
        system: p.system,
        messages: [{ role: "user", content: p.user }],
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

  const byId = new Map(pending.map((p) => [p.customId, p]));
  let applied = 0;
  let failed = 0;
  for await (const result of await client.messages.batches.results(batch.id)) {
    const p = byId.get(result.custom_id);
    if (!p) continue;
    const { documentId } = parseCustomId(result.custom_id);
    let error: string | null = null;
    if (result.result.type === "succeeded") {
      let text = "";
      for (const block of result.result.message.content) if (block.type === "text") text += block.text;
      const payload = parseBatchText(p.schema, text);
      if (payload) await p.apply(payload);
      else error = "batch output did not match the schema";
    } else {
      error = `batch result ${result.result.type}`;
    }
    if (error) {
      failed++;
      await ctx.sql`update brain.ingest_jobs set error = ${error}, attempts = attempts + 1, updated_at = now() where document_id = ${documentId}`;
    } else {
      applied++;
    }
  }
  // A document advances only when every one of its requests applied.
  const docs = [...new Set(pending.map((p) => parseCustomId(p.customId).documentId))];
  for (const documentId of docs) {
    const [job] = await ctx.sql<{ error: string | null }[]>`select error from brain.ingest_jobs where document_id = ${documentId}`;
    if (job && job.error === null) {
      await ctx.sql`update brain.ingest_jobs set stage = ${stage}, updated_at = now() where document_id = ${documentId}`;
    }
  }
  return { applied, failed };
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
  const summaryPending: Pending[] = [];
  for (const j of chunked) {
    const reqs = await buildSummaryRequests(ctx.sql, j.document_id);
    if (reqs.length !== 1) continue;
    summaryPending.push({
      customId: makeCustomId("summarized", j.document_id, null),
      system: reqs[0].system,
      user: reqs[0].user,
      schema: SummarySchema,
      apply: (payload) => applySummary(ctx.sql, j.document_id, payload as Summary),
    });
  }
  const s = await runBatch(client, ctx, "summarized", summaryPending, pollMs);
  console.log(`summaries: ${s.applied} applied, ${s.failed} failed`);

  // 3. Embeddings online (Voyage, cheap and fast).
  const summarized = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'summarized' limit ${limit}`;
  for (const j of summarized) await runPipeline(ctx, j.document_id, { until: "embedded" });

  // 4. Extraction in one batch, one request per section.
  const embedded = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'embedded' limit ${limit}`;
  const extractPending: Pending[] = [];
  for (const j of embedded) {
    const reqs: ExtractionRequest[] = await buildExtractionRequests(ctx.sql, j.document_id);
    for (const r of reqs) {
      extractPending.push({
        customId: makeCustomId("extracted", r.documentId, r.sectionChunkId),
        system: r.system,
        user: r.user,
        schema: ExtractionSchema,
        apply: (payload) => applyExtraction(ctx.sql, r, payload as Extraction, config.anthropicModel),
      });
    }
  }
  const e = await runBatch(client, ctx, "extracted", extractPending, pollMs);
  console.log(`extractions: ${e.applied} applied, ${e.failed} failed`);

  // 5. Resolve online (local plus name embeddings).
  const extracted = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'extracted' limit ${limit}`;
  for (const j of extracted) await runPipeline(ctx, j.document_id);
}
