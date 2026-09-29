import type { Ctx } from "../ctx.js";
import type { ReadResult } from "./readers.js";
import type { StoreInput } from "./store.js";
import { ingest, type PipelineResult, type Stage } from "./pipeline.js";

export type IngestOutcome = PipelineResult & { created: boolean; id: string };

export interface IngestAllOptions {
  until?: Stage;
  /** Builds the store input for one read result; defaults to its own text, title, origin, mime type and metadata. */
  toInput?: (r: ReadResult) => StoreInput;
}

export interface IngestLog {
  done(r: ReadResult, res: IngestOutcome): void;
  skip(r: ReadResult, message: string): void;
}

/** Default skip line: `skip  <origin>: <message>` on stderr. */
export function logSkip(r: ReadResult, message: string): void {
  process.stderr.write(`skip  ${r.origin}: ${message}\n`);
}

const defaultInput = (r: ReadResult): StoreInput => ({ text: r.text, title: r.title, origin: r.origin, mimeType: r.mimeType, metadata: r.metadata });

/**
 * Ingests each item on its own: an item that throws (an unreadable file, an empty PDF) is logged and skipped,
 * and the rest still run. Stage failures inside the pipeline are not thrown; they stay on the job for retry.
 */
export async function ingestAll(
  ctx: Ctx,
  results: ReadResult[],
  opts: IngestAllOptions = {},
  log: IngestLog = { done: () => {}, skip: logSkip },
): Promise<{ ok: { origin: string; result: IngestOutcome }[]; failed: { origin: string; error: string }[] }> {
  const toInput = opts.toInput ?? defaultInput;
  const ok: { origin: string; result: IngestOutcome }[] = [];
  const failed: { origin: string; error: string }[] = [];
  for (const r of results) {
    let result: IngestOutcome;
    try {
      result = await ingest(ctx, toInput(r), { until: opts.until });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ origin: r.origin, error: message });
      log.skip(r, message);
      continue;
    }
    ok.push({ origin: r.origin, result });
    log.done(r, result);
  }
  return { ok, failed };
}
