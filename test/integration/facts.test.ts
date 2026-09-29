import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { addFact, supersedeFact, verifyFact, listFacts } from "../../src/graph/facts.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("facts", () => {
  it("adds an unverified fact labeled with the writer, and dedupes", async () => {
    const { id: a, predicate } = await addFact(sql, { predicate: "Lives In", objectText: "Los Angeles", by: "agent:test" });
    expect(predicate).toBe("lives_in");
    const { id: b } = await addFact(sql, { predicate: "lives_in", objectText: "Los Angeles", by: "agent:test" });
    expect(b).toBe(a);
    const [f] = await listFacts(sql, false);
    expect(f).toEqual(expect.objectContaining({ id: a, predicate: "lives_in", objectText: "Los Angeles", verified: false, verifiedBy: "agent:test" }));
  });

  it("supersedes: the old fact leaves the current view, history remains", async () => {
    const { id: a } = await addFact(sql, { predicate: "lives_in", objectText: "Austin", by: "frank" });
    const b = await supersedeFact(sql, a, { objectText: "Los Angeles", by: "agent:test", validFrom: new Date("2026-09-01") });
    const current = await listFacts(sql, false);
    expect(current.map((f) => f.id)).toEqual([b]);
    const all = await listFacts(sql, true);
    expect(all.find((f) => f.id === a)?.supersededBy).toBe(b);
    await expect(supersedeFact(sql, "00000000-0000-0000-0000-000000000000", { objectText: "x", by: "t" })).rejects.toThrow(/not found/);
  });

  it("verifies", async () => {
    const { id: a } = await addFact(sql, { predicate: "prefers", objectText: "hybrid work", by: "agent:test" });
    expect(await verifyFact(sql, a, "frank")).toBe(true);
    expect(await verifyFact(sql, "00000000-0000-0000-0000-000000000000", "frank")).toBe(false);
    const [f] = await listFacts(sql, false);
    expect(f.verified).toBe(true);
    expect(f.verifiedBy).toBe("frank");
  });

  it("collapses the same fact from different source chunks in the current view only", async () => {
    const [doc] = await sql<{ id: string }[]>`
      insert into brain.documents (content_hash, raw_content) values ('facts-test-hash', 'x') returning id`;
    const chunkIds: string[] = [];
    for (const ordinal of [0, 1]) {
      const [c] = await sql<{ id: string }[]>`
        insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end)
        values (${doc.id}, 0, ${ordinal}, 'c', 1, 0, 1) returning id`;
      chunkIds.push(c.id);
    }
    const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
    for (const chunk of chunkIds) {
      await sql`insert into brain.facts (subject_id, predicate, object_text, source_chunk_id, verified)
        values (${self.id}, 'visa_status', 'F-1 OPT', ${chunk}, false)`;
    }
    expect((await listFacts(sql, false)).length).toBe(1);
    expect((await listFacts(sql, true)).length).toBe(2);
  });

  it("superseding back to an earlier value revives that fact instead of making a cycle", async () => {
    const { id: a } = await addFact(sql, { predicate: "lives_in", objectText: "Austin", by: "frank" });
    const b = await supersedeFact(sql, a, { objectText: "Los Angeles", by: "agent:test" });
    const c = await supersedeFact(sql, b, { objectText: "Austin", by: "agent:test" });
    expect(c).toBe(a);
    const current = await listFacts(sql, false);
    expect(current.map((f) => f.objectText)).toEqual(["Austin"]);
    expect(current[0]).toEqual(expect.objectContaining({ id: a, supersededBy: null, validTo: null, verifiedBy: "agent:test" }));
    const all = await listFacts(sql, true);
    expect(all.map((f) => f.objectText).sort()).toEqual(["Austin", "Los Angeles"]);
    expect(all.find((f) => f.id === b)?.supersededBy).toBe(a);
  });

  it("refuses to supersede a fact with its own value and leaves it current", async () => {
    const { id: a } = await addFact(sql, { predicate: "lives_in", objectText: "Austin", by: "frank" });
    await expect(supersedeFact(sql, a, { objectText: " Austin ", by: "agent:test" })).rejects.toThrow(/New value equals the current value/);
    const current = await listFacts(sql, false);
    expect(current.map((f) => [f.id, f.supersededBy])).toEqual([[a, null]]);
  });

  it("rejects empty predicates and values", async () => {
    await expect(addFact(sql, { predicate: "!!!", objectText: "x", by: "t" })).rejects.toThrow(/predicate must contain letters or digits/);
    await expect(addFact(sql, { predicate: "住在", objectText: "x", by: "t" })).rejects.toThrow(/predicate must contain letters or digits/);
    await expect(addFact(sql, { predicate: "lives_in", objectText: "   ", by: "t" })).rejects.toThrow(/value must not be empty/);
    const { id: a } = await addFact(sql, { predicate: "lives_in", objectText: "Austin", by: "frank" });
    await expect(supersedeFact(sql, a, { objectText: "   ", by: "t" })).rejects.toThrow(/value must not be empty/);
    expect((await listFacts(sql, true)).length).toBe(1);
  });
});
