import { connect, type Db } from "../../src/db.js";
import type { Ctx } from "../../src/ctx.js";
import { FakeLlm } from "../../src/llm/llm.js";
import { FakeEmbedder, FakeReranker, VoyageClient, hashVector, estimateEmbedTokens, estimateRerankTokens } from "../../src/llm/voyage.js";

/**
 * Integration tests wipe brain tables, so they only ever run against a database whose name ends in
 * "_test" (created by scripts/prepare-test-db.sh). DATABASE_URL is deliberately ignored: it points at
 * the real knowledge base.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_test";

export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run integration tests against "${name}": the database name must end in _test`);
  }
}

export function testDb(): Db {
  assertTestDatabase(TEST_DATABASE_URL);
  return connect(TEST_DATABASE_URL);
}

/** Removes data but keeps registries and the self node. */
export async function wipe(sql: Db): Promise<void> {
  await sql`truncate brain.documents cascade`;
  await sql`delete from brain.nodes where is_self = false`;
  await sql`truncate brain.retrieval_log`;
  await sql`truncate brain.tool_calls`;
  await sql`truncate brain.provider_usage`;
}

export function fakeVector(seed: number, dims = 1024): number[] {
  const v: number[] = [];
  let x = seed * 9301 + 49297;
  for (let i = 0; i < dims; i++) {
    x = (x * 9301 + 49297) % 233280;
    v.push(x / 233280 - 0.5);
  }
  const norm = Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  return v.map((a) => a / norm);
}

export interface FakeCtx extends Ctx {
  llm: FakeLlm;
  embedder: FakeEmbedder;
}

export function fakeCtx(sql: Db, handler: (args: { system: string; user: string }) => unknown = () => ({})): FakeCtx {
  return { sql, llm: new FakeLlm(handler), embedder: new FakeEmbedder(), reranker: new FakeReranker() };
}

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
