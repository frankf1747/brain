-- Phase 5: deterministic citation verification (spec §7).
-- 1. brain.retrieval_log.facts: the facts each search returned, in order (index 0 is F1), so brain_verify can resolve
--    F labels exactly as the search showed them. Rows logged before this migration have it null; their F labels
--    are reported as bad citations, with that reason.
-- 2. brain.verification_log: one row per brain_verify call (and per `brain verify` and `brain ask`): the claims as
--    given, each claim's verdict and evidence, and the summary. No foreign key to retrieval_log, so an audit row
--    outlives any later cleanup of the search log.
-- Idempotent: safe to apply more than once.

begin;

alter table brain.retrieval_log add column if not exists facts jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'retrieval_log_facts_check' and conrelid = 'brain.retrieval_log'::regclass) then
    alter table brain.retrieval_log
      add constraint retrieval_log_facts_check check (facts is null or jsonb_typeof(facts) = 'array');
  end if;
end $$;

comment on column brain.retrieval_log.facts is
  'Phase 5: the facts the search returned, in order (index 0 is F1): id, predicate, objectText, confidence, verified, verifiedBy, sourceChunkId, sourceDocumentId, sourceKind. Null on rows logged before migration 012.';

create table if not exists brain.verification_log (
  id uuid primary key default gen_random_uuid(),
  retrieval_id uuid not null,
  client text not null,
  claims jsonb not null check (jsonb_typeof(claims) = 'array'),
  results jsonb not null check (jsonb_typeof(results) = 'array'),
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists verification_log_retrieval_id on brain.verification_log (retrieval_id);
create index if not exists verification_log_created_at on brain.verification_log (created_at desc);
alter table brain.verification_log enable row level security;

comment on table brain.verification_log is
  'Phase 5: one row per citation check. claims: [{text, cites}] as given. results: per claim, verdict, support, matchedTerms, missingTerms, missingNumbers, negationMismatch, badLabels and the resolved cites. summary: counts per verdict and the one-line text.';

commit;
