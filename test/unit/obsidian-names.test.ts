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

describe("macOS-like name folding", () => {
  const at = (id: string, name: string, day: number) => ({ id, name, createdAt: new Date(2026, 0, day) });

  it("collides NFC and NFD forms and ß with SS", () => {
    const m = uniqueNames([
      at("aaaaaaaa-1", "éclair", 1),
      at("bbbbbbbb-1", "éclair", 2),
      at("cccccccc-1", "Straße", 3),
      at("dddddddd-1", "STRASSE", 4),
    ]);
    expect(m.get("aaaaaaaa-1")).toBe("éclair");
    expect(m.get("bbbbbbbb-1")).toBe("éclair (bbbbbbbb)");
    expect(m.get("cccccccc-1")).toBe("Straße");
    expect(m.get("dddddddd-1")).toBe("STRASSE (dddddddd)");
  });

  it("returns NFC names", () => {
    expect(sanitizeName("éclair")).toBe("éclair");
  });

  it("strips leading dots and neutralises attachment-like extensions", () => {
    expect(sanitizeName(".hidden")).toBe("hidden");
    expect(sanitizeName("...")).toBe("untitled");
    expect(sanitizeName("Resume.pdf")).toBe("Resume pdf");
    expect(sanitizeName("notes.md")).toBe("notes md");
    expect(sanitizeName("v1.2 notes")).toBe("v1.2 notes");
    expect(sanitizeName("v1.2")).toBe("v1.2");
  });
});

describe("sanitizeName truncation", () => {
  it("never splits an astral character", () => {
    const out = sanitizeName("😀".repeat(200));
    expect([...out].length).toBe(120);
    expect(out).toBe("😀".repeat(120));
  });
});
