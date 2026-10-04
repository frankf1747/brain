import { spawn } from "node:child_process";
import { assertEvalDatabase } from "./db.js";

/** What `brain eval sync` copies from and to, read from two connection URLs. */
export interface SyncPlan {
  sourceDb: string;
  targetDb: string;
  /** The port both URLs name; scripts/sync-eval-db.sh checks the Supabase container publishes it. */
  port: string;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Checks the source and target before anything runs. The copy runs inside the local Supabase container, which reaches
 * databases by name, so both URLs must name that local server (same host class, same port); the target must be an eval
 * database (assertEvalDatabase: the name ends in _eval, no query parameter that could redirect it); the source must not
 * be one, and the two must differ.
 */
export function syncPlan(sourceUrl: string, targetUrl: string): SyncPlan {
  assertEvalDatabase(targetUrl);
  const src = new URL(sourceUrl);
  const dst = new URL(targetUrl);
  const name = (u: URL) => decodeURIComponent(u.pathname.replace(/^\//, ""));
  const sourceDb = name(src);
  const targetDb = name(dst);
  for (const [role, db] of [["source", sourceDb], ["target", targetDb]] as const) {
    if (!IDENTIFIER.test(db)) throw new Error(`eval sync: the ${role} database name must be a lower-case identifier, got "${db}"`);
  }
  if (sourceDb.endsWith("_eval")) throw new Error(`eval sync: the source "${sourceDb}" is an eval database; DATABASE_URL must name the knowledge base`);
  if (sourceDb === targetDb) throw new Error("eval sync: source and target are the same database");
  for (const [role, u] of [["DATABASE_URL", src], ["EVAL_REAL_DATABASE_URL", dst]] as const) {
    if (!LOCAL_HOSTS.has(u.hostname)) throw new Error(`eval sync: ${role} must name the local Supabase server (127.0.0.1 or localhost), got ${u.hostname}`);
  }
  const port = (u: URL) => u.port || "5432";
  if (port(src) !== port(dst)) throw new Error(`eval sync: DATABASE_URL (port ${port(src)}) and EVAL_REAL_DATABASE_URL (port ${port(dst)}) must name the same server`);
  return { sourceDb, targetDb, port: port(dst) };
}

/** Runs scripts/sync-eval-db.sh with the plan; its output goes to this process's stdout and stderr. Resolves with its exit code. */
export function runSync(plan: SyncPlan, script = "scripts/sync-eval-db.sh"): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, plan.sourceDb, plan.targetDb], { stdio: "inherit", env: { ...process.env, SYNC_PORT: plan.port } });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
