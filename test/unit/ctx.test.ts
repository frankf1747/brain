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
