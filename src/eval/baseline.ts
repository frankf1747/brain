import { readFile, writeFile } from "node:fs/promises";
import type { Report } from "./metrics.js";

export interface Baseline {
  recordedAt: string;
  commit: string;
  report: Report;
  /** 1-based rank of the first expected document per question id; null is a miss. */
  ranks: Record<string, number | null>;
}

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
}

const TOLERANCE = 0.02;

/** Lower rank number is better; null (miss) is worse than any rank. */
function worse(before: number | null, after: number | null): boolean {
  if (before === null) return false;
  if (after === null) return true;
  return after > before;
}

export function compare(base: Baseline, after: Report, ranks: Record<string, number | null>): Comparison {
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
  };
}

/** Returns the reasons the run fails the gate; empty means pass. */
export function gate(c: Comparison): string[] {
  const failures: string[] = [];
  if (c.deltas.recallAt10 < -TOLERANCE) failures.push(`recallAt10 dropped ${(-c.deltas.recallAt10).toFixed(3)} (tolerance ${TOLERANCE})`);
  if (c.deltas.mrr < -TOLERANCE) failures.push(`mrr dropped ${(-c.deltas.mrr).toFixed(3)} (tolerance ${TOLERANCE})`);
  if (c.after.negatives.n > 0 && c.after.negatives.abstentionRate < c.before.negatives.abstentionRate) {
    failures.push(`abstention rate fell from ${c.before.negatives.abstentionRate.toFixed(2)} to ${c.after.negatives.abstentionRate.toFixed(2)}`);
  }
  if (c.after.degradedFraction > 0) failures.push(`${Math.round(c.after.degradedFraction * 100)}% of searches ran degraded; must be 0`);
  return failures;
}

export async function loadBaseline(path: string): Promise<Baseline | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Baseline;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveBaseline(path: string, b: Baseline): Promise<void> {
  await writeFile(path, JSON.stringify(b, null, 2) + "\n");
}
