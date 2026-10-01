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

commit;
