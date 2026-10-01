import type { Expected, GoldenKind } from "./golden.js";

export interface RankedDoc {
  documentId: string;
  origin: string | null;
  /** True when the passage contains the expected quote (only meaningful when the item has quotes). */
  containsQuote: boolean;
}

/** One golden item after searching: what came back, in passage order (hybrid then graph then fallback). */
export interface QuestionResult {
  id: string;
  kind: GoldenKind;
  negative: boolean;
  expected: Expected[];
  ranked: RankedDoc[];
  topScore: number | null;
  hasGraphPassage: boolean;
  degraded: boolean;
  totalMs: number;
  paraphraseRanked: RankedDoc[][];
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
  negatives: { n: number; abstentionRate: number; falseAnswerRate: number };
  paraphrase: { n: number; consistency: number };
  degradedFraction: number;
  latencyMs: { p50: number; p95: number };
}

function matches(e: Expected, d: RankedDoc): boolean {
  if (e.document_id && e.document_id === d.documentId) return true;
  if (e.origin && d.origin && d.origin.endsWith(e.origin)) return true;
  return false;
}

/** Distinct documents in rank order. */
function uniqueDocs(ranked: RankedDoc[]): RankedDoc[] {
  const seen = new Set<string>();
  return ranked.filter((d) => (seen.has(d.documentId) ? false : (seen.add(d.documentId), true)));
}

export function setRecallAtK(expected: Expected[], ranked: RankedDoc[], k: number): number {
  if (expected.length === 0) return 0;
  const top = uniqueDocs(ranked).slice(0, k);
  const found = expected.filter((e) => top.some((d) => matches(e, d))).length;
  return found / expected.length;
}

export function mrr(expected: Expected[], ranked: RankedDoc[]): number {
  const docs = uniqueDocs(ranked);
  for (let i = 0; i < docs.length; i++) if (expected.some((e) => matches(e, docs[i]))) return 1 / (i + 1);
  return 0;
}

/** Binary relevance per passage position; ideal ordering puts every relevant passage first. */
export function ndcgAt10(relevant: boolean[]): number {
  const top = relevant.slice(0, 10);
  const dcg = top.reduce((s, r, i) => s + (r ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = top.filter(Boolean).length;
  if (ideal === 0) return 0;
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return dcg / idcg;
}

export function abstained(r: QuestionResult, threshold: number): boolean {
  return (r.topScore === null || r.topScore < threshold) && !r.hasGraphPassage;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

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
    ndcgAt10: withQuotes.length ? mean(withQuotes.map((i) => ndcgAt10(i.ranked.map((d) => d.containsQuote)))) : null,
  };
}

export function summarize(results: QuestionResult[], threshold: number): Report {
  const positives = results.filter((r) => !r.negative);
  const negatives = results.filter((r) => r.negative);
  const byKind: Record<string, RankMetrics> = {};
  for (const kind of new Set(positives.map((r) => r.kind))) byKind[kind] = rankMetrics(positives.filter((r) => r.kind === kind));
  const paraphrases = positives.flatMap((r) => r.paraphraseRanked.map((pr) => setRecallAtK(r.expected, pr, 10) === setRecallAtK(r.expected, r.ranked, 10)));
  const abst = negatives.map((r) => abstained(r, threshold));
  const latencies = results.map((r) => r.totalMs);
  return {
    n: results.length,
    overall: rankMetrics(positives),
    byKind,
    negatives: {
      n: negatives.length,
      abstentionRate: negatives.length ? abst.filter(Boolean).length / negatives.length : 0,
      falseAnswerRate: negatives.length ? abst.filter((a) => !a).length / negatives.length : 0,
    },
    paraphrase: { n: paraphrases.length, consistency: paraphrases.length ? paraphrases.filter(Boolean).length / paraphrases.length : 0 },
    degradedFraction: results.length ? results.filter((r) => r.degraded).length / results.length : 0,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  };
}
