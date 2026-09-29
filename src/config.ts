import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Resolve .env from the repository root so the MCP server works from any cwd.
// quiet: dotenv 17 otherwise logs to stdout, which would corrupt an MCP stdio stream.
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
  llmBackend: (process.env.BRAIN_LLM ?? "claude-code") as "claude-code" | "api",
  claudeCodeBin: process.env.BRAIN_CLAUDE_CODE_BIN ?? "claude",
  claudeCodeModel: process.env.BRAIN_CLAUDE_CODE_MODEL ?? "opus",
  anthropicModel: process.env.BRAIN_MODEL ?? "claude-opus-5",
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  voyageEmbedModel: process.env.VOYAGE_EMBED_MODEL ?? "voyage-4-large",
  voyageRerankModel: process.env.VOYAGE_RERANK_MODEL ?? "rerank-2.5",
  obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH ?? "/Users/frankfu/Documents/Obsidian/General",
  obsidianFolder: process.env.OBSIDIAN_FOLDER ?? "Brain",
  embeddingDimensions: 1024,
  chunking: { sectionTokens: 1500, passageTokens: 400, overlapRatio: 0.15 },
  resolution: { matchThreshold: 0.92, flagThreshold: 0.85, lexicalThreshold: 0.6 },
  retrieval: { candidateK: 40, defaultK: 10, fallbackThreshold: 0.3 },
} as const;
