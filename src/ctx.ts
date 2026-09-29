import { config } from "./config.js";
import { connect, type Db } from "./db.js";
import { AnthropicLlm, type Llm } from "./llm/llm.js";
import { ClaudeCodeLlm } from "./llm/claude-code.js";
import { VoyageClient, type Embedder, type Reranker } from "./llm/voyage.js";

export interface Ctx {
  sql: Db;
  llm: Llm;
  embedder: Embedder;
  reranker: Reranker;
  /** Query-time clients with small retry budgets, so search degrades fast instead of waiting out a Voyage outage. */
  queryEmbedder?: Embedder;
  queryReranker?: Reranker;
}

export function makeLlm(): Llm {
  return config.llmBackend === "api" ? new AnthropicLlm() : new ClaudeCodeLlm();
}

export function makeCtx(): Ctx {
  const voyage = new VoyageClient();
  const queryVoyage = new VoyageClient({ maxRateLimitAttempts: 1, maxAttempts: 2 });
  return {
    sql: connect(config.databaseUrl),
    llm: makeLlm(),
    embedder: voyage,
    reranker: voyage,
    queryEmbedder: queryVoyage,
    queryReranker: queryVoyage,
  };
}
