import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

export const GOLDEN_KINDS = ["keyword", "semantic", "graph", "filter", "fallback", "attribution", "negative"] as const;
export type GoldenKind = (typeof GOLDEN_KINDS)[number];

/** Where an item came from: written with the fixture corpus, drafted by `eval draft`, or labelled from a logged search. */
export const GOLDEN_SOURCES = ["fixture", "generated", "captured"] as const;
export type GoldenSource = (typeof GOLDEN_SOURCES)[number];

/** Who approved the item. Drafted and captured items are always approved by the owner; agents never approve them. */
export const APPROVERS = ["owner", "agent"] as const;
export type Approver = (typeof APPROVERS)[number];

/** Which eval database the item runs against: brain_eval (eval/corpus) or brain_real_eval (a copy of the real base). */
export const CORPORA = ["fixtures", "real"] as const;
export type Corpus = (typeof CORPORA)[number];

/**
 * Where each corpus's items live. The repository is public and a real item quotes the owner's own documents, so real
 * items stay in eval/golden-real.jsonl, which is gitignored; eval/golden.jsonl (committed) holds fixtures items only.
 */
export const GOLDEN_FILES: Record<Corpus, string> = { fixtures: "eval/golden.jsonl", real: "eval/golden-real.jsonl" };

const REAL_SUFFIX = "-real.jsonl";

/** The corpus a golden file holds, from its name: `*-real.jsonl` holds real items, any other file fixtures items. */
export function goldenFileCorpus(path: string): Corpus {
  return basename(path).endsWith(REAL_SUFFIX) ? "real" : "fixtures";
}

/**
 * The file that holds one corpus's items, next to the given golden file: `golden.jsonl` and `golden-real.jsonl` in the
 * same directory. Either name of the pair may be given.
 */
export function goldenFileFor(path: string, corpus: Corpus): string {
  const name = basename(path);
  const stem = name.endsWith(REAL_SUFFIX) ? name.slice(0, -REAL_SUFFIX.length) : name.replace(/\.jsonl$/, "");
  const file = corpus === "real" ? `${stem}${REAL_SUFFIX}` : `${stem}.jsonl`;
  return join(dirname(path), file);
}

/** Why an item may not sit in a file that holds `fileCorpus` items; null when it may. */
function wrongFileProblem(item: GoldenItem, fileCorpus: Corpus): string | null {
  if (item.corpus === fileCorpus) return null;
  return item.corpus === "real"
    ? `a corpus "real" item quotes the owner's private documents; it belongs in golden-real.jsonl (gitignored), not in the fixtures file`
    : `a corpus "fixtures" item belongs in golden.jsonl, not in the real file`;
}

const ExpectedSchema = z.object({
  /** Suffix of documents.origin, e.g. the fixture file name. */
  origin: z.string().min(1).optional(),
  /** A document id, for items about the real base (ids survive `eval sync`). */
  document_id: z.string().uuid().optional(),
  /** Verbatim span from the document; when present, a passage is relevant only if it contains it. */
  quote: z.string().min(1).optional(),
}).strict().refine((e) => e.origin || e.document_id, { message: "expected needs origin or document_id" });

export const GoldenItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(GOLDEN_KINDS),
  expected: z.array(ExpectedSchema),
  filters: z.object({ sourceKinds: z.array(z.string()).optional() }).strict().optional(),
  paraphrases: z.array(z.string().min(1)).optional(),
  source: z.enum(GOLDEN_SOURCES),
  negative: z.boolean().default(false),
  corpus: z.enum(CORPORA).default("fixtures"),
  approved_by: z.enum(APPROVERS),
  approved_at: z.string().min(1),
  /** Generated items only: true when the owner changed the drafted question, quote, kind or paraphrases before approving. */
  edited: z.boolean().optional(),
  /** Captured items only: the logged search the question came from. */
  retrieval_id: z.string().uuid().optional(),
}).strict();
export type GoldenItem = z.infer<typeof GoldenItemSchema>;
export type GoldenInput = z.input<typeof GoldenItemSchema>;
export type Expected = z.infer<typeof ExpectedSchema>;

/** The rules a schema cannot express. Empty means the item is valid. */
export function goldenItemProblems(item: GoldenItem): string[] {
  const out: string[] = [];
  if ((item.kind === "negative") !== item.negative) out.push('kind "negative" and negative: true must go together');
  if (item.negative && item.expected.length > 0) out.push("a negative item must not list expected documents");
  if (!item.negative && item.expected.length === 0) out.push("expected is empty; mark the item negative or list a document");
  if (item.source !== "fixture" && item.approved_by !== "owner") out.push(`a ${item.source} item must be approved by the owner`);
  if (item.edited !== undefined && item.source !== "generated") out.push("edited is only for generated items");
  if ((item.retrieval_id !== undefined) !== (item.source === "captured")) out.push("retrieval_id is required on captured items and only there");
  // brain_eval is rebuilt from eval/corpus, so its document ids change; fixture items name documents by file name.
  if (item.corpus === "fixtures" && item.expected.some((e) => !e.origin)) out.push("a fixtures item names each expected document by origin");
  if (item.kind === "filter" && !item.filters?.sourceKinds?.length) out.push("a filter item needs filters.sourceKinds");
  return out;
}

