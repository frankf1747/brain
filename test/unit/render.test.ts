import { describe, it, expect } from "vitest";
import {
  renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, passageLine, factLine, scoreText, foundBy, searchHeader,
  renderExplain, explainLine, renderSources, verdictLine, verdictDetail, renderVerification, VERIFY_LIMITS, renderAnswerCheck,
} from "../../src/mcp/render.js";
import type { ClaimResult } from "../../src/verify/verify.js";
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
    fact({ id: "f2", predicate: "lives_in", objectText: "Austin", verified: true, verifiedBy: "frank", sourceChunkId: null, sourceDocumentId: null, sourceKind: null }),
    fact({ id: "f3", predicate: "prefers", objectText: "tea", sourceChunkId: null, sourceDocumentId: null, sourceKind: null }),
    fact({ id: "f4", predicate: "works_at", objectText: "Acme", verifiedBy: "agent:claude-code", sourceChunkId: null, sourceDocumentId: null, sourceKind: null }),
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
        "[F2] lives_in: Austin (verified · confirmed by owner)",
        "[F3] prefers: tea (unverified · extracted; source passage no longer stored)",
        "[F4] works_at: Acme (unverified · stated by owner)",
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

  it("a hybrid passage the graph also reached keeps its ranks and score and adds the entity", () => {
    const both = passage({ layers: ["vector", "keyword", "graph"], viaEntity: { id: "n1", name: "Acme Corp" } });
    expect(foundBy(both)).toBe("vector#2 keyword#5 graph via Acme Corp");
    expect(scoreText(both)).toBe("0.76 rerank");
    expect(passageLine(both, 0)).toBe('[P1] 0.76 rerank · vector#2 keyword#5 graph via Acme Corp · news · author: other · "Doc" · 2026-09-29 (doc d1, chunk c1)');
    expect(explainLine(both, 0)).toBe(
      '#1 [P1] score 0.76 (rerank) · layers vector+keyword+graph via Acme Corp · vector 2 · keyword 5 · rerank 1 · "Doc" · author: other · news (doc d1, chunk c1)',
    );
  });

  it("factLine and searchHeader are what renderSearch prints", () => {
    expect(factLine(fact(), 0)).toBe("[F1] visa_status: F-1 OPT (unverified · from note d9)");
    expect(searchHeader(fixture)).toBe("retrieval r1 · mode: hybrid · 4 passages");
  });
});

describe("renderSources", () => {
  it("lists what a brain ask answer could cite, marked as the knowledge base's, with the explain hint", () => {
    const r = searchResult({ passages: [passage()], facts: [fact()], degraded: { embedding: false, rerank: true, capReached: false }, mode: "fused-order" });
    expect(renderSources(r).split("\n")).toEqual([
      "Sources from the knowledge base (the answer above is the model's, written from these):",
      "retrieval r1 · mode: fused-order · 1 passage",
      "(reranking failed; results in fused order)",
      '[P1] 0.76 rerank · vector#2 keyword#5 · news · author: other · "Doc" · 2026-09-29 (doc d1, chunk c1)',
      "[F1] visa_status: F-1 OPT (unverified · from note d9)",
      "brain explain r1 replays how these passages were ranked.",
    ]);
  });
});

