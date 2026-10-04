import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseGolden } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace } from "../../src/eval/run.js";

// The committed file holds fixtures items only: real-corpus items quote private documents and stay in eval/golden-real.jsonl.
const golden = async () => parseGolden(await readFile("eval/golden.jsonl", "utf8"), "fixtures");
const fixture = async (origin: string) => splitFrontMatter(await readFile(`eval/corpus/${origin}`, "utf8"));

describe("eval/golden.jsonl against eval/corpus", () => {
  it("every quote appears verbatim in its fixture once front matter is stripped", async () => {
    for (const item of await golden()) {
      for (const e of item.expected) {
        if (!e.origin || !e.quote) continue;
        const { body } = await fixture(e.origin);
        expect([item.id, normalizeWhitespace(body).includes(normalizeWhitespace(e.quote))]).toEqual([item.id, true]);
      }
    }
  });
  it("every fixtures item names files that exist in eval/corpus, and every real item names documents by id", async () => {
    const files = new Set(await readdir("eval/corpus"));
    for (const item of await golden()) {
      for (const e of item.expected) {
        if (item.corpus === "fixtures") expect([item.id, files.has(e.origin!)]).toEqual([item.id, true]);
        else expect([item.id, typeof e.document_id]).toEqual([item.id, "string"]);
      }
    }
  });
  it("has at least three attribution items, each naming a fixture marked author: other, and a negative item", async () => {
    const items = await golden();
    const attribution = items.filter((i) => i.kind === "attribution");
    expect(attribution.length).toBeGreaterThanOrEqual(3);
    for (const a of attribution) {
      for (const e of a.expected) expect([a.id, (await fixture(e.origin!)).author]).toEqual([a.id, "other"]);
    }
    expect(items.some((i) => i.negative)).toBe(true);
  });
  it("keeps real-corpus items, drafts and review sheets out of git, since the repository is public", async () => {
    const ignored = (await readFile(".gitignore", "utf8")).split("\n").map((l) => l.trim());
    expect(ignored).toEqual(expect.arrayContaining(["eval/golden-real.jsonl", "eval/drafts-real.jsonl", "eval/review/real/"]));
  });
  it("git ignores every private path and none of the committed eval files", () => {
    const ignored = (path: string) => spawnSync("git", ["check-ignore", "-q", "--no-index", path]).status === 0;
    for (const p of ["eval/golden-real.jsonl", "eval/drafts-real.jsonl", "eval/review/real/2026-10-03-1.md", "eval/review/real/x/y.md"]) {
      expect([p, ignored(p)]).toEqual([p, true]);
    }
    for (const p of ["eval/golden.jsonl", "eval/drafts.jsonl", "eval/review/2026-10-03-1.md", "eval/baseline-real.json", "eval/baseline.json"]) {
      expect([p, ignored(p)]).toEqual([p, false]);
    }
  });
});
