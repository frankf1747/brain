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
  it("throws when the opening fence has no closing fence, instead of storing the block as body text", () => {
    expect(() => splitFrontMatter("---\nauthor: other\n# Title\n\nBody.\n")).toThrow("front matter: the opening --- has no closing --- line");
    expect(() => splitFrontMatter("---\r\nauthor: other\r\nText")).toThrow(/no closing/);
  });
  it("accepts trailing spaces or tabs after the opening fence, as the no-closing-fence check does", () => {
    expect(splitFrontMatter("--- \nauthor: other\n---\nText")).toEqual({ author: "other", body: "Text" });
    expect(splitFrontMatter("---\t\r\nauthor: owner\r\n---\r\nText")).toEqual({ author: "owner", body: "Text" });
    expect(() => splitFrontMatter("---  \nauthor: other\nText")).toThrow(/no closing/);
  });
  it("accepts an empty block", () => {
    expect(splitFrontMatter("---\n---\nText")).toEqual({ author: undefined, body: "Text" });
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
