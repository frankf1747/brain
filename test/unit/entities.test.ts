import { describe, it, expect } from "vitest";
import { candidateSpans, dropContainedSpans } from "../../src/retrieve/entities.js";

describe("candidateSpans", () => {
  it("returns every 1- to 3-token span that does not start or end with a stopword, plus quoted strings", () => {
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
