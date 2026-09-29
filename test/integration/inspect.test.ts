import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { getDocument } from "../../src/retrieve/documents.js";
import { describeNode, findNode } from "../../src/graph/inspect.js";
import { orient } from "../../src/retrieve/orient.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: "2026-09-01" } : fakeExtraction;

describe("getDocument", () => {
  it("returns metadata and a raw slice, or null for unknown ids", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: "0123456789".repeat(5), sourceKind: "note" });
    const d = (await getDocument(sql, id, 10, 5))!;
    expect(d.text).toBe("01234");
    expect(d.totalLength).toBe(50);
    expect(d.sourceKind).toBe("note");
    expect(await getDocument(sql, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await getDocument(sql, "not-a-uuid")).toBeNull();
  });
});

describe("describeNode", () => {
  it("finds by name, alias or id and reports edges with evidence, facts and mentions", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT." });
    const byAlias = (await findNode(sql, "acme"))!;
    const report = (await describeNode(sql, byAlias.id))!;
    expect(report.name).toBe("Acme Corp");
    expect(report.edges).toEqual([expect.objectContaining({ direction: "in", type: "applied_to", otherName: "Frank Fu" })]);
    expect(report.edges[0].evidence).toContain("Acme Corp");
    expect(report.mentionedIn.length).toBe(1);
    const self = (await describeNode(sql, "Frank Fu"))!;
    expect(self.facts.map((f) => f.predicate)).toEqual(["visa_status"]);
    expect(await describeNode(sql, "nobody here")).toBeNull();
  });
});

describe("orient", () => {
  it("summarizes what the base holds", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "I applied to Acme Corp.", sourceKind: "note" });
    await ingest(ctx, { text: "Acme raised money.", sourceKind: "news" });
    const o = await orient(ctx);
    expect(o.totalDocuments).toBe(2);
    expect(o.documentsByKind).toEqual(expect.arrayContaining([{ kind: "news", count: 1 }, { kind: "note", count: 1 }]));
    expect(o.nodesByType.find((n) => n.type === "organization")?.count).toBe(1);
    expect(o.recent[0].title).toBe("Acme note");
    expect(o.facts.length).toBe(1); // same fact from two evidence chunks, collapsed by predicate and value
    expect(o.pipeline.find((p) => p.stage === "done")?.count).toBe(2);
  });
});
