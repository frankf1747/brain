import { describe, it, expect } from "vitest";
import { renderSheet, parseSheet, applySheet, documentLine, type ApplyContext } from "../../src/eval/review.js";
import { parseGolden } from "../../src/eval/golden.js";
import type { Draft } from "../../src/eval/draft.js";

const TEXT = "## Compensation and visa\n\nBase salary range $115,000 to $140,000. Acme sponsors H-1B for this role.\nHybrid, three days a week in the Austin office.";
const doc = { id: "0b9c6a38-1111-4222-8333-444455556666", origin: "eval/corpus/job_description--acme-senior-data-analyst.md", title: "Senior Data Analyst, Acme Corp", source_kind: "job_description", author: "other" };

function draft(over: Partial<Draft> = {}): Draft {
  return {
    draft_id: "d-0123456789", corpus: "fixtures", kind: "keyword", question: "What is the pay range for the Acme analyst job?",
    quote: "Base salary range $115,000 to $140,000.", paraphrases: ["How much does the Acme analyst role pay?", "Acme analyst salary band"],
    document: doc, drafted_at: "2026-10-03T10:00:00.000Z", model: "fake", sheet: "eval/review/2026-10-03-1.md", ...over,
  };
}

const keyword = draft();
const semantic = draft({ draft_id: "d-1111111111", kind: "semantic", question: "Can a foreign graduate get a work visa through this Acme job?", quote: "Acme sponsors H-1B for this role.", paraphrases: ["Will Acme sponsor my visa?", "visa sponsorship at Acme"] });
const negative = draft({ draft_id: "d-2222222222", kind: "negative", question: "What signing bonus does Acme offer?", quote: null, paraphrases: [] });
const drafts = [keyword, semantic, negative];
const info = { sheet: "eval/review/2026-10-03-1.md", corpus: "fixtures" as const, model: "opus", day: "2026-10-03", documents: 1 };

const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({ drafts, golden: [], documentText: () => TEXT, stems: new Map(), today: "2026-10-04", ...over });

/** The rendered sheet with each item's `decision:` line set, in item order. */
function decide(text: string, ...decisions: string[]): string {
  let i = 0;
  return text.replace(/^decision:$/gm, () => `decision: ${decisions[i++] ?? ""}`.trimEnd());
}

describe("renderSheet", () => {
  it("writes the instructions, then one section per draft with an empty decision", () => {
    const text = renderSheet(drafts, info);
    expect(text.startsWith("# Eval review 2026-10-03-1\n\nDrafted 2026-10-03 by opus from 1 document of the fixtures corpus: 3 questions.")).toBe(true);
    expect(text).toContain("Apply: `npm run brain -- eval approve --sheet eval/review/2026-10-03-1.md`");
    expect(text).toContain([
      "## d-0123456789", "", "document: job_description--acme-senior-data-analyst.md", "decision:", "kind: keyword",
      "question: What is the pay range for the Acme analyst job?", "quote: Base salary range $115,000 to $140,000.", "paraphrases:",
      "- How much does the Acme analyst role pay?", "- Acme analyst salary band",
    ].join("\n"));
    expect(text).toContain([
      "## d-2222222222", "", "document: none (negative question, drafted from job_description--acme-senior-data-analyst.md)", "decision:", "kind: negative",
      "question: What signing bonus does Acme offer?",
    ].join("\n"));
    expect(documentLine(draft({ corpus: "real" }))).toBe(`Senior Data Analyst, Acme Corp (${doc.id})`);
  });
});

describe("parseSheet", () => {
  it("reads every section back, decisions empty", () => {
    const items = parseSheet(renderSheet(drafts, info));
    expect(items.map((s) => [s.draftId, s.decision, s.kind])).toEqual([["d-0123456789", null, "keyword"], ["d-1111111111", null, "semantic"], ["d-2222222222", null, "negative"]]);
    expect(items[0]).toMatchObject({ line: 14, quote: "Base salary range $115,000 to $140,000.", paraphrases: ["How much does the Acme analyst role pay?", "Acme analyst salary band"] });
    expect(items[2]).toMatchObject({ quote: null, paraphrases: [] });
  });
  it("accepts CRLF line ends, trailing spaces and extra blank lines, as editors leave them", () => {
    const text = decide(renderSheet([keyword], info), "keep").replace(/\n/g, "  \r\n").replace("kind: keyword", "\r\nkind: keyword");
    expect(parseSheet(text)[0]).toMatchObject({ decision: "keep", kind: "keyword" });
  });
  it("reports every problem with its line number, and reads nothing when there is one", () => {
    const bad = renderSheet([keyword], info)
      .replace(/^decision:$/m, "decision: maybe")
      .replace("kind: keyword", "kind: keyword\nkind: semantic\nnotes: looks fine")
      .replace("- Acme analyst salary band", "- Acme analyst salary band\n-")
      .concat("## not-an-id\n");
    expect(() => parseSheet(bad, "s.md")).toThrow(
      [
        "s.md has 5 problems:",
        '  s.md:17: decision must be keep, edit, reject or empty; got "maybe"',
        "  s.md:19: d-0123456789 has a second kind: line",
        '  s.md:20: cannot read "notes: looks fine"; expected one of document: decision: kind: question: quote: paraphrases: or a "- " paraphrase',
        "  s.md:26: empty paraphrase",
        '  s.md:27: a heading must be "## d-" and 10 hex digits, as the sheet was written; got "## not-an-id"',
      ].join("\n"),
    );
  });
  it("puts a stray \"- \" line, outside paraphrases, down as an error", () => {
    const text = renderSheet([keyword], info).replace("kind: keyword", "kind: keyword\n- a note");
    expect(() => parseSheet(text, "s.md")).toThrow('s.md:19: a "- " line belongs under paraphrases:');
  });
  it("requires the document, decision, kind and question lines, and each id once", () => {
    const text = renderSheet([keyword], info).replace(/^decision:\n/m, "");
    expect(() => parseSheet(text, "s.md")).toThrow("s.md:14: d-0123456789 has no decision: line");
    const twice = renderSheet([keyword, keyword], info);
    expect(() => parseSheet(twice, "s.md")).toThrow(/s\.md:\d+: d-0123456789 appears twice/);
  });
});

