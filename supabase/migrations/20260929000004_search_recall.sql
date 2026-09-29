-- Recall guarantee: keyword matches must not wait for embeddings.
-- The "has an embedding" condition moves from the shared filtered CTE into the vector CTE only,
-- and a null query_embedding makes the vector side return nothing (keyword-only search).

create or replace function brain.hybrid_search(
  query_text text,
  query_embedding vector(1024),
  k int default 40,
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
  with filtered as (
    select c.id, c.document_id, c.embedding, c.tsv
    from brain.chunks c
    join brain.documents d on d.id = c.document_id
    where c.level = 1
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
  ),
  vec as (
    select id, document_id,
           row_number() over (order by embedding <=> query_embedding) as r,
           1 - (embedding <=> query_embedding) as score
    from filtered
    where embedding is not null
      and query_embedding is not null
    order by embedding <=> query_embedding
    limit k
  ),
  kw as (
    select f.id, f.document_id,
           row_number() over (order by ts_rank_cd(f.tsv, q) desc) as r
    from filtered f, websearch_to_tsquery('english', query_text) q
    where f.tsv @@ q
    order by ts_rank_cd(f.tsv, q) desc
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
  k int default 10,
  source_kinds text[] default null,
  since timestamptz default null,
  until timestamptz default null
) returns table (
  document_id uuid,
  vector_rank int,
  keyword_rank int,
  vector_score real
) language sql stable as $$
  with filtered as (
    select d.id, d.summary_embedding, d.summary_tsv
    from brain.documents d
    where (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
  ),
  vec as (
    select id, row_number() over (order by summary_embedding <=> query_embedding) as r,
           1 - (summary_embedding <=> query_embedding) as score
    from filtered
    where summary_embedding is not null
      and query_embedding is not null
    order by summary_embedding <=> query_embedding limit k
  ),
  kw as (
    select f.id, row_number() over (order by ts_rank_cd(f.summary_tsv, q) desc) as r
    from filtered f, websearch_to_tsquery('english', query_text) q
    where f.summary_tsv @@ q
    order by ts_rank_cd(f.summary_tsv, q) desc limit k
  )
  select coalesce(vec.id, kw.id), vec.r::int, kw.r::int, vec.score::real
  from vec full outer join kw on vec.id = kw.id;
$$;
