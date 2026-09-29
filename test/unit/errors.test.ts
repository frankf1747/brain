import { describe, it, expect } from "vitest";
import { z } from "zod";
import { isSchemaFailure } from "../../src/llm/errors.js";

describe("isSchemaFailure", () => {
  it("recognizes ZodError and the schema-failure messages", () => {
    const zerr = z.object({ a: z.string() }).safeParse({}).error;
    expect(isSchemaFailure(zerr)).toBe(true);
    expect(isSchemaFailure(new Error("Model output did not match the schema"))).toBe(true);
    expect(isSchemaFailure(new Error("Model output did not match the schema: not JSON"))).toBe(true);
    expect(isSchemaFailure(new Error("Failed to parse structured output"))).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isSchemaFailure(new Error("network down"))).toBe(false);
    expect(isSchemaFailure(new Error("Model refused: x"))).toBe(false);
    expect(isSchemaFailure(new Error("schema registry offline"))).toBe(false);
    expect(isSchemaFailure("did not match the schema")).toBe(false);
    expect(isSchemaFailure(null)).toBe(false);
  });
});
