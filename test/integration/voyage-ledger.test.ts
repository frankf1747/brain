import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, meteredVoyage, TEST_DATABASE_URL } from "./helpers.js";
import { VoyageClient, estimateEmbedTokens, estimateRerankTokens } from "../../src/llm/voyage.js";
import { isSpendCap } from "../../src/llm/errors.js";
import { tokensToday, reserveTokens } from "../../src/llm/ledger.js";
import { makeCtx } from "../../src/ctx.js";

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

describe("VoyageClient with a ledger when fetch throws", () => {
  it("counts a thrown fetch at its estimate: Voyage may have processed and billed it", async () => {
    let n = 0;
    const fn = (async () => {
      n++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, retryDelayMs: 1, maxAttempts: 2, ledger: ledger(1000) });
    await expect(client.embed(["abcdefgh"], "document")).rejects.toThrow(/fetch failed/);
    expect(n).toBe(2);
    expect((await rows()).map((r) => [r.status, r.estimated_tokens, r.tokens, r.error, r.finished])).toEqual([
      ["error", 2, null, "fetch failed", true],
      ["error", 2, null, "fetch failed", true],
    ]);
    expect(await tokensToday(sql)).toBe(4);
  });

  it("counts a timed-out request at its estimate, and a 5xx after it at 0", async () => {
    let n = 0;
    const fn = ((_url: string, init: RequestInit) => {
      n++;
      if (n > 1) return Promise.resolve(new Response(JSON.stringify({ detail: "busy" }), { status: 503 }));
      // Never answers; rejects with the signal's reason when the client's timeout aborts it.
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, retryDelayMs: 1, maxAttempts: 2, requestTimeoutMs: 20, ledger: ledger(1000) });
    await expect(client.rerank("q", ["abcd"], 1)).rejects.toThrow(/503/);
    const [timedOut, busy] = await rows();
    expect(timedOut).toMatchObject({ status: "error", tokens: null, estimated_tokens: estimateRerankTokens("q", ["abcd"]), finished: true });
    expect(timedOut.error).toMatch(/timeout|aborted/i);
    expect(busy).toMatchObject({ status: "error", tokens: 0 });
    expect(await tokensToday(sql)).toBe(estimateRerankTokens("q", ["abcd"]));
  });
});

describe("makeCtx's dailyTokenCap", () => {
  it("is the cap its clients' ledger enforces in the context's database", async () => {
    const ctx = makeCtx({ databaseUrl: TEST_DATABASE_URL, obsidian: false, client: "eval", dailyTokenCap: 10 });
    try {
      const metered = (ctx.queryEmbedder as VoyageClient).ledger!;
      await reserveTokens(metered, { operation: "embed_query", model: "voyage-test", estimatedTokens: 8 });
      await expect(reserveTokens(metered, { operation: "embed_query", model: "voyage-test", estimatedTokens: 3 })).rejects.toThrow(/> cap 10/);
      expect((await rows()).map((r) => [r.status, r.client])).toEqual([["reserved", "eval"], ["refused", "eval"]]);
    } finally {
      await ctx.sql.end();
    }
  });
});
