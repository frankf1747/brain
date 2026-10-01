# Phase 0: Eval Isolation and Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the retrieval eval run only against a dedicated `brain_eval` database, upgrade the golden set and metrics so later phases can be measured, and record a baseline on the current code before any retrieval change.

**Architecture:** `src/eval/` becomes four small modules: `db.ts` (eval database guard and context), `golden.ts` (golden set v2 schema and parser), `metrics.ts` (pure functions from question results to numbers), `baseline.ts` (compare a run to the stored baseline and apply the gate). `run.ts` wires them: it searches, turns each `SearchResult` into a `QuestionResult`, and hands the list to `metrics`. The CLI `eval` command becomes a group: `eval run`, `eval ingest`. A bash script creates `brain_eval` from the migrations the way `prepare-test-db.sh` creates `brain_test`.

**Tech Stack:** TypeScript (ESM, `tsx`), vitest, commander, zod 4, postgres.js, Postgres 15 with pgvector via local Supabase.

**Spec:** `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` §8.1, §8.2, §8.4, §8.5 and §12 (Phase 0 row).
**Working directory:** `/Users/frankfu/Documents/GitHub/brain`
**Prerequisite:** `npm run db:start` has been run (Supabase containers up); `npm test` is green on `main` at commit `9cdfbc5`.

---

## File structure

```
scripts/
  prepare-eval-db.sh         NEW: create brain_eval from migrations (idempotent; --reset recreates)
src/
  ctx.ts                     MODIFY: makeCtx(opts) accepts databaseUrl and obsidian:false
  eval/
    db.ts                    NEW: EVAL_DATABASE_URL, assertEvalDatabase, makeEvalCtx
    golden.ts                NEW: GoldenItem schema (v2), parseGolden
    metrics.ts               NEW: QuestionResult, setRecallAtK, mrr, ndcgAt10, abstention, summarize
    baseline.ts              NEW: Baseline type, compare, gate, load/save
    run.ts                   REWRITE: runEval returns QuestionResult[] + Report; ingestCorpus guards
  cli.ts                     MODIFY: eval becomes a command group (run, ingest)
eval/
  golden.jsonl               REWRITE in v2 format (14 items, ids q01..q14)
  baseline.json              NEW: recorded by Task 8
package.json                 MODIFY: eval:prepare, eval:run, eval:gate scripts
README.md                    MODIFY: eval section
test/unit/
  eval-db-guard.test.ts      NEW
  golden.test.ts             NEW
  metrics.test.ts            NEW
  baseline.test.ts           NEW
  eval.test.ts               REWRITE for the new run.ts exports
```

---

### Task 1: Eval database script and guard

**Files:**
- Create: `scripts/prepare-eval-db.sh`
- Create: `src/eval/db.ts`
- Modify: `src/ctx.ts`
- Create: `test/unit/eval-db-guard.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing guard test**

`test/unit/eval-db-guard.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { assertEvalDatabase, EVAL_DATABASE_URL } from "../../src/eval/db.js";

