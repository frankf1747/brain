import type { Ctx } from "../ctx.js";
import { runPipeline, type PipelineResult } from "../ingest/pipeline.js";

/** Runs post-chunk pipeline stages in the background inside the server process. */
export class JobManager {
  private readonly inflight = new Map<string, Promise<PipelineResult>>();

  constructor(
    private readonly ctx: Ctx,
    private readonly log: (message: string) => void = (m) => process.stderr.write(m + "\n"),
  ) {}

  get pending(): string[] {
    return [...this.inflight.keys()];
  }

  start(documentId: string): void {
    if (this.inflight.has(documentId)) return;
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
      .finally(() => this.inflight.delete(documentId));
    this.inflight.set(documentId, run);
  }

  /** Picks up jobs another process left unfinished. */
  async resumeStalled(limit = 5, olderThanMinutes = 10): Promise<string[]> {
    const rows = await this.ctx.sql<{ document_id: string }[]>`
      select document_id from brain.ingest_jobs
      where stage <> 'done' and updated_at < now() - make_interval(mins => ${olderThanMinutes})
      order by updated_at limit ${limit}`;
    const started: string[] = [];
    for (const r of rows) {
      if (this.inflight.has(r.document_id)) continue;
      this.start(r.document_id);
      started.push(r.document_id);
    }
    return started;
  }

  async drain(): Promise<void> {
    await Promise.all(this.inflight.values());
  }
}
