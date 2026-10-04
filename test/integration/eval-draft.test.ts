import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { FakeLlm } from "../../src/llm/llm.js";
import { draftDocuments, loadDrafts, toGoldenItem, DRAFT_SYSTEM, type DraftOutput } from "../../src/eval/draft.js";
import { approveSheetFile, parseSheet } from "../../src/eval/review.js";
import { loadGolden, validateGoldenItem } from "../../src/eval/golden.js";

const sql = testDb();
afterAll(() => sql.end());

const NOTE = "# Garden plan\n\nI planted 40 tulip bulbs along the north fence on 2026-03-14. The soil there drains slowly, so I mixed in two bags of grit.";
const EMAIL = "# Re: Northwind panel\n\nFrom: Sam Okafor\n\nHi Frank, your panel interview with the analytics team is booked for October 6 at 10:00 in Denver.";

/** The fake model: fixed questions per document, some of which must fail the checks. */
function model(fail: string[] = []) {
  return new FakeLlm(({ system, user }) => {
    if (system !== DRAFT_SYSTEM) throw new Error("unexpected call");
    if (fail.some((f) => user.includes(f))) throw new Error("model unavailable");
    if (user.includes("title: Garden plan")) {
      return {
        questions: [
          { kind: "keyword", question: "How many tulip bulbs did I plant by the fence?", quote: "I planted 40 tulip bulbs along the north fence", paraphrases: ["tulip bulb count", "How many bulbs went in along the fence?"] },
          { kind: "semantic", question: "Why did I add grit to the soil?", quote: "The soil there drains badly", paraphrases: ["reason for the grit", "Why mix grit into the bed?"] },
          { kind: "keyword", question: "Is it true I mixed in two bags of grit?", quote: "mixed in two bags of grit", paraphrases: ["grit bags", "How much grit went in?"] },
        ],
        negative: { question: "What colour were the tulips I planted?" },
      } satisfies DraftOutput;
    }
    return {
      questions: [
        { kind: "attribution", question: "When does Sam say my Northwind panel is?", quote: "booked for October 6 at 10:00 in Denver", paraphrases: ["Northwind panel date", "What day is the panel interview Sam set up?"] },
        { kind: "semantic", question: "When is my Northwind panel interview?", quote: "your panel interview with the analytics team", paraphrases: ["panel interview time", "When do I meet the Northwind analytics team?"] },
      ],
      negative: { question: "Who else is on the Northwind analytics team?" },
    } satisfies DraftOutput;
  });
}

let dir: string;
let paths: { goldenPath: string; draftsPath: string; reviewDir: string };
const now = new Date("2026-10-03T12:00:00Z");

beforeEach(async () => {
  await wipe(sql);
  const ingestCtx = fakeCtx(sql);
  await ingest(ingestCtx, { text: NOTE, title: "Garden plan", sourceKind: "note", origin: "eval/corpus/note--garden-plan.md" }, { until: "chunked" });
  await ingest(ingestCtx, { text: EMAIL, title: "Re: Northwind panel", sourceKind: "email", origin: "eval/corpus/email--northwind-panel.md" }, { until: "chunked" });
  dir = await mkdtemp(join(tmpdir(), "eval-draft-"));
  paths = { goldenPath: join(dir, "golden.jsonl"), draftsPath: join(dir, "drafts.jsonl"), reviewDir: join(dir, "review") };
  await writeFile(paths.goldenPath, JSON.stringify({
    // About another document, so it does not make the email count as covered; its question still blocks a duplicate.
    id: "q01", question: "When is my Northwind panel interview?", kind: "semantic", expected: [{ origin: "news--elsewhere.md" }],
    source: "fixture", approved_by: "agent", approved_at: "2026-09-30",
  }) + "\n");
});

