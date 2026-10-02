// Loads .env (dotenv) before EVAL_DATABASE_URL is read below.
import "../config.js";
import { makeCtx, type Ctx } from "../ctx.js";
import type { Db } from "../db.js";

/**
 * The eval ingests fictional documents and logs hundreds of searches, so it only ever runs against a
 * database whose name ends in "_eval" (created by scripts/prepare-eval-db.sh). DATABASE_URL is
 * deliberately ignored: it points at the real knowledge base.
 */
export const EVAL_DATABASE_URL =
  process.env.EVAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_eval";

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
 * A real context (real Voyage, real Claude Code) on the eval database, with the Obsidian mirror off. Its Voyage
 * calls are recorded and capped in brain_eval's own ledger, never the real base's.
 */
export function makeEvalCtx(): Ctx {
  assertEvalDatabase(EVAL_DATABASE_URL);
  return makeCtx({ databaseUrl: EVAL_DATABASE_URL, obsidian: false, client: EVAL_CLIENT });
}
