import type { Ctx } from "../ctx.js";
import { runPipeline, MAX_CONCURRENT_PIPELINES, type PipelineResult } from "../ingest/pipeline.js";

/**
 * Background pipelines this manager runs at once. One core slot stays free so a foreground
 * brain_ingest (store and chunk) never waits behind background summarize/extract work.
 */
export const BACKGROUND_SLOTS = Math.max(1, MAX_CONCURRENT_PIPELINES - 1);

/** Runs post-chunk pipeline stages in the background inside the server process. */
export class JobManager {
  /** Documents waiting for a background slot, in arrival order. */
  private readonly queue: string[] = [];
  private readonly running = new Map<string, Promise<PipelineResult>>();
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly ctx: Ctx,
    private readonly log: (message: string) => void = (m) => process.stderr.write(m + "\n"),
  ) {}

  /** Queued and running document ids. */
  get pending(): string[] {
    return [...this.running.keys(), ...this.queue];
  }

  start(documentId: string): void {
    if (this.running.has(documentId) || this.queue.includes(documentId)) return;
    this.queue.push(documentId);
    this.pump();
  }

  private pump(): void {
    while (this.running.size < BACKGROUND_SLOTS && this.queue.length > 0) {
      const documentId = this.queue.shift()!;
      const run = runPipeline(this.ctx, documentId)
        .then((r) => {
          // A skipped result means another runner holds the document; that is not an error.
          if (r.error && !r.skipped) this.log(`brain: document ${documentId} stopped after ${r.stage}: ${r.error}`);
          return r;
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`brain: document ${documentId} failed: ${message}`);
          return { documentId, stage: "stored" as const, error: message };
        })
        .finally(() => {
          this.running.delete(documentId);
          this.pump();
          if (this.running.size === 0 && this.queue.length === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((w) => w());
          }
        });
      this.running.set(documentId, run);
    }
  }

  /** Picks up jobs another process left unfinished. */
  async resumeStalled(limit = 5, olderThanMinutes = 10): Promise<string[]> {
    const rows = await this.ctx.sql<{ document_id: string }[]>`
      select document_id from brain.ingest_jobs
      where stage <> 'done' and attempts < 5 and updated_at < now() - make_interval(mins => ${olderThanMinutes})
      order by updated_at limit ${limit}`;
    const started: string[] = [];
    for (const r of rows) {
      if (this.pending.includes(r.document_id)) continue;
      this.start(r.document_id);
      started.push(r.document_id);
    }
    return started;
  }

  /** Resolves once nothing is queued or running, including jobs started while draining. */
  async drain(): Promise<void> {
    while (this.running.size > 0 || this.queue.length > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }
}
