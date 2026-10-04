-- Phase 7: calibrated abstention.
-- brain.retrieval_log.evidence: whether the search's passages are likely to hold an answer, as the search judged it
-- ({level, basis, threshold}; src/retrieve/evidence.ts), so brain_explain replays the judgment with the threshold that
-- was in force. Rows logged before this migration have it null.
-- Idempotent: safe to apply more than once.

begin;

alter table brain.retrieval_log add column if not exists evidence jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'retrieval_log_evidence_check' and conrelid = 'brain.retrieval_log'::regclass) then
    alter table brain.retrieval_log
      add constraint retrieval_log_evidence_check check (evidence is null or jsonb_typeof(evidence) = 'object');
  end if;
end $$;

commit;
