import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";

const sql = testDb();
// Other files leave nodes such as Acme behind, and file order follows cached durations: start clean.
beforeAll(() => wipe(sql));
afterAll(() => sql.end());

describe("core schema", () => {
  it("has the recall-layer tables", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'brain' order by table_name`;
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(["documents", "chunks", "ingest_jobs"]));
  });

  it("stores 1024-dimension embeddings on chunks", async () => {
    const [row] = await sql<{ atttypmod: number }[]>`
      select atttypmod from pg_attribute
      where attrelid = 'brain.chunks'::regclass and attname = 'embedding'`;
    expect(row.atttypmod).toBe(1024);
  });

  it("rejects a chunk level outside 0..1", async () => {
    await expect(sql`
      insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end)
      values (gen_random_uuid(), 2, 0, 'x', 1, 0, 1)`).rejects.toThrow();
  });

  it("seeds the node and edge type registries", async () => {
    const [{ n: nodeTypes }] = await sql<{ n: string }[]>`select count(*)::text as n from brain.node_types`;
    const [{ n: edgeTypes }] = await sql<{ n: string }[]>`select count(*)::text as n from brain.edge_types`;
    expect(Number(nodeTypes)).toBe(7);
    expect(Number(edgeTypes)).toBe(11);
  });

  it("has exactly one self node and refuses a second", async () => {
    const selves = await sql`select id from brain.nodes where is_self`;
    expect(selves.length).toBe(1);
    await expect(sql`
      insert into brain.nodes (type, name, canonical_name, is_self)
      values ('person', 'Impostor', 'impostor', true)`).rejects.toThrow();
  });

  it("does not duplicate an edge re-extracted from the same evidence", async () => {
    const [a] = await sql<{ id: string }[]>`
      insert into brain.nodes (type, name, canonical_name) values ('organization', 'Acme', 'acme') returning id`;
    const [b] = await sql<{ id: string }[]>`
      insert into brain.nodes (type, name, canonical_name) values ('place', 'Austin', 'austin') returning id`;
    await sql`insert into brain.edges (from_node, to_node, type) values (${a.id}, ${b.id}, 'located_in')`;
    await expect(sql`
      insert into brain.edges (from_node, to_node, type) values (${a.id}, ${b.id}, 'located_in')`).rejects.toThrow();
    await sql`delete from brain.nodes where id in (${a.id}, ${b.id})`;
  });
});
