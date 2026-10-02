# Phase 3: Voyage Spending Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voyage spend is visible at all times and cannot exceed a daily limit. Every Voyage HTTP request is reserved in a ledger before it is sent and settled with Voyage's own `usage.total_tokens` after; a request that would take today's (UTC) total past `BRAIN_VOYAGE_DAILY_TOKEN_CAP` (default 5,000,000) is never sent. Ingestion stops cleanly before the Voyage stages and resumes with `brain retry`; search falls back to keyword-only and says why; `brain usage` and `brain_orient` show the spend. The owner added a payment method and asked that it never "spend like crazy": the cap is hard, fails closed, and has no off switch.

**Architecture:** Migration `20261002000010_provider_usage.sql` adds `brain.provider_usage` (one row per HTTP attempt) and `brain.provider_tokens_today(provider)` (the one definition of "tokens counted today"). `src/llm/ledger.ts` holds the reservation protocol: in one READ COMMITTED transaction, take a fixed advisory lock, sum today's counted tokens, then insert a `reserved` row or a `refused` row and throw `SpendCapError` (`src/llm/errors.ts`) after commit. `VoyageClient` requires a ledger whenever it would use the real `fetch`, reserves each attempt (estimate = characters / 4) and settles it. `makeCtx` wires the ledger on its own database for both the ingest and query clients (`makeEvalCtx` therefore meters on `brain_eval`). The pipeline records `spend_cap: …` without counting an attempt, and batch callers (`retryFailed`, `redoSkipped`, `ingestAll`, `JobManager`, `backfill`) stop asking the ledger after the first refusal (`voyageBlocked`). `search` reports `capReached` and `degradedReason`, and `render.ts` prints the accurate one of four notes. The query clients get 3 attempts and at most 10 s of total backoff. `src/llm/usage.ts` backs `brain usage`, the `brain_orient` line and the eval's spend line.

**Tech Stack:** Postgres 17.6, pgvector 0.8.2 (local Supabase, port 55322), plpgsql, TypeScript ESM run with tsx, vitest, zod 4, postgres.js, commander, @modelcontextprotocol/sdk.

**Spec:** `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` §5. Task breakdown: the Phase 3 table in `docs/superpowers/plans/2026-09-30-retrieval-hardening-roadmap.md`. Numbering here: **Tasks 1 and 2 together are roadmap 1 and 2** (the reservation protocol makes recording and the cap one mechanism, so Task 1 is the ledger in the database and Task 2 is the client using it), Task 3 is roadmap 3, Task 4 is roadmap 4, Task 5 is roadmap 5, Task 6 is roadmap 6, **Task 7** adds the eval's Voyage spend line (roadmap Phase 6 task 6 asks for it in the report later; here it is printed only), **Task 8** applies the migration to the real database (controller only).
**Prerequisite:** Phase 2 complete and merged into `main` (`710ff12`). Work on branch `spend-guard`.
**Working directory:** `/Users/frankfu/Documents/GitHub/brain`

Rules for every task:
- Integration tests run on `brain_test` only: `npm run test:int` recreates it from all migrations. Run one integration file with `bash scripts/prepare-test-db.sh && npx vitest run <file>`. Unit tests: `npx vitest run <file>` or `npm run test:unit`. **Unit tests make no network calls**: anything that needs the ledger table is an integration test; unit tests of `VoyageClient` inject `fetchFn` and run without a ledger.
- Migrations are applied to `brain_eval` with `psql`. **Never touch the `postgres` database (the real knowledge base) except in Task 8, which the controller runs, not a subagent.** Never use `supabase migration up`: the real database's migration table is out of sync.
- Migration 010 is idempotent (`create … if not exists`, `create or replace`) inside `begin`/`commit`. Re-applying it to `brain_eval` is always safe.
- From Task 2 on, every real-Voyage run on `brain_eval` (eval ingest and eval run) goes through `brain_eval`'s ledger, so migration 010 must be applied to `brain_eval` in Task 1 before anything else runs there.
- Tasks 4 and 7 end with `npm run eval:run` (search output and eval output change). The other tasks change no ranking; they end with `npm run typecheck` and the test suites, and say so.
- Commit per task. The last line of every commit message is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File structure

```
supabase/migrations/
  20261002000010_provider_usage.sql   NEW (T1): brain.provider_usage, created_at index, RLS, brain.provider_tokens_today
src/
  config.ts                           MODIFY: voyageDailyTokenCap + parseTokenCap (T1); prices + parsePrice (T6)
  llm/errors.ts                       MODIFY (T1): SpendCapError, isSpendCap, SPEND_CAP_PREFIX
  llm/ledger.ts                       NEW (T1): VoyageLedger, reserveTokens, settleReservation, tokensToday, spendCapMessage
  llm/voyage.ts                       MODIFY: ledger option, per-attempt reservation, estimates, usageTokens, fail-closed
                                      constructor, ledger getter (T2); maxTotalWaitMs, QUERY_RETRY_BUDGET, retryBudget (T5)
  llm/usage.ts                        NEW: usageByDay, formatUsage, voyageTodayLine (T6); voyageSpendSince (T7)
  ctx.ts                              MODIFY: ledger for both clients, client label (T2); query budget (T5)
  eval/db.ts                          MODIFY (T2): EVAL_CLIENT, makeEvalCtx labels its ledger "eval"
  mcp/stdio.ts, mcp/http-main.ts      MODIFY (T2): ledger client labels mcp-stdio, mcp-http
  ingest/pipeline.ts                  MODIFY (T3): spend_cap handling, VOYAGE_STAGES, voyageBlocked, DEFERRED_MESSAGE,
                                      SPEND_CAP_ADVICE; retryFailed and redoSkipped stop asking after a refusal
  ingest/batch.ts                     MODIFY (T3): ingestAll stops asking after a refusal
  ingest/backfill.ts                  MODIFY (T3): same for its two online Voyage loops
  ingest/set-author.ts                MODIFY (T3): a refused re-resolve counts no attempt
  mcp/jobs.ts                         MODIFY (T3): JobManager stops asking for the rest of the UTC day
  retrieve/search.ts                  MODIFY (T4): degradedReason, capReached, cap_reached log layer
  retrieve/orient.ts                  MODIFY (T6): Orientation.voyage
  mcp/render.ts                       MODIFY: degradedNote, searchMode (T4); Voyage today line in renderOrient (T6)
  eval/run.ts                         MODIFY (T7): EvalRun.voyage, evalVoyageLine
  cli.ts                              MODIFY: ingest/retry advice (T3); search mode line (T4); usage command (T6);
                                      eval voyage line (T7)
.env.example                          MODIFY (T6)
README.md                             MODIFY (T6, T7)
test/
  integration/helpers.ts              MODIFY: wipe truncates provider_usage (T1); fakeVoyageFetch, meteredVoyage (T2)
  unit/errors.test.ts                 MODIFY (T1)
  unit/config.test.ts                 MODIFY (T1, T6)
  integration/ledger.test.ts          NEW (T1)
  unit/voyage.test.ts                 MODIFY (T2, T5)
  unit/ctx.test.ts                    NEW (T2, T5)
  integration/voyage-ledger.test.ts   NEW (T2)
  integration/spend-cap-pipeline.test.ts NEW (T3)
  integration/search.test.ts          MODIFY (T4)
  unit/render.test.ts                 MODIFY (T4, T6)
  unit/eval.test.ts                   MODIFY (T4: SearchResult literal gains degradedReason, capReached; T7)
  unit/usage.test.ts                  NEW (T6)
  integration/usage.test.ts           NEW (T6, T7)
  integration/mcp-server.test.ts      MODIFY (T6)
```

---

### Task 1: The ledger table, the cap setting, and the reservation protocol

**Files:**
- Create: `supabase/migrations/20261002000010_provider_usage.sql`
- Create: `src/llm/ledger.ts`
- Modify: `src/llm/errors.ts`
- Modify: `src/config.ts`
- Modify: `test/integration/helpers.ts` (`wipe`)
- Modify: `test/unit/errors.test.ts`
- Modify: `test/unit/config.test.ts`
- Create: `test/integration/ledger.test.ts`

The protocol, which every later task relies on:

1. Before each HTTP attempt the client calls `reserveTokens`, which runs one transaction: `set transaction isolation level read committed`; `pg_advisory_xact_lock(hashtextextended('brain:voyage-spend', 0))`; `select brain.provider_tokens_today('voyage')`; then either insert a `reserved` row with `estimated_tokens` and return its id, or insert a `refused` row. The transaction commits, and only then is `SpendCapError` thrown, so the refused row is kept.
2. After the attempt the client calls `settleReservation`: `ok` with Voyage's `usage.total_tokens` (or the estimate when the response has none), or `error` with `tokens = 0` and the message.
3. "Counted today" is `coalesce(tokens, estimated_tokens)` over today's (UTC) rows in `reserved` or `ok`. A `reserved` row whose process died never settles and keeps counting at its estimate for the rest of the day; `brain usage` lists it as stale after 10 minutes. That over-counts, which is the safe side.

Why it is hard under concurrency: every reservation in a database takes the same transaction-scoped advisory lock, so check-and-insert is serialized across connections and processes (three pipelines, the MCP server, a CLI command). Under READ COMMITTED each statement takes a new snapshot, and the sum runs in the statement after the lock is granted, so it sees every reservation committed before; the isolation level is set explicitly so a changed database default cannot break this. Therefore at every admission, (settled actual tokens + in-flight estimates) ≤ cap. What the protocol cannot bound exactly is the difference between an in-flight call's estimate and its actual count: once settled, the actual count is what the next reservation sees, so the day's final total can exceed the cap only by the sum of (actual − estimate) over calls that were in flight when the cap was approached. With at most four Voyage callers per process at once (three pipelines and one search), each one request of at most 128 texts, that is a few thousand tokens against a 5,000,000 cap.

- [ ] **Step 1: Write the failing unit tests**

Append to `test/unit/errors.test.ts` (and add `SpendCapError, isSpendCap, SPEND_CAP_PREFIX` to its import from `../../src/llm/errors.js`):
```ts
describe("SpendCapError", () => {
  it("is recognized by type and by name, and carries the numbers", () => {
    const e = new SpendCapError("Voyage daily token cap reached: x", { used: 10, estimated: 5, cap: 12 });
    expect(isSpendCap(e)).toBe(true);
    expect(e.name).toBe("SpendCapError");
    expect([e.used, e.estimated, e.cap]).toEqual([10, 5, 12]);
    // An error that crossed a boundary that loses the class (a worker, a re-thrown copy) is still recognized.
    expect(isSpendCap(Object.assign(new Error("m"), { name: "SpendCapError" }))).toBe(true);
    expect(isSpendCap(new Error("Voyage /embeddings returned 429: rate limited"))).toBe(false);
    expect(isSpendCap("SpendCapError")).toBe(false);
    expect(isSpendCap(null)).toBe(false);
  });

  it("names the prefix pipeline jobs record", () => {
    expect(SPEND_CAP_PREFIX).toBe("spend_cap: ");
  });
});
```

Replace `test/unit/config.test.ts` with:
```ts
import { describe, it, expect } from "vitest";
import { config, parseTokenCap, DEFAULT_VOYAGE_DAILY_TOKEN_CAP } from "../../src/config.js";

describe("config", () => {
  it("pins the embedding dimension the schema was created with", () => {
    expect(config.embeddingDimensions).toBe(1024);
  });
  it("falls back to the local Supabase connection string", () => {
    expect(config.databaseUrl).toMatch(/^postgresql:\/\//);
  });
});

describe("parseTokenCap", () => {
  it("defaults to 5,000,000 when unset or empty", () => {
    expect(DEFAULT_VOYAGE_DAILY_TOKEN_CAP).toBe(5_000_000);
    expect(parseTokenCap(undefined)).toBe(5_000_000);
    expect(parseTokenCap("")).toBe(5_000_000);
    expect(parseTokenCap("   ")).toBe(5_000_000);
  });

  it("reads whole numbers, with optional underscores, and 0 (which blocks every call)", () => {
    expect(parseTokenCap("0")).toBe(0);
    expect(parseTokenCap("250000")).toBe(250_000);
    expect(parseTokenCap(" 1_000_000 ")).toBe(1_000_000);
  });

  it("refuses anything else instead of lifting the cap", () => {
    for (const bad of ["-1", "1e6", "5,000,000", "off", "none", "false", "1.5", "Infinity", "99999999999999999999"]) {
      expect(() => parseTokenCap(bad), bad).toThrow(/BRAIN_VOYAGE_DAILY_TOKEN_CAP must be a whole number of tokens/);
    }
  });

  it("is what config uses", () => {
    expect(config.voyageDailyTokenCap).toBe(parseTokenCap(process.env.BRAIN_VOYAGE_DAILY_TOKEN_CAP));
  });
});
```

- [ ] **Step 2: Write the failing integration test**

`test/integration/ledger.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { reserveTokens, settleReservation, tokensToday, type VoyageLedger, type VoyageOperation } from "../../src/llm/ledger.js";
import { SpendCapError, isSpendCap } from "../../src/llm/errors.js";
import { config } from "../../src/config.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const call = (estimatedTokens: number, operation: VoyageOperation = "embed_document") => ({ operation, model: "voyage-test", estimatedTokens });
const ledger = (dailyTokenCap: number, client = "test"): VoyageLedger => ({ sql, client, dailyTokenCap });
const rowById = async (id: string) =>
  (await sql<Record<string, unknown>[]>`
    select status, estimated_tokens, tokens, requests, error, client, finished_at is not null as finished
    from brain.provider_usage where id = ${id}::bigint`)[0];

/** Inserts a ledger row directly, `ago` before now. */
async function seed(status: string, estimated: number, tokens: number | null, ago = "0 seconds") {
  await sql`
    insert into brain.provider_usage (provider, operation, model, requests, estimated_tokens, tokens, status, client, created_at)
    values ('voyage', 'embed_document', 'voyage-test', ${status === "refused" ? 0 : 1}, ${estimated}, ${tokens}, ${status}, 'seed',
            now() - ${ago}::interval)`;
}

describe("brain.provider_usage", () => {
  it("has the ledger columns, row level security, and checks on operation and status", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'brain' and table_name = 'provider_usage' order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "id", "provider", "operation", "model", "requests", "estimated_tokens", "tokens", "status", "error", "client", "created_at", "finished_at",
    ]);
    const [rls] = await sql<{ rls: boolean }[]>`select relrowsecurity as rls from pg_class where oid = 'brain.provider_usage'::regclass`;
    expect(rls.rls).toBe(true);
    await expect(sql`
      insert into brain.provider_usage (provider, operation, model, estimated_tokens, status, client)
      values ('voyage', 'chat', 'm', 1, 'ok', 't')`).rejects.toThrow(/provider_usage_operation_check/);
    await expect(sql`
      insert into brain.provider_usage (provider, operation, model, estimated_tokens, status, client)
      values ('voyage', 'rerank', 'm', 1, 'pending', 't')`).rejects.toThrow(/provider_usage_status_check/);
  });
});

describe("reserveTokens and settleReservation", () => {
  it("reserves the estimate, then settles to Voyage's count, or to 0 with the message on error", async () => {
    const a = await reserveTokens(ledger(1000, "cli"), call(40));
    expect(await rowById(a)).toEqual({ status: "reserved", estimated_tokens: 40, tokens: null, requests: 1, error: null, client: "cli", finished: false });
    expect(await tokensToday(sql)).toBe(40);

    await settleReservation(sql, a, { tokens: 55 });
    expect(await rowById(a)).toMatchObject({ status: "ok", tokens: 55, finished: true });
    expect(await tokensToday(sql)).toBe(55);

    const b = await reserveTokens(ledger(1000), call(30));
    await settleReservation(sql, b, { error: "Voyage /embeddings returned 503: busy" });
    expect(await rowById(b)).toMatchObject({ status: "error", tokens: 0, error: "Voyage /embeddings returned 503: busy", finished: true });
    expect(await tokensToday(sql)).toBe(55);
  });

  it("keeps a call at its estimate when Voyage reports no usage", async () => {
    const id = await reserveTokens(ledger(1000), call(25));
    await settleReservation(sql, id, { tokens: null });
    expect(await rowById(id)).toMatchObject({ status: "ok", tokens: 25 });
  });

  it("settles a row once: a second settle does not change it", async () => {
    const id = await reserveTokens(ledger(1000), call(10));
    await settleReservation(sql, id, { tokens: 12 });
    await settleReservation(sql, id, { error: "late" });
    expect(await rowById(id)).toMatchObject({ status: "ok", tokens: 12, error: null });
  });

  it("refuses a call that would pass the cap, keeps the refusal, and leaves the counted total unchanged", async () => {
    await seed("ok", 900, 950);
    const err = await reserveTokens(ledger(1000), call(60)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpendCapError);
    expect(isSpendCap(err)).toBe(true);
    expect((err as SpendCapError).message).toBe(
      "Voyage daily token cap reached: 950 tokens counted today (UTC) + 60 estimated for this call > cap 1000",
    );
    expect([(err as SpendCapError).used, (err as SpendCapError).estimated, (err as SpendCapError).cap]).toEqual([950, 60, 1000]);
    const refused = await sql<Record<string, unknown>[]>`
      select requests, estimated_tokens, tokens, error, finished_at is not null as finished
      from brain.provider_usage where status = 'refused'`;
    expect(refused).toEqual([{ requests: 0, estimated_tokens: 60, tokens: 0, error: (err as Error).message, finished: true }]);
    expect(await tokensToday(sql)).toBe(950);

    // Reaching the cap exactly is allowed; one token more is not.
    await reserveTokens(ledger(1000), call(50));
    expect(await tokensToday(sql)).toBe(1000);
    await expect(reserveTokens(ledger(1000), call(1))).rejects.toThrow(/Voyage daily token cap reached/);
  });

  it("counts today's ok and reserved rows, stale reservations at their estimate, and nothing else", async () => {
    await seed("ok", 10, 100);
    await seed("reserved", 20, null);
    // A reservation whose process died mid-call: still counted, at its estimate. Kept inside today near 00:00 UTC.
    await sql`
      insert into brain.provider_usage (provider, operation, model, requests, estimated_tokens, tokens, status, client, created_at)
      values ('voyage', 'rerank', 'rerank-test', 1, 30, null, 'reserved', 'seed',
              greatest(now() - interval '11 minutes', date_trunc('day', now() at time zone 'utc') at time zone 'utc'))`;
    await seed("error", 40, 0);
    await seed("refused", 50, 0);
    await seed("ok", 60, 600, "1 day"); // the previous UTC day
    expect(await tokensToday(sql)).toBe(150);
  });

  it("refuses every call when the cap is 0", async () => {
    await expect(reserveTokens(ledger(0), call(1))).rejects.toThrow(
      "Voyage daily token cap reached: BRAIN_VOYAGE_DAILY_TOKEN_CAP is 0, which blocks every Voyage call",
    );
    expect(await tokensToday(sql)).toBe(0);
  });

  it("uses config.voyageDailyTokenCap when the ledger sets no cap", async () => {
    await expect(reserveTokens({ sql, client: "cli" }, call(config.voyageDailyTokenCap + 1))).rejects.toThrow(/Voyage daily token cap reached/);
  });

  it("admits no more than the cap when reservations race across connections and processes", async () => {
    const other = testDb(); // a second pool stands in for a second process
    try {
      for (let round = 0; round < 5; round++) {
        await sql`truncate brain.provider_usage`;
        const ledgers = [{ sql, client: "a", dailyTokenCap: 450 }, { sql: other, client: "b", dailyTokenCap: 450 }];
        const results = await Promise.allSettled(
          Array.from({ length: 12 }, (_, i) => reserveTokens(ledgers[i % 2], call(100))),
        );
        const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(results.length - refused.length).toBe(4);
        for (const r of refused) expect(isSpendCap(r.reason)).toBe(true);
        const rows = await sql<{ status: string; n: number; est: number }[]>`
          select status, count(*)::int as n, sum(estimated_tokens)::int as est
          from brain.provider_usage group by status order by status`;
        expect(rows).toEqual([{ status: "refused", n: 8, est: 800 }, { status: "reserved", n: 4, est: 400 }]);
        expect(await tokensToday(sql)).toBeLessThanOrEqual(450);
      }
    } finally {
      await other.end();
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/errors.test.ts test/unit/config.test.ts`
Expected: FAIL: `SpendCapError is not a constructor` and `parseTokenCap is not a function` (the exports do not exist yet).

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/ledger.test.ts`
Expected: FAIL: `Failed to load url ../../src/llm/ledger.js` (module does not exist).

- [ ] **Step 4: Write the migration**

`supabase/migrations/20261002000010_provider_usage.sql`:
```sql
-- Phase 3: Voyage spending guard (spec §5). One row per Voyage HTTP attempt, written before the request is sent
-- (status reserved) and settled after it (ok with Voyage's usage.total_tokens, or error with 0). A request that
-- would take today's (UTC) total past BRAIN_VOYAGE_DAILY_TOKEN_CAP is never sent and is recorded as refused.
-- The protocol is in src/llm/ledger.ts. Idempotent: safe to apply more than once.

begin;

create table if not exists brain.provider_usage (
  id bigint generated always as identity primary key,
  provider text not null,
  operation text not null check (operation in ('embed_document', 'embed_query', 'rerank')),
  model text not null,
  -- 1 for a request that was sent (or is being sent), 0 for a refusal.
  requests int not null default 1 check (requests >= 0),
  estimated_tokens int not null check (estimated_tokens >= 0),
  -- Null only while reserved; 0 on error and refused rows.
  tokens int check (tokens >= 0),
  status text not null check (status in ('reserved', 'ok', 'error', 'refused')),
  error text,
  client text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists provider_usage_created_at on brain.provider_usage (created_at);
alter table brain.provider_usage enable row level security;

-- Tokens counted against today's cap (UTC day). A reserved row counts at its estimate until it is settled, and for
-- the rest of the day if its process died mid-call: an over-count, the safe side. The reservation in
-- src/llm/ledger.ts and brain_orient both read this function, so they cannot disagree.
create or replace function brain.provider_tokens_today(p_provider text) returns bigint
language sql stable as $$
  select coalesce(sum(coalesce(tokens, estimated_tokens)), 0)::bigint
  from brain.provider_usage
  where provider = p_provider
    and status in ('reserved', 'ok')
    and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
$$;

commit;
```

- [ ] **Step 5: Add `SpendCapError` to `src/llm/errors.ts`**

Append to `src/llm/errors.ts`:
```ts
/**
 * A Voyage call was refused before it was sent: today's (UTC) counted tokens plus this call's estimate would pass
 * BRAIN_VOYAGE_DAILY_TOKEN_CAP. Retrying before 00:00 UTC (or before the cap is raised) cannot help.
 */
export class SpendCapError extends Error {
  readonly used: number;
  readonly estimated: number;
  readonly cap: number;
  constructor(message: string, detail: { used: number; estimated: number; cap: number }) {
    super(message);
    this.name = "SpendCapError";
    this.used = detail.used;
    this.estimated = detail.estimated;
    this.cap = detail.cap;
  }
}

/** True when a Voyage call was refused by the daily cap. */
export function isSpendCap(err: unknown): boolean {
  return err instanceof SpendCapError || (err instanceof Error && err.name === "SpendCapError");
}

/** Prefix of ingest_jobs.error when the cap stopped a document (src/ingest/pipeline.ts). */
export const SPEND_CAP_PREFIX = "spend_cap: ";
```

- [ ] **Step 6: Add the cap to `src/config.ts`**

In `src/config.ts`, insert between the `dotenv.config(...)` line and `export const config = {`:
```ts
export const DEFAULT_VOYAGE_DAILY_TOKEN_CAP = 5_000_000;

/**
 * BRAIN_VOYAGE_DAILY_TOKEN_CAP: whole tokens per UTC day (underscores allowed). Unset or empty means the default;
 * 0 blocks every Voyage call. There is no value that turns the cap off, and anything unreadable stops the process
 * at startup, so a typo can never lift the cap.
 */
export function parseTokenCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_VOYAGE_DAILY_TOKEN_CAP;
  const s = raw.trim().replace(/_/g, "");
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n)) {
    throw new Error(`BRAIN_VOYAGE_DAILY_TOKEN_CAP must be a whole number of tokens per UTC day (0 blocks every Voyage call); got "${raw}"`);
  }
  return n;
}
```
and inside the `config` object, after the `voyageRerankModel:` line:
```ts
  /** Hard cap on Voyage tokens per UTC day, enforced before every request by src/llm/ledger.ts. */
  voyageDailyTokenCap: parseTokenCap(process.env.BRAIN_VOYAGE_DAILY_TOKEN_CAP),
