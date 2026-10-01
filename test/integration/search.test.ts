import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";
import { FakeReranker, type RerankHit } from "../../src/llm/voyage.js";
import { reciprocalRankFusion } from "../../src/retrieve/fuse.js";
import { toVector } from "../../src/db.js";
import { config } from "../../src/config.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const extraction = {
  entities: [{ key: "z", type: "organization", name: "Zorblax Industries", aliases: ["Zorblax"], untyped_hint: null, quote: "Zorblax Industries" },
             { key: "a", type: "place", name: "Austin", aliases: [], untyped_hint: null, quote: "Austin" }],
  relations: [{ from_key: "z", to_key: "a", type: "located_in", confidence: 0.9, valid_from: null, valid_to: null, quote: "Zorblax Industries in Austin" }],
  facts_about_self: [{ predicate: "visa_status", object_text: "F-1 OPT", object_key: null, confidence: 0.9, valid_from: null, valid_to: null, quote: "I am on F-1 OPT" }],
};
const longExtraction = {
  entities: [{ key: "c", type: "project", name: "Clinical Trial Risk Intelligence Platform", aliases: [], untyped_hint: null, quote: "Clinical Trial Risk Intelligence Platform" }],
  relations: [], facts_about_self: [],
};
const handler = ({ system, user }: { system: string; user: string }) =>
  system === SUMMARY_SYSTEM
    ? { title: "Untitled", summary_line: "A note.", summary: user.slice(0, 80), occurred_at: null }
    : user.includes("Clinical Trial Risk") ? longExtraction : user.includes("Zorblax") ? extraction : { entities: [], relations: [], facts_about_self: [] };

