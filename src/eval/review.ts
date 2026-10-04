import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Db } from "../db.js";
import { stemAll, type StemMap } from "../verify/terms.js";
import { appendGolden, loadGoldenAll, type Corpus, type GoldenItem, type GoldenKind } from "./golden.js";
import { DRAFT_KINDS, draftProblems, loadDrafts, saveDrafts, toGoldenItem, draftsFileFor, sheetCorpus, type Draft } from "./draft.js";

/**
 * The review sheet: a Markdown file the owner edits in a plain text editor or Obsidian to keep, edit or reject each
 * draft, and `brain eval approve --sheet` reads back. One `## <draft id>` section per draft, `key: value` lines, the
 * two paraphrases as `- ` lines under `paraphrases:`. Parsing is strict: any line it cannot place is an error with its
 * line number, and nothing is applied while any error remains.
 */

export const DECISIONS = ["keep", "edit", "reject"] as const;
export type Decision = (typeof DECISIONS)[number];

/** How the sheet names a draft's document; also checked on the way back in, so the line cannot be edited by mistake. */
export function documentLine(d: Draft): string {
  const doc = d.corpus === "fixtures" && d.document.origin ? basename(d.document.origin) : `${d.document.title ?? "(untitled)"} (${d.document.id})`;
  return d.kind === "negative" ? `none (negative question, drafted from ${doc})` : doc;
}

export interface SheetInfo {
  sheet: string;
  corpus: Corpus;
  model: string;
  day: string;
  documents: number;
}

/** The sheet for a batch of drafts. */
export function renderSheet(drafts: Draft[], info: SheetInfo): string {
  const out = [
    `# Eval review ${basename(info.sheet, ".md")}`,
    "",
    `Drafted ${info.day} by ${info.model} from ${info.documents} document${info.documents === 1 ? "" : "s"} of the ${info.corpus} corpus: ${drafts.length} question${drafts.length === 1 ? "" : "s"}. Every quote was found verbatim in its document, and no question repeats a golden item or another draft.`,
    "",
    "For each item, set `decision:` to one of:",
    "- `keep`: approve it as written.",
    "- `edit`: approve it after your changes. Change `kind`, `question`, `quote` or the two lines under `paraphrases:` in place.",
    "- `reject`: discard it.",
    "",
    `Leave \`decision:\` empty to decide later. Do not change the \`## d-…\` headings or the \`document:\` lines. Kinds: ${DRAFT_KINDS.join(", ")} (a negative item stays negative). A filter item searches only its document's source kind. A quote must stay a verbatim span of the document.`,
    "",
    `Apply: \`npm run brain -- eval approve --sheet ${info.sheet}\``,
  ];
  for (const d of drafts) {
    out.push("", `## ${d.draft_id}`, "", `document: ${documentLine(d)}`, "decision:", `kind: ${d.kind}`, `question: ${d.question}`);
    if (d.kind !== "negative") out.push(`quote: ${d.quote ?? ""}`, "paraphrases:", ...d.paraphrases.map((p) => `- ${p}`));
  }
  return out.join("\n") + "\n";
}

/** One section of a sheet as the owner left it. */
export interface SheetItem {
  draftId: string;
  /** 1-based line of the heading. */
  line: number;
  decision: Decision | null;
  document: string;
  kind: string;
  question: string;
  quote: string | null;
  paraphrases: string[];
}

const KEYS = ["document", "decision", "kind", "question", "quote", "paraphrases"] as const;
const HEADING = /^## (d-[0-9a-f]{10})\s*$/;

