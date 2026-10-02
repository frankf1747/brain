import { describe, it, expect } from "vitest";
import {
  renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, passageLine, factLine, scoreText, foundBy, searchHeader,
  renderExplain,
} from "../../src/mcp/render.js";
import { toLoggedPassages } from "../../src/retrieve/contract.js";
import type { Explanation } from "../../src/retrieve/explain.js";
import { passage, fact, searchResult } from "./search-fixture.js";

const graphPassage = passage({
  chunkId: "c3", documentId: "d3", title: "Acme memo", sourceKind: "note", author: "owner", occurredAt: "2026-01-25T00:00:00.000Z",
  content: "Graph body", score: null, scoreKind: "none", layers: ["graph"], vectorRank: null, keywordRank: null, rerankRank: null,
  viaEntity: { id: "n1", name: "Acme" },
});
const fallbackPassage = passage({
  chunkId: null, documentId: "d4", title: "Codes", sourceKind: "note", author: "unknown", occurredAt: null, content: "Order X-90 today",
  charStart: 10, charEnd: 30, score: null, scoreKind: "none", layers: ["fallback"], vectorRank: null, keywordRank: null, rerankRank: null,
  fallbackTerm: "X-90",
});

const fixture = searchResult({
  fallbackUsed: true,
  topScore: 0.76,
  passages: [
    passage({ headingPath: ["H", "Sub"] }),
    passage({
      chunkId: "c2", documentId: "d2", title: null, sourceKind: "note", author: "owner", occurredAt: null, content: "  Second body  ",
      score: 0.41, layers: ["vector"], vectorRank: 1, keywordRank: null, rerankRank: 2,
    }),
    graphPassage,
    fallbackPassage,
  ],
  documents: [{ documentId: "d1", title: "Doc", sourceKind: "news", summary: "S", score: 0.03 }],
  entities: [{ id: "n1", type: "organization", name: "Acme", matchedSpan: "acme", neighbors: [{ id: "n2", type: "place", name: "Austin", depth: 1 }] }],
  facts: [
    fact(),
    fact({ id: "f2", predicate: "lives_in", objectText: "Austin", verified: true, verifiedBy: "agent:claude-code", sourceChunkId: null, sourceDocumentId: null, sourceKind: null }),
    fact({ id: "f3", predicate: "prefers", objectText: "tea", sourceChunkId: null, sourceDocumentId: null, sourceKind: null }),
  ],
});

describe("renderSearch", () => {
  it("generates the whole text from the structure", () => {
    expect(renderSearch(fixture)).toBe(
      [
        "retrieval r1 · mode: hybrid · 4 passages",
        "(weak match: results include raw substring hits)",
        "",
        '[P1] 0.76 rerank · vector#2 keyword#5 · news · author: other · "Doc" · 2026-09-29 (doc d1, chunk c1)',
        "  H > Sub",
        "Body text",
        "",
        "[P2] 0.41 rerank · vector#1 · note · author: owner · (untitled) · undated (doc d2, chunk c2)",
        "Second body",
        "",
        '[P3] - · graph via Acme · note · author: owner · "Acme memo" · 2026-01-25 (doc d3, chunk c3)',
        "Graph body",
        "",
        '[P4] - · fallback "X-90" · note · author: unknown · "Codes" · undated (doc d4, chars 10–30)',
        "Order X-90 today",
        "",
        "Documents by summary: Doc [news] (doc d1)",
        'Entity organization: Acme (node n1, matched "acme") — Austin (place)',
        "Facts about the owner:",
        "[F1] visa_status: F-1 OPT (unverified · from note d9)",
        "[F2] lives_in: Austin (verified · stated by owner)",
        "[F3] prefers: tea (unverified · extracted; source passage no longer stored)",
      ].join("\n"),
    );
  });

  it("brief mode keeps every provenance line and cuts each passage to one line", () => {
    const long = passage({ content: "word ".repeat(100) + "\n\nend" });
    const text = renderSearch(searchResult({ passages: [long] }), { brief: true });
    expect(text.split("\n")[0]).toBe("retrieval r1 · mode: hybrid · 1 passage");
    expect(text).toContain(passageLine(long, 0));
    const body = text.split("\n")[3];
    expect(body.startsWith("     word word")).toBe(true);
    expect(body.length).toBe(5 + 240);
  });

  it("states the mode exactly and keeps the four degraded notes on the line after the header", () => {
    const cases = [
      { degraded: { embedding: true, rerank: true, capReached: true }, mode: "keyword-only" as const, note: "Voyage daily cap reached; keyword-only results" },
      { degraded: { embedding: true, rerank: true, capReached: false }, mode: "keyword-only" as const, note: "query embedding failed; keyword-only results" },
      { degraded: { embedding: false, rerank: true, capReached: true }, mode: "fused-order" as const, note: "Voyage daily cap reached; results in fused order" },
      { degraded: { embedding: false, rerank: true, capReached: false }, mode: "fused-order" as const, note: "reranking failed; results in fused order" },
    ];
    for (const c of cases) {
      const lines = renderSearch(searchResult({ retrievalId: "r9", mode: c.mode, degraded: c.degraded })).split("\n");
      expect(lines[0]).toBe(`retrieval r9 · mode: ${c.mode} · 0 passages`);
      expect(lines[1]).toBe(`(${c.note})`);
    }
    const hybrid = renderSearch(searchResult()).split("\n");
    expect(hybrid[0]).toBe("retrieval r1 · mode: hybrid · 0 passages");
    expect(hybrid[1]).toBe("");
  });

  it("says so when nothing was found", () => {
    expect(renderSearch(searchResult())).toContain("No passages matched.");
  });

  it("shows RRF scores with four decimals when reranking was skipped, and keyword ranks alone in keyword-only mode", () => {
    const p = passage({ score: 1 / 61, scoreKind: "rrf", layers: ["keyword"], vectorRank: null, keywordRank: 1, rerankRank: null });
    expect(scoreText(p)).toBe("0.0164 rrf");
    expect(foundBy(p)).toBe("keyword#1");
    expect(scoreText(graphPassage)).toBe("-");
    expect(foundBy(graphPassage)).toBe("graph via Acme");
    expect(foundBy(fallbackPassage)).toBe('fallback "X-90"');
  });

  it("factLine and searchHeader are what renderSearch prints", () => {
    expect(factLine(fact(), 0)).toBe("[F1] visa_status: F-1 OPT (unverified · from note d9)");
    expect(searchHeader(fixture)).toBe("retrieval r1 · mode: hybrid · 4 passages");
  });
});