/** Makes every reranked hit weak, so the fallback scan runs even when keyword search found the document. */
function weakRerank<T extends { reranker: unknown }>(ctx: T): T {
  ctx.reranker = { rerank: async (_q: string, docs: string[], k: number) => docs.slice(0, k).map((_d, index) => ({ index, score: 0.01 })) };
  return ctx;
}

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
    // visa_status shares no term with the query and has no object node, so it is not returned here.
    expect(res.facts).toEqual([]);
    expect(res.usedFallback).toBe(false);
    const [log] = await sql<{ query: string; used_fallback: boolean; node_ids: string[] }[]>`select query, used_fallback, node_ids from brain.retrieval_log`;
    expect(log.query).toContain("Zorblax");
    expect(log.node_ids.length).toBe(1);
    const visa = await search(ctx, "visa status");
    expect(visa.facts.map((f) => f.predicate)).toContain("visa_status");
  });

  it("applies the source_kind filter inside retrieval", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Zorblax Industries", { sourceKinds: ["note"], includeFacts: false });
    expect(res.passages.filter((p) => p.group === "hybrid").every((p) => p.sourceKind === "note")).toBe(true);
    expect(res.facts).toEqual([]);
  });

  it("keyword side matches a question that shares only some terms with the passage", async () => {
    const ctx = await seed();
    ctx.embedder = { embed: async () => { throw new Error("no vectors in this test"); } } as unknown as typeof ctx.embedder;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // "Texas" and "year" appear nowhere; the old AND query returned nothing.
      const res = await search(ctx, "What did Zorblax release in Texas this year?");
      // Hybrid group only: entity detection also brings the passage in as a graph passage.
      expect(res.passages.some((p) => p.group === "hybrid" && p.content.includes("ZX-9000"))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it("falls back to a raw substring scan when nothing ranks well", async () => {
    const ctx = await seed();
    const res = await search(ctx, "X-90");
    expect(res.usedFallback).toBe(true);
    const fb = res.passages.find((p) => p.group === "fallback")!;
    expect(fb.documentTitle).toBe("Zorblax news");
    expect(fb.content).toContain("ZX-9000");
  });

  it("does not scan for a plain natural-language question even when nothing ranks well", async () => {
    const ctx = await seed();
    ctx.reranker = { rerank: async (_q, docs, k) => docs.slice(0, k).map((_d, index) => ({ index, score: 0.01 })) };
    const res = await search(ctx, "tell me about gardening in winter");
    expect(res.usedFallback).toBe(false);
    expect(res.passages.filter((p) => p.group === "fallback")).toEqual([]);
  });

  it("treats LIKE metacharacters inside a trigger term literally", async () => {
    const ctx = await seed();
    for (const q of ["100%", "a_b-1", "100%_1", "a\\b-1"]) {
      const res = await search(ctx, q);
      expect(res.passages.filter((p) => p.group === "fallback")).toEqual([]);
    }
    // Near-misses that an unescaped pattern would match: "%" spans anything, "_" matches one character.
    await ingest(ctx, { text: "Revenue grew 1000 points; the code axb-1 shipped.", sourceKind: "note", title: "Near miss" });
    await ingest(ctx, { text: "Path ab-1 and axb-1 differ.", sourceKind: "note", title: "Slash" });
    await ingest(ctx, { text: "Revenue grew 100% and the code a_b-1 shipped. Path a\\b-1 too.", sourceKind: "note", title: "Exact" });
    weakRerank(ctx);
    for (const q of ["100%", "a_b-1", "a\\b-1"]) {
      const res = await search(ctx, q);
      expect(res.passages.filter((p) => p.group === "fallback").map((p) => p.documentTitle)).toEqual(["Exact"]);
    }
  });

  it("ranks fallback hits by how many trigger terms they contain", async () => {
    const ctx = weakRerank(fakeCtx(sql, handler));
    await ingest(ctx, { text: "Order X-90 and ZX-9000 together.", sourceKind: "note", title: "Both" });
    await ingest(ctx, { text: "Only the X-90 here.", sourceKind: "note", title: "One" });
    const res = await search(ctx, "X-90 ZX-9000");
    const fb = res.passages.filter((p) => p.group === "fallback");
    expect(fb.map((p) => p.documentTitle)).toEqual(["Both", "One"]);
  });

  it("returns one fallback passage per document, matches case-insensitively, and windows at document edges", async () => {
    const ctx = weakRerank(fakeCtx(sql, handler));
    const long = "x".repeat(500);
    await ingest(ctx, { text: `ZX-90 ${long} zx-90 ${long} Zx-90 end`, sourceKind: "note", title: "Repeats" });
    await ingest(ctx, { text: `${long} the code Q-77 closes`, sourceKind: "note", title: "Tail" });
    const rep = await search(ctx, "zx-90");
    const fbRep = rep.passages.filter((p) => p.group === "fallback");
    expect(fbRep).toHaveLength(1);
    expect(fbRep[0].charStart).toBe(0);
    expect(fbRep[0].content.startsWith("ZX-90")).toBe(true);
    const tail = await search(ctx, "q-77");
    const fbTail = tail.passages.filter((p) => p.group === "fallback");
    expect(fbTail).toHaveLength(1);
    expect(fbTail[0].content.endsWith("closes")).toBe(true);
    expect(fbTail[0].charEnd - fbTail[0].charStart).toBeLessThan(500);
  });

  it("applies source_kind and since/until to fallback hits", async () => {
    const ctx = weakRerank(fakeCtx(sql, handler));
    await ingest(ctx, { text: "Old build K-42 passed.", sourceKind: "news", title: "Old", occurredAt: new Date("2020-01-01T00:00:00Z") });
    await ingest(ctx, { text: "New build K-42 passed.", sourceKind: "note", title: "New", occurredAt: new Date("2026-01-01T00:00:00Z") });
    const titles = async (o = {}) => (await search(ctx, "K-42", o)).passages.filter((p) => p.group === "fallback").map((p) => p.documentTitle).sort();
    expect(await titles()).toEqual(["New", "Old"]);
    expect(await titles({ since: new Date("2025-01-01T00:00:00Z") })).toEqual(["New"]);
    expect(await titles({ until: new Date("2021-01-01T00:00:00Z") })).toEqual(["Old"]);
    expect(await titles({ sourceKinds: ["news"] })).toEqual(["Old"]);
  });

  it("applies since/until to graph and fallback passages too", async () => {
    const ctx = fakeCtx(sql, handler);
    const old = await ingest(ctx, { text: "Zorblax Industries in Austin opened a lab in 2020.", sourceKind: "news", title: "Old Zorblax", occurredAt: new Date("2020-01-01T00:00:00Z") });
    await ingest(ctx, { text: "Gardening notes: tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
    const unfiltered = await search(ctx, "Zorblax Industries");
    expect(unfiltered.passages.some((p) => p.documentId === old.documentId)).toBe(true);
    // With since, hybrid search drops the old document; the graph (mentions) and fallback (substring) layers must too.
    const res = await search(ctx, "Zorblax Industries", { since: new Date("2025-01-01T00:00:00Z") });
    expect(res.passages.filter((p) => p.documentId === old.documentId).map((p) => p.group)).toEqual([]);
    expect(res.entities.map((e) => e.name)).toContain("Zorblax Industries");
  });

  it("reranks with the chunk's context prefix but returns bare chunk text", async () => {
    const ctx = await seed();
    const seen: string[] = [];
    const inner = new FakeReranker();
    ctx.reranker = {
      rerank: async (q: string, docs: string[], k: number): Promise<RerankHit[]> => {
        seen.push(...docs);
        return inner.rerank(q, docs, k);
      },
    };
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(seen.some((d) => d.startsWith("Zorblax news\nA note.\n\n") && d.includes("ZX-9000"))).toBe(true);
    const hit = res.passages.find((p) => p.group === "hybrid" && p.content.includes("ZX-9000"))!;
    expect(hit.content.startsWith("Zorblax news")).toBe(false);
  });

  it("falls back to keyword-only search when the query embedding fails", async () => {
    const ctx = await seed();
    ctx.embedder = { embed: async () => { throw new Error("voyage 503"); } } as unknown as typeof ctx.embedder;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await search(ctx, "What did Zorblax Industries release?");
      expect(res.degraded).toBe(true);
      expect(res.passages.some((p) => p.content.includes("ZX-9000"))).toBe(true);
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("brain: query embedding failed, keyword search only: voyage 503");
    } finally {
      err.mockRestore();
    }
    const [log] = await sql<{ layers: string[] }[]>`select layers from brain.retrieval_log`;
    expect(log.layers).toContain("degraded");
  });

  it("does not call the reranker after the query embedding failed", async () => {
    const ctx = await seed();
    ctx.embedder = { embed: async () => { throw new Error("voyage 429"); } } as unknown as typeof ctx.embedder;
    const rerankCalls: string[] = [];
    ctx.reranker = { rerank: async (q: string) => { rerankCalls.push(q); return []; } };
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await search(ctx, "Zorblax Industries drill");
      expect(res.degraded).toBe(true);
      expect(rerankCalls).toEqual([]);
      const hybrid = res.passages.filter((p) => p.group === "hybrid");
      expect(hybrid.length).toBeGreaterThan(0);
      expect(hybrid[0].content).toContain("ZX-9000");
    } finally {
      err.mockRestore();
    }
  });

  it("uses the query-time embedder and reranker when the context has them", async () => {
    const ctx = await seed();
    const used: string[] = [];
    const real = ctx.embedder;
    ctx.queryEmbedder = { embed: async (texts, type) => { used.push("embed"); return real.embed(texts, type); } };
    ctx.queryReranker = { rerank: async (q, docs, k) => { used.push("rerank"); return new FakeReranker().rerank(q, docs, k); } };
    ctx.embedder = { embed: async () => { throw new Error("ingest embedder must not be used"); } } as unknown as typeof ctx.embedder;
    ctx.reranker = { rerank: async () => { throw new Error("ingest reranker must not be used"); } };
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res.degraded).toBe(false);
    expect(used).toEqual(["embed", "rerank"]);
  });

  it("keeps fused order with RRF scores when the reranker fails", async () => {
    const ctx = await seed();
    ctx.reranker = { rerank: async () => { throw new Error("rerank down"); } };
    const [qv] = await ctx.embedder.embed(["Zorblax Industries drill"], "query");
    const cands = await sql<{ chunk_id: string; vector_rank: number | null; keyword_rank: number | null }[]>`
      select chunk_id, vector_rank, keyword_rank from brain.hybrid_search(${"Zorblax Industries drill"}, ${toVector(qv)}::vector, ${config.retrieval.candidateK}, null::text[], null, null)`;
    const fused = reciprocalRankFusion(cands.map((c) => ({ id: c.chunk_id, vectorRank: c.vector_rank, keywordRank: c.keyword_rank })));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await search(ctx, "Zorblax Industries drill");
      expect(res.degraded).toBe(true);
      const hybrid = res.passages.filter((p) => p.group === "hybrid");
      expect(hybrid.length).toBeGreaterThan(0);
      expect(hybrid.map((p) => p.chunkId)).toEqual(fused.slice(0, hybrid.length).map((f) => f.id));
      expect(hybrid.map((p) => p.score)).toEqual(fused.slice(0, hybrid.length).map((f) => f.fused));
    } finally {
      err.mockRestore();
    }
  });

  it("is not degraded when embedding and reranking succeed", async () => {
    const ctx = await seed();
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res.degraded).toBe(false);
  });

  it("detects an entity from a lowercase query and expands its neighbours", async () => {
    const ctx = await seed();
    const res = await search(ctx, "what did zorblax industries release?");
    expect(res.entities.map((e) => e.name)).toEqual(["Zorblax Industries"]);
    expect(res.entities[0].matchedSpan).toBe("zorblax industries");
    expect(res.entities[0].neighbors.map((n) => n.name)).toContain("Austin");
  });
  it("detects an entity by a one-word alias in a lowercase query", async () => {
    const ctx = await seed();
    const res = await search(ctx, "tell me about zorblax");
    expect(res.entities.map((e) => e.name)).toEqual(["Zorblax Industries"]);
    expect(res.entities[0].matchedSpan).toBe("zorblax");
  });
  it("detects a five-token node name from a lowercase query", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "I built the Clinical Trial Risk Intelligence Platform last year.", sourceKind: "note", title: "CTRIP" });
    const res = await search(ctx, "tell me about the clinical trial risk intelligence platform");
    expect(res.entities.map((e) => e.name)).toEqual(["Clinical Trial Risk Intelligence Platform"]);
    expect(res.entities[0].matchedSpan).toBe("clinical trial risk intelligence platform");
  });
  it("caps neighbours and graph passages per entity and orders graph passages by document date", async () => {
    const ctx = fakeCtx(sql, ({ system, user }) => {
      if (system === SUMMARY_SYSTEM) return { title: "Untitled", summary_line: "A note.", summary: user.slice(0, 80), occurred_at: null };
      const m = /Zorblax mention (\d+)/.exec(user);
      return m
        ? { entities: [{ key: "z", type: "organization", name: "Zorblax Industries", aliases: [], untyped_hint: null, quote: "Zorblax" },
                        { key: "p", type: "place", name: `Place ${m[1]}`, aliases: [], untyped_hint: null, quote: `Place ${m[1]}` }],
            relations: [{ from_key: "z", to_key: "p", type: "located_in", confidence: Number(m[1]) / 100, valid_from: null, valid_to: null, quote: "Zorblax" }],
            facts_about_self: [] }
        : { entities: [], relations: [], facts_about_self: [] };
    });
    for (let i = 1; i <= 25; i++) {
      await ingest(ctx, { text: `Zorblax mention ${i} in Place ${i}.`, sourceKind: "note", title: `M${i}`, occurredAt: new Date(Date.UTC(2026, 0, i)) });
    }
    // No hybrid passages, so none of the graph passages is dropped as a duplicate of a hybrid hit.
    ctx.reranker = { rerank: async () => [] };
    const res = await search(ctx, "Zorblax Industries", { includeFacts: false });
    const z = res.entities.find((e) => e.name === "Zorblax Industries")!;
    expect(z.neighbors.length).toBe(config.graph.maxNeighbors);
    expect(z.neighbors[0].name).toBe("Place 25"); // highest edge confidence first
    const graph = res.passages.filter((p) => p.group === "graph");
    expect(graph.length).toBe(config.graph.maxPassagesPerEntity);
    expect(graph.map((p) => p.documentTitle)).toEqual(["M25", "M24", "M23", "M22", "M21"]); // newest documents first
  });

  it("maps a mention stored on a level-0 section to that section's first passage", async () => {
    const ctx = fakeCtx(sql, handler);
    const [doc] = await sql<{ id: string }[]>`
      insert into brain.documents (content_hash, title, raw_content, source_kind) values ('q', 'Quuxcorp memo', 'Quuxcorp memo.', 'note') returning id`;
    const [sec] = await sql<{ id: string }[]>`
      insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end)
      values (${doc.id}, 0, 0, 'Quuxcorp memo.', 3, 0, 14) returning id`;
    const [first] = await sql<{ id: string }[]>`
      insert into brain.chunks (document_id, parent_id, level, ordinal, content, token_count, char_start, char_end)
      values (${doc.id}, ${sec.id}, 1, 0, 'Quuxcorp', 1, 0, 8), (${doc.id}, ${sec.id}, 1, 1, 'memo.', 1, 9, 14) returning id`;
    const [node] = await sql<{ id: string }[]>`
      insert into brain.nodes (type, name, canonical_name) values ('organization', 'Quuxcorp', 'quuxcorp') returning id`;
    await sql`insert into brain.mentions (chunk_id, node_id) values (${sec.id}, ${node.id})`;
    ctx.reranker = { rerank: async () => [] };
    const res = await search(ctx, "Quuxcorp", { includeFacts: false });
    expect(res.passages.filter((p) => p.group === "graph").map((p) => p.chunkId)).toEqual([first.id]);
  });

  it("returns only facts that overlap the query or its detected entities, capped", async () => {
    const ctx = fakeCtx(sql, ({ system }) =>
      system === SUMMARY_SYSTEM
        ? { title: "Me", summary_line: "About me.", summary: "About me.", occurred_at: null }
        : { entities: [], relations: [],
            facts_about_self: Array.from({ length: 15 }, (_, i) => ({ predicate: i === 0 ? "lives_in" : `skill_${i}`, object_text: i === 0 ? "Austin" : `thing ${i}`, object_key: null, confidence: 0.9, valid_from: null, valid_to: null, quote: "I" })) });
    await ingest(ctx, { text: "I live in Austin. I know many things.", sourceKind: "note", title: "Me" });
    const res = await search(ctx, "where do I live");
    expect(res.facts.map((f) => f.predicate)).toEqual(["lives_in"]);
    const all = await search(ctx, "skill");
    expect(all.facts.length).toBeLessThanOrEqual(config.graph.maxFacts);
  });

  it("rejects an empty query", async () => {
    const ctx = fakeCtx(sql, handler);
    await expect(search(ctx, "   ")).rejects.toThrow("Search query is empty");
  });
});
