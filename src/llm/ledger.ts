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
 * tokens plus in-flight estimates stay within the cap.
 *
 * How far past the cap a day can go: settled calls count their real tokens (Voyage's usage.total_tokens), so the
 * only overshoot comes from calls in flight when the cap is reached, which were admitted at their characters / 4
 * estimate. On measured data that estimate was within about 4% for English; for non-English or code-heavy text it
 * can undercount 2-4x. The worst case is therefore roughly (concurrent callers) x (largest batch estimate) x
 * (estimate error): tens of thousands of tokens for English, more for other text. It is bounded by what is in
 * flight at one moment and never grows over the day, because every later reservation sees the settled totals.
 * Requests time out (8 s for query clients, 120 s for ingest, src/llm/voyage.ts); a timed-out or dropped request
 * (fetch threw) settles at null tokens and keeps counting at its estimate, since Voyage may have billed it. A row
 * left `reserved` by a dead process counts at its estimate too.
 *
 * The ledger is per database: the real knowledge base and brain_eval each count and cap their own calls
 * (BRAIN_VOYAGE_DAILY_TOKEN_CAP and BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP). Voyage bills per account, so the account's
 * daily ceiling is the sum of the caps of every database using the key.
 */

export type VoyageOperation = "embed_document" | "embed_query" | "rerank";

export interface VoyageLedger {
  /** The database whose brain.provider_usage records and caps the calls. */
  sql: Db;
  /** Who is spending (cli, mcp-stdio, mcp-http, eval, test); stored on every row. */
  client: string;
  /** Tokens per UTC day; defaults to config.voyageDailyTokenCap. makeEvalCtx sets config.evalVoyageDailyTokenCap; tests set their own. */
  dailyTokenCap?: number;
}

export interface MeteredCall {
  operation: VoyageOperation;
  model: string;
  /** Characters / 4 (src/llm/voyage.ts); at least 1 is reserved. */
  estimatedTokens: number;
}

/**
 * How a reservation ends: Voyage's token count (null: none reported, keep the estimate), or an error. An error is
 * stored at 0 tokens (an HTTP error status: Voyage does not bill it), or with `maybeBilled` at null tokens, which
 * brain.provider_tokens_today counts at the estimate (fetch threw: a timeout or a dropped connection may come after
 * Voyage processed and billed the request).
 */
export type Settlement = { tokens: number | null; error?: string } | { error: string; maybeBilled?: boolean };

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
      set status = 'error', tokens = ${outcome.maybeBilled ? null : 0}::int, error = ${outcome.error.slice(0, 1000)}, finished_at = now()
      where id = ${id}::bigint and status = 'reserved'`;
  }
}