/** Parses a sheet; throws one error listing every problem with its line number. */
export function parseSheet(text: string, path = "sheet"): SheetItem[] {
  const errors: string[] = [];
  const items: SheetItem[] = [];
  type Open = { item: SheetItem; seen: Set<string>; inParaphrases: boolean; hasQuote: boolean; hasParaphrases: boolean };
  let open: Open | null = null;
  const close = (o: Open | null) => {
    if (!o) return;
    for (const k of ["document", "decision", "kind", "question"]) if (!o.seen.has(k)) errors.push(`${path}:${o.item.line}: ${o.item.draftId} has no ${k}: line`);
    items.push(o.item);
  };
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## ") || line === "##") {
      close(open);
      const m = HEADING.exec(line);
      if (!m) {
        errors.push(`${path}:${n}: a heading must be "## d-" and 10 hex digits, as the sheet was written; got "${line}"`);
        open = null;
        return;
      }
      if (items.some((x) => x.draftId === m[1])) errors.push(`${path}:${n}: ${m[1]} appears twice`);
      open = { item: { draftId: m[1], line: n, decision: null, document: "", kind: "", question: "", quote: null, paraphrases: [] }, seen: new Set(), inParaphrases: false, hasQuote: false, hasParaphrases: false };
      return;
    }
    if (!open) return; // the introduction before the first item is free text
    const o: Open = open;
    if (line.trim() === "") return;
    const bullet = /^\s*-(?: (.*))?$/.exec(line);
    if (bullet) {
      const value = (bullet[1] ?? "").trim();
      if (!o.inParaphrases) errors.push(`${path}:${n}: a "- " line belongs under paraphrases:`);
      else if (value === "") errors.push(`${path}:${n}: empty paraphrase`);
      else o.item.paraphrases.push(value);
      return;
    }
    const kv = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (!kv || !(KEYS as readonly string[]).includes(kv[1])) {
      errors.push(`${path}:${n}: cannot read "${line}"; expected one of ${KEYS.map((k) => k + ":").join(" ")} or a "- " paraphrase`);
      return;
    }
    const [key, value = ""] = [kv[1], (kv[2] ?? "").trim()];
    if (o.seen.has(key)) {
      errors.push(`${path}:${n}: ${o.item.draftId} has a second ${key}: line`);
      return;
    }
    o.seen.add(key);
    o.inParaphrases = key === "paraphrases";
    if (key === "paraphrases") {
      if (value) errors.push(`${path}:${n}: put each paraphrase on its own "- " line under paraphrases:`);
      return;
    }
    if (key === "decision") {
      if (value === "") o.item.decision = null;
      else if ((DECISIONS as readonly string[]).includes(value)) o.item.decision = value as Decision;
      else errors.push(`${path}:${n}: decision must be keep, edit, reject or empty; got "${value}"`);
      return;
    }
    if (key === "quote") {
      o.item.quote = value;
      return;
    }
    if (key === "document") o.item.document = value;
    else if (key === "kind") o.item.kind = value;
    else if (key === "question") o.item.question = value;
  });
  close(open);
  if (errors.length) throw new Error(`${path} has ${errors.length} problem${errors.length === 1 ? "" : "s"}:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  return items;
}

export interface ApplyContext {
  drafts: Draft[];
  golden: GoldenItem[];
  /** Full text of a draft's document in its eval database, or null when it is not there. */
  documentText: (d: Draft) => string | null;
  stems: StemMap;
  /** YYYY-MM-DD. */
  today: string;
}

export interface ApplyResult {
  approved: GoldenItem[];
  rejected: string[];
  undecided: string[];
  /** Kept or rejected in an earlier run of the same sheet. */
  alreadyApplied: string[];
  /** The drafts that stay pending. */
  remaining: Draft[];
}

/** The draft as the sheet item would make it. */
function edited(d: Draft, s: SheetItem): Draft {
  return { ...d, kind: s.kind as GoldenKind, question: s.question, quote: d.kind === "negative" ? null : s.quote, paraphrases: d.kind === "negative" ? [] : s.paraphrases };
}

function changedFields(d: Draft, s: SheetItem): string[] {
  const out: string[] = [];
  if (s.kind !== d.kind) out.push("kind");
  if (s.question !== d.question) out.push("question");
  if (d.kind !== "negative") {
    if (s.quote !== d.quote) out.push("quote");
    if (JSON.stringify(s.paraphrases) !== JSON.stringify(d.paraphrases)) out.push("paraphrases");
  }
  return out;
}

/**
 * Applies a parsed sheet. keep and edit become golden items (source generated, approved_by owner, approved_at today,
 * edited when any field changed); reject drops the draft; an empty decision leaves it pending. Every kept or edited
 * item passes the automatic checks again against the eval database. Throws, applying nothing, when any item has a
 * problem: an unknown draft id, a changed document line, keep with changed fields, a negative turned positive (or the
 * reverse), an unknown kind, or a failed check.
 */
export function applySheet(items: SheetItem[], c: ApplyContext): ApplyResult {
  const errors: string[] = [];
  const byId = new Map(c.drafts.map((d) => [d.draft_id, d]));
  const goldenIds = new Set(c.golden.map((g) => g.id));
  const result: ApplyResult = { approved: [], rejected: [], undecided: [], alreadyApplied: [], remaining: [] };
  const others = [...c.golden.map((g) => ({ id: g.id, question: g.question }))];
  for (const s of items) {
    const d = byId.get(s.draftId);
    if (!d) {
      if (s.decision !== null && (goldenIds.has(s.draftId) || s.decision === "reject")) result.alreadyApplied.push(s.draftId);
      else if (s.decision === null) result.undecided.push(s.draftId);
      else errors.push(`${s.draftId} (line ${s.line}): no pending draft has this id`);
      continue;
    }
    if (s.document !== documentLine(d)) errors.push(`${s.draftId} (line ${s.line}): the document line was changed; it must read "${documentLine(d)}"`);
    if (s.decision === null) {
      result.undecided.push(s.draftId);
      continue;
    }
    if (s.decision === "reject") {
      result.rejected.push(s.draftId);
      continue;
    }
    const changed = changedFields(d, s);
    if (s.decision === "keep" && changed.length) {
      errors.push(`${s.draftId} (line ${s.line}): decision keep but ${changed.join(", ")} changed; use edit, or undo the change`);
      continue;
    }
    if ((s.kind === "negative") !== (d.kind === "negative")) {
      errors.push(`${s.draftId} (line ${s.line}): ${d.kind === "negative" ? "a negative question cannot become positive" : "a question with a quote cannot become negative; reject it instead"}`);
      continue;
    }
    if (s.kind !== "negative" && !(DRAFT_KINDS as readonly string[]).includes(s.kind)) {
      errors.push(`${s.draftId} (line ${s.line}): kind must be one of ${DRAFT_KINDS.join(", ")}; got "${s.kind}"`);
      continue;
    }
    const next = edited(d, s);
    // Against the golden set and the items approved above; pending drafts were compared with each other when drafted.
    const problems = draftProblems(next, { documentText: c.documentText(d), others, stems: c.stems });
    if (problems.length) {
      errors.push(`${s.draftId} (line ${s.line}): ${problems.join("; ")}`);
      continue;
    }
    const item = toGoldenItem(next, c.today, changed.length > 0);
    if ("errors" in item) {
      errors.push(`${s.draftId} (line ${s.line}): ${item.errors}`);
      continue;
    }
    result.approved.push(item);
    others.push({ id: item.id, question: item.question });
  }
  if (errors.length) throw new Error(`nothing applied; fix the sheet and run approve again:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  const gone = new Set([...result.approved.map((a) => a.id), ...result.rejected]);
  result.remaining = c.drafts.filter((d) => !gone.has(d.draft_id));
  return result;
}