describe("eval database guard", () => {
  it("defaults to a *_eval database", () => {
    expect(new URL(EVAL_DATABASE_URL).pathname).toMatch(/_eval$/);
  });
  it("refuses the real and the test database", () => {
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/postgres")).toThrow(/must end in _eval/);
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_test")).toThrow(/must end in _eval/);
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_eval")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/eval-db-guard.test.ts`
Expected: FAIL with `Cannot find module '../../src/eval/db.js'`

- [ ] **Step 3: Let `makeCtx` take a database URL and an Obsidian switch**

In `src/ctx.ts`, replace the `makeCtx` signature and the first lines of its body:

```ts
export interface MakeCtxOptions {
  /** Defaults to config.databaseUrl (the real knowledge base). */
  databaseUrl?: string;
  /** False turns the Obsidian mirror off regardless of the environment; the eval database must never be mirrored. */
  obsidian?: boolean;
}

export function makeCtx(opts: MakeCtxOptions = {}): Ctx {
  const voyage = new VoyageClient();
  const queryVoyage = new VoyageClient({ maxRateLimitAttempts: 1, maxAttempts: 2 });
  const ctx: Ctx = {
    sql: connect(opts.databaseUrl ?? config.databaseUrl),
    llm: makeLlm(),
    embedder: voyage,
    reranker: voyage,
    queryEmbedder: queryVoyage,
    queryReranker: queryVoyage,
  };
  if (opts.obsidian === false) return ctx;
  if (autoProjectionEnabled(process.env, isDirectory)) {
```

The rest of the function is unchanged.

- [ ] **Step 4: Write `src/eval/db.ts`**

```ts
import { makeCtx, type Ctx } from "../ctx.js";

/**
 * The eval ingests fictional documents and logs hundreds of searches, so it only ever runs against a
 * database whose name ends in "_eval" (created by scripts/prepare-eval-db.sh). DATABASE_URL is
 * deliberately ignored: it points at the real knowledge base.
 */
export const EVAL_DATABASE_URL =
  process.env.EVAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_eval";

export function assertEvalDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_eval")) {
    throw new Error(`Refusing to run the eval against "${name}": the database name must end in _eval`);
  }
}

/** A real context (real Voyage, real Claude Code) on the eval database, with the Obsidian mirror off. */
export function makeEvalCtx(): Ctx {
  assertEvalDatabase(EVAL_DATABASE_URL);
  return makeCtx({ databaseUrl: EVAL_DATABASE_URL, obsidian: false });
}
```

- [ ] **Step 5: Run the guard test**

Run: `npx vitest run test/unit/eval-db-guard.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Write the database script**

`scripts/prepare-eval-db.sh`:
```bash
#!/usr/bin/env bash
# Create the brain_eval database from the migrations if it does not exist, so the eval never touches
# the real knowledge base (the `postgres` database of the same local server). Pass --reset to drop
# and recreate it; the ingested corpus costs model and embedding calls, so by default it is kept.
set -euo pipefail

ADMIN_URL="${EVAL_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}"
EVAL_DB="brain_eval"
EVAL_URL="${ADMIN_URL%/*}/${EVAL_DB}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "--reset" ]]; then
  psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "drop database if exists ${EVAL_DB} with (force)"
fi

exists="$(psql "$ADMIN_URL" -At -c "select 1 from pg_database where datname = '${EVAL_DB}'")"
if [[ "$exists" == "1" ]]; then
  echo "${EVAL_DB} exists; pass --reset to recreate it" >&2
  exit 0
fi

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "create database ${EVAL_DB}"
psql "$EVAL_URL" -q -v ON_ERROR_STOP=1 -c "create schema if not exists extensions"
for f in "$HERE"/supabase/migrations/*.sql; do
  PGOPTIONS="--client-min-messages=warning" psql "$EVAL_URL" -q -v ON_ERROR_STOP=1 -f "$f"
done
echo "${EVAL_DB} ready ($(ls "$HERE"/supabase/migrations/*.sql | wc -l | tr -d ' ') migrations)" >&2
```

- [ ] **Step 7: Add npm scripts**

In `package.json` `scripts`, add after `"test:int"`:
```json
    "eval:prepare": "bash scripts/prepare-eval-db.sh",
    "eval:run": "tsx src/cli.ts eval run --compare",
    "eval:gate": "tsx src/cli.ts eval run --compare --gate",
```

- [ ] **Step 8: Create the database and verify**

Run: `chmod +x scripts/prepare-eval-db.sh && npm run eval:prepare && npm run eval:prepare`
Expected: first call prints `brain_eval ready (5 migrations)`, second prints `brain_eval exists; pass --reset to recreate it`.

- [ ] **Step 9: Run the full unit suite and typecheck**

Run: `npm run typecheck && npm run test:unit`
Expected: typecheck clean; all unit tests pass (148 + 2).

- [ ] **Step 10: Commit**

```bash
git add scripts/prepare-eval-db.sh src/eval/db.ts src/ctx.ts test/unit/eval-db-guard.test.ts package.json
git commit -m "Eval gets its own database and refuses any other

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Golden set v2 schema and parser

**Files:**
- Create: `src/eval/golden.ts`
- Create: `test/unit/golden.test.ts`
- Rewrite: `eval/golden.jsonl`

- [ ] **Step 1: Write the failing test**

`test/unit/golden.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseGolden } from "../../src/eval/golden.js";

const ok = JSON.stringify({
  id: "q01", question: "What is the salary range?", kind: "keyword",
  expected: [{ origin: "job_description--acme-senior-data-analyst.md" }],
  source: "fixture", approved_at: "2026-09-30",
});

describe("parseGolden", () => {
  it("parses one item per non-empty line", () => {
    const items = parseGolden(`${ok}\n\n${ok.replace("q01", "q02")}\n`);
    expect(items.map((i) => i.id)).toEqual(["q01", "q02"]);
    expect(items[0].expected[0].origin).toBe("job_description--acme-senior-data-analyst.md");
    expect(items[0].negative).toBe(false);
  });
  it("rejects duplicate ids", () => {
    expect(() => parseGolden(`${ok}\n${ok}`)).toThrow(/duplicate id q01/);
  });
  it("requires expected documents unless the item is negative", () => {
    const empty = JSON.stringify({ id: "q03", question: "x", kind: "semantic", expected: [], source: "fixture", approved_at: "2026-09-30" });
    expect(() => parseGolden(empty)).toThrow(/q03.*expected/);
    const neg = JSON.stringify({ id: "q04", question: "x", kind: "negative", expected: [], negative: true, source: "fixture", approved_at: "2026-09-30" });
    expect(parseGolden(neg)[0].negative).toBe(true);
  });
  it("rejects a negative item that lists expected documents", () => {
    const bad = JSON.stringify({ id: "q05", question: "x", kind: "negative", expected: [{ origin: "a.md" }], negative: true, source: "fixture", approved_at: "2026-09-30" });
    expect(() => parseGolden(bad)).toThrow(/q05.*negative/);
  });
  it("reports the line number of invalid JSON", () => {
    expect(() => parseGolden(`${ok}\n{not json`)).toThrow(/line 2/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/golden.test.ts`
Expected: FAIL with `Cannot find module '../../src/eval/golden.js'`

- [ ] **Step 3: Write `src/eval/golden.ts`**

```ts
import { z } from "zod";

export const GOLDEN_KINDS = ["keyword", "semantic", "graph", "filter", "fallback", "attribution", "negative"] as const;
export type GoldenKind = (typeof GOLDEN_KINDS)[number];

const ExpectedSchema = z.object({
  /** Suffix of documents.origin, e.g. the fixture file name. */
  origin: z.string().min(1).optional(),
  /** A document id, for items captured from the real base. */
  document_id: z.string().uuid().optional(),
  /** Verbatim span from the document; when present, a passage is relevant only if it contains it. */
  quote: z.string().min(1).optional(),
}).refine((e) => e.origin || e.document_id, { message: "expected needs origin or document_id" });

export const GoldenItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(GOLDEN_KINDS),
  expected: z.array(ExpectedSchema),
  filters: z.object({ sourceKinds: z.array(z.string()).optional() }).optional(),
  paraphrases: z.array(z.string().min(1)).optional(),
  source: z.enum(["fixture", "generated", "captured"]),
  negative: z.boolean().default(false),
  approved_at: z.string().min(1),
});
export type GoldenItem = z.infer<typeof GoldenItemSchema>;
export type Expected = z.infer<typeof ExpectedSchema>;