const issueText = (issues: z.ZodError["issues"]) => issues.map((x) => (x.path.length ? `${x.path.join(".")}: ${x.message}` : x.message)).join("; ");

/** Schema and rules for one item; the errors are what parseGolden would report for it. */
export function validateGoldenItem(raw: unknown): { ok: true; item: GoldenItem } | { ok: false; errors: string } {
  const parsed = GoldenItemSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: issueText(parsed.error.issues) };
  const problems = goldenItemProblems(parsed.data);
  return problems.length ? { ok: false, errors: problems.join("; ") } : { ok: true, item: parsed.data };
}

/**
 * One JSON object per line; blank lines are ignored. Unknown keys are rejected. Throws with the line number
 * (and the field path for schema errors) on the first invalid line. With `fileCorpus`, the text is one corpus's file
 * and an item of the other corpus is an error (a real item must never reach the committed fixtures file).
 */
export function parseGolden(text: string, fileCorpus?: Corpus): GoldenItem[] {
  const items: GoldenItem[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`golden line ${i + 1}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = GoldenItemSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`golden line ${i + 1}: ${issueText(parsed.error.issues)}`);
    const item = parsed.data;
    if (seen.has(item.id)) throw new Error(`golden line ${i + 1}: duplicate id ${item.id}`);
    seen.add(item.id);
    const problems = goldenItemProblems(item);
    const wrongFile = fileCorpus ? wrongFileProblem(item, fileCorpus) : null;
    if (wrongFile) problems.unshift(wrongFile);
    if (problems.length) throw new Error(`golden line ${i + 1} (${item.id}): ${problems.join("; ")}`);
    items.push(item);
  }
  return items;
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Reads one golden file, which must hold only its own corpus's items (goldenFileCorpus); a missing file is an empty set. */
export async function loadGolden(path: string): Promise<GoldenItem[]> {
  return parseGolden(await readOrEmpty(path), goldenFileCorpus(path));
}

/** Both corpora's items: the fixtures file and the real file next to it (goldenFileFor). */
export async function loadGoldenAll(path: string): Promise<GoldenItem[]> {
  const all = [...(await loadGolden(goldenFileFor(path, "fixtures"))), ...(await loadGolden(goldenFileFor(path, "real")))];
  const seen = new Set<string>();
  for (const i of all) {
    if (seen.has(i.id)) throw new Error(`golden: id ${i.id} is in both ${goldenFileFor(path, "fixtures")} and ${goldenFileFor(path, "real")}`);
    seen.add(i.id);
  }
  return all;
}

/** One line of eval/golden.jsonl, keys in a fixed order; negative is written only when true. */
export function goldenLine(item: GoldenItem): string {
  const ordered: Record<string, unknown> = { id: item.id, question: item.question, kind: item.kind, expected: item.expected };
  if (item.filters) ordered.filters = item.filters;
  if (item.paraphrases) ordered.paraphrases = item.paraphrases;
  ordered.source = item.source;
  if (item.negative) ordered.negative = true;
  ordered.corpus = item.corpus;
  ordered.approved_by = item.approved_by;
  ordered.approved_at = item.approved_at;
  if (item.edited !== undefined) ordered.edited = item.edited;
  if (item.retrieval_id !== undefined) ordered.retrieval_id = item.retrieval_id;
  return JSON.stringify(ordered);
}

/**
 * Appends items to the golden files, each to its corpus's file (goldenFileFor: fixtures items to golden.jsonl, real items
 * to the gitignored golden-real.jsonl next to it; either name may be given), after checking every result parses (unique
 * ids across both files, every rule). Existing lines are kept byte for byte; nothing is written when any check fails.
 */
export async function appendGolden(path: string, items: GoldenItem[]): Promise<void> {
  const writes: { file: string; next: string }[] = [];
  const ids = new Set<string>();
  for (const corpus of CORPORA) {
    const file = goldenFileFor(path, corpus);
    const text = await readOrEmpty(file);
    const mine = items.filter((i) => i.corpus === corpus);
    const next = mine.length === 0 ? text : (text === "" || text.endsWith("\n") ? text : text + "\n") + mine.map(goldenLine).join("\n") + "\n";
    for (const i of parseGolden(next, corpus)) {
      if (ids.has(i.id)) throw new Error(`golden: duplicate id ${i.id} across ${goldenFileFor(path, "fixtures")} and ${goldenFileFor(path, "real")}`);
      ids.add(i.id);
    }
    if (mine.length) writes.push({ file, next });
  }
  for (const w of writes) await writeFile(w.file, w.next);
}

/** The items that run against one corpus. */
export function forCorpus(items: GoldenItem[], corpus: Corpus): GoldenItem[] {
  return items.filter((i) => i.corpus === corpus);
}

/** How many items each approver approved; printed by `eval run` and stated in the README. */
export function approvalCounts(items: GoldenItem[]): Record<Approver, number> {
  return { owner: items.filter((i) => i.approved_by === "owner").length, agent: items.filter((i) => i.approved_by === "agent").length };
}