```

- [ ] **Step 7: Write `src/llm/ledger.ts`**

```ts
import type { Db } from "../db.js";
import { config } from "../config.js";
import { SpendCapError } from "./errors.js";

/**
 * The Voyage spend ledger (spec §5). Every HTTP attempt is reserved here before it is sent and settled after it.
 *
 * reserveTokens runs one READ COMMITTED transaction: take the one advisory lock every Voyage reservation in this
 * database shares, sum today's counted tokens (brain.provider_tokens_today), then insert either a `reserved` row
 * or a `refused` row. The lock makes check-and-insert atomic across connections and processes, and the sum runs
 * after the lock is granted, so it sees every reservation committed before it. At each admission, settled actual
 * tokens plus in-flight estimates stay within the cap; the day's total can pass the cap only by how far in-flight
 * calls' actual counts exceed their estimates.
 *
 * The ledger is per database: the real knowledge base and brain_eval each count and cap their own calls. Voyage
 * bills per account, so the account's daily spend can reach the sum of the caps of every database using the key.
 */

export type VoyageOperation = "embed_document" | "embed_query" | "rerank";

export interface VoyageLedger {
  /** The database whose brain.provider_usage records and caps the calls. */
  sql: Db;
  /** Who is spending (cli, mcp-stdio, mcp-http, eval, test); stored on every row. */
  client: string;
  /** Tokens per UTC day; defaults to config.voyageDailyTokenCap. Only tests set it. */
  dailyTokenCap?: number;
}

export interface MeteredCall {
  operation: VoyageOperation;
  model: string;
  /** Characters / 4 (src/llm/voyage.ts); at least 1 is reserved. */
  estimatedTokens: number;
}

/** How a reservation ends: Voyage's token count (null: none reported, keep the estimate), or an error at 0 tokens. */
export type Settlement = { tokens: number | null; error?: string } | { error: string };

/** A row still `reserved` after this long belongs to a process that died mid-call. It keeps counting at its estimate. */
export const STALE_RESERVATION_MINUTES = 10;

export function spendCapMessage(used: number, estimate: number, cap: number): string {
  return cap === 0
    ? "Voyage daily token cap reached: BRAIN_VOYAGE_DAILY_TOKEN_CAP is 0, which blocks every Voyage call"
    : `Voyage daily token cap reached: ${used} tokens counted today (UTC) + ${estimate} estimated for this call > cap ${cap}`;
}

/** Tokens counted against today's (UTC) cap in this database. */
export async function tokensToday(sql: Db): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select brain.provider_tokens_today('voyage')::float8 as n`;
  return row.n;
}

/**
 * Reserves one Voyage HTTP attempt. Returns the row id to settle, or throws SpendCapError (after recording a
 * `refused` row) when today's counted tokens plus the estimate would pass the cap. Throws whatever the database
 * throws if the reservation cannot be written; the caller then does not send the request (fail closed).
 */
export async function reserveTokens(ledger: VoyageLedger, call: MeteredCall): Promise<string> {
  const cap = ledger.dailyTokenCap ?? config.voyageDailyTokenCap;
  const estimate = Math.max(1, Math.ceil(call.estimatedTokens));
  const outcome = await ledger.sql.begin(async (tx) => {
    // Must be the transaction's first statement. READ COMMITTED gives the sum below a snapshot taken after the lock.
    await tx`set transaction isolation level read committed`;
    await tx`select pg_advisory_xact_lock(hashtextextended('brain:voyage-spend', 0))`;
    const [{ used }] = await tx<{ used: number }[]>`select brain.provider_tokens_today('voyage')::float8 as used`;
    if (used + estimate > cap) {
      const message = spendCapMessage(used, estimate, cap);
      await tx`
        insert into brain.provider_usage (provider, operation, model, requests, estimated_tokens, tokens, status, error, client, finished_at)
        values ('voyage', ${call.operation}, ${call.model}, 0, ${estimate}, 0, 'refused', ${message}, ${ledger.client}, now())`;
      return { refused: true as const, used, message };
    }
    const [row] = await tx<{ id: string }[]>`
      insert into brain.provider_usage (provider, operation, model, requests, estimated_tokens, status, client)
      values ('voyage', ${call.operation}, ${call.model}, 1, ${estimate}, 'reserved', ${ledger.client})
      returning id::text as id`;
    return { refused: false as const, id: row.id };
  });
  // Thrown after the commit, so the refused row is kept.
  if (outcome.refused) throw new SpendCapError(outcome.message, { used: outcome.used, estimated: estimate, cap });
  return outcome.id;
}

/** Settles a reservation once; a row that is no longer `reserved` is left alone. */
export async function settleReservation(sql: Db, id: string, outcome: Settlement): Promise<void> {
  if ("tokens" in outcome) {
    await sql`
      update brain.provider_usage
      set status = 'ok', tokens = coalesce(${outcome.tokens}::int, estimated_tokens), error = ${outcome.error ?? null}, finished_at = now()
      where id = ${id}::bigint and status = 'reserved'`;
  } else {
    await sql`
      update brain.provider_usage
      set status = 'error', tokens = 0, error = ${outcome.error.slice(0, 1000)}, finished_at = now()
      where id = ${id}::bigint and status = 'reserved'`;
  }
}
```

- [ ] **Step 8: Wipe the ledger between integration tests**

In `test/integration/helpers.ts`, in `wipe`, after `await sql\`truncate brain.tool_calls\`;` add:
```ts
  await sql`truncate brain.provider_usage`;
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run test/unit/errors.test.ts test/unit/config.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/ledger.test.ts`
Expected: PASS (9 tests). The race test runs 5 rounds of 12 reservations across two pools; each round admits exactly 4.

- [ ] **Step 10: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. Nothing calls the ledger yet.

- [ ] **Step 11: Apply to the eval database**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20261002000010_provider_usage.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "select brain.provider_tokens_today('voyage')"
```
Expected: `BEGIN`, `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, `CREATE FUNCTION`, `COMMIT`; then `0`. Applying it a second time prints `NOTICE: relation "provider_usage" already exists, skipping` (and the same for the index) and succeeds.

No eval run: nothing uses the ledger yet.

- [ ] **Step 12: Commit**

```bash
git add supabase/migrations/20261002000010_provider_usage.sql src/llm/ledger.ts src/llm/errors.ts src/config.ts test/integration/helpers.ts test/unit/errors.test.ts test/unit/config.test.ts test/integration/ledger.test.ts
git commit -m "Voyage spend ledger: provider_usage, daily token cap, locked reservation protocol

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: `VoyageClient` reserves every attempt; `makeCtx` wires the ledger

**Files:**
- Modify: `src/llm/voyage.ts`
- Modify: `src/ctx.ts`
- Modify: `src/eval/db.ts`
- Modify: `src/mcp/stdio.ts`
- Modify: `src/mcp/http-main.ts`
- Modify: `test/integration/helpers.ts` (`fakeVoyageFetch`, `meteredVoyage`)
- Modify: `test/unit/voyage.test.ts`
- Create: `test/unit/ctx.test.ts`
- Create: `test/integration/voyage-ledger.test.ts`

Retries: **each HTTP attempt is its own reservation**, not one reservation per logical call. Reasons: (1) every attempt re-checks the cap, so a call that waits out a 60 s rate limit cannot send its retry after other callers have filled the day; (2) a failed attempt (429, 5xx, network error) settles at 0 tokens immediately, so a retried call is never counted at more than one estimate at a time; (3) `requests` then counts real HTTP requests. The alternative (one reservation held across all retries) would hold the estimate through minutes of rate-limit waits and could not tell how many requests were sent. A `SpendCapError` from a reservation is never retried: the reservation runs outside the fetch `try`, so it propagates at once.

Fail closed: a `VoyageClient` that would use the real `fetch` must be given a ledger, or its constructor throws. Only a test that injects `fetchFn` may run unmetered. If the reservation cannot be written (database down), the request is not sent. If the settle fails, the row stays `reserved` and keeps counting at its estimate. The API key is read before the reservation, so a missing key never leaves a row behind.

Voyage's response shape, both endpoints: `{ object: "list", data: [...], model, usage: { total_tokens } }` (embeddings: `data[i] = { object: "embedding", embedding, index }`; rerank: `data[i] = { relevance_score, index }`). For rerank Voyage counts the query once per document plus every document, which the estimate mirrors.

- [ ] **Step 1: Write the failing unit tests**

In `test/unit/voyage.test.ts`, change the import line to:
```ts
import { VoyageClient, FakeEmbedder, FakeReranker, hashVector, estimateEmbedTokens, estimateRerankTokens, usageTokens } from "../../src/llm/voyage.js";
```
and append:
```ts
describe("spend metering", () => {
  it("estimates embeddings at 4 characters per token, at least 1", () => {
    expect(estimateEmbedTokens(["aaaa", "bbbbbbbb"])).toBe(3);
    expect(estimateEmbedTokens(["abcde"])).toBe(2);
    expect(estimateEmbedTokens([""])).toBe(1);
    expect(estimateEmbedTokens([])).toBe(1);
  });

  it("estimates a rerank as the query once per document plus every document", () => {
    // (3 chars * 2 documents + 4 + 6) / 4 = 4
    expect(estimateRerankTokens("abc", ["abcd", "abcdef"])).toBe(4);
    expect(estimateRerankTokens("q", [])).toBe(1);
  });

  it("reads usage.total_tokens and nothing else", () => {
    expect(usageTokens({ data: [], usage: { total_tokens: 42 } })).toBe(42);
    expect(usageTokens({ data: [] })).toBeNull();
    expect(usageTokens({ usage: { total_tokens: "42" } })).toBeNull();
    expect(usageTokens({ usage: { total_tokens: -1 } })).toBeNull();
    expect(usageTokens(null)).toBeNull();
  });

  it("refuses to build a client that could call Voyage without the ledger", () => {
    expect(() => new VoyageClient()).toThrow(/needs a spend ledger/);
    expect(() => new VoyageClient({ apiKey: "k", maxAttempts: 2 })).toThrow(/needs a spend ledger/);
    // An injected fetch (tests) may run unmetered.
    const fn = (async () => new Response("{}")) as unknown as typeof fetch;
    expect(new VoyageClient({ apiKey: "k", fetchFn: fn }).ledger).toBeNull();
  });
});
```

`test/unit/ctx.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { makeCtx } from "../../src/ctx.js";
import { makeEvalCtx, EVAL_CLIENT } from "../../src/eval/db.js";
import { VoyageClient } from "../../src/llm/voyage.js";

// postgres.js connects lazily and nothing here runs a query, so no connection is ever opened.
const UNUSED_DB = "postgresql://postgres:postgres@127.0.0.1:1/ctx_unit";

const voyageClients = (ctx: ReturnType<typeof makeCtx>) => [ctx.embedder, ctx.reranker, ctx.queryEmbedder, ctx.queryReranker];

describe("makeCtx", () => {
  it("meters the ingest and query Voyage clients in the context's own database", async () => {
    const ctx = makeCtx({ databaseUrl: UNUSED_DB, obsidian: false, client: "mcp-stdio" });
    try {
      for (const c of voyageClients(ctx)) {
        expect(c).toBeInstanceOf(VoyageClient);
        expect((c as VoyageClient).ledger?.sql).toBe(ctx.sql);
        expect((c as VoyageClient).ledger?.client).toBe("mcp-stdio");
        // The cap always comes from config in production.
        expect((c as VoyageClient).ledger?.dailyTokenCap).toBeUndefined();
      }
    } finally {
      await ctx.sql.end();
    }
  });

  it("labels CLI spend cli by default, and the eval's spend eval in brain_eval's ledger", async () => {
    const cli = makeCtx({ databaseUrl: UNUSED_DB, obsidian: false });
    const ev = makeEvalCtx();
    try {
      expect((cli.embedder as VoyageClient).ledger?.client).toBe("cli");
      expect(EVAL_CLIENT).toBe("eval");
      for (const c of voyageClients(ev)) {
        expect((c as VoyageClient).ledger?.client).toBe("eval");
        expect((c as VoyageClient).ledger?.sql).toBe(ev.sql);
      }
    } finally {
      await cli.sql.end();
      await ev.sql.end();
    }
  });
});
```

- [ ] **Step 2: Write the failing integration test**

First add the fake Voyage endpoint to `test/integration/helpers.ts`. Replace its import block with:
```ts
import { connect, type Db } from "../../src/db.js";
import type { Ctx } from "../../src/ctx.js";
import { FakeLlm } from "../../src/llm/llm.js";
import { FakeEmbedder, FakeReranker, VoyageClient, hashVector, estimateEmbedTokens, estimateRerankTokens } from "../../src/llm/voyage.js";
```
and append:
```ts
/**
 * A fetch that answers like Voyage: /embeddings with hashVector embeddings (so results match FakeEmbedder) and
 * /rerank by word overlap (FakeReranker), both with usage.total_tokens equal to the client's own estimate.
 */
