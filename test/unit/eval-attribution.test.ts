import { describe, it, expect } from "vitest";
import { splitFrontMatter, attributionGate } from "../../src/eval/run.js";

describe("splitFrontMatter", () => {
  it("reads the author and strips the block", () => {
    expect(splitFrontMatter("---\nauthor: other\n---\n# Title\n\nBody.\n")).toEqual({ author: "other", body: "# Title\n\nBody.\n" });
  });
  it("leaves text without front matter unchanged", () => {
    expect(splitFrontMatter("# Title\n---\nnot front matter\n")).toEqual({ author: undefined, body: "# Title\n---\nnot front matter\n" });
  });
  it("accepts quoted values, CRLF line ends and other keys", () => {
    expect(splitFrontMatter('---\r\ntags: x\r\nauthor: "Owner"\r\n---\r\nText')).toEqual({ author: "owner", body: "Text" });
  });
  it("rejects an author outside owner, other and unknown", () => {
    expect(() => splitFrontMatter("---\nauthor: me\n---\nx")).toThrow(/author must be one of/);
  });
});

describe("attributionGate", () => {
  it("passes at zero and fails otherwise", () => {
    expect(attributionGate({ selfFacts: 0, selfEdges: 0 })).toEqual([]);
    expect(attributionGate({ selfFacts: 2, selfEdges: 1 })).toEqual([
      "attribution: 2 facts about the owner and 1 edges from the owner come from documents the owner did not write; must be 0",
    ]);
    expect(attributionGate({ selfFacts: 0, selfEdges: 1 })).toHaveLength(1);
  });
});