describe("draftDocuments", () => {
  it("makes one model call per document, keeps the drafts that pass every check, and writes them to drafts.jsonl and a review sheet", async () => {
    const llm = model();
    const r = await draftDocuments({ ...fakeCtx(sql), llm }, { corpus: "fixtures", ...paths, now });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].user).toContain("Other documents in the corpus:\n- Garden plan [note]");
    expect(r.drafted).toEqual(["email--northwind-panel.md", "note--garden-plan.md"]);
    expect(r.rejected).toEqual([
      { document: "email--northwind-panel.md", question: "When is my Northwind panel interview?", reasons: ["duplicates q01"] },
      { document: "note--garden-plan.md", question: "Why did I add grit to the soil?", reasons: ["the quote is not in the document verbatim"] },
      { document: "note--garden-plan.md", question: "Is it true I mixed in two bags of grit?", reasons: ["the question contains its own answer quote"] },
    ]);
    expect(r.written.map((d) => [d.kind, d.question])).toEqual([
      ["attribution", "When does Sam say my Northwind panel is?"],
      ["negative", "Who else is on the Northwind analytics team?"],
      ["keyword", "How many tulip bulbs did I plant by the fence?"],
      ["negative", "What colour were the tulips I planted?"],
    ]);
    expect(r.sheet).toBe(join(paths.reviewDir, "2026-10-03-1.md"));
    expect((await loadDrafts(paths.draftsPath)).map((d) => d.draft_id)).toEqual(r.written.map((d) => d.draft_id));
    expect(r.written.every((d) => d.sheet === r.sheet && d.model === "fake" && d.drafted_at === now.toISOString())).toBe(true);
    // Drafted items are golden items waiting only for approval.
    for (const d of r.written) {
      const item = toGoldenItem(d, "2026-10-04", false);
      expect([d.draft_id, "errors" in item ? item.errors : validateGoldenItem(item).ok]).toEqual([d.draft_id, true]);
    }
    expect(parseSheet(await readFile(r.sheet!, "utf8")).map((s) => s.draftId)).toEqual(r.written.map((d) => d.draft_id));
  });

  it("skips documents that already have drafts or golden items, unless forced; a forced re-draft is caught as a duplicate", async () => {
    await draftDocuments({ ...fakeCtx(sql), llm: model() }, { corpus: "fixtures", ...paths, now });
    const again = model();
    const second = await draftDocuments({ ...fakeCtx(sql), llm: again }, { corpus: "fixtures", ...paths, now });
    expect(again.calls).toHaveLength(0);
    expect(second).toMatchObject({ skipped: ["email--northwind-panel.md", "note--garden-plan.md"], written: [], sheet: null });
    const forced = model();
    const third = await draftDocuments({ ...fakeCtx(sql), llm: forced }, { corpus: "fixtures", ...paths, now, force: true, docs: ["note--garden-plan.md"] });
    expect(forced.calls).toHaveLength(1);
    expect(third.written).toEqual([]);
    expect(third.rejected.find((x) => x.question === "How many tulip bulbs did I plant by the fence?")!.reasons).toEqual([expect.stringMatching(/^duplicates d-[0-9a-f]{10}$/)]);
  });

  it("reports a failed model call and goes on with the next document", async () => {
    const r = await draftDocuments({ ...fakeCtx(sql), llm: model(["title: Re: Northwind panel"]) }, { corpus: "fixtures", ...paths, now });
    expect(r.failed).toEqual([{ document: "email--northwind-panel.md", error: "model unavailable" }]);
    expect(r.drafted).toEqual(["note--garden-plan.md"]);
  });
});

describe("approveSheetFile", () => {
  it("applies the owner's decisions: keep and edit go into the golden set, reject drops the draft, the rest stay", async () => {
    const r = await draftDocuments({ ...fakeCtx(sql), llm: model() }, { corpus: "fixtures", ...paths, now });
    const [attribution, negEmail, keyword] = r.written;
    let text = await readFile(r.sheet!, "utf8");
    const set = (id: string, decision: string) => {
      text = text.replace(new RegExp(`(## ${id}\\n\\n[^\\n]*\\n)decision:`), `$1decision: ${decision}`);
    };
    set(attribution.draft_id, "keep");
    set(keyword.draft_id, "edit");
    set(negEmail.draft_id, "reject");
    text = text.replace("question: How many tulip bulbs did I plant by the fence?", "question: How many tulips went in along the north fence?");
    await writeFile(r.sheet!, text);

    const result = await approveSheetFile(r.sheet!, { ...paths, sql: () => sql, today: "2026-10-04" });
    expect(result.approved.map((a) => [a.id, a.edited])).toEqual([[attribution.draft_id, false], [keyword.draft_id, true]]);
    expect(result.rejected).toEqual([negEmail.draft_id]);
    expect(result.undecided).toHaveLength(1);
    const golden = await loadGolden(paths.goldenPath);
    expect(golden.map((g) => [g.id, g.source, g.approved_by])).toEqual([
      ["q01", "fixture", "agent"],
      [attribution.draft_id, "generated", "owner"],
      [keyword.draft_id, "generated", "owner"],
    ]);
    expect(golden[2]).toMatchObject({ question: "How many tulips went in along the north fence?", expected: [{ origin: "note--garden-plan.md", quote: "I planted 40 tulip bulbs along the north fence" }], approved_at: "2026-10-04", edited: true });
    expect((await loadDrafts(paths.draftsPath)).map((d) => d.draft_id)).toEqual(result.undecided);

    // Applying the same sheet again changes nothing.
    const again = await approveSheetFile(r.sheet!, { ...paths, sql: () => sql, today: "2026-10-04" });
    expect(again.approved).toEqual([]);
    expect(again.alreadyApplied.sort()).toEqual([attribution.draft_id, keyword.draft_id, negEmail.draft_id].sort());
    expect(await loadGolden(paths.goldenPath)).toHaveLength(3);
  });

  it("writes nothing when an edit breaks a check, here a question that duplicates a golden item by its stems", async () => {
    const r = await draftDocuments({ ...fakeCtx(sql), llm: model() }, { corpus: "fixtures", ...paths, now });
    const attribution = r.written[0];
    const text = (await readFile(r.sheet!, "utf8"))
      .replace(new RegExp(`(## ${attribution.draft_id}\\n\\n[^\\n]*\\n)decision:`), "$1decision: edit")
      .replace("question: When does Sam say my Northwind panel is?", "question: When's my Northwind panel interview?");
    await writeFile(r.sheet!, text);
    await expect(approveSheetFile(r.sheet!, { ...paths, sql: () => sql })).rejects.toThrow(`${attribution.draft_id} (line 14): duplicates q01`);
    expect(await loadGolden(paths.goldenPath)).toHaveLength(1);
    expect(await loadDrafts(paths.draftsPath)).toHaveLength(4);
  });
});

