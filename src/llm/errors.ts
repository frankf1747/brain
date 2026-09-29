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
