import { describe, it, expect } from "vitest";
import { candidateSpans, dropContainedSpans, rankEntities } from "../../src/retrieve/entities.js";

describe("candidateSpans", () => {
  it("returns every 1- to 6-token span that does not start or end with a stopword, plus quoted strings", () => {
    const spans = candidateSpans('who works at acme corp and "beta ventures"?');
    expect(spans).toContain("beta ventures");
    expect(spans).toContain("acme corp");
    expect(spans).toContain("acme");
    expect(spans).toContain("corp");
    expect(spans).not.toContain("at acme");
    expect(spans).not.toContain("corp and");
    expect(spans).not.toContain("who");
  });
  it("is case-insensitive and strips possessives", () => {
    expect(candidateSpans("Who led Acme's Series B?")).toEqual(expect.arrayContaining(["Acme", "Series B", "Acme Series B", "Series", "B"]));
  });
  it("includes spans up to six tokens, with interior stopwords", () => {
    expect(candidateSpans("what did i learn at ucla anderson school of management")).toContain("ucla anderson school of management");
  });
  it("allows a leading 'the' on spans of two or more tokens", () => {
    const spans = candidateSpans("does the home depot hire");
    expect(spans).toContain("the home depot");
    expect(spans).not.toContain("the");
  });
  it("returns nothing for a stopword-only query", () => {
    expect(candidateSpans("what is the")).toEqual([]);
  });
});

describe("dropContainedSpans", () => {
  it("keeps the longest matched span and drops matches contained in it", () => {
    const kept = dropContainedSpans([
      { id: "1", type: "organization", name: "Databricks", matchedSpan: "databricks" },
      { id: "2", type: "concept", name: "Databricks cost governance", matchedSpan: "databricks cost governance" },
      { id: "3", type: "place", name: "Austin", matchedSpan: "austin" },
    ]);
    expect(kept.map((k) => k.id)).toEqual(["2", "3"]);
  });
  it("keeps one entry per node, with the longest span", () => {
    const kept = dropContainedSpans([
      { id: "1", type: "organization", name: "Acme", matchedSpan: "acme" },
      { id: "1", type: "organization", name: "Acme", matchedSpan: "acme corp" },
    ]);
    expect(kept).toEqual([{ id: "1", type: "organization", name: "Acme", matchedSpan: "acme corp" }]);
  });
});

describe("dropContainedSpans: boundaries", () => {
  const ref = (id: string, matchedSpan: string) => ({ id, type: "concept", name: id, matchedSpan });
  it("keeps overlapping spans that are not nested", () => {
    const kept = dropContainedSpans([ref("1", "acme corp"), ref("2", "corp ventures")]);
    expect(kept.map((k) => k.id).sort()).toEqual(["1", "2"]);
  });
  it("keeps the longest span when one node matched two disjoint spans", () => {
    const kept = dropContainedSpans([ref("1", "acme"), ref("1", "beta ventures")]);
    expect(kept).toEqual([ref("1", "beta ventures")]);
  });
  it("matches on word boundaries: 'cost' is not contained in 'databricks costs'", () => {
    const kept = dropContainedSpans([ref("1", "cost"), ref("2", "databricks costs")]);
    expect(kept.map((k) => k.id).sort()).toEqual(["1", "2"]);
  });
});

describe("rankEntities", () => {
  const ref = (name: string, matchedSpan: string) => ({ id: name, type: "concept", name, matchedSpan });
  it("prefers longer matched spans, then name, and caps the count", () => {
    const ranked = rankEntities([ref("b", "one"), ref("a", "one"), ref("c", "one two three"), ref("d", "one two")], 3);
    expect(ranked.map((r) => r.name)).toEqual(["c", "d", "a"]);
  });
});
