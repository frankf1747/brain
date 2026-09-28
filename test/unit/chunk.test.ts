import { describe, it, expect } from "vitest";
import { chunkDocument, headingBlocks } from "../../src/ingest/chunk.js";

const small = { sectionTokens: 1000, passageTokens: 20, overlapRatio: 0.5 };

function sentences(n: number): string {
  return Array.from({ length: n }, (_, i) => `Sentence number ${i} is here.`).join(" ");
}

describe("headingBlocks", () => {
  it("tracks the heading stack and drops empty blocks", () => {
    const text = "# A\n\nfirst\n\n## B\n\nsecond\n\n# C\n\nthird\n";
    const blocks = headingBlocks(text);
    expect(blocks.map((b) => b.headingPath)).toEqual([["A"], ["A", "B"], ["C"]]);
    expect(blocks.map((b) => text.slice(b.start, b.end).trim())).toEqual(["first", "second", "third"]);
  });
  it("treats a document without headings as one block", () => {
    expect(headingBlocks("just text").length).toBe(1);
  });
});

describe("chunkDocument", () => {
  it("round-trips every chunk to the exact original substring", () => {
    const text = `# Title\n\n${sentences(30)}\n\n## Part two\n\n${sentences(30)}\n`;
    for (const c of chunkDocument(text, small)) {
      expect(text.slice(c.charStart, c.charEnd)).toBe(c.content);
      expect(c.content.trim()).toBe(c.content);
    }
  });

  it("gives passages their section as parent and inherits heading paths", () => {
    const text = `# Title\n\n${sentences(10)}\n\n## Part two\n\n${sentences(10)}\n`;
    const drafts = chunkDocument(text, small);
    const sections = drafts.filter((d) => d.level === 0);
    const passages = drafts.filter((d) => d.level === 1);
    expect(sections.length).toBe(2);
    expect(sections[1].headingPath).toEqual(["Title", "Part two"]);
    for (const p of passages) {
      const parent = sections.find((s) => s.ordinal === p.parentOrdinal)!;
      expect(p.charStart).toBeGreaterThanOrEqual(parent.charStart);
      expect(p.charEnd).toBeLessThanOrEqual(parent.charEnd);
      expect(p.headingPath).toEqual(parent.headingPath);
    }
  });

  it("overlaps consecutive passages within a section", () => {
    const drafts = chunkDocument(sentences(40), small).filter((d) => d.level === 1);
    expect(drafts.length).toBeGreaterThan(3);
    for (let i = 1; i < drafts.length; i++) {
      expect(drafts[i].charStart).toBeLessThan(drafts[i - 1].charEnd);
      expect(drafts[i].charStart).toBeGreaterThan(drafts[i - 1].charStart);
    }
  });

  it("hard-splits a run of text with no sentence boundaries", () => {
    const blob = "x".repeat(1000);
    const passages = chunkDocument(blob, small).filter((d) => d.level === 1);
    expect(passages.length).toBeGreaterThan(1);
    for (const p of passages) expect(p.content.length).toBeLessThanOrEqual(small.passageTokens * 4);
    expect(passages.map((p) => p.content).join("")).toBe(blob);
  });

  it("numbers passages globally and sections per document", () => {
    const drafts = chunkDocument(`# A\n\n${sentences(10)}\n\n# B\n\n${sentences(10)}`, small);
    const passageOrdinals = drafts.filter((d) => d.level === 1).map((d) => d.ordinal);
    expect(passageOrdinals).toEqual(passageOrdinals.map((_, i) => i));
  });
});