export function fakeVoyageFetch(opts: { delayMs?: number } = {}): { fn: typeof fetch; calls: { path: string; body: any }[] } {
  const calls: { path: string; body: any }[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/v1/, "");
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (path === "/embeddings") {
      const input = body.input as string[];
      return json({
        object: "list",
        data: input.map((t, index) => ({ object: "embedding", index, embedding: hashVector(t) })),
        model: body.model,
        usage: { total_tokens: estimateEmbedTokens(input) },
      });
    }
    const documents = body.documents as string[];
    const hits = await new FakeReranker().rerank(body.query, documents, body.top_k);
    return json({
      object: "list",
      data: hits.map((h) => ({ index: h.index, relevance_score: h.score })),
      model: body.model,
      usage: { total_tokens: estimateRerankTokens(body.query, documents) },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** A real VoyageClient on the fake endpoint, metered in brain_test's ledger with the given daily cap. */
export function meteredVoyage(sql: Db, dailyTokenCap: number, opts: { client?: string; delayMs?: number } = {}) {
  const fake = fakeVoyageFetch({ delayMs: opts.delayMs });
  const voyage = new VoyageClient({
    apiKey: "test-key",
    fetchFn: fake.fn,
    retryDelayMs: 1,
    rateLimitDelayMs: 1,
    ledger: { sql, client: opts.client ?? "test", dailyTokenCap },
  });
  return { voyage, calls: fake.calls };
}
```

`test/integration/voyage-ledger.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, meteredVoyage } from "./helpers.js";
import { VoyageClient, estimateEmbedTokens, estimateRerankTokens } from "../../src/llm/voyage.js";
import { isSpendCap } from "../../src/llm/errors.js";
import { tokensToday } from "../../src/llm/ledger.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

type Row = { operation: string; model: string; requests: number; estimated_tokens: number; tokens: number | null; status: string; error: string | null; client: string; finished: boolean };
const rows = () => sql<Row[]>`
  select operation, model, requests, estimated_tokens, tokens, status, error, client, finished_at is not null as finished
  from brain.provider_usage order by id`;

/** Answers with the scripted responses in order, repeating the last one. */
function scripted(responses: Array<{ status: number; body: unknown }>) {
  let n = 0;
  const fn = (async () => {
    const r = responses[Math.min(n, responses.length - 1)];
    n++;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, count: () => n };
}

const ledger = (dailyTokenCap: number, client = "test") => ({ sql, client, dailyTokenCap });

describe("VoyageClient with a ledger", () => {
  it("records one ok row per embeddings request with Voyage's usage.total_tokens", async () => {
    const { fn } = scripted([
      { status: 200, body: { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }], usage: { total_tokens: 7 } } },
      { status: 200, body: { data: [{ index: 0, embedding: [3] }], usage: { total_tokens: 3 } } },
    ]);
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, batchSize: 2, embedModel: "voyage-test", ledger: ledger(1000, "cli") });
    expect(await client.embed(["aaaa", "bbbbbbbb", "c"], "document")).toEqual([[1], [2], [3]]);
    expect(await rows()).toEqual([
      { operation: "embed_document", model: "voyage-test", requests: 1, estimated_tokens: estimateEmbedTokens(["aaaa", "bbbbbbbb"]), tokens: 7, status: "ok", error: null, client: "cli", finished: true },
      { operation: "embed_document", model: "voyage-test", requests: 1, estimated_tokens: 1, tokens: 3, status: "ok", error: null, client: "cli", finished: true },
    ]);
    expect(await tokensToday(sql)).toBe(10);
  });

  it("records a query embedding as embed_query and a rerank with its estimate and count", async () => {
    const { fn } = scripted([
      { status: 200, body: { data: [{ index: 0, embedding: [1] }], usage: { total_tokens: 2 } } },
      { status: 200, body: { data: [{ index: 1, relevance_score: 0.9 }], usage: { total_tokens: 9 } } },
    ]);
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, embedModel: "voyage-test", rerankModel: "rerank-test", ledger: ledger(1000) });
    await client.embed(["what is it"], "query");
    expect(await client.rerank("q", ["aa", "bbbb"], 1)).toEqual([{ index: 1, score: 0.9 }]);
    expect((await rows()).map((r) => [r.operation, r.model, r.estimated_tokens, r.tokens, r.status])).toEqual([
      ["embed_query", "voyage-test", estimateEmbedTokens(["what is it"]), 2, "ok"],
      ["rerank", "rerank-test", estimateRerankTokens("q", ["aa", "bbbb"]), 9, "ok"],
    ]);
  });

  it("records a failed attempt at 0 tokens with the error, and its retry as a row of its own", async () => {
    const { fn, count } = scripted([
      { status: 500, body: { detail: "busy" } },
      { status: 200, body: { data: [{ index: 0, embedding: [1] }], usage: { total_tokens: 5 } } },
    ]);
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, retryDelayMs: 1, ledger: ledger(1000) });
    expect(await client.embed(["abc"], "document")).toEqual([[1]]);
    expect(count()).toBe(2);
    const [failed, ok] = await rows();
    expect(failed).toMatchObject({ status: "error", tokens: 0, requests: 1, finished: true });
    expect(failed.error).toMatch(/Voyage \/embeddings returned 500/);
    expect(ok).toMatchObject({ status: "ok", tokens: 5 });
    expect(await tokensToday(sql)).toBe(5);
  });

  it("records a 400 as an error row and throws", async () => {
    const { fn } = scripted([{ status: 400, body: { detail: "bad input" } }]);
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, ledger: ledger(1000) });
    await expect(client.rerank("q", ["a"], 1)).rejects.toThrow(/returned 400/);
    expect((await rows()).map((r) => [r.operation, r.status, r.tokens])).toEqual([["rerank", "error", 0]]);
  });

  it("refuses a call over the cap before fetch is called, and records the refusal", async () => {
    const { fn, count } = scripted([{ status: 200, body: { data: [{ index: 0, embedding: [1] }], usage: { total_tokens: 3 } } }]);
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, ledger: ledger(2) });
    const err = await client.embed(["aaaa bbbb c"], "document").catch((e: unknown) => e);
    expect(isSpendCap(err)).toBe(true);
    expect(count()).toBe(0);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "refused", requests: 0, tokens: 0, estimated_tokens: 3 });
    expect(row.error).toMatch(/^Voyage daily token cap reached/);
  });

  it("counts Voyage's actual tokens, not the estimate, against the next call", async () => {
    const { fn, count } = scripted([{ status: 200, body: { data: [{ index: 0, embedding: [1] }], usage: { total_tokens: 8 } } }]);
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, ledger: ledger(10) });
    await client.embed(["abcdefghij"], "document"); // estimate 3, actual 8
    await expect(client.embed(["abcdefghij"], "document")).rejects.toThrow(/8 tokens counted today \(UTC\) \+ 3 estimated for this call > cap 10/);
    expect(count()).toBe(1);
  });

  it("never lets concurrent calls spend past the cap while requests are in flight", async () => {
    const { voyage, calls } = meteredVoyage(sql, 350, { delayMs: 50 });
    const text = "x".repeat(400); // estimate 100; the fake reports 100
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => voyage.embed([text], "document")));
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.length - refused.length).toBe(3);
    for (const r of refused) expect(isSpendCap(r.reason)).toBe(true);
    expect(calls.length).toBe(3);
    expect(await tokensToday(sql)).toBe(300);
  });

  it("records nothing when the API key is missing", async () => {
    const { fn, count } = scripted([{ status: 200, body: {} }]);
    const client = new VoyageClient({ apiKey: "", fetchFn: fn, ledger: ledger(1000) });
    await expect(client.embed(["a"], "query")).rejects.toThrow(/VOYAGE_API_KEY is not set/);
    expect(count()).toBe(0);
    expect(await rows()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/voyage.test.ts test/unit/ctx.test.ts`
Expected: FAIL: `estimateEmbedTokens is not a function`, `refuses to build a client…` (no throw), `EVAL_CLIENT` undefined, `ledger` undefined.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/voyage-ledger.test.ts`
Expected: FAIL: `estimateEmbedTokens is not a function` (helpers import), or with that fixed, no rows recorded.

- [ ] **Step 4: Rewrite `src/llm/voyage.ts`**

Replace `src/llm/voyage.ts` with:
```ts
import { config } from "../config.js";
import { canonicalName } from "../text/normalize.js";
import { reserveTokens, settleReservation, type MeteredCall, type Settlement, type VoyageLedger } from "./ledger.js";

export type InputType = "query" | "document";

export interface Embedder {
  embed(texts: string[], inputType: InputType): Promise<number[][]>;
}

export interface RerankHit {
  index: number;
  score: number;
}

export interface Reranker {
  rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]>;
}

const BASE = "https://api.voyageai.com/v1";

export interface VoyageOptions {
  apiKey?: string;
  embedModel?: string;
  rerankModel?: string;
  fetchFn?: typeof fetch;
  batchSize?: number;
  retryDelayMs?: number;
  /** Base wait after a 429 without Retry-After; doubles per attempt, capped at 60 s. */
  rateLimitDelayMs?: number;
  /** Injected for tests; defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Total calls allowed while Voyage answers 429 (default 6). 1 means fail on the first 429 without waiting. */
  maxRateLimitAttempts?: number;
  /** Total calls allowed across 5xx responses and network errors (default 4). */
  maxAttempts?: number;
  /**
   * The spend ledger and its daily cap (src/llm/ledger.ts). Every HTTP attempt is reserved before it is sent and
   * settled after. Required unless fetchFn is injected (tests): a client that could reach Voyage unmetered is
   * refused at construction.
   */
  ledger?: VoyageLedger;
}

const MAX_ATTEMPTS = 4;
const MAX_RATE_LIMIT_ATTEMPTS = 6;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parses a Retry-After header (delta seconds or an HTTP date) into milliseconds, or undefined. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/** Tokens an embeddings request is reserved at: 4 characters per token, at least 1. */
export function estimateEmbedTokens(texts: string[]): number {
  const chars = texts.reduce((s, t) => s + t.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** Tokens a rerank request is reserved at: Voyage counts the query once per document plus every document. */
export function estimateRerankTokens(query: string, documents: string[]): number {
  const chars = query.length * documents.length + documents.reduce((s, d) => s + d.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** usage.total_tokens from an embeddings or rerank response, or null when it is missing or malformed. */
export function usageTokens(body: unknown): number | null {
  const t = (body as { usage?: { total_tokens?: unknown } } | null)?.usage?.total_tokens;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? Math.round(t) : null;
}

export class VoyageClient implements Embedder, Reranker {
  constructor(private readonly opts: VoyageOptions = {}) {
    // Fail closed: only a test that injects fetchFn may run without the ledger and its daily cap.
    if (!opts.ledger && !opts.fetchFn) {
      throw new Error("VoyageClient needs a spend ledger ({ sql, client }) so every call counts against BRAIN_VOYAGE_DAILY_TOKEN_CAP");
    }
  }

  /** The ledger this client records and caps its calls in, or null for an unmetered test client. */
  get ledger(): VoyageLedger | null {
    return this.opts.ledger ?? null;
  }

  private get apiKey(): string {
    const key = this.opts.apiKey ?? config.voyageApiKey;
    if (!key) throw new Error("VOYAGE_API_KEY is not set");
    return key;
  }

  async embed(texts: string[], inputType: InputType): Promise<number[][]> {
    const out: number[][] = [];
    const size = this.opts.batchSize ?? 128;
    const model = this.opts.embedModel ?? config.voyageEmbedModel;
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const body = await this.post(
        "/embeddings",
        { input: batch, model, input_type: inputType, output_dimension: config.embeddingDimensions },
        { operation: inputType === "query" ? "embed_query" : "embed_document", model, estimatedTokens: estimateEmbedTokens(batch) },
      );
      const data = (body.data as { index: number; embedding: number[] }[]).slice().sort((a, b) => a.index - b.index);
      if (data.length !== batch.length) throw new Error(`Voyage returned ${data.length} embeddings for ${batch.length} inputs`);
      out.push(...data.map((d) => d.embedding));
    }
    return out;
  }

  async rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]> {
    if (documents.length === 0) return [];
    const model = this.opts.rerankModel ?? config.voyageRerankModel;
    const body = await this.post(
      "/rerank",
      { query, documents, model, top_k: Math.min(topK, documents.length) },
      { operation: "rerank", model, estimatedTokens: estimateRerankTokens(query, documents) },
    );
    return (body.data as { index: number; relevance_score: number }[]).map((d) => ({ index: d.index, score: d.relevance_score }));
  }

  /** Reserves one attempt; throws SpendCapError when the cap refuses it. Null when unmetered (tests). */
  private async reserve(call: MeteredCall): Promise<string | null> {
    return this.opts.ledger ? reserveTokens(this.opts.ledger, call) : null;
  }

  /** A settle that fails leaves the row reserved, where it keeps counting at its estimate: the safe side. */
  private async settle(id: string | null, outcome: Settlement): Promise<void> {
    if (id === null || !this.opts.ledger) return;
    try {
      await settleReservation(this.opts.ledger.sql, id, outcome);
    } catch (err) {
      process.stderr.write(`brain: recording Voyage usage failed (row ${id} keeps counting at its estimate): ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async post(path: string, payload: unknown, call: MeteredCall): Promise<any> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const sleep = this.opts.sleep ?? defaultSleep;
    const delay = this.opts.retryDelayMs ?? 500;
    const rateDelay = this.opts.rateLimitDelayMs ?? 20_000;
    const maxAttempts = this.opts.maxAttempts ?? MAX_ATTEMPTS;
    const maxRateLimitAttempts = this.opts.maxRateLimitAttempts ?? MAX_RATE_LIMIT_ATTEMPTS;
    // Read before any reservation, so a missing key never leaves a reserved row behind.
    const authorization = `Bearer ${this.apiKey}`;
    let lastError: Error | undefined;
    // 429s and other transient failures have separate budgets: rate limits need minute-scale waits.
    let failures = 0;
    let rateLimits = 0;
    for (;;) {
      // Each attempt is its own reservation: a retry re-checks the cap, and a failed attempt settles at 0 tokens.
      const reservation = await this.reserve(call);
      const init = {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(payload),
      };
      let res: Response;
      try {
        res = await fetchFn(`${BASE}${path}`, init);
      } catch (err) {
        // Network failure (DNS, reset, "fetch failed"): retry with backoff like a 5xx.
        lastError = err instanceof Error ? err : new Error(String(err));
        await this.settle(reservation, { error: lastError.message });
        if (++failures >= maxAttempts) throw lastError;
        await sleep(delay * 2 ** (failures - 1));
        continue;
      }
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let body: any;
        try {
          body = await res.json();
        } catch (err) {
          // Voyage answered 200, so the call is billed: keep the row at its estimate.
          await this.settle(reservation, { tokens: null, error: `unreadable response: ${err instanceof Error ? err.message : String(err)}` });
          throw err;
        }
        const tokens = usageTokens(body);
        if (tokens === null && reservation !== null) {
          process.stderr.write(`brain: Voyage ${path} response had no usage.total_tokens; recorded at the estimate\n`);
        }
        await this.settle(reservation, { tokens });
        return body;
      }
      const text = await res.text();
      lastError = new Error(`Voyage ${path} returned ${res.status}: ${text.slice(0, 200)}`);
      await this.settle(reservation, { error: lastError.message });
      if (res.status === 429) {
        if (++rateLimits >= maxRateLimitAttempts) throw lastError;
        const wait = Math.min(
          retryAfterMs(res.headers.get("retry-after")) ?? rateDelay * 2 ** (rateLimits - 1),
          MAX_RATE_LIMIT_WAIT_MS,
        );
        process.stderr.write(`brain: Voyage rate limited, waiting ${Math.ceil(wait / 1000)}s\n`);
        await sleep(wait);
        continue;
      }
      if (res.status < 500) throw lastError;
      if (++failures >= maxAttempts) throw lastError;
      await sleep(delay * 2 ** (failures - 1));
    }
  }
}

/** Deterministic pseudo-embedding keyed on the canonical form of the text. Equal names collide, unrelated names do not. */
export function hashVector(text: string, dims = config.embeddingDimensions): number[] {
  const key = canonicalName(text);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let x = h || 1;
  const v = new Array<number>(dims);
  for (let i = 0; i < dims; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    v[i] = x / 4294967296 - 0.5;
  }
  const n = Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  return v.map((a) => a / n);
}

export class FakeEmbedder implements Embedder {
  calls: string[][] = [];
  async embed(texts: string[], _inputType?: InputType): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((t) => hashVector(t));
  }
}

