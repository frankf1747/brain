import { describe, it, expect } from "vitest";
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts } from "../../src/mcp/render.js";

describe("renderSearch", () => {
  it("numbers passages with ids, lists entities, facts and the fallback notice", () => {
    const text = renderSearch({
      query: "q",
      passages: [
        { chunkId: "c1", documentId: "d1", documentTitle: "Doc", sourceKind: "news", content: "Body text", parentContent: null, headingPath: ["H"], charStart: 0, charEnd: 9, score: 0.8, group: "hybrid" },
        { chunkId: null, documentId: "d2", documentTitle: null, sourceKind: "note", content: "raw hit", parentContent: null, headingPath: [], charStart: 0, charEnd: 7, score: 0, group: "fallback" },
      ],
      documents: [{ documentId: "d1", title: "Doc", sourceKind: "news", summary: "S", score: 0.1 }],
      entities: [{ id: "n1", type: "organization", name: "Acme", matchedSpan: "acme", neighbors: [{ id: "n2", type: "place", name: "Austin", depth: 1 }] }],
      facts: [{ id: "f1", predicate: "visa_status", objectText: "F-1", confidence: 1, verified: true, sourceChunkId: null }],
      usedFallback: true,
      topScore: 0.8,
      degraded: false,
    });
    expect(text).toContain("[P1] hybrid · news · Doc (document d1, chunk c1)");
    expect(text).toContain("[P2] fallback · note (document d2)");
    expect(text).toContain("organization: Acme (node n1) — Austin (place)");
    expect(text).toContain("[F1] visa_status: F-1 (verified)");
    expect(text).toContain("weak match");
    expect(text).not.toContain("embeddings unavailable");
  });
  it("says so when nothing was found", () => {
    expect(renderSearch({ query: "q", passages: [], documents: [], entities: [], facts: [], usedFallback: true, topScore: null, degraded: false })).toContain("No passages matched");
  });
  it("notes degraded (keyword-only) results on its own line near the top", () => {
    const text = renderSearch({ query: "q", passages: [], documents: [], entities: [], facts: [], usedFallback: false, topScore: null, degraded: true });
    const lines = text.split("\n");
    expect(lines.indexOf("(embeddings unavailable: keyword-only results)")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("(embeddings unavailable: keyword-only results)")).toBeLessThan(3);
  });
});

describe("other renderers", () => {
  it("renderOrient lists counts and usage guidance", () => {
    const t = renderOrient({
      totalDocuments: 2, documentsByKind: [{ kind: "news", count: 2 }], nodesByType: [{ type: "person", count: 3 }],
      recent: [{ id: "d1", title: "T", sourceKind: "news", occurredAt: null, ingestedAt: new Date("2026-09-27T00:00:00Z") }],
      facts: [{ id: "f", predicate: "p", objectText: "o", verified: false }], pipeline: [{ stage: "done", count: 2, failed: 0 }],
    });
    expect(t).toContain("2 documents");
    expect(t).toContain("news: 2");
    expect(t).toContain("person: 3");
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
  it("renderDocument shows the slice window", () => {
    const t = renderDocument({ id: "d1", title: "T", sourceKind: "news", origin: null, occurredAt: null, ingestedAt: new Date(0), summary: null, totalLength: 100, offset: 10, text: "abc" });
    expect(t).toContain("characters 10–13 of 100");
    expect(t).toContain("abc");
  });
  it("renderFacts marks unverified and superseded", () => {
    const t = renderFacts([{ id: "f1", predicate: "p", objectText: "o", confidence: null, verified: false, verifiedBy: "agent:x", validFrom: null, validTo: null, supersededBy: "f2", sourceChunkId: null, createdAt: new Date(0) }]);
    expect(t).toContain("[F1] p: o (unverified, agent:x; superseded) id f1");
  });
});
