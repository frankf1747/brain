import { describe, it, expect } from "vitest";
import { decide, locateQuote, normalizePredicate } from "../../src/ingest/stages/resolve.js";

describe("decide", () => {
  const t = { matchThreshold: 0.92, flagThreshold: 0.85 };
  it("creates when there are no candidates", () => {
    expect(decide([], t)).toEqual({ action: "create", possibleDuplicateOf: null });
  });
  it("matches at or above the match threshold", () => {
    expect(decide([{ id: "a", similarity: 0.5 }, { id: "b", similarity: 0.93 }], t)).toEqual({ action: "match", nodeId: "b" });
  });
  it("creates but flags in the grey zone", () => {
    expect(decide([{ id: "a", similarity: 0.88 }], t)).toEqual({ action: "create", possibleDuplicateOf: "a" });
  });
  it("creates cleanly below the flag threshold", () => {
    expect(decide([{ id: "a", similarity: 0.6 }], t)).toEqual({ action: "create", possibleDuplicateOf: null });
  });
});

describe("locateQuote", () => {
  const chunks = [
    { id: "c1", content: "First passage about nothing." },
    { id: "c2", content: "Acme   Corp announced\na round led by Beta Ventures." },
  ];
  it("finds a quote ignoring case and whitespace differences and returns original offsets", () => {
    const loc = locateQuote(chunks, "acme corp announced a round")!;
    expect(loc.chunkId).toBe("c2");
    expect(chunks[1].content.slice(loc.start, loc.end)).toBe("Acme   Corp announced\na round");
  });
  it("falls back to the first 40 characters, then null", () => {
    expect(locateQuote(chunks, "led by Beta Ventures and then something the model made up")!.chunkId).toBe("c2");
    expect(locateQuote(chunks, "completely absent")).toBeNull();
  });
});

describe("normalizePredicate", () => {
  it("makes lowercase snake_case", () => {
    expect(normalizePredicate(" Visa Status ")).toBe("visa_status");
    expect(normalizePredicate("graduated-from!")).toBe("graduated_from");
  });
});

describe("locateQuote prefix fallback", () => {
  it("does not accept a short generic prefix that lands in the wrong passage", () => {
    const chunks = [
      { id: "p1", content: "The company said hello." },
      { id: "p2", content: "They told me the company said nothing about sponsorship." },
    ];
    expect(locateQuote(chunks, "the company said they would sponsor")).toBeNull();
  });
  it("accepts a full-quote match in the passage that contains it", () => {
    const chunks = [
      { id: "p1", content: "The company said hello." },
      { id: "p2", content: "Later the company said they would sponsor me." },
    ];
    expect(locateQuote(chunks, "the company said they would sponsor")!.chunkId).toBe("p2");
  });
  it("rejects a prefix that more than one passage contains", () => {
    const chunks = [
      { id: "p1", content: "At first the company said they were hiring." },
      { id: "p2", content: "Later the company said they might reconsider." },
    ];
    expect(locateQuote(chunks, "the company said they would sponsor")).toBeNull();
  });
});
