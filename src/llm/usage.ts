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
