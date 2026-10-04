import { describe, it, expect, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TEST_DATABASE_URL } from "./helpers.js";
import { renderSheet } from "../../src/eval/review.js";
import type { Draft } from "../../src/eval/draft.js";

const run = promisify(execFile);

/** Runs `brain eval …` with every database URL on brain_test, which the eval commands that write refuse (not *_eval). */
async function brainEval(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("node_modules/.bin/tsx", ["src/cli.ts", "eval", ...args], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, EVAL_DATABASE_URL: TEST_DATABASE_URL, EVAL_REAL_DATABASE_URL: TEST_DATABASE_URL, OBSIDIAN_AUTO: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

const doc = { id: "0b9c6a38-1111-4222-8333-444455556666", origin: "eval/corpus/note--garden-plan.md", title: "Garden plan", source_kind: "note", author: "owner" };
const draft = (id: string, question: string, kind = "keyword"): Draft => ({
  draft_id: id, corpus: "fixtures", kind: kind as Draft["kind"], question, quote: kind === "negative" ? null : "I planted 40 tulip bulbs",
  paraphrases: kind === "negative" ? [] : ["p one", "p two"], document: doc, drafted_at: "2026-10-03T12:00:00.000Z", model: "fake", sheet: "eval/review/2026-10-03-1.md",
});

let dir: string;
let drafts: string;
let golden: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eval-cli-"));
  drafts = join(dir, "drafts.jsonl");
  golden = join(dir, "golden.jsonl");
  await writeFile(drafts, [draft("d-aaaaaaaaaa", "How many tulip bulbs did I plant?"), draft("d-bbbbbbbbbb", "What colour were the tulips?", "negative")].map((d) => JSON.stringify(d)).join("\n") + "\n");
  await writeFile(golden, "");
});

describe("brain eval drafts, reject, approve (CLI)", () => {
  it("lists pending drafts with their document and sheet", async () => {
    const r = await brainEval(["drafts", "--drafts", drafts]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("d-aaaaaaaaaa  fixtures keyword     note--garden-plan.md\n    How many tulip bulbs did I plant?\n    sheet eval/review/2026-10-03-1.md");
    expect(r.stdout).toContain("d-bbbbbbbbbb  fixtures negative    none (negative question, drafted from note--garden-plan.md)");
    expect(r.stdout.trim().endsWith("2 pending")).toBe(true);
  });

  it("rejects drafts by id and exits 1 naming an id that is not pending", async () => {
    const r = await brainEval(["reject", "--id", "d-aaaaaaaaaa", "d-cccccccccc", "--drafts", drafts]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("rejected 1; 1 drafts pending");
    expect(r.stderr).toContain("no pending draft d-cccccccccc");
    expect((await readFile(drafts, "utf8")).trim().split("\n").map((l) => JSON.parse(l).draft_id)).toEqual(["d-bbbbbbbbbb"]);
  });

  it("applies a sheet of rejections without opening an eval database, and reports a malformed sheet without changing anything", async () => {
    const sheet = join(dir, "2026-10-03-1.md");
    const text = renderSheet([draft("d-aaaaaaaaaa", "How many tulip bulbs did I plant?"), draft("d-bbbbbbbbbb", "What colour were the tulips?", "negative")], { sheet, corpus: "fixtures", model: "fake", day: "2026-10-03", documents: 1 });
    await writeFile(sheet, text.replace("decision:\nkind: keyword", "decision: maybe\nkind: keyword"));
    const bad = await brainEval(["approve", "--sheet", sheet, "--drafts", drafts, "--golden", golden]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain(`${sheet}:17: decision must be keep, edit, reject or empty; got "maybe"`);
    await writeFile(sheet, text.replace(/^decision:$/gm, "decision: reject"));
    const ok = await brainEval(["approve", "--sheet", sheet, "--drafts", drafts, "--golden", golden]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("approved 0 (0 edited), rejected 2, undecided 0, already applied 0");
    expect(ok.stdout).toContain(`${golden} now has 0 items: 0 approved by the owner, 0 written by an agent`);
    expect(await readFile(drafts, "utf8")).toBe("");
  });

  it("lists and rejects real drafts from the gitignored drafts-real.jsonl next to drafts.jsonl, leaving each file to its corpus", async () => {
    const realDrafts = join(dir, "drafts-real.jsonl");
    const real: Draft = { ...draft("d-dddddddddd", "When is the plumber coming?"), corpus: "real", sheet: "eval/review/real/2026-10-03-1.md" };
    await writeFile(realDrafts, JSON.stringify(real) + "\n");
    const list = await brainEval(["drafts", "--drafts", drafts]);
    expect(list.stdout).toContain("d-dddddddddd  real     keyword     Garden plan (0b9c6a38-1111-4222-8333-444455556666)\n    When is the plumber coming?\n    sheet eval/review/real/2026-10-03-1.md");
    expect(list.stdout.trim().endsWith("3 pending")).toBe(true);
    const r = await brainEval(["reject", "--id", "d-dddddddddd", "d-aaaaaaaaaa", "--drafts", drafts]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("rejected 2; 1 drafts pending");
    expect(await readFile(realDrafts, "utf8")).toBe("");
    expect((await readFile(drafts, "utf8")).trim().split("\n").map((l) => JSON.parse(l).draft_id)).toEqual(["d-bbbbbbbbbb"]);
  });
});