describe("applySheet", () => {
  it("keeps, edits, rejects and leaves undecided items pending", () => {
    const text = decide(renderSheet(drafts, info), "keep", "edit", "reject").replace("question: Can a foreign graduate get a work visa through this Acme job?", "question: Will Acme sponsor an H-1B for the analyst role?");
    const r = applySheet(parseSheet(text), ctx());
    expect(r.approved.map((a) => [a.id, a.edited, a.approved_by, a.source, a.approved_at])).toEqual([
      ["d-0123456789", false, "owner", "generated", "2026-10-04"],
      ["d-1111111111", true, "owner", "generated", "2026-10-04"],
    ]);
    expect(r.approved[1].question).toBe("Will Acme sponsor an H-1B for the analyst role?");
    expect(r.rejected).toEqual(["d-2222222222"]);
    expect(r.remaining).toEqual([]);
    const pending = applySheet(parseSheet(decide(renderSheet(drafts, info), "keep")), ctx());
    expect(pending.undecided).toEqual(["d-1111111111", "d-2222222222"]);
    expect(pending.remaining.map((d) => d.draft_id)).toEqual(["d-1111111111", "d-2222222222"]);
  });
  it("counts an item applied by an earlier run of the same sheet as already applied", () => {
    const text = decide(renderSheet(drafts, info), "keep", "", "reject");
    const first = applySheet(parseSheet(text), ctx());
    const golden = parseGolden(first.approved.map((a) => JSON.stringify(a)).join("\n"));
    const again = applySheet(parseSheet(text), ctx({ drafts: first.remaining, golden }));
    expect(again).toMatchObject({ approved: [], rejected: [], alreadyApplied: ["d-0123456789", "d-2222222222"], undecided: ["d-1111111111"] });
  });
  it("applies nothing and lists every problem when any item is wrong", () => {
    const text = decide(renderSheet(drafts, info), "keep", "edit", "edit")
      .replace("quote: Base salary range $115,000 to $140,000.", "quote: Base salary range $115,000 to $150,000.")
      .replace("quote: Acme sponsors H-1B for this role.", "quote: Acme sponsors visas.")
      .replace("kind: negative", "kind: keyword")
      .replace("document: job_description--acme-senior-data-analyst.md", "document: somewhere-else.md");
    expect(() => applySheet(parseSheet(text), ctx())).toThrow(
      [
        "nothing applied; fix the sheet and run approve again:",
        '  d-0123456789 (line 14): the document line was changed; it must read "job_description--acme-senior-data-analyst.md"',
        "  d-0123456789 (line 14): decision keep but quote changed; use edit, or undo the change",
        "  d-1111111111 (line 25): the quote is not in the document verbatim",
        "  d-2222222222 (line 36): a negative question cannot become positive",
      ].join("\n"),
    );
  });
  it("rechecks kept items against the golden set and the eval database, and refuses unknown kinds and ids", () => {
    const golden = parseGolden(JSON.stringify({ id: "q01", question: "What is the pay range for the Acme analyst job?", kind: "keyword", expected: [{ origin: "x.md" }], source: "fixture", approved_by: "agent", approved_at: "2026-09-30" }));
    expect(() => applySheet(parseSheet(decide(renderSheet([keyword], info), "keep")), ctx({ golden }))).toThrow(/d-0123456789 \(line 14\): duplicates q01/);
    expect(() => applySheet(parseSheet(decide(renderSheet([keyword], info), "keep")), ctx({ documentText: () => null }))).toThrow(/its document is not in the eval database/);
    const kind = decide(renderSheet([keyword], info), "edit").replace("kind: keyword", "kind: fallback");
    expect(() => applySheet(parseSheet(kind), ctx())).toThrow(/kind must be one of keyword, semantic, graph, filter, attribution; got "fallback"/);
    expect(() => applySheet(parseSheet(decide(renderSheet([keyword], info), "keep")), ctx({ drafts: [] }))).toThrow(/d-0123456789 \(line 14\): no pending draft has this id/);
  });
  it("recovers when an earlier approve wrote the golden item but not the drafts file: the stale draft counts as already applied and is dropped", () => {
    const text = decide(renderSheet(drafts, info), "keep", "", "reject");
    const first = applySheet(parseSheet(text), ctx());
    const golden = parseGolden(first.approved.map((a) => JSON.stringify(a)).join("\n"));
    // drafts.jsonl was never rewritten: it still lists all three drafts, one of which is already golden.
    const again = applySheet(parseSheet(text), ctx({ drafts, golden }));
    expect(again).toMatchObject({ approved: [], rejected: ["d-2222222222"], alreadyApplied: ["d-0123456789"], undecided: ["d-1111111111"] });
    expect(again.remaining.map((d) => d.draft_id)).toEqual(["d-1111111111"]);
  });
  it("records edited false for an edit that changed nothing", () => {
    const r = applySheet(parseSheet(decide(renderSheet([keyword], info), "edit")), ctx({ drafts: [keyword] }));
    expect(r.approved[0].edited).toBe(false);
  });
});
