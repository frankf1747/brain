import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DraftOutputSchema, DUPLICATE_STEM_JACCARD, MAX_DRAFT_CHARS, normalizeQuestion, draftId, docKey, stemJaccard, duplicateOf, quoteInDocument,
  questionContainsQuote, toGoldenItem, draftProblems, draftUserMessage, nextSheetPath, loadDrafts, saveDrafts, draftsFileFor, reviewDirFor, sheetCorpus,
  quoteInPassage, QUOTE_SPANS_PASSAGES,
  type Draft, type CorpusDocument,
} from "../../src/eval/draft.js";
import { validateGoldenItem } from "../../src/eval/golden.js";

const TEXT = "## Compensation and visa\n\nBase salary range $115,000 to $140,000. Acme sponsors H-1B for this role.\nHybrid, three days a week in the Austin office.";
const doc = { id: "0b9c6a38-1111-4222-8333-444455556666", origin: "eval/corpus/job_description--acme-senior-data-analyst.md", title: "Senior Data Analyst, Acme Corp", source_kind: "job_description", author: "other" };

function draft(over: Partial<Draft> = {}): Draft {
  return {
    draft_id: "d-0123456789", corpus: "fixtures", kind: "keyword", question: "What is the pay range for the Acme analyst job?",
    quote: "Base salary range $115,000 to $140,000.", paraphrases: ["How much does the Acme analyst role pay?", "Acme analyst salary band"],
    document: doc, drafted_at: "2026-10-03T10:00:00.000Z", model: "fake", sheet: "eval/review/2026-10-03-1.md", ...over,
  };
}

/** A stem map by hand, as stemAll would build it from Postgres. */
const stems = new Map<string, string[]>([
  ["What is the pay range for the Acme analyst job?", ["acm", "analyst", "job", "pay", "rang"]],
  ["What's the Acme analyst job pay range?", ["acm", "analyst", "job", "pay", "rang"]],
  ["What is the pay range for the Northwind analyst job?", ["analyst", "job", "northwind", "pay", "rang"]],
  ["Who led Acme's Series B?", ["acm", "b", "led", "seri"]],
  ["Who led the Acme Series B round?", ["acm", "b", "led", "round", "seri"]],
]);

describe("question identity", () => {
  it("normalises case, punctuation and spacing", () => {
    expect(normalizeQuestion("  What's the  Acme   role's PAY?! ")).toBe("what s the acme role s pay");
  });
  it("gives a stable id per document and normalised question", () => {
    const a = draftId("job.md", "What is the pay?");
    expect(a).toMatch(/^d-[0-9a-f]{10}$/);
    expect(draftId("job.md", "what is the PAY")).toBe(a);
    expect(draftId("other.md", "What is the pay?")).not.toBe(a);
  });
  it("names fixture documents by file name and real documents by id", () => {
    expect(docKey("fixtures", doc)).toBe("job_description--acme-senior-data-analyst.md");
    expect(docKey("real", doc)).toBe(doc.id);
  });
});

describe("duplicates", () => {
  it("Jaccard over distinct stems, 0 when either side is empty", () => {
    expect(stemJaccard(["a", "b", "c"], ["a", "b", "d"])).toBe(0.5);
    expect(stemJaccard([], ["a"])).toBe(0);
    expect(DUPLICATE_STEM_JACCARD).toBe(0.8);
  });
  it("flags equal normalised text and stem overlap of at least 0.8, and not a question about another company", () => {
    const others = [{ id: "q01", question: "What is the pay range for the Acme analyst job?" }];
    expect(duplicateOf("what is the PAY range for the acme analyst job", others, stems)).toBe("q01");
    expect(duplicateOf("What's the Acme analyst job pay range?", others, stems)).toBe("q01");
    expect(duplicateOf("What is the pay range for the Northwind analyst job?", others, stems)).toBeNull(); // 4/6
    expect(duplicateOf("Who led the Acme Series B round?", [{ id: "q02", question: "Who led Acme's Series B?" }], stems)).toBe("q02"); // 4/5
  });
});

