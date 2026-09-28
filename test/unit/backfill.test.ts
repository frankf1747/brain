import { describe, it, expect } from "vitest";
import { z } from "zod";
import { makeCustomId, parseCustomId, parseBatchText } from "../../src/ingest/backfill.js";

describe("backfill helpers", () => {
  it("round-trips custom ids", () => {
    const id = makeCustomId("extracted", "doc-1", "sec-9");
    expect(parseCustomId(id)).toEqual({ stage: "extracted", documentId: "doc-1", sectionChunkId: "sec-9" });
    expect(parseCustomId(makeCustomId("summarized", "doc-2", null))).toEqual({ stage: "summarized", documentId: "doc-2", sectionChunkId: null });
  });
  it("parses and validates batch text output", () => {
    const schema = z.object({ a: z.number() });
    expect(parseBatchText(schema, '{"a": 1}')).toEqual({ a: 1 });
    expect(parseBatchText(schema, "not json")).toBeNull();
    expect(parseBatchText(schema, '{"a": "x"}')).toBeNull();
  });
});