describe("real-corpus drafts (the repository is public)", () => {
  it("drafting a real document writes only drafts-real.jsonl and review/real/, and approving lands in golden-real.jsonl", async () => {
    const goldenBefore = await readFile(paths.goldenPath, "utf8");
    const r = await draftDocuments({ ...fakeCtx(sql), llm: model() }, { corpus: "real", ...paths, now });
    expect(r.written.length).toBeGreaterThan(0);
    expect(r.written.every((d) => d.corpus === "real")).toBe(true);
    expect(r.sheet).toBe(join(paths.reviewDir, "real", "2026-10-03-1.md"));
    expect((await readdir(dir)).sort()).toEqual(["drafts-real.jsonl", "golden.jsonl", "review"]);
    expect(await readdir(paths.reviewDir)).toEqual(["real"]);
    expect((await loadDrafts(join(dir, "drafts-real.jsonl"))).map((d) => d.draft_id)).toEqual(r.written.map((d) => d.draft_id));
    // The fixtures golden file is untouched, and its items still count for duplicates (loadGoldenAll).
    expect(await readFile(paths.goldenPath, "utf8")).toBe(goldenBefore);
    expect(r.rejected).toContainEqual(expect.objectContaining({ question: "When is my Northwind panel interview?", reasons: ["duplicates q01"] }));

    const keep = r.written.find((d) => d.kind !== "negative")!;
    const text = (await readFile(r.sheet!, "utf8")).replace(new RegExp(`(## ${keep.draft_id}\\n\\n[^\\n]*\\n)decision:`), "$1decision: keep");
    await writeFile(r.sheet!, text);
    const result = await approveSheetFile(r.sheet!, { ...paths, sql: () => sql, today: "2026-10-04" });
    expect(result.approved.map((a) => [a.id, a.corpus])).toEqual([[keep.draft_id, "real"]]);
    expect(await readFile(paths.goldenPath, "utf8")).toBe(goldenBefore);
    expect((await loadGolden(join(dir, "golden-real.jsonl"))).map((g) => g.id)).toEqual([keep.draft_id]);
    expect((await readdir(dir)).sort()).toEqual(["drafts-real.jsonl", "golden-real.jsonl", "golden.jsonl", "review"]);
  });

  it("refuses a sheet that mixes fixtures and real drafts, or a real draft in a fixtures sheet, and writes nothing", async () => {
    const fx = await draftDocuments({ ...fakeCtx(sql), llm: model() }, { corpus: "fixtures", ...paths, now, docs: ["note--garden-plan.md"] });
    const real = await draftDocuments({ ...fakeCtx(sql), llm: model() }, { corpus: "real", ...paths, now, docs: ["note--garden-plan.md"] });
    const realText = await readFile(real.sheet!, "utf8");
    const realSections = realText.slice(realText.indexOf("\n## d-"));
    const mixed = (await readFile(fx.sheet!, "utf8")) + realSections;
    await writeFile(fx.sheet!, mixed);
    const draftsBefore = await readFile(paths.draftsPath, "utf8");
    await expect(approveSheetFile(fx.sheet!, { ...paths, sql: () => sql })).rejects.toThrow(
      `${fx.sheet} mixes the fixtures and real corpora; approve each corpus's drafts from its own sheet`,
    );
    // A fixtures sheet holding only real drafts is refused too: real items never pass through eval/review/.
    const onlyReal = join(paths.reviewDir, "2026-10-03-9.md");
    await writeFile(onlyReal, realText);
    await expect(approveSheetFile(onlyReal, { ...paths, sql: () => sql })).rejects.toThrow(
      `${onlyReal} holds real drafts but is not under a review/real/ directory; real sheets stay in the gitignored eval/review/real/`,
    );
    expect(await readFile(paths.draftsPath, "utf8")).toBe(draftsBefore);
    expect(await loadGolden(paths.goldenPath)).toHaveLength(1);
  });
});
