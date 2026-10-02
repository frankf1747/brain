import type { Expected, GoldenKind } from "./golden.js";
import type { Timings } from "../retrieve/contract.js";

export interface RankedDoc {
  documentId: string;
  origin: string | null;
  /**
   * True when this passage is relevant for nDCG: it is a chunk of an expected document and contains one
   * of the item's expected quotes (whitespace-normalised). Only meaningful when the item has quotes.
   */
  containsQuote: boolean;
}

/** One golden item after searching: what came back, in passage order (hybrid then graph then fallback). */
export interface QuestionResult {
  id: string;
  kind: GoldenKind;
  negative: boolean;
  expected: Expected[];
  ranked: RankedDoc[];
  /** Relevant passages in the whole corpus (the nDCG denominator); 0 when the item has no quotes. */
  totalRelevant: number;
  topScore: number | null;
  hasGraphPassage: boolean;
  degraded: boolean;
  /** The search's own total (timings.totalMs), not wall-clock around the call. */
  totalMs: number;
  /** The search's stage timings. */
  timings: Timings;
  paraphraseRanked: RankedDoc[][];
  /** Whether each paraphrase search ran degraded, parallel to paraphraseRanked. */
  paraphraseDegraded: boolean[];
}

export interface RankMetrics {
  n: number;
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  /** Mean over items that have quotes; null when none do. */
  ndcgAt10: number | null;
}

export interface Report {
  n: number;
  overall: RankMetrics;
  byKind: Record<string, RankMetrics>;
  /** abstentionRate and falseAnswerRate need not sum to 1 (a graph-only answer below threshold is neither). */
  negatives: { n: number; abstentionRate: number; falseAnswerRate: number };
  /** See paraphraseStats. */
  paraphrase: { n: number; consistency: number; meanRecallDelta: number };
  /** Share of all searches (originals and paraphrases) that ran degraded. */
  degradedFraction: number;
  latencyMs: Percentiles;
  /** p50/p95 of each search stage over the main questions. Optional: baselines recorded before Phase 4 have none. */
  stageLatencyMs?: StageLatency;
}

export interface Percentiles {
  p50: number;
  p95: number;
}

export interface StageLatency {
  embed: Percentiles;
  sql: Percentiles;
  rerank: Percentiles;
  graph: Percentiles;
}

/** By document id, exact origin, or origin ending in "/" + the expected origin (a path-segment suffix). */
export function matchesExpected(e: Expected, d: Pick<RankedDoc, "documentId" | "origin">): boolean {
  if (e.document_id && e.document_id === d.documentId) return true;
  if (e.origin && d.origin && (d.origin === e.origin || d.origin.endsWith("/" + e.origin))) return true;
  return false;
}

/** Distinct documents in rank order. */
function uniqueDocs(ranked: RankedDoc[]): RankedDoc[] {
  const seen = new Set<string>();
  return ranked.filter((d) => (seen.has(d.documentId) ? false : (seen.add(d.documentId), true)));
}

/** Indices of the expected entries matched by a document in the top k passages. */
function foundAtK(expected: Expected[], ranked: RankedDoc[], k: number): Set<number> {
  const top = uniqueDocs(ranked.slice(0, k));
  const found = new Set<number>();
  expected.forEach((e, i) => {
    if (top.some((d) => matchesExpected(e, d))) found.add(i);
  });
  return found;
}

/**
 * Set recall@k: the fraction of expected documents that appear among the top k PASSAGES (the cut is
 * taken on passages first, then documents are deduplicated). 0 when nothing is expected.
 */
export function setRecallAtK(expected: Expected[], ranked: RankedDoc[], k: number): number {
  if (expected.length === 0) return 0;
  return foundAtK(expected, ranked, k).size / expected.length;
}

/**
 * Reciprocal rank of the first expected document, where rank counts DISTINCT documents (repeated
 * passages of one document occupy a single rank). 0 on a miss; the report averages it into MRR.
 */
export function mrr(expected: Expected[], ranked: RankedDoc[]): number {
  const docs = uniqueDocs(ranked);
  for (let i = 0; i < docs.length; i++) if (expected.some((e) => matchesExpected(e, docs[i]))) return 1 / (i + 1);
  return 0;
}

