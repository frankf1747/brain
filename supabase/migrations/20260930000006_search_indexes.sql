-- The shared "filtered" CTE was materialised, so neither the HNSW nor the GIN index could be used:
-- every search computed a distance for every passage. Each branch now reads the base table directly
-- with the filters inlined; the chunk vector branch reads chunks alone and checks the document filters
-- with a correlated EXISTS, so the filter sits on the HNSW scan node. The caller sets hnsw.iterative_scan and hnsw.ef_search (src/retrieve/search.ts)
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
    -- Ranks come from a sort on the exact scores, not from index order: under
    -- hnsw.iterative_scan = relaxed_order the HNSW scan may return rows slightly out of order,
    -- and a window ordered by distance directly over the index scan would trust that order.
    select n.id, n.document_id,
           row_number() over (order by n.score desc, n.id) as r,
           n.score
    from (
      select c.id, c.document_id,
             1 - (c.embedding <=> query_embedding) as score
      from brain.chunks c
      where c.level = 1
        and c.embedding is not null
        and query_embedding is not null
        -- Not a join: with documents joined in, the planner sorts the join result and skips HNSW.
        -- An EXISTS nested under OR is not pulled up into a semi-join, so it stays a filter on the
        -- HNSW scan itself, and the iterative scan keeps going until k rows pass it. With no filters
        -- the OR folds to true (literal nulls) or short-circuits at run time (bound nulls).
        and ((source_kinds is null and since is null and until is null)
             or exists (
               select 1 from brain.documents d
               where d.id = c.document_id
                 and (source_kinds is null or d.source_kind = any (source_kinds))
                 and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
                 and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)))
      order by c.embedding <=> query_embedding
      limit k
    ) n
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
    -- Ranks from exact scores, not index order (see hybrid_search). Summaries are not reranked,
    -- so these ranks go straight into fusion.
    select n.id,
           row_number() over (order by n.score desc, n.id) as r,
           n.score
    from (
      select d.id,
             1 - (d.summary_embedding <=> query_embedding) as score
      from brain.documents d
      where d.summary_embedding is not null
        and query_embedding is not null
        and (source_kinds is null or d.source_kind = any (source_kinds))
        and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
        and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
      order by d.summary_embedding <=> query_embedding
      limit k
    ) n
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
