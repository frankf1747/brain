import { describe, it, expect } from "vitest";
import { renderSearch } from "../../src/mcp/render.js";
import { SearchOutputSchema, toSearchOutput, type SearchResult } from "../../src/retrieve/contract.js";
import { config } from "../../src/config.js";
import { passage, fact, searchResult } from "./search-fixture.js";

/** About what an MCP client such as Claude Code accepts from one tool call before truncating it (25,000 tokens). */
const OUTPUT_BUDGET_BYTES = 100_000;

const id = (prefix: string, i: number) => `${prefix}${i}`.padEnd(36, "0");

/**
 * The largest brain_search result: k=30 hybrid passages plus 25 graph passages (5 entities × 5 passages), each at the
 * passage cap (passageTokens × 4 characters, the chunker's estimate), 10 facts, and 5 entities with 20 neighbours each.
 */
function worstCase(k = 30): SearchResult {
  const body = "x".repeat(config.chunking.passageTokens * 4);
  const title = "A realistic document title of about sixty characters, ok";
  const hybrid = Array.from({ length: k }, (_, i) =>
    passage({ chunkId: id("c", i), documentId: id("d", i), title, headingPath: ["Section heading", "Subsection"], content: body }));
  const graph = Array.from({ length: config.graph.maxEntities * config.graph.maxPassagesPerEntity }, (_, i) =>
    passage({
      chunkId: id("g", i), documentId: id("e", i), title, headingPath: ["Section heading"], content: body, score: null, scoreKind: "none",
      layers: ["graph"], vectorRank: null, keywordRank: null, rerankRank: null, viaEntity: { id: id("n", 0), name: "Acme Corp" },
    }));
  return searchResult({
    k,
    passages: [...hybrid, ...graph],
    facts: Array.from({ length: config.graph.maxFacts }, (_, i) => fact({ id: id("f", i) })),
    entities: Array.from({ length: config.graph.maxEntities }, (_, i) => ({
      id: id("n", i), type: "organization", name: "Acme Corp", matchedSpan: "acme corp",
      neighbors: Array.from({ length: config.graph.maxNeighbors }, (_, j) => ({ id: id("m", j), type: "person", name: "Priya Natarajan", depth: 1 })),
    })),
  });
}

const bytes = (s: string) => Buffer.byteLength(s);

describe("brain_search output size at k=30 with graph passages", () => {
  const r = worstCase();
  const text = bytes(renderSearch(r));

  it("is over the budget when structuredContent repeats every passage's text, which is why it no longer does", () => {
    expect(r.passages).toHaveLength(55);
    expect(text + bytes(JSON.stringify(r))).toBeGreaterThan(OUTPUT_BUDGET_BYTES);
  });

  it("structuredContent leaves passage text out and still validates against the advertised schema", () => {
    const out = toSearchOutput(r);
    expect(SearchOutputSchema.parse(out)).toEqual(out);
    expect(out.passages.every((p) => !("content" in p))).toBe(true);
    expect(out.passages.map((p) => p.chunkId)).toEqual(r.passages.map((p) => p.chunkId));
    // The saving is the passage text: more than 85 KB on this result.
    expect(bytes(JSON.stringify(r)) - bytes(JSON.stringify(out))).toBeGreaterThan(85_000);
  });

  it("at k=30 the text alone is over the budget (the README says so); at the default k=10 the whole output fits", () => {
    expect(text).toBeGreaterThan(OUTPUT_BUDGET_BYTES);
    const d = worstCase(config.retrieval.defaultK);
    expect(d.passages).toHaveLength(35);
    expect(bytes(renderSearch(d)) + bytes(JSON.stringify(toSearchOutput(d)))).toBeLessThan(OUTPUT_BUDGET_BYTES);
  });
});
