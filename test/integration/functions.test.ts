import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeVector } from "./helpers.js";
import { toVector } from "../../src/db.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

async function seedDoc(title: string, passages: string[], seed: number) {
  const [doc] = await sql<{ id: string }[]>`
    insert into brain.documents (content_hash, title, raw_content, source_kind, summary, summary_embedding)
    values (${title}, ${title}, ${passages.join("\n\n")}, 'note', ${"About " + title}, ${toVector(fakeVector(seed))}::vector)
    returning id`;
  const ids: string[] = [];
  for (let i = 0; i < passages.length; i++) {
    const [c] = await sql<{ id: string }[]>`
      insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end, embedding)
      values (${doc.id}, 1, ${i}, ${passages[i]}, 10, 0, 10, ${toVector(fakeVector(seed * 10 + i))}::vector)
      returning id`;
    ids.push(c.id);
  }
  return { docId: doc.id, chunkIds: ids };
}

describe("hybrid_search", () => {
  it("returns a keyword hit even when its vector rank is poor", async () => {
    await seedDoc("A", ["The quarterly report mentions Zorblax Industries.", "Nothing here."], 1);
    await seedDoc("B", ["Unrelated text about gardening.", "More gardening."], 2);
    const rows = await sql<{ chunk_id: string; keyword_rank: number | null; vector_rank: number | null }[]>`
      select * from brain.hybrid_search('Zorblax', ${toVector(fakeVector(999))}::vector, 10, null, null, null)`;
    const kw = rows.filter((r) => r.keyword_rank !== null);
    expect(kw.length).toBe(1);
    expect(rows.length).toBeGreaterThanOrEqual(4); // vector side returns every embedded chunk
  });

  it("applies source_kind filter inside the query", async () => {
    await seedDoc("A", ["Zorblax again."], 3);
    await sql`update brain.documents set source_kind = 'news'`;
    const rows = await sql`
      select * from brain.hybrid_search('Zorblax', ${toVector(fakeVector(1))}::vector, 10, ${["note"]}::text[], null, null)`;
    expect(rows.length).toBe(0);
  });
});

describe("neighbors", () => {
  it("walks one and two hops and follows merged_into", async () => {
    const [a] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name) values ('person','Ann','ann') returning id`;
    const [b] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name) values ('organization','Beta Co','beta co') returning id`;
    const [bDup] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name, merged_into) values ('organization','Beta Company','beta company', ${b.id}) returning id`;
    const [c] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name) values ('place','Denver','denver') returning id`;
    await sql`insert into brain.edges (from_node, to_node, type) values (${a.id}, ${bDup.id}, 'works_at')`;
    await sql`insert into brain.edges (from_node, to_node, type) values (${b.id}, ${c.id}, 'located_in')`;

    const one = await sql<{ node_id: string; depth: number }[]>`select * from brain.neighbors(${a.id}, 1, null)`;
    expect(one.map((r) => r.node_id)).toEqual([b.id]); // merged duplicate resolved to canonical
    const two = await sql<{ node_id: string; depth: number }[]>`select * from brain.neighbors(${a.id}, 2, null)`;
    expect(two.map((r) => r.node_id).sort()).toEqual([b.id, c.id].sort());
  });
});

describe("current_facts", () => {
  it("hides superseded and expired facts", async () => {
    const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
    const [old] = await sql<{ id: string }[]>`
      insert into brain.facts (subject_id, predicate, object_text) values (${self.id}, 'lives_in', 'Austin') returning id`;
    const [cur] = await sql<{ id: string }[]>`
      insert into brain.facts (subject_id, predicate, object_text) values (${self.id}, 'lives_in', 'Los Angeles') returning id`;
    await sql`update brain.facts set superseded_by = ${cur.id} where id = ${old.id}`;
    await sql`insert into brain.facts (subject_id, predicate, object_text, valid_to) values (${self.id}, 'visa_status', 'F-1', '2020-01-01')`;
    const rows = await sql<{ predicate: string; object_text: string }[]>`select * from brain.current_facts(null)`;
    expect(rows).toEqual([{ predicate: "lives_in", object_text: "Los Angeles" }].map((f) => expect.objectContaining(f)));
    expect(rows.length).toBe(1);
  });
});
