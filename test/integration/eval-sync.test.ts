import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { testDb, wipe, fakeCtx, TEST_DATABASE_URL } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { connect, type Db } from "../../src/db.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { search } from "../../src/retrieve/search.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";

const run = promisify(execFile);

// The source is brain_test (seeded below); the target is a throwaway *_eval database named after it.
const sourceDb = new URL(TEST_DATABASE_URL).pathname.slice(1);
const targetDb = `${sourceDb}_sync_eval`;
const port = new URL(TEST_DATABASE_URL).port || "5432";
const adminUrl = process.env.TEST_ADMIN_URL ?? TEST_DATABASE_URL.replace(/\/[^/]+$/, "/postgres");
const targetUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${targetDb}`);
const TABLES = ["documents", "chunks", "ingest_jobs", "nodes", "edges", "mentions", "facts", "extractions", "fact_events"];

const sql = testDb();
let target: Db;

async function sync(src = sourceDb, dst = targetDb) {
  try {
    const { stdout, stderr } = await run("bash", ["scripts/sync-eval-db.sh", src, dst], { env: { ...process.env, SYNC_PORT: port } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function counts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await db.unsafe<{ n: number }[]>(`select count(*)::int as n from brain.${t}`))[0].n;
  return out;
}

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: null } : fakeExtraction;

beforeAll(async () => {
  // An older prepare-eval-db.sh ignores EVAL_DB and would reset brain_eval itself; never run it from here.
  if (!readFileSync("scripts/prepare-eval-db.sh", "utf8").includes('EVAL_DB="${EVAL_DB:-brain_eval}"')) {
    throw new Error("scripts/prepare-eval-db.sh does not read EVAL_DB yet; refusing to run it");
  }
  await run("bash", ["scripts/prepare-eval-db.sh", "--reset"], { env: { ...process.env, EVAL_ADMIN_URL: adminUrl, EVAL_DB: targetDb } });
  target = connect(targetUrl);
  await wipe(sql);
  const ctx = fakeCtx(sql, handler);
  await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT.", sourceKind: "note" });
  await ingest(ctx, { text: "Acme Corp builds the ZX-9000 drill in Austin.", sourceKind: "news" });
  const [fact] = await sql<{ id: string }[]>`select id from brain.facts limit 1`;
  await sql`insert into brain.fact_events (fact_id, event, by, detail) values (${fact.id}, 'restored', 'test', '{}'::jsonb)`;
  await search(ctx, "Acme visa", { client: "test" });
}, 120_000);

afterAll(async () => {
  await target?.end();
  await sql.end();
  const admin = connect(adminUrl);
  await admin.unsafe(`drop database if exists ${targetDb} with (force)`);
  await admin.end();
});

describe("scripts/sync-eval-db.sh", () => {
  it("replaces the target's content with the source's, embeddings and ids included, and leaves the source alone", async () => {
    await target`insert into brain.documents (content_hash, raw_content) values ('stale', 'left over from an earlier sync')`;
    await target`insert into brain.retrieval_log (query) values ('an old eval search')`;
    const before = await counts(sql);
    const sourceLog = (await sql<{ n: number }[]>`select count(*)::int as n from brain.retrieval_log`)[0].n;
    const res = await sync();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`synced ${sourceDb} -> ${targetDb}: documents 2, chunks `);
    expect(res.stderr).not.toContain("circular foreign-key");
    expect(await counts(target)).toEqual(before);
    expect(await counts(sql)).toEqual(before);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from brain.retrieval_log`)[0].n).toBe(sourceLog);
    expect((await target<{ n: number }[]>`select count(*)::int as n from brain.retrieval_log`)[0].n).toBe(0);
    expect(await target`select 1 from brain.documents where content_hash = 'stale'`).toHaveLength(0);
    const [s] = await sql<{ id: string; e: string }[]>`select id, embedding::text as e from brain.chunks where embedding is not null order by id limit 1`;
    const [t] = await target<{ e: string; keyword: boolean }[]>`select embedding::text as e, tsv @@ plainto_tsquery('english', 'Acme') as keyword from brain.chunks where id = ${s.id}`;
    expect(t.e).toBe(s.e);
    expect(t.keyword).toBe(true);
    expect(await target`select 1 from brain.chunks where tsv is null`).toHaveLength(0);
    const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
    expect(await target<{ id: string }[]>`select id from brain.nodes where is_self`).toEqual([{ id: self.id }]);
  });

  it("is repeatable: a second sync gives the same counts", async () => {
    expect((await sync()).code).toBe(0);
    expect(await counts(target)).toEqual(await counts(sql));
  });

  it("refuses a target that is not an eval database and a source that is one, before touching anything", async () => {
    const bad = await sync(sourceDb, sourceDb);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain(`sync: refusing to write to "${sourceDb}": the target database name must end in _eval`);
    const evalSource = await sync(targetDb, targetDb);
    expect(evalSource.code).toBe(1);
    expect(evalSource.stderr).toContain(`the source "${targetDb}" is an eval database`);
  });

  it("leaves the target unchanged when the dump fails", async () => {
    const before = await counts(target);
    const res = await sync(`${sourceDb}_missing`, targetDb);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`the copy failed; ${targetDb} is unchanged`);
    expect(await counts(target)).toEqual(before);
  });
});
