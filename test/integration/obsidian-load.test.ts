import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { loadGraph } from "../../src/obsidian/load.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: "2026-09-01" } : fakeExtraction;

describe("loadGraph", () => {
  it("returns canonical nodes, resolved edges with evidence, mentions, facts and documents", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT.", sourceKind: "note" });
    const g = await loadGraph(sql);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["Acme Corp", "Frank Fu"]);
    expect(g.self?.name).toBe("Frank Fu");
    expect(g.edges).toEqual([expect.objectContaining({ type: "applied_to", evidenceDocumentId: id })]);
    expect(g.edges[0].evidence).toContain("Acme Corp");
    expect(g.mentions.some((m) => m.documentId === id)).toBe(true);
    expect(g.facts).toEqual([expect.objectContaining({ predicate: "visa_status", documentId: id, verifiedBy: "extractor:fake" })]);
    expect(g.documents[0]).toEqual(expect.objectContaining({ id, title: "Acme note", sourceKind: "note", author: "owner" }));
    expect(g.documents[0].raw).toContain("F-1 OPT");
  });

  it("uses the relation's own quote as evidence, not the start of the passage", async () => {
    const ctx = fakeCtx(sql, handler);
    const text = "Opening line about my week that has nothing to do with it. I applied to Acme Corp in September. I am on F-1 OPT.";
    await ingest(ctx, { text, sourceKind: "note" });
    const g = await loadGraph(sql);
    expect(g.edges[0].evidence).toBe("applied to Acme Corp");
  });

  it("falls back to the start of the evidence chunk when the edge has no stored quote", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT.", sourceKind: "note" });
    await sql`update brain.edges set properties = properties - 'quote'`;
    const g = await loadGraph(sql);
    expect(g.edges[0].evidence).toContain("I applied to Acme Corp in September");
  });

  it("excludes merged duplicates and points their edges at the canonical node", async () => {
    const [a] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name) values ('organization','Beta','beta') returning id`;
    const [dup] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name, merged_into) values ('organization','Beta Co','beta co', ${a.id}) returning id`;
    const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
    await sql`insert into brain.edges (from_node, to_node, type, evidence_chunk_id) values (${self.id}, ${dup.id}, 'works_at', null)`;
    const g = await loadGraph(sql);
    expect(g.nodes.find((n) => n.id === dup.id)).toBeUndefined();
    expect(g.edges[0].toNode).toBe(a.id);
  });

  it("collapses the same current fact extracted from two chunks into one entry", async () => {
    const [doc] = await sql<{ id: string }[]>`insert into brain.documents (content_hash, source_kind, raw_content) values ('dedupe-hash', 'note', 'x') returning id`;
    const [c1] = await sql<{ id: string }[]>`
      insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end) values (${doc.id}, 1, 0, 'a', 1, 0, 1) returning id`;
    const [c2] = await sql<{ id: string }[]>`
      insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end) values (${doc.id}, 1, 1, 'b', 1, 1, 2) returning id`;
    const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
    await sql`
      insert into brain.facts (subject_id, predicate, object_text, source_chunk_id) values
        (${self.id}, 'visa_status', 'F-1 OPT', ${c1.id}),
        (${self.id}, 'visa_status', 'f-1 opt', ${c2.id})`;
    const g = await loadGraph(sql);
    expect(g.facts.filter((f) => f.predicate === "visa_status")).toHaveLength(1);
  });
});
