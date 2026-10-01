# Phase 1: Retrieval Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sure a passage that answers a question reaches the candidate pool and is ordered by the reranker: search SQL that uses its indexes, OR-of-stems keyword matching over title, headings and content, entity detection without capital letters, a per-term fallback scan, and bounded graph and fact expansion.

**Architecture:** Three migrations (search functions, keyword query builder and weighted tsvectors, neighbor walk). `search.ts` sets the pgvector scan parameters inside a transaction around the two SQL searches, and gains per-term fallback and fact filtering. `entities.ts` switches from capitalised runs to token spans. Every SQL change has an `EXPLAIN` test that fails if the index is not used.

**Tech Stack:** Postgres 15, pgvector 0.8.2 (local Supabase), plpgsql, TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` §3.
**Prerequisite:** Phase 0 complete (`eval/baseline.json` exists; `npm run eval:gate` passes on `main`).
**Working directory:** `/Users/frankfu/Documents/GitHub/brain`

Every task ends with `npm run test:int`. The phase ends with `npm run eval:run` and a reviewed delta.

---

## File structure

```
supabase/migrations/
  20260930000006_search_indexes.sql   NEW: hybrid_search / summary_search without the shared CTE; candidate k for both
  20260930000007_keyword_or.sql       NEW: brain.query_to_tsquery; weighted chunks.tsv and documents.summary_tsv
  20260930000008_neighbors_index.sql  NEW (built up over Tasks 3–5): canonical_text, like_literal, nodes_merged_into_idx, node_members, neighbors() on raw edge columns
src/
  config.ts                           MODIFY: retrieval.candidateK 60, retrieval.efSearch 200, graph budgets
  retrieve/search.ts                  MODIFY: transaction with pgvector GUCs; per-term fallback; fact filter; budgets
  retrieve/entities.ts                REWRITE: candidateSpans, detectEntities with matchedSpan, longest-span wins
  retrieve/fallback.ts                NEW: triggerTerms(query)
  mcp/server.ts                       MODIFY: verified_only description
test/
  unit/entities.test.ts               REWRITE
  unit/fallback.test.ts               NEW
  integration/search-plan.test.ts     NEW: EXPLAIN assertions for hybrid_search, summary_search, neighbors
  integration/keyword.test.ts         NEW: query_to_tsquery and weighted tsv behaviour
  integration/search.test.ts          MODIFY: lowercase entity, per-term fallback, fact filter, budgets
```

---

### Task 1: Search functions that use their indexes

**Files:**
- Create: `supabase/migrations/20260930000006_search_indexes.sql`
- Modify: `src/config.ts`
- Modify: `src/retrieve/search.ts` (the two SQL calls at the top of `search()`)
- Create: `test/integration/search-plan.test.ts`

- [ ] **Step 1: Write the failing plan test**

`test/integration/search-plan.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx, fakeVector } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { toVector } from "../../src/db.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

/** Plan text for a statement with sequential scans discouraged, so index eligibility shows even on tiny tables. */
async function plan(statement: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx.unsafe("set local enable_seqscan = off");
    const rows = await tx.unsafe(`explain (costs off) ${statement}`);
    return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
  });
}

