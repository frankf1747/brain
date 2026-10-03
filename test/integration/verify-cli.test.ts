import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { testDb, wipe, fakeCtx, TEST_DATABASE_URL } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";

const run = promisify(execFile);
const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

/** Runs `brain verify` against brain_test (never the real database), without the Obsidian mirror. */
async function brainVerify(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("node_modules/.bin/tsx", ["src/cli.ts", "verify", ...args], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, OBSIDIAN_AUTO: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function logged(): Promise<string> {
  const ctx = fakeCtx(sql, ({ system }) =>
    system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: null } : { entities: [], relations: [], facts_about_self: [] });
  await ingest(ctx, { text: "Acme Corp sponsors H-1B visas for analysts.", sourceKind: "note" });
  return (await search(ctx, "Acme visa", { k: 3 })).retrievalId;
}

describe("brain verify (CLI)", () => {
  it("checks one --claim with its --cite labels and logs it as client cli", async () => {
    const id = await logged();
    const r = await brainVerify([id, "--claim", "Acme sponsors H-1B visas.", "--cite", "P1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`retrieval ${id} · 1 claim`);
    expect(r.stdout).toContain('✓ supported 1.00 — "Acme sponsors H-1B visas." [P1]');
    expect(r.stdout).toContain("Summary: 1 supported");
    const [row] = await sql<{ client: string }[]>`select client from brain.verification_log where retrieval_id = ${id}`;
    expect(row.client).toBe("cli");
  }, 30_000);

  it("exits 1 with a clear message when the --claims file is not JSON, and writes nothing", async () => {
    const id = await logged();
    const dir = await mkdtemp(join(tmpdir(), "brain-claims-"));
    const file = join(dir, "claims.json");
    await writeFile(file, "{ not json");
    const r = await brainVerify([id, "--claims", file]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Cannot read ${file} as JSON`);
    expect((await sql`select id from brain.verification_log`).length).toBe(0);
  }, 30_000);
});
