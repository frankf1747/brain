import { describe, it, expect } from "vitest";
import { extractionSystem, extractionHeader, type Registries } from "../../src/ingest/stages/extract.js";

const reg: Registries = {
  nodeTypes: [{ name: "person", description: "A human being" }],
  edgeTypes: [{ name: "knows", description: "from person to person" }],
  selfName: "Frank Fu",
};

describe("extractionSystem", () => {
  it("owner: first-person pronouns are the owner (the rule as it was)", () => {
    const s = extractionSystem(reg, "owner");
    expect(s).toContain('The owner, Frank Fu, may appear as "I", "me", "my" or by name.');
    expect(s).toContain("facts_about_self: durable statements about the owner");
    expect(s).not.toContain("not the owner");
  });

  it("other: first-person pronouns are the author, who is not the owner; facts about the owner only when named", () => {
    const s = extractionSystem(reg, "other");
    expect(s).toContain("This document was written by someone other than the owner, Frank Fu.");
    expect(s).toContain('First-person pronouns ("I", "me", "my", "we", "our") refer to the document\'s author, who is not the owner.');
    expect(s).toContain("facts_about_self must be empty unless the text names the owner, Frank Fu, and states something about them");
    expect(s).toContain("Relations from the owner are allowed only when the text names the owner");
    expect(s).not.toContain('may appear as "I", "me", "my"');
  });

  it("unknown: treated as someone other than the owner", () => {
    const s = extractionSystem(reg, "unknown");
    expect(s).toContain("Who wrote this document is unknown; treat its author as someone other than the owner, Frank Fu.");
    expect(s).toContain("facts_about_self must be empty unless the text names the owner");
  });

  it("defaults to the owner rule", () => {
    expect(extractionSystem(reg)).toBe(extractionSystem(reg, "owner"));
  });
});

describe("extractionHeader", () => {
  it("lists title, kind, author, origin and summary line", () => {
    expect(extractionHeader({ title: "Post", source_kind: "note", author: "other", origin: "https://example.test/p", summary_line: "A post." })).toBe(
      "Document title: Post\nSource kind: note\nAuthor: other\nOrigin: https://example.test/p\nDocument summary: A post.",
    );
    expect(extractionHeader({ title: null, source_kind: "paste", author: "owner", origin: null, summary_line: null })).toBe(
      "Document title: (none)\nSource kind: paste\nAuthor: owner\nOrigin: (none)\nDocument summary: (none)",
    );
  });
});
