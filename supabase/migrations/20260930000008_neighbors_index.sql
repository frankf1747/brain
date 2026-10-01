-- Canonical form of a name, matching canonicalName in src/text/normalize.ts:
-- lowercase, apostrophes removed, every other run of non-alphanumerics becomes one space, trimmed.
create or replace function brain.canonical_text(s text) returns text language sql immutable as $$
  select btrim(regexp_replace(lower(replace(replace(s, '''', ''), '’', '')), '[^[:alnum:]]+', ' ', 'g'));
$$;

-- LIKE escaping for the fallback scan (default escape character is backslash).
create or replace function brain.like_literal(s text) returns text language sql immutable as $$
  select replace(replace(replace(s, '\', '\\'), '%', '\%'), '_', '\_');
$$;

-- Entity detection matches query spans against canonical_name; the unique index leads with type.
create index if not exists nodes_canonical_name_idx on brain.nodes (canonical_name);

-- The old walk joined on canonical_node(e.from_node), which hid the column from the edge indexes and
-- ran a recursive function per edge row. The walk now expands the current node to its member ids
-- (itself plus everything merged into it) once per step and joins on the raw columns.
create index if not exists nodes_merged_into_idx on brain.nodes (merged_into);

create or replace function brain.node_members(p_canonical uuid) returns uuid[]
language sql stable as $$
  with recursive m as (
    select p_canonical as id
    union
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
    cross join lateral (select brain.node_members(w.node_id) as ids offset 0) mem
    join brain.edges e on e.from_node = any (mem.ids) or e.to_node = any (mem.ids)
    where w.depth < least(p_depth, 2)
      and (p_edge_types is null or e.type = any (p_edge_types))
  )
  select w.node_id, min(w.depth)::int, (array_agg(w.via_edge order by w.depth))[1]
  from walk w
  where w.depth > 0 and w.node_id <> brain.canonical_node(p_start)
  group by w.node_id;
$$;

-- Graph passages: a mention stored on a level-0 section maps to that section's first level-1 passage.
create index if not exists chunks_parent_ordinal_idx on brain.chunks (parent_id, ordinal);
