import { describe, it, expect } from "vitest";
import { sanitizeName, uniqueNames } from "../../src/obsidian/names.js";

describe("sanitizeName", () => {
  it("removes characters that break file names or wikilinks", () => {
    expect(sanitizeName('Acme: "Q3" [draft] #1 | a/b\\c')).toBe("Acme Q3 draft 1 a b c");
    expect(sanitizeName("   ")).toBe("untitled");
    expect(sanitizeName("ends with dots...")).toBe("ends with dots");
    expect(sanitizeName("x".repeat(200)).length).toBe(120);
  });
});

describe("uniqueNames", () => {
  it("keeps the oldest name plain and suffixes later collisions", () => {
    const m = uniqueNames([
      { id: "bbbbbbbb-1", name: "Acme Corp", createdAt: new Date("2026-02-01") },
      { id: "aaaaaaaa-1", name: "acme corp", createdAt: new Date("2026-01-01") },
      { id: "cccccccc-1", name: "Other", createdAt: new Date("2026-03-01") },
    ]);
    expect(m.get("aaaaaaaa-1")).toBe("acme corp");
    expect(m.get("bbbbbbbb-1")).toBe("Acme Corp (bbbbbbbb)");
    expect(m.get("cccccccc-1")).toBe("Other");
  });
});

describe("uniqueNames reserved names", () => {
  it("suffixes anything whose key equals a reserved name, even the oldest", () => {
    const m = uniqueNames(
      [
        { id: "aaaaaaaa-1", name: "readme", createdAt: new Date("2026-01-01") },
        { id: "bbbbbbbb-1", name: "README", createdAt: new Date("2026-02-01") },
        { id: "cccccccc-1", name: "Other", createdAt: new Date("2026-03-01") },
      ],
      ["README"],
    );
    expect(m.get("aaaaaaaa-1")).toBe("readme (aaaaaaaa)");
    expect(m.get("bbbbbbbb-1")).toBe("README (bbbbbbbb)");
    expect(m.get("cccccccc-1")).toBe("Other");
  });
});
