import { describe, it, expect } from "vitest";
import { frontmatter, renderNode, renderDocument, renderReadme, type NodeView, type DocView } from "../../src/obsidian/render.js";

describe("frontmatter", () => {
  it("quotes strings, renders lists and dates, skips undefined", () => {
    const fm = frontmatter({ brain_id: "x", aliases: ['a"b', "c: d"], verified: false, when: new Date("2026-09-01T10:00:00Z"), nothing: undefined, tags: ["brain/node/person"] });
    expect(fm).toBe(`---\nbrain_id: "x"\naliases: ["a\\"b", "c: d"]\nverified: false\nwhen: 2026-09-01\ntags: ["brain/node/person"]\n---\n`);
  });
});

const node: NodeView = {
  id: "7b1e0000-0000-0000-0000-000000000000", type: "organization", name: "Acme Corp", noteName: "Acme Corp", aliases: ["acme"],
  properties: { possible_duplicate_of: "ACME Corporation" }, verified: false, isSelf: false,
  edges: [
    { direction: "out", type: "located_in", otherNoteName: "Austin", evidence: "Acme Corp announced … Austin", evidenceDocNoteName: "Acme raises Series B" },
    { direction: "in", type: "applied_to", otherNoteName: "Frank Fu", evidence: null, evidenceDocNoteName: null },
  ],
  mentionedIn: [{ docNoteName: "Acme raises Series B", kind: "news", date: "2026-03-12" }],
  facts: [],
};

describe("renderNode", () => {
  it("writes frontmatter, read-only notice, relationships as wikilinks, mentions and properties", () => {
    const t = renderNode(node);
    expect(t.startsWith("---\n")).toBe(true);
    expect(t).toContain('brain_type: "organization"');
    expect(t).toContain("brain_managed: true");
    expect(t).toContain('tags: ["brain/node/organization", "brain/unverified"]');
    expect(t).toContain("# Acme Corp");
    expect(t).toContain("Read-only");
    expect(t).toContain('- located_in → [[Austin]] · "Acme Corp announced … Austin" ([[Acme raises Series B]])');
    expect(t).toContain("- applied_to ← [[Frank Fu]]");
    expect(t).toContain("- [[Acme raises Series B]] (news, 2026-03-12)");
    expect(t).toContain("- possible_duplicate_of: ACME Corporation");
  });
  it("adds a Facts section for the self node", () => {
    const t = renderNode({ ...node, isSelf: true, name: "Frank Fu", noteName: "Frank Fu", facts: [{ predicate: "visa_status", objectText: "F-1 OPT", verified: false, by: "extractor:opus", docNoteName: "Prep call" }] });
    expect(t).toContain("## Facts");
    expect(t).toContain("- visa_status: F-1 OPT (unverified, extractor:opus, from [[Prep call]])");
  });
  it("escapes quotes and colons in name and aliases, and keeps multi-line evidence on one line", () => {
    const t = renderNode({
      ...node,
      name: 'Acme "Best": Corp',
      aliases: ['Acme "Best": Corp', "a: b"],
      edges: [{ direction: "out", type: "located_in", otherNoteName: "Austin", evidence: 'line one\nline "two"\n\n  line three', evidenceDocNoteName: null }],
    });
    const fm = t.split("---\n")[1];
    const aliasLine = fm.split("\n").find((l) => l.startsWith("aliases: "))!;
    expect(aliasLine).toBe('aliases: ["Acme \\"Best\\": Corp", "a: b"]');
    expect(JSON.parse(aliasLine.slice("aliases: ".length))).toEqual(['Acme "Best": Corp', "a: b"]);
    expect(t).toContain('# Acme "Best": Corp');
    const rel = t.split("\n").find((l) => l.startsWith("- located_in"))!;
    expect(rel).toBe('- located_in → [[Austin]] · "line one line "two" line three"');
  });
});

describe("renderDocument", () => {
  const doc: DocView = {
    id: "3f2a0000-0000-0000-0000-000000000000", noteName: "Acme raises Series B", title: "Acme raises Series B", kind: "news", origin: "https://x.test/a",
    occurredAt: new Date("2026-03-12T00:00:00Z"), ingestedAt: new Date("2026-09-27T00:00:00Z"), summary: "Acme raised $40M.", entityNoteNames: ["Acme Corp", "Beta Ventures"], raw: "Full text here.",
  };
  it("renders metadata, summary, entity links and the raw text", () => {
    const t = renderDocument(doc);
    expect(t).toContain('brain_kind: "news"');
    expect(t).toContain("occurred_at: 2026-03-12");
    expect(t).toContain("**Entities.** [[Acme Corp]] · [[Beta Ventures]]");
    expect(t.trim().endsWith("Full text here.")).toBe(true);
  });
  it("truncates very long raw text with a pointer to the id", () => {
    const t = renderDocument({ ...doc, raw: "y".repeat(250_000) }, 1000);
    expect(t).toContain("truncated");
    expect(t).toContain(doc.id);
    expect(t.length).toBeLessThan(3000);
  });
});

describe("renderReadme", () => {
  it("lists counts and the timestamp", () => {
    const t = renderReadme({ nodes: 5, documents: 2 }, new Date("2026-09-27T12:00:00Z"));
    expect(t).toContain("5 entity notes");
    expect(t).toContain("2026-09-27T12:00:00.000Z");
    expect(t).toContain("path:Brain/nodes/person");
  });
});