/** The questions whose stems approve needs: every kept or edited question as the sheet has it, golden items, other drafts. */
export function questionsToStem(items: SheetItem[], drafts: Draft[], golden: GoldenItem[]): string[] {
  return [...items.map((s) => s.question), ...drafts.map((d) => d.question), ...golden.map((g) => g.question)];
}

export interface ApproveOptions {
  /** The fixtures golden file; approved real items go to golden-real.jsonl next to it (appendGolden routes them). */
  goldenPath: string;
  /** The fixtures drafts file; a real sheet's drafts are in drafts-real.jsonl next to it. */
  draftsPath: string;
  /** The eval database of a corpus (brain_eval or brain_real_eval), opened and checked by the caller; only read. */
  sql: (corpus: Corpus) => Db | Promise<Db>;
  /** YYYY-MM-DD; defaults to today (UTC). */
  today?: string;
}

/**
 * `brain eval approve --sheet`: parses the sheet, rechecks every kept or edited item against its eval database (the
 * document's text, Postgres stems for the duplicate check), then appends the approved items to the golden set and
 * rewrites eval/drafts.jsonl without the approved and rejected drafts. Nothing is written when anything fails.
 */
export async function approveSheetFile(sheetPath: string, opts: ApproveOptions): Promise<ApplyResult> {
  const items = parseSheet(await readFile(sheetPath, "utf8"), sheetPath);
  // A sheet holds one corpus's drafts: real sheets sit in the gitignored review/real/ and their drafts in
  // drafts-real.jsonl. Every item is looked up in both drafts files, so a mixed sheet is refused before anything runs.
  const corpus = sheetCorpus(sheetPath);
  const pending = { fixtures: await loadDrafts(draftsFileFor(opts.draftsPath, "fixtures")), real: await loadDrafts(draftsFileFor(opts.draftsPath, "real")) };
  const found = new Set<Corpus>();
  for (const s of items) for (const c of ["fixtures", "real"] as const) if (pending[c].some((d) => d.draft_id === s.draftId)) found.add(c);
  if (found.size > 1) throw new Error(`${sheetPath} mixes the fixtures and real corpora; approve each corpus's drafts from its own sheet`);
  if (found.has("real") && corpus !== "real") {
    throw new Error(`${sheetPath} holds real drafts but is not under a review/real/ directory; real sheets stay in the gitignored eval/review/real/`);
  }
  if (found.has("fixtures") && corpus !== "fixtures") throw new Error(`${sheetPath} is under review/real/ but holds fixtures drafts`);
  const draftsPath = draftsFileFor(opts.draftsPath, corpus);
  const drafts = pending[corpus];
  const golden = await loadGoldenAll(opts.goldenPath);
  const byId = new Map(drafts.map((d) => [d.draft_id, d]));
  const toCheck = items.filter((s) => s.decision === "keep" || s.decision === "edit").map((s) => byId.get(s.draftId)).filter((d): d is Draft => !!d);
  const corpora = [...new Set(toCheck.map((d) => d.corpus))];
  const texts = new Map<string, string>();
  let stems: StemMap = new Map();
  if (corpora.length === 1) {
    const sql = await opts.sql(corpora[0]);
    // brain_eval is rebuilt from eval/corpus, so a fixture is found by its origin when its id has changed.
    const rows = await sql<{ id: string; origin: string | null; raw_content: string }[]>`
      select id, origin, raw_content from brain.documents
      where id = any(${toCheck.map((d) => d.document.id)}::uuid[]) or origin = any(${toCheck.map((d) => d.document.origin ?? "")}::text[])`;
    for (const r of rows) {
      texts.set(r.id, r.raw_content);
      if (r.origin) texts.set(`origin:${r.origin}`, r.raw_content);
    }
    stems = await stemAll(sql, questionsToStem(items, drafts, golden));
  }
  const result = applySheet(items, {
    drafts,
    golden,
    documentText: (d) => texts.get(d.document.id) ?? (d.document.origin ? texts.get(`origin:${d.document.origin}`) : undefined) ?? null,
    stems,
    today: opts.today ?? new Date().toISOString().slice(0, 10),
  });
  await appendGolden(opts.goldenPath, result.approved);
  await saveDrafts(draftsPath, result.remaining);
  return result;
}
