import { ZodError } from "zod";

/** True when the model's output failed schema validation (worth one retry, then a fallback). */
export function isSchemaFailure(err: unknown): boolean {
  return (
    err instanceof ZodError ||
    (err instanceof Error && /did not match the schema|Failed to parse structured output/i.test(err.message))
  );
}

/** True when the model declined to answer. Retrying the same prompt will not help. */
export function isRefusal(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Model refused");
}