describe("quote checks", () => {
  it("finds the quote verbatim after collapsing whitespace, but not with other case or punctuation", () => {
    expect(quoteInDocument("Base salary range $115,000 to $140,000.", TEXT)).toBe(true);
    expect(quoteInDocument("$140,000. Acme sponsors   H-1B", TEXT)).toBe(true);
    expect(quoteInDocument("Acme sponsors H-1B for this role. Hybrid, three days", TEXT)).toBe(true); // across a line break
    expect(quoteInDocument("base salary range $115,000", TEXT)).toBe(false);
    expect(quoteInDocument("Base salary range $115000", TEXT)).toBe(false);
    expect(quoteInDocument("   ", TEXT)).toBe(false);
  });
  it("catches a question that contains its own quote, in any case", () => {
    expect(questionContainsQuote("Does ACME SPONSORS H-1B for this role?", "Acme sponsors H-1B for this role")).toBe(true);
    expect(questionContainsQuote("Does Acme sponsor visas?", "Acme sponsors H-1B for this role")).toBe(false);
  });
});

describe("toGoldenItem", () => {
  it("makes a generated item approved by the owner, naming a fixture by file name and a real document by id", () => {
    const item = toGoldenItem(draft(), "2026-10-04", false);
    expect(item).toEqual({
      id: "d-0123456789", question: "What is the pay range for the Acme analyst job?", kind: "keyword",
      expected: [{ origin: "job_description--acme-senior-data-analyst.md", quote: "Base salary range $115,000 to $140,000." }],
      paraphrases: ["How much does the Acme analyst role pay?", "Acme analyst salary band"], source: "generated", negative: false,
      corpus: "fixtures", approved_by: "owner", approved_at: "2026-10-04", edited: false,
    });
    expect(validateGoldenItem(item).ok).toBe(true);
    expect(toGoldenItem(draft({ corpus: "real" }), "2026-10-04", true)).toMatchObject({ expected: [{ document_id: doc.id }], corpus: "real", edited: true });
  });
  it("gives a filter item its document's source kind and a negative item no expected document", () => {
    expect(toGoldenItem(draft({ kind: "filter", question: "Acme pay" }), "2026-10-04", false)).toMatchObject({ filters: { sourceKinds: ["job_description"] } });
    expect(toGoldenItem(draft({ kind: "negative", quote: null, paraphrases: [] }), "2026-10-04", false)).toMatchObject({ expected: [], negative: true, kind: "negative" });
  });
});

describe("draftProblems", () => {
  const ok = { documentText: TEXT, others: [], stems };
  it("passes a good draft", () => {
    expect(draftProblems(draft(), ok)).toEqual([]);
    expect(draftProblems(draft({ kind: "negative", question: "What is the Acme signing bonus?", quote: null, paraphrases: [] }), ok)).toEqual([]);
  });
  it("lists every failed check", () => {
    expect(draftProblems(draft({ quote: "Base salary range $115k" }), ok)).toEqual(["the quote is not in the document verbatim"]);
    expect(draftProblems(draft({ question: "Is the base salary range $115,000 to $140,000.?" }), ok)).toEqual(["the question contains its own answer quote"]);
    expect(draftProblems(draft(), { ...ok, others: [{ id: "q01", question: "What's the Acme analyst job pay range?" }] })).toEqual(["duplicates q01"]);
    expect(draftProblems(draft(), { ...ok, documentText: null })).toEqual(["its document is not in the eval database"]);
    expect(draftProblems(draft({ paraphrases: ["only one"] }), ok)).toEqual(["a question needs exactly two paraphrases"]);
    expect(draftProblems(draft({ kind: "attribution", document: { ...doc, author: "owner" } }), ok)).toEqual(["an attribution question needs a document the owner did not write"]);
    expect(draftProblems(draft({ kind: "negative" }), ok)).toEqual(["a negative question has no quote and no paraphrases"]);
    expect(draftProblems(draft({ document: { ...doc, origin: null } }), ok)).toEqual(["not a valid golden item: a fixtures item names each expected document by origin"]);
  });
});