/** One JSON object per line; blank lines are ignored. Throws with the line number on the first invalid line. */
export function parseGolden(text: string): GoldenItem[] {
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
    if (!parsed.success) throw new Error(`golden line ${i + 1}: ${parsed.error.issues.map((x) => x.message).join("; ")}`);
    const item = parsed.data;
    if (seen.has(item.id)) throw new Error(`golden line ${i + 1}: duplicate id ${item.id}`);
    seen.add(item.id);
    if (item.negative && item.expected.length > 0) throw new Error(`golden ${item.id}: a negative item must not list expected documents`);
    if (!item.negative && item.expected.length === 0) throw new Error(`golden ${item.id}: expected is empty; mark the item negative or list a document`);
    items.push(item);
  }
  return items;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/golden.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Rewrite `eval/golden.jsonl` in v2**

Replace the whole file with:
```
{"id":"q01","question":"What is the salary range for the Acme Senior Data Analyst role?","kind":"keyword","expected":[{"origin":"job_description--acme-senior-data-analyst.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q02","question":"Who led Acme's Series B?","kind":"keyword","expected":[{"origin":"news--acme-series-b.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q03","question":"Does Acme sponsor work visas?","kind":"semantic","expected":[{"origin":"job_description--acme-senior-data-analyst.md"},{"origin":"conversation--interview-prep-with-priya.md"},{"origin":"email--recruiter-followup-beta-ventures.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q04","question":"What should I study before the SQL screen?","kind":"semantic","expected":[{"origin":"conversation--interview-prep-with-priya.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q05","question":"Why can't you satisfy every fairness definition at once?","kind":"semantic","expected":[{"origin":"note--fairness-in-ml.md","quote":"cannot satisfy all three when base rates differ"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q06","question":"How much did prepending context to chunks reduce retrieval failures?","kind":"semantic","expected":[{"origin":"paper--contextual-retrieval-abstract.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q07","question":"What do I know about Priya Natarajan?","kind":"graph","expected":[{"origin":"conversation--interview-prep-with-priya.md"},{"origin":"job_description--acme-senior-data-analyst.md"},{"origin":"email--recruiter-followup-beta-ventures.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q08","question":"Which companies is Beta Ventures connected to?","kind":"graph","expected":[{"origin":"news--acme-series-b.md"},{"origin":"email--recruiter-followup-beta-ventures.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q09","question":"What is the ZX-9000?","kind":"graph","expected":[{"origin":"news--acme-series-b.md"},{"origin":"job_description--acme-senior-data-analyst.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q10","question":"Acme funding news","kind":"filter","expected":[{"origin":"news--acme-series-b.md"}],"filters":{"sourceKinds":["news"]},"source":"fixture","approved_at":"2026-09-30"}
{"id":"q11","question":"remote product analyst Denver","kind":"filter","expected":[{"origin":"email--recruiter-followup-beta-ventures.md"}],"filters":{"sourceKinds":["email"]},"source":"fixture","approved_at":"2026-09-30"}
{"id":"q12","question":"Chouldechova","kind":"keyword","expected":[{"origin":"note--fairness-in-ml.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q13","question":"X-90","kind":"fallback","expected":[{"origin":"news--acme-series-b.md"},{"origin":"job_description--acme-senior-data-analyst.md"},{"origin":"conversation--interview-prep-with-priya.md"}],"source":"fixture","approved_at":"2026-09-30"}
{"id":"q14","question":"$115k","kind":"fallback","expected":[{"origin":"email--recruiter-followup-beta-ventures.md"}],"source":"fixture","approved_at":"2026-09-30"}
```

