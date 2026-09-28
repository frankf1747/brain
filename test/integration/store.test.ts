import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { storeDocument } from "../../src/ingest/store.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("storeDocument", () => {
  it("stores raw text untouched and opens an ingest job", async () => {
    const text = "Line one\r\nLine two  \n";
    const { id, created } = await storeDocument(sql, { text, title: "T", sourceKind: "note", metadata: { a: 1 } });
    expect(created).toBe(true);
    const [doc] = await sql<{ raw_content: string; metadata: { a: number }; source_kind: string }[]>`
      select raw_content, metadata, source_kind from brain.documents where id = ${id}`;
    expect(doc.raw_content).toBe(text);
    expect(doc.metadata.a).toBe(1);
    expect(doc.source_kind).toBe("note");
    const [job] = await sql<{ stage: string }[]>`select stage from brain.ingest_jobs where document_id = ${id}`;
    expect(job.stage).toBe("stored");
  });

  it("is a no-op for identical content", async () => {
    const a = await storeDocument(sql, { text: "same", sourceKind: "paste" });
    const b = await storeDocument(sql, { text: "same", sourceKind: "news" });
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
    const [{ n }] = await sql<{ n: string }[]>`select count(*)::text as n from brain.documents`;
    expect(Number(n)).toBe(1);
  });

  it("refuses empty input", async () => {
    await expect(storeDocument(sql, { text: "   \n" })).rejects.toThrow(/empty/);
  });
});
