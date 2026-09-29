import { describe, it, expect } from "vitest";
import { z } from "zod";
import { batchCustomId, parseBatchText } from "../../src/ingest/backfill.js";

describe("backfill helpers", () => {
  it("makes short custom ids that the Batches API accepts", () => {
    const pattern = /^[a-zA-Z0-9_-]{1,64}$/;
    const ids = [0, 1, 99_999].map(batchCustomId);
    for (const id of ids) expect(id).toMatch(pattern);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("parses and validates batch text output", () => {
    const schema = z.object({ a: z.number() });
    expect(parseBatchText(schema, '{"a": 1}')).toEqual({ a: 1 });
    expect(parseBatchText(schema, "not json")).toBeNull();
    expect(parseBatchText(schema, '{"a": "x"}')).toBeNull();
  });
});
