import { describe, it, expect } from "vitest";
import { buildAskPrompt, ASK_SYSTEM } from "../../src/retrieve/ask.js";
import { passage, fact, searchResult } from "./search-fixture.js";

describe("buildAskPrompt", () => {
  it("states the search mode, and each passage's score, how it was found, and author", () => {
    const prompt = buildAskPrompt("Why?", searchResult({ passages: [passage()], facts: [fact()] }));
    expect(prompt).toBe(
      [
        "Question: Why?",
        "",
        "Search mode: hybrid",
        "",
        "Facts about the owner:",
        "[F1] visa_status: F-1 OPT (unverified · from note d9)",
        "",
        "Passages:",
        "[P1] 0.76 rerank · vector#2 keyword#5 · author: other · news: Doc",
        "Body text",
      ].join("\n"),
    );
  });

  it("says when the search was degraded or fell back to literal matches", () => {
    const degraded = searchResult({
      mode: "keyword-only",
      degraded: { embedding: true, rerank: true, capReached: false },
      fallbackUsed: true,
      passages: [
        passage({ score: 1 / 61, scoreKind: "rrf", layers: ["keyword"], vectorRank: null, keywordRank: 1, rerankRank: null }),
        passage({ chunkId: null, author: "unknown", score: null, scoreKind: "none", layers: ["fallback"], vectorRank: null, keywordRank: null, rerankRank: null, fallbackTerm: "X-90" }),
      ],
    });
    const prompt = buildAskPrompt("What is X-90?", degraded);
    expect(prompt).toContain("Search mode: keyword-only (query embedding failed; keyword-only results)");
    expect(prompt).toContain("Weak match: some passages are literal substring hits (fallback), not ranked passages.");
    expect(prompt).toContain("[P1] 0.0164 rrf · keyword#1 · author: other · news: Doc");
    expect(prompt).toContain('[P2] - · fallback "X-90" · author: unknown · news: Doc');
    expect(buildAskPrompt("q", searchResult())).toContain("Passages:\n(none)");
  });

  it("passes weak evidence on to the model, and tells it what weak evidence means", () => {
    const weak = searchResult({ topScore: 0.47, evidence: { level: "weak", basis: "rerank", threshold: 0.56 }, passages: [passage({ score: 0.47 })] });
    expect(buildAskPrompt("q", weak)).toContain(
      "Search mode: hybrid\nEvidence: weak (the top rerank score 0.47 is below 0.56: these passages may not hold the answer; if none of them states it, say the knowledge base does not have it)",
    );
    expect(buildAskPrompt("q", searchResult())).not.toContain("Evidence:");
    expect(ASK_SYSTEM).toContain("When the evidence is weak, answer only what a passage states outright; otherwise say the knowledge base does not hold the answer.");
  });

  it("shows a ranked passage the graph also reached with its ranks and the entity", () => {
    const both = passage({ layers: ["vector", "keyword", "graph"], viaEntity: { id: "n1", name: "Acme Corp" } });
    expect(buildAskPrompt("q", searchResult({ passages: [both] }))).toContain("[P1] 0.76 rerank · vector#2 keyword#5 graph via Acme Corp · author: other · news: Doc");
  });

  it("keeps the rule that the answer comes only from the material, and says how to weigh it", () => {
    expect(ASK_SYSTEM).toContain("using only the passages and facts provided");
    expect(ASK_SYSTEM).toContain("Never state anything the material does not support.");
    expect(ASK_SYSTEM).toContain("When the search mode is not hybrid, or every score is low, say the evidence is weak.");
  });
});