describe("renderExplain", () => {
  const base: Explanation = {
    retrievalId: "r1", query: "acme X-90", client: "mcp-stdio", createdAt: "2026-10-02T09:15:00.000Z",
    filters: { sourceKinds: ["note", "news"], since: "2026-09-01T00:00:00.000Z", until: null, verifiedOnly: false },
    v2: true, k: 10, mode: "hybrid", degraded: { embedding: false, rerank: false, capReached: false },
    candidates: { vector: 60, keyword: 12, fused: 64 }, timings: { embedMs: 120.3, sqlMs: 45.1, rerankMs: 210, graphMs: 3.2, totalMs: 380.9 },
    results: toLoggedPassages(fixture.passages), layers: ["hybrid", "summary", "graph", "fallback"], chunkIds: ["c1", "c2", "c3"], nodeIds: ["n1"],
    topScore: 0.76, usedFallback: true,
  };

  it("replays a v2 row: who and when, filters, mode, flags, candidates, timings, and every passage's ranks and score", () => {
    expect(renderExplain(base)).toBe(
      [
        "retrieval r1 · logged 2026-10-02T09:15:00.000Z · client mcp-stdio",
        'query: "acme X-90"',
        "filters: source_kinds note, news · since 2026-09-01T00:00:00.000Z",
        "mode: hybrid · k 10",
        "degraded: embedding no · rerank no · cap reached no",
        "candidates: vector 60 · keyword 12 · fused 64",
        "timings: embed 120.3 ms · sql 45.1 ms · rerank 210.0 ms · graph 3.2 ms · total 380.9 ms",
        "top rerank score: 0.76",
        "fallback scan: used",
        "",
        "Passages in rank order (P labels as brain_search showed them): 4",
        '#1 [P1] score 0.76 (rerank) · layers vector+keyword · vector 2 · keyword 5 · rerank 1 · "Doc" · author: other · news (doc d1, chunk c1)',
        "#2 [P2] score 0.41 (rerank) · layers vector · vector 1 · keyword - · rerank 2 · (untitled) · author: owner · note (doc d2, chunk c2)",
        '#3 [P3] score - (none) · layers graph via Acme · vector - · keyword - · rerank - · "Acme memo" · author: owner · note (doc d3, chunk c3)',
        '#4 [P4] score - (none) · layers fallback "X-90" · vector - · keyword - · rerank - · "Codes" · author: unknown · note (doc d4, chars 10–30)',
      ].join("\n"),
    );
  });

  it("shows the degraded note and an RRF ranking for a degraded row", () => {
    const rrf = passage({ score: 1 / 61, scoreKind: "rrf", layers: ["keyword"], vectorRank: null, keywordRank: 1, rerankRank: null });
    const t = renderExplain({
      ...base, mode: "keyword-only", degraded: { embedding: true, rerank: true, capReached: true }, topScore: null, results: toLoggedPassages([rrf]),
      filters: {},
    });
    expect(t).toContain("filters: none");
    expect(t).toContain("mode: keyword-only · k 10");
    expect(t).toContain("degraded: embedding yes · rerank yes · cap reached yes\n(Voyage daily cap reached; keyword-only results)");
    expect(t).toContain("top rerank score: none (no rerank ran, or it returned nothing)");
    expect(t).toContain("#1 [P1] score 0.0164 (rrf) · layers keyword · vector - · keyword 1 · rerank -");
  });

  it("explains what is known about a row logged before evidence v2", () => {
    const t = renderExplain({
      ...base, v2: false, k: null, mode: null, degraded: null, candidates: null, timings: null, results: null, filters: {},
      layers: ["hybrid", "summary", "degraded"], chunkIds: ["c1", "c2"], nodeIds: [], topScore: 0.031, usedFallback: false,
    });
    expect(t.split("\n")).toEqual([
      "retrieval r1 · logged 2026-10-02T09:15:00.000Z · client mcp-stdio",
      'query: "acme X-90"',
      "filters: none",
      "logged before evidence v2: only the chunk ids, the top score, the layers and the fallback flag were recorded.",
      "layers: hybrid, summary, degraded",
      "top score: 0.03 (before evidence v2 this is an RRF value when the search was degraded)",
      "fallback scan: not used",
      "chunks in rank order (fallback passages were not recorded): c1, c2",
      "entities: none",
    ]);
  });
});

