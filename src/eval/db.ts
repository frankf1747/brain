// Loads .env (dotenv) before EVAL_DATABASE_URL is read below.
import { config, EVAL_VOYAGE_CAP_NAME } from "../config.js";
import { makeCtx, type Ctx } from "../ctx.js";
import type { Db } from "../db.js";
import type { Corpus } from "./golden.js";

/**
 * The eval ingests fictional documents and logs hundreds of searches, so it only ever runs against a
 * database whose name ends in "_eval" (created by scripts/prepare-eval-db.sh). DATABASE_URL is
 * deliberately ignored: it points at the real knowledge base.
 */
export const EVAL_DATABASE_URL =
  process.env.EVAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_eval";

/**
 * The copy of the real knowledge base that `brain eval sync` fills (`eval run --corpus real` runs against it). Kept
 * apart from brain_eval so fixture evals and real-base evals both keep working; its name must end in _eval too.
 */
export const EVAL_REAL_DATABASE_URL =
  process.env.EVAL_REAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_real_eval";

/** The eval database a corpus runs against. */
export function evalDatabaseUrl(corpus: Corpus): string {
  return corpus === "real" ? EVAL_REAL_DATABASE_URL : EVAL_DATABASE_URL;
}

/** A "database does not exist" error (SQLSTATE 3D000) gains the commands that create that corpus's eval database. */
export function evalDatabaseHint(err: unknown, corpus: Corpus): unknown {
  if ((err as { code?: string } | null)?.code !== "3D000") return err;
  const how = corpus === "real" ? "npm run eval:prepare-real, then npm run brain -- eval sync" : "npm run eval:prepare, then npm run brain -- eval ingest";
  return new Error(`${err instanceof Error ? err.message : String(err)}; create it with ${how}`);
}

/**
 * postgres.js copies unknown URL query parameters into the startup message, so `?database=postgres`
 * would override the path. Only these parameters, which cannot change the target database, are allowed.
 */
const ALLOWED_QUERY_PARAMS = new Set(["sslmode", "connect_timeout", "application_name"]);

export function assertEvalDatabase(url: string): void {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "");
  if (!name.endsWith("_eval")) {
    throw new Error(`Refusing to run the eval against "${name}": the database name must end in _eval`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_QUERY_PARAMS.has(key)) {
      throw new Error(`Refusing eval database URL: query parameter "${key}" is not allowed (allowed: ${[...ALLOWED_QUERY_PARAMS].join(", ")})`);
    }
  }
}

/** Checks the database the live connection actually reached; the URL check alone can be bypassed. */
export async function assertEvalConnection(sql: Db): Promise<void> {
  const [row] = await sql<{ name: string }[]>`select current_database() as name`;
  if (!row?.name.endsWith("_eval")) {
    throw new Error(`Refusing to run the eval against "${row?.name}": the connected database name must end in _eval`);
  }
}

/** The ledger client label of every Voyage call the eval makes; runEval reads its spend by it. */
export const EVAL_CLIENT = "eval";

/**
 * A real context (real Voyage, real Claude Code) on a corpus's eval database, with the Obsidian mirror off. Its Voyage
 * calls are recorded in that eval database's own ledger, never the real base's, and capped at the eval's own cap
 * (BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP, counted per eval database).
 */
export function makeEvalCtx(corpus: Corpus = "fixtures"): Ctx {
  const url = evalDatabaseUrl(corpus);
  assertEvalDatabase(url);
  return makeCtx({ databaseUrl: url, obsidian: false, client: EVAL_CLIENT, voyageCap: { tokens: config.evalVoyageDailyTokenCap, name: EVAL_VOYAGE_CAP_NAME } });
}
