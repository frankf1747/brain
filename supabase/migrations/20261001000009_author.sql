-- Phase 2: authorship and facts about the owner (spec §4).
-- Every statement is idempotent: later Phase 2 tasks insert blocks into this file (before the final commit)
-- and it is applied to brain_eval more than once. The documents backfill runs only when the author column is
-- first added, so re-applying the file never undoes a later `brain set-author`.

begin;

-- Default author by source kind.
-- KEEP IN SYNC with config.authorDefaults in src/config.ts; test/integration/author.test.ts fails when they differ.
create or replace function brain.default_author(kind text) returns text
language sql immutable parallel safe as $$
  select case kind
    when 'resume' then 'owner'
    when 'note' then 'owner'
    when 'conversation' then 'owner'
    when 'paste' then 'owner'
    when 'news' then 'other'
    when 'paper' then 'other'
    when 'job_description' then 'other'
    when 'email' then 'other'
    else 'unknown'
  end;
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'brain' and table_name = 'documents' and column_name = 'author'
  ) then
    alter table brain.documents
      add column author text not null default 'unknown'
      constraint documents_author_check check (author in ('owner', 'other', 'unknown'));
    update brain.documents set author = brain.default_author(source_kind);
  end if;
end $$;

-- Every supersession, restoration and removal of a fact. No foreign key on fact_id: the log outlives facts
-- that undoResolution deletes. detail carries what undo needs to restore a fact exactly
-- ({"superseded_by": id, "previous_valid_to": date|null} on 'superseded').
create table if not exists brain.fact_events (
  id bigint generated always as identity primary key,
  fact_id uuid not null,
  event text not null check (event in ('superseded', 'restored', 'removed')),
  by text not null,
  document_id uuid references brain.documents(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists fact_events_fact_idx on brain.fact_events (fact_id, created_at);
alter table brain.fact_events enable row level security;

-- undoResolution finds what a document produced by chunk.
create index if not exists facts_source_chunk_idx on brain.facts (source_chunk_id);
create index if not exists edges_evidence_chunk_idx on brain.edges (evidence_chunk_id);

-- (Task 7) The date a fact holds from, for deciding which of two single-valued facts is newer: its valid_from,
-- else its source document's occurred_at, else when that document was ingested, else (facts added by hand,
-- which have no source document) when the fact was recorded.
create or replace function brain.fact_effective_from(p_fact uuid) returns date
language sql stable as $$
  select coalesce(f.valid_from, d.occurred_at::date, d.ingested_at::date, f.created_at::date)
  from brain.facts f
  left join brain.chunks c on c.id = f.source_chunk_id
  left join brain.documents d on d.id = c.document_id
  where f.id = p_fact;
$$;

-- (Task 7) A fact the owner stands behind: verified, or written by someone other than the extractor. The one
-- definition undoResolution (keptCorrected) and resolve's insert guard share.
create or replace function brain.fact_owner_held(p_verified boolean, p_verified_by text) returns boolean
language sql immutable as $$
  select p_verified or coalesce(p_verified_by, '') not like 'extractor:%';
$$;

-- (Task 7) Who linked p_fact to p_to (superseded_by): the `by` of the latest 'superseded' event naming p_to,
-- or the detail's link_by when undo re-pointed the fact past removed facts (it carries the original link's
-- author forward). Null when no event records the link.
create or replace function brain.fact_link_by(p_fact uuid, p_to uuid) returns text
language sql stable as $$
  select coalesce(detail->>'link_by', by) from brain.fact_events
  where fact_id = p_fact and event = 'superseded' and detail->>'superseded_by' = p_to::text
  order by created_at desc, id desc
  limit 1;
$$;

-- (Task 7) A supersession link into an owner-held fact is an owner correction unless the extractor made it
-- (extraction parks a fact behind the owner's value; that is not a correction). An unrecorded link counts as
-- the owner's.
create or replace function brain.fact_link_is_correction(p_fact uuid, p_to uuid) returns boolean
language sql stable as $$
  select coalesce(brain.fact_link_by(p_fact, p_to), '') not like 'extractor:%';
$$;

-- (Task 7) True when the first owner-held fact reached by following superseded_by from the fact was linked
-- by an owner correction: the fact is the record of that correction.
create or replace function brain.fact_corrected_by_owner(p_fact uuid) returns boolean
language sql stable as $$
  with recursive chain(from_id, to_id, depth) as (
    select id, superseded_by, 1 from brain.facts where id = p_fact and superseded_by is not null
    union all
    select f.id, f.superseded_by, c.depth + 1
    from chain c join brain.facts f on f.id = c.to_id
    where f.superseded_by is not null
  ) cycle from_id set is_cycle using path
  select coalesce((
    select brain.fact_link_is_correction(c.from_id, c.to_id)
    from chain c join brain.facts t on t.id = c.to_id
    where not c.is_cycle and brain.fact_owner_held(t.verified, t.verified_by)
    order by c.depth
    limit 1), false);
$$;

commit;
