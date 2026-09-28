import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Ctx } from "../ctx.js";
import { readInput } from "../ingest/readers.js";
import { ingest } from "../ingest/pipeline.js";
import { search, type SearchOptions } from "../retrieve/search.js";

export interface GoldenItem {
  question: string;
  expected_origins: string[];
  needs: string;
  filters?: { sourceKinds?: string[] };
}

export interface Scored {
  needs: string;
  rank: number | null;
}

export interface Metrics {
  n: number;
  recallAt10: number;
  mrr: number;
}

export function kindFromFilename(name: string): string {
  const i = name.indexOf("--");
  return i > 0 ? name.slice(0, i) : "note";
}

/** 1-based rank of the first passage from an expected document, or null. */
export function scoreQuestion(passageOrigins: (string | null)[], expected: string[]): number | null {
  for (let i = 0; i < passageOrigins.length; i++) {
    const o = passageOrigins[i];
    if (o && expected.some((e) => o.endsWith(e))) return i + 1;
  }
  return null;
}

function metrics(items: Scored[]): Metrics {
  const n = items.length;
  const recall = items.filter((i) => i.rank !== null && i.rank <= 10).length / (n || 1);
  const mrr = items.reduce((s, i) => s + (i.rank ? 1 / i.rank : 0), 0) / (n || 1);
  return { n, recallAt10: recall, mrr };
}

export function summarize(items: Scored[]): { overall: Metrics; byNeeds: Record<string, Metrics> } {
  const byNeeds: Record<string, Metrics> = {};
  for (const needs of new Set(items.map((i) => i.needs))) byNeeds[needs] = metrics(items.filter((i) => i.needs === needs));
  return { overall: metrics(items), byNeeds };
}

export async function ingestCorpus(ctx: Ctx, dir: string): Promise<void> {
  for (const r of await readInput(dir)) {
    const res = await ingest(ctx, { text: r.text, title: r.title, sourceKind: kindFromFilename(basename(r.origin)), origin: r.origin, mimeType: r.mimeType });
    console.log(`${res.created ? "new" : "dup"} ${res.stage.padEnd(10)} ${r.origin}${res.error ? " ERROR " + res.error : ""}`);
  }
}

export async function runEval(ctx: Ctx, goldenPath: string): Promise<{ scored: (Scored & { question: string; rank: number | null })[]; summary: ReturnType<typeof summarize> }> {
  const lines = (await readFile(goldenPath, "utf8")).split("\n").filter((l) => l.trim());
  const golden = lines.map((l) => JSON.parse(l) as GoldenItem);
  const scored: (Scored & { question: string })[] = [];
  for (const g of golden) {
    const opts: SearchOptions = { sourceKinds: g.filters?.sourceKinds, client: "eval", includeFacts: false };
    const res = await search(ctx, g.question, opts);
    const ids = [...new Set(res.passages.map((p) => p.documentId))];
    const origins = ids.length
      ? await ctx.sql<{ id: string; origin: string | null }[]>`select id, origin from brain.documents where id = any(${ids}::uuid[])`
      : [];
    const byId = new Map(origins.map((o) => [o.id, o.origin]));
    scored.push({ question: g.question, needs: g.needs, rank: scoreQuestion(res.passages.map((p) => byId.get(p.documentId) ?? null), g.expected_origins) });
  }
  return { scored, summary: summarize(scored) };
}
