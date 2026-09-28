import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { storeDocument } from "../../src/ingest/store.js";
import { runChunk } from "../../src/ingest/stages/chunk.js";
import { runSummarize, SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const fakeSummary = {
  title: "Acme hiring plan",
  summary_line: "A note on Acme Corp hiring twelve engineers in Austin in 2027.",
  summary: "Acme Corp plans to hire twelve engineers in Austin during 2027. The note lists roles and a timeline.",
  occurred_at: "2027-03-01",
};

describe("runSummarize", () => {
  it("fills summary, one-line summary, missing title and occurred_at", async () => {
    const ctx = fakeCtx(sql, () => fakeSummary);
    const { id } = await storeDocument(sql, { text: "Acme Corp will hire twelve engineers in Austin in 2027.", sourceKind: "note" });
    await runChunk(ctx, id);
    await runSummarize(ctx, id);
    const [doc] = await sql<{ title: string; summary: string; summary_line: string; occurred_at: Date }[]>`
      select title, summary, summary_line, occurred_at from brain.documents where id = ${id}`;
    expect(doc.title).toBe("Acme hiring plan");
    expect(doc.summary_line).toBe(fakeSummary.summary_line);
    expect(doc.occurred_at.toISOString().slice(0, 10)).toBe("2027-03-01");
    expect(ctx.llm.calls[0].system).toBe(SUMMARY_SYSTEM);
    expect(ctx.llm.calls[0].user).toContain("Source kind: note");
  });

  it("keeps a title and occurred_at that were given at store time", async () => {
    const ctx = fakeCtx(sql, () => fakeSummary);
    const { id } = await storeDocument(sql, { text: "some text", title: "Given", occurredAt: new Date("2020-05-05") });
    await runChunk(ctx, id);
    await runSummarize(ctx, id);
    const [doc] = await sql<{ title: string; occurred_at: Date }[]>`select title, occurred_at from brain.documents where id = ${id}`;
    expect(doc.title).toBe("Given");
    expect(doc.occurred_at.toISOString().slice(0, 10)).toBe("2020-05-05");
  });

  it("summarizes very long documents per section then combines", async () => {
    const ctx = fakeCtx(sql, () => fakeSummary);
    const long = Array.from({ length: 300 }, (_, i) => `# Part ${i}\n\n${"Words words words. ".repeat(60)}`).join("\n\n");
    expect(long.length).toBeGreaterThan(240_000);
    const { id } = await storeDocument(sql, { text: long });
    await runChunk(ctx, id);
    await runSummarize(ctx, id);
    expect(ctx.llm.calls.length).toBeGreaterThan(2); // per-section calls plus one combine call
    expect(ctx.llm.calls.at(-1)!.user).toContain("consecutive sections");
  });
});
