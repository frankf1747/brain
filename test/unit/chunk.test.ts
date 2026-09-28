import { describe, it, expect } from "vitest";
import { chunkDocument, headingBlocks } from "../../src/ingest/chunk.js";
import { config } from "../../src/config.js";

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

describe("chunker edge cases", () => {
  it("bounds passage size by the full span, including whitespace between units", () => {
    const text = Array.from({ length: 400 }, (_, i) => `Cell ${i}.` + " ".repeat(200)).join("");
    const passages = chunkDocument(text, config.chunking).filter((d) => d.level === 1);
    expect(passages.length).toBeGreaterThan(1);
    for (const p of passages) expect(p.content.length).toBeLessThanOrEqual(config.chunking.passageTokens * 4);
  });

  it("trims hard-split pieces and never emits empty chunks", () => {
    const text = "word ".repeat(300) + " ".repeat(5000) + "word ".repeat(300);
    const drafts = chunkDocument(text, small);
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      expect(d.content.length).toBeGreaterThan(0);
      expect(d.content.trim()).toBe(d.content);
      expect(text.slice(d.charStart, d.charEnd)).toBe(d.content);
    }
  });

  it("keeps leading punctuation of a paragraph", () => {
    const text = "...and then he left. ?? what happened";
    const passages = chunkDocument(text, small).filter((d) => d.level === 1);
    const covered = new Set<number>();
    for (const p of passages) for (let k = p.charStart; k < p.charEnd; k++) covered.add(k);
    for (let k = 0; k < text.length; k++) {
      if (/\S/.test(text[k])) expect(covered.has(k), `char ${k} (${text[k]})`).toBe(true);
    }
  });

  it("ignores heading-like lines inside fenced code blocks", () => {
    const text = "# Setup\n\nRun this:\n\n```bash\n# install deps\nnpm install\n```\n\nThen done.";
    const blocks = headingBlocks(text);
    expect(blocks.map((b) => b.headingPath)).toEqual([["Setup"]]);
    const passages = chunkDocument(text, small).filter((d) => d.level === 1);
    expect(passages.some((p) => p.content.includes("# install deps"))).toBe(true);
  });
});
