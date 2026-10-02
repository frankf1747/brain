import { describe, it, expect } from "vitest";
import { makeCtx } from "../../src/ctx.js";
import { makeEvalCtx, EVAL_CLIENT } from "../../src/eval/db.js";
import { VoyageClient } from "../../src/llm/voyage.js";
import { config } from "../../src/config.js";

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

  it("times out query requests after 8 s and ingest requests after 120 s", async () => {
    const ctx = makeCtx({ databaseUrl: UNUSED_DB, obsidian: false });
    try {
      expect((ctx.queryEmbedder as VoyageClient).requestTimeoutMs).toBe(8_000);
      expect((ctx.queryReranker as VoyageClient).requestTimeoutMs).toBe(8_000);
      expect((ctx.embedder as VoyageClient).requestTimeoutMs).toBe(120_000);
      expect((ctx.reranker as VoyageClient).requestTimeoutMs).toBe(120_000);
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

  it("caps a context at the dailyTokenCap it is given, on every Voyage client", async () => {
    const ctx = makeCtx({ databaseUrl: UNUSED_DB, obsidian: false, dailyTokenCap: 1234 });
    try {
      for (const c of voyageClients(ctx)) expect((c as VoyageClient).ledger?.dailyTokenCap).toBe(1234);
    } finally {
      await ctx.sql.end();
    }
  });

  it("caps the eval context at BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP, not the real base's cap", async () => {
    const ev = makeEvalCtx();
    try {
      expect(config.evalVoyageDailyTokenCap).toEqual(expect.any(Number));
      for (const c of voyageClients(ev)) expect((c as VoyageClient).ledger?.dailyTokenCap).toBe(config.evalVoyageDailyTokenCap);
    } finally {
      await ev.sql.end();
    }
  });
});
