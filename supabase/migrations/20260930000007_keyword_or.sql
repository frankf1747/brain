-- Keyword recall and ranking. websearch_to_tsquery ANDs every term, so a question had to match every
-- stem inside one ~400-token passage. The question is now split into units (brain.query_units): one
-- per quoted phrase and one per distinct unquoted stem of two or more characters. A passage matches
-- when it matches any unit (brain.query_to_tsquery is their OR, which the GIN index serves). Matches
-- are ranked by coverage, the number of distinct units the passage matches, so a passage that answers
-- more of the question beats one that repeats a single word; ties go to ts_rank_cd with normalisation 1
-- (divided by 1 + log(length), so long passages are not favoured), then to id.
-- The chunk tsvector is weighted content A, heading path B, context prefix C (title, summary line and
-- heading path, written by the embed stage). A word that appears only in the title or a heading still
-- finds the passage, while the passage's own text counts most in ts_rank_cd; the model-written summary
-- line, shared by every passage of a document, no longer ties them all at weight A.
--
-- One transaction: a failure between dropping the tsv columns and replacing the search functions
-- must not leave search broken.

begin;

create or replace function brain.query_units(q text) returns tsquery[]
language plpgsql immutable parallel safe as $$
declare
  units tsquery[] := '{}';
  m text[];
  u tsquery;
  lex text;
begin
  -- Quoted strings become phrase matches. An empty or stopword-only phrase is dropped (numnode = 0).
  -- The extraction pattern accepts empty quotes exactly like the strip pattern below, so "" cannot
  -- shift which quote pairs are read as phrases.
  for m in select regexp_matches(q, '"([^"]*)"', 'g') loop
    u := phraseto_tsquery('english', m[1]);
    if numnode(u) > 0 and not (u = any (units)) then
      units := units || u;
    end if;
  end loop;
  -- Every other stem of two or more characters, in query order. One-character lexemes (the "x" of
  -- X-90, the "o" of O'Neil) match far too much; exact strings like X-90 are the fallback scan's job.
  -- Each lexeme is written as a quoted tsquery literal (backslash and quote escaped), so operator
  -- characters in the question never reach the tsquery parser.
  for lex in
    select t.lexeme
    from unnest(to_tsvector('english', regexp_replace(q, '"[^"]*"', ' ', 'g'))) t
    where char_length(t.lexeme) >= 2
    order by t.positions[1]
  loop
    u := ('''' || replace(replace(lex, '\', '\\'), '''', '''''') || '''')::tsquery;
    if not (u = any (units)) then
      units := units || u;
    end if;
  end loop;
  return units;
end $$;

-- The OR of the units; null when there are none.
create or replace function brain.query_to_tsquery(q text) returns tsquery
language plpgsql immutable parallel safe as $$
declare
  result tsquery;
  u tsquery;
begin
  foreach u in array brain.query_units(q) loop
    result := case when result is null then u else result || u end;
  end loop;
  return result;
end $$;

-- Weighted chunk tsvector. A generated column may only reference its own row, and context_prefix
-- (title, summary line, heading path; written by the embed stage) is on the row. Dropping the column
-- drops its GIN index; it is recreated under the same name, which test/integration/search-plan.test.ts
-- asserts on. Adding a stored generated column computes it for every existing row.
-- array_to_string is only STABLE (it is polymorphic), and a generated column needs an IMMUTABLE
-- expression. For text[] it is immutable in practice, so it is wrapped once here.
create or replace function brain.heading_text(path text[]) returns text
language sql immutable parallel safe as $$ select array_to_string(path, ' ') $$;

drop index if exists brain.chunks_tsv_idx;
alter table brain.chunks drop column tsv;
alter table brain.chunks add column tsv tsvector generated always as (
  setweight(to_tsvector('english', content), 'A') ||
  setweight(to_tsvector('english', brain.heading_text(heading_path)), 'B') ||
  setweight(to_tsvector('english', coalesce(context_prefix, '')), 'C')
) stored;
create index chunks_tsv_idx on brain.chunks using gin (tsv);

drop index if exists brain.documents_summary_tsv_idx;
alter table brain.documents drop column summary_tsv;
alter table brain.documents add column summary_tsv tsvector generated always as (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(summary, '')), 'B')
) stored;
create index documents_summary_tsv_idx on brain.documents using gin (summary_tsv);

-- The functions below are migration 006's, unchanged except in the keyword (kw) branches:
-- brain.query_to_tsquery replaces websearch_to_tsquery, a null query (stopwords only) matches nothing,
-- and rows are ordered by coverage (distinct query units matched), then ts_rank_cd normalisation 1,
-- then id. Coverage is computed only for rows that already match the OR query, so its cost is bounded
-- by the GIN matches.

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
           row_number() over (order by cov.n desc, ts_rank_cd(c.tsv, q.q, 1) desc, c.id) as r
    from brain.chunks c
    join brain.documents d on d.id = c.document_id
    cross join (select brain.query_to_tsquery(query_text) as q, brain.query_units(query_text) as units) q
    cross join lateral (select count(*) as n from unnest(q.units) u where c.tsv @@ u) cov
    where c.level = 1
      and q.q is not null
      and c.tsv @@ q.q
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by cov.n desc, ts_rank_cd(c.tsv, q.q, 1) desc, c.id
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
           row_number() over (order by cov.n desc, ts_rank_cd(d.summary_tsv, q.q, 1) desc, d.id) as r
    from brain.documents d
    cross join (select brain.query_to_tsquery(query_text) as q, brain.query_units(query_text) as units) q
    cross join lateral (select count(*) as n from unnest(q.units) u where d.summary_tsv @@ u) cov
    where q.q is not null
      and d.summary_tsv @@ q.q
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
    order by cov.n desc, ts_rank_cd(d.summary_tsv, q.q, 1) desc, d.id
    limit k
  )
  select coalesce(vec.id, kw.id), vec.r::int, kw.r::int, vec.score::real
  from vec full outer join kw on vec.id = kw.id;
$$;

commit;
