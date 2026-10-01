import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx, fakeVector } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { toVector } from "../../src/db.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

/**
 * Plan text for a statement under the given planner settings. Test tables hold a handful of rows, where
 * a full sort or a scan of any index is cheapest, so the tests switch off the alternatives to show which
 * indexes the SQL is *able* to use. With the old materialised CTE no setting could produce an index scan:
 * every branch read a CTE Scan.
 *
 * The vector branch is checked with sorts disabled: then an ordered HNSW scan is the only sort-free way to
 * satisfy ORDER BY distance LIMIT k. The keyword branch is checked with sorts allowed, because it always
 * sorts by rank; disabling sorts there puts the same 1e10 penalty on every keyword path and the planner
 * then treats them as equal. Vector literals are shortened so a failing assertion prints a readable plan.
 */
async function plan(statement: string, settings: string[]): Promise<string> {
  return sql.begin(async (tx) => {
    for (const s of settings) await tx.unsafe(`set local ${s}`);
    const rows = await tx.unsafe(`explain (costs off) ${statement}`);
    return rows
      .map((r: Record<string, string>) => r["QUERY PLAN"])
      .join("\n")
      .replace(/'\[[^\]]*\]'/g, "'<vector>'");
  });
}
const VECTOR = ["enable_seqscan = off", "enable_sort = off"];
const KEYWORD = ["enable_seqscan = off"];

/**
 * One real document plus filler rows without embeddings (cheap: nothing to insert into HNSW), then ANALYZE.
 * The filler makes `level = 1` unselective and the query terms selective, as in the real knowledge base;
 * on a one-row table the planner's choice between the GIN index and a btree scan on level is a coin flip.
 */
async function seed(): Promise<string> {
  await ingest(fakeCtx(sql), { text: "Zorblax Industries released the ZX-9000 drill.", sourceKind: "news", title: "Zorblax" });
  await sql`
    insert into brain.documents (content_hash, source_kind, title, raw_content, summary)
    select 'filler-' || g, 'note', 'Filler ' || g, 'filler', 'routine weekly status notes ' || g
    from generate_series(1, 500) g`;
  await sql`
    insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end)
    select d.id, 1, o, 'routine weekly status notes ' || o, 5, 0, 10
    from brain.documents d, generate_series(1, 4) o
    where d.content_hash like 'filler-%'`;
  await sql`analyze brain.documents`;
  await sql`analyze brain.chunks`;
  return toVector(fakeVector(1));
}

describe("search SQL uses its indexes", () => {
  it("hybrid_search: vector branch reads chunks through HNSW, not a materialised CTE", async () => {
    const v = await seed();
    const p = await plan(`select * from brain.hybrid_search('zorblax drill', '${v}'::vector, 60, null::text[], null, null)`, VECTOR);
    expect(p).not.toContain("CTE Scan");
    expect(p).toMatch(/Index Scan using chunks_embedding_idx on chunks c\n\s+Order By: \(embedding <=> '<vector>'::vector\)/);
  });
  it("hybrid_search: keyword branch reads chunks through GIN", async () => {
    const v = await seed();
    const p = await plan(`select * from brain.hybrid_search('zorblax drill', '${v}'::vector, 60, null::text[], null, null)`, KEYWORD);
    expect(p).not.toContain("CTE Scan");
    expect(p).toMatch(/Bitmap Index Scan on chunks_tsv_idx\n\s+Index Cond: \(tsv @@ /);
  });
  it("hybrid_search: source_kind and date filters sit on the HNSW scan itself", async () => {
    const v = await seed();
    const p = await plan(
      `select * from brain.hybrid_search('zorblax drill', '${v}'::vector, 60, array['news'], '2020-01-01'::timestamptz, null)`,
      VECTOR,
    );
    expect(p).not.toContain("CTE Scan");
    // A filter on the scan node (not a join above it) lets the iterative scan keep going until k rows pass.
    expect(p).toMatch(
      /Index Scan using chunks_embedding_idx on chunks c\n\s+Order By: \(embedding <=> '<vector>'::vector\)\n\s+Filter: .*SubPlan/,
    );
  });
  it("summary_search: vector branch reads documents through HNSW", async () => {
    const v = await seed();
    const p = await plan(`select * from brain.summary_search('zorblax drill', '${v}'::vector, 60, null::text[], null, null)`, VECTOR);
    expect(p).not.toContain("CTE Scan");
    expect(p).toMatch(/Index Scan using documents_summary_embedding_idx on documents d\n\s+Order By: \(summary_embedding <=> /);
  });
  // Under hnsw.iterative_scan = relaxed_order the index output can be slightly out of order, so the ranks
  // must come from a Sort on the exact scores above the HNSW scan, not from index order.
  it("hybrid_search: vector ranks come from a Sort on exact scores above the HNSW scan", async () => {
    const v = await seed();
    const p = await plan(`select * from brain.hybrid_search('zorblax drill', '${v}'::vector, 60, null::text[], null, null)`, VECTOR);
    expect(p).toMatch(
      /WindowAgg\n\s+->  Sort\n\s+Sort Key: [^\n]*score DESC, [^\n]*id\n\s+->  Subquery Scan[^\n]*\n\s+->  Limit\n\s+->  Index Scan using chunks_embedding_idx/,
    );
  });
  it("summary_search: vector ranks come from a Sort on exact scores above the HNSW scan", async () => {
    const v = await seed();
    const p = await plan(`select * from brain.summary_search('zorblax drill', '${v}'::vector, 60, null::text[], null, null)`, VECTOR);
    expect(p).toMatch(
      /WindowAgg\n\s+->  Sort\n\s+Sort Key: [^\n]*score DESC, [^\n]*id\n\s+->  Subquery Scan[^\n]*\n\s+->  Limit\n\s+->  Index Scan using documents_summary_embedding_idx/,
    );
  });
  it("summary_search: keyword branch reads documents through GIN", async () => {
    const v = await seed();
    const p = await plan(`select * from brain.summary_search('zorblax drill', '${v}'::vector, 60, null::text[], null, null)`, KEYWORD);
    expect(p).not.toContain("CTE Scan");
    expect(p).toMatch(/Bitmap Index Scan on documents_summary_tsv_idx\n\s+Index Cond: \(summary_tsv @@ /);
  });
});
