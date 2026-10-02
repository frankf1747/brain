import { describe, it, expect } from "vitest";
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus } from "../../src/mcp/render.js";
import { passage, fact, searchResult } from "./search-fixture.js";

describe("renderSearch", () => {
  it("numbers passages with ids, lists entities, facts and the fallback notice", () => {
    const text = renderSearch(searchResult({
      passages: [
        passage({ headingPath: ["H"] }),
        passage({
          chunkId: null, documentId: "d2", title: null, sourceKind: "note", author: "owner", content: "raw hit", score: null, scoreKind: "none",
          layers: ["fallback"], vectorRank: null, keywordRank: null, rerankRank: null, fallbackTerm: "hit",
        }),
      ],
      documents: [{ documentId: "d1", title: "Doc", sourceKind: "news", summary: "S", score: 0.1 }],
      entities: [{ id: "n1", type: "organization", name: "Acme", matchedSpan: "acme", neighbors: [{ id: "n2", type: "place", name: "Austin", depth: 1 }] }],
      facts: [fact({ verified: true })],
      fallbackUsed: true,
      topScore: 0.76,
    }));
    expect(text).toContain("[P1] vector+keyword · news · author: other · Doc (document d1, chunk c1)");
    expect(text).toContain("[P2] fallback · note · author: owner (document d2)");
    expect(text).toContain("organization: Acme (node n1) — Austin (place)");
    expect(text).toContain("[F1] visa_status: F-1 OPT (verified)");
    expect(text).toContain("weak match");
  });

  it("says so when nothing was found", () => {
    expect(renderSearch(searchResult({ fallbackUsed: true }))).toContain("No passages matched");
  });

  it("names which part of a degraded search fell back, on its own line near the top", () => {
    const cases = [
      { degraded: { embedding: true, rerank: true, capReached: true }, note: "Voyage daily cap reached; keyword-only results" },
      { degraded: { embedding: true, rerank: true, capReached: false }, note: "query embedding failed; keyword-only results" },
      { degraded: { embedding: false, rerank: true, capReached: true }, note: "Voyage daily cap reached; results in fused order" },
      { degraded: { embedding: false, rerank: true, capReached: false }, note: "reranking failed; results in fused order" },
    ];
    for (const c of cases) {
      const lines = renderSearch(searchResult({ degraded: c.degraded })).split("\n");
      expect(lines.indexOf(`(${c.note})`)).toBeGreaterThanOrEqual(0);
      expect(lines.indexOf(`(${c.note})`)).toBeLessThan(3);
    }
  });

  it("prints no degraded note for a hybrid search", () => {
    expect(renderSearch(searchResult())).not.toMatch(/keyword-only results|fused order/);
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
