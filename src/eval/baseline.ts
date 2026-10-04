import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Report } from "./metrics.js";

/** One golden item as a baseline records it: its id and the hash of its canonical line. */
export interface GoldenRef {
  id: string;
  sha256: string;
}

export interface Baseline {
  recordedAt: string;
  commit: string;
  /** Ids of every golden item the baseline was recorded on, sorted. */
  goldenIds: string[];
  /** Each item's id and goldenItemSha256, sorted by id. Optional: baselines recorded before Phase 7 have none. */
  goldenItems?: GoldenRef[];
  report: Report;
  /** 1-based rank of the first expected document per question id; null is a miss. */
  ranks: Record<string, number | null>;
}

const RankMetricsSchema = z.object({
  n: z.number(),
  recallAt1: z.number(),
  recallAt5: z.number(),
  recallAt10: z.number(),
  mrr: z.number(),
  ndcgAt10: z.number().nullable(),
});

const PercentilesSchema = z.object({ p50: z.number(), p95: z.number() });

const SplitAbstentionSchema = z.object({
  negatives: z.number(), abstentionRate: z.number(), falseAnswerRate: z.number(), positives: z.number(), falseAbstentionRate: z.number(),
});

const ReportSchema = z.object({
  n: z.number(),
  overall: RankMetricsSchema,
  byKind: z.record(z.string(), RankMetricsSchema),
  negatives: z.object({ n: z.number(), abstentionRate: z.number(), falseAnswerRate: z.number() }),
  paraphrase: z.object({ n: z.number(), consistency: z.number(), meanRecallDelta: z.number() }),
  degradedFraction: z.number(),
  latencyMs: PercentilesSchema,
  // Added in Phase 4; baselines recorded before it have none and still load.
  stageLatencyMs: z.object({ embed: PercentilesSchema, sql: PercentilesSchema, rerank: PercentilesSchema, graph: PercentilesSchema }).optional(),
  // Added in Phase 6; earlier baselines have neither and still load.
  bySource: z.record(z.string(), RankMetricsSchema).optional(),
  approvals: z.object({ owner: z.number(), agent: z.number() }).optional(),
  // Added in Phase 7.
  abstention: z.object({ calibration: SplitAbstentionSchema.optional(), heldout: SplitAbstentionSchema.optional() }).optional(),
});