describe("other renderers", () => {
  it("renderStatus lists documents whose items about the owner were suppressed", () => {
    const pipeline = [{ stage: "done", count: 1, failed: 0 }];
    const t = renderStatus(pipeline, [], [], [{ documentId: "d1", title: "Databricks costs", author: "other", count: 4 }]);
    expect(t).toContain("suppressed because the owner did not write the document");
    expect(t).toContain("- d1 Databricks costs [author other]: 4");
    expect(renderStatus(pipeline, [], [])).not.toContain("suppressed");
  });

  it("renderOrient lists counts, today's Voyage tokens against the cap, and usage guidance", () => {
    const t = renderOrient({
      totalDocuments: 2, documentsByKind: [{ kind: "news", count: 2 }], nodesByType: [{ type: "person", count: 3 }],
      recent: [{ id: "d1", title: "T", sourceKind: "news", occurredAt: null, ingestedAt: new Date("2026-09-27T00:00:00Z") }],
      facts: [{ id: "f", predicate: "p", objectText: "o", verified: false }], pipeline: [{ stage: "done", count: 2, failed: 0 }],
      voyage: { tokensToday: 1_250_000, cap: 5_000_000 },
    });
    expect(t).toContain("2 documents");
    expect(t).toContain("news: 2");
    expect(t).toContain("person: 3");
    expect(t.split("\n")).toContain("Voyage today: 1,250,000 of 5,000,000 tokens (25.0%)");
    expect(t).toContain("brain_search");
  });
  it("renderOrient says the Voyage ledger is unavailable instead of failing", () => {
    const t = renderOrient({
      totalDocuments: 0, documentsByKind: [], nodesByType: [], recent: [], facts: [], pipeline: [], voyage: null,
    });
    expect(t.split("\n")).toContain("Voyage ledger unavailable (migration 010 missing?)");
    expect(t).toContain("brain_search");
  });
  it("renderNode shows edges with direction and evidence", () => {
    const t = renderNode({
      id: "n1", type: "organization", name: "Acme", aliases: ["acme"], properties: {}, verified: false, isSelf: false,
      edges: [{ direction: "in", type: "applied_to", otherId: "n0", otherName: "Frank Fu", otherType: "person", evidence: "I applied", evidenceDocumentId: "d1", evidenceDocumentTitle: "Note" }],
      facts: [], mentionCount: 1, mentionedIn: [{ documentId: "d1", title: "Note", sourceKind: "note" }],
    });
    expect(t).toContain("← applied_to Frank Fu (person, node n0)");
    expect(t).toContain('"I applied"');
  });
  it("renderDocument shows the author and the slice window", () => {
    const t = renderDocument({ id: "d1", title: "T", sourceKind: "news", author: "other", origin: null, occurredAt: null, ingestedAt: new Date(0), summary: null, totalLength: 100, offset: 10, text: "abc" });
    expect(t).toContain("origin: n/a · author: other · about: unknown");
    expect(t).toContain("characters 10–13 of 100");
    expect(t).toContain("abc");
  });
  it("renderFacts marks unverified and superseded", () => {
    const t = renderFacts([{ id: "f1", predicate: "p", objectText: "o", confidence: null, verified: false, verifiedBy: "agent:x", validFrom: null, validTo: null, supersededBy: "f2", sourceChunkId: null, createdAt: new Date(0) }]);
    expect(t).toContain("[F1] p: o (unverified, agent:x; superseded) id f1");
  });
});