describe("model output and prompt", () => {
  it("wants one to three questions with exactly two paraphrases each, and one negative", () => {
    const q = { kind: "keyword", question: "q", quote: "a quote", paraphrases: ["p1", "p2"] };
    expect(DraftOutputSchema.safeParse({ questions: [q], negative: { question: "n" } }).success).toBe(true);
    expect(DraftOutputSchema.safeParse({ questions: [{ ...q, paraphrases: ["p1"] }], negative: { question: "n" } }).success).toBe(false);
    expect(DraftOutputSchema.safeParse({ questions: [q, q, q, q], negative: { question: "n" } }).success).toBe(false);
    expect(DraftOutputSchema.safeParse({ questions: [{ ...q, kind: "negative" }], negative: { question: "n" } }).success).toBe(false);
    expect(DraftOutputSchema.safeParse({ questions: [q] }).success).toBe(false);
  });
  it("sends the document's metadata, its text cut at the limit, and the other titles", () => {
    const d: CorpusDocument = { ...doc, author: "owner", raw_content: "x".repeat(MAX_DRAFT_CHARS + 5), occurred_at: new Date("2026-09-26T00:00:00Z"), ingested_at: new Date() };
    const msg = draftUserMessage(d, ["Moved to Denver [note]"]);
    expect(msg).toContain("source kind: job_description\nauthor: owner (the owner, Frank Fu)\ndate: 2026-09-26");
    expect(msg).toContain("x".repeat(MAX_DRAFT_CHARS) + "\n[document cut here]\n---");
    expect(msg).not.toContain("x".repeat(MAX_DRAFT_CHARS + 1));
    expect(msg.endsWith("Other documents in the corpus:\n- Moved to Denver [note]")).toBe(true);
  });
});

describe("files", () => {
  it("numbers review sheets per day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-"));
    expect(await nextSheetPath(join(dir, "missing"), "2026-10-03")).toBe(join(dir, "missing", "2026-10-03-1.md"));
    await writeFile(join(dir, "2026-10-03-1.md"), "");
    await writeFile(join(dir, "2026-10-03-2.md"), "");
    await writeFile(join(dir, "2026-10-02-7.md"), "");
    expect(await nextSheetPath(dir, "2026-10-03")).toBe(join(dir, "2026-10-03-3.md"));
  });
  it("saves and loads drafts, and rejects a malformed or repeated line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drafts-"));
    const path = join(dir, "drafts.jsonl");
    expect(await loadDrafts(path)).toEqual([]);
    await saveDrafts(path, [draft(), draft({ draft_id: "d-aaaaaaaaaa" })]);
    expect((await loadDrafts(path)).map((d) => d.draft_id)).toEqual(["d-0123456789", "d-aaaaaaaaaa"]);
    await writeFile(path, JSON.stringify(draft()) + "\n" + JSON.stringify(draft()) + "\n");
    await expect(loadDrafts(path)).rejects.toThrow(/drafts line 2: duplicate draft id d-0123456789/);
    await writeFile(path, JSON.stringify({ ...draft(), extra: 1 }) + "\n");
    await expect(loadDrafts(path)).rejects.toThrow(/drafts line 1: .*extra/);
  });
});

