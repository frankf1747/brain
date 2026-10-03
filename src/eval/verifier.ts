import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Db } from "../db.js";
import { VERDICTS, VerdictSchema, factText, passageText, verifyTexts, type ClaimResult, type ClaimToJudge, type Verdict } from "../verify/verify.js";

/**
 * The verifier's own eval (spec §7, roadmap Phase 5 task 6). Each item of eval/verifier.jsonl is a claim, the texts it
 * cites (quoted verbatim from eval/corpus, or a fact written out), and the verdict a careful reader assigns. Items carry
 * their cited texts inline, so the set needs no ingested corpus and no retrieval ids: it runs the same judging code as
 * brain_verify (verify.ts) with stems from Postgres, and nothing else. No model and no Voyage call.
 */

/** What each item exercises; the fixture test requires every case at least once. */
export const VERIFIER_CASES = [
  "exact", "paraphrase", "wrong_number", "negation", "unrelated", "two_passages", "no_terms", "fact", "number_form", "date_form",
  "hedged", "partial_overlap", "uncited", "bad_citation", "known_limit", "polarity", "number_word",
] as const;

const PassageCiteSchema = z.object({
  label: z.string().regex(/^P\d+$/),
  /** Verbatim from one of the item's retrieval.documents (whitespace may differ). */
  text: z.string().min(1),
  heading_path: z.array(z.string()).optional(),
}).strict();
const FactCiteSchema = z.object({ label: z.string().regex(/^F\d+$/), predicate: z.string().min(1), object_text: z.string().min(1) }).strict();
/** A label the retrieval does not have. */
const MissingCiteSchema = z.object({ label: z.string().min(1), missing: z.literal(true) }).strict();

export const VerifierItemSchema = z.object({
  id: z.string().min(1),
  case: z.enum(VERIFIER_CASES),
  /** The fixture files (eval/corpus) the passage texts are quoted from. */
  retrieval: z.object({ documents: z.array(z.string().min(1)) }).strict(),
  claim: z.string().min(1).max(2000),
  cites: z.array(z.union([PassageCiteSchema, FactCiteSchema, MissingCiteSchema])),
  expected_verdict: VerdictSchema,
  note: z.string().min(1),
  /** agent:<name> or owner. */
  labelled_by: z.string().min(1),
}).strict();
export type VerifierItem = z.infer<typeof VerifierItemSchema>;

