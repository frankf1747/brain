import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { usageByDay, formatUsage, voyageSpendSince } from "../../src/llm/usage.js";
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