describe("real-corpus drafts and sheets stay in the gitignored paths", () => {
  it("names the real drafts file and review directory next to the fixtures ones", () => {
    expect(draftsFileFor("eval/drafts.jsonl", "fixtures")).toBe("eval/drafts.jsonl");
    expect(draftsFileFor("eval/drafts.jsonl", "real")).toBe("eval/drafts-real.jsonl");
    expect(reviewDirFor("eval/review", "fixtures")).toBe("eval/review");
    expect(reviewDirFor("eval/review", "real")).toBe(join("eval/review", "real"));
    expect(sheetCorpus("eval/review/real/2026-10-03-1.md")).toBe("real");
    expect(sheetCorpus("eval/review/2026-10-03-1.md")).toBe("fixtures");
  });
  it("rejects a real draft in drafts.jsonl and a fixtures draft in drafts-real.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drafts-"));
    await writeFile(join(dir, "drafts.jsonl"), JSON.stringify(draft({ corpus: "real" })) + "\n");
    await expect(loadDrafts(join(dir, "drafts.jsonl"))).rejects.toThrow(
      "drafts line 1: d-0123456789 is a real draft; real drafts quote the owner's private documents and belong in drafts-real.jsonl (gitignored)",
    );
    await writeFile(join(dir, "drafts-real.jsonl"), JSON.stringify(draft()) + "\n");
    await expect(loadDrafts(join(dir, "drafts-real.jsonl"))).rejects.toThrow("drafts line 1: d-0123456789 is a fixtures draft; it belongs in drafts.jsonl");
    await expect(saveDrafts(join(dir, "drafts.jsonl"), [draft({ corpus: "real" })])).rejects.toThrow(/belong in drafts-real\.jsonl/);
  });
});

describe("real-corpus paths must stay where git ignores them", () => {
  it("refuses a real drafts file or review directory inside the repository but outside eval/", () => {
    expect(() => draftsFileFor("data/drafts.jsonl", "real")).toThrow(
      "the real corpus's drafts file data/drafts-real.jsonl is inside the repository but outside eval/, where git would not ignore it; keep it under eval/ or outside the repository",
    );
    expect(() => reviewDirFor("docs/review", "real")).toThrow(/the real corpus's review directory docs\/review\/real is inside the repository but outside eval\//);
    expect(() => reviewDirFor("./review", "real")).toThrow(/outside eval\//);
    // Fixtures paths are not private; eval/ subpaths and paths outside the repository (temporary directories) are fine.
    expect(draftsFileFor("data/drafts.jsonl", "fixtures")).toBe("data/drafts.jsonl");
    expect(draftsFileFor("eval/x/drafts.jsonl", "real")).toBe("eval/x/drafts-real.jsonl");
    expect(reviewDirFor("eval/review-x", "real")).toBe(join("eval/review-x", "real"));
    expect(reviewDirFor(join(tmpdir(), "r"), "real")).toBe(join(tmpdir(), "r", "real"));
  });
});

describe("quote inside one passage", () => {
  const passages = ["## Compensation and visa\n\nBase salary range $115,000", "to $140,000. Acme sponsors H-1B for this role.\nHybrid, three days"];
  it("finds a quote only when one level-1 passage holds all of it, whitespace normalised as the eval does", () => {
    expect(quoteInPassage("Acme sponsors   H-1B for this role.", passages)).toBe(true);
    expect(quoteInPassage("Base salary range $115,000 to $140,000.", passages)).toBe(false);
  });
  it("draftProblems names a quote that crosses a passage boundary, since eval run matches quotes per passage", () => {
    const ok = { documentText: TEXT, others: [], stems };
    expect(draftProblems(draft(), { ...ok, passages })).toEqual([QUOTE_SPANS_PASSAGES]);
    expect(QUOTE_SPANS_PASSAGES).toBe("quote spans a passage boundary; pick a quote inside one passage");
    expect(draftProblems(draft({ quote: "Acme sponsors H-1B for this role." , question: "Does Acme sponsor visas?" }), { ...ok, passages })).toEqual([]);
    // Without passages (not looked up) only the whole-document check runs.
    expect(draftProblems(draft(), ok)).toEqual([]);
  });
});
