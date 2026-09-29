import { describe, it, expect } from "vitest";
import { z } from "zod";
import { FakeLlm } from "../../src/llm/llm.js";
import { SchemaFailure } from "../../src/llm/errors.js";

describe("FakeLlm", () => {
  it("validates handler output against the schema", async () => {
    const llm = new FakeLlm(() => ({ n: 1 }));
    expect(await llm.structured({ schema: z.object({ n: z.number() }), system: "s", user: "u" })).toEqual({ n: 1 });
    await expect(llm.structured({ schema: z.object({ n: z.string() }), system: "s", user: "u" })).rejects.toBeInstanceOf(SchemaFailure);
    expect(llm.calls.length).toBe(2);
  });
});
