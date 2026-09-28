import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const extraction = {
  entities: [{ key: "z", type: "organization", name: "Zorblax Industries", aliases: ["Zorblax"], untyped_hint: null, quote: "Zorblax Industries" },
             { key: "a", type: "place", name: "Austin", aliases: [], untyped_hint: null, quote: "Austin" }],
  relations: [{ from_key: "z", to_key: "a", type: "located_in", confidence: 0.9, valid_from: null, valid_to: null, quote: "Zorblax Industries in Austin" }],
  facts_about_self: [{ predicate: "visa_status", object_text: "F-1 OPT", object_key: null, confidence: 0.9, valid_from: null, valid_to: null, quote: "I am on F-1 OPT" }],
};
const handler = ({ system, user }: { system: string; user: string }) =>
  system === SUMMARY_SYSTEM
    ? { title: "Untitled", summary_line: "A note.", summary: user.slice(0, 80), occurred_at: null }
    : user.includes("Zorblax") ? extraction : { entities: [], relations: [], facts_about_self: [] };

async function seed() {
  const ctx = fakeCtx(sql, handler);
  await ingest(ctx, { text: "Zorblax Industries in Austin released the ZX-9000 drill. I am on F-1 OPT.", sourceKind: "news", title: "Zorblax news" });
  await ingest(ctx, { text: "Gardening notes: tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
  await ingest(ctx, { text: "Interview prep: practice SQL window functions and case studies.", sourceKind: "conversation", title: "Prep" });
  return ctx;
}

describe("search", () => {
  it("finds a keyword hit, resolves the entity with its neighbors, and loads facts", async () => {
    const ctx = await seed();
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res.passages.some((p) => p.content.includes("ZX-9000"))).toBe(true);
    expect(res.passages[0].documentTitle).toBe("Zorblax news");
    expect(res.entities.map((e) => e.name)).toContain("Zorblax Industries");
    expect(res.entities[0].neighbors.map((n) => n.name)).toContain("Austin");
    expect(res.facts.map((f) => f.predicate)).toContain("visa_status");
    expect(res.usedFallback).toBe(false);
    const [log] = await sql<{ query: string; used_fallback: boolean; node_ids: string[] }[]>`select query, used_fallback, node_ids from brain.retrieval_log`;
    expect(log.query).toContain("Zorblax");
    expect(log.node_ids.length).toBe(1);
  });

  it("applies the source_kind filter inside retrieval", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Zorblax Industries", { sourceKinds: ["note"], includeFacts: false });
    expect(res.passages.filter((p) => p.group === "hybrid").every((p) => p.sourceKind === "note")).toBe(true);
    expect(res.facts).toEqual([]);
  });

  it("falls back to a raw substring scan when nothing ranks well", async () => {
    const ctx = await seed();
    const res = await search(ctx, "X-90");
    expect(res.usedFallback).toBe(true);
    const fb = res.passages.find((p) => p.group === "fallback")!;
    expect(fb.documentTitle).toBe("Zorblax news");
    expect(fb.content).toContain("ZX-9000");
  });

  it("treats LIKE metacharacters in the query literally in the fallback scan", async () => {
    const ctx = await seed();
    // No seeded document contains a literal "%" or "_"; unescaped, "%" would match every document.
    for (const q of ["%", "_"]) {
      const res = await search(ctx, q);
      expect(res.passages.filter((p) => p.group === "fallback")).toEqual([]);
      expect(res.usedFallback).toBe(false);
    }
  });
});