describe("search SQL uses its indexes", () => {
  it("hybrid_search reads chunks through the HNSW and GIN indexes, not a materialised CTE", async () => {
    await ingest(fakeCtx(sql), { text: "Zorblax Industries released the ZX-9000 drill.", sourceKind: "news", title: "Zorblax" });
    const v = toVector(fakeVector(1));
    const p = await plan(`select * from brain.hybrid_search('zorblax drill', '${v}'::vector, 60, null::text[], null, null)`);
    expect(p).not.toContain("CTE Scan");
    expect(p).toContain("chunks_embedding_idx");
    expect(p).toContain("chunks_tsv_idx");
  });
  it("summary_search reads documents through the HNSW and GIN indexes", async () => {
    await ingest(fakeCtx(sql), { text: "Zorblax Industries released the ZX-9000 drill.", sourceKind: "news", title: "Zorblax" });
    const v = toVector(fakeVector(1));
    const p = await plan(`select * from brain.summary_search('zorblax drill', '${v}'::vector, 60, null::text[], null, null)`);
    expect(p).not.toContain("CTE Scan");
    expect(p).toContain("documents_summary_embedding_idx");
    expect(p).toContain("documents_summary_tsv_idx");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:int -- test/integration/search-plan.test.ts`
Expected: FAIL: the plan contains `CTE Scan` and no index names (or shows only `Function Scan on hybrid_search`, which also fails the `chunks_embedding_idx` assertion).

- [ ] **Step 3: Write the migration**

`supabase/migrations/20260930000006_search_indexes.sql`:
```sql
-- The shared "filtered" CTE was materialised, so neither the HNSW nor the GIN index could be used:
-- every search computed a distance for every passage. Each branch now reads the base table directly
-- with the filters inlined. The caller sets hnsw.iterative_scan and hnsw.ef_search (src/retrieve/search.ts)
-- so a filtered vector search keeps scanning until it has k rows instead of returning short.
-- Both functions stay single-SELECT, STABLE and without SET clauses so Postgres can inline them into
-- the calling query; that is what lets EXPLAIN show the real plan (test/integration/search-plan.test.ts).

create or replace function brain.hybrid_search(
  query_text text,
  query_embedding vector(1024),
  k int default 60,
  source_kinds text[] default null,
  since timestamptz default null,
  until timestamptz default null
) returns table (
  chunk_id uuid,
  document_id uuid,
  vector_rank int,
  keyword_rank int,
  vector_score real
) language sql stable as $$
  with vec as (
    select c.id, c.document_id,
           row_number() over (order by c.embedding <=> query_embedding) as r,
           1 - (c.embedding <=> query_embedding) as score
    from brain.chunks c
    join brain.documents d on d.id = c.document_id
    where c.level = 1
      and c.embedding is not null
      and query_embedding is not null
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by c.embedding <=> query_embedding
    limit k
  ),
  kw as (
    select c.id, c.document_id,
           row_number() over (order by ts_rank_cd(c.tsv, q.q) desc) as r
    from brain.chunks c
    join brain.documents d on d.id = c.document_id
    cross join (select websearch_to_tsquery('english', query_text) as q) q
    where c.level = 1
      and c.tsv @@ q.q
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by ts_rank_cd(c.tsv, q.q) desc
    limit k
  )
  select coalesce(vec.id, kw.id),
         coalesce(vec.document_id, kw.document_id),
         vec.r::int,
         kw.r::int,
         vec.score::real
  from vec full outer join kw on vec.id = kw.id;
$$;

create or replace function brain.summary_search(
  query_text text,
  query_embedding vector(1024),
  k int default 60,
  source_kinds text[] default null,
  since timestamptz default null,
  until timestamptz default null
) returns table (
  document_id uuid,
  vector_rank int,
  keyword_rank int,
  vector_score real
) language sql stable as $$
  with vec as (
    select d.id,
           row_number() over (order by d.summary_embedding <=> query_embedding) as r,
           1 - (d.summary_embedding <=> query_embedding) as score
    from brain.documents d
    where d.summary_embedding is not null
      and query_embedding is not null
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by d.summary_embedding <=> query_embedding
    limit k
  ),
  kw as (
    select d.id,
           row_number() over (order by ts_rank_cd(d.summary_tsv, q.q) desc) as r
    from brain.documents d
    cross join (select websearch_to_tsquery('english', query_text) as q) q
    where d.summary_tsv @@ q.q
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by ts_rank_cd(d.summary_tsv, q.q) desc
    limit k
  )
  select coalesce(vec.id, kw.id), vec.r::int, kw.r::int, vec.score::real
  from vec full outer join kw on vec.id = kw.id;
$$;
```

(Task 2 replaces `websearch_to_tsquery` in both functions with `brain.query_to_tsquery`; this migration keeps the old builder so the two changes are measured separately.)

- [ ] **Step 4: Update config**

In `src/config.ts`, replace the `retrieval` line with:
```ts
  retrieval: { candidateK: 60, defaultK: 10, fallbackThreshold: 0.3, efSearch: 200 },
  graph: { maxNeighbors: 20, maxPassagesPerEntity: 5, maxFacts: 10 },
```

- [ ] **Step 5: Run the two searches inside a transaction that sets the pgvector parameters**

In `src/retrieve/search.ts`, replace the `Promise.all` block that calls `hybrid_search` and `summary_search` with:

```ts
  // pgvector 0.8: with iterative scans the HNSW index keeps going until `limit k` rows satisfy the
  // source_kind/date filters; ef_search bounds the first pass. SET LOCAL needs a transaction.
  const [chunkCands, docCands] = await sql.begin(async (tx) => {
    await tx.unsafe("set local hnsw.iterative_scan = 'relaxed_order'");
    await tx.unsafe(`set local hnsw.ef_search = ${config.retrieval.efSearch}`);
    return Promise.all([
      tx<{ chunk_id: string; vector_rank: number | null; keyword_rank: number | null }[]>`
        select chunk_id, vector_rank, keyword_rank
        from brain.hybrid_search(${query}, ${qvec}::vector, ${config.retrieval.candidateK}, ${kinds}::text[], ${since}, ${until})`,
      tx<{ document_id: string; vector_rank: number | null; keyword_rank: number | null }[]>`
        select document_id, vector_rank, keyword_rank
        from brain.summary_search(${query}, ${qvec}::vector, ${config.retrieval.candidateK}, ${kinds}::text[], ${since}, ${until})`,
    ]);
  });
  const entityRefs = await detectEntities(sql, query);
```

`efSearch` is a number from config, never user input, so `tx.unsafe` with interpolation is acceptable here; `SET` does not accept bind parameters.

- [ ] **Step 6: Apply the migration to the test database and run the plan test**

Run: `npm run test:int -- test/integration/search-plan.test.ts`
(`test:int` recreates `brain_test` from all migrations first.)
Expected: PASS (2 tests). If the plan shows only `Function Scan on hybrid_search`, Postgres did not inline the function; the two causes to check are a non-constant argument in the test statement (the test passes literals, so this should not happen) and a `SET` clause on the function (there is none).

- [ ] **Step 7: Run the whole integration suite**

Run: `npm run test:int`
Expected: all pass. `search.test.ts` "keeps fused order with RRF scores when the reranker fails" calls `hybrid_search` directly with `config.retrieval.candidateK`; it still passes because the function signature is unchanged.

- [ ] **Step 8: Apply to the real database and the eval database**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20260930000006_search_indexes.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20260930000006_search_indexes.sql
```
Expected: `CREATE FUNCTION` twice for each.

- [ ] **Step 9: Eval and commit**

Run: `npm run eval:run`
Expected: no `GATE:` lines; deltas at or above 0. Note the numbers in the commit message.

```bash
git add supabase/migrations/20260930000006_search_indexes.sql src/config.ts src/retrieve/search.ts test/integration/search-plan.test.ts
git commit -m "Search SQL uses the HNSW and GIN indexes; candidate pool 60 for chunks and summaries

Eval vs baseline: recall@10 <delta>, mrr <delta>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: OR-of-stems keyword matching over title, headings and content

**Files:**
- Create: `supabase/migrations/20260930000007_keyword_or.sql`
- Create: `test/integration/keyword.test.ts`
- Modify: `test/integration/search.test.ts` (one new test)

- [ ] **Step 1: Write the failing tests**

`test/integration/keyword.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const tsq = async (q: string) => (await sql<{ t: string | null }[]>`select brain.query_to_tsquery(${q})::text as t`)[0].t;

describe("query_to_tsquery", () => {
  it("ORs the stems of a natural-language question", async () => {
    expect(await tsq("What did Zorblax release in Texas this year?")).toBe("'zorblax' | 'releas' | 'texa' | 'year'");
  });
  it("keeps a quoted phrase as a phrase match and ORs it with the rest", async () => {
    expect(await tsq('"Zorblax Industries" drill')).toBe("'zorblax' <-> 'industri' | 'drill'");
  });
  it("returns null when only stopwords remain", async () => {
    expect(await tsq("what is the")).toBeNull();
  });
});

describe("weighted tsvector", () => {
  it("finds a passage by a word that appears only in the document title", async () => {
    const ctx = fakeCtx(sql, ({ system }) => (system.includes("summar") ? { title: "Garden", summary_line: "Notes on tomatoes.", summary: "Tomato notes.", occurred_at: null } : { entities: [], relations: [], facts_about_self: [] }));
    await ingest(ctx, { text: "Tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
    const rows = await sql<{ chunk_id: string; keyword_rank: number | null }[]>`
      select chunk_id, keyword_rank from brain.hybrid_search('garden', null::vector, 60, null::text[], null, null)`;
    expect(rows.length).toBe(1);
    expect(rows[0].keyword_rank).toBe(1);
  });
  it("ranks a passage matching more of the question's terms above one matching fewer", async () => {
    const ctx = fakeCtx(sql);
    await ingest(ctx, { text: "Zorblax Industries released the ZX-9000 drill in Austin.", sourceKind: "news", title: "A" });
    await ingest(ctx, { text: "A drill is a tool.", sourceKind: "note", title: "B" });
    const rows = await sql<{ document_id: string; keyword_rank: number | null }[]>`
      select document_id, keyword_rank from brain.hybrid_search('What did Zorblax release in Austin?', null::vector, 60, null::text[], null, null) order by keyword_rank`;
    const [first] = await sql<{ id: string }[]>`select id from brain.documents where title = 'A'`;
    expect(rows[0].document_id).toBe(first.id);
    expect(rows.length).toBe(1); // "A drill is a tool" shares no stem with the question
  });
});
```

Add to `test/integration/search.test.ts` inside `describe("search", ...)`:
```ts
  it("keyword side matches a question that shares only some terms with the passage", async () => {
    const ctx = await seed();
    ctx.embedder = { embed: async () => { throw new Error("no vectors in this test"); } } as unknown as typeof ctx.embedder;
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // "Texas" and "year" appear nowhere; the old AND query returned nothing.
      const res = await search(ctx, "What did Zorblax release in Texas this year?");
      expect(res.passages.some((p) => p.content.includes("ZX-9000"))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:int -- test/integration/keyword.test.ts test/integration/search.test.ts`
Expected: `query_to_tsquery` tests fail with `function brain.query_to_tsquery(text) does not exist`; the title test returns 0 rows; the search test finds no ZX-9000 passage.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20260930000007_keyword_or.sql`:
```sql
-- Keyword recall. websearch_to_tsquery ANDs every term, so a question had to match every stem inside
-- one ~400-token passage. query_to_tsquery ORs the stems (ts_rank_cd still ranks passages that match
-- more of them higher) and keeps quoted strings as phrase matches. The chunk tsvector gains the
-- context prefix (title, summary line, heading path) at weight A and the heading path at B, so a
-- word that only appears in the title still finds every passage of that document.

create or replace function brain.query_to_tsquery(q text) returns tsquery
language plpgsql immutable as $$
declare
  parts text[] := '{}';
  m text[];
  lex text;
  rest text;
begin
  for m in select regexp_matches(q, '"([^"]+)"', 'g') loop
    if numnode(phraseto_tsquery('english', m[1])) > 0 then
      parts := parts || ('( ' || phraseto_tsquery('english', m[1])::text || ' )');
    end if;
  end loop;
  rest := regexp_replace(q, '"[^"]*"', ' ', 'g');
  for lex in select lexeme from unnest(to_tsvector('english', rest)) order by positions[1] loop
    parts := parts || quote_literal(lex);
  end loop;
  if array_length(parts, 1) is null then
    return null;
  end if;
  return array_to_string(parts, ' | ')::tsquery;
end $$;

-- Weighted chunk tsvector. A generated column may only reference its own row, and context_prefix
-- (title, summary line, heading path; written by the embed stage) is on the row.
drop index if exists brain.chunks_tsv_idx;
alter table brain.chunks drop column tsv;
alter table brain.chunks add column tsv tsvector generated always as (
  setweight(to_tsvector('english', coalesce(context_prefix, '')), 'A') ||
  setweight(to_tsvector('english', array_to_string(heading_path, ' ')), 'B') ||
  setweight(to_tsvector('english', content), 'C')
) stored;
create index chunks_tsv_idx on brain.chunks using gin (tsv);

drop index if exists brain.documents_summary_tsv_idx;
alter table brain.documents drop column summary_tsv;
alter table brain.documents add column summary_tsv tsvector generated always as (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(summary, '')), 'B')
) stored;
create index documents_summary_tsv_idx on brain.documents using gin (summary_tsv);

-- Same functions as migration 006 with the new query builder and rank normalisation 32 (rank / (rank + 1)).
create or replace function brain.hybrid_search(
  query_text text,
  query_embedding vector(1024),
  k int default 60,
  source_kinds text[] default null,
  since timestamptz default null,
  until timestamptz default null
) returns table (
  chunk_id uuid,
  document_id uuid,
  vector_rank int,
  keyword_rank int,
  vector_score real
) language sql stable as $$
  with vec as (
    select c.id, c.document_id,
           row_number() over (order by c.embedding <=> query_embedding) as r,
           1 - (c.embedding <=> query_embedding) as score
    from brain.chunks c
    join brain.documents d on d.id = c.document_id
    where c.level = 1
      and c.embedding is not null
      and query_embedding is not null
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by c.embedding <=> query_embedding
    limit k
  ),
  kw as (
    select c.id, c.document_id,
           row_number() over (order by ts_rank_cd(c.tsv, q.q, 32) desc) as r
    from brain.chunks c
    join brain.documents d on d.id = c.document_id
    cross join (select brain.query_to_tsquery(query_text) as q) q
    where c.level = 1
      and q.q is not null
      and c.tsv @@ q.q
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by ts_rank_cd(c.tsv, q.q, 32) desc
    limit k
  )
  select coalesce(vec.id, kw.id),
         coalesce(vec.document_id, kw.document_id),
         vec.r::int,
         kw.r::int,
         vec.score::real
  from vec full outer join kw on vec.id = kw.id;
$$;

create or replace function brain.summary_search(
  query_text text,
  query_embedding vector(1024),
  k int default 60,
  source_kinds text[] default null,
  since timestamptz default null,
  until timestamptz default null
) returns table (
  document_id uuid,
  vector_rank int,
  keyword_rank int,
  vector_score real
) language sql stable as $$
  with vec as (
    select d.id,
           row_number() over (order by d.summary_embedding <=> query_embedding) as r,
           1 - (d.summary_embedding <=> query_embedding) as score
    from brain.documents d
    where d.summary_embedding is not null
      and query_embedding is not null
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by d.summary_embedding <=> query_embedding
    limit k
  ),
  kw as (
    select d.id,
           row_number() over (order by ts_rank_cd(d.summary_tsv, q.q, 32) desc) as r
    from brain.documents d
    cross join (select brain.query_to_tsquery(query_text) as q) q
    where q.q is not null
      and d.summary_tsv @@ q.q
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by ts_rank_cd(d.summary_tsv, q.q, 32) desc
    limit k
  )
  select coalesce(vec.id, kw.id), vec.r::int, kw.r::int, vec.score::real
  from vec full outer join kw on vec.id = kw.id;
$$;
```

- [ ] **Step 4: Run the tests**

Run: `npm run test:int -- test/integration/keyword.test.ts test/integration/search.test.ts test/integration/search-plan.test.ts`
Expected: PASS. The expected strings are Postgres' own `tsquery` text output (a phrase binds tighter than `|`, so the cast drops the parentheses the function adds). If the stem for "Texas" or the phrase formatting prints differently on your Postgres version, print the actual output with `psql ... -c "select brain.query_to_tsquery('...')"`, confirm every stem is present and the phrase uses `<->`, and copy that exact string into the test once.

- [ ] **Step 5: Run the whole suite**

Run: `npm run test:int`
Expected: all pass. The existing fallback tests still pass because "X-90" has no stem overlap and still falls through to the scan.

- [ ] **Step 6: Apply to the real and eval databases**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20260930000007_keyword_or.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20260930000007_keyword_or.sql
```
Expected: no errors. Generated columns are recomputed for existing rows automatically.

- [ ] **Step 7: Eval and commit**

Run: `npm run eval:run`
Expected: no `GATE:` lines. `q03` (visa sponsorship, three expected documents) and `q07` (Priya, three documents) are the ones most likely to improve.

```bash
git add supabase/migrations/20260930000007_keyword_or.sql test/integration/keyword.test.ts test/integration/search.test.ts
git commit -m "Keyword search ORs stems and indexes title, summary line and headings

Eval vs baseline: recall@10 <delta>, mrr <delta>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Entity detection from token spans

**Files:**
- Rewrite: `src/retrieve/entities.ts`
- Rewrite: `test/unit/entities.test.ts`
- Modify: `src/retrieve/search.ts` (`EntityHit` keeps `matchedSpan`)
- Modify: `test/integration/search.test.ts` (one new test)

- [ ] **Step 1: Write the failing unit test**

Replace `test/unit/entities.test.ts` with:
```ts
import { describe, it, expect } from "vitest";
import { candidateSpans, dropContainedSpans } from "../../src/retrieve/entities.js";

describe("candidateSpans", () => {
  it("returns every 1- to 3-token span that does not start or end with a stopword, plus quoted strings", () => {
    const spans = candidateSpans('who works at acme corp and "beta ventures"?');
    expect(spans).toContain("beta ventures");
    expect(spans).toContain("acme corp");
    expect(spans).toContain("acme");
    expect(spans).toContain("corp");
    expect(spans).not.toContain("at acme");
    expect(spans).not.toContain("corp and");
    expect(spans).not.toContain("who");
  });
  it("is case-insensitive and strips possessives", () => {
    expect(candidateSpans("Who led Acme's Series B?")).toEqual(expect.arrayContaining(["Acme", "Series B", "Acme Series B", "Series", "B"]));
  });
  it("returns nothing for a stopword-only query", () => {
    expect(candidateSpans("what is the")).toEqual([]);
  });
});

describe("dropContainedSpans", () => {
  it("keeps the longest matched span and drops matches contained in it", () => {
    const kept = dropContainedSpans([
      { id: "1", type: "organization", name: "Databricks", matchedSpan: "databricks" },
      { id: "2", type: "concept", name: "Databricks cost governance", matchedSpan: "databricks cost governance" },
      { id: "3", type: "place", name: "Austin", matchedSpan: "austin" },
    ]);
    expect(kept.map((k) => k.id)).toEqual(["2", "3"]);
  });
  it("keeps both when the same node matched two unrelated spans", () => {
    const kept = dropContainedSpans([
      { id: "1", type: "organization", name: "Acme", matchedSpan: "acme" },
      { id: "1", type: "organization", name: "Acme", matchedSpan: "acme corp" },
    ]);
    expect(kept).toEqual([{ id: "1", type: "organization", name: "Acme", matchedSpan: "acme corp" }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/entities.test.ts`
Expected: FAIL: `does not provide an export named 'candidateSpans'`

- [ ] **Step 3: Rewrite `src/retrieve/entities.ts`**

```ts
import type { Db } from "../db.js";
import { canonicalName } from "../text/normalize.js";

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "for", "to", "in", "on", "at", "with", "about", "from", "by", "as",
  "my", "me", "i", "you", "your", "we", "our", "it", "its", "this", "that", "these", "those",
  "do", "does", "did", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "what", "who", "where", "when", "why", "how", "which", "tell", "show", "list", "find", "give", "can", "know", "knows", "say", "said",
]);

const MAX_SPAN = 3;

function tokens(query: string): string[] {
  return query
    .replace(/["“”?,!;:()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^(.+?)(?:['’]s|['’])$/, "$1").replace(/\.$/, ""))
    .filter(Boolean);
}

/** Quoted strings plus every 1..3-token span whose first and last token are not stopwords. Case is kept for display; matching is canonical. */
export function candidateSpans(query: string): string[] {
  const spans = new Set<string>();
  for (const m of query.matchAll(/["“]([^"”]+)["”]/g)) spans.add(m[1].trim());
  const toks = tokens(query);
  for (let n = MAX_SPAN; n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const span = toks.slice(i, i + n);
      if (STOPWORDS.has(span[0].toLowerCase()) || STOPWORDS.has(span[n - 1].toLowerCase())) continue;
      spans.add(span.join(" "));
    }
  }
  return [...spans].filter((s) => s.length > 1);
}

export interface EntityRef {
  id: string;
  type: string;
  name: string;
  /** The canonicalised query span that matched this node. */
  matchedSpan: string;
}

function containsSpan(longer: string, shorter: string): boolean {
  return longer !== shorter && (` ${longer} `).includes(` ${shorter} `);
}

/** Longest span wins: a match whose span is contained in another match's span is dropped; one row per (node, span). */
export function dropContainedSpans(refs: EntityRef[]): EntityRef[] {
  const spans = new Set(refs.map((r) => r.matchedSpan));
  const kept = refs.filter((r) => ![...spans].some((s) => containsSpan(s, r.matchedSpan)));
  const byNode = new Map<string, EntityRef>();
  for (const r of kept) if (!byNode.has(r.id) || r.matchedSpan.length > byNode.get(r.id)!.matchedSpan.length) byNode.set(r.id, r);
  return [...byNode.values()];
}

export async function detectEntities(sql: Db, query: string): Promise<EntityRef[]> {
  const keys = [...new Set(candidateSpans(query).map(canonicalName).filter(Boolean))];
  if (keys.length === 0) return [];
  const rows = await sql<EntityRef[]>`
    select distinct x.id, x.type, x.name, k.key as "matchedSpan"
    from unnest(${keys}::text[]) as k(key)
    join brain.nodes n
      on n.canonical_name = k.key
      or exists (select 1 from unnest(n.aliases) a where brain.canonical_text(a) = k.key)
    join brain.nodes x on x.id = brain.canonical_node(n.id)
    order by x.name`;
  return dropContainedSpans(rows);
}
```

Aliases are stored as the extractor wrote them, so the alias side is canonicalised in SQL. Create `supabase/migrations/20260930000008_neighbors_index.sql` now with this one function (Tasks 4 and 5 append to the same file):
```sql
-- Canonical form of a name, matching canonicalName in src/text/normalize.ts:
-- lowercase, apostrophes removed, every other run of non-alphanumerics becomes one space, trimmed.
create or replace function brain.canonical_text(s text) returns text language sql immutable as $$
  select btrim(regexp_replace(lower(replace(replace(s, '''', ''), '’', '')), '[^[:alnum:]]+', ' ', 'g'));
$$;
```

Add to `test/integration/keyword.test.ts` (it already has a `sql` handle):
```ts
describe("canonical_text", () => {
  it("matches canonicalName", async () => {
    const [r] = await sql<{ t: string }[]>`select brain.canonical_text(${"  Acme’s  Corp., Inc! "}) as t`;
    expect(r.t).toBe("acmes corp inc");
  });
});
```

- [ ] **Step 4: Keep `matchedSpan` on `EntityHit` and the integration test**

`EntityHit extends EntityRef` in `search.ts` already carries the new field. Add to `test/integration/search.test.ts`:
```ts
  it("detects an entity from a lowercase query and expands its neighbours", async () => {
    const ctx = await seed();
    const res = await search(ctx, "what did zorblax industries release?");
    expect(res.entities.map((e) => e.name)).toContain("Zorblax Industries");
    expect(res.entities[0].matchedSpan).toBe("zorblax industries");
    expect(res.entities[0].neighbors.map((n) => n.name)).toContain("Austin");
  });
```

- [ ] **Step 5: Run unit and integration tests**

Run: `npx vitest run test/unit/entities.test.ts && npm run test:int -- test/integration/search.test.ts`
Expected: PASS. If the first existing test ("finds a keyword hit, resolves the entity...") now returns two entities (Zorblax Industries and Austin, since "austin" is not in that query it should not), inspect `res.entities` and confirm only spans present in the query matched.

- [ ] **Step 6: Full suite, eval, commit**

Run: `npm run test:unit && npm run test:int && npm run eval:run`
Expected: all green; `q09` ("What is the ZX-9000?") and lowercase variants benefit.

```bash
git add src/retrieve/entities.ts test/unit/entities.test.ts test/integration/search.test.ts
git commit -m "Entity detection matches query spans against node names without needing capitals

Eval vs baseline: recall@10 <delta>, mrr <delta>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Per-term fallback scan

**Files:**
- Create: `src/retrieve/fallback.ts`
- Create: `test/unit/fallback.test.ts`
- Modify: `src/retrieve/search.ts` (fallback block)
- Modify: `test/integration/search.test.ts`

- [ ] **Step 1: Write the failing unit test**

`test/unit/fallback.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { triggerTerms } from "../../src/retrieve/fallback.js";

describe("triggerTerms", () => {
  it("picks quoted strings and tokens containing digits or symbols", () => {
    expect(triggerTerms('what is the "ZX-9000" and X-90 at $115k on rerank-2.5?')).toEqual(["ZX-9000", "X-90", "$115k", "rerank-2.5"]);
  });
  it("returns nothing for a plain natural-language question", () => {
    expect(triggerTerms("What did Zorblax Industries release?")).toEqual([]);
  });
  it("ignores LIKE metacharacters on their own", () => {
    expect(triggerTerms("%")).toEqual([]);
    expect(triggerTerms("_")).toEqual([]);
  });
  it("deduplicates", () => {
    expect(triggerTerms("F-1 or F-1")).toEqual(["F-1"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/fallback.test.ts`
Expected: FAIL: cannot find module.

- [ ] **Step 3: Write `src/retrieve/fallback.ts`**

```ts
/**
 * Terms worth a literal substring scan: quoted strings, and tokens that contain a digit or a symbol
 * (product codes, dollar figures, version numbers, visa classes). The tokenizer mangles these, so
 * keyword search can miss them; natural-language words are left to the keyword and vector layers.
 */
export function triggerTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const m of query.matchAll(/["“]([^"”]+)["”]/g)) terms.add(m[1].trim());
  const rest = query.replace(/["“][^"”]+["”]/g, " ");
  for (const raw of rest.split(/\s+/)) {
    const t = raw.replace(/^[?,!;:()]+|[?,!;:()]+$/g, "");
    if (t.length < 2) continue;
    if (!/[\p{L}\p{N}]/u.test(t)) continue; // "%" or "_" alone
    if (/\p{N}/u.test(t) || /[^\p{L}\p{N}\s]/u.test(t)) terms.add(t);
  }
  return [...terms];
}
```

- [ ] **Step 4: Replace the fallback block in `search.ts`**

Replace everything from `// Fallback: raw substring scan when the best reranked hit is weak.` through the end of the `if (...) { ... }` block with:

```ts
  // Fallback: literal substring scan for exact-string terms (codes, figures, versions), when the search
  // was degraded or the best reranked hit is weak. Natural-language queries have no trigger terms and skip it.
  const topScore = passages.find((p) => p.group === "hybrid")?.score ?? null;
  let usedFallback = false;
  const terms = triggerTerms(query);
  const weak = degraded || topScore === null || topScore < config.retrieval.fallbackThreshold;
  if (terms.length && weak) {
    const hits = await sql<{ id: string; title: string | null; source_kind: string; raw_content: string; matched: string[]; n: number }[]>`
      select d.id, d.title, d.source_kind, d.raw_content,
             array(select t from unnest(${terms}::text[]) t where d.raw_content ilike '%' || brain.like_literal(t) || '%') as matched,
             (select count(*) from unnest(${terms}::text[]) t where d.raw_content ilike '%' || brain.like_literal(t) || '%') as n
      from brain.documents d
      where (${kinds}::text[] is null or d.source_kind = any(${kinds}::text[]))
        and ${inDateRange(sql, "d", since, until)}
        and exists (select 1 from unnest(${terms}::text[]) t where d.raw_content ilike '%' || brain.like_literal(t) || '%')
      order by n desc, coalesce(d.occurred_at, d.ingested_at) desc
      limit 10`;
    for (const h of hits) {
      usedFallback = true;
      const term = h.matched[0];
      const at = Math.max(0, h.raw_content.toLowerCase().indexOf(term.toLowerCase()));
      const start = Math.max(0, at - 200);
      const end = Math.min(h.raw_content.length, at + term.length + 200);
      passages.push({
        chunkId: null,
        documentId: h.id,
        documentTitle: h.title,
        sourceKind: h.source_kind,
        content: h.raw_content.slice(start, end),
        parentContent: null,
        headingPath: [],
        charStart: start,
        charEnd: end,
        score: 0,
        group: "fallback",
      });
    }
  }
```

Add the import at the top of `search.ts`: `import { triggerTerms } from "./fallback.js";`. Delete the now-unused `likeLiteral` function from `search.ts`.

Append `brain.like_literal` to `supabase/migrations/20260930000008_neighbors_index.sql` (the file was created in Task 3 with `canonical_text`; `test:int` applies it):
```sql
-- LIKE escaping for the fallback scan (default escape character is backslash).
create or replace function brain.like_literal(s text) returns text language sql immutable as $$
  select replace(replace(replace(s, '\', '\\'), '%', '\%'), '_', '\_');
$$;
```

- [ ] **Step 5: Update the integration tests**

In `test/integration/search.test.ts`, replace the test "treats LIKE metacharacters in the query literally in the fallback scan" with:
```ts
  it("does not scan for a plain natural-language question even when nothing ranks well", async () => {
    const ctx = await seed();
    ctx.reranker = { rerank: async (_q, docs, k) => docs.slice(0, k).map((_d, index) => ({ index, score: 0.01 })) };
    const res = await search(ctx, "tell me about gardening in winter");
    expect(res.usedFallback).toBe(false);
    expect(res.passages.filter((p) => p.group === "fallback")).toEqual([]);
  });

  it("treats LIKE metacharacters inside a trigger term literally", async () => {
    const ctx = await seed();
    for (const q of ["100%", "a_b-1"]) {
      const res = await search(ctx, q);
      expect(res.passages.filter((p) => p.group === "fallback")).toEqual([]);
    }
  });

  it("ranks fallback hits by how many trigger terms they contain", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "Order X-90 and ZX-9000 together.", sourceKind: "note", title: "Both" });
    await ingest(ctx, { text: "Only the X-90 here.", sourceKind: "note", title: "One" });
    const res = await search(ctx, "X-90 ZX-9000");
    const fb = res.passages.filter((p) => p.group === "fallback");
    expect(fb[0].documentTitle).toBe("Both");
  });
```

The existing "falls back to a raw substring scan when nothing ranks well" test (query `X-90`) stays and must still pass.

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/unit/fallback.test.ts && npm run test:int -- test/integration/search.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, eval, commit**

Run: `npm run test:int && npm run eval:run`
Expected: green; `q13` and `q14` (fallback kind) unchanged or better.

```bash
git add src/retrieve/fallback.ts src/retrieve/search.ts test/unit/fallback.test.ts test/integration/search.test.ts supabase/migrations/20260930000008_neighbors_index.sql
git commit -m "Fallback scans per exact-string term instead of the whole query

Eval vs baseline: recall@10 <delta>, mrr <delta>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Neighbor walk on indexed columns, with budgets for neighbours, graph passages and facts

**Files:**
- Modify: `supabase/migrations/20260930000008_neighbors_index.sql` (add to the file started in Task 4)
- Modify: `src/retrieve/search.ts` (graph and facts layers)
- Modify: `test/integration/search-plan.test.ts`
- Modify: `test/integration/search.test.ts`

- [ ] **Step 1: Write the failing plan test**

Add to `test/integration/search-plan.test.ts`:
```ts
  it("neighbors() reaches edges through edges_from_idx and edges_to_idx", async () => {
    const ctx = fakeCtx(sql, ({ system, user }) =>
      system.includes("summar")
        ? { title: "Z", summary_line: "Z.", summary: "Z.", occurred_at: null }
        : { entities: [{ key: "z", type: "organization", name: "Zorblax Industries", aliases: [], untyped_hint: null, quote: "Zorblax" },
                        { key: "a", type: "place", name: "Austin", aliases: [], untyped_hint: null, quote: "Austin" }],
            relations: [{ from_key: "z", to_key: "a", type: "located_in", confidence: 0.9, valid_from: null, valid_to: null, quote: "Zorblax in Austin" }],
            facts_about_self: [] });
    await ingest(ctx, { text: "Zorblax in Austin.", sourceKind: "news", title: "Z" });
    const [z] = await sql<{ id: string }[]>`select id from brain.nodes where canonical_name = 'zorblax industries'`;
    const p = await plan(`select * from brain.neighbors('${z.id}'::uuid, 1, null)`);
    expect(p).toMatch(/edges_from_idx|edges_to_idx/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:int -- test/integration/search-plan.test.ts`
Expected: the new test fails: the plan shows a sequential scan on `edges` (or `Function Scan on neighbors` without index names).

- [ ] **Step 3: Complete the migration**

Append to `supabase/migrations/20260930000008_neighbors_index.sql` (after `canonical_text` from Task 3 and `like_literal` from Task 4):
```sql
-- The old walk joined on canonical_node(e.from_node), which hid the column from the edge indexes and
-- ran a recursive function per edge row. The walk now expands the current node to its member ids
-- (itself plus everything merged into it) once per step and joins on the raw columns.
create index if not exists nodes_merged_into_idx on brain.nodes (merged_into);

create or replace function brain.node_members(p_canonical uuid) returns uuid[]
language sql stable as $$
  with recursive m as (
    select p_canonical as id
    union all
    select n.id from brain.nodes n join m on n.merged_into = m.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) from m;
$$;

create or replace function brain.neighbors(
  p_start uuid,
  p_depth int default 1,
  p_edge_types text[] default null
) returns table (node_id uuid, depth int, via_edge uuid) language sql stable as $$
  with recursive walk as (
    select brain.canonical_node(p_start) as node_id, 0 as depth, null::uuid as via_edge
    union
    select brain.canonical_node(case when e.from_node = any (mem.ids) then e.to_node else e.from_node end),
           w.depth + 1,
           e.id
    from walk w
    cross join lateral (select brain.node_members(w.node_id) as ids) mem
    join brain.edges e on e.from_node = any (mem.ids) or e.to_node = any (mem.ids)
    where w.depth < least(p_depth, 2)
      and (p_edge_types is null or e.type = any (p_edge_types))
  )
  select w.node_id, min(w.depth)::int, (array_agg(w.via_edge order by w.depth))[1]
  from walk w
  where w.depth > 0 and w.node_id <> brain.canonical_node(p_start)
  group by w.node_id;
$$;
```

- [ ] **Step 4: Run the plan test and the existing graph tests**

Run: `npm run test:int -- test/integration/search-plan.test.ts test/integration/functions.test.ts test/integration/inspect.test.ts`
Expected: PASS. `functions.test.ts` exercises `neighbors` through merged nodes and depth 2; both behaviours are preserved because `node_members` returns the merged set and the recursion is unchanged.

- [ ] **Step 5: Write the failing budget tests**

Add to `test/integration/search.test.ts`:
```ts
  it("caps neighbours and graph passages per entity and orders graph passages by document date", async () => {
    const ctx = fakeCtx(sql, ({ system, user }) => {
      if (system === SUMMARY_SYSTEM) return { title: "Untitled", summary_line: "A note.", summary: user.slice(0, 80), occurred_at: null };
      const m = /Zorblax mention (\d+)/.exec(user);
      return m
        ? { entities: [{ key: "z", type: "organization", name: "Zorblax Industries", aliases: [], untyped_hint: null, quote: "Zorblax" },
                        { key: "p", type: "place", name: `Place ${m[1]}`, aliases: [], untyped_hint: null, quote: `Place ${m[1]}` }],
            relations: [{ from_key: "z", to_key: "p", type: "located_in", confidence: Number(m[1]) / 100, valid_from: null, valid_to: null, quote: "Zorblax" }],
            facts_about_self: [] }
        : { entities: [], relations: [], facts_about_self: [] };
    });
    for (let i = 1; i <= 25; i++) {
      await ingest(ctx, { text: `Zorblax mention ${i} in Place ${i}.`, sourceKind: "note", title: `M${i}`, occurredAt: new Date(Date.UTC(2026, 0, i)) });
    }
    const res = await search(ctx, "Zorblax Industries", { includeFacts: false });
    const z = res.entities.find((e) => e.name === "Zorblax Industries")!;
    expect(z.neighbors.length).toBe(config.graph.maxNeighbors);
    expect(z.neighbors[0].name).toBe("Place 25"); // highest edge confidence first
    const graph = res.passages.filter((p) => p.group === "graph");
    expect(graph.length).toBeLessThanOrEqual(config.graph.maxPassagesPerEntity);
    expect(graph[0].documentTitle).toBe("M25"); // newest document first
  });

  it("returns only facts that overlap the query or its detected entities, capped", async () => {
    const ctx = fakeCtx(sql, ({ system, user }) =>
      system === SUMMARY_SYSTEM
        ? { title: "Me", summary_line: "About me.", summary: "About me.", occurred_at: null }
        : { entities: [], relations: [],
            facts_about_self: Array.from({ length: 15 }, (_, i) => ({ predicate: i === 0 ? "lives_in" : `skill_${i}`, object_text: i === 0 ? "Austin" : `thing ${i}`, object_key: null, confidence: 0.9, valid_from: null, valid_to: null, quote: "I" })) });
    await ingest(ctx, { text: "I live in Austin. I know many things.", sourceKind: "note", title: "Me" });
    const res = await search(ctx, "where do I live");
    expect(res.facts.map((f) => f.predicate)).toEqual(["lives_in"]);
    const all = await search(ctx, "skill");
    expect(all.facts.length).toBeLessThanOrEqual(config.graph.maxFacts);
  });
```

`config` is already imported at the top of this test file.

- [ ] **Step 6: Run them to verify they fail**

Run: `npm run test:int -- test/integration/search.test.ts`
Expected: the neighbours test fails on `length` (25 instead of 20); the facts test fails because all 15 facts come back.

- [ ] **Step 7: Rewrite the graph and facts layers in `search.ts`**

Replace the `// Layer 4` block through the end of the `// Layer 5` block with:

```ts
  // Layer 4: graph expansion from entities named in the query, with budgets.
  const entities: EntityHit[] = [];
  for (const ref of entityRefs) {
    const neighbors = await sql<Neighbor[]>`
      select nb.node_id as id, x.type, x.name, nb.depth
      from brain.neighbors(${ref.id}, 1, null) nb
      join brain.nodes x on x.id = nb.node_id
      left join brain.edges e on e.id = nb.via_edge
      where nb.depth > 0 and ${opts.verifiedOnly ? sql`x.verified` : sql`true`}
      order by nb.depth, e.confidence desc nulls last, x.name
      limit ${config.graph.maxNeighbors}`;
    entities.push({ ...ref, neighbors });
    // A mention stored on a level-0 section (quote not located) maps to that section's first passage.
    const mentioned = await sql<{ id: string }[]>`
      select distinct on (passage_id) passage_id as id, coalesce(d.occurred_at, d.ingested_at) as at, c.ordinal
      from (
        select m.node_id, c0.document_id, c0.ordinal,
               case when c0.level = 1 then c0.id
                    else (select p.id from brain.chunks p where p.parent_id = c0.id order by p.ordinal limit 1) end as passage_id
        from brain.mentions m join brain.chunks c0 on c0.id = m.chunk_id
        where m.node_id = ${ref.id}
      ) c
      join brain.documents d on d.id = c.document_id
      where c.passage_id is not null
        and (${kinds}::text[] is null or d.source_kind = any(${kinds}::text[]))
        and ${inDateRange(sql, "d", since, until)}
      order by passage_id, at desc, c.ordinal`;
    const ordered = await sql<{ id: string }[]>`
      select c.id from brain.chunks c join brain.documents d on d.id = c.document_id
      where c.id = any(${mentioned.map((m) => m.id)}::uuid[])
      order by coalesce(d.occurred_at, d.ingested_at) desc, c.ordinal
      limit ${config.graph.maxPassagesPerEntity}`;
    const newIds = ordered.map((m) => m.id).filter((id) => !seen.has(id));
    const extra = await loadChunks(sql, newIds);
    for (const id of newIds) {
      const row = extra.get(id);
      if (!row) continue;
      passages.push(toPassage(row, 0, "graph"));
      seen.add(row.id);
    }
  }

  // Layer 5: facts whose predicate, value or linked node overlaps the query, capped.
  let facts: FactRow[] = [];
  if (opts.includeFacts !== false) {
    const entityIds = entities.map((e) => e.id);
    const rowsF = await sql<{ id: string; predicate: string; object_text: string; confidence: number | null; verified: boolean; source_chunk_id: string | null }[]>`
      select f.id, f.predicate, f.object_text, f.confidence, f.verified, f.source_chunk_id
      from brain.current_facts(null) f
      cross join (select brain.query_to_tsquery(${query}) as q) q
      where (q.q is not null and to_tsvector('english', replace(f.predicate, '_', ' ') || ' ' || f.object_text) @@ q.q)
         or f.object_node_id = any(${entityIds}::uuid[])
      order by f.verified desc, f.confidence desc nulls last, f.created_at desc
      limit ${config.graph.maxFacts}`;
    facts = rowsF
      .filter((f) => !opts.verifiedOnly || f.verified)
      .map((f) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text, confidence: f.confidence, verified: f.verified, sourceChunkId: f.source_chunk_id }));
  }
```

- [ ] **Step 8: Run the search tests**

Run: `npm run test:int -- test/integration/search.test.ts`
Expected: PASS, including the first existing test, which expects `visa_status` in the facts for "What did Zorblax Industries release?". That fact has no term overlap with the query and no object node, so it is no longer returned: change that assertion to `expect(res.facts).toEqual([])` and add a second search in the same test, `await search(ctx, "visa status")`, asserting `res.facts.map((f) => f.predicate)` contains `visa_status`.

- [ ] **Step 9: Full suite, apply migration, eval, commit**

Run:
```bash
npm run test:int
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20260930000008_neighbors_index.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20260930000008_neighbors_index.sql
npm run eval:run
```
Expected: green; no `GATE:` lines.

```bash
git add supabase/migrations/20260930000008_neighbors_index.sql src/retrieve/search.ts test/integration/search-plan.test.ts test/integration/search.test.ts
git commit -m "Neighbor walk uses the edge indexes; neighbours, graph passages and facts are budgeted per search

Eval vs baseline: recall@10 <delta>, mrr <delta>.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `verified_only` description, README, and phase acceptance

**Files:**
- Modify: `src/mcp/server.ts` (the `verified_only` zod description in `brain_search`)
- Modify: `README.md`

- [ ] **Step 1: Fix the tool description**

In `src/mcp/server.ts`, find the `verified_only` field in the `brain_search` input schema and set its description to:
```ts
verified_only: z.boolean().optional().describe("Only return facts and neighbour nodes marked verified. Passages are never filtered: documents have no verification state."),
```

- [ ] **Step 2: README**

Under `## MCP`, after the `brain_search` bullet, add:
```markdown
  Search runs five layers: hybrid (vector + OR-of-stems keyword over title, headings and content, fused with RRF and reranked), document summaries, graph expansion from entities named in the query (any case; at most 20 neighbours and 5 passages per entity), facts overlapping the query (at most 10), and a literal scan for exact-string terms such as codes or figures when the best hit is weak. `verified_only` filters facts and neighbours only.
```

- [ ] **Step 3: Run everything and accept the new baseline**

Run: `npm run typecheck && npm test && npm run eval:run`
Expected: all green. Review the printed deltas and the per-question `worse`/`better` lines. If any question got worse, explain why in the commit message of the task that caused it before accepting; otherwise:

Run: `npm run brain -- eval run --accept`

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.ts README.md eval/baseline.json
git commit -m "Phase 1 complete: retrieval correctness; new eval baseline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §3.1: Task 1 (SQL, GUCs in a transaction, candidate pool 60 for both functions, EXPLAIN test).
- Spec §3.2: Task 2 (`query_to_tsquery`, phrase matches, weighted tsvectors, rank normalisation 32).
- Spec §3.3: Task 3 (spans, canonical lookup in one SQL call, longest span wins, quoted strings).
- Spec §3.4: Task 4 (`triggerTerms`, per-term ILIKE, ranked by matches then date, no scan without trigger terms).
- Spec §3.5: Task 5 (indexed walk, 20 neighbours by confidence, 5 passages by date then ordinal, level-0 mention mapping, 10 overlapping facts).
- Spec §3.6: Task 6.
- Types: `config.graph.{maxNeighbors,maxPassagesPerEntity,maxFacts}` and `config.retrieval.efSearch` are introduced in Task 1 and used in Tasks 5 and 1. `EntityRef.matchedSpan` is introduced in Task 3 and read by `EntityHit` through inheritance. `brain.like_literal` is created in Task 4's migration file and used by Task 4's SQL. `brain.query_to_tsquery` is created in Task 2 and reused for fact overlap in Task 5.
- Known caveat for Task 2: the exact tsquery text in the first unit assertion depends on the English stemmer output; the step says to copy actual output once if "texa" differs.