The `quote` on q05 is copied verbatim from `eval/corpus/note--fairness-in-ml.md` line 3 ("Chouldechova's impossibility result shows you cannot satisfy all three when base rates differ.").

- [ ] **Step 6: Verify the file parses**

Run: `npx tsx -e 'import { readFileSync } from "node:fs"; import { parseGolden } from "./src/eval/golden.js"; console.log(parseGolden(readFileSync("eval/golden.jsonl","utf8")).length)'`
Expected: `14`

- [ ] **Step 7: Commit**

```bash
git add src/eval/golden.ts test/unit/golden.test.ts eval/golden.jsonl
git commit -m "Golden set v2: ids, kinds, expected documents with optional quotes, negatives

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Metrics module

**Files:**
- Create: `src/eval/metrics.ts`
- Create: `test/unit/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/metrics.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { setRecallAtK, mrr, ndcgAt10, abstained, summarize, type QuestionResult } from "../../src/eval/metrics.js";

const ranked = (...ids: string[]) => ids.map((documentId) => ({ documentId, origin: `/c/${documentId}.md`, containsQuote: false }));
const exp = (...origins: string[]) => origins.map((origin) => ({ origin: `${origin}.md` }));

function result(partial: Partial<QuestionResult>): QuestionResult {
  return { id: "q", kind: "keyword", negative: false, expected: [], ranked: [], topScore: 0.9, hasGraphPassage: false, degraded: false, totalMs: 10, paraphraseRanked: [], ...partial };
}

describe("set recall and MRR", () => {
  it("counts the fraction of expected documents in the top k", () => {
    expect(setRecallAtK(exp("a", "b"), ranked("a", "c", "d"), 10)).toBe(0.5);
    expect(setRecallAtK(exp("a", "b"), ranked("c", "a", "b"), 1)).toBe(0);
    expect(setRecallAtK(exp("a"), ranked("c", "a"), 5)).toBe(1);
  });
  it("matches by origin suffix or document id", () => {
    expect(setRecallAtK([{ document_id: "a" }], ranked("a"), 10)).toBe(1);
    expect(setRecallAtK([{ origin: "zzz.md" }], ranked("a"), 10)).toBe(0);
  });
  it("mrr is one over the rank of the first expected document, deduplicated by document", () => {
    expect(mrr(exp("b"), ranked("a", "a", "b"))).toBe(0.5);
    expect(mrr(exp("z"), ranked("a"))).toBe(0);
  });
});

describe("nDCG@10", () => {
  it("is 1 when the only relevant passage is first and lower when it is third", () => {
    expect(ndcgAt10([true, false, false])).toBe(1);
    expect(ndcgAt10([false, false, true])).toBeCloseTo(1 / Math.log2(4));
    expect(ndcgAt10([false, false])).toBe(0);
  });
});

describe("abstention", () => {
  it("abstains when the top score is below the threshold and no graph passage was added", () => {
    expect(abstained(result({ topScore: 0.1, hasGraphPassage: false }), 0.3)).toBe(true);
    expect(abstained(result({ topScore: null, hasGraphPassage: false }), 0.3)).toBe(true);
    expect(abstained(result({ topScore: 0.5, hasGraphPassage: false }), 0.3)).toBe(false);
    expect(abstained(result({ topScore: 0.1, hasGraphPassage: true }), 0.3)).toBe(false);
  });
});

