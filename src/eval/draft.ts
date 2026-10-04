import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import type { Db } from "../db.js";
import { stemAll, type StemMap } from "../verify/terms.js";
import { GOLDEN_KINDS, CORPORA, validateGoldenItem, loadGoldenAll, goldenFileFor, goldenFileCorpus, type Corpus, type GoldenItem, type GoldenKind } from "./golden.js";
import { matchesExpected } from "./metrics.js";
import { normalizeWhitespace } from "./run.js";

/**
 * Drafting golden questions (spec §8.3). `brain eval draft` asks the model, once per document, for 2 to 3 questions
 * the document answers (each with a verbatim answer quote and two paraphrases) and one negative question nothing in
 * the corpus answers. Every draft passes the automatic checks below before it is written to eval/drafts.jsonl and to
 * a review sheet; the owner then keeps, edits or rejects each one (src/eval/review.ts). Nothing here approves.
 */

/** Kinds the model may draft; negative questions are asked for separately. */
export const DRAFT_KINDS = ["keyword", "semantic", "graph", "filter", "attribution"] as const;

/** One model call's answer for one document. */
export const DraftOutputSchema = z.object({
  questions: z
    .array(
      z.object({
        kind: z.enum(DRAFT_KINDS),
        question: z.string().min(1),
        quote: z.string().min(1),
        paraphrases: z.array(z.string().min(1)).length(2),
      }),
    )
    .min(1)
    .max(3),
  negative: z.object({ question: z.string().min(1) }),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

/** The document a draft was written from, as the sheet shows it. */
const DraftDocumentSchema = z.object({
  id: z.string().uuid(),
  origin: z.string().nullable(),
  title: z.string().nullable(),
  source_kind: z.string(),
  author: z.string(),
}).strict();

/** One line of eval/drafts.jsonl: a golden item waiting for the owner, plus where it came from. */
export const DraftSchema = z.object({
  draft_id: z.string().regex(/^d-[0-9a-f]{10}$/),
  corpus: z.enum(CORPORA),
  kind: z.enum(GOLDEN_KINDS),
  question: z.string().min(1),
  quote: z.string().min(1).nullable(),
  paraphrases: z.array(z.string().min(1)),
  document: DraftDocumentSchema,
  drafted_at: z.string().min(1),
  model: z.string().min(1),
  sheet: z.string().min(1),
}).strict();
export type Draft = z.infer<typeof DraftSchema>;
export type DraftDocument = z.infer<typeof DraftDocumentSchema>;

/** Two questions are duplicates when their stem sets overlap at least this much (Jaccard), or their normalised text is equal. */
export const DUPLICATE_STEM_JACCARD = 0.8;

/** The longest document text sent to the model; the quote check always reads the whole text. */
export const MAX_DRAFT_CHARS = 40_000;

/** Lower case, every run of characters that are not letters or digits as one space, trimmed. */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A stable id: the same question drafted from the same document always gets the same id. */
export function draftId(docKey: string, question: string): string {
  return "d-" + createHash("sha256").update(`${docKey}\n${normalizeQuestion(question)}`).digest("hex").slice(0, 10);
}

/** How a draft names its document in the golden set: the fixture file name, or the document id for the real base. */
export function docKey(corpus: Corpus, d: Pick<DraftDocument, "id" | "origin">): string {
  return corpus === "fixtures" && d.origin ? basename(d.origin) : d.id;
}

/** |A ∩ B| / |A ∪ B| over distinct stems; 0 when either is empty. */
export function stemJaccard(a: string[], b: string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const s of x) if (y.has(s)) both++;
  return both / (x.size + y.size - both);
}

/**
 * The id of the first existing question that `question` duplicates: equal normalised text, or stem sets (Postgres
 * english lexemes, stopwords removed) with Jaccard ≥ DUPLICATE_STEM_JACCARD. Null when there is none.
 */
export function duplicateOf(question: string, others: { id: string; question: string }[], stems: StemMap): string | null {
  const norm = normalizeQuestion(question);
  const mine = stems.get(question) ?? [];
  for (const o of others) {
    if (normalizeQuestion(o.question) === norm) return o.id;
    if (stemJaccard(mine, stems.get(o.question) ?? []) >= DUPLICATE_STEM_JACCARD) return o.id;
  }
  return null;
}

/** The quote as it is compared: ASCII whitespace runs collapsed, ends trimmed (as the eval's quote matching does). */
const squash = (s: string) => normalizeWhitespace(s).replace(/^ | $/g, "");

/** Whether the quote appears verbatim in the document text after whitespace normalisation (case and punctuation count). */
export function quoteInDocument(quote: string, text: string): boolean {
  const q = squash(quote);
  return q.length > 0 && normalizeWhitespace(text).includes(q);
}

/** Whether the question contains its own answer quote (case-insensitive, whitespace normalised). */
export function questionContainsQuote(question: string, quote: string): boolean {
  const q = squash(quote).toLowerCase();
  return q.length > 0 && normalizeWhitespace(question).toLowerCase().includes(q);
}

/** The golden item a draft becomes once the owner approves it. */
export function toGoldenItem(d: Draft, approvedAt: string, edited: boolean): GoldenItem | { errors: string } {
  const negative = d.kind === "negative";
  const expected = negative ? [] : [{ ...(d.corpus === "fixtures" && d.document.origin ? { origin: basename(d.document.origin) } : { document_id: d.document.id }), ...(d.quote ? { quote: d.quote } : {}) }];
  const raw = {
    id: d.draft_id,
    question: d.question,
    kind: d.kind,
    expected,
    ...(d.kind === "filter" ? { filters: { sourceKinds: [d.document.source_kind] } } : {}),
    ...(d.paraphrases.length ? { paraphrases: d.paraphrases } : {}),
    source: "generated",
    negative,
    corpus: d.corpus,
    approved_by: "owner",
    approved_at: approvedAt,
    edited,
  };
  const v = validateGoldenItem(raw);
  return v.ok ? v.item : { errors: v.errors };
}

export interface CheckContext {
  /** The full text of the draft's document, or null when it is not in the eval database. */
  documentText: string | null;
  /** Golden items and other drafts the question must not duplicate (the draft itself excluded). */
  others: { id: string; question: string }[];
  stems: StemMap;
}

/**
 * Every automatic check, in order; the reasons a draft fails (empty means it passes):
 * the expected document exists; the quote appears verbatim in it after whitespace normalisation; the question does not
 * contain its own quote; it is not a duplicate of a golden item or another draft; kind and fields are valid under the
 * golden schema (as the item it would become); an attribution question needs a document the owner did not write.
 */
export function draftProblems(d: Draft, c: CheckContext): string[] {
  const out: string[] = [];
  const negative = d.kind === "negative";
  if (c.documentText === null) out.push("its document is not in the eval database");
  if (!negative) {
    if (!d.quote) out.push("a question needs a quote");
    else {
      if (c.documentText !== null && !quoteInDocument(d.quote, c.documentText)) out.push("the quote is not in the document verbatim");
      if (questionContainsQuote(d.question, d.quote)) out.push("the question contains its own answer quote");
    }
    if (d.paraphrases.length !== 2) out.push("a question needs exactly two paraphrases");
  } else if (d.quote || d.paraphrases.length) out.push("a negative question has no quote and no paraphrases");
  if (d.kind === "attribution" && d.document.author === "owner") out.push("an attribution question needs a document the owner did not write");
  const dup = duplicateOf(d.question, c.others, c.stems);
  if (dup) out.push(`duplicates ${dup}`);
  const item = toGoldenItem(d, "2000-01-01", false);
  if ("errors" in item) out.push(`not a valid golden item: ${item.errors}`);
  return out;
}

/**
 * Where a corpus's drafts live: eval/drafts.jsonl (committed) for fixtures, eval/drafts-real.jsonl (gitignored) for the
 * real base, whose drafts quote the owner's private documents. Either name of the pair may be given.
 */
export function draftsFileFor(draftsPath: string, corpus: Corpus): string {
  return goldenFileFor(draftsPath, corpus);
}

/** Where a corpus's review sheets go: eval/review/ for fixtures, eval/review/real/ (gitignored) for the real base. */
export function reviewDirFor(reviewDir: string, corpus: Corpus): string {
  return corpus === "real" ? join(reviewDir, "real") : reviewDir;
}

/** The corpus a review sheet belongs to, from where it is: a sheet in a directory named real is a real sheet. */
export function sheetCorpus(sheetPath: string): Corpus {
  return basename(dirname(sheetPath)) === "real" ? "real" : "fixtures";
}

/** Why a draft may not sit in a drafts file of `fileCorpus`; null when it may. */
function wrongDraftsFile(d: Draft, fileCorpus: Corpus): string | null {
  if (d.corpus === fileCorpus) return null;
  return d.corpus === "real"
    ? `${d.draft_id} is a real draft; real drafts quote the owner's private documents and belong in drafts-real.jsonl (gitignored)`
    : `${d.draft_id} is a fixtures draft; it belongs in drafts.jsonl`;
}

/**
 * Reads a drafts file (missing means none); each line must be a valid draft, with unique ids, of the corpus the file's
 * name says (goldenFileCorpus: drafts-real.jsonl holds real drafts, any other name fixtures drafts).
 */
export async function loadDrafts(path: string): Promise<Draft[]> {
  const fileCorpus = goldenFileCorpus(path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Draft[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`drafts line ${i + 1}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = DraftSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`drafts line ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ")}`);
    if (seen.has(parsed.data.draft_id)) throw new Error(`drafts line ${i + 1}: duplicate draft id ${parsed.data.draft_id}`);
    const wrong = wrongDraftsFile(parsed.data, fileCorpus);
    if (wrong) throw new Error(`drafts line ${i + 1}: ${wrong}`);
    seen.add(parsed.data.draft_id);
    out.push(parsed.data);
  });
  return out;
}

/** Rewrites a drafts file with exactly these drafts, which must all be of the file's corpus. */
export async function saveDrafts(path: string, drafts: Draft[]): Promise<void> {
  for (const d of drafts) {
    const wrong = wrongDraftsFile(d, goldenFileCorpus(path));
    if (wrong) throw new Error(`${path}: ${wrong}`);
  }
  await writeFile(path, drafts.map((d) => JSON.stringify(d)).join("\n") + (drafts.length ? "\n" : ""));
}

export const DRAFT_SYSTEM = [
  "You write evaluation questions for the search engine of a personal knowledge base. Its owner is Frank Fu; the documents are things he wrote or saved. You get one document and the titles of the other documents in the corpus.",
  "Write 2 or 3 questions that this document answers, each of a different kind where the document allows:",
  "- keyword: uses an exact name, number, code or rare term that appears in the document.",
  "- semantic: asks about the meaning in other words than the document uses.",
  "- graph: asks about a named person, company or place in the document and how it relates to others, e.g. \"What do I know about <name>?\".",
  "- filter: a short search-style query that makes sense when only documents of this document's source kind are searched.",
  "- attribution: only when the author is not the owner: asks what that author says, naming them or their piece, so it cannot be read as something the owner said.",
  "Rules for every question:",
  "- Ask it as the owner would: first person about the owner's own documents (\"Where did I…\"), plainly otherwise.",
  "- quote: 5 to 30 words copied exactly, character for character, from one place in the document, containing the answer. Do not fix spelling or punctuation and do not join two places.",
  "- The question must not contain the quote, or most of its words.",
  "- paraphrases: exactly two other ways to ask the same question, worded differently from it and from each other.",
  "Then write one negative question: in the same area as this document, specific, and answered neither by this document nor, judging by their titles, by any other document listed (for example a detail this document leaves out).",
].join("\n");

export interface CorpusDocument extends DraftDocument {
  raw_content: string;
  occurred_at: Date | null;
  ingested_at: Date;
}

/** The user message for one document: its metadata, its text (cut at MAX_DRAFT_CHARS), and the other titles. */
export function draftUserMessage(doc: CorpusDocument, otherTitles: string[]): string {
  const text = doc.raw_content.length > MAX_DRAFT_CHARS ? doc.raw_content.slice(0, MAX_DRAFT_CHARS) + "\n[document cut here]" : doc.raw_content;
  return [
    "Document",
    `title: ${doc.title ?? "(untitled)"}`,
    `source kind: ${doc.source_kind}`,
    `author: ${doc.author}${doc.author === "owner" ? " (the owner, Frank Fu)" : ""}`,
    `date: ${doc.occurred_at ? doc.occurred_at.toISOString().slice(0, 10) : "unknown"}`,
    "---",
    text,
    "---",
    "Other documents in the corpus:",
    ...(otherTitles.length ? otherTitles.map((t) => `- ${t}`) : ["- none"]),
  ].join("\n");
}

/** Every document of the eval database, oldest origin first. */
export async function corpusDocuments(sql: Db): Promise<CorpusDocument[]> {
  return sql<CorpusDocument[]>`
    select id, origin, title, source_kind, author, raw_content, occurred_at, ingested_at
    from brain.documents order by origin nulls last, ingested_at, id`;
}

/** The next free review sheet path for a date: eval/review/2026-10-03-1.md, -2.md, … */
export async function nextSheetPath(reviewDir: string, day: string): Promise<string> {
  let names: string[] = [];
  try {
    names = await readdir(reviewDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const re = new RegExp(`^${day}-(\\d+)\\.md$`);
  const used = names.map((n) => re.exec(n)?.[1]).filter((x): x is string => !!x).map(Number);
  return join(reviewDir, `${day}-${(used.length ? Math.max(...used) : 0) + 1}.md`);
}

export interface DraftRunOptions {
  corpus: Corpus;
  /** The fixtures golden file; real items are read from golden-real.jsonl next to it (loadGoldenAll). */
  goldenPath: string;
  /** The fixtures drafts file; real drafts go to drafts-real.jsonl next to it (draftsFileFor). */
  draftsPath: string;
  /** The review directory; real sheets go to its real/ subdirectory (reviewDirFor). */
  reviewDir: string;
  /** Only documents ingested at or after this time. */
  since?: Date;
  /** At most this many documents get a model call. */
  limit?: number;
  /** Draft documents that already have drafts or golden items. */
  force?: boolean;
  /** Only these documents: a file name (origin suffix) or a document id each. */
  docs?: string[];
  /** The run's time (tests pass a fixed one). */
  now?: Date;
}

export interface DraftRunResult {
  /** Documents that got a model call. */
  drafted: string[];
  /** Documents left out because they already have drafts or golden items (without --force). */
  skipped: string[];
  written: Draft[];
  rejected: { document: string; question: string; reasons: string[] }[];
  failed: { document: string; error: string }[];
  sheet: string | null;
}

const label = (corpus: Corpus, d: DraftDocument) => (corpus === "fixtures" && d.origin ? basename(d.origin) : `${d.title ?? "(untitled)"} (${d.id})`);

/**
 * One model call per selected document (ctx.llm.structured with DraftOutputSchema), the automatic checks on every
 * question, then the passing drafts appended to eval/drafts.jsonl and written to one new review sheet. Idempotent: a
 * document that already has a pending draft or a golden item is skipped unless force is set, and a question already
 * drafted gets the same id and is reported as a duplicate.
 */
export async function draftDocuments(ctx: Ctx, opts: DraftRunOptions): Promise<DraftRunResult> {
  const { renderSheet } = await import("./review.js");
  const now = opts.now ?? new Date();
  // Real drafts and sheets quote the owner's private documents, so they go only to the gitignored paths.
  const draftsPath = draftsFileFor(opts.draftsPath, opts.corpus);
  const reviewDir = reviewDirFor(opts.reviewDir, opts.corpus);
  // Golden items of both corpora count for duplicates; pending drafts of this corpus (the other corpus's drafts are
  // about documents of another database).
  const golden = await loadGoldenAll(opts.goldenPath);
  const drafts = await loadDrafts(draftsPath);
  const all = await corpusDocuments(ctx.sql);
  const result: DraftRunResult = { drafted: [], skipped: [], written: [], rejected: [], failed: [], sheet: null };

  const sheet = await nextSheetPath(reviewDir, now.toISOString().slice(0, 10));
  const covered = (d: CorpusDocument) =>
    drafts.some((x) => x.document.id === d.id || (x.document.origin !== null && x.document.origin === d.origin)) ||
    golden.some((g) => g.corpus === opts.corpus && g.expected.some((e) => matchesExpected(e, { documentId: d.id, origin: d.origin })));
  const wanted = (d: CorpusDocument) =>
    !opts.docs?.length || opts.docs.some((w) => w === d.id || (d.origin !== null && (d.origin === w || d.origin.endsWith("/" + w))));

  const selected: CorpusDocument[] = [];
  for (const d of all) {
    if (opts.since && d.ingested_at < opts.since) continue;
    if (!wanted(d)) continue;
    if (!opts.force && covered(d)) {
      result.skipped.push(label(opts.corpus, d));
      continue;
    }
    selected.push(d);
  }
  const todo = opts.limit === undefined ? selected : selected.slice(0, opts.limit);

  const others: { id: string; question: string }[] = [
    ...golden.map((g) => ({ id: g.id, question: g.question })),
    ...drafts.map((d) => ({ id: d.draft_id, question: d.question })),
  ];
  for (const doc of todo) {
    const name = label(opts.corpus, doc);
    const document: DraftDocument = { id: doc.id, origin: doc.origin, title: doc.title, source_kind: doc.source_kind, author: doc.author };
    let out: DraftOutput;
    try {
      out = await ctx.llm.structured({
        schema: DraftOutputSchema,
        system: DRAFT_SYSTEM,
        user: draftUserMessage(doc, all.filter((o) => o.id !== doc.id).map((o) => `${o.title ?? "(untitled)"} [${o.source_kind}]`)),
      });
    } catch (err) {
      result.failed.push({ document: name, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    result.drafted.push(name);
    const key = docKey(opts.corpus, document);
    const candidates: Draft[] = [
      ...out.questions.map((q) => ({ kind: q.kind as GoldenKind, question: q.question.trim(), quote: q.quote, paraphrases: q.paraphrases.map((p) => p.trim()) })),
      { kind: "negative" as GoldenKind, question: out.negative.question.trim(), quote: null, paraphrases: [] },
    ].map((c) => ({
      draft_id: draftId(key, c.question),
      corpus: opts.corpus,
      ...c,
      document,
      drafted_at: now.toISOString(),
      model: ctx.llm.model,
      sheet,
    }));
    const stems = await stemAll(ctx.sql, [...candidates.map((c) => c.question), ...others.map((o) => o.question)]);
    for (const c of candidates) {
      const reasons = draftProblems(c, { documentText: doc.raw_content, others, stems });
      if (reasons.length) {
        result.rejected.push({ document: name, question: c.question, reasons });
        continue;
      }
      result.written.push(c);
      others.push({ id: c.draft_id, question: c.question });
    }
  }

  if (result.written.length) {
    await appendFile(draftsPath, result.written.map((d) => JSON.stringify(d)).join("\n") + "\n");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(sheet, renderSheet(result.written, { sheet, corpus: opts.corpus, model: ctx.llm.model, day: now.toISOString().slice(0, 10), documents: result.drafted.length }));
    result.sheet = sheet;
  }
  return result;
}
