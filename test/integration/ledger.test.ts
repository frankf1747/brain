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

  it("keeps an error that may have been billed at its estimate, and an ordinary error at 0", async () => {
    const id = await reserveTokens(ledger(1000), call(35));
    await settleReservation(sql, id, { error: "The operation was aborted due to timeout", maybeBilled: true });
    expect(await rowById(id)).toMatchObject({ status: "error", tokens: null, error: "The operation was aborted due to timeout", finished: true });
    expect(await tokensToday(sql)).toBe(35);
    await seed("error", 40, 0);
    expect(await tokensToday(sql)).toBe(35);
    // Counted against the cap like any other spend.
    await expect(reserveTokens(ledger(1000), call(966))).rejects.toThrow(/35 tokens counted today/);
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

  it("counts today's ok, reserved and error rows, stale reservations at their estimate, and nothing else", async () => {
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
