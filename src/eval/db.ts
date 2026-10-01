import { makeCtx, type Ctx } from "../ctx.js";

/**
 * The eval ingests fictional documents and logs hundreds of searches, so it only ever runs against a
 * database whose name ends in "_eval" (created by scripts/prepare-eval-db.sh). DATABASE_URL is
 * deliberately ignored: it points at the real knowledge base.
 */
export const EVAL_DATABASE_URL =
  process.env.EVAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_eval";

export function assertEvalDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_eval")) {
    throw new Error(`Refusing to run the eval against "${name}": the database name must end in _eval`);
  }
}

/** A real context (real Voyage, real Claude Code) on the eval database, with the Obsidian mirror off. */
export function makeEvalCtx(): Ctx {
  assertEvalDatabase(EVAL_DATABASE_URL);
  return makeCtx({ databaseUrl: EVAL_DATABASE_URL, obsidian: false });
}
