import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { testDb, wipe } from "./helpers.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("brain.retrieval_log v2 (migration 011)", () => {
  it("has the v2 columns, the created_at index and the checks, and re-applies cleanly", async () => {
    const cols = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
      where table_schema = 'brain' and table_name = 'retrieval_log' and column_name in ('results', 'degraded', 'candidates', 'timings', 'k', 'mode')
      order by column_name`;
    expect(cols).toEqual([
      { column_name: "candidates", data_type: "jsonb" },
      { column_name: "degraded", data_type: "jsonb" },
      { column_name: "k", data_type: "integer" },
      { column_name: "mode", data_type: "text" },
      { column_name: "results", data_type: "jsonb" },
      { column_name: "timings", data_type: "jsonb" },
    ]);
    const [idx] = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = 'brain' and indexname = 'retrieval_log_created_at'`;
    expect(idx.indexdef).toContain("(created_at DESC)");
    await expect(sql`insert into brain.retrieval_log (query, mode) values ('q', 'full')`).rejects.toThrow(/retrieval_log_mode_check/);
    await expect(sql`insert into brain.retrieval_log (query, results) values ('q', '{}'::jsonb)`).rejects.toThrow(/retrieval_log_results_check/);
    const file = await readFile(new URL("../../supabase/migrations/20261002000011_retrieval_log_v2.sql", import.meta.url), "utf8");
    // The file has its own begin/commit, so it runs on one reserved connection, exactly as psql runs it.
    const conn = await sql.reserve();
    try {
      await conn.unsafe(file);
      await conn.unsafe(file);
    } finally {
      conn.release();
    }
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_constraint
      where conrelid = 'brain.retrieval_log'::regclass and conname in ('retrieval_log_mode_check', 'retrieval_log_results_check')`;
    expect(n).toBe(2);
  });

  it("still takes a v1 insert, leaving the v2 columns null", async () => {
    const [row] = await sql<{ results: unknown; degraded: unknown; k: number | null; mode: string | null }[]>`
      insert into brain.retrieval_log (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client)
      values ('q', '{}'::jsonb, '{hybrid,summary}', '{}'::uuid[], '{}'::uuid[], 0.5, false, 'cli')
      returning results, degraded, k, mode`;
    expect(row).toEqual({ results: null, degraded: null, k: null, mode: null });
  });
});