export class FakeReranker implements Reranker {
  async rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]> {
    const words = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
    return documents
      .map((d, index) => ({
        index,
        score: d.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length / (words.size || 1),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
```

- [ ] **Step 5: Wire the ledger in `src/ctx.ts`**

Replace `MakeCtxOptions` and `makeCtx`'s first lines. The new `MakeCtxOptions`:
```ts
export interface MakeCtxOptions {
  /** Defaults to config.databaseUrl (the real knowledge base). */
  databaseUrl?: string;
  /** False turns the Obsidian mirror off regardless of the environment; the eval database must never be mirrored. */
  obsidian?: boolean;
  /** Stored on every Voyage ledger row: cli (default), mcp-stdio, mcp-http, eval. */
  client?: string;
}
```
and replace, inside `makeCtx`, everything from `const voyage = new VoyageClient();` through the closing `};` of the `const ctx: Ctx = { … };` literal with:
```ts
  const sql = connect(opts.databaseUrl ?? config.databaseUrl);
  // Both clients record every Voyage call in this database's brain.provider_usage and stop at the daily cap
  // (src/llm/ledger.ts). The eval context gets brain_eval's ledger the same way.
  const ledger = { sql, client: opts.client ?? "cli" };
  const voyage = new VoyageClient({ ledger });
  const queryVoyage = new VoyageClient({ ledger, maxRateLimitAttempts: 1, maxAttempts: 2 });
  const ctx: Ctx = {
    sql,
    llm: makeLlm(),
    embedder: voyage,
    reranker: voyage,
    queryEmbedder: queryVoyage,
    queryReranker: queryVoyage,
  };
```

- [ ] **Step 6: Label the eval and MCP contexts**

In `src/eval/db.ts`, replace `makeEvalCtx` and its comment with:
```ts
/** The ledger client label of every Voyage call the eval makes; runEval reads its spend by it. */
export const EVAL_CLIENT = "eval";

/**
 * A real context (real Voyage, real Claude Code) on the eval database, with the Obsidian mirror off. Its Voyage
 * calls are recorded and capped in brain_eval's own ledger, never the real base's.
 */
export function makeEvalCtx(): Ctx {
  assertEvalDatabase(EVAL_DATABASE_URL);
  return makeCtx({ databaseUrl: EVAL_DATABASE_URL, obsidian: false, client: EVAL_CLIENT });
}
```

In `src/mcp/stdio.ts`, replace `const ctx = makeCtx();` with `const ctx = makeCtx({ client: "mcp-stdio" });`.
In `src/mcp/http-main.ts`, replace `const ctx = makeCtx();` with `const ctx = makeCtx({ client: "mcp-http" });`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/voyage.test.ts test/unit/ctx.test.ts`
Expected: PASS. The existing `VoyageClient` tests inject `fetchFn` and no ledger, so they run unmetered and unchanged.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/voyage-ledger.test.ts test/integration/ledger.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. Integration tests use `FakeEmbedder`/`FakeReranker` through `fakeCtx`, which never touch the ledger.

- [ ] **Step 9: Check the eval context reaches its ledger**

Run:
```bash
npm run brain -- eval ingest
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "select count(*) from brain.provider_usage"
```
Expected: every corpus file prints `dup … done` (the corpus is already ingested, so nothing calls Voyage) and the count is `0`. If a file was unfinished and the run resumed it, the count is the number of Voyage requests it made, all `ok` with client `eval`; that is also correct. This proves the eval context starts against `brain_eval` with the ledger wired; Task 4's eval run is the first to spend through it. No eval run here: ranking is unchanged.

- [ ] **Step 10: Commit**

```bash
git add src/llm/voyage.ts src/ctx.ts src/eval/db.ts src/mcp/stdio.ts src/mcp/http-main.ts test/integration/helpers.ts test/unit/voyage.test.ts test/unit/ctx.test.ts test/integration/voyage-ledger.test.ts
git commit -m "VoyageClient reserves every attempt in the ledger and refuses to run unmetered; makeCtx wires it per database

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: The pipeline stops on the cap, counts no attempt, and stops asking for the rest of the batch

**Files:**
- Modify: `src/ingest/pipeline.ts`
- Modify: `src/ingest/batch.ts`
- Modify: `src/ingest/backfill.ts`
- Modify: `src/ingest/set-author.ts`
- Modify: `src/mcp/jobs.ts`
- Modify: `src/cli.ts` (`ingest`, `retry`)
- Create: `test/integration/spend-cap-pipeline.test.ts`

What the existing code already does, and what it does not: `advance` in `pipeline.ts` already catches any stage error, stores its message on the job and stops, so a `SpendCapError` from `runEmbed` or from `runResolve`'s entity-name embedding already stops the document with its message. Three things are missing:
1. **The prefix.** The job's error must read `spend_cap: <message>` so `brain status` and `brain_status` say why.
2. **The attempt count.** `advance` increments `attempts`, and `JobManager.resumeStalled` only resumes jobs with `attempts < 5`. Five capped days would strand a document for good. A cap refusal is not the document's failure: it records the error **without** incrementing `attempts`. `set-author`'s own re-resolve catch gets the same rule.
3. **The rest of the batch.** `retryFailed`, `redoSkipped`, `ingestAll`, `backfill` and `JobManager` run documents one after another; after the first refusal each later document would ask the ledger again, be refused, and write another `refused` row. Instead, after the first `spendCap` result they pass `voyageBlocked: true`, and `advance` stops before the first stage that calls Voyage (`embedded` or `resolved`) and records `DEFERRED_MESSAGE` without touching the ledger. Chunk and summarize, which do not call Voyage, still run, so new material is stored, chunked, summarized and keyword-searchable. `JobManager` keeps the flag for the rest of the UTC day (a restart, for example after raising the cap, clears it).

On the cap a document stays at `summarized` (refused in embed; summarize runs before embed in `STAGES`) or `extracted` (refused in resolve). `brain retry` picks up both, and `resumeStalled` picks them up on the next `brain_ingest` once they are 10 minutes old.

- [ ] **Step 1: Write the failing integration test**

`test/integration/spend-cap-pipeline.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx, meteredVoyage } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import type { Ctx } from "../../src/ctx.js";
import { ingest, retryFailed, runPipeline, DEFERRED_MESSAGE } from "../../src/ingest/pipeline.js";
import { ingestAll } from "../../src/ingest/batch.js";
import { setAuthor } from "../../src/ingest/set-author.js";
import { storeDocument } from "../../src/ingest/store.js";
import type { ReadResult } from "../../src/ingest/readers.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { JobManager, BACKGROUND_SLOTS } from "../../src/mcp/jobs.js";
import { tokensToday } from "../../src/llm/ledger.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM
    ? { title: "Acme note", summary_line: "Applying to Acme.", summary: "The owner applied to Acme Corp.", occurred_at: null }
    : fakeExtraction;

/** A fake LLM with a real VoyageClient on the fake endpoint, metered in brain_test with the given cap. */
function cappedCtx(cap: number): { ctx: Ctx; calls: { path: string }[] } {
  const { voyage, calls } = meteredVoyage(sql, cap);
  return { ctx: { ...fakeCtx(sql, handler), embedder: voyage, reranker: voyage }, calls };
}

const job = async (id: string) =>
  (await sql<{ stage: string; error: string | null; attempts: number }[]>`
    select stage, error, attempts from brain.ingest_jobs where document_id = ${id}`)[0];
const ledgerStatuses = () =>
  sql<{ status: string; n: number }[]>`select status, count(*)::int as n from brain.provider_usage group by status order by status`;
const read = (origin: string, text: string): ReadResult => ({ text, title: null, mimeType: "text/plain", origin, metadata: {} });

describe("pipeline on the Voyage daily cap", () => {
  it("stops before embedding with spend_cap, counts no attempt, and finishes on retry once the cap allows", async () => {
    const capped = cappedCtx(1);
    const res = await ingest(capped.ctx, { text: "I applied to Acme Corp. I am on F-1 OPT.", sourceKind: "note" });
    expect(res).toMatchObject({ stage: "summarized", spendCap: true });
    expect(res.error).toMatch(/^spend_cap: Voyage daily token cap reached/);
    expect(capped.calls).toEqual([]);
    const stopped = await job(res.id);
    expect(stopped).toMatchObject({ stage: "summarized", attempts: 0 });
    expect(stopped.error).toMatch(/^spend_cap: /);
    expect(await ledgerStatuses()).toEqual([{ status: "refused", n: 1 }]);

    const raised = cappedCtx(1_000_000);
    const [again] = await retryFailed(raised.ctx);
    expect(again).toMatchObject({ documentId: res.id, stage: "done", error: null });
    expect(again.spendCap).toBeUndefined();
    expect(raised.calls.some((c) => c.path === "/embeddings")).toBe(true);
    expect(await job(res.id)).toMatchObject({ stage: "done", error: null, attempts: 0 });
  });

  it("stops before resolving when the entity-name embedding would pass the cap", async () => {
    const open = cappedCtx(1_000_000);
    const { id } = await ingest(open.ctx, { text: "I applied to Acme Corp.", sourceKind: "note" }, { until: "extracted" });
    const capped = cappedCtx(await tokensToday(sql)); // nothing left today
    const r = await runPipeline(capped.ctx, id);
    expect(r).toMatchObject({ stage: "extracted", spendCap: true });
    expect(r.error).toMatch(/^spend_cap: Voyage daily token cap reached/);
    expect(capped.calls).toEqual([]);
    expect(await job(id)).toMatchObject({ stage: "extracted", attempts: 0 });
  });

  it("ingestAll asks the ledger once, then stops the remaining documents before embedding", async () => {
    const capped = cappedCtx(1);
    const res = await ingestAll(
      capped.ctx,
      [read("/a.md", "First note about apples."), read("/b.md", "Second note about pears."), read("/c.md", "Third note about plums.")],
      { toInput: (r) => ({ text: r.text, origin: r.origin, sourceKind: "note" }) },
      { done: () => {}, skip: () => {} },
    );
    expect(res.ok.map((o) => o.result.stage)).toEqual(["summarized", "summarized", "summarized"]);
    expect(res.ok.every((o) => o.result.spendCap)).toBe(true);
    expect(res.ok[0].result.error).toMatch(/^spend_cap: Voyage daily token cap reached/);
    expect(res.ok.slice(1).map((o) => o.result.error)).toEqual([DEFERRED_MESSAGE, DEFERRED_MESSAGE]);
    expect(await ledgerStatuses()).toEqual([{ status: "refused", n: 1 }]);
    expect(capped.calls).toEqual([]);
    for (const o of res.ok) expect((await job(o.result.id)).attempts).toBe(0);
  });

  it("retryFailed asks the ledger once, then defers the rest", async () => {
    const plain = fakeCtx(sql, handler);
    const ids: string[] = [];
    for (const t of ["Apples are red.", "Pears are green.", "Plums are purple."]) {
      ids.push((await ingest(plain, { text: t, sourceKind: "note" }, { until: "summarized" })).id);
    }
    const capped = cappedCtx(1);
    const results = await retryFailed(capped.ctx);
    expect(results.map((r) => r.documentId).sort()).toEqual([...ids].sort());
    expect(results.every((r) => r.spendCap && r.stage === "summarized")).toBe(true);
    expect(results.filter((r) => r.error === DEFERRED_MESSAGE).length).toBe(2);
    expect(await ledgerStatuses()).toEqual([{ status: "refused", n: 1 }]);
  });

  it("the background queue stops asking after a refusal and logs the cap once", async () => {
    const capped = cappedCtx(1);
    const ids: string[] = [];
    for (const t of ["Apples are red.", "Pears are green.", "Plums are purple."]) {
      const { id } = await storeDocument(sql, { text: t, sourceKind: "note" });
      await runPipeline(capped.ctx, id, { until: "chunked" });
      ids.push(id);
    }
    const logs: string[] = [];
    const jobs = new JobManager(capped.ctx, (m) => logs.push(m));
    for (const id of ids) jobs.start(id);
    await jobs.drain();
    for (const id of ids) {
      const j = await job(id);
      expect(j).toMatchObject({ stage: "summarized", attempts: 0 });
      expect(j.error).toMatch(/^spend_cap: /);
    }
    const [refused] = await ledgerStatuses();
    expect(refused.status).toBe("refused");
    // Documents already running when the first refusal lands ask once each; later ones do not ask.
    expect(refused.n).toBeGreaterThanOrEqual(1);
    expect(refused.n).toBeLessThanOrEqual(BACKGROUND_SLOTS);
    expect(capped.calls).toEqual([]);
    expect(logs.filter((l) => l.includes("Voyage daily cap reached")).length).toBe(1);
  });

  it("set-author refused by the cap puts the job back before resolve without counting an attempt", async () => {
    const { id } = await ingest(fakeCtx(sql, handler), { text: "I applied to Acme Corp. I am on F-1 OPT.", sourceKind: "note" });
    const capped = cappedCtx(1);
    await expect(setAuthor(capped.ctx, id, "other")).rejects.toThrow(/re-resolving failed: spend_cap: Voyage daily token cap reached/);
    const j = await job(id);
    expect(j).toMatchObject({ stage: "extracted", attempts: 0 });
    expect(j.error).toMatch(/^spend_cap: /);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/spend-cap-pipeline.test.ts`
Expected: FAIL: `spendCap` is undefined on results, errors lack the `spend_cap: ` prefix, `attempts` is 1, `DEFERRED_MESSAGE` is undefined, and the batch tests see one refused row per document.

- [ ] **Step 3: Rewrite `src/ingest/pipeline.ts`**

Replace `src/ingest/pipeline.ts` with:
```ts
import type { Ctx } from "../ctx.js";
import { storeDocument, type StoreInput } from "./store.js";
import { withDocumentLock } from "./lock.js";
import type { Author } from "./author.js";
import { isSpendCap, SPEND_CAP_PREFIX } from "../llm/errors.js";
import { runChunk } from "./stages/chunk.js";
import { runSummarize } from "./stages/summarize.js";
import { runEmbed } from "./stages/embed.js";
import { runExtract } from "./stages/extract.js";
import { runResolve } from "./stages/resolve.js";

export const STAGES = ["stored", "chunked", "summarized", "embedded", "extracted", "resolved", "done"] as const;
export type Stage = (typeof STAGES)[number];

/** Stages whose runner calls Voyage: embed (passages and summary) and resolve (entity names). */
export const VOYAGE_STAGES: readonly Stage[] = ["embedded", "resolved"];

/** The job error of a document a batch stopped before a Voyage stage because an earlier document hit the cap. */
export const DEFERRED_MESSAGE = `${SPEND_CAP_PREFIX}deferred: the Voyage daily cap was reached earlier in this run`;

/** Printed by the CLI after a run in which the cap stopped any document. */
export const SPEND_CAP_ADVICE =
  "Voyage daily cap reached: documents stopped before the stages that call Voyage (embedding, resolving). " +
  "`brain retry` finishes them after 00:00 UTC, or now if BRAIN_VOYAGE_DAILY_TOKEN_CAP is raised; `brain usage` shows today's spend.";

/** A stage may return a report (runResolve does); the pipeline ignores it. */
type Runner = (ctx: Ctx, documentId: string) => Promise<unknown>;
const RUNNERS: Record<Exclude<Stage, "stored">, Runner> = {
  chunked: runChunk,
  summarized: runSummarize,
  embedded: runEmbed,
  extracted: runExtract,
  resolved: runResolve,
  done: async () => {},
};

export interface PipelineResult {
  documentId: string;
  stage: Stage;
  error: string | null;
  /** True when another runner holds this document's lock, so this call did nothing. */
  skipped?: boolean;
  /** True when the Voyage daily cap stopped the run: refused by the ledger, or deferred (DEFERRED_MESSAGE). */
  spendCap?: boolean;
}

export interface RunOptions {
  /** Stop after this stage (default done). */
  until?: Stage;
  /**
   * Set by batch callers once any document in the batch hit the Voyage daily cap: the run stops before the first
   * stage that calls Voyage and records DEFERRED_MESSAGE, without asking the ledger again. Chunk and summarize,
   * which do not call Voyage, still run.
   */
  voyageBlocked?: boolean;
}

/**
 * Each running pipeline pins one reserved connection (its advisory lock) and needs up to a few pooled
 * connections for its stage queries. With the pool at max 10 (src/db.ts), three at once leave room for
 * their stage queries and for other work; without a cap, as many pipelines as pool slots would each
 * reserve one and their stage queries would wait forever.
 */
export const MAX_CONCURRENT_PIPELINES = 3;

/** Process-wide counting semaphore: excess runPipeline calls wait for a slot instead of failing. */
let running = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT_PIPELINES) {
    running++;
    return;
  }
  // The releaser hands its slot straight to us, so `running` stays unchanged.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

async function currentStage(ctx: Ctx, documentId: string): Promise<Stage> {
  const [job] = await ctx.sql<{ stage: Stage }[]>`select stage from brain.ingest_jobs where document_id = ${documentId}`;
  if (!job) throw new Error(`No ingest job for document ${documentId}`);
  return job.stage;
}

/**
 * Advances a document stage by stage until `until` (default done) or the first failure.
 * Holds a per-document session advisory lock for the whole run; if another runner holds it,
 * returns the current stage with skipped: true and does nothing. At most MAX_CONCURRENT_PIPELINES
 * runs proceed at once per process; the rest wait their turn.
 */
export async function runPipeline(ctx: Ctx, documentId: string, opts: RunOptions = {}): Promise<PipelineResult> {
  await acquireSlot();
  try {
    return await runLocked(ctx, documentId, opts.until ?? "done", opts.voyageBlocked ?? false);
  } finally {
    releaseSlot();
  }
}

async function runLocked(ctx: Ctx, documentId: string, until: Stage, voyageBlocked: boolean): Promise<PipelineResult> {
  const r = await withDocumentLock(ctx.sql, documentId, () => advance(ctx, documentId, until, voyageBlocked));
  return r.locked ? r.value : { documentId, stage: await currentStage(ctx, documentId), error: null, skipped: true };
}

async function advance(ctx: Ctx, documentId: string, target: Stage, voyageBlocked: boolean): Promise<PipelineResult> {
  for (;;) {
    const stage = await currentStage(ctx, documentId);
    const idx = STAGES.indexOf(stage);
    if (idx >= STAGES.indexOf(target)) return { documentId, stage, error: null };
    const next = STAGES[idx + 1] as Exclude<Stage, "stored">;
    if (voyageBlocked && VOYAGE_STAGES.includes(next)) {
      // Not a failure: no attempt is counted, so `brain retry` and resumeStalled pick it up later.
      await ctx.sql`update brain.ingest_jobs set error = ${DEFERRED_MESSAGE}, updated_at = now() where document_id = ${documentId}`;
      return { documentId, stage, error: DEFERRED_MESSAGE, spendCap: true };
    }
    try {
      await RUNNERS[next](ctx, documentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isSpendCap(err)) {
        // The ledger refused the call before it was sent. Not this document's failure, so no attempt is counted:
        // resumeStalled only resumes jobs with attempts < 5, and capped days must not use those up.
        const capped = SPEND_CAP_PREFIX + message;
        await ctx.sql`update brain.ingest_jobs set error = ${capped}, updated_at = now() where document_id = ${documentId}`;
        return { documentId, stage, error: capped, spendCap: true };
      }
      await ctx.sql`update brain.ingest_jobs set error = ${message}, attempts = attempts + 1, updated_at = now() where document_id = ${documentId}`;
      return { documentId, stage, error: message };
    }
    // Only advance from the stage this run started from, so a stage can never move backwards.
    const moved = await ctx.sql`
      update brain.ingest_jobs set stage = ${next}, error = null, updated_at = now()
      where document_id = ${documentId} and stage = ${stage}`;
    if (moved.count === 0) return { documentId, stage: await currentStage(ctx, documentId), error: null };
    // The raw text is readable once chunked, and the enrichment once done; tell the mirror both times.
    if (next === "chunked" || next === "done") documentChanged(ctx, documentId);
  }
}

/** A change listener (the Obsidian mirror) must never fail or stall ingestion. */
function documentChanged(ctx: Ctx, documentId: string): void {
  try {
    ctx.onDocumentChanged?.(documentId);
  } catch (err) {
    process.stderr.write(`brain: document change hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export async function ingest(
  ctx: Ctx,
  input: StoreInput,
  opts: RunOptions = {},
): Promise<PipelineResult & { created: boolean; id: string; author: Author }> {
  const { id, created, author } = await storeDocument(ctx.sql, input);
  const result = await runPipeline(ctx, id, opts);
  return { ...result, created, id: result.documentId, author };
}

/**
 * Re-runs every job that is not done, oldest first. After the first document the Voyage cap stops, the rest run
 * with voyageBlocked: they still get chunked and summarized, and stop before embedding without asking the ledger.
 */
export async function retryFailed(ctx: Ctx, opts: { stage?: Stage; limit?: number } = {}): Promise<PipelineResult[]> {
  const jobs = await ctx.sql<{ document_id: string }[]>`
    select document_id from brain.ingest_jobs
    where stage <> 'done' and (${opts.stage ?? null}::text is null or stage = ${opts.stage ?? null})
    order by updated_at limit ${opts.limit ?? 1000}`;
  const out: PipelineResult[] = [];
  let voyageBlocked = false;
  for (const j of jobs) {
    const r = await runPipeline(ctx, j.document_id, { voyageBlocked });
    out.push(r);
    if (r.spendCap) voyageBlocked = true;
  }
  return out;
}

/** Stages after which a skipped summary (redo from chunked) or skipped extraction (redo from embedded) has already been passed. */
const AFTER_CHUNKED: Stage[] = ["summarized", "embedded", "extracted", "resolved", "done"];
const AFTER_EMBEDDED: Stage[] = ["extracted", "resolved", "done"];

/**
 * Redoes enrichment that was skipped because the model refused or kept failing the schema: a stubbed
 * summary is redone from the chunked stage (which also redoes embedding and extraction), a skipped
 * extraction from the embedded stage. The reset happens only while holding the document's advisory
 * lock, so a document another runner holds is left alone and reported as skipped. Stops asking Voyage
 * after the first cap refusal, like retryFailed.
 */
export async function redoSkipped(ctx: Ctx, opts: { limit?: number } = {}): Promise<PipelineResult[]> {
  const docs = await ctx.sql<{ id: string }[]>`
    select d.id from brain.documents d join brain.ingest_jobs j on j.document_id = d.id
    where d.metadata->>'summary' = 'skipped' or d.metadata->>'extraction' = 'skipped'
    order by j.updated_at limit ${opts.limit ?? 1000}`;
  const out: PipelineResult[] = [];
  let voyageBlocked = false;
  for (const { id } of docs) {
    if (!(await resetSkipped(ctx, id))) {
      out.push({ documentId: id, stage: await currentStage(ctx, id), error: null, skipped: true });
      continue;
    }
    const r = await runPipeline(ctx, id, { voyageBlocked });
    out.push(r);
    if (r.spendCap) voyageBlocked = true;
  }
  return out;
}

/** Resets one document's stage and skip flags under its advisory lock. False when another runner holds the lock. */
async function resetSkipped(ctx: Ctx, documentId: string): Promise<boolean> {
  const r = await withDocumentLock(ctx.sql, documentId, () =>
    ctx.sql.begin(async (tx) => {
      const [doc] = await tx<{ summary: string | null; extraction: string | null }[]>`
        select metadata->>'summary' as summary, metadata->>'extraction' as extraction
        from brain.documents where id = ${documentId} for update`;
      if (!doc) return;
      const redoSummary = doc.summary === "skipped";
      if (!redoSummary && doc.extraction !== "skipped") return;
      // Redoing the summary redoes extraction too, so both flags go; otherwise only the extraction flag.
      await tx`
        update brain.documents
        set metadata = metadata - ${redoSummary ? ["summary", "extraction"] : ["extraction"]}::text[]
        where id = ${documentId}`;
      const to: Stage = redoSummary ? "chunked" : "embedded";
      const later = redoSummary ? AFTER_CHUNKED : AFTER_EMBEDDED;
      await tx`
        update brain.ingest_jobs set stage = ${to}, error = null, updated_at = now()
        where document_id = ${documentId} and stage = any(${later}::text[])`;
    }),
  );
  return r.locked;
}

export async function stageCounts(ctx: Ctx): Promise<{ stage: string; count: number; failed: number }[]> {
  const rows = await ctx.sql<{ stage: string; count: string; failed: string }[]>`
    select stage, count(*)::text as count, count(error)::text as failed from brain.ingest_jobs group by stage`;
  return STAGES.map((s) => {
    const r = rows.find((x) => x.stage === s);
    return { stage: s, count: Number(r?.count ?? 0), failed: Number(r?.failed ?? 0) };
  });
}
```

- [ ] **Step 4: `ingestAll` stops asking after a refusal**

In `src/ingest/batch.ts`, replace the doc comment and body of `ingestAll` (from `/**\n * Ingests each item on its own` to the end of the file) with:
```ts
/**
 * Ingests each item on its own: an item that throws (an unreadable file, an empty PDF) is logged and skipped,
 * and the rest still run. Stage failures inside the pipeline are not thrown; they stay on the job for retry.
 * After the first item the Voyage daily cap stops, the rest are stored, chunked and summarized and stop before
 * embedding without asking the ledger again (voyageBlocked).
 */
export async function ingestAll(
  ctx: Ctx,
  results: ReadResult[],
  opts: IngestAllOptions = {},
  log: IngestLog = { done: () => {}, skip: logSkip },
): Promise<{ ok: { origin: string; result: IngestOutcome }[]; failed: { origin: string; error: string }[] }> {
  const toInput = opts.toInput ?? defaultInput;
  const ok: { origin: string; result: IngestOutcome }[] = [];
  const failed: { origin: string; error: string }[] = [];
  let voyageBlocked = false;
  for (const r of results) {
    let result: IngestOutcome;
    try {
      result = await ingest(ctx, toInput(r), { until: opts.until, voyageBlocked });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ origin: r.origin, error: message });
      log.skip(r, message);
      continue;
    }
    if (result.spendCap) voyageBlocked = true;
    ok.push({ origin: r.origin, result });
    log.done(r, result);
  }
  return { ok, failed };
}
```

- [ ] **Step 5: `backfill` stops asking after a refusal**

In `src/ingest/backfill.ts`, change `import { runPipeline } from "./pipeline.js";` to:
```ts
import { runPipeline, SPEND_CAP_ADVICE } from "./pipeline.js";
```
Replace the step 3 block:
```ts
  // 3. Embeddings online (Voyage, cheap and fast).
  const summarized = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'summarized' limit ${limit}`;
  for (const j of summarized) await runPipeline(ctx, j.document_id, { until: "embedded" });
```
with:
```ts
  // 3. Embeddings online (Voyage). After the daily cap refuses one document, the rest are deferred without asking again.
  let voyageBlocked = false;
  const summarized = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'summarized' limit ${limit}`;
  for (const j of summarized) {
    const r = await runPipeline(ctx, j.document_id, { until: "embedded", voyageBlocked });
    if (r.spendCap) voyageBlocked = true;
  }
```
and replace the step 5 block:
```ts
  // 5. Resolve online (local plus name embeddings).
  const extracted = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'extracted' limit ${limit}`;
  for (const j of extracted) await runPipeline(ctx, j.document_id);
}
```
with:
```ts
  // 5. Resolve online (local plus name embeddings).
  const extracted = await ctx.sql<{ document_id: string }[]>`select document_id from brain.ingest_jobs where stage = 'extracted' limit ${limit}`;
  for (const j of extracted) {
    const r = await runPipeline(ctx, j.document_id, { voyageBlocked });
    if (r.spendCap) voyageBlocked = true;
  }
  if (voyageBlocked) console.log(SPEND_CAP_ADVICE);
}
```

- [ ] **Step 6: `set-author` counts no attempt for a cap refusal**

In `src/ingest/set-author.ts`, add the import:
```ts
import { isSpendCap, SPEND_CAP_PREFIX } from "../llm/errors.js";
```
and replace the `catch` block of the `runResolve` call:
```ts
  } catch (err) {
    // The undo has committed and only part of the document may be re-applied. Put the job back before the
    // resolve stage with the error, so `brain retry` re-runs resolve (which undoes and re-applies in full).
    const message = err instanceof Error ? err.message : String(err);
    await ctx.sql`
      update brain.ingest_jobs set stage = 'extracted', error = ${message}, attempts = attempts + 1, updated_at = now()
      where document_id = ${documentId}`;
    throw new Error(`author changed to ${author} but re-resolving failed: ${message}; run \`brain retry\` to finish`, { cause: err });
  }
```
with:
```ts
  } catch (err) {
    // The undo has committed and only part of the document may be re-applied. Put the job back before the
    // resolve stage with the error, so `brain retry` re-runs resolve (which undoes and re-applies in full).
    // A cap refusal is not the document's failure and counts no attempt (as in src/ingest/pipeline.ts).
    const capped = isSpendCap(err);
    const raw = err instanceof Error ? err.message : String(err);
    const message = capped ? SPEND_CAP_PREFIX + raw : raw;
    await ctx.sql`
      update brain.ingest_jobs set stage = 'extracted', error = ${message}, attempts = attempts + ${capped ? 0 : 1}, updated_at = now()
      where document_id = ${documentId}`;
    throw new Error(`author changed to ${author} but re-resolving failed: ${message}; run \`brain retry\` to finish`, { cause: err });
  }
```

- [ ] **Step 7: `JobManager` stops asking for the rest of the UTC day**

Replace `src/mcp/jobs.ts` with:
```ts
import type { Ctx } from "../ctx.js";
import { runPipeline, MAX_CONCURRENT_PIPELINES, type PipelineResult } from "../ingest/pipeline.js";

/**
 * Background pipelines this manager runs at once. One core slot stays free so a foreground
 * brain_ingest (store and chunk) never waits behind background summarize/extract work.
 */
export const BACKGROUND_SLOTS = Math.max(1, MAX_CONCURRENT_PIPELINES - 1);

const utcDay = () => new Date().toISOString().slice(0, 10);

/** Runs post-chunk pipeline stages in the background inside the server process. */
export class JobManager {
  /** Documents waiting for a background slot, in arrival order. */
  private readonly queue: string[] = [];
  private readonly running = new Map<string, Promise<PipelineResult>>();
  private idleWaiters: (() => void)[] = [];
  /**
   * The UTC day on which the Voyage daily cap stopped a document in this server. Documents started later that day
   * stop before their Voyage stages without asking the ledger; the next UTC day or a restart (for a raised cap)
   * clears it.
   */
  private voyageBlockedDay: string | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly log: (message: string) => void = (m) => process.stderr.write(m + "\n"),
  ) {}

  /** Queued and running document ids. */
  get pending(): string[] {
    return [...this.running.keys(), ...this.queue];
  }

  start(documentId: string): void {
    if (this.running.has(documentId) || this.queue.includes(documentId)) return;
    this.queue.push(documentId);
    this.pump();
  }

  private pump(): void {
    while (this.running.size < BACKGROUND_SLOTS && this.queue.length > 0) {
      const documentId = this.queue.shift()!;
      const voyageBlocked = this.voyageBlockedDay === utcDay();
      const run = runPipeline(this.ctx, documentId, { voyageBlocked })
        .then((r) => {
          if (r.spendCap) {
            if (this.voyageBlockedDay !== utcDay()) {
              this.voyageBlockedDay = utcDay();
              this.log(`brain: Voyage daily cap reached (${r.error}); queued documents stop before embedding until 00:00 UTC, then brain retry or the next brain_ingest resumes them`);
            }
          } else if (r.error && !r.skipped) {
            // A skipped result means another runner holds the document; that is not an error.
            this.log(`brain: document ${documentId} stopped after ${r.stage}: ${r.error}`);
          }
          return r;
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`brain: document ${documentId} failed: ${message}`);
          return { documentId, stage: "stored" as const, error: message };
        })
        .finally(() => {
          this.running.delete(documentId);
          this.pump();
          if (this.running.size === 0 && this.queue.length === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((w) => w());
          }
        });
      this.running.set(documentId, run);
    }
  }

  /** Picks up jobs another process left unfinished. */
  async resumeStalled(limit = 5, olderThanMinutes = 10): Promise<string[]> {
    const rows = await this.ctx.sql<{ document_id: string }[]>`
      select document_id from brain.ingest_jobs
      where stage <> 'done' and attempts < 5 and updated_at < now() - make_interval(mins => ${olderThanMinutes})
      order by updated_at limit ${limit}`;
    const started: string[] = [];
    for (const r of rows) {
      if (this.pending.includes(r.document_id)) continue;
      this.start(r.document_id);
      started.push(r.document_id);
    }
    return started;
  }

  /** Resolves once nothing is queued or running, including jobs started while draining. */
  async drain(): Promise<void> {
    while (this.running.size > 0 || this.queue.length > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }
}
```

- [ ] **Step 8: The CLI says what happened**

In `src/cli.ts`, change the pipeline import to:
```ts
import { redoSkipped, retryFailed, stageCounts, STAGES, SPEND_CAP_ADVICE, type Stage } from "./ingest/pipeline.js";
```
In the `ingest` action, replace:
```ts
      const { failed } = await ingestAll(
```
with:
```ts
      const { ok, failed } = await ingestAll(
```
and replace:
```ts
      if (failed.length) process.exitCode = 1;
    });
  });

program
  .command("status")
```
with:
```ts
      if (ok.some((o) => o.result.spendCap)) console.error(SPEND_CAP_ADVICE);
      if (failed.length) process.exitCode = 1;
    });
  });

