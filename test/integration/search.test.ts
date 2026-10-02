import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { testDb, wipe, fakeCtx, meteredVoyage } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";
import { FakeReranker, estimateEmbedTokens, type RerankHit } from "../../src/llm/voyage.js";
import { renderSearch } from "../../src/mcp/render.js";
import { reciprocalRankFusion } from "../../src/retrieve/fuse.js";
import { isHybrid, factSource, SearchResultSchema, type LoggedPassage } from "../../src/retrieve/contract.js";
import { addFact, verifyFact } from "../../src/graph/facts.js";
import { factLine } from "../../src/mcp/render.js";
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
  // Owner-written so its first-person visa fact is kept: resolve drops facts about the owner from documents
  // the owner did not write, and news defaults to author other.
  await ingest(ctx, { text: "Zorblax Industries in Austin released the ZX-9000 drill. I am on F-1 OPT.", sourceKind: "news", title: "Zorblax news", author: "owner" });
  await ingest(ctx, { text: "Gardening notes: tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
  await ingest(ctx, { text: "Interview prep: practice SQL window functions and case studies.", sourceKind: "conversation", title: "Prep" });
  return ctx;
}

describe("search", () => {
  it("reports each passage's document author", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "Lonestar Capital closed a new fund for robotics startups.", sourceKind: "news", title: "Fund news" });
    await ingest(ctx, { text: "My tomatoes finally ripened this week.", sourceKind: "note", title: "Tomatoes" });
    const news = (await search(ctx, "Lonestar Capital robotics fund", { includeFacts: false })).passages.find((p) => p.title === "Fund news")!;
    expect(news.author).toBe("other");
    const note = (await search(ctx, "tomatoes ripened", { includeFacts: false })).passages.find((p) => p.title === "Tomatoes")!;
    expect(note.author).toBe("owner");
  });

  it("finds a keyword hit, resolves the entity with its neighbors, and loads facts", async () => {
    const ctx = await seed();
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res.passages.some((p) => p.content.includes("ZX-9000"))).toBe(true);
    expect(res.passages[0].title).toBe("Zorblax news");
    expect(res.entities.map((e) => e.name)).toContain("Zorblax Industries");
    expect(res.entities[0].neighbors.map((n) => n.name)).toContain("Austin");
    // visa_status shares no term with the query and has no object node, so it is not returned here.
    expect(res.facts).toEqual([]);
    expect(res.fallbackUsed).toBe(false);
    const [log] = await sql<{ query: string; used_fallback: boolean; node_ids: string[] }[]>`select query, used_fallback, node_ids from brain.retrieval_log`;
    expect(log.query).toContain("Zorblax");
    expect(log.node_ids.length).toBe(1);
    const visa = await search(ctx, "visa status");
    expect(visa.facts.map((f) => f.predicate)).toContain("visa_status");
  });

  it("applies the source_kind filter inside retrieval", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Zorblax Industries", { sourceKinds: ["note"], includeFacts: false });
    expect(res.passages.filter((p) => isHybrid(p)).every((p) => p.sourceKind === "note")).toBe(true);
    expect(res.facts).toEqual([]);
  });

  it("keyword side matches a question that shares only some terms with the passage", async () => {
    const ctx = await seed();
    ctx.embedder = { embed: async () => { throw new Error("no vectors in this test"); } } as unknown as typeof ctx.embedder;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // "Texas" and "year" appear nowhere; the old AND query returned nothing.
      const res = await search(ctx, "What did Zorblax release in Texas this year?");
      // Hybrid passages only: entity detection also brings the passage in as a graph passage.
      expect(res.passages.some((p) => isHybrid(p) && p.content.includes("ZX-9000"))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it("falls back to a raw substring scan when nothing ranks well", async () => {
    const ctx = await seed();
    const res = await search(ctx, "X-90");
    expect(res.fallbackUsed).toBe(true);
    const fb = res.passages.find((p) => p.layers.includes("fallback"))!;
    expect(fb.title).toBe("Zorblax news");
    expect(fb.content).toContain("ZX-9000");
  });

  it("does not scan for a plain natural-language question even when nothing ranks well", async () => {
    const ctx = await seed();
    ctx.reranker = { rerank: async (_q, docs, k) => docs.slice(0, k).map((_d, index) => ({ index, score: 0.01 })) };
    const res = await search(ctx, "tell me about gardening in winter");
    expect(res.fallbackUsed).toBe(false);
    expect(res.passages.filter((p) => p.layers.includes("fallback"))).toEqual([]);
  });

  it("treats LIKE metacharacters inside a trigger term literally", async () => {
    const ctx = await seed();
    for (const q of ["100%", "a_b-1", "100%_1", "a\\b-1"]) {
      const res = await search(ctx, q);
      expect(res.passages.filter((p) => p.layers.includes("fallback"))).toEqual([]);
    }
    // Near-misses that an unescaped pattern would match: "%" spans anything, "_" matches one character.
    await ingest(ctx, { text: "Revenue grew 1000 points; the code axb-1 shipped.", sourceKind: "note", title: "Near miss" });
    await ingest(ctx, { text: "Path ab-1 and axb-1 differ.", sourceKind: "note", title: "Slash" });
    await ingest(ctx, { text: "Revenue grew 100% and the code a_b-1 shipped. Path a\\b-1 too.", sourceKind: "note", title: "Exact" });
    weakRerank(ctx);
    for (const q of ["100%", "a_b-1", "a\\b-1"]) {
      const res = await search(ctx, q);
      expect(res.passages.filter((p) => p.layers.includes("fallback")).map((p) => p.title)).toEqual(["Exact"]);
    }
  });

  it("ranks fallback hits by how many trigger terms they contain", async () => {
    const ctx = weakRerank(fakeCtx(sql, handler));
    await ingest(ctx, { text: "Order X-90 and ZX-9000 together.", sourceKind: "note", title: "Both" });
    await ingest(ctx, { text: "Only the X-90 here.", sourceKind: "note", title: "One" });
    const res = await search(ctx, "X-90 ZX-9000");
    const fb = res.passages.filter((p) => p.layers.includes("fallback"));
    expect(fb.map((p) => p.title)).toEqual(["Both", "One"]);
  });

  it("returns one fallback passage per document, matches case-insensitively, and windows at document edges", async () => {
    const ctx = weakRerank(fakeCtx(sql, handler));
    const long = "x".repeat(500);
    await ingest(ctx, { text: `ZX-90 ${long} zx-90 ${long} Zx-90 end`, sourceKind: "note", title: "Repeats" });
    await ingest(ctx, { text: `${long} the code Q-77 closes`, sourceKind: "note", title: "Tail" });
    const rep = await search(ctx, "zx-90");
    const fbRep = rep.passages.filter((p) => p.layers.includes("fallback"));
    expect(fbRep).toHaveLength(1);
    expect(fbRep[0].charStart).toBe(0);
    expect(fbRep[0].content.startsWith("ZX-90")).toBe(true);
    const tail = await search(ctx, "q-77");
    const fbTail = tail.passages.filter((p) => p.layers.includes("fallback"));
    expect(fbTail).toHaveLength(1);
    expect(fbTail[0].content.endsWith("closes")).toBe(true);
    expect(fbTail[0].charEnd - fbTail[0].charStart).toBeLessThan(500);
  });

  it("applies source_kind and since/until to fallback hits", async () => {
    const ctx = weakRerank(fakeCtx(sql, handler));
    await ingest(ctx, { text: "Old build K-42 passed.", sourceKind: "news", title: "Old", occurredAt: new Date("2020-01-01T00:00:00Z") });
    await ingest(ctx, { text: "New build K-42 passed.", sourceKind: "note", title: "New", occurredAt: new Date("2026-01-01T00:00:00Z") });
    const titles = async (o = {}) => (await search(ctx, "K-42", o)).passages.filter((p) => p.layers.includes("fallback")).map((p) => p.title).sort();
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
    expect(res.passages.filter((p) => p.documentId === old.documentId).map((p) => p.layers)).toEqual([]);
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
    const hit = res.passages.find((p) => isHybrid(p) && p.content.includes("ZX-9000"))!;
    expect(hit.content.startsWith("Zorblax news")).toBe(false);
  });

  it("falls back to keyword-only search when the query embedding fails", async () => {
    const ctx = await seed();
    ctx.embedder = { embed: async () => { throw new Error("voyage 503"); } } as unknown as typeof ctx.embedder;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await search(ctx, "What did Zorblax Industries release?");
      expect(res.degraded).toEqual({ embedding: true, rerank: true, capReached: false });
      expect(res.mode).toBe("keyword-only");
      expect(res.topScore).toBeNull();
      expect(res.candidates.vector).toBe(0);
      expect(res.passages.some((p) => p.content.includes("ZX-9000"))).toBe(true);
      // No vectors: every hybrid passage was found by the keyword branch alone, in RRF order, unreranked.
      const hybrid = res.passages.filter(isHybrid);
      expect(hybrid.length).toBeGreaterThan(0);
      for (const p of hybrid) {
        // The query names Zorblax Industries, so the graph also reaches its passage; no passage has a vector layer.
        expect(p.layers.filter((l) => l !== "graph")).toEqual(["keyword"]);
        expect(p).toMatchObject({ vectorRank: null, scoreKind: "rrf", rerankRank: null });
        expect(p.keywordRank).toBeGreaterThan(0);
      }
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
      expect(res.degraded).toEqual({ embedding: true, rerank: true, capReached: false });
      expect(rerankCalls).toEqual([]);
      const hybrid = res.passages.filter((p) => isHybrid(p));
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
    expect(res.mode).toBe("hybrid");
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
      expect(res.degraded).toEqual({ embedding: false, rerank: true, capReached: false });
      expect(res.mode).toBe("fused-order");
      const hybrid = res.passages.filter((p) => isHybrid(p));
      expect(hybrid.length).toBeGreaterThan(0);
      expect(hybrid.map((p) => p.chunkId)).toEqual(fused.slice(0, hybrid.length).map((f) => f.id));
      expect(hybrid.map((p) => p.score)).toEqual(fused.slice(0, hybrid.length).map((f) => f.fused));
      expect(hybrid.every((p) => p.scoreKind === "rrf" && p.rerankRank === null)).toBe(true);
      // RRF values are never a top score: the log's top_score is null too.
      expect(res.topScore).toBeNull();
      const [log] = await sql<{ top_score: number | null }[]>`select top_score from brain.retrieval_log where id = ${res.retrievalId}`;
      expect(log.top_score).toBeNull();
    } finally {
      err.mockRestore();
    }
  });

  it("is not degraded when embedding and reranking succeed", async () => {
    const ctx = await seed();
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res.degraded).toEqual({ embedding: false, rerank: false, capReached: false });
    expect(res.mode).toBe("hybrid");
  });

  it("goes keyword-only and says the cap was reached when the ledger refuses the query embedding", async () => {
    const ctx = await seed();
    const { voyage, calls } = meteredVoyage(sql, 1);
    ctx.queryEmbedder = voyage;
    ctx.queryReranker = voyage;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await search(ctx, "What did Zorblax Industries release?");
      expect(res).toMatchObject({ mode: "keyword-only", degraded: { embedding: true, rerank: true, capReached: true } });
      expect(res.passages.some((p) => p.content.includes("ZX-9000"))).toBe(true);
      expect(calls).toEqual([]);
      expect(renderSearch(res)).toContain("(Voyage daily cap reached; keyword-only results)");
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("brain: Voyage daily cap reached, keyword search only");
    } finally {
      err.mockRestore();
    }
    const [log] = await sql<{ layers: string[] }[]>`select layers from brain.retrieval_log`;
    expect(log.layers).toEqual(expect.arrayContaining(["degraded", "cap_reached"]));
    const [refused] = await sql<{ operation: string; status: string }[]>`select operation, status from brain.provider_usage`;
    expect(refused).toEqual({ operation: "embed_query", status: "refused" });
  });

  it("keeps fused order and says the cap was reached when only the rerank is refused", async () => {
    const ctx = await seed();
    const query = "Zorblax Industries drill";
    // Room for the query embedding (the fake reports exactly the estimate) and nothing more.
    const { voyage, calls } = meteredVoyage(sql, estimateEmbedTokens([query]));
    ctx.queryEmbedder = voyage;
    ctx.queryReranker = voyage;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await search(ctx, query);
      expect(res).toMatchObject({ mode: "fused-order", degraded: { embedding: false, rerank: true, capReached: true } });
      expect(calls.map((c) => c.path)).toEqual(["/embeddings"]);
      expect(res.passages.filter((p) => isHybrid(p)).length).toBeGreaterThan(0);
      expect(renderSearch(res)).toContain("(Voyage daily cap reached; results in fused order)");
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("brain: Voyage daily cap reached, keeping fused order");
    } finally {
      err.mockRestore();
    }
  });

  it("searches normally through the ledger under the cap and records both calls", async () => {
    const ctx = await seed();
    const { voyage } = meteredVoyage(sql, 1_000_000, { client: "cli" });
    ctx.queryEmbedder = voyage;
    ctx.queryReranker = voyage;
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res).toMatchObject({ mode: "hybrid", degraded: { embedding: false, rerank: false, capReached: false } });
    const rows = await sql<{ operation: string; status: string; client: string }[]>`
      select operation, status, client from brain.provider_usage order by id`;
    expect(rows).toEqual([
      { operation: "embed_query", status: "ok", client: "cli" },
      { operation: "rerank", status: "ok", client: "cli" },
    ]);
  });

  it("reports how each hybrid passage was found: branch ranks, layers, rerank position and score kind", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Zorblax Industries drill", { includeFacts: false });
    const hybrid = res.passages.filter(isHybrid);
    expect(hybrid.length).toBeGreaterThan(1);
    // Only the Zorblax passage shares a term with the query, so it is the one passage both branches found.
    const both = hybrid.find((p) => p.content.includes("ZX-9000"))!;
    // The query names Zorblax Industries, whose mention is this same passage: graph is added, the branch ranks stay.
    expect(both.layers).toEqual(["vector", "keyword", "graph"]);
    expect(both.vectorRank).toBeGreaterThan(0);
    expect(both.keywordRank).toBe(1);
    const vectorOnly = hybrid.find((p) => !p.content.includes("ZX-9000"))!;
    expect(vectorOnly).toMatchObject({ layers: ["vector"], keywordRank: null });
    expect(hybrid.map((p) => p.rerankRank)).toEqual(hybrid.map((_p, i) => i + 1));
    expect(hybrid.every((p) => p.scoreKind === "rerank" && p.fallbackTerm === null)).toBe(true);
    expect(vectorOnly.viaEntity).toBeNull();
    expect(res.topScore).toBe(Math.max(...hybrid.map((p) => p.score as number)));
    expect(res.candidates.keyword).toBe(1);
    expect(res.candidates.fused).toBeGreaterThanOrEqual(res.candidates.vector);
    expect(res.candidates.fused).toBeLessThanOrEqual(res.candidates.vector + res.candidates.keyword);
    expect(both).toMatchObject({ title: "Zorblax news", sourceKind: "news", author: "owner", occurredAt: null });
  });

  it("times each stage; the stages are disjoint and fit inside the total", async () => {
    const ctx = await seed();
    const { timings } = await search(ctx, "What did Zorblax Industries release?");
    for (const v of Object.values(timings)) expect(v).toBeGreaterThanOrEqual(0);
    expect(timings.sqlMs).toBeGreaterThan(0);
    expect(timings.totalMs).toBeGreaterThan(0);
    // Each stage is rounded to 0.1 ms, so allow 0.05 ms per stage.
    expect(timings.embedMs + timings.sqlMs + timings.rerankMs + timings.graphMs).toBeLessThanOrEqual(timings.totalMs + 0.25);
    // At most one decimal: sqlMs sums several stages and must not carry float error such as 21.099999999999998.
    for (const v of Object.values(timings)) expect(String(v)).toMatch(/^\d+(\.\d)?$/);
  });

  it("a passage found by hybrid search and by the graph keeps its ranks and score and gains graph and the entity", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Zorblax Industries drill", { includeFacts: false });
    const entity = res.entities.find((e) => e.name === "Zorblax Industries")!;
    const zorblax = res.passages.filter((p) => p.content.includes("ZX-9000"));
    expect(zorblax).toHaveLength(1); // listed once, at its hybrid rank
    expect(zorblax[0]).toMatchObject({ layers: ["vector", "keyword", "graph"], scoreKind: "rerank", keywordRank: 1, rerankRank: 1, viaEntity: { id: entity.id, name: entity.name } });
    expect(zorblax[0].score).toBe(res.topScore);
    expect(zorblax[0].vectorRank).toBeGreaterThan(0);
    expect(isHybrid(zorblax[0])).toBe(true);
    expect(renderSearch(res)).toContain(`vector#${zorblax[0].vectorRank} keyword#1 graph via Zorblax Industries · news`);
    const [log] = await sql<{ results: LoggedPassage[] }[]>`select results from brain.retrieval_log where id = ${res.retrievalId}`;
    expect(log.results.find((p) => p.chunkId === zorblax[0].chunkId)!.layers).toEqual(["vector", "keyword", "graph"]);
  });

  it("a graph passage mentioned by two named entities is listed once, through the first", async () => {
    const ctx = await seed();
    ctx.reranker = { rerank: async () => [] };
    const res = await search(ctx, "Zorblax Industries Austin", { includeFacts: false });
    expect(res.entities.map((e) => e.name).sort()).toEqual(["Austin", "Zorblax Industries"]);
    const graph = res.passages.filter((p) => p.layers.includes("graph"));
    expect(graph).toHaveLength(1);
    expect(graph[0]).toMatchObject({ layers: ["graph"], score: null, viaEntity: { id: res.entities[0].id, name: res.entities[0].name } });
  });

  it("returns occurredAt as an ISO 8601 date-time that the contract schema accepts", async () => {
    const ctx = await seed();
    await sql`update brain.documents set occurred_at = '2026-01-25T13:05:07.012+02:00' where title = 'Zorblax news'`;
    const res = await search(ctx, "Zorblax drill X-90");
    const dated = res.passages.filter((p) => p.title === "Zorblax news");
    expect(dated.length).toBeGreaterThan(0);
    expect(dated.every((p) => p.occurredAt === "2026-01-25T11:05:07.012Z")).toBe(true);
    expect(() => SearchResultSchema.parse(res)).not.toThrow();
  });

  it("reports a graph passage with layers graph, no score, no ranks, and the entity that brought it in", async () => {
    const ctx = await seed();
    ctx.reranker = { rerank: async () => [] };
    const res = await search(ctx, "Zorblax Industries", { includeFacts: false });
    const entity = res.entities.find((e) => e.name === "Zorblax Industries")!;
    const graph = res.passages.filter((p) => p.layers.includes("graph"));
    expect(graph.length).toBe(1);
    expect(graph[0]).toMatchObject({
      layers: ["graph"], score: null, scoreKind: "none", vectorRank: null, keywordRank: null, rerankRank: null, fallbackTerm: null,
      viaEntity: { id: entity.id, name: "Zorblax Industries" }, title: "Zorblax news",
    });
    expect(res.topScore).toBeNull();
    expect(res.mode).toBe("hybrid");
  });

  it("reports a fallback passage with its document, the matched term, and no chunk or score", async () => {
    const ctx = await seed();
    const res = await search(ctx, "X-90");
    const fb = res.passages.find((p) => p.layers.includes("fallback"))!;
    expect(fb).toMatchObject({
      chunkId: null, title: "Zorblax news", layers: ["fallback"], score: null, scoreKind: "none", fallbackTerm: "X-90",
      vectorRank: null, keywordRank: null, rerankRank: null, viaEntity: null, headingPath: [],
    });
    expect(fb.charEnd).toBeGreaterThan(fb.charStart);
  });

  it("says where each fact came from: the extractor's document, or the owner", async () => {
    const ctx = await seed();
    const zorblax = (await sql<{ id: string }[]>`select id from brain.documents where title = 'Zorblax news'`)[0];
    await addFact(sql, { predicate: "lives_in", objectText: "Austin", by: "agent:test" });
    const visa = (await search(ctx, "visa status")).facts.find((f) => f.predicate === "visa_status")!;
    expect(visa.verifiedBy).toMatch(/^extractor:/);
    expect(visa).toMatchObject({ sourceDocumentId: zorblax.id, sourceKind: "news", verified: false });
    expect(visa.sourceChunkId).not.toBeNull();
    expect(factSource(visa)).toEqual({ kind: "document", sourceKind: "news", documentId: zorblax.id });
    const lives = (await search(ctx, "where do I live", { k: 3 })).facts.find((f) => f.predicate === "lives_in")!;
    expect(lives).toMatchObject({ verifiedBy: "agent:test", sourceChunkId: null, sourceDocumentId: null, sourceKind: null, confidence: 1 });
    expect(factSource(lives)).toEqual({ kind: "owner" });
  });

  it("an extracted fact whose passage is gone is unlinked, and once the owner verifies it, confirmed by owner", async () => {
    const ctx = await seed();
    const [visa] = await sql<{ id: string; source_chunk_id: string }[]>`select id, source_chunk_id from brain.facts where predicate = 'visa_status'`;
    await sql`delete from brain.chunks where id = ${visa.source_chunk_id}`;
    const before = (await search(ctx, "visa status")).facts.find((f) => f.id === visa.id)!;
    expect(before).toMatchObject({ sourceChunkId: null, sourceDocumentId: null, sourceKind: null, verified: false });
    expect(before.verifiedBy).toMatch(/^extractor:/);
    expect(factSource(before)).toEqual({ kind: "unlinked" });
    expect(factLine(before, 0)).toBe("[F1] visa_status: F-1 OPT (unverified · extracted; source passage no longer stored)");
    expect(await verifyFact(sql, visa.id)).toBe(true);
    const after = (await search(ctx, "visa status")).facts.find((f) => f.id === visa.id)!;
    expect(after).toMatchObject({ verified: true, verifiedBy: "frank", sourceChunkId: null });
    expect(factSource(after)).toEqual({ kind: "confirmed" });
    expect(factLine(after, 0)).toBe("[F1] visa_status: F-1 OPT (verified · confirmed by owner)");
  });

  it("logs each passage without its text, the degraded flags, candidates, timings, k and mode, and returns the log id", async () => {
    const ctx = weakRerank(await seed());
    const res = await search(ctx, "Zorblax ZX-9000", { k: 5, includeFacts: false });
    expect(res.fallbackUsed).toBe(true);
    const rows = await sql<{
      id: string; results: LoggedPassage[]; degraded: unknown; candidates: unknown; timings: unknown; k: number; mode: string;
      chunk_ids: string[]; used_fallback: boolean; layers: string[]; top_score: number | null;
    }[]>`select id, results, degraded, candidates, timings, k, mode, chunk_ids, used_fallback, layers, top_score from brain.retrieval_log`;
    expect(rows).toHaveLength(1);
    const [log] = rows;
    expect(log.id).toBe(res.retrievalId);
    expect(log.results).toHaveLength(res.passages.length);
    for (const [i, entry] of log.results.entries()) {
      expect(entry).not.toHaveProperty("content");
      expect(entry).toEqual(Object.fromEntries(Object.entries(res.passages[i]).filter(([key]) => key !== "content")));
      expect(entry).toHaveProperty("score");
      expect(entry).toHaveProperty("layers");
    }
    const fb = log.results.find((e) => e.layers.includes("fallback"))!;
    expect(fb).toMatchObject({ chunkId: null, fallbackTerm: "ZX-9000" });
    expect(fb.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(log.degraded).toEqual({ embedding: false, rerank: false, capReached: false });
    expect(log.candidates).toEqual(res.candidates);
    expect(log.timings).toEqual(res.timings);
    expect(log.k).toBe(5);
    expect(log.mode).toBe("hybrid");
    // The v1 columns are still written.
    expect(log.used_fallback).toBe(true);
    expect(log.layers).toContain("fallback");
    expect(log.chunk_ids).toEqual(res.passages.map((p) => p.chunkId).filter((id) => id !== null));
    expect(log.top_score).toBeCloseTo(0.01, 5);
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
    const graph = res.passages.filter((p) => p.layers.includes("graph"));
    expect(graph.length).toBe(config.graph.maxPassagesPerEntity);
    expect(graph.map((p) => p.title)).toEqual(["M25", "M24", "M23", "M22", "M21"]); // newest documents first
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
    expect(res.passages.filter((p) => p.layers.includes("graph")).map((p) => p.chunkId)).toEqual([first.id]);
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
    expect(all.facts.length).toBe(config.graph.maxFacts);
  });

  it("finds graph passages through mentions recorded on a node merged into the named one", async () => {
    const ctx = fakeCtx(sql, ({ system }) =>
      system === SUMMARY_SYSTEM
        ? { title: "Beta", summary_line: "Beta.", summary: "Beta.", occurred_at: null }
        : { entities: [{ key: "b", type: "organization", name: "Betacorp", aliases: [], untyped_hint: null, quote: "Betacorp" }],
            relations: [], facts_about_self: [] });
    await ingest(ctx, { text: "Betacorp opened a lab.", sourceKind: "note", title: "Beta doc" });
    const [a] = await sql<{ id: string }[]>`
      insert into brain.nodes (type, name, canonical_name) values ('organization', 'Alphagroup', 'alphagroup') returning id`;
    await sql`update brain.nodes set merged_into = ${a.id} where canonical_name = 'betacorp'`;
    ctx.reranker = { rerank: async () => [] };
    const res = await search(ctx, "Alphagroup", { includeFacts: false });
    expect(res.entities.map((e) => e.id)).toEqual([a.id]);
    expect(res.passages.filter((p) => p.layers.includes("graph")).map((p) => p.title)).toEqual(["Beta doc"]);
  });

  it("returns a fact pointing at a detected entity ahead of term-only matches, also through a merge", async () => {
    const ctx = fakeCtx(sql, ({ system }) =>
      system === SUMMARY_SYSTEM
        ? { title: "Me", summary_line: "About me.", summary: "About me.", occurred_at: null }
        : { entities: [{ key: "q", type: "organization", name: "Quuxcorp", aliases: [], untyped_hint: null, quote: "Quuxcorp" }],
            relations: [],
            facts_about_self: [
              { predicate: "works_at", object_text: "my employer", object_key: "q", confidence: 0.5, valid_from: null, valid_to: null, quote: "Quuxcorp" },
              ...Array.from({ length: 12 }, (_, i) => ({ predicate: `skill_${i}`, object_text: `thing ${i}`, object_key: null, confidence: 0.9, valid_from: null, valid_to: null, quote: "I" })),
            ] });
    await ingest(ctx, { text: "I work at Quuxcorp. I have many skills.", sourceKind: "note", title: "Me" });
    const res = await search(ctx, "Quuxcorp skill");
    expect(res.facts.length).toBe(config.graph.maxFacts);
    expect(res.facts[0].predicate).toBe("works_at");
    // The fact's object node is merged into another node; naming the canonical node still finds it.
    const [z] = await sql<{ id: string }[]>`
      insert into brain.nodes (type, name, canonical_name) values ('organization', 'Zentrix Holdings', 'zentrix holdings') returning id`;
    await sql`update brain.nodes set merged_into = ${z.id} where canonical_name = 'quuxcorp'`;
    const merged = await search(ctx, "Zentrix Holdings skill");
    expect(merged.facts[0].predicate).toBe("works_at");
  });

  it("verifiedOnly keeps only verified facts", async () => {
    const ctx = fakeCtx(sql, ({ system }) =>
      system === SUMMARY_SYSTEM
        ? { title: "Me", summary_line: "About me.", summary: "About me.", occurred_at: null }
        : { entities: [], relations: [],
            facts_about_self: Array.from({ length: 3 }, (_, i) => ({ predicate: `skill_${i}`, object_text: `thing ${i}`, object_key: null, confidence: 0.9, valid_from: null, valid_to: null, quote: "I" })) });
    await ingest(ctx, { text: "I have skills.", sourceKind: "note", title: "Me" });
    await sql`update brain.facts set verified = true where predicate = 'skill_1'`;
    expect((await search(ctx, "skill")).facts.length).toBe(3);
    const res = await search(ctx, "skill", { verifiedOnly: true });
    expect(res.facts.map((f) => f.predicate)).toEqual(["skill_1"]);
  });

  it("rejects an empty query", async () => {
    const ctx = fakeCtx(sql, handler);
    await expect(search(ctx, "   ")).rejects.toThrow("Search query is empty");
  });
});
