import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseGolden, approvalCounts, GOLDEN_KINDS } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace, kindFromFilename } from "../../src/eval/run.js";
import { defaultAuthor } from "../../src/ingest/author.js";

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
  it("has at least five attribution items, each naming a fixture the owner did not write (front matter or its kind's default), and a negative item", async () => {
    const items = await golden();
    const attribution = items.filter((i) => i.kind === "attribution");
    expect(attribution.length).toBeGreaterThanOrEqual(5);
    for (const a of attribution) {
      for (const e of a.expected) expect([a.id, (await fixture(e.origin!)).author ?? defaultAuthor(kindFromFilename(e.origin!))]).toEqual([a.id, "other"]);
    }
    expect(items.some((i) => i.negative)).toBe(true);
  });
  it("meets the Phase 6 target (spec §8.3): at least 60 items, 10 negative, 5 attribution, every kind, and the owner's approvals", async () => {
    const items = await golden();
    const count = (kind: string) => items.filter((i) => i.kind === kind).length;
    expect({
      items: items.length >= 60,
      negative: count("negative") >= 10,
      attribution: count("attribution") >= 5,
      everyKind: GOLDEN_KINDS.every((k) => count(k) > 0),
      ownerApproved: approvalCounts(items).owner > 0,
      generatedOrCapturedByOwner: items.filter((i) => i.source !== "fixture").every((i) => i.approved_by === "owner"),
    }).toEqual({ items: true, negative: true, attribution: true, everyKind: true, ownerApproved: true, generatedOrCapturedByOwner: true });
  });
  it("keeps real-corpus items, drafts and review sheets out of git, since the repository is public", async () => {
    const ignored = (await readFile(".gitignore", "utf8")).split("\n").map((l) => l.trim());
    expect(ignored).toEqual(expect.arrayContaining(["eval/golden-real.jsonl", "eval/drafts-real.jsonl", "eval/review/real/", "eval/**/*-real.jsonl", "eval/**/real/"]));
  });
  it("git ignores every private path and none of the committed eval files", () => {
    const ignored = (path: string) => spawnSync("git", ["check-ignore", "-q", "--no-index", path]).status === 0;
    for (const p of [
      "eval/golden-real.jsonl", "eval/drafts-real.jsonl", "eval/review/real/2026-10-03-1.md", "eval/review/real/x/y.md",
      // Any renamed real-corpus file (eval/**/*-real.jsonl), e.g. from --golden or --drafts.
      "eval/golden-v2-real.jsonl", "eval/drafts-x-real.jsonl", "eval/tmp/sub/golden-real.jsonl",
      // Any real/ directory under eval/, e.g. from --review-dir.
      "eval/review-x/real/a.md", "eval/foo/real/b.md",
    ]) {
      expect([p, ignored(p)]).toEqual([p, true]);
    }
    for (const p of ["eval/golden.jsonl", "eval/drafts.jsonl", "eval/review/2026-10-03-1.md", "eval/baseline-real.json", "eval/baseline.json"]) {
      expect([p, ignored(p)]).toEqual([p, false]);
    }
  });
});
