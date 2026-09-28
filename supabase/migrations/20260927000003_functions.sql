-- Follow merged_into to the canonical node. Bounded to 10 hops.
create or replace function brain.canonical_node(node uuid)
returns uuid language sql stable as $$
  with recursive walk as (
    select id, merged_into, 0 as d from brain.nodes where id = node
    union all
    select n.id, n.merged_into, w.d + 1 from walk w join brain.nodes n on n.id = w.merged_into where w.d < 10
  )
  select id from walk where merged_into is null limit 1;
$$;

-- Candidates from both indexes with their ranks. Fusion happens in the application.
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
      and c.embedding is not null
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
  ),
  vec as (
    select id, document_id,
           row_number() over (order by embedding <=> query_embedding) as r,
           1 - (embedding <=> query_embedding) as score
    from filtered
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
    where d.summary_embedding is not null
      and (source_kinds is null or d.source_kind = any (source_kinds))
      and (since is null or coalesce(d.occurred_at, d.ingested_at) >= since)
      and (until is null or coalesce(d.occurred_at, d.ingested_at) <= until)
  ),
  vec as (
    select id, row_number() over (order by summary_embedding <=> query_embedding) as r,
           1 - (summary_embedding <=> query_embedding) as score
    from filtered order by summary_embedding <=> query_embedding limit k
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

-- Graph walk. Depth capped at 2. Edges are followed in both directions; nodes resolve through merged_into.
-- Parameters carry a p_ prefix: in a SQL function a same-named CTE column (depth) would shadow them.
-- Terminates on cycles because every recursive step increments depth and depth is bounded.
create or replace function brain.neighbors(
  p_start uuid,
  p_depth int default 1,
  p_edge_types text[] default null
) returns table (node_id uuid, depth int, via_edge uuid) language sql stable as $$
  with recursive walk as (
    select brain.canonical_node(p_start) as node_id, 0 as depth, null::uuid as via_edge
    union
    select brain.canonical_node(case when e.from_node = w.node_id or brain.canonical_node(e.from_node) = w.node_id
                                     then e.to_node else e.from_node end),
           w.depth + 1,
           e.id
    from walk w
    join brain.edges e
      on brain.canonical_node(e.from_node) = w.node_id or brain.canonical_node(e.to_node) = w.node_id
    where w.depth < least(p_depth, 2)
      and (p_edge_types is null or e.type = any (p_edge_types))
  )
  select w.node_id, min(w.depth)::int, (array_agg(w.via_edge order by w.depth))[1]
  from walk w
  where w.depth > 0 and w.node_id <> brain.canonical_node(p_start)
  group by w.node_id;
$$;

-- Current view of facts: not superseded, not expired. Null subject means the self node.
create or replace function brain.current_facts(subject uuid default null)
returns table (
  id uuid, subject_id uuid, predicate text, object_text text, object_node_id uuid,
  confidence real, source_chunk_id uuid, verified boolean, valid_from date, valid_to date, created_at timestamptz
) language sql stable as $$
  select f.id, f.subject_id, f.predicate, f.object_text, f.object_node_id,
         f.confidence, f.source_chunk_id, f.verified, f.valid_from, f.valid_to, f.created_at
  from brain.facts f
  where f.subject_id = coalesce(subject, (select id from brain.nodes where is_self))
    and f.superseded_by is null
    and (f.valid_to is null or f.valid_to >= current_date)
  order by f.predicate, f.created_at;
$$;