program
  .command("status")
```
In the `retry` action, after the `for (const r of results) { … }` loop add:
```ts
      if (results.some((r) => r.spendCap)) console.log(SPEND_CAP_ADVICE);
```

- [ ] **Step 9: Run the tests**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/spend-cap-pipeline.test.ts test/integration/pipeline.test.ts test/integration/batch.test.ts test/integration/mcp-server.test.ts test/integration/set-author.test.ts test/integration/backfill.test.ts`
Expected: PASS. The existing pipeline, batch, MCP, set-author and backfill tests are unchanged: their fakes never raise `SpendCapError`, so `voyageBlocked` stays false.

- [ ] **Step 10: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. No eval run: ranking is unchanged.

- [ ] **Step 11: Commit**

```bash
git add src/ingest/pipeline.ts src/ingest/batch.ts src/ingest/backfill.ts src/ingest/set-author.ts src/mcp/jobs.ts src/cli.ts test/integration/spend-cap-pipeline.test.ts
git commit -m "Pipeline on the Voyage cap: spend_cap error without an attempt, batches stop asking after the first refusal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Search on the cap, and an accurate degraded note

**Files:**
- Modify: `src/retrieve/search.ts`
- Modify: `src/mcp/render.ts`
- Modify: `src/cli.ts` (`search` prints the mode)
- Modify: `test/integration/search.test.ts`
- Modify: `test/unit/render.test.ts`
- Modify: `test/unit/eval.test.ts`

Today `renderSearch` prints "(embeddings unavailable: keyword-only results)" for any degraded search, including one where the query embedding worked and only the reranker failed (results are then vector + keyword in fused order, not keyword-only). `SearchResult` gains `degradedReason` (which part fell back) and `capReached` (the ledger refused a call). The rerank can be refused after the query embedding was admitted (the embedding is a few tokens, the rerank of 60 candidates tens of thousands), and those results are not keyword-only, so that case is `degradedReason: "rerank"` with `capReached: true`. Four notes:

| `degradedReason` | `capReached` | note |
|---|---|---|
| `"cap"` | true | Voyage daily cap reached; keyword-only results |
| `"embedding"` | false | query embedding failed; keyword-only results |
| `"rerank"` | true | Voyage daily cap reached; results in fused order |
| `"rerank"` | false | reranking failed; results in fused order |

`degraded` stays (`degradedReason !== null`) because the eval and the log read it. Phase 4 replaces this with a `degraded` object; this is the minimum that makes the text true.

- [ ] **Step 1: Write the failing unit tests**

In `test/unit/render.test.ts`, change the import to:
```ts
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, degradedNote, searchMode } from "../../src/mcp/render.js";
```
In the first test's `renderSearch({ … })` literal, replace `      degraded: false,` with:
```ts
      degraded: false,
      degradedReason: null,
      capReached: false,
```
Replace the `"says so when nothing was found"` test and the `"notes degraded (keyword-only) results on its own line near the top"` test with:
```ts
  const empty = { query: "q", passages: [], documents: [], entities: [], facts: [], usedFallback: false, topScore: null };

  it("says so when nothing was found", () => {
    expect(renderSearch({ ...empty, usedFallback: true, degraded: false, degradedReason: null, capReached: false })).toContain("No passages matched");
  });

  it("names which part of a degraded search fell back, on its own line near the top", () => {
    const cases = [
      { degradedReason: "cap" as const, capReached: true, note: "Voyage daily cap reached; keyword-only results" },
      { degradedReason: "embedding" as const, capReached: false, note: "query embedding failed; keyword-only results" },
      { degradedReason: "rerank" as const, capReached: true, note: "Voyage daily cap reached; results in fused order" },
      { degradedReason: "rerank" as const, capReached: false, note: "reranking failed; results in fused order" },
    ];
    for (const c of cases) {
      const r = { ...empty, degraded: true, degradedReason: c.degradedReason, capReached: c.capReached };
      expect(degradedNote(r)).toBe(c.note);
      expect(searchMode(r)).toBe(c.note);
      const lines = renderSearch(r).split("\n");
      expect(lines.indexOf(`(${c.note})`)).toBeGreaterThanOrEqual(0);
      expect(lines.indexOf(`(${c.note})`)).toBeLessThan(3);
      expect(renderSearch(r)).not.toContain("embeddings unavailable");
    }
  });

  it("prints no note for a full hybrid search, and the CLI mode says so", () => {
    const r = { ...empty, degraded: false, degradedReason: null, capReached: false };
    expect(degradedNote(r)).toBeNull();
    expect(searchMode(r)).toBe("hybrid (vector and keyword, reranked)");
  });
```

In `test/unit/eval.test.ts`, in `searchResult`, replace:
```ts
    documents: [], entities: [], facts: [], usedFallback: false, topScore: passages[0]?.score ?? null, degraded,
```
with:
```ts
    documents: [], entities: [], facts: [], usedFallback: false, topScore: passages[0]?.score ?? null, degraded,
    degradedReason: degraded ? "embedding" : null, capReached: false,
```

- [ ] **Step 2: Write the failing integration tests**

In `test/integration/search.test.ts`, change the imports:
```ts
import { testDb, wipe, fakeCtx, meteredVoyage } from "./helpers.js";
```
```ts
import { FakeReranker, estimateEmbedTokens, type RerankHit } from "../../src/llm/voyage.js";
```
and add:
```ts
import { renderSearch } from "../../src/mcp/render.js";
```
In `"falls back to keyword-only search when the query embedding fails"`, after `expect(res.degraded).toBe(true);` add:
```ts
      expect(res.degradedReason).toBe("embedding");
      expect(res.capReached).toBe(false);
```
In `"keeps fused order with RRF scores when the reranker fails"`, after `expect(res.degraded).toBe(true);` add:
```ts
      expect(res.degradedReason).toBe("rerank");
      expect(res.capReached).toBe(false);
```
In `"is not degraded when embedding and reranking succeed"`, after `expect(res.degraded).toBe(false);` add:
```ts
    expect(res.degradedReason).toBeNull();
    expect(res.capReached).toBe(false);
