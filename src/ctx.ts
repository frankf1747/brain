import { config } from "./config.js";
import { connect, type Db } from "./db.js";
import { AnthropicLlm, type Llm } from "./llm/llm.js";
import { ClaudeCodeLlm } from "./llm/claude-code.js";
import { VoyageClient, QUERY_RETRY_BUDGET, QUERY_REQUEST_TIMEOUT_MS, type Embedder, type Reranker } from "./llm/voyage.js";
import type { VoyageLedger } from "./llm/ledger.js";
import { statSync } from "node:fs";
import { ObsidianAutoProjector, autoProjectionEnabled } from "./obsidian/auto.js";

export interface Ctx {
  sql: Db;
  llm: Llm;
  embedder: Embedder;
  reranker: Reranker;
  /** Query-time clients: 3 attempts and at most 10 s of backoff per call (QUERY_RETRY_BUDGET) and an 8 s request timeout, so search degrades fast. */
  queryEmbedder?: Embedder;
  queryReranker?: Reranker;
  /** Called after a document reaches chunked and again at done; the pipeline ignores anything it throws. */
  onDocumentChanged?: (documentId: string) => void;
  /** The Obsidian mirror refresher behind onDocumentChanged, so callers can flush it before exiting. */
  obsidian?: ObsidianAutoProjector;
}

export function makeLlm(): Llm {
  return config.llmBackend === "api" ? new AnthropicLlm() : new ClaudeCodeLlm();
}

export interface MakeCtxOptions {
  /** Defaults to config.databaseUrl (the real knowledge base). */
  databaseUrl?: string;
  /** False turns the Obsidian mirror off regardless of the environment; the eval database must never be mirrored. */
  obsidian?: boolean;
  /** Stored on every Voyage ledger row: cli (default), mcp-stdio, mcp-http, eval. */
  client?: string;
  /** Tokens per UTC day for this context's ledger; unset means config.voyageDailyTokenCap. makeEvalCtx passes the eval cap. */
  dailyTokenCap?: number;
}

export function makeCtx(opts: MakeCtxOptions = {}): Ctx {
  const sql = connect(opts.databaseUrl ?? config.databaseUrl);
  // Both clients record every Voyage call in this database's brain.provider_usage and stop at the daily cap
  // (src/llm/ledger.ts). The eval context gets brain_eval's ledger the same way.
  const ledger: VoyageLedger = { sql, client: opts.client ?? "cli" };
  if (opts.dailyTokenCap !== undefined) ledger.dailyTokenCap = opts.dailyTokenCap;
  const voyage = new VoyageClient({ ledger });
  const queryVoyage = new VoyageClient({ ledger, ...QUERY_RETRY_BUDGET, requestTimeoutMs: QUERY_REQUEST_TIMEOUT_MS });
  const ctx: Ctx = {
    sql,
    llm: makeLlm(),
    embedder: voyage,
    reranker: voyage,
    queryEmbedder: queryVoyage,
    queryReranker: queryVoyage,
  };
  if (opts.obsidian === false) return ctx;
  if (autoProjectionEnabled(process.env, isDirectory)) {
    const obsidian = new ObsidianAutoProjector(ctx);
    ctx.obsidian = obsidian;
    ctx.onDocumentChanged = () => obsidian.notify();
  } else if (process.env.OBSIDIAN_VAULT_PATH && process.env.OBSIDIAN_AUTO !== "0") {
    // stderr only: the MCP stdio server owns stdout.
    process.stderr.write(`brain: Obsidian vault ${process.env.OBSIDIAN_VAULT_PATH} does not exist; automatic mirror refresh is off\n`);
  }
  return ctx;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
