import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Ctx } from "../ctx.js";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { readInput } from "../ingest/readers.js";
import { ingestAll, logSkip } from "../ingest/batch.js";
import { search, type SearchOptions, type SearchResult } from "../retrieve/search.js";
import { isDegraded, isHybrid } from "../retrieve/contract.js";
import { parseGolden, type Expected, type GoldenItem } from "./golden.js";
import { summarize, mrr, matchesExpected, type QuestionResult, type RankedDoc, type Report } from "./metrics.js";
import { assertEvalConnection, EVAL_CLIENT } from "./db.js";
import { voyageSpendSince, type VoyageSpend } from "../llm/usage.js";
import { parseAuthor, type Author } from "../ingest/author.js";

export function kindFromFilename(name: string): string {
  const i = name.indexOf("--");
  return i > 0 ? name.slice(0, i) : "note";
}

/**
 * Optional front matter at the top of a fixture: `---`, `key: value` lines, `---`. Only `author` is read
 * (owner, other or unknown, optionally quoted); other keys are ignored. Returns the text without the block.
 */
export function splitFrontMatter(text: string): { author: Author | undefined; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { author: undefined, body: text };
  let author: Author | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) {
      if (line.trim()) throw new Error(`front matter: cannot read line "${line}"`);
      continue;
    }
    if (kv[1] === "author") author = parseAuthor(kv[2].replace(/^["']|["']$/g, ""));
  }
  return { author, body: text.slice(m[0].length) };
}

export interface AttributionLeaks {
  /** Facts about the owner whose source chunk is in a document the owner did not write. */
  selfFacts: number;
  /** Edges from the owner whose evidence chunk is in a document the owner did not write. */
  selfEdges: number;
}

/** Spec §8.4 attribution, over the whole database: must be 0. Read-only. */
export async function attributionLeaks(sql: Db): Promise<AttributionLeaks> {
  const [row] = await sql<{ facts: number; edges: number }[]>`
    with self as (select id from brain.nodes where is_self)
    select
      (select count(*)::int
         from brain.facts f
         join brain.chunks c on c.id = f.source_chunk_id
         join brain.documents d on d.id = c.document_id
        where brain.canonical_node(f.subject_id) in (select id from self) and d.author <> 'owner') as facts,
      (select count(*)::int
         from brain.edges e
         join brain.chunks c on c.id = e.evidence_chunk_id
         join brain.documents d on d.id = c.document_id
        where brain.canonical_node(e.from_node) in (select id from self) and d.author <> 'owner') as edges`;
  return { selfFacts: row.facts, selfEdges: row.edges };
}

/** `eval run --gate` fails when any fact about, or edge from, the owner comes from a document the owner did not write. */
export function attributionGate(a: AttributionLeaks): string[] {
  return a.selfFacts + a.selfEdges === 0
    ? []
    : [`attribution: ${a.selfFacts} facts about the owner and ${a.selfEdges} edges from the owner come from documents the owner did not write; must be 0`];
}

/** The eval output line for the run's Voyage spend. */
export function evalVoyageLine(v: VoyageSpend): string {
  const base = `voyage  tokens=${v.tokens} requests=${v.requests} refused=${v.refused}`;
  return v.refused ? `${base}  (brain_eval's daily cap refused calls; those searches ran degraded)` : base;
}

/** The eval output line for per-stage latency, or null for a report recorded before Phase 4. */
export function stageLatencyLine(report: Report): string | null {
  const s = report.stageLatencyMs;
  if (!s) return null;
  const part = (name: string, p: { p50: number; p95: number }) => `${name} p50=${p.p50}ms p95=${p.p95}ms`;
  return `stages  ${part("embed", s.embed)}  ${part("sql", s.sql)}  ${part("rerank", s.rerank)}  ${part("graph", s.graph)}`;
}

/** 1-based rank of the first expected document among distinct ranked documents, or null. */
export function firstExpectedRank(q: QuestionResult): number | null {
  const m = mrr(q.expected, q.ranked);
  return m === 0 ? null : Math.round(1 / m);
}

/**
 * ASCII whitespace only (space, tab, CR, LF, FF, VT), written with the literal characters so the same
 * pattern means the same thing in JS and in Postgres. JS \s is Unicode (it includes NBSP) while Postgres
 * \s depends on the locale, so neither is used.
 */
const WHITESPACE_RUN = "[ \t\r\n\f\v]+";
const WHITESPACE_RUN_RE = new RegExp(WHITESPACE_RUN, "g");

/** Collapses ASCII whitespace runs to one space; applied to quotes and passages alike (and in countRelevantPassages' SQL). */
export function normalizeWhitespace(s: string): string {
  return s.replace(WHITESPACE_RUN_RE, " ");
}

function quotesOf(expected: Expected[]): string[] {
  // After collapsing, at most one ASCII space remains at either end; String.trim would also strip NBSP.
  return expected.map((e) => e.quote).filter((q): q is string => !!q).map((q) => normalizeWhitespace(q).replace(/^ | $/g, "")).filter(Boolean);
}

/** A golden item whose quotes appear in no passage of its expected documents is almost always a typo. */
export function missingQuoteWarning(item: GoldenItem, totalRelevant: number): string | null {
  return quotesOf(item.expected).length > 0 && totalRelevant === 0
    ? `eval: ${item.id} quote not found in any passage of its expected documents`
    : null;
}

/**
 * A passage is relevant (for nDCG) when it is a chunk (not a fallback window, which totalRelevant cannot
 * count) of an expected document and contains any of the item's expected quotes.
 */
export function toQuestionResult(
  item: GoldenItem,
  res: SearchResult,
  originById: Map<string, string | null>,
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
    // A passage only the graph found: the entity has material ranking missed. A ranked passage that the graph also
    // reached is judged by its score, as it was before passages could carry both (keeps abstention comparable).
    hasGraphPassage: res.passages.some((p) => p.layers.includes("graph") && !isHybrid(p)),
    degraded: isDegraded(res.degraded),
    totalMs: res.timings.totalMs,
    timings: res.timings,
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
                  where strpos(regexp_replace(c.content, ${WHITESPACE_RUN}, ' ', 'g'), q) > 0)`;
  return row.n;
}

async function originsFor(ctx: Ctx, results: SearchResult[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(results.flatMap((r) => r.passages.map((p) => p.documentId)))];
  if (ids.length === 0) return new Map();
  const rows = await ctx.sql<{ id: string; origin: string | null }[]>`select id, origin from brain.documents where id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.origin]));
}