describe("renderVerification", () => {
  const claim = (over: Partial<ClaimResult> = {}): ClaimResult => ({
    claim: "Acme sponsors H-1B visas.", labels: ["P1"], verdict: "supported", support: 1, matchedTerms: ["Acme", "sponsors", "visas"],
    missingTerms: [], missingNumbers: [], negationMismatch: false, missingPolarity: [], badLabels: [],
    cites: [{ label: "P1", kind: "passage", documentId: "d1", chunkId: "c1", factId: null, title: "Doc" }], ...over,
  });

  it("prints one line per claim with its mark, verdict, support and cites", () => {
    expect(verdictLine(claim({ support: 0.833 }))).toBe('✓ supported 0.83 — "Acme sponsors H-1B visas." [P1]');
    expect(verdictLine(claim({ verdict: "partial", support: 0.5, labels: ["P1", "F2"] }))).toBe('~ partial 0.50 — "Acme sponsors H-1B visas." [P1, F2]');
    expect(verdictLine(claim({ verdict: "unsupported", support: 0 }))).toBe('✗ unsupported 0.00 — "Acme sponsors H-1B visas." [P1]');
    expect(verdictLine(claim({ verdict: "uncited", support: null, labels: [], cites: [] }))).toBe('○ uncited - — "Acme sponsors H-1B visas."');
    expect(verdictLine(claim({ verdict: "bad_citation", support: null, labels: ["P9"], cites: [] }))).toBe('! bad citation - — "Acme sponsors H-1B visas." [P9]');
  });

  it("says under each claim that is not supported what its cited text lacks, and lists bad cites under any claim", () => {
    expect(verdictDetail(claim())).toBeNull();
    expect(verdictDetail(claim({ badLabels: [{ label: "P9", reason: "no P9 in this search (it returned 3 passages)" }] }))).toBe(
      "    bad citation P9: no P9 in this search (it returned 3 passages)",
    );
    expect(verdictDetail(claim({ verdict: "partial", support: 0.5, missingTerms: ["Denver"], missingNumbers: ["$140000"], negationMismatch: true }))).toBe(
      "    missing terms: Denver · missing numbers: $140000 · negation differs from the cited text",
    );
    expect(verdictDetail(claim({ verdict: "partial", support: 1, missingPolarity: ["up", "only"] }))).toBe(
      "    missing polarity words: up, only",
    );
    expect(verdictDetail(claim({ verdict: "partial", support: null }))).toBe("    no content words to compare");
    expect(verdictDetail(claim({ verdict: "uncited", support: null, labels: [], cites: [] }))).toBe("    no citation: nothing from the knowledge base backs this");
    expect(verdictDetail(claim({ verdict: "bad_citation", support: null, cites: [], badLabels: [{ label: "P9", reason: "r" }] }))).toBe("    bad citation P9: r");
  });

  it("renders the whole verification: header, claims, summary, notes and what was not checked", () => {
    const text = renderVerification({
      verificationId: "v1", retrievalId: "r1", notes: ["Old search."],
      claims: [claim(), claim({ claim: "Acme pays $150,000.", verdict: "partial", support: 1, missingNumbers: ["$150000"] })],
      summary: { supported: 1, partial: 1, unsupported: 0, uncited: 0, bad_citation: 0, text: "1 supported, 1 partial" },
    });
    expect(text.split("\n")).toEqual([
      "verification v1 · retrieval r1 · 2 claims",
      '✓ supported 1.00 — "Acme sponsors H-1B visas." [P1]',
      '~ partial 1.00 — "Acme pays $150,000." [P1]',
      "    missing numbers: $150000",
      "Summary: 1 supported, 1 partial",
      "Note: Old search.",
      VERIFY_LIMITS,
    ]);
  });
});

describe("renderAnswerCheck", () => {
  const v = {
    verificationId: "v1", retrievalId: "r1", notes: [],
    claims: [{ claim: "Acme sponsors visas.", labels: ["P1"], verdict: "supported" as const, support: 1, matchedTerms: [], missingTerms: [], missingNumbers: [], negationMismatch: false, missingPolarity: [], badLabels: [], cites: [] }],
    summary: { supported: 1, partial: 0, unsupported: 0, uncited: 0, bad_citation: 0, text: "1 supported" },
  };

  it("introduces the verification, and says when sentences were left out", () => {
    expect(renderAnswerCheck(v, null, 0).split("\n").slice(0, 3)).toEqual([
      "Each sentence of the answer, checked against what it cites (no model call):",
      "verification v1 · retrieval r1 · 1 claim",
      '✓ supported 1.00 — "Acme sponsors visas." [P1]',
    ]);
    expect(renderAnswerCheck(v, null, 0)).not.toContain("Only the first");
    expect(renderAnswerCheck(v, null, 4).split("\n").at(-1)).toBe("Only the first 1 sentences were checked; 4 more were not.");
  });

  it("says why the check did not run, or that there was nothing to check", () => {
    expect(renderAnswerCheck(null, "relation \"brain.verification_log\" does not exist", 0)).toBe(
      'Could not check the answer against its sources: relation "brain.verification_log" does not exist',
    );
    expect(renderAnswerCheck(null, null, 0)).toBe("The answer has no sentences to check.");
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
    expect(t).toContain("brain_verify to check an answer's claims against the passages and facts they cite");
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
