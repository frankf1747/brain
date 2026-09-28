import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { storeDocument } from "../../src/ingest/store.js";
import { runChunk } from "../../src/ingest/stages/chunk.js";
import { runEmbed, contextPrefix } from "../../src/ingest/stages/embed.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("contextPrefix", () => {
  it("joins the present parts and skips blanks", () => {
    expect(contextPrefix("T", "L", ["A", "B"])).toBe("T\nL\nA > B");
    expect(contextPrefix(null, " ", [])).toBe("");
  });
});

describe("runEmbed", () => {
  it("embeds passages with their prefix and the document summary", async () => {
    const ctx = fakeCtx(sql);
    const { id } = await storeDocument(sql, { text: "# Head\n\nBody sentence one. Body sentence two.", title: "Doc" });
    await runChunk(ctx, id);
    await sql`update brain.documents set summary = 'A summary.', summary_line = 'One line.' where id = ${id}`;
    await runEmbed(ctx, id);

    const passages = await sql<{ embedding: string | null; context_prefix: string }[]>`
      select embedding::text as embedding, context_prefix from brain.chunks where document_id = ${id} and level = 1`;
    expect(passages.length).toBeGreaterThan(0);
    for (const p of passages) {
      expect(p.embedding).not.toBeNull();
      expect(p.context_prefix).toBe("Doc\nOne line.\nHead");
    }
    const [doc] = await sql<{ e: string | null }[]>`select summary_embedding::text as e from brain.documents where id = ${id}`;
    expect(doc.e).not.toBeNull();
    expect(ctx.embedder.calls[0][0].startsWith("Doc\nOne line.\nHead\n\n")).toBe(true);
  });
});