export interface EvalRun {
  results: QuestionResult[];
  report: Report;
  ranks: Record<string, number | null>;
  /** Kept out of Report so eval/baseline.json's schema does not change. */
  attribution: AttributionLeaks;
  /** Voyage spend of this run (searches and anything else under the eval client) in brain_eval's ledger. Kept out of Report. */
  voyage: VoyageSpend;
}

/** Runs every golden item (and its paraphrases) against the context's database, which must be the eval database. */
export async function runEval(ctx: Ctx, goldenPath: string): Promise<EvalRun> {
  await assertEvalConnection(ctx.sql);
  // The database's clock, so the window matches the ledger's created_at exactly.
  const [{ startedAt }] = await ctx.sql<{ startedAt: Date }[]>`select clock_timestamp() as "startedAt"`;
  const golden = parseGolden(await readFile(goldenPath, "utf8"));
  const results: QuestionResult[] = [];
  for (const g of golden) {
    const opts: SearchOptions = { sourceKinds: g.filters?.sourceKinds, client: "eval", includeFacts: false, k: 10 };
    const main = await search(ctx, g.question, opts);
    const paras: SearchResult[] = [];
    for (const p of g.paraphrases ?? []) paras.push(await search(ctx, p, opts));
    const origins = await originsFor(ctx, [main, ...paras]);
    const paraphraseRanked: RankedDoc[][] = paras.map((r) => r.passages.map((p) => ({ documentId: p.documentId, origin: origins.get(p.documentId) ?? null, containsQuote: false })));
    const totalRelevant = await countRelevantPassages(ctx.sql, g.expected);
    const warning = missingQuoteWarning(g, totalRelevant);
    if (warning) console.error(warning);
    results.push(toQuestionResult(g, main, origins, paraphraseRanked, totalRelevant, paras.map((r) => isDegraded(r.degraded))));
  }
  const ranks: Record<string, number | null> = {};
  for (const r of results) if (!r.negative) ranks[r.id] = firstExpectedRank(r);
  return {
    results,
    report: summarize(results, config.retrieval.fallbackThreshold),
    ranks,
    attribution: await attributionLeaks(ctx.sql),
    voyage: await voyageSpendSince(ctx.sql, startedAt, EVAL_CLIENT),
  };
}

/**
 * Ingests every file under dir into the eval database; a file that cannot be stored is logged and skipped.
 * Front matter (`author: other`) is read and stripped before storing. Returns how many failed.
 */
export async function ingestCorpus(ctx: Ctx, dir: string): Promise<number> {
  await assertEvalConnection(ctx.sql);
  const { failed } = await ingestAll(
    ctx,
    await readInput(dir),
    {
      toInput: (r) => {
        const { author, body } = splitFrontMatter(r.text);
        return { text: body, title: r.title, sourceKind: kindFromFilename(basename(r.origin)), author, origin: r.origin, mimeType: r.mimeType };
      },
    },
    {
      done: (r, res) => console.log(`${res.created ? "new" : "dup"} ${res.stage.padEnd(10)} ${r.origin}${res.error ? " ERROR " + res.error : ""}`),
      skip: logSkip,
    },
  );
  return failed.length;
}
