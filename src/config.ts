import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Resolve .env from the repository root so the MCP server works from any cwd.
// quiet: dotenv 17 otherwise logs to stdout, which would corrupt an MCP stdio stream.
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

export const DEFAULT_VOYAGE_DAILY_TOKEN_CAP = 5_000_000;

/**
 * BRAIN_VOYAGE_DAILY_TOKEN_CAP: whole tokens per UTC day (underscores allowed). Unset or empty means the default;
 * 0 blocks every Voyage call. There is no value that turns the cap off, and anything unreadable stops the process
 * at startup, so a typo can never lift the cap.
 */
export function parseTokenCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_VOYAGE_DAILY_TOKEN_CAP;
  const s = raw.trim().replace(/_/g, "");
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n)) {
    throw new Error(`BRAIN_VOYAGE_DAILY_TOKEN_CAP must be a whole number of tokens per UTC day (0 blocks every Voyage call); got "${raw}"`);
  }
  return n;
}

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
  /** Hard cap on Voyage tokens per UTC day, enforced before every request by src/llm/ledger.ts. */
  voyageDailyTokenCap: parseTokenCap(process.env.BRAIN_VOYAGE_DAILY_TOKEN_CAP),
  obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH ?? "/Users/frankfu/Documents/Obsidian/General",
  obsidianFolder: process.env.OBSIDIAN_FOLDER || "Brain", // empty means unset
  embeddingDimensions: 1024,
  chunking: { sectionTokens: 1500, passageTokens: 400, overlapRatio: 0.15 },
  resolution: { matchThreshold: 0.92, flagThreshold: 0.85, lexicalThreshold: 0.6 },
  retrieval: { candidateK: 60, defaultK: 10, fallbackThreshold: 0.3 },
  graph: { maxEntities: 5, maxNeighbors: 20, maxPassagesPerEntity: 5, maxFacts: 10 },
  /**
   * Author of a document saved without one, by source kind; any other kind is "unknown".
   * KEEP IN SYNC with brain.default_author in supabase/migrations/20261001000009_author.sql.
   */
  authorDefaults: {
    resume: "owner",
    note: "owner",
    conversation: "owner",
    paste: "owner",
    news: "other",
    paper: "other",
    job_description: "other",
    email: "other",
  },
  /** Predicates that hold one current value: a newer statement in an owner document supersedes the older (spec §4.4). */
  singleValuedPredicates: ["lives_in", "visa_status", "targeting_role", "pursuing_degree", "employment_status", "current_employer", "phone", "email"],
} as const;
