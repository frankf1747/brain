import { z } from "zod";
import type { Db } from "../db.js";
import {
  claimWords, citedNumberSet, extractNumbers, hasNegation, isContentLexeme, isNumberWord, polarityWords, splitSentences, stemAll, type StemMap,
} from "./terms.js";

/**
 * The citation verifier's method (spec §7.2): for one claim and the texts it cites, how much of the claim's
 * vocabulary the cited texts contain, whether they state every number and date the claim states, and whether
 * negation agrees. No model is called. Everything here is pure except verifyTexts, which fetches the stems.
 *
 * Definitions:
 *  - content terms: the distinct Postgres english lexemes of the claim's words, after labels ([P1]), numbers, dates
 *    and codes are removed, keeping lexemes that contain a letter and are not negation words (terms.ts).
 *  - cited stems: the union of the lexemes of every cited text. A passage's text is its heading path plus its content;
 *    a fact's is its predicate with underscores as spaces, a colon, and its object text.
 *  - support: |content terms ∩ cited stems| / |content terms|; null when the claim has no content terms.
 *  - numbers: every number, date and code in the claim must be in the cited texts' citedNumberSet.
 *  - negation mismatch: the claim has a negation word, but no sentence of the cited texts has one together with a
 *    matched term; or the claim has none, but such a sentence does.
 *  - polarity: every polarity word of the claim (up, down, before, after, more, less, all, some, only, will, might, …;
 *    terms.ts POLARITY_WORDS) must appear as a whole word in the cited texts, or the claim is capped at partial.
 *  - counting words: a missing term that is a number or ordinal word (one, first, dozen, tenth) caps it at partial.
 */

/** Lowest support for `supported`. */
export const SUPPORTED_MIN = 0.6;
/** Lowest support for `partial`; below it a claim with good citations is `unsupported`. */
export const PARTIAL_MIN = 0.3;

