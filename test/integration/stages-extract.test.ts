import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { storeDocument } from "../../src/ingest/store.js";
import { runChunk } from "../../src/ingest/stages/chunk.js";
import { runExtract } from "../../src/ingest/stages/extract.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const text = "I applied to Acme Corp in September. I am on F-1 OPT so sponsorship matters.";

describe("runExtract", () => {
  it("stores the extractor payload per section and tells the model the registries", async () => {
    const ctx = fakeCtx(sql, () => fakeExtraction);
    const { id } = await storeDocument(sql, { text, title: "Note" });
    await runChunk(ctx, id);
    await runExtract(ctx, id);
    const rows = await sql<{ payload: typeof fakeExtraction; section_chunk_id: string; model: string }[]>`
      select payload, section_chunk_id, model from brain.extractions where document_id = ${id}`;
    expect(rows.length).toBe(1);
    expect(rows[0].payload.entities.length).toBe(2);
    expect(rows[0].section_chunk_id).not.toBeNull();
    expect(rows[0].model).toBe("fake");
    expect(ctx.llm.calls[0].system).toContain("organization");
    expect(ctx.llm.calls[0].system).toContain("applied_to");
    expect(ctx.llm.calls[0].user).toContain("Acme Corp");
  });

  it("skips extraction after two schema failures but leaves the document intact", async () => {
    const ctx = fakeCtx(sql, () => ({ garbage: true }));
    const { id } = await storeDocument(sql, { text });
    await runChunk(ctx, id);
    await runExtract(ctx, id);
    expect(ctx.llm.calls.length).toBe(2);
    const [doc] = await sql<{ metadata: { extraction?: string } }[]>`select metadata from brain.documents where id = ${id}`;
    expect(doc.metadata.extraction).toBe("skipped");
    const extractions = await sql`select id from brain.extractions where document_id = ${id}`;
    expect(extractions.length).toBe(0);
  });

  it("rethrows non-schema errors so the pipeline records a retryable failure", async () => {
    const ctx = fakeCtx(sql, () => { throw new Error("network down"); });
    const { id } = await storeDocument(sql, { text });
    await runChunk(ctx, id);
    await expect(runExtract(ctx, id)).rejects.toThrow("network down");
  });
});

describe("runExtract with no sections", () => {
  it("does nothing for a document with zero sections", async () => {
    const ctx = fakeCtx(sql, () => fakeExtraction);
    const { id } = await storeDocument(sql, { text: "# Only a heading" });
    // no chunk rows: the zero-section case
    await expect(runExtract(ctx, id)).resolves.toBeUndefined();
    expect(ctx.llm.calls.length).toBe(0);
  });
});
