import { describe, it, expect, vi } from "vitest";
import { VoyageClient, FakeEmbedder, FakeReranker, hashVector, estimateEmbedTokens, estimateRerankTokens, usageTokens, QUERY_RETRY_BUDGET, QUERY_REQUEST_TIMEOUT_MS } from "../../src/llm/voyage.js";

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("VoyageClient", () => {
  it("sends input_type and dimension and restores input order", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] } },
    ]);
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn });
    const out = await client.embed(["a", "b"], "document");
    expect(out).toEqual([[1], [2]]);
    expect(calls[0].body.input_type).toBe("document");
    expect(calls[0].body.output_dimension).toBe(1024);
  });

  it("batches large inputs", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] } },
      { status: 200, body: { data: [{ index: 0, embedding: [3] }] } },
    ]);
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, batchSize: 2 });
    expect(await client.embed(["a", "b", "c"], "document")).toEqual([[1], [2], [3]]);
    expect(calls.length).toBe(2);
  });

  it("retries a 429 then succeeds, and throws on 400", async () => {
    const ok = { data: [{ index: 0, embedding: [1] }] };
    const { fn } = fakeFetch([{ status: 429, body: {} }, { status: 200, body: ok }]);
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, retryDelayMs: 1, rateLimitDelayMs: 1 });
    expect(await client.embed(["a"], "query")).toEqual([[1]]);
    const bad = fakeFetch([{ status: 400, body: { detail: "nope" } }]);
    await expect(new VoyageClient({ apiKey: "k", fetchFn: bad.fn }).embed(["a"], "query")).rejects.toThrow(/400/);
  });

  it("maps rerank results to index and score", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { data: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] } },
    ]);
    const hits = await new VoyageClient({ apiKey: "k", fetchFn: fn }).rerank("q", ["a", "b", "c"], 2);
    expect(hits).toEqual([{ index: 2, score: 0.9 }, { index: 0, score: 0.2 }]);
    expect(calls[0].body.top_k).toBe(2);
  });
});

describe("VoyageClient network errors and clamping", () => {
  it("retries a thrown network error then succeeds", async () => {
    let n = 0;
    const fn = (async () => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await new VoyageClient({ apiKey: "k", fetchFn: fn, retryDelayMs: 1 }).embed(["a"], "query")).toEqual([[1]]);
    expect(n).toBe(2);
  });

  it("gives up after 4 attempts when fetch always throws", async () => {
    let n = 0;
    const fn = (async () => {
      n++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new VoyageClient({ apiKey: "k", fetchFn: fn, retryDelayMs: 1 }).embed(["a"], "query")).rejects.toThrow(/fetch failed/);
    expect(n).toBe(4);
  });

  it("clamps top_k to the number of documents", async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { data: [{ index: 0, relevance_score: 0.5 }] } }]);
    await new VoyageClient({ apiKey: "k", fetchFn: fn }).rerank("q", ["a", "b"], 10);
    expect(calls[0].body.top_k).toBe(2);
  });
});

