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

-- (Task 7) True when following superseded_by from the fact reaches a fact the owner holds: the fact is the
-- record of an owner correction. UNION (not UNION ALL) stops on a cycle.
create or replace function brain.fact_corrected_by_owner(p_fact uuid) returns boolean
language sql stable as $$
  with recursive chain(id) as (
    select superseded_by from brain.facts where id = p_fact and superseded_by is not null
    union
    select f.superseded_by from brain.facts f join chain c on f.id = c.id where f.superseded_by is not null
  )
  select exists (
    select 1 from chain c join brain.facts f on f.id = c.id where brain.fact_owner_held(f.verified, f.verified_by));
$$;

commit;
