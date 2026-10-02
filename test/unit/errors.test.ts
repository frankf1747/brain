import { describe, it, expect } from "vitest";
import { spendCapAdvice } from "../../src/ingest/pipeline.js";
import { z } from "zod";
import { isSchemaFailure, isRefusal, SchemaFailure, ModelRefusal, SpendCapError, isSpendCap, SPEND_CAP_PREFIX } from "../../src/llm/errors.js";

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

describe("typed LLM errors", () => {
  it("classifies SchemaFailure and ModelRefusal by type", () => {
    expect(isSchemaFailure(new SchemaFailure("anything"))).toBe(true);
    expect(isRefusal(new SchemaFailure("anything"))).toBe(false);
    expect(isRefusal(new ModelRefusal("anything"))).toBe(true);
    expect(isSchemaFailure(new ModelRefusal("anything"))).toBe(false);
    expect(isRefusal(new Error("Model refused: x"))).toBe(true);
    expect(isRefusal(new Error("network down"))).toBe(false);
  });
});

describe("SpendCapError", () => {
  it("is recognized by type and by name, and carries the numbers", () => {
    const e = new SpendCapError("Voyage daily token cap reached: x", { used: 10, estimated: 5, cap: 12 });
    expect(isSpendCap(e)).toBe(true);
    expect(e.name).toBe("SpendCapError");
    expect([e.used, e.estimated, e.cap]).toEqual([10, 5, 12]);
    // An error that crossed a boundary that loses the class (a worker, a re-thrown copy) is still recognized.
    expect(isSpendCap(Object.assign(new Error("m"), { name: "SpendCapError" }))).toBe(true);
    expect(isSpendCap(new Error("Voyage /embeddings returned 429: rate limited"))).toBe(false);
    expect(isSpendCap("SpendCapError")).toBe(false);
    expect(isSpendCap(null)).toBe(false);
  });

  it("names the prefix pipeline jobs record", () => {
    expect(SPEND_CAP_PREFIX).toBe("spend_cap: ");
  });
});

describe("spendCapAdvice", () => {
  it("keeps the real base's text and names the eval's own variable on brain_eval", () => {
    expect(spendCapAdvice()).toBe(
      "Voyage daily cap reached: documents stopped before the stages that call Voyage (embedding, resolving). " +
        "`brain retry` finishes them after 00:00 UTC, or now if BRAIN_VOYAGE_DAILY_TOKEN_CAP is raised; `brain usage` shows today's spend.",
    );
    expect(spendCapAdvice("BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP")).toContain("or now if BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP is raised");
  });
});