export const VERDICTS = ["supported", "partial", "unsupported", "uncited", "bad_citation"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ResolvedCiteSchema = z.object({
  /** The cite as given, normalised: P1, F2, or a chunk or fact id. */
  label: z.string(),
  kind: z.enum(["passage", "fact"]),
  /** The passage's document; for a fact, the document it was extracted from, or null when the owner stated it. */
  documentId: z.string().nullable(),
  /** Null for a fallback passage (a window of the raw document) and for facts. */
  chunkId: z.string().nullable(),
  /** Set for facts only. */
  factId: z.string().nullable(),
  /** The passage's document title; for a fact, the fact itself ("visa_status: F-1 OPT"). */
  title: z.string().nullable(),
});
export type ResolvedCite = z.infer<typeof ResolvedCiteSchema>;

export const BadLabelSchema = z.object({ label: z.string(), reason: z.string() });
export type BadLabel = z.infer<typeof BadLabelSchema>;

export const ClaimResultSchema = z.object({
  /** The claim as checked: the given text with citation labels removed. */
  claim: z.string(),
  /** The cites as given, normalised and without duplicates, in order. */
  labels: z.array(z.string()),
  verdict: VerdictSchema,
  /** Share of content terms found in the cited texts, 3 decimals; null without content terms or without a good cite. */
  support: z.number().nullable(),
  /** Content terms found, as the claim's own words (the first word that produced each stem). */
  matchedTerms: z.array(z.string()),
  /** Content terms not found, as the claim's own words. */
  missingTerms: z.array(z.string()),
  /** The claim's numbers, dates and codes (canonical form) that no cited text states. */
  missingNumbers: z.array(z.string()),
  negationMismatch: z.boolean(),
  /** The claim's polarity words (up, before, more, all, only, will, …) that no cited text contains. */
  missingPolarity: z.array(z.string()),
  /** Cites that name nothing in that search (or in the knowledge base), with the reason. */
  badLabels: z.array(BadLabelSchema),
  /** The good cites, resolved. */
  cites: z.array(ResolvedCiteSchema),
});
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

export const SummarySchema = z.object({
  supported: z.number().int(),
  partial: z.number().int(),
  unsupported: z.number().int(),
  uncited: z.number().int(),
  bad_citation: z.number().int(),
  /** "4 supported, 1 partial, 1 unsupported": the non-zero counts in verdict order. */
  text: z.string(),
});
export type Summary = z.infer<typeof SummarySchema>;

/** One cited text: a passage (heading path plus content) or a fact (predicate plus object). */
export interface CitedText {
  label: string;
  kind: "passage" | "fact";
  text: string;
}

/** A passage's cited text: its heading path joined with " > ", then its content. */
export function passageText(headingPath: string[], content: string): string {
  return [headingPath.join(" > "), content].filter((s) => s.trim() !== "").join("\n");
}

/** A fact's cited text: "visa status: F-1 OPT". */
export function factText(predicate: string, objectText: string): string {
  return `${predicate.replace(/_/g, " ")}: ${objectText}`;
}

/** [P1], [F2], [P1, F2] and [P1][F2], case-insensitive. */
export const LABEL_GROUP_RE = /\[\s*[PF]\d+(?:\s*[,;]\s*[PF]\d+)*\s*\]/gi;

/** The claim without its citation labels, with the space a label leaves before punctuation removed. */
export function stripLabels(text: string): string {
  return text.replace(LABEL_GROUP_RE, " ").replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim();
}

/** Every string checkClaim will look up in the stem map: the claim's words and the cited texts' sentences. */
export function stemInputs(claimText: string, cited: CitedText[]): string[] {
  const { rest } = extractNumbers(stripLabels(claimText));
  return [...claimWords(rest).map((w) => w.stemKey), ...cited.flatMap((c) => splitSentences(c.text))];
}

export interface ClaimCheck {
  /** Number of content terms in the claim. */
  termCount: number;
  /** Null when termCount is 0. Unrounded. */
  support: number | null;
  matchedTerms: string[];
  missingTerms: string[];
  /** Number of numbers, dates and codes in the claim. */
  numberCount: number;
  missingNumbers: string[];
  negationMismatch: boolean;
  /** Polarity words of the claim that no cited text contains. */
  missingPolarity: string[];
}

function lexemesOf(stems: StemMap, text: string): string[] {
  const l = stems.get(text);
  if (!l) throw new Error(`no stems for ${JSON.stringify(text)}; build the map from stemInputs`);
  return l;
}

/** Compares one claim with its cited texts. `stems` must hold every string stemInputs(claimText, cited) returns. */
export function checkClaim(claimText: string, cited: CitedText[], stems: StemMap): ClaimCheck {
  const claim = stripLabels(claimText);
  const { values: numbers, rest } = extractNumbers(claim);

  // Content terms in first-seen order, each shown as the first claim word that produced it.
  const word = new Map<string, string>();
  for (const w of claimWords(rest)) {
    for (const lexeme of lexemesOf(stems, w.stemKey)) if (isContentLexeme(lexeme) && !word.has(lexeme)) word.set(lexeme, w.display);
  }

  const sentences = cited.flatMap((c) => splitSentences(c.text)).map((s) => ({ text: s, lexemes: new Set(lexemesOf(stems, s)) }));
  const citedStems = new Set(sentences.flatMap((s) => [...s.lexemes]));
  const matched = [...word.keys()].filter((l) => citedStems.has(l));
  const missing = [...word.keys()].filter((l) => !citedStems.has(l));

  const citedNumbers = citedNumberSet(cited.flatMap((c) => extractNumbers(c.text).values));
  const missingNumbers = [...new Set(numbers)].filter((n) => !citedNumbers.has(n));

  const matchedSet = new Set(matched);
  const citedPolarity = new Set(cited.flatMap((c) => [...polarityWords(c.text)]));
  const missingPolarity = [...polarityWords(claim)].filter((w) => !citedPolarity.has(w));

  const citedNegates = sentences.some((s) => hasNegation(s.text) && [...s.lexemes].some((l) => matchedSet.has(l)));

  return {
    termCount: word.size,
    support: word.size === 0 ? null : matched.length / word.size,
    matchedTerms: [...new Set(matched.map((l) => word.get(l)!))],
    missingTerms: [...new Set(missing.map((l) => word.get(l)!))],
    numberCount: numbers.length,
    missingNumbers,
    negationMismatch: hasNegation(claim) !== citedNegates,
    missingPolarity,
  };
}

/**
 * The verdict, from the first rule that applies:
 *  1. no good cite: bad_citation if any cite was given (all of them bad), else uncited;
 *  2. no content terms (e.g. "Yes."): supported if it has no numbers, no negation mismatch and no missing polarity
 *     word; partial if it has numbers and the cited texts state all of them, or a negation mismatch, or a missing
 *     polarity word; unsupported if a number is missing;
 *  3. support < PARTIAL_MIN: unsupported (a missing number, polarity word or counting word, or a negation mismatch,
 *     never raises a verdict);
 *  4. support ≥ SUPPORTED_MIN, no missing number, no negation mismatch, no missing polarity word, and no missing term
 *     that is a number or ordinal word: supported;
 *  5. otherwise partial.
 */
export function verdictOf(check: ClaimCheck, goodCites: number, badCites: number): Verdict {
  if (goodCites === 0) return badCites > 0 ? "bad_citation" : "uncited";
  if (check.support === null) {
    if (check.numberCount === 0) return check.negationMismatch || check.missingPolarity.length ? "partial" : "supported";
    return check.missingNumbers.length === 0 ? "partial" : "unsupported";
  }
  if (check.support < PARTIAL_MIN) return "unsupported";
  const capped = check.missingNumbers.length > 0 || check.negationMismatch || check.missingPolarity.length > 0 || check.missingTerms.some(isNumberWord);
  if (check.support >= SUPPORTED_MIN && !capped) return "supported";
  return "partial";
}

/** One claim ready to judge: its text, its normalised labels, the good cites' texts and resolutions, and the bad ones. */
export interface ClaimToJudge {
  text: string;
  labels: string[];
  cited: CitedText[];
  cites: ResolvedCite[];
  badLabels: BadLabel[];
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Judges one claim. Pure: `stems` must hold every string stemInputs(claim.text, claim.cited) returns. */
export function judge(claim: ClaimToJudge, stems: StemMap): ClaimResult {
  const empty: ClaimCheck = { termCount: 0, support: null, matchedTerms: [], missingTerms: [], numberCount: 0, missingNumbers: [], negationMismatch: false, missingPolarity: [] };
  const check = claim.cited.length ? checkClaim(claim.text, claim.cited, stems) : empty;
  return {
    claim: stripLabels(claim.text),
    labels: claim.labels,
    verdict: verdictOf(check, claim.cited.length, claim.badLabels.length),
    support: check.support === null ? null : round3(check.support),
    matchedTerms: check.matchedTerms,
    missingTerms: check.missingTerms,
    missingNumbers: check.missingNumbers,
    negationMismatch: check.negationMismatch,
    missingPolarity: check.missingPolarity,
    badLabels: claim.badLabels,
    cites: claim.cites,
  };
}

/** Judges every claim with one stem query for all of them. */
export async function verifyTexts(sql: Db, claims: ClaimToJudge[]): Promise<ClaimResult[]> {
  const stems = await stemAll(sql, claims.flatMap((c) => (c.cited.length ? stemInputs(c.text, c.cited) : [])));
  return claims.map((c) => judge(c, stems));
}

const SUMMARY_WORDS: Record<Verdict, string> = { supported: "supported", partial: "partial", unsupported: "unsupported", uncited: "uncited", bad_citation: "bad citation" };

/** Counts per verdict and the one-line text ("4 supported, 1 partial, 1 unsupported"; "no claims" when empty). */
export function summarizeVerdicts(results: Pick<ClaimResult, "verdict">[]): Summary {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, results.filter((r) => r.verdict === v).length])) as Record<Verdict, number>;
  const text = VERDICTS.filter((v) => counts[v] > 0).map((v) => `${counts[v]} ${SUMMARY_WORDS[v]}`).join(", ") || "no claims";
  return { ...counts, text };
}
