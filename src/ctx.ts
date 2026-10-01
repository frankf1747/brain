import { config } from "./config.js";
import { connect, type Db } from "./db.js";
import { AnthropicLlm, type Llm } from "./llm/llm.js";
import { ClaudeCodeLlm } from "./llm/claude-code.js";
import { VoyageClient, type Embedder, type Reranker } from "./llm/voyage.js";
import { statSync } from "node:fs";
import { ObsidianAutoProjector, autoProjectionEnabled } from "./obsidian/auto.js";

export interface Ctx {
  sql: Db;
  llm: Llm;
  embedder: Embedder;
  reranker: Reranker;
  /** Query-time clients with small retry budgets, so search degrades fast instead of waiting out a Voyage outage. */
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
}

export function makeCtx(opts: MakeCtxOptions = {}): Ctx {
  const voyage = new VoyageClient();
  const queryVoyage = new VoyageClient({ maxRateLimitAttempts: 1, maxAttempts: 2 });
  const ctx: Ctx = {
    sql: connect(opts.databaseUrl ?? config.databaseUrl),
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
