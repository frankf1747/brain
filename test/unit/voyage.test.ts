import { describe, it, expect } from "vitest";
import { VoyageClient, FakeEmbedder, FakeReranker, hashVector } from "../../src/llm/voyage.js";

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
    const client = new VoyageClient({ apiKey: "k", fetchFn: fn, retryDelayMs: 1 });
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