/** One JSON object per line; blank lines are ignored. Throws with the line number on the first invalid line or duplicate id. */
export function parseVerifierSet(text: string): VerifierItem[] {
  const items: VerifierItem[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`verifier line ${i + 1}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = VerifierItemSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`verifier line ${i + 1}: ${parsed.error.issues.map((x) => (x.path.length ? `${x.path.join(".")}: ${x.message}` : x.message)).join("; ")}`);
    }
    if (seen.has(parsed.data.id)) throw new Error(`verifier line ${i + 1}: duplicate id ${parsed.data.id}`);
    seen.add(parsed.data.id);
    items.push(parsed.data);
  }
  return items;
}

/** An item as the judge sees it: passages as heading path plus text, facts as predicate plus object, missing labels as bad. */
export function toClaim(item: VerifierItem): ClaimToJudge {
  const claim: ClaimToJudge = { text: item.claim, labels: item.cites.map((c) => c.label), cited: [], cites: [], badLabels: [] };
  for (const c of item.cites) {
    if ("missing" in c) claim.badLabels.push({ label: c.label, reason: "not in the retrieval" });
    else if ("text" in c) claim.cited.push({ label: c.label, kind: "passage", text: passageText(c.heading_path ?? [], c.text) });
    else claim.cited.push({ label: c.label, kind: "fact", text: factText(c.predicate, c.object_text) });
  }
  return claim;
}

export interface VerifierReport {
  n: number;
  /** Share of items whose verdict equals the label. */
  accuracy: number;
  /** Of the items the verifier marked supported, the share labelled supported; null when it marked none. */
  precision: number | null;
  /** Of the items labelled supported, the share the verifier marked supported; null when none is labelled supported. */
  recall: number | null;
  /** confusion[expected][predicted]: item counts. */
  confusion: Record<Verdict, Record<Verdict, number>>;
}

export function verifierReport(pairs: { expected: Verdict; predicted: Verdict }[]): VerifierReport {
  const confusion = Object.fromEntries(VERDICTS.map((e) => [e, Object.fromEntries(VERDICTS.map((p) => [p, 0]))])) as Record<Verdict, Record<Verdict, number>>;
  for (const { expected, predicted } of pairs) confusion[expected][predicted]++;
  const tp = confusion.supported.supported;
  const markedSupported = VERDICTS.reduce((s, e) => s + confusion[e].supported, 0);
  const labelledSupported = VERDICTS.reduce((s, p) => s + confusion.supported[p], 0);
  const correct = VERDICTS.reduce((s, v) => s + confusion[v][v], 0);
  return {
    n: pairs.length,
    accuracy: pairs.length ? correct / pairs.length : 0,
    precision: markedSupported ? tp / markedSupported : null,
    recall: labelledSupported ? tp / labelledSupported : null,
    confusion,
  };
}

/** The gate's floor for precision of `supported`: a claim wrongly marked supported is worse than one wrongly flagged. */
export const VERIFIER_PRECISION_MIN = 0.9;
const EPSILON = 1e-9;

/** Reasons the verifier set fails the gate; empty means pass. */
export function verifierGate(r: VerifierReport): string[] {
  if (r.precision === null) return ["verifier: no claim was marked supported, so precision of supported is undefined"];
  if (r.precision < VERIFIER_PRECISION_MIN - EPSILON) return [`verifier: precision of supported is ${r.precision.toFixed(3)}, below ${VERIFIER_PRECISION_MIN}`];
  return [];
}

const ratio = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));

/** The one line `eval run` prints. */
export function verifierLine(r: VerifierReport): string {
  return `verifier  n=${r.n}  supported precision=${ratio(r.precision)} recall=${ratio(r.recall)}  accuracy=${ratio(r.accuracy)}`;
}

export interface VerifierItemResult {
  id: string;
  case: VerifierItem["case"];
  expected: Verdict;
  predicted: Verdict;
  result: ClaimResult;
}

export interface VerifierRun {
  items: VerifierItemResult[];
  report: VerifierReport;
}

/** Judges every item with one stem query. Read-only: it writes nothing (not even verification_log). */
export async function runVerifierSet(sql: Db, items: VerifierItem[]): Promise<VerifierRun> {
  const results = await verifyTexts(sql, items.map(toClaim));
  const out = items.map((it, i) => ({ id: it.id, case: it.case, expected: it.expected_verdict, predicted: results[i].verdict, result: results[i] }));
  return { items: out, report: verifierReport(out) };
}

/** runVerifierSet on a file; null when the file does not exist. */
export async function runVerifierFile(sql: Db, path: string): Promise<VerifierRun | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return runVerifierSet(sql, parseVerifierSet(text));
}

/** `brain eval verifier`: one line per item (ok or MISS), the confusion matrix, and the summary line. */
export function renderVerifierRun(run: VerifierRun): string[] {
  const support = (s: number | null) => (s === null ? "-" : s.toFixed(2));
  const lines = run.items.map((i) =>
    i.expected === i.predicted
      ? `ok    ${i.id.padEnd(5)} ${i.case.padEnd(15)} ${i.predicted} ${support(i.result.support)}`
      : `MISS  ${i.id.padEnd(5)} ${i.case.padEnd(15)} expected ${i.expected}, got ${i.predicted} ${support(i.result.support)}`,
  );
  const w = 13;
  lines.push("", "confusion (rows: labelled, columns: verifier)", "".padEnd(w) + VERDICTS.map((v) => v.padStart(w)).join(""));
  for (const e of VERDICTS) lines.push(e.padEnd(w) + VERDICTS.map((p) => String(run.report.confusion[e][p]).padStart(w)).join(""));
  lines.push("", verifierLine(run.report));
  return lines;
}