describe("VoyageClient rate limits", () => {
  const ok = { data: [{ index: 0, embedding: [1] }] };

  function seqFetch(responses: Array<{ status: number; headers?: Record<string, string> }>) {
    let n = 0;
    const fn = (async () => {
      const r = responses[Math.min(n, responses.length - 1)];
      n++;
      return new Response(JSON.stringify(r.status === 200 ? ok : { detail: "rate limited" }), {
        status: r.status,
        headers: r.headers,
      });
    }) as unknown as typeof fetch;
    return { fn, count: () => n };
  }

  function recorder() {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  }

  it("honors a Retry-After header in seconds", async () => {
    const { fn } = seqFetch([{ status: 429, headers: { "retry-after": "2" } }, { status: 200 }]);
    const { waits, sleep } = recorder();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write");
    try {
      const client = new VoyageClient({ apiKey: "k", fetchFn: fn, sleep });
      expect(await client.embed(["a"], "query")).toEqual([[1]]);
      expect(waits).toEqual([2000]);
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("brain: Voyage rate limited, waiting 2s");
      expect(out.mock.calls.map((c) => String(c[0])).join("")).not.toContain("rate limited");
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it("honors a Retry-After header given as an HTTP date", async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const { fn } = seqFetch([{ status: 429, headers: { "retry-after": at } }, { status: 200 }]);
    const { waits, sleep } = recorder();
    await new VoyageClient({ apiKey: "k", fetchFn: fn, sleep }).embed(["a"], "query");
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(2000);
    expect(waits[0]).toBeLessThanOrEqual(5000);
  });

  it("without Retry-After, doubles rateLimitDelayMs and caps each wait at 60s", async () => {
    const { fn } = seqFetch([
      { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 200 },
    ]);
    const { waits, sleep } = recorder();
    await new VoyageClient({ apiKey: "k", fetchFn: fn, sleep }).embed(["a"], "query");
    expect(waits).toEqual([20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it("gives up after 6 attempts of 429", async () => {
    const { fn, count } = seqFetch([{ status: 429 }]);
    const { sleep } = recorder();
    await expect(
      new VoyageClient({ apiKey: "k", fetchFn: fn, sleep, rateLimitDelayMs: 1 }).embed(["a"], "query"),
    ).rejects.toThrow(/429/);
    expect(count()).toBe(6);
  });

  it("does not retry a 400", async () => {
    const { fn, count } = seqFetch([{ status: 400 }]);
    const { waits, sleep } = recorder();
    await expect(new VoyageClient({ apiKey: "k", fetchFn: fn, sleep }).embed(["a"], "query")).rejects.toThrow(/400/);
    expect(count()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("keeps 4 attempts and retryDelayMs backoff for 5xx", async () => {
    const { fn, count } = seqFetch([{ status: 503 }]);
    const { waits, sleep } = recorder();
    await expect(
      new VoyageClient({ apiKey: "k", fetchFn: fn, sleep, retryDelayMs: 10 }).embed(["a"], "query"),
    ).rejects.toThrow(/503/);
    expect(count()).toBe(4);
    expect(waits).toEqual([10, 20, 40]);
  });
});

describe("VoyageClient attempt budgets", () => {
  it("with maxRateLimitAttempts 1, makes one call on a 429 and rejects without waiting", async () => {
    let n = 0;
    const fn = (async () => {
      n++;
      return new Response(JSON.stringify({ detail: "rate limited" }), { status: 429, headers: { "retry-after": "30" } });
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => {});
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, sleep, maxRateLimitAttempts: 1 });
    await expect(client.embed(["a"], "query")).rejects.toThrow(/429/);
    expect(n).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("with maxAttempts 2, gives up on 5xx and network errors after two calls", async () => {
    let n = 0;
    const fn = (async () => {
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    const sleep = vi.fn(async (_ms: number) => {});
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, sleep, retryDelayMs: 1, maxAttempts: 2 });
    await expect(client.rerank("q", ["a"], 1)).rejects.toThrow(/503/);
    expect(n).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("fakes", () => {
  it("hashVector is deterministic, unit length, and case/punctuation insensitive", () => {
    const a = hashVector("Acme, Inc.");
    expect(hashVector("acme inc")).toEqual(a);
    expect(Math.abs(Math.hypot(...a) - 1)).toBeLessThan(1e-6);
    expect(hashVector("Other")).not.toEqual(a);
  });
  it("FakeEmbedder records calls; FakeReranker scores by word overlap", async () => {
    const e = new FakeEmbedder();
    await e.embed(["x"], "document");
    expect(e.calls).toEqual([["x"]]);
    const hits = await new FakeReranker().rerank("red apple", ["green pear", "red apple pie"], 1);
    expect(hits[0].index).toBe(1);
  });
});

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
    expect(QUERY_RETRY_BUDGET).toEqual({ maxAttempts: 3, maxRateLimitAttempts: 3, maxTotalAttempts: 3, retryDelayMs: 500, rateLimitDelayMs: 2000, maxTotalWaitMs: 10_000 });
  });

  it("sends at most 3 HTTP requests in total when 429s and 5xx alternate", async () => {
    const err = quiet();
    try {
      const { fn, count } = seq([{ status: 503 }, { status: 429 }, { status: 503 }, { status: 429 }, { status: 503 }, { status: 200 }]);
      const { c } = client(fn);
      await expect(c.embed(["a"], "query")).rejects.toThrow(/503/);
      expect(count()).toBe(3);
    } finally {
      err.mockRestore();
    }
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
    expect(new VoyageClient({ ...QUERY_RETRY_BUDGET, apiKey: "k", fetchFn: fn }).retryBudget).toEqual({ maxAttempts: 3, maxRateLimitAttempts: 3, maxTotalAttempts: 3, maxTotalWaitMs: 10_000 });
    expect(new VoyageClient({ apiKey: "k", fetchFn: fn }).retryBudget).toEqual({ maxAttempts: 4, maxRateLimitAttempts: 6, maxTotalAttempts: Infinity, maxTotalWaitMs: Infinity });
  });
});

describe("request timeout", () => {
  it("is 120 s by default (ingest) and 8 s for the query clients", () => {
    const fn = (async () => new Response("{}")) as unknown as typeof fetch;
    expect(QUERY_REQUEST_TIMEOUT_MS).toBe(8_000);
    expect(new VoyageClient({ apiKey: "k", fetchFn: fn }).requestTimeoutMs).toBe(120_000);
    expect(new VoyageClient({ apiKey: "k", fetchFn: fn, requestTimeoutMs: QUERY_REQUEST_TIMEOUT_MS }).requestTimeoutMs).toBe(8_000);
  });

  it("sends every attempt with its own abort signal", async () => {
    const signals: AbortSignal[] = [];
    let n = 0;
    const fn = (async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return ++n === 1
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await new VoyageClient({ apiKey: "k", fetchFn: fn, sleep: async () => {} }).embed(["a"], "query");
    expect(signals).toHaveLength(2);
    for (const s of signals) {
      expect(s).toBeInstanceOf(AbortSignal);
      expect(s.aborted).toBe(false);
    }
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("aborts a request that outlives the timeout and retries it like a network error", async () => {
    let n = 0;
    const fn = ((_url: string, init: RequestInit) => {
      n++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, requestTimeoutMs: 20, maxAttempts: 2, retryDelayMs: 5, sleep: async (ms) => void waits.push(ms) });
    const err = await client.embed(["a"], "query").catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect(n).toBe(2);
    expect(waits).toEqual([5]);
  });
});