describe("summarize", () => {
  it("reports overall and per-kind metrics, abstention, degraded fraction and latency", () => {
    const r = summarize([
      result({ id: "1", kind: "keyword", expected: exp("a"), ranked: ranked("a"), totalMs: 10 }),
      result({ id: "2", kind: "keyword", expected: exp("a"), ranked: ranked("b", "a"), totalMs: 30, degraded: true }),
      result({ id: "3", kind: "semantic", expected: exp("z"), ranked: ranked("b"), totalMs: 20 }),
      result({ id: "4", kind: "negative", negative: true, topScore: 0.1, totalMs: 5 }),
      result({ id: "5", kind: "negative", negative: true, topScore: 0.8, totalMs: 5 }),
    ], 0.3);
    expect(r.n).toBe(5);
    expect(r.overall.recallAt10).toBeCloseTo(2 / 3);
    expect(r.overall.recallAt1).toBeCloseTo(1 / 3);
    expect(r.overall.mrr).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(r.byKind.keyword.recallAt10).toBe(1);
    expect(r.byKind.semantic.mrr).toBe(0);
    expect(r.negatives.n).toBe(2);
    expect(r.negatives.abstentionRate).toBe(0.5);
    expect(r.negatives.falseAnswerRate).toBe(0.5);
    expect(r.degradedFraction).toBeCloseTo(1 / 5);
    expect(r.latencyMs.p50).toBe(10);
    expect(r.latencyMs.p95).toBe(30);
  });
  it("paraphrase consistency is the share of paraphrases whose top-10 covers the same expected documents", () => {
    const r = summarize([
      result({ id: "1", kind: "semantic", expected: exp("a"), ranked: ranked("a"), paraphraseRanked: [ranked("a"), ranked("b")] }),
    ], 0.3);
    expect(r.paraphrase.n).toBe(2);
    expect(r.paraphrase.consistency).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/metrics.test.ts`
Expected: FAIL with `Cannot find module '../../src/eval/metrics.js'`

- [ ] **Step 3: Write `src/eval/metrics.ts`**

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/metrics.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/eval/metrics.ts test/unit/metrics.test.ts
git commit -m "Eval metrics: set recall, MRR, nDCG, abstention, paraphrase consistency, latency

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Baseline comparison and gate

**Files:**
- Create: `src/eval/baseline.ts`
- Create: `test/unit/baseline.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/baseline.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { compare, gate, type Baseline } from "../../src/eval/baseline.js";
import type { Report } from "../../src/eval/metrics.js";

function report(overrides: Partial<Report["overall"]> = {}, extra: Partial<Report> = {}): Report {
  return {
    n: 3,
    overall: { n: 3, recallAt1: 0.5, recallAt5: 0.8, recallAt10: 1, mrr: 0.9, ndcgAt10: null, ...overrides },
    byKind: {},
    negatives: { n: 0, abstentionRate: 0, falseAnswerRate: 0 },
    paraphrase: { n: 0, consistency: 0 },
    degradedFraction: 0,
    latencyMs: { p50: 10, p95: 20 },
    ...extra,
  };
}

const base: Baseline = { recordedAt: "2026-09-30T00:00:00Z", commit: "abc", report: report(), ranks: { q1: 1, q2: 2, q3: null } };

describe("compare", () => {
  it("lists metric deltas and the questions whose rank got worse", () => {
    const c = compare(base, report({ recallAt10: 0.9, mrr: 0.95 }), { q1: 1, q2: 3, q3: 2 });
    expect(c.deltas.recallAt10).toBeCloseTo(-0.1);
    expect(c.deltas.mrr).toBeCloseTo(0.05);
    expect(c.regressions).toEqual([{ id: "q2", before: 2, after: 3 }]);
    expect(c.improvements).toEqual([{ id: "q3", before: null, after: 2 }]);
  });
  it("treats a new miss as a regression", () => {
    const c = compare(base, report(), { q1: null, q2: 2, q3: null });
    expect(c.regressions).toEqual([{ id: "q1", before: 1, after: null }]);
  });
});

describe("gate", () => {
  it("passes when nothing dropped more than the tolerance", () => {
    expect(gate(compare(base, report({ recallAt10: 0.99, mrr: 0.89 }), base.ranks))).toEqual([]);
  });
  it("fails on a recall or MRR drop above 0.02, a lower abstention rate, or any degraded search", () => {
    const withNeg: Baseline = { ...base, report: report({}, { negatives: { n: 2, abstentionRate: 1, falseAnswerRate: 0 } }) };
    const failures = gate(compare(withNeg, report({ recallAt10: 0.9, mrr: 0.8 }, { negatives: { n: 2, abstentionRate: 0.5, falseAnswerRate: 0.5 }, degradedFraction: 0.1 }), base.ranks));
    expect(failures).toEqual([
      "recallAt10 dropped 0.100 (tolerance 0.02)",
      "mrr dropped 0.100 (tolerance 0.02)",
      "abstention rate fell from 1.00 to 0.50",
      "10% of searches ran degraded; must be 0",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/baseline.test.ts`
Expected: FAIL with `Cannot find module '../../src/eval/baseline.js'`

- [ ] **Step 3: Write `src/eval/baseline.ts`**

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/baseline.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/eval/baseline.ts test/unit/baseline.test.ts
git commit -m "Eval baseline: per-question rank comparison and a regression gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Runner rewrite

**Files:**
- Rewrite: `src/eval/run.ts`
- Rewrite: `test/unit/eval.test.ts`

- [ ] **Step 1: Write the failing test**

Replace `test/unit/eval.test.ts` with:
```ts
import { describe, it, expect } from "vitest";
import { kindFromFilename, toQuestionResult, firstExpectedRank } from "../../src/eval/run.js";
import type { GoldenItem } from "../../src/eval/golden.js";
import type { SearchResult } from "../../src/retrieve/search.js";

const item: GoldenItem = {
  id: "q05", question: "Why?", kind: "semantic", negative: false, source: "fixture", approved_at: "2026-09-30",
  expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot satisfy all three" }],
};

function searchResult(passages: { documentId: string; group: "hybrid" | "graph" | "fallback"; content: string; score: number }[]): SearchResult {
  return {
    query: "Why?",
    passages: passages.map((p) => ({ chunkId: "c", documentId: p.documentId, documentTitle: null, sourceKind: "note", content: p.content, parentContent: null, headingPath: [], charStart: 0, charEnd: 0, score: p.score, group: p.group })),
    documents: [], entities: [], facts: [], usedFallback: false, topScore: passages[0]?.score ?? null, degraded: false,
  };
}

describe("toQuestionResult", () => {
  it("records ranked documents with origins, quote hits, top score and graph presence", () => {
    const res = searchResult([
      { documentId: "d1", group: "hybrid", content: "Demographic parity asks that positive rates match.", score: 0.4 },
      { documentId: "d2", group: "hybrid", content: "shows you cannot satisfy all three when base rates differ", score: 0.3 },
      { documentId: "d3", group: "graph", content: "x", score: 0 },
    ]);
    const origins = new Map([["d1", "/c/other.md"], ["d2", "/c/note--fairness-in-ml.md"], ["d3", null]]);
    const q = toQuestionResult(item, res, origins, 42, []);
    expect(q.ranked.map((d) => d.documentId)).toEqual(["d1", "d2", "d3"]);
    expect(q.ranked.map((d) => d.containsQuote)).toEqual([false, true, false]);
    expect(q.topScore).toBe(0.4);
    expect(q.hasGraphPassage).toBe(true);
    expect(q.totalMs).toBe(42);
    expect(firstExpectedRank(q)).toBe(2);
  });
  it("rank is null on a miss", () => {
    const q = toQuestionResult(item, searchResult([{ documentId: "d9", group: "hybrid", content: "x", score: 0.9 }]), new Map([["d9", "/c/z.md"]]), 1, []);
    expect(firstExpectedRank(q)).toBeNull();
  });
  it("reads the source kind from the file name prefix", () => {
    expect(kindFromFilename("news--acme-series-b.md")).toBe("news");
    expect(kindFromFilename("plain.md")).toBe("note");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/eval.test.ts`
Expected: FAIL with `does not provide an export named 'toQuestionResult'`

- [ ] **Step 3: Rewrite `src/eval/run.ts`**

```ts
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Ctx } from "../ctx.js";
import { config } from "../config.js";
import { readInput } from "../ingest/readers.js";
import { ingestAll, logSkip } from "../ingest/batch.js";
import { search, type SearchOptions, type SearchResult } from "../retrieve/search.js";
import { parseGolden, type GoldenItem } from "./golden.js";
import { summarize, mrr, type QuestionResult, type RankedDoc, type Report } from "./metrics.js";
import { assertEvalDatabase } from "./db.js";

export function kindFromFilename(name: string): string {
  const i = name.indexOf("--");
  return i > 0 ? name.slice(0, i) : "note";
}

/** 1-based rank of the first expected document among distinct ranked documents, or null. */
export function firstExpectedRank(q: QuestionResult): number | null {
  const m = mrr(q.expected, q.ranked);
  return m === 0 ? null : Math.round(1 / m);
}

export function toQuestionResult(
  item: GoldenItem,
  res: SearchResult,
  originById: Map<string, string | null>,
  totalMs: number,
  paraphraseRanked: RankedDoc[][],
): QuestionResult {
  const quotes = item.expected.map((e) => e.quote).filter((q): q is string => !!q);
  const ranked: RankedDoc[] = res.passages.map((p) => ({
    documentId: p.documentId,
    origin: originById.get(p.documentId) ?? null,
    containsQuote: quotes.some((q) => p.content.includes(q)),
  }));
  return {
    id: item.id,
    kind: item.kind,
    negative: item.negative,
    expected: item.expected,
    ranked,
    topScore: res.topScore,
    hasGraphPassage: res.passages.some((p) => p.group === "graph"),
    degraded: res.degraded,
    totalMs,
    paraphraseRanked,
  };
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
export async function runEval(ctx: Ctx, goldenPath: string, databaseUrl: string): Promise<EvalRun> {
  assertEvalDatabase(databaseUrl);
  const golden = parseGolden(await readFile(goldenPath, "utf8"));
  const results: QuestionResult[] = [];
  for (const g of golden) {
    const opts: SearchOptions = { sourceKinds: g.filters?.sourceKinds, client: "eval", includeFacts: false, k: 10 };
    const main = await timedSearch(ctx, g.question, opts);
    const paras = [];
    for (const p of g.paraphrases ?? []) paras.push((await timedSearch(ctx, p, opts)).res);
    const origins = await originsFor(ctx, [main.res, ...paras]);
    const paraphraseRanked: RankedDoc[][] = paras.map((r) => r.passages.map((p) => ({ documentId: p.documentId, origin: origins.get(p.documentId) ?? null, containsQuote: false })));
    results.push(toQuestionResult(g, main.res, origins, main.ms, paraphraseRanked));
  }
  const ranks: Record<string, number | null> = {};
  for (const r of results) if (!r.negative) ranks[r.id] = firstExpectedRank(r);
  return { results, report: summarize(results, config.retrieval.fallbackThreshold), ranks };
}

/** Ingests every file under dir into the eval database; a file that cannot be stored is logged and skipped. Returns how many failed. */
export async function ingestCorpus(ctx: Ctx, dir: string, databaseUrl: string): Promise<number> {
  assertEvalDatabase(databaseUrl);
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
```

- [ ] **Step 4: Run the unit test and typecheck**

Run: `npx vitest run test/unit/eval.test.ts && npm run typecheck`
Expected: PASS (3 tests). Typecheck fails in `src/cli.ts` because `runEval` and `ingestCorpus` now take a third argument; Task 6 fixes it.

- [ ] **Step 5: Commit the runner (typecheck is fixed in the next task, which is committed within minutes)**

```bash
git add src/eval/run.ts test/unit/eval.test.ts
git commit -m "Eval runner builds QuestionResults, times searches, runs paraphrases

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: CLI command group

**Files:**
- Modify: `src/cli.ts` (replace the `eval` command, lines 199–216 in the current file)

- [ ] **Step 1: Replace the `eval` command**

`src/cli.ts` does not import `config` yet; add `import { config } from "./config.js";` next to its other imports at the top of the file. Then delete the block starting with `program\n  .command("eval")` through its closing `});` and insert:

```ts
const evalCmd = program.command("eval").description("Retrieval eval against the brain_eval database (never the real one)");

evalCmd
  .command("ingest [dir]")
  .description("Ingest a corpus directory into the eval database (default eval/corpus)")
  .action(async (dir: string | undefined) => {
    const { makeEvalCtx, EVAL_DATABASE_URL } = await import("./eval/db.js");
    const { ingestCorpus } = await import("./eval/run.js");
    const ctx = makeEvalCtx();
    try {
      if ((await ingestCorpus(ctx, dir ?? "eval/corpus", EVAL_DATABASE_URL)) > 0) process.exitCode = 1;
    } finally {
      await ctx.sql.end();
    }
  });

evalCmd
  .command("run")
  .description("Run the golden set and report metrics; --compare shows deltas against eval/baseline.json")
  .option("--golden <path>", "golden set file", "eval/golden.jsonl")
  .option("--baseline <path>", "baseline file", "eval/baseline.json")
  .option("--compare", "compare against the baseline")
  .option("--gate", "exit 1 when the comparison fails the gate (implies --compare)")
  .option("--accept", "overwrite the baseline with this run")
  .option("--json")
  .action(async (opts) => {
    const { makeEvalCtx, EVAL_DATABASE_URL } = await import("./eval/db.js");
    const { runEval } = await import("./eval/run.js");
    const { compare, gate, loadBaseline, saveBaseline } = await import("./eval/baseline.js");
    const { execSync } = await import("node:child_process");
    const ctx = makeEvalCtx();
    try {
      const run = await runEval(ctx, opts.golden, EVAL_DATABASE_URL);
      const base = opts.compare || opts.gate ? await loadBaseline(opts.baseline) : null;
      const comparison = base ? compare(base, run.report, run.ranks) : null;
      const failures = comparison && opts.gate ? gate(comparison) : [];
      if (opts.json) {
        console.log(JSON.stringify({ ...run, comparison, failures }, null, 2));
      } else {
        for (const r of run.results) {
          const rank = run.ranks[r.id];
          const tag = r.negative ? (r.topScore !== null && r.topScore >= config.retrieval.fallbackThreshold ? "FALSE" : "abst.") : rank === null ? "MISS" : `#${String(rank).padStart(2)}`;
          console.log(`${tag.padEnd(5)} ${r.kind.padEnd(11)} ${r.degraded ? "DEGRADED " : ""}${r.id}  ${r.ranked.length ? "" : "(no passages) "}${r.totalMs}ms`);
        }
        const o = run.report.overall;
        console.log(`\noverall  n=${o.n}  recall@1=${o.recallAt1.toFixed(2)}  recall@5=${o.recallAt5.toFixed(2)}  recall@10=${o.recallAt10.toFixed(2)}  mrr=${o.mrr.toFixed(2)}  ndcg@10=${o.ndcgAt10 === null ? "n/a" : o.ndcgAt10.toFixed(2)}`);
        for (const [kind, m] of Object.entries(run.report.byKind)) console.log(`${kind.padEnd(11)} n=${m.n}  recall@10=${m.recallAt10.toFixed(2)}  mrr=${m.mrr.toFixed(2)}`);
        const ng = run.report.negatives;
        if (ng.n) console.log(`negatives   n=${ng.n}  abstention=${ng.abstentionRate.toFixed(2)}  false-answer=${ng.falseAnswerRate.toFixed(2)}`);
        if (run.report.paraphrase.n) console.log(`paraphrase  n=${run.report.paraphrase.n}  consistency=${run.report.paraphrase.consistency.toFixed(2)}`);
        console.log(`degraded=${(run.report.degradedFraction * 100).toFixed(0)}%  latency p50=${run.report.latencyMs.p50}ms p95=${run.report.latencyMs.p95}ms`);
        if (comparison) {
          const d = comparison.deltas;
          console.log(`\nvs baseline  recall@10 ${d.recallAt10 >= 0 ? "+" : ""}${d.recallAt10.toFixed(3)}  mrr ${d.mrr >= 0 ? "+" : ""}${d.mrr.toFixed(3)}`);
          for (const r of comparison.regressions) console.log(`  worse   ${r.id}: ${r.before ?? "miss"} -> ${r.after ?? "miss"}`);
          for (const r of comparison.improvements) console.log(`  better  ${r.id}: ${r.before ?? "miss"} -> ${r.after ?? "miss"}`);
          for (const f of failures) console.log(`  GATE: ${f}`);
        } else if (opts.compare || opts.gate) {
          console.log("\nno baseline yet; run with --accept to record one");
        }
      }
      if (failures.length) process.exitCode = 1;
      if (opts.accept) {
        const commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
        await saveBaseline(opts.baseline, { recordedAt: new Date().toISOString(), commit, report: run.report, ranks: run.ranks });
        console.log(`baseline written to ${opts.baseline} at ${commit}`);
      }
    } finally {
      await ctx.sql.end();
    }
  });
```

- [ ] **Step 2: Typecheck and run unit tests**

Run: `npm run typecheck && npm run test:unit`
Expected: both clean.

- [ ] **Step 3: Check the real database is refused**

Run: `EVAL_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres npm run brain -- eval run`
Expected: exits non-zero with `Refusing to run the eval against "postgres": the database name must end in _eval`.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "CLI: eval becomes a command group with ingest and run (compare, gate, accept)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Integration tests still green

**Files:** none changed; this task confirms nothing else depended on the old `runEval` signature.

- [ ] **Step 1: Run the integration suite**

Run: `npm run test:int`
Expected: all integration tests pass. Check with `grep -rn "eval/run" test/integration` that no integration test imports `src/eval/run.ts` (none does at the time of writing); the eval must never run inside the integration suite, so if one appears later, delete that import rather than adapting it.

---

### Task 8: Record the baseline on the current code

This task spends real Voyage tokens and Claude Code calls (6 small documents: 6 summaries, 6 extractions, about 20 embeddings). Run it once.

- [ ] **Step 1: Ingest the fixture corpus into the eval database**

Run: `npm run brain -- eval ingest`
Expected: six lines ending in `done`, e.g. `new done       /Users/frankfu/Documents/GitHub/brain/eval/corpus/news--acme-series-b.md`. If any line shows `ERROR`, re-run the same command (ingestion resumes from the last completed stage) before continuing.

- [ ] **Step 2: Confirm the real database is untouched**

Run: `psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -At -c "select count(*) from brain.documents" -c "select count(*) from brain.retrieval_log where client='eval'"`
Expected: `2` and `0`.

- [ ] **Step 3: Run the eval and accept the baseline**

Run: `npm run brain -- eval run --accept`
Expected: 14 result lines, an `overall` line, per-kind lines, and `baseline written to eval/baseline.json at <commit>`. Record the printed `recall@10`, `mrr` and `degraded` values; `degraded` must be `0%`. If it is not, wait one minute (Voyage rate limit) and re-run with `--accept` again.

- [ ] **Step 4: Verify the gate passes against itself**

Run: `npm run eval:gate`
Expected: the same metrics, a `vs baseline  recall@10 +0.000  mrr +0.000` line, no `GATE:` lines, exit code 0.

- [ ] **Step 5: Update the README eval section**

In `README.md`, replace the bullet that begins `- `npm run brain -- eval --ingest eval/corpus` is the retrieval gate` with:

```markdown
- The retrieval eval runs only against `brain_eval` (`npm run eval:prepare` creates it from the migrations; `--reset` recreates it). `npm run brain -- eval ingest` loads `eval/corpus`; `npm run eval:run` scores `eval/golden.jsonl` and compares with `eval/baseline.json`; `npm run eval:gate` exits 1 on a regression (recall@10 or MRR down more than 0.02, abstention down, or any degraded search). After a deliberate change, `npm run brain -- eval run --accept` records the new baseline. Baseline on 2026-09-30 (commit in `eval/baseline.json`): recall@10 <value>, MRR <value>, 14 questions over 6 documents. The set is small, so treat it as a regression check until Phase 6 of `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` grows it.
```

Fill `<value>` with the numbers printed in Step 3.

- [ ] **Step 6: Commit**

```bash
git add eval/baseline.json README.md
git commit -m "Record the retrieval baseline before any retrieval change

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §8.1 isolation: Task 1 (guard, script, `makeEvalCtx` with Obsidian off). `brain eval sync` from §8.1 is deferred to Phase 6 (roadmap), since the baseline uses fixtures only.
- Spec §8.2 golden v2: Task 2. `attribution` kind is accepted by the parser; its metric arrives in Phase 6 when fixtures with `author: other` exist.
- Spec §8.4 metrics: Task 3 covers set recall, MRR, nDCG, paraphrase consistency, abstention, false answer, degraded fraction, latency. Verifier accuracy and Voyage tokens need Phases 5 and 3 respectively and are in the roadmap.
- Spec §8.5 baseline and gate: Tasks 4, 6, 8.
- Types: `QuestionResult`, `RankedDoc`, `Report` defined in Task 3 and used unchanged in Tasks 4–6. `runEval(ctx, goldenPath, databaseUrl)` and `ingestCorpus(ctx, dir, databaseUrl)` signatures match between Task 5 and Task 6.