/**
 * nDCG@10 with binary relevance per passage position: DCG = sum over the top 10 of rel_i / log2(i + 1)
 * (1-based i); the ideal DCG places min(totalRelevant, 10) relevant passages first, where totalRelevant
 * counts relevant passages in the whole corpus, not only the retrieved ones. 0 when totalRelevant is 0.
 */
export function ndcgAt10(relevant: boolean[], totalRelevant: number): number {
  if (totalRelevant <= 0) return 0;
  const dcg = relevant.slice(0, 10).reduce((s, r, i) => s + (r ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Math.min(totalRelevant, 10);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return dcg / idcg;
}

/** The search declined to answer: no hybrid score at or above the threshold and no graph passage. */
export function abstained(r: QuestionResult, threshold: number): boolean {
  return (r.topScore === null || r.topScore < threshold) && !r.hasGraphPassage;
}

/** On a negative item, the search answered confidently: the top hybrid score reached the threshold. */
export function falseAnswer(r: QuestionResult, threshold: number): boolean {
  return r.topScore !== null && r.topScore >= threshold;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Nearest-rank percentile: the smallest value with at least p% of the values at or below it. */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function rankMetrics(items: QuestionResult[]): RankMetrics {
  const withQuotes = items.filter((i) => i.expected.some((e) => e.quote));
  return {
    n: items.length,
    recallAt1: mean(items.map((i) => setRecallAtK(i.expected, i.ranked, 1))),
    recallAt5: mean(items.map((i) => setRecallAtK(i.expected, i.ranked, 5))),
    recallAt10: mean(items.map((i) => setRecallAtK(i.expected, i.ranked, 10))),
    mrr: mean(items.map((i) => mrr(i.expected, i.ranked))),
    ndcgAt10: withQuotes.length ? mean(withQuotes.map((i) => ndcgAt10(i.ranked.map((d) => d.containsQuote), i.totalRelevant))) : null,
  };
}

/**
 * Paraphrase robustness over positive items. A paraphrase is consistent when the SET of expected entries
 * found in its top 10 passages equals the set the original question found (two empty sets are
 * consistent, so items the original misses entirely still count). consistency is the share of consistent
 * paraphrases; meanRecallDelta is the mean of (paraphrase recall@10 - original recall@10), positive when
 * paraphrases do better.
 */
function paraphraseStats(positives: QuestionResult[]): Report["paraphrase"] {
  const consistent: boolean[] = [];
  const deltas: number[] = [];
  for (const r of positives) {
    const orig = foundAtK(r.expected, r.ranked, 10);
    for (const pr of r.paraphraseRanked) {
      const para = foundAtK(r.expected, pr, 10);
      consistent.push(para.size === orig.size && [...para].every((i) => orig.has(i)));
      deltas.push(setRecallAtK(r.expected, pr, 10) - setRecallAtK(r.expected, r.ranked, 10));
    }
  }
  return {
    n: consistent.length,
    consistency: consistent.length ? consistent.filter(Boolean).length / consistent.length : 0,
    meanRecallDelta: mean(deltas),
  };
}

export function summarize(results: QuestionResult[], threshold: number): Report {
  const positives = results.filter((r) => !r.negative);
  const negatives = results.filter((r) => r.negative);
  const byKind: Record<string, RankMetrics> = {};
  for (const kind of new Set(positives.map((r) => r.kind))) byKind[kind] = rankMetrics(positives.filter((r) => r.kind === kind));
  const latencies = results.map((r) => r.totalMs);
  const stage = (pick: (t: Timings) => number): Percentiles => {
    const xs = results.map((r) => pick(r.timings));
    return { p50: percentile(xs, 50), p95: percentile(xs, 95) };
  };
  const searches = results.flatMap((r) => [r.degraded, ...r.paraphraseDegraded]);
  const rate = (pred: (r: QuestionResult) => boolean) => (negatives.length ? negatives.filter(pred).length / negatives.length : 0);
  return {
    n: results.length,
    overall: rankMetrics(positives),
    byKind,
    negatives: {
      n: negatives.length,
      abstentionRate: rate((r) => abstained(r, threshold)),
      falseAnswerRate: rate((r) => falseAnswer(r, threshold)),
    },
    paraphrase: paraphraseStats(positives),
    degradedFraction: searches.length ? searches.filter(Boolean).length / searches.length : 0,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    stageLatencyMs: { embed: stage((t) => t.embedMs), sql: stage((t) => t.sqlMs), rerank: stage((t) => t.rerankMs), graph: stage((t) => t.graphMs) },
  };
}
