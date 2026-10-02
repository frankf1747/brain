import { ZodError } from "zod";

/** The model's output was truncated, was not JSON, or did not match the schema. Worth one retry, then a fallback. */
export class SchemaFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaFailure";
  }
}

/** The model declined to answer. Retrying the same prompt will not help. */
export class ModelRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRefusal";
  }
}

/** True when the model's output failed schema validation (worth one retry, then a fallback). */
export function isSchemaFailure(err: unknown): boolean {
  return (
    err instanceof SchemaFailure ||
    err instanceof ZodError ||
    // Fallback for untyped errors, such as the SDK's own structured-output parse error.
    (err instanceof Error && !(err instanceof ModelRefusal) && /did not match the schema|Failed to parse structured output/i.test(err.message))
  );
}

/** True when the model declined to answer. Retrying the same prompt will not help. */
export function isRefusal(err: unknown): boolean {
  return err instanceof ModelRefusal || (err instanceof Error && err.message.startsWith("Model refused"));
}

/**
 * A Voyage call was refused before it was sent: today's (UTC) counted tokens plus this call's estimate would pass
 * BRAIN_VOYAGE_DAILY_TOKEN_CAP. Retrying before 00:00 UTC (or before the cap is raised) cannot help.
 */
export class SpendCapError extends Error {
  readonly used: number;
  readonly estimated: number;
  readonly cap: number;
  constructor(message: string, detail: { used: number; estimated: number; cap: number }) {
    super(message);
    this.name = "SpendCapError";
    this.used = detail.used;
    this.estimated = detail.estimated;
    this.cap = detail.cap;
  }
}

/** True when a Voyage call was refused by the daily cap. */
export function isSpendCap(err: unknown): boolean {
  return err instanceof SpendCapError || (err instanceof Error && err.name === "SpendCapError");
}

/** Prefix of ingest_jobs.error when the cap stopped a document (src/ingest/pipeline.ts). */
export const SPEND_CAP_PREFIX = "spend_cap: ";