```
Add these tests inside `describe("search", …)`, after `"is not degraded when embedding and reranking succeed"`:
```ts
  it("goes keyword-only and says the cap was reached when the ledger refuses the query embedding", async () => {
    const ctx = await seed();
    const { voyage, calls } = meteredVoyage(sql, 1);
    ctx.queryEmbedder = voyage;
    ctx.queryReranker = voyage;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await search(ctx, "What did Zorblax Industries release?");
      expect(res).toMatchObject({ degraded: true, degradedReason: "cap", capReached: true });
      expect(res.passages.some((p) => p.content.includes("ZX-9000"))).toBe(true);
      expect(calls).toEqual([]);
      expect(renderSearch(res)).toContain("(Voyage daily cap reached; keyword-only results)");
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("brain: Voyage daily cap reached, keyword search only");
    } finally {
      err.mockRestore();
    }
    const [log] = await sql<{ layers: string[] }[]>`select layers from brain.retrieval_log`;
    expect(log.layers).toEqual(expect.arrayContaining(["degraded", "cap_reached"]));
    const [refused] = await sql<{ operation: string; status: string }[]>`select operation, status from brain.provider_usage`;
    expect(refused).toEqual({ operation: "embed_query", status: "refused" });
  });

  it("keeps fused order and says the cap was reached when only the rerank is refused", async () => {
    const ctx = await seed();
    const query = "Zorblax Industries drill";
    // Room for the query embedding (the fake reports exactly the estimate) and nothing more.
    const { voyage, calls } = meteredVoyage(sql, estimateEmbedTokens([query]));
    ctx.queryEmbedder = voyage;
    ctx.queryReranker = voyage;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const res = await search(ctx, query);
      expect(res).toMatchObject({ degraded: true, degradedReason: "rerank", capReached: true });
      expect(calls.map((c) => c.path)).toEqual(["/embeddings"]);
      expect(res.passages.filter((p) => p.group === "hybrid").length).toBeGreaterThan(0);
      expect(renderSearch(res)).toContain("(Voyage daily cap reached; results in fused order)");
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("brain: Voyage daily cap reached, keeping fused order");
    } finally {
      err.mockRestore();
    }
  });

  it("searches normally through the ledger under the cap and records both calls", async () => {
    const ctx = await seed();
    const { voyage } = meteredVoyage(sql, 1_000_000, { client: "cli" });
    ctx.queryEmbedder = voyage;
    ctx.queryReranker = voyage;
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res).toMatchObject({ degraded: false, degradedReason: null, capReached: false });
    const rows = await sql<{ operation: string; status: string; client: string }[]>`
      select operation, status, client from brain.provider_usage order by id`;
    expect(rows).toEqual([
      { operation: "embed_query", status: "ok", client: "cli" },
      { operation: "rerank", status: "ok", client: "cli" },
    ]);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/render.test.ts test/unit/eval.test.ts`
Expected: FAIL: `degradedNote is not a function`; the typecheck of the literals would also fail until `SearchResult` has the fields.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/search.test.ts`
Expected: FAIL: `degradedReason` and `capReached` are undefined; the cap test's note reads "embeddings unavailable".

- [ ] **Step 4: Report the reason in `src/retrieve/search.ts`**

Add the import:
```ts
import { isSpendCap } from "../llm/errors.js";
```
Replace the `SearchResult` interface's last member:
```ts
  /** True when the query embedding or the reranker failed and results come from keyword search and fused order. */
  degraded: boolean;
}
```
with:
```ts
  /** True when any part fell back (degradedReason is not null). */
  degraded: boolean;
  /**
   * Which part fell back: "cap" (the Voyage daily cap refused the query embedding: keyword-only), "embedding" (the
   * query embedding failed: keyword-only), "rerank" (the reranker failed or was refused: vector and keyword in
   * fused order). Phase 4 replaces this with a structured `degraded` object.
   */
  degradedReason: DegradedReason;
  /** True when the Voyage daily cap refused the query embedding or the rerank. */
  capReached: boolean;
}

export type DegradedReason = "cap" | "embedding" | "rerank" | null;
```
Replace:
```ts
  let degraded = false;
  let qvec: string | null = null;
  try {
    const [queryVector] = await (ctx.queryEmbedder ?? ctx.embedder).embed([query], "query");
    qvec = toVector(queryVector);
  } catch (err) {
    degraded = true;
    process.stderr.write(`brain: query embedding failed, keyword search only: ${err instanceof Error ? err.message : String(err)}\n`);
  }
```
with:
```ts
  let degradedReason: DegradedReason = null;
  let capReached = false;
  let qvec: string | null = null;
  try {
    const [queryVector] = await (ctx.queryEmbedder ?? ctx.embedder).embed([query], "query");
    qvec = toVector(queryVector);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isSpendCap(err)) {
      capReached = true;
      degradedReason = "cap";
      process.stderr.write(`brain: Voyage daily cap reached, keyword search only: ${message}\n`);
    } else {
      degradedReason = "embedding";
      process.stderr.write(`brain: query embedding failed, keyword search only: ${message}\n`);
    }
  }
```
Replace the rerank `catch` block:
```ts
    } catch (err) {
      degraded = true;
      process.stderr.write(`brain: reranking failed, keeping fused order: ${err instanceof Error ? err.message : String(err)}\n`);
      reranked = fusedOrder();
    }
  }
```
with:
```ts
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      degradedReason = "rerank";
      if (isSpendCap(err)) {
        capReached = true;
        process.stderr.write(`brain: Voyage daily cap reached, keeping fused order: ${message}\n`);
      } else {
        process.stderr.write(`brain: reranking failed, keeping fused order: ${message}\n`);
      }
      reranked = fusedOrder();
    }
  }
  const degraded = degradedReason !== null;
```
Replace the `layers` line:
```ts
  const layers = ["hybrid", "summary", ...(entities.length ? ["graph"] : []), ...(facts.length ? ["facts"] : []), ...(usedFallback ? ["fallback"] : []), ...(degraded ? ["degraded"] : [])];
```
with:
```ts
  const layers = [
    "hybrid", "summary", ...(entities.length ? ["graph"] : []), ...(facts.length ? ["facts"] : []), ...(usedFallback ? ["fallback"] : []),
    ...(degraded ? ["degraded"] : []), ...(capReached ? ["cap_reached"] : []),
  ];
```
and the return:
```ts
  return { query, passages, documents, entities, facts, usedFallback, topScore, degraded };
```
with:
```ts
  return { query, passages, documents, entities, facts, usedFallback, topScore, degraded, degradedReason, capReached };
```

- [ ] **Step 5: Render the accurate note in `src/mcp/render.ts`**

Add after the `const day = …` line:
```ts
/** The one-line note for a degraded search, or null for a full hybrid search. */
export function degradedNote(r: Pick<SearchResult, "degradedReason" | "capReached">): string | null {
  switch (r.degradedReason) {
    case "cap":
      return "Voyage daily cap reached; keyword-only results";
    case "embedding":
      return "query embedding failed; keyword-only results";
    case "rerank":
      return r.capReached ? "Voyage daily cap reached; results in fused order" : "reranking failed; results in fused order";
    default:
      return null;
  }
}

/** The search mode, as the CLI prints it on its `mode:` line. */
export function searchMode(r: Pick<SearchResult, "degradedReason" | "capReached">): string {
  return degradedNote(r) ?? "hybrid (vector and keyword, reranked)";
}
```
In `renderSearch`, replace:
```ts
  if (r.degraded) out.push("(embeddings unavailable: keyword-only results)");
```
with:
```ts
  const note = degradedNote(r);
  if (note) out.push(`(${note})`);
```

- [ ] **Step 6: Print the mode in CLI `search`**

In `src/cli.ts`, in the `search` action, replace:
```ts
      if (opts.json) return void console.log(JSON.stringify(res, null, 2));
      if (res.usedFallback) console.log("(weak match: included raw substring hits)\n");
```
with:
```ts
      if (opts.json) return void console.log(JSON.stringify(res, null, 2));
      const { searchMode } = await import("./mcp/render.js");
      console.log(`mode: ${searchMode(res)}\n`);
      if (res.usedFallback) console.log("(weak match: included raw substring hits)\n");
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/render.test.ts test/unit/eval.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/search.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green.

- [ ] **Step 9: Eval: the first run through `brain_eval`'s ledger**

Run:
```bash
npm run eval:run
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "
select operation, status, client, count(*) as calls, sum(tokens) as tokens
from brain.provider_usage group by 1, 2, 3 order by 1, 2"
```
Expected: the same per-question ranks as `eval/baseline.json`, `degraded=0%`, no regressions (`vs baseline` deltas `+0.000`). The ledger shows `embed_query | ok | eval` and `rerank | ok | eval` rows, one per search (main questions and paraphrases), with positive token sums and no `refused` or `error` rows. If any search is degraded, stop and read stderr: a `Voyage daily cap reached` line means `brain_eval`'s cap was hit, anything else is a Voyage outage.

- [ ] **Step 10: Commit**

```bash
git add src/retrieve/search.ts src/mcp/render.ts src/cli.ts test/integration/search.test.ts test/unit/render.test.ts test/unit/eval.test.ts
git commit -m "Search on the Voyage cap: keyword-only with capReached; degraded notes name the part that fell back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Query-time retry budget

**Files:**
- Modify: `src/llm/voyage.ts`
- Modify: `src/ctx.ts`
- Modify: `test/unit/voyage.test.ts`
- Modify: `test/unit/ctx.test.ts`

The query clients get 3 attempts (for 429s and for 5xx/network errors alike) and at most 10 s of total backoff per call; the ingest client keeps its budget (6 rate-limit attempts with waits up to 60 s, 4 other attempts, no total limit). A wait that would take the call past 10 s gives up at once rather than waiting part of it: a `Retry-After: 30` cannot be satisfied in 10 s, so the search should fall back now instead of 10 s from now. Each attempt is still its own ledger reservation (Task 2).

- [ ] **Step 1: Write the failing tests**

In `test/unit/voyage.test.ts`, add `QUERY_RETRY_BUDGET` to the import from `../../src/llm/voyage.js`, and append:
```ts
describe("query-time retry budget", () => {
  const ok = { data: [{ index: 0, embedding: [1] }] };

  function seq(responses: Array<{ status: number; headers?: Record<string, string> }>) {
    let n = 0;
    const fn = (async () => {
      const r = responses[Math.min(n, responses.length - 1)];
      n++;
      return new Response(JSON.stringify(r.status === 200 ? ok : { detail: "x" }), { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    return { fn, count: () => n };
  }

  function client(fn: typeof fetch) {
    const waits: number[] = [];
    const c = new VoyageClient({ ...QUERY_RETRY_BUDGET, apiKey: "k", fetchFn: fn, sleep: async (ms) => void waits.push(ms) });
    return { c, waits };
  }

  // The rate-limit message goes to stderr; keep test output clean.
  const quiet = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  it("is 3 attempts with at most 10 s of backoff in total", () => {
    expect(QUERY_RETRY_BUDGET).toEqual({ maxAttempts: 3, maxRateLimitAttempts: 3, retryDelayMs: 500, rateLimitDelayMs: 2000, maxTotalWaitMs: 10_000 });
  });

  it("returns the result after two 429s, within the budget", async () => {
    const err = quiet();
    try {
      const { fn, count } = seq([{ status: 429 }, { status: 429 }, { status: 200 }]);
      const { c, waits } = client(fn);
      expect(await c.embed(["a"], "query")).toEqual([[1]]);
      expect(count()).toBe(3);
      expect(waits).toEqual([2000, 4000]);
    } finally {
      err.mockRestore();
    }
  });

  it("throws after three 429s", async () => {
    const err = quiet();
    try {
      const { fn, count } = seq([{ status: 429 }]);
      const { c, waits } = client(fn);
      await expect(c.embed(["a"], "query")).rejects.toThrow(/429/);
      expect(count()).toBe(3);
      expect(waits).toEqual([2000, 4000]);
    } finally {
      err.mockRestore();
    }
  });

  it("gives up at once when Retry-After asks for more than the budget", async () => {
    const { fn, count } = seq([{ status: 429, headers: { "retry-after": "30" } }, { status: 200 }]);
    const { c, waits } = client(fn);
    await expect(c.embed(["a"], "query")).rejects.toThrow(/429/);
    expect(count()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("never sleeps more than 10 s in total across retries", async () => {
    const err = quiet();
    try {
      const { fn, count } = seq([{ status: 429, headers: { "retry-after": "6" } }, { status: 429, headers: { "retry-after": "6" } }, { status: 200 }]);
      const { c, waits } = client(fn);
      await expect(c.embed(["a"], "query")).rejects.toThrow(/429/);
      expect(count()).toBe(2);
      expect(waits).toEqual([6000]);
    } finally {
      err.mockRestore();
    }
  });

  it("allows 3 attempts for 5xx with short backoff", async () => {
    const { fn, count } = seq([{ status: 503 }]);
    const { c, waits } = client(fn);
    await expect(c.rerank("q", ["a"], 1)).rejects.toThrow(/503/);
    expect(count()).toBe(3);
    expect(waits).toEqual([500, 1000]);
  });

  it("reports each client's budget; the ingest default has no total limit", () => {
    const fn = (async () => new Response("{}")) as unknown as typeof fetch;
    expect(new VoyageClient({ ...QUERY_RETRY_BUDGET, apiKey: "k", fetchFn: fn }).retryBudget).toEqual({ maxAttempts: 3, maxRateLimitAttempts: 3, maxTotalWaitMs: 10_000 });
    expect(new VoyageClient({ apiKey: "k", fetchFn: fn }).retryBudget).toEqual({ maxAttempts: 4, maxRateLimitAttempts: 6, maxTotalWaitMs: Infinity });
  });
});
```

In `test/unit/ctx.test.ts`, add inside `describe("makeCtx", …)`:
```ts
  it("gives the query clients the query budget and keeps the ingest budget", async () => {
    const ctx = makeCtx({ databaseUrl: UNUSED_DB, obsidian: false });
    try {
      expect((ctx.queryEmbedder as VoyageClient).retryBudget).toEqual({ maxAttempts: 3, maxRateLimitAttempts: 3, maxTotalWaitMs: 10_000 });
      expect((ctx.queryReranker as VoyageClient).retryBudget).toEqual({ maxAttempts: 3, maxRateLimitAttempts: 3, maxTotalWaitMs: 10_000 });
      expect((ctx.embedder as VoyageClient).retryBudget).toEqual({ maxAttempts: 4, maxRateLimitAttempts: 6, maxTotalWaitMs: Infinity });
    } finally {
      await ctx.sql.end();
    }
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/voyage.test.ts test/unit/ctx.test.ts`
Expected: FAIL: `QUERY_RETRY_BUDGET` is undefined (spreading it adds nothing, so the defaults apply: 6 rate-limit attempts, 20 s waits), and `retryBudget` is undefined.

- [ ] **Step 3: Add the budget to `src/llm/voyage.ts`**

In `VoyageOptions`, after `maxAttempts?: number;` add:
```ts
  /** Most total time one call may sleep between attempts; a wait that would pass it gives up instead (default unlimited). */
  maxTotalWaitMs?: number;
```
After `const MAX_RATE_LIMIT_WAIT_MS = 60_000;` add:
```ts
/**
 * Query-time clients (src/ctx.ts): 3 attempts and at most 10 s of backoff in total, so a search degrades quickly
 * instead of waiting out a Voyage outage. With a paid tier that is enough; without one the search still fails fast.
 */
export const QUERY_RETRY_BUDGET = {
  maxAttempts: 3,
  maxRateLimitAttempts: 3,
  retryDelayMs: 500,
  rateLimitDelayMs: 2_000,
  maxTotalWaitMs: 10_000,
} as const;
```
In the class, after the `ledger` getter add:
```ts
  /** The attempt and wait limits this client applies to one call. */
  get retryBudget(): { maxAttempts: number; maxRateLimitAttempts: number; maxTotalWaitMs: number } {
    return {
      maxAttempts: this.opts.maxAttempts ?? MAX_ATTEMPTS,
      maxRateLimitAttempts: this.opts.maxRateLimitAttempts ?? MAX_RATE_LIMIT_ATTEMPTS,
      maxTotalWaitMs: this.opts.maxTotalWaitMs ?? Infinity,
    };
  }
```
In `post`, replace:
```ts
    const maxAttempts = this.opts.maxAttempts ?? MAX_ATTEMPTS;
    const maxRateLimitAttempts = this.opts.maxRateLimitAttempts ?? MAX_RATE_LIMIT_ATTEMPTS;
```
with:
```ts
    const { maxAttempts, maxRateLimitAttempts, maxTotalWaitMs } = this.retryBudget;
    let waited = 0;
    /** Sleeps unless that would pass the total wait budget; false means give up now. */
    const pause = async (ms: number): Promise<boolean> => {
      if (waited + ms > maxTotalWaitMs) return false;
      waited += ms;
      await sleep(ms);
      return true;
    };
```
Replace the network-error retry:
```ts
        if (++failures >= maxAttempts) throw lastError;
        await sleep(delay * 2 ** (failures - 1));
        continue;
      }
```
with:
```ts
        if (++failures >= maxAttempts) throw lastError;
        if (!(await pause(delay * 2 ** (failures - 1)))) throw lastError;
        continue;
      }
```
Replace the 429 and 5xx tail:
```ts
      if (res.status === 429) {
        if (++rateLimits >= maxRateLimitAttempts) throw lastError;
        const wait = Math.min(
          retryAfterMs(res.headers.get("retry-after")) ?? rateDelay * 2 ** (rateLimits - 1),
          MAX_RATE_LIMIT_WAIT_MS,
        );
        process.stderr.write(`brain: Voyage rate limited, waiting ${Math.ceil(wait / 1000)}s\n`);
        await sleep(wait);
        continue;
      }
      if (res.status < 500) throw lastError;
      if (++failures >= maxAttempts) throw lastError;
      await sleep(delay * 2 ** (failures - 1));
    }
```
with:
```ts
      if (res.status === 429) {
        if (++rateLimits >= maxRateLimitAttempts) throw lastError;
        const wait = Math.min(
          retryAfterMs(res.headers.get("retry-after")) ?? rateDelay * 2 ** (rateLimits - 1),
          MAX_RATE_LIMIT_WAIT_MS,
        );
        if (waited + wait > maxTotalWaitMs) throw lastError;
        process.stderr.write(`brain: Voyage rate limited, waiting ${Math.ceil(wait / 1000)}s\n`);
        await pause(wait);
        continue;
      }
      if (res.status < 500) throw lastError;
      if (++failures >= maxAttempts) throw lastError;
      if (!(await pause(delay * 2 ** (failures - 1)))) throw lastError;
    }
```

- [ ] **Step 4: Use it in `src/ctx.ts`**

Change the voyage import to:
```ts
import { VoyageClient, QUERY_RETRY_BUDGET, type Embedder, type Reranker } from "./llm/voyage.js";
```
and replace:
```ts
  const queryVoyage = new VoyageClient({ ledger, maxRateLimitAttempts: 1, maxAttempts: 2 });
```
with:
```ts
  const queryVoyage = new VoyageClient({ ledger, ...QUERY_RETRY_BUDGET });
```
Update the `queryEmbedder` comment in `Ctx` to:
```ts
  /** Query-time clients: 3 attempts and at most 10 s of backoff per call (QUERY_RETRY_BUDGET), so search degrades fast. */
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/voyage.test.ts test/unit/ctx.test.ts`
Expected: PASS. The existing rate-limit tests (6 attempts, 60 s cap, 4 attempts for 5xx, `maxRateLimitAttempts: 1`, `maxAttempts: 2`) are unchanged: without `maxTotalWaitMs` the budget is unlimited.

- [ ] **Step 6: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. No eval run: a healthy Voyage never reaches the retry path, so ranking is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/llm/voyage.ts src/ctx.ts test/unit/voyage.test.ts test/unit/ctx.test.ts
git commit -m "Query-time Voyage budget: 3 attempts and at most 10 s of backoff per call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: `brain usage`, the `brain_orient` line, prices, and the docs

**Files:**
- Create: `src/llm/usage.ts`
- Modify: `src/config.ts` (prices)
- Modify: `src/retrieve/orient.ts`
- Modify: `src/mcp/render.ts` (`renderOrient`)
- Modify: `src/cli.ts` (`usage` command)
- Modify: `.env.example`
- Modify: `README.md`
- Create: `test/unit/usage.test.ts`
- Create: `test/integration/usage.test.ts`
- Modify: `test/unit/config.test.ts`
- Modify: `test/unit/render.test.ts`
- Modify: `test/integration/mcp-server.test.ts`

`brain usage [--days N]` (default 30, as in the spec) prints one line per UTC day and operation with requests, tokens, refused calls and errors, a day total when a day has more than one operation, an estimated cost column when either price is set, and today's tokens against the cap. Tokens are counted the way the cap counts them: `ok` rows at Voyage's count, `reserved` rows at their estimate (a reservation older than 10 minutes is flagged stale), `error` and `refused` rows at 0. Prices are US dollars per million tokens, read from `.env` and defaulting to 0 (tokens only); embed prices apply to `embed_document` and `embed_query`, the rerank price to `rerank`.

- [ ] **Step 1: Write the failing unit tests**

`test/unit/usage.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { formatUsage, voyageTodayLine, type UsageRow } from "../../src/llm/usage.js";

const rows: UsageRow[] = [
  { day: "2026-10-02", operation: "embed_document", requests: 3, tokens: 1_300, refused: 0, errors: 1, stale: 0 },
  { day: "2026-10-02", operation: "rerank", requests: 2, tokens: 24_000, refused: 4, errors: 0, stale: 1 },
  { day: "2026-10-01", operation: "embed_query", requests: 5, tokens: 50, refused: 0, errors: 0, stale: 0 },
];

describe("voyageTodayLine", () => {
  it("shows today's tokens against the cap", () => {
    expect(voyageTodayLine(1_250_000, 5_000_000)).toBe("Voyage today: 1,250,000 of 5,000,000 tokens (25.0%)");
    expect(voyageTodayLine(0, 5_000_000)).toBe("Voyage today: 0 of 5,000,000 tokens (0.0%)");
  });
  it("says a cap of 0 blocks every call", () => {
    expect(voyageTodayLine(0, 0)).toBe("Voyage today: 0 of 0 tokens (the cap is 0: every Voyage call is blocked)");
  });
});

describe("formatUsage", () => {
  it("prints a line per day and operation, a day total, refusals, stale reservations, and today against the cap", () => {
    const lines = formatUsage(rows, { days: 30, tokensToday: 25_300, cap: 5_000_000, prices: { embed: 0, rerank: 0 } });
    expect(lines[0]).toMatch(/^UTC day\s+operation\s+requests\s+tokens\s+refused\s+errors$/);
    expect(lines[1]).toMatch(/^2026-10-02\s+embed_document\s+3\s+1,300\s+0\s+1$/);
    expect(lines[2]).toMatch(/^2026-10-02\s+rerank\s+2\s+24,000\s+4\s+0\s+\(1 stale reservation counted at the estimate\)$/);
    expect(lines[3]).toMatch(/^2026-10-02\s+all\s+5\s+25,300\s+4\s+1\s+\(1 stale reservation counted at the estimate\)$/);
    expect(lines[4]).toMatch(/^2026-10-01\s+embed_query\s+5\s+50\s+0\s+0$/);
    expect(lines).toContain("Set BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED and BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK in .env to see an estimated cost.");
    expect(lines.at(-1)).toBe("Voyage today: 25,300 of 5,000,000 tokens (0.5%); the count resets at 00:00 UTC.");
  });

  it("adds an estimated cost column when a price is set (illustrative prices)", () => {
    const priced: UsageRow[] = [
      { day: "2026-10-02", operation: "embed_document", requests: 10, tokens: 2_000_000, refused: 0, errors: 0, stale: 0 },
      { day: "2026-10-02", operation: "rerank", requests: 4, tokens: 500_000, refused: 0, errors: 0, stale: 0 },
    ];
    const lines = formatUsage(priced, { days: 1, tokensToday: 2_500_000, cap: 5_000_000, prices: { embed: 0.12, rerank: 0.05 } });
    expect(lines[0]).toMatch(/errors\s+est\. cost$/);
    expect(lines[1]).toMatch(/^2026-10-02\s+embed_document\s+10\s+2,000,000\s+0\s+0\s+\$0\.2400$/);
    expect(lines[2]).toMatch(/^2026-10-02\s+rerank\s+4\s+500,000\s+0\s+0\s+\$0\.0250$/);
    expect(lines[3]).toMatch(/^2026-10-02\s+all\s+14\s+2,500,000\s+0\s+0\s+\$0\.2650$/);
    expect(lines.join("\n")).not.toContain("to see an estimated cost");
  });

  it("says when there were no calls", () => {
    const lines = formatUsage([], { days: 7, tokensToday: 0, cap: 0, prices: { embed: 0, rerank: 0 } });
    expect(lines[0]).toBe("No Voyage calls in the last 7 UTC days.");
    expect(lines.at(-1)).toBe("Voyage today: 0 of 0 tokens (the cap is 0: every Voyage call is blocked); the count resets at 00:00 UTC.");
  });
});
```

In `test/unit/config.test.ts`, change the import to:
```ts
import { config, parseTokenCap, parsePrice, DEFAULT_VOYAGE_DAILY_TOKEN_CAP } from "../../src/config.js";
```
and append:
```ts
describe("parsePrice", () => {
  it("defaults to 0 (tokens only) and reads non-negative decimals", () => {
    expect(parsePrice("X", undefined)).toBe(0);
    expect(parsePrice("X", "")).toBe(0);
    expect(parsePrice("X", "0.12")).toBe(0.12);
    expect(parsePrice("X", " 2 ")).toBe(2);
  });
  it("refuses anything else, naming the variable", () => {
    for (const bad of ["-0.1", "$0.12", "1e-3", "abc"]) {
      expect(() => parsePrice("BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED", bad), bad).toThrow(/BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED must be/);
    }
  });
  it("is what config uses", () => {
    expect(config.voyagePricePerMTokEmbed).toBe(parsePrice("BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED", process.env.BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED));
    expect(config.voyagePricePerMTokRerank).toBe(parsePrice("BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK", process.env.BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK));
  });
});
```

In `test/unit/render.test.ts`, replace the `"renderOrient lists counts and usage guidance"` test with:
```ts
  it("renderOrient lists counts, today's Voyage tokens against the cap, and usage guidance", () => {
    const t = renderOrient({
      totalDocuments: 2, documentsByKind: [{ kind: "news", count: 2 }], nodesByType: [{ type: "person", count: 3 }],
      recent: [{ id: "d1", title: "T", sourceKind: "news", occurredAt: null, ingestedAt: new Date("2026-09-27T00:00:00Z") }],
      facts: [{ id: "f", predicate: "p", objectText: "o", verified: false }], pipeline: [{ stage: "done", count: 2, failed: 0 }],
      voyage: { tokensToday: 1_250_000, cap: 5_000_000 },
    });
    expect(t).toContain("2 documents");
    expect(t).toContain("news: 2");
    expect(t).toContain("person: 3");
    expect(t.split("\n")).toContain("Voyage today: 1,250,000 of 5,000,000 tokens (25.0%)");
    expect(t).toContain("brain_search");
  });
```

- [ ] **Step 2: Write the failing integration tests**

`test/integration/usage.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { usageByDay, formatUsage } from "../../src/llm/usage.js";
import { tokensToday } from "../../src/llm/ledger.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

/** Inserts a ledger row directly, `ago` before now. */
async function seed(operation: string, status: string, estimated: number, tokens: number | null, ago = "0 seconds", client = "seed") {
  await sql`
    insert into brain.provider_usage (provider, operation, model, requests, estimated_tokens, tokens, status, client, created_at)
    values ('voyage', ${operation}, 'voyage-test', ${status === "refused" ? 0 : 1}, ${estimated}, ${tokens}, ${status}, ${client},
            now() - ${ago}::interval)`;
}

const days = async () =>
  (await sql<{ today: string; yesterday: string }[]>`
    select to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD') as today,
           to_char((now() at time zone 'utc')::date - 1, 'YYYY-MM-DD') as yesterday`)[0];

describe("usageByDay", () => {
  it("sums requests, tokens, refusals and errors per UTC day and operation, and prints per-day totals", async () => {
    await seed("embed_document", "ok", 100, 120);
    await seed("embed_document", "ok", 50, 40);
    await seed("embed_document", "error", 30, 0);
    await seed("rerank", "refused", 900, 0);
    await seed("rerank", "reserved", 70, null);
    await seed("embed_query", "ok", 5, 6, "1 day");
    await seed("embed_query", "ok", 5, 6, "40 days"); // outside --days 2
    const { today, yesterday } = await days();
    const rows = await usageByDay(sql, 2);
    expect(rows).toEqual([
      { day: today, operation: "embed_document", requests: 3, tokens: 160, refused: 0, errors: 1, stale: 0 },
      { day: today, operation: "rerank", requests: 1, tokens: 70, refused: 1, errors: 0, stale: 0 },
      { day: yesterday, operation: "embed_query", requests: 1, tokens: 6, refused: 0, errors: 0, stale: 0 },
    ]);
    expect(await tokensToday(sql)).toBe(230);

    const lines = formatUsage(rows, { days: 2, tokensToday: 230, cap: 1000, prices: { embed: 0, rerank: 0 } });
    expect(lines.find((l) => l.startsWith(`${today}  all`))).toMatch(/\s4\s+230\s+1\s+1$/);
    expect(lines.find((l) => l.startsWith(`${yesterday}  embed_query`))).toMatch(/\s1\s+6\s+0\s+0$/);
    expect(lines.at(-1)).toBe("Voyage today: 230 of 1,000 tokens (23.0%); the count resets at 00:00 UTC.");
  });

  it("flags a reservation older than 10 minutes as stale", async () => {
    await seed("rerank", "reserved", 70, null, "11 minutes");
    await seed("rerank", "reserved", 30, null);
    const rows = await usageByDay(sql, 2);
    expect(rows.reduce((s, r) => s + r.stale, 0)).toBe(1);
  });

  it("rejects a day count that is not a positive whole number", async () => {
    await expect(usageByDay(sql, 0)).rejects.toThrow(/days must be a positive whole number/);
    await expect(usageByDay(sql, 1.5)).rejects.toThrow(/days must be a positive whole number/);
  });
});
```

In `test/integration/mcp-server.test.ts`, add inside `describe("brain MCP server", …)`:
```ts
  it("brain_orient reports today's Voyage tokens against the cap", async () => {
    await sql`
      insert into brain.provider_usage (provider, operation, model, requests, estimated_tokens, tokens, status, client)
      values ('voyage', 'embed_query', 'voyage-test', 1, 1000, 1234, 'ok', 'test')`;
    const s = await connect();
    const orient = await s.call("brain_orient");
    expect(orient.text).toMatch(/Voyage today: 1,234 of [\d,]+ tokens/);
    await s.close();
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/usage.test.ts test/unit/config.test.ts test/unit/render.test.ts`
Expected: FAIL: `Failed to load url ../../src/llm/usage.js`; `parsePrice is not a function`; the orient text has no `Voyage today:` line.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/usage.test.ts test/integration/mcp-server.test.ts`
Expected: FAIL: `Failed to load url ../../src/llm/usage.js`; the orient test finds no `Voyage today:`.

- [ ] **Step 4: Add the prices to `src/config.ts`**

After `parseTokenCap`, add:
```ts
/** A USD-per-million-tokens price from .env. Unset or empty means 0, which prints tokens only. */
export function parsePrice(name: string, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${name} must be a non-negative number of US dollars per million tokens; got "${raw}"`);
  return Number(s);
}
```
and inside `config`, after `voyageDailyTokenCap: …,`:
```ts
  /** US dollars per million tokens, copied from Voyage's pricing page into .env; 0 prints tokens only. */
  voyagePricePerMTokEmbed: parsePrice("BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED", process.env.BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED),
  voyagePricePerMTokRerank: parsePrice("BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK", process.env.BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK),
```

- [ ] **Step 5: Write `src/llm/usage.ts`**

```ts
import type { Db } from "../db.js";
import { STALE_RESERVATION_MINUTES, type VoyageOperation } from "./ledger.js";

/** One UTC day and operation of Voyage spend in this database's ledger. */
export interface UsageRow {
  /** YYYY-MM-DD, UTC. */
  day: string;
  operation: VoyageOperation;
  /** HTTP requests sent (refusals are not requests). */
  requests: number;
  /** Counted the way the cap counts: ok at Voyage's count, reserved at the estimate, error and refused at 0. */
  tokens: number;
  refused: number;
  errors: number;
  /** Reservations older than STALE_RESERVATION_MINUTES: their process died mid-call; counted at the estimate. */
  stale: number;
}

export interface UsagePrices {
  /** USD per million tokens for embed_document and embed_query. */
  embed: number;
  /** USD per million tokens for rerank. */
  rerank: number;
}

type Totals = Omit<UsageRow, "day" | "operation">;

const fmt = (n: number) => n.toLocaleString("en-US");

/** The brain_orient line, and the last line of `brain usage`. */
export function voyageTodayLine(tokens: number, cap: number): string {
  if (cap === 0) return `Voyage today: ${fmt(tokens)} of 0 tokens (the cap is 0: every Voyage call is blocked)`;
  return `Voyage today: ${fmt(tokens)} of ${fmt(cap)} tokens (${((tokens / cap) * 100).toFixed(1)}%)`;
}

/** Spend per UTC day and operation over the last `days` UTC days, today included, newest first. */
export async function usageByDay(sql: Db, days: number): Promise<UsageRow[]> {
  if (!Number.isInteger(days) || days < 1) throw new Error(`days must be a positive whole number; got ${days}`);
  return sql<UsageRow[]>`
    select to_char(created_at at time zone 'utc', 'YYYY-MM-DD') as day,
           operation,
           sum(requests)::int as requests,
           coalesce(sum(case status when 'ok' then tokens when 'reserved' then estimated_tokens else 0 end), 0)::float8 as tokens,
           (count(*) filter (where status = 'refused'))::int as refused,
           (count(*) filter (where status = 'error'))::int as errors,
           (count(*) filter (where status = 'reserved'
                              and created_at < now() - make_interval(mins => ${STALE_RESERVATION_MINUTES})))::int as stale
    from brain.provider_usage
    where provider = 'voyage'
      and created_at >= (date_trunc('day', now() at time zone 'utc') - make_interval(days => ${days - 1})) at time zone 'utc'
    group by 1, 2
    order by 1 desc, 2`;
}

function costOf(operation: VoyageOperation, tokens: number, prices: UsagePrices): number {
  return (tokens / 1_000_000) * (operation === "rerank" ? prices.rerank : prices.embed);
}

function line(day: string, operation: string, t: Totals, cost: number | null): string {
  const cells = [
    day.padEnd(10),
    operation.padEnd(14),
    String(t.requests).padStart(8),
    fmt(t.tokens).padStart(13),
    String(t.refused).padStart(7),
    String(t.errors).padStart(6),
  ];
  if (cost !== null) cells.push(`$${cost.toFixed(4)}`.padStart(10));
  const stale = t.stale ? `  (${t.stale} stale reservation${t.stale === 1 ? "" : "s"} counted at the estimate)` : "";
  return cells.join("  ") + stale;
}

/** The lines `brain usage` prints. */
export function formatUsage(
  rows: UsageRow[],
  opts: { days: number; tokensToday: number; cap: number; prices: UsagePrices },
): string[] {
  const priced = opts.prices.embed > 0 || opts.prices.rerank > 0;
  const out: string[] = [];
  if (rows.length === 0) {
    out.push(`No Voyage calls in the last ${opts.days} UTC day${opts.days === 1 ? "" : "s"}.`);
  } else {
    const header = ["UTC day".padEnd(10), "operation".padEnd(14), "requests".padStart(8), "tokens".padStart(13), "refused".padStart(7), "errors".padStart(6)];
    if (priced) header.push("est. cost".padStart(10));
    out.push(header.join("  "));
    for (const day of [...new Set(rows.map((r) => r.day))]) {
      const dayRows = rows.filter((r) => r.day === day);
      const total: Totals = { requests: 0, tokens: 0, refused: 0, errors: 0, stale: 0 };
      let dayCost = 0;
      for (const r of dayRows) {
        const cost = costOf(r.operation, r.tokens, opts.prices);
        dayCost += cost;
        out.push(line(day, r.operation, r, priced ? cost : null));
        total.requests += r.requests;
        total.tokens += r.tokens;
        total.refused += r.refused;
        total.errors += r.errors;
        total.stale += r.stale;
      }
      if (dayRows.length > 1) out.push(line(day, "all", total, priced ? dayCost : null));
    }
  }
  if (!priced) out.push("Set BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED and BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK in .env to see an estimated cost.");
  out.push(`${voyageTodayLine(opts.tokensToday, opts.cap)}; the count resets at 00:00 UTC.`);
  return out;
}
```

- [ ] **Step 6: Add the spend to `brain_orient`**

Replace `src/retrieve/orient.ts` with:
```ts
import type { Ctx } from "../ctx.js";
import { config } from "../config.js";
import { stageCounts } from "../ingest/pipeline.js";
import { tokensToday } from "../llm/ledger.js";

export interface Orientation {
  totalDocuments: number;
  documentsByKind: { kind: string; count: number }[];
  nodesByType: { type: string; count: number }[];
  recent: { id: string; title: string | null; sourceKind: string; occurredAt: Date | null; ingestedAt: Date }[];
  facts: { id: string; predicate: string; objectText: string; verified: boolean }[];
  pipeline: { stage: string; count: number; failed: number }[];
  /** Tokens counted against today's (UTC) Voyage cap in this database, and the cap. */
  voyage: { tokensToday: number; cap: number };
}

export async function orient(ctx: Ctx): Promise<Orientation> {
  const { sql } = ctx;
  const [kinds, types, recent, facts, pipeline, voyageTokens] = await Promise.all([
    sql<{ kind: string; count: string }[]>`select source_kind as kind, count(*)::text as count from brain.documents group by source_kind order by count desc`,
    sql<{ type: string; count: string }[]>`select type, count(*)::text as count from brain.nodes where merged_into is null group by type order by count desc`,
    sql<Orientation["recent"]>`
      select id, title, source_kind as "sourceKind", occurred_at as "occurredAt", ingested_at as "ingestedAt"
      from brain.documents order by ingested_at desc limit 10`,
    sql<{ id: string; predicate: string; object_text: string; verified: boolean }[]>`
      select * from (
        select distinct on (predicate, lower(object_text)) id, predicate, object_text, verified
        from brain.current_facts(null)
        order by predicate, lower(object_text), verified desc, created_at
      ) d order by verified desc, predicate limit 50`,
    stageCounts(ctx),
    tokensToday(sql),
  ]);
  return {
    totalDocuments: kinds.reduce((s, k) => s + Number(k.count), 0),
    documentsByKind: kinds.map((k) => ({ kind: k.kind, count: Number(k.count) })),
    nodesByType: types.map((t) => ({ type: t.type, count: Number(t.count) })),
    recent,
    facts: facts.map((f) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text, verified: f.verified })),
    pipeline,
    voyage: { tokensToday: voyageTokens, cap: config.voyageDailyTokenCap },
  };
}
```

In `src/mcp/render.ts`, add the import:
```ts
import { voyageTodayLine } from "../llm/usage.js";
```
and in `renderOrient`, after the `` `Pipeline: …` `` line, add:
```ts
    voyageTodayLine(o.voyage.tokensToday, o.voyage.cap),
```

- [ ] **Step 7: Add `brain usage` to the CLI**

In `src/cli.ts`, insert before `const evalCmd = program.command("eval")…`:
```ts
program
  .command("usage")
  .description("Voyage tokens per UTC day and operation, refused calls, errors, and the estimated cost")
  .option("--days <n>", "UTC days to show, today included", "30")
  .action(async (opts) => {
    const days = Number(opts.days);
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error(`--days needs a whole number from 1 to 366, got ${JSON.stringify(opts.days)}`);
    const { usageByDay, formatUsage } = await import("./llm/usage.js");
    const { tokensToday } = await import("./llm/ledger.js");
    await withCtx(async (ctx) => {
      const lines = formatUsage(await usageByDay(ctx.sql, days), {
        days,
        tokensToday: await tokensToday(ctx.sql),
        cap: config.voyageDailyTokenCap,
        prices: { embed: config.voyagePricePerMTokEmbed, rerank: config.voyagePricePerMTokRerank },
      });
      for (const l of lines) console.log(l);
    });
  });
```

- [ ] **Step 8: `.env.example` and the README**

In `.env.example`, after the `VOYAGE_RERANK_MODEL=rerank-2.5` line add:
```
# Hard cap on Voyage tokens per UTC day, counted in this database's brain.provider_usage. A request that would pass it
# is refused before it is sent. 0 blocks every call. There is no off switch. Default 5000000.
BRAIN_VOYAGE_DAILY_TOKEN_CAP=5000000
# US dollars per million tokens, copied from Voyage's pricing page, for the estimated cost in `brain usage`. 0 prints tokens only.
BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED=0
BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK=0
```

In `README.md`, replace the whole `### Voyage rate limit` section (heading and paragraph) with:
```markdown
### Voyage spending cap

Every Voyage request (passage and summary embeddings, entity-name embeddings during resolve, query embeddings, reranking) is recorded in `brain.provider_usage` and counted against a hard daily cap: `BRAIN_VOYAGE_DAILY_TOKEN_CAP` tokens per UTC day, default 5,000,000. Before each request the client reserves its estimated tokens (characters / 4) under a database lock and refuses the request without sending it when today's total plus the estimate would pass the cap; after the response it records Voyage's own `usage.total_tokens`. A failed request is recorded at 0 tokens; a retry is a request of its own. `0` blocks every call. **There is no setting that turns the cap off**, and a value that is not a whole number stops the program at startup, so a typo can never lift it.

When the cap is reached:
- Ingestion stores, chunks and summarizes as usual and stops before embedding (or before resolving); `brain status` shows `spend_cap: …` on those jobs, and no retry attempt is used up. After the first refusal the rest of a batch stops before its Voyage stages without asking again. `brain retry` (or the next `brain_ingest`, which resumes stalled jobs) finishes them after 00:00 UTC, or at once after raising the cap.
- Search returns keyword-only results and says "Voyage daily cap reached; keyword-only results" (or "…; results in fused order" when only the rerank was refused).

`npm run brain -- usage [--days 30]` prints requests, tokens, refused calls and errors per UTC day and operation, today's tokens against the cap, and an estimated cost once `BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED` and `BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK` are set from Voyage's pricing page (default 0: tokens only). `brain_orient` shows today's tokens against the cap.

The ledger lives in each database: the real knowledge base and `brain_eval` each count and cap their own calls, while Voyage bills the account, so the account's daily spend can reach the sum of both caps. Running processes read the cap when they start: restart the MCP server after changing it. A request in flight when its process dies stays counted at its estimate for the rest of the day.

Search waits at most 10 seconds in total for Voyage retries (3 attempts) and then falls back; ingestion waits out rate limits (up to 6 attempts, at most 60 s per wait).
```
In the `## Commands` block, after the `retry` line add:
```
npm run brain -- usage [--days 30]
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run test/unit/usage.test.ts test/unit/config.test.ts test/unit/render.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/usage.test.ts test/integration/mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 10: Full suites, typecheck, and the command on the eval database**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green.

Run (against `brain_eval`, never the real base):
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval npm run brain -- usage --days 2
```
Expected: today's `embed_query` and `rerank` lines from Task 4's eval run (client `eval`), the price hint, and `Voyage today: <n> of 5,000,000 tokens (<pct>%); the count resets at 00:00 UTC.` (or the cap set in `.env`). No eval run: ranking is unchanged.

- [ ] **Step 11: Commit**

```bash
git add src/llm/usage.ts src/config.ts src/retrieve/orient.ts src/mcp/render.ts src/cli.ts .env.example README.md test/unit/usage.test.ts test/integration/usage.test.ts test/unit/config.test.ts test/unit/render.test.ts test/integration/mcp-server.test.ts
git commit -m "brain usage and the brain_orient Voyage line; price settings; README documents the cap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The eval prints the Voyage tokens it used

**Files:**
- Modify: `src/llm/usage.ts` (`voyageSpendSince`)
- Modify: `src/eval/run.ts`
- Modify: `src/cli.ts` (`eval run` output)
- Modify: `README.md`
- Modify: `test/integration/usage.test.ts`
- Modify: `test/unit/eval.test.ts`

`runEval` reads the database clock when it starts and, at the end, sums `brain_eval`'s ledger rows from that moment with client `eval` (the label `makeEvalCtx` gives its clients in Task 2). The result goes on `EvalRun.voyage` and into one output line; it is not added to `Report`, so `eval/baseline.json` and the gate are unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/integration/usage.test.ts`, change the usage import to:
```ts
import { usageByDay, formatUsage, voyageSpendSince } from "../../src/llm/usage.js";
```
and append:
```ts
describe("voyageSpendSince", () => {
  it("sums one client's requests, tokens and refusals from a moment on", async () => {
    await seed("embed_query", "ok", 5, 7, "2 hours", "eval"); // before the run
    const [{ t }] = await sql<{ t: Date }[]>`select clock_timestamp() - interval '1 hour' as t`;
    await seed("embed_query", "ok", 5, 6, "0 seconds", "eval");
    await seed("rerank", "ok", 100, 90, "0 seconds", "eval");
    await seed("rerank", "refused", 100, 0, "0 seconds", "eval");
    await seed("rerank", "ok", 100, 500, "0 seconds", "cli"); // another client
    expect(await voyageSpendSince(sql, t, "eval")).toEqual({ requests: 2, tokens: 96, refused: 1 });
  });

  it("is all zeros when nothing was spent", async () => {
    expect(await voyageSpendSince(sql, new Date(), "eval")).toEqual({ requests: 0, tokens: 0, refused: 0 });
  });
});
```

In `test/unit/eval.test.ts`, add `evalVoyageLine` to the import from `../../src/eval/run.js`, and append:
```ts
describe("evalVoyageLine", () => {
  it("prints the run's Voyage spend, and warns when the cap refused calls", () => {
    expect(evalVoyageLine({ requests: 30, tokens: 41_200, refused: 0 })).toBe("voyage  tokens=41200 requests=30 refused=0");
    expect(evalVoyageLine({ requests: 3, tokens: 90, refused: 2 })).toBe(
      "voyage  tokens=90 requests=3 refused=2  (brain_eval's daily cap refused calls; those searches ran degraded)",
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/eval.test.ts`
Expected: FAIL: `evalVoyageLine is not a function`.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/usage.test.ts`
Expected: FAIL: `voyageSpendSince is not a function`.

- [ ] **Step 3: Add `voyageSpendSince` to `src/llm/usage.ts`**

Append:
```ts
export interface VoyageSpend {
  requests: number;
  /** Counted the way the cap counts (see UsageRow.tokens). */
  tokens: number;
  refused: number;
}

/** One client's Voyage spend in this database's ledger from `since` on (the eval's spend per run). */
export async function voyageSpendSince(sql: Db, since: Date, client: string): Promise<VoyageSpend> {
  const [row] = await sql<VoyageSpend[]>`
    select coalesce(sum(requests), 0)::int as requests,
           coalesce(sum(case status when 'ok' then tokens when 'reserved' then estimated_tokens else 0 end), 0)::float8 as tokens,
           (count(*) filter (where status = 'refused'))::int as refused
    from brain.provider_usage
    where provider = 'voyage' and client = ${client} and created_at >= ${since}`;
  return row;
}
```

- [ ] **Step 4: Record it in `src/eval/run.ts`**

Change the imports:
```ts
import { assertEvalConnection } from "./db.js";
```
to:
```ts
import { assertEvalConnection, EVAL_CLIENT } from "./db.js";
import { voyageSpendSince, type VoyageSpend } from "../llm/usage.js";
```
In `EvalRun`, after `attribution: AttributionLeaks;` add:
```ts
  /** Voyage spend of this run (searches and anything else under the eval client) in brain_eval's ledger. Kept out of Report. */
  voyage: VoyageSpend;
```
In `runEval`, replace:
```ts
  await assertEvalConnection(ctx.sql);
  const golden = parseGolden(await readFile(goldenPath, "utf8"));
```
with:
```ts
  await assertEvalConnection(ctx.sql);
  // The database's clock, so the window matches the ledger's created_at exactly.
  const [{ startedAt }] = await ctx.sql<{ startedAt: Date }[]>`select clock_timestamp() as "startedAt"`;
  const golden = parseGolden(await readFile(goldenPath, "utf8"));
```
and replace its return:
```ts
  return { results, report: summarize(results, config.retrieval.fallbackThreshold), ranks, attribution: await attributionLeaks(ctx.sql) };
```
with:
```ts
  return {
    results,
    report: summarize(results, config.retrieval.fallbackThreshold),
    ranks,
    attribution: await attributionLeaks(ctx.sql),
    voyage: await voyageSpendSince(ctx.sql, startedAt, EVAL_CLIENT),
  };
```
Add after `attributionGate`:
```ts
/** The eval output line for the run's Voyage spend. */
export function evalVoyageLine(v: VoyageSpend): string {
  const base = `voyage  tokens=${v.tokens} requests=${v.requests} refused=${v.refused}`;
  return v.refused ? `${base}  (brain_eval's daily cap refused calls; those searches ran degraded)` : base;
}
```

- [ ] **Step 5: Print it in `eval run`**

In `src/cli.ts`, in the `eval run` action, change:
```ts
    const { runEval, attributionGate } = await import("./eval/run.js");
```
to:
```ts
    const { runEval, attributionGate, evalVoyageLine } = await import("./eval/run.js");
```
and after the line that prints `attribution  self-facts-from-others=…` add:
```ts
        console.log(evalVoyageLine(run.voyage));
```
(`--json` already includes `voyage` through `...run`.)

In `README.md`, in the `## Tests` bullet about the retrieval eval, after the sentence that ends `` `npm run eval:gate` exits 1 on a regression (…). `` add:
```markdown
Each run also prints `voyage tokens=… requests=… refused=…`: the Voyage tokens that run used, from `brain_eval`'s own ledger and cap (not part of the baseline).
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/unit/eval.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/usage.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suites, typecheck, eval**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green.

Run: `npm run eval:run`
Expected: ranks and metrics as in Task 4 (no regressions, `degraded=0%`), and a new line `voyage  tokens=<n> requests=<m> refused=0` with `n > 0` and `m` equal to two requests (query embedding and rerank) per search, main questions and paraphrases together. Compare `m` with `select count(*) from brain.provider_usage where client = 'eval' and created_at > now() - interval '10 minutes'` on `brain_eval` if in doubt.

- [ ] **Step 8: Commit**

```bash
git add src/llm/usage.ts src/eval/run.ts src/cli.ts README.md test/integration/usage.test.ts test/unit/eval.test.ts
git commit -m "Eval prints the Voyage tokens each run used, from brain_eval's ledger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Turn the guard on in the real knowledge base (run by the controller, not a subagent)

**Files:** none changed in the repo. Output goes into the PR description.

This is the only step that touches the `postgres` database. Run each command yourself and read its output before the next. Never use `supabase migration up`. Stop and ask the owner if anything below does not match what is expected.

Order matters: until migration 010 is applied, the new code cannot reserve (the table does not exist), so every Voyage call fails closed and searches degrade. Until every running process is restarted, old processes keep calling Voyage **unmetered**. Apply first, then restart, then verify.

- [ ] **Step 1: Back up the brain schema**

Run:
```bash
ts=$(date +%Y%m%d-%H%M%S)
docker exec supabase_db_brain pg_dump -U postgres -d postgres -n brain -Fc > ~/brain-pre-010-$ts.dump
ls -l ~/brain-pre-010-$ts.dump
docker exec -i supabase_db_brain pg_restore --list < ~/brain-pre-010-$ts.dump | grep -c "TABLE DATA brain"
```
Expected: a dump file of non-trivial size; the table-data count equals the number of tables in `brain` (13 before this migration). Note the file name for the PR.

- [ ] **Step 2: Check the settings the processes will read**

Run:
```bash
grep -E '^(VOYAGE_API_KEY|BRAIN_VOYAGE_)' .env | sed -E 's/(VOYAGE_API_KEY=).+/\1<set>/'
```
Expected: `VOYAGE_API_KEY=<set>`. `BRAIN_VOYAGE_DAILY_TOKEN_CAP` either absent (default 5,000,000) or a whole number the owner chose. If it is absent, tell the owner the default applies and that they can add the price variables from `.env.example`. Do not edit `.env` yourself.

- [ ] **Step 3: Apply migration 010**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20261002000010_provider_usage.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select brain.provider_tokens_today('voyage'), (select relrowsecurity from pg_class where oid = 'brain.provider_usage'::regclass) as rls"
```
Expected: `BEGIN`, `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, `CREATE FUNCTION`, `COMMIT`; then `0 | t`.

- [ ] **Step 4: Restart every running brain process**

Run:
```bash
pgrep -fl "src/mcp/(stdio|http-main)\.ts|src/cli\.ts" || echo "no brain processes running"
```
For each listed process: an MCP HTTP server (`npm run mcp:http`) is restarted; an MCP stdio server belongs to a Claude Code session and is restarted by restarting that session (or by `/mcp` reconnect). A long-running CLI command (`project-obsidian --watch`, `backfill`) is stopped and started again. Re-run the `pgrep` and confirm every remaining process started after Step 3 (`ps -o lstart= -p <pid>`). Until then those processes call Voyage without the ledger.

- [ ] **Step 5: `brain usage` before any call**

Run: `npm run brain -- usage`
Expected:
```
No Voyage calls in the last 30 UTC days.
Set BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED and BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK in .env to see an estimated cost.
Voyage today: 0 of 5,000,000 tokens (0.0%); the count resets at 00:00 UTC.
```
(the cap from Step 2 in place of 5,000,000; no price hint if the owner set prices).

- [ ] **Step 6: One search, and its ledger rows**

Run:
```bash
npm run brain -- search "what am I working on" -k 3
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select operation, model, status, requests, estimated_tokens, tokens, client, finished_at - created_at as took
from brain.provider_usage order by id"
npm run brain -- usage --days 1
```
Expected: the search prints `mode: hybrid (vector and keyword, reranked)` and three passages. The ledger has exactly two rows, `embed_query | voyage-4-large | ok` and `rerank | rerank-2.5 | ok`, both `requests 1`, client `cli`, `tokens > 0` (Voyage's own count; usually close to the estimate), `took` well under a second. `brain usage --days 1` lists both operations, an `all` line, and `Voyage today: <sum> of <cap> tokens`. If the search printed any other mode, or a row is `error` or `refused`, stop and show the owner.

- [ ] **Step 7: `brain_orient` shows the line**

From a Claude Code session restarted in Step 4, call `brain_orient` (or run `npm run brain -- status` and the psql query again if no session is open).
Expected: the orient text contains `Voyage today: <sum> of <cap> tokens (<pct>%)`, with the sum from Step 6.

- [ ] **Step 8: PR description**

Paste into the PR: the backup file name, the cap in effect, the output of Steps 5 and 6, and the orient line from Step 7.

---

## Self-review notes

- Spec §5.1 (ledger): Task 1 (table, `provider_tokens_today`, reservation and settlement), Task 2 (every embeddings and rerank attempt records `usage.total_tokens`, failures at `tokens = 0` with the error, client labels from `makeCtx`).
- Spec §5.2 (cap and behaviour): Task 1 (`BRAIN_VOYAGE_DAILY_TOKEN_CAP`, `SpendCapError`, the locked check), Task 2 (estimate = characters / 4 before every request), Task 3 (ingestion), Task 4 (search).
- Spec §5.3 (visibility, query budget): Task 6 (`brain usage`, `brain_orient`, prices, `.env.example`, README), Task 5 (3 attempts, 10 s total).
- Decision 9 (eval): Task 2 (`makeEvalCtx` meters on `brain_eval` as client `eval`), Task 7 (spend line). Decision 10: Task 8.

Places where the real code forced a decision that differs from, or adds to, the brief:
- **A document stopped by the cap stays at `summarized`, not `chunked`.** The spec says "stage = chunked", but `STAGES` runs summarize before embed, and `advance` leaves a document at the last stage it completed. A cap refusal in resolve leaves it at `extracted`. `brain retry` handles both.
- **A cap refusal does not count an attempt.** `advance` increments `ingest_jobs.attempts` on every failure and `JobManager.resumeStalled` only resumes jobs with `attempts < 5`; five capped days would otherwise strand a document permanently. `set-author`'s own catch (which also re-queues before resolve) follows the same rule.
- **Batches stop asking with `voyageBlocked`, they do not break out of the loop.** After the first `spendCap` result, later documents still run chunk and summarize (neither calls Voyage), so new material is stored and keyword-searchable, and they stop before `embedded`/`resolved` with `DEFERRED_MESSAGE` without writing a `refused` row. `JobManager` keeps the flag for the rest of the UTC day; a restart clears it. Up to `BACKGROUND_SLOTS` (2) documents already running when the first refusal lands may each be refused once.
- **A rerank refused by the cap is `degradedReason: "rerank"` with `capReached: true`, and prints "Voyage daily cap reached; results in fused order".** The brief's message for the cap says "keyword-only", which is false when the query embedding was admitted and only the rerank (tens of thousands of tokens for 60 candidates, against a few for the query) was refused: those results used vectors. `degradedReason: "cap"` therefore means "the query embedding was refused"; four notes instead of three.
- **The client refuses to exist unmetered.** The brief makes `ledger` optional. A forgotten ledger would silently bypass the cap, so the constructor throws unless a ledger is given or `fetchFn` is injected (tests only). `makeCtx` is the only production constructor; `test/unit/ctx.test.ts` asserts all four clients carry the context's own database.
- **Fail closed on ledger errors.** A reservation that cannot be written means the request is not sent. A settle that fails leaves the row `reserved`, counting at its estimate.
- **`brain.provider_tokens_today(provider)` is added to the migration** so the reservation and `brain_orient` share one definition of "counted today". `requests` is 1 on sent attempts and 0 on refusals; `tokens` is null only while reserved; `model` and `client` are `not null`.
- **No injected clock.** The roadmap's task 2 test used "an injected clock and seeded usage rows". The UTC day is the database's `now()`, the one clock every process shares; tests seed `created_at` relative to `now()`. Tests that need the ledger are integration tests on `brain_test`, since unit tests may not touch a database.
- **`SET TRANSACTION ISOLATION LEVEL READ COMMITTED` is explicit** in the reservation: the correctness argument needs each statement's snapshot to be taken after the lock, which REPEATABLE READ would break.
- **Query budget: a wait that would pass 10 s gives up at once** instead of sleeping the remainder. `Retry-After: 30` cannot be met in 10 s, so the search falls back immediately.
- **The API key is read before reserving**, so a missing key leaves no stray `reserved` row (it would count until midnight).
- **Not in the brief, added because the code needed it:** the `cap_reached` layer in `retrieval_log.layers`; `MakeCtxOptions.client` with labels `cli`, `mcp-stdio`, `mcp-http`, `eval`; `EVAL_CLIENT` so `runEval` filters the eval's own rows; `SPEND_CAP_ADVICE` printed by `ingest`, `retry` and `backfill`.
- **Migration name** is `20261002000010_provider_usage.sql` as decided (the roadmap said `20260930000010`).
- **`brain usage` defaults to `--days 30`** (the spec's example).

How hard the cap is, stated plainly for the owner:
- At every admission, settled actual tokens plus the estimates of calls in flight are within the cap, across connections and processes on the same database (the race tests in Tasks 1 and 2 show N parallel reservations admitting exactly the number that fit).
- The day's final total can pass the cap only by how much the actual counts of calls in flight at that moment exceed their characters / 4 estimates: at most four concurrent Voyage requests per process (three pipelines, one search), so a few thousand tokens against 5,000,000.
- A network error after Voyage has processed a request is recorded at 0 tokens (Voyage's count is unknown). Voyage does not bill 429s or 5xx responses.
- Each database has its own ledger and cap. The real base and `brain_eval` together can spend up to twice the cap per day on one Voyage account; `brain_test` never reaches Voyage.

Types and names used across tasks: `VoyageLedger`, `MeteredCall`, `Settlement`, `reserveTokens`, `settleReservation`, `tokensToday`, `STALE_RESERVATION_MINUTES` (T1) are used by `VoyageClient` (T2), `orient` (T6) and `usage.ts` (T6). `SpendCapError`/`isSpendCap`/`SPEND_CAP_PREFIX` (T1) are used by T3 and T4. `estimateEmbedTokens`, `estimateRerankTokens`, `VoyageClient.ledger` (T2) are used by the helpers and tests of T3 and T4; `fakeVoyageFetch`/`meteredVoyage` (T2) by T3 and T4. `RunOptions.voyageBlocked`, `PipelineResult.spendCap`, `DEFERRED_MESSAGE`, `SPEND_CAP_ADVICE` (T3) are used by `batch.ts`, `jobs.ts`, `backfill.ts` and `cli.ts`. `DegradedReason`, `SearchResult.degradedReason`/`capReached` (T4) are required fields, so `test/unit/render.test.ts` and `test/unit/eval.test.ts` literals are updated in T4. `QUERY_RETRY_BUDGET`, `VoyageClient.retryBudget` (T5). `UsageRow`, `formatUsage`, `voyageTodayLine` (T6); `Orientation.voyage` (T6) is required, so the `renderOrient` test literal is updated in T6. `voyageSpendSince`, `VoyageSpend`, `EvalRun.voyage`, `evalVoyageLine` (T7); `EVAL_CLIENT` (T2) is read by T7.

Known limits, not addressed here:
- `runResolve` undoes a document's previous resolution before it embeds entity names. A cap refusal in resolve (or in `set-author`) therefore leaves that document without graph rows until `brain retry` resolves it again; its text and vectors stay searchable.
- `runEmbed` embeds in batches of 128 and writes vectors at the end; if the cap refuses a later batch, the earlier batches' tokens are spent and are spent again on retry. Documents here are short (one batch), so this is rare.
- Each search reranks up to 60 candidates, tens of thousands of tokens; at the default cap that is a few hundred searches a day alongside ingestion. The owner can watch this in `brain usage` and adjust the cap.
- The cap and prices are read at process start; a long-running MCP server needs a restart to pick up a change.
- `brain status` and `brain_status` show `spend_cap: …` errors as failures in their per-stage counts; they are not separated from real failures there.
