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

describe("runSummarize fallback", () => {
  const noteText = "# Offer call\n\nThey raised the base to 180k and moved the start date to March.\nWe also talked about relocation.";
  const squashed = noteText.replace(/\s+/g, " ").trim().slice(0, 200);

  async function docAfterPipeline(handler: (args: { system: string; user: string }) => unknown) {
    const { ingest } = await import("../../src/ingest/pipeline.js");
    const ctx = fakeCtx(sql, handler);
    const res = await ingest(ctx, { text: noteText, sourceKind: "note" });
    const [doc] = await sql<{ title: string | null; summary: string | null; summary_line: string | null; metadata: { summary?: string } }[]>`
      select title, summary, summary_line, metadata from brain.documents where id = ${res.id}`;
    return { res, doc, ctx };
  }

  it("writes a text-prefix stub after two schema failures and the document reaches done", async () => {
    const { res, doc, ctx } = await docAfterPipeline(() => ({ garbage: true }));
    expect(res.stage).toBe("done");
    expect(res.error).toBeNull();
    expect(ctx.llm.calls.filter((c) => c.system === SUMMARY_SYSTEM).length).toBe(2);
    expect(doc.metadata.summary).toBe("skipped");
    expect(doc.summary_line).toBe(squashed);
    expect(doc.summary).toBeNull();
    expect(doc.title).toBe("Offer call"); // first heading, since none was given
  });

  it("writes the stub when the model refuses, without retrying", async () => {
    const { fakeExtraction } = await import("./fixtures.js");
    const { res, doc, ctx } = await docAfterPipeline(({ system }) => {
      if (system === SUMMARY_SYSTEM) throw new Error("Model refused: x");
      return fakeExtraction;
    });
    expect(res.stage).toBe("done");
    expect(ctx.llm.calls.filter((c) => c.system === SUMMARY_SYSTEM).length).toBe(1);
    expect(doc.metadata.summary).toBe("skipped");
    expect(doc.summary_line).toBe(squashed);
  });

  it("keeps a given title and falls back to the first 80 characters when there is no heading", async () => {
    const ctx = fakeCtx(sql, () => ({ garbage: true }));
    const plain = "x".repeat(50) + "\n" + "y".repeat(100);
    const given = await storeDocument(sql, { text: plain, title: "Given" });
    const none = await storeDocument(sql, { text: plain + " z" });
    for (const id of [given.id, none.id]) {
      await runChunk(ctx, id);
      await runSummarize(ctx, id);
    }
    const [g] = await sql<{ title: string }[]>`select title from brain.documents where id = ${given.id}`;
    const [n] = await sql<{ title: string }[]>`select title from brain.documents where id = ${none.id}`;
    expect(g.title).toBe("Given");
    expect(n.title).toBe(("x".repeat(50) + " " + "y".repeat(100)).slice(0, 80));
  });

  it("still throws other errors so the pipeline records a retryable failure at chunked", async () => {
    const { res } = await docAfterPipeline(() => { throw new Error("network down"); });
    expect(res.stage).toBe("chunked");
    expect(res.error).toBe("network down");
    const [job] = await sql<{ stage: string; error: string }[]>`select stage, error from brain.ingest_jobs where document_id = ${res.id}`;
    expect(job).toEqual({ stage: "chunked", error: "network down" });
  });
});