const BaselineSchema = z.object({
  recordedAt: z.string(),
  commit: z.string(),
  goldenIds: z.array(z.string()),
  goldenItems: z.array(z.object({ id: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).optional(),
  report: ReportSchema,
  ranks: z.record(z.string(), z.number().nullable()),
});

export interface RankChange {
  id: string;
  before: number | null;
  after: number | null;
}

export interface Comparison {
  before: Report;
  after: Report;
  deltas: { recallAt1: number; recallAt5: number; recallAt10: number; mrr: number };
  regressions: RankChange[];
  improvements: RankChange[];
  /**
   * True when the current golden ids differ from the baseline's, or (when both sides carry hashes) any item was edited
   * in place; the metrics then compare different sets.
   */
  goldenChanged: boolean;
}

const TOLERANCE = 0.02;
/** Absorbs floating-point error so a drop of exactly TOLERANCE passes. */
const EPSILON = 1e-9;

/** Lower rank number is better; null (miss) is worse than any rank. */
function worse(before: number | null, after: number | null): boolean {
  if (before === null) return false;
  if (after === null) return true;
  return after > before;
}

function sameIds(a: string[], b: string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

function sameItems(a: GoldenRef[], b: GoldenRef[]): boolean {
  return sameIds(a.map((i) => `${i.id} ${i.sha256}`), b.map((i) => `${i.id} ${i.sha256}`));
}

export function compare(base: Baseline, after: Report, ranks: Record<string, number | null>, goldenIds: string[], goldenItems?: GoldenRef[]): Comparison {
  const regressions: RankChange[] = [];
  const improvements: RankChange[] = [];
  for (const id of Object.keys(ranks)) {
    if (!(id in base.ranks)) continue; // new question: nothing to compare against
    const b = base.ranks[id];
    const a = ranks[id];
    if (worse(b, a)) regressions.push({ id, before: b, after: a });
    else if (worse(a, b)) improvements.push({ id, before: b, after: a });
  }
  const o = base.report.overall;
  return {
    before: base.report,
    after,
    deltas: {
      recallAt1: after.overall.recallAt1 - o.recallAt1,
      recallAt5: after.overall.recallAt5 - o.recallAt5,
      recallAt10: after.overall.recallAt10 - o.recallAt10,
      mrr: after.overall.mrr - o.mrr,
    },
    regressions,
    improvements,
    goldenChanged: !sameIds(base.goldenIds, goldenIds) || (!!base.goldenItems && !!goldenItems && !sameItems(base.goldenItems, goldenItems)),
  };
}

/** Returns the reasons the run fails the gate; empty means pass. */
export function gate(c: Comparison): string[] {
  const failures: string[] = [];
  if (c.goldenChanged) failures.push("golden set changed since the baseline; review and run `eval run --accept`");
  if (c.deltas.recallAt10 < -TOLERANCE - EPSILON) failures.push(`recallAt10 dropped ${(-c.deltas.recallAt10).toFixed(3)} (tolerance ${TOLERANCE})`);
  if (c.deltas.mrr < -TOLERANCE - EPSILON) failures.push(`mrr dropped ${(-c.deltas.mrr).toFixed(3)} (tolerance ${TOLERANCE})`);
  if (c.before.negatives.n > 0 && c.after.negatives.n === 0) failures.push("negative items disappeared");
  if (c.after.negatives.n > 0 && c.after.negatives.abstentionRate < c.before.negatives.abstentionRate) {
    failures.push(`abstention rate fell from ${c.before.negatives.abstentionRate.toFixed(2)} to ${c.after.negatives.abstentionRate.toFixed(2)}`);
  }
  for (const split of ["calibration", "heldout"] as const) {
    const b = c.before.abstention?.[split];
    const a = c.after.abstention?.[split];
    if (!b || !a || b.positives === 0 || a.positives === 0) continue;
    if (a.falseAbstentionRate > b.falseAbstentionRate + TOLERANCE + EPSILON) {
      failures.push(`${split}: answerable items judged weak rose from ${b.falseAbstentionRate.toFixed(2)} to ${a.falseAbstentionRate.toFixed(2)} (tolerance ${TOLERANCE})`);
    }
  }
  if (c.after.degradedFraction > 0) failures.push(`${Math.round(c.after.degradedFraction * 100)}% of searches ran degraded; must be 0`);
  return failures;
}

/**
 * The gate's verdict for a run: with --gate, a missing baseline fails (there is nothing to protect against
 * regressions) unless this run records one with --accept; without --gate nothing fails.
 */
export function gateFailures(c: Comparison | null, opts: { gate: boolean; accept: boolean; baselinePath: string }): string[] {
  if (!opts.gate) return [];
  if (c) return gate(c);
  return opts.accept ? [] : [`no baseline at ${opts.baselinePath}; record one with \`eval run --accept\``];
}

/** Returns null when the file does not exist; throws "malformed baseline" when it is not a valid Baseline. */
export async function loadBaseline(path: string): Promise<Baseline | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`malformed baseline ${path}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = BaselineSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`malformed baseline ${path}: ${issues}; re-record it with \`eval run --accept\``);
  }
  return parsed.data;
}

export async function saveBaseline(path: string, b: Baseline): Promise<void> {
  const goldenItems = b.goldenItems ? { goldenItems: [...b.goldenItems].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)) } : {};
  await writeFile(path, JSON.stringify({ ...b, goldenIds: [...b.goldenIds].sort(), ...goldenItems }, null, 2) + "\n");
}
