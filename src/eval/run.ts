import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Ctx } from "../ctx.js";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { readInput } from "../ingest/readers.js";
import { ingestAll, logSkip } from "../ingest/batch.js";
import { search, type SearchOptions, type SearchResult } from "../retrieve/search.js";
import { parseGolden, type Expected, type GoldenItem } from "./golden.js";
import { summarize, mrr, matchesExpected, type QuestionResult, type RankedDoc, type Report } from "./metrics.js";
import { assertEvalConnection } from "./db.js";

export function kindFromFilename(name: string): string {
  const i = name.indexOf("--");
  return i > 0 ? name.slice(0, i) : "note";
}

/** 1-based rank of the first expected document among distinct ranked documents, or null. */
export function firstExpectedRank(q: QuestionResult): number | null {
  const m = mrr(q.expected, q.ranked);
  return m === 0 ? null : Math.round(1 / m);
}

/** Collapses whitespace runs to one space; applied to quotes and passages alike (and in countRelevantPassages' SQL). */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ");
}

function quotesOf(expected: Expected[]): string[] {
  return expected.map((e) => e.quote).filter((q): q is string => !!q).map((q) => normalizeWhitespace(q).trim()).filter(Boolean);
}

/**
 * A passage is relevant (for nDCG) when it is a chunk (not a fallback window, which totalRelevant cannot
 * count) of an expected document and contains any of the item's expected quotes.
 */
export function toQuestionResult(
  item: GoldenItem,
  res: SearchResult,
  originById: Map<string, string | null>,
  totalMs: number,
  paraphraseRanked: RankedDoc[][],
  totalRelevant: number,
  paraphraseDegraded: boolean[],
): QuestionResult {
  const quotes = quotesOf(item.expected);
  const ranked: RankedDoc[] = res.passages.map((p) => {
    const doc = { documentId: p.documentId, origin: originById.get(p.documentId) ?? null };
    const content = normalizeWhitespace(p.content);
    return {
      ...doc,
      containsQuote: p.chunkId !== null && item.expected.some((e) => matchesExpected(e, doc)) && quotes.some((q) => content.includes(q)),
    };
  });
  return {
    id: item.id,
    kind: item.kind,
    negative: item.negative,
    expected: item.expected,
    ranked,
    totalRelevant,
    topScore: res.topScore,
    hasGraphPassage: res.passages.some((p) => p.group === "graph"),
    degraded: res.degraded,
    totalMs,
    paraphraseRanked,
    paraphraseDegraded,
  };
}

/**
 * The nDCG denominator: level-1 passages (the unit search returns) in the corpus that belong to an expected
 * document and contain any expected quote, whitespace-normalised. Read-only. Documents match by id or by
 * origin equal to, or ending in "/" + , the expected origin (compared literally, not with LIKE, since
 * origins contain "_"). 0 when the item has no quotes.
 */
export async function countRelevantPassages(sql: Db, expected: Expected[]): Promise<number> {
  const quotes = quotesOf(expected);
  if (quotes.length === 0) return 0;
  const ids = expected.map((e) => e.document_id).filter((x): x is string => !!x);
  const origins = expected.map((e) => e.origin).filter((x): x is string => !!x);
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n
    from brain.chunks c
    join brain.documents d on d.id = c.document_id
    where c.level = 1
      and (d.id = any(${ids}::uuid[])
           or exists (select 1 from unnest(${origins}::text[]) o
                      where d.origin = o or right(d.origin, length(o) + 1) = '/' || o))
      and exists (select 1 from unnest(${quotes}::text[]) q
                  where strpos(regexp_replace(c.content, '\\s+', ' ', 'g'), q) > 0)`;
  return row.n;
}

async function originsFor(ctx: Ctx, results: SearchResult[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(results.flatMap((r) => r.passages.map((p) => p.documentId)))];
  if (ids.length === 0) return new Map();
  const rows = await ctx.sql<{ id: string; origin: string | null }[]>`select id, origin from brain.documents where id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.origin]));
}

async function timedSearch(ctx: Ctx, question: string, opts: SearchOptions): Promise<{ res: SearchResult; ms: number }> {
  const t0 = Date.now();
  const res = await search(ctx, question, opts);
  return { res, ms: Date.now() - t0 };
}

export interface EvalRun {
  results: QuestionResult[];
  report: Report;
  ranks: Record<string, number | null>;
}

/** Runs every golden item (and its paraphrases) against the context's database, which must be the eval database. */
export async function runEval(ctx: Ctx, goldenPath: string): Promise<EvalRun> {
  await assertEvalConnection(ctx.sql);
  const golden = parseGolden(await readFile(goldenPath, "utf8"));
  const results: QuestionResult[] = [];
  for (const g of golden) {
    const opts: SearchOptions = { sourceKinds: g.filters?.sourceKinds, client: "eval", includeFacts: false, k: 10 };
    const main = await timedSearch(ctx, g.question, opts);
    const paras: SearchResult[] = [];
    for (const p of g.paraphrases ?? []) paras.push((await timedSearch(ctx, p, opts)).res);
    const origins = await originsFor(ctx, [main.res, ...paras]);
    const paraphraseRanked: RankedDoc[][] = paras.map((r) => r.passages.map((p) => ({ documentId: p.documentId, origin: origins.get(p.documentId) ?? null, containsQuote: false })));
    const totalRelevant = await countRelevantPassages(ctx.sql, g.expected);
    results.push(toQuestionResult(g, main.res, origins, main.ms, paraphraseRanked, totalRelevant, paras.map((r) => r.degraded)));
  }
  const ranks: Record<string, number | null> = {};
  for (const r of results) if (!r.negative) ranks[r.id] = firstExpectedRank(r);
  return { results, report: summarize(results, config.retrieval.fallbackThreshold), ranks };
}

/** Ingests every file under dir into the eval database; a file that cannot be stored is logged and skipped. Returns how many failed. */
export async function ingestCorpus(ctx: Ctx, dir: string): Promise<number> {
  await assertEvalConnection(ctx.sql);
  const { failed } = await ingestAll(
    ctx,
    await readInput(dir),
    { toInput: (r) => ({ text: r.text, title: r.title, sourceKind: kindFromFilename(basename(r.origin)), origin: r.origin, mimeType: r.mimeType }) },
    {
      done: (r, res) => console.log(`${res.created ? "new" : "dup"} ${res.stage.padEnd(10)} ${r.origin}${res.error ? " ERROR " + res.error : ""}`),
      skip: logSkip,
    },
  );
  return failed.length;
}
