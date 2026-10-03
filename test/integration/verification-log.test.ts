import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("migration 012: retrieval_log.facts and brain.verification_log", () => {
  it("adds the facts column and the verification_log table with its indexes, checks and row level security, and re-applies cleanly", async () => {
    const [col] = await sql<{ data_type: string }[]>`
      select data_type from information_schema.columns where table_schema = 'brain' and table_name = 'retrieval_log' and column_name = 'facts'`;
    expect(col.data_type).toBe("jsonb");
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'brain' and table_name = 'verification_log' order by ordinal_position`;
    expect(cols).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "retrieval_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "client", data_type: "text", is_nullable: "NO" },
      { column_name: "claims", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "results", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "summary", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);
    const idx = await sql<{ indexname: string }[]>`select indexname from pg_indexes where schemaname = 'brain' and tablename = 'verification_log' order by indexname`;
    expect(idx.map((i) => i.indexname)).toEqual(["verification_log_created_at", "verification_log_pkey", "verification_log_retrieval_id"]);
    const [rls] = await sql<{ relrowsecurity: boolean }[]>`select relrowsecurity from pg_class where oid = 'brain.verification_log'::regclass`;
    expect(rls.relrowsecurity).toBe(true);
    await expect(sql`insert into brain.retrieval_log (query, facts) values ('q', '{}'::jsonb)`).rejects.toThrow(/retrieval_log_facts_check/);
    await expect(sql`
      insert into brain.verification_log (retrieval_id, client, claims, results, summary)
      values (gen_random_uuid(), 'test', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)`).rejects.toThrow(/verification_log_claims_check/);
    const file = await readFile(new URL("../../supabase/migrations/20261003000012_verification_log.sql", import.meta.url), "utf8");
    const conn = await sql.reserve();
    try {
      await conn.unsafe(file);
      await conn.unsafe(file);
    } finally {
      conn.release();
    }
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_constraint where conrelid = 'brain.retrieval_log'::regclass and conname = 'retrieval_log_facts_check'`;
    expect(n).toBe(1);
  });

  it("search logs the facts it returned, in order, so F1 is the first one", async () => {
    const ctx = fakeCtx(sql, ({ system }) =>
      system === SUMMARY_SYSTEM
        ? { title: "T", summary_line: "L", summary: "S", occurred_at: null }
        : { entities: [], relations: [], facts_about_self: [{ predicate: "visa_status", object_text: "F-1 OPT", object_key: null, confidence: 1, valid_from: null, valid_to: null, quote: "F-1 OPT" }] });
    await ingest(ctx, { text: "I am on F-1 OPT and looking for a visa sponsor.", sourceKind: "note" });
    const res = await search(ctx, "visa status", { k: 3 });
    expect(res.facts.length).toBe(1);
    const [row] = await sql<{ facts: unknown }[]>`select facts from brain.retrieval_log where id = ${res.retrievalId}`;
    expect(row.facts).toEqual(res.facts);
    const none = await search(ctx, "visa status", { k: 3, includeFacts: false });
    const [empty] = await sql<{ facts: unknown }[]>`select facts from brain.retrieval_log where id = ${none.retrievalId}`;
    expect(empty.facts).toEqual([]);
  });

  it("wipe empties verification_log", async () => {
    await sql`
      insert into brain.verification_log (retrieval_id, client, claims, results, summary)
      values (gen_random_uuid(), 'test', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`;
    await wipe(sql);
    expect((await sql`select id from brain.verification_log`).length).toBe(0);
  });
});
