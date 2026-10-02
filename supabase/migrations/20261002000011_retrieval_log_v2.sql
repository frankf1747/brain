-- Phase 4: the evidence contract (spec §6.2). brain.retrieval_log keeps, per search, everything brain_explain needs
-- to replay it without searching again: each returned passage with its ranks, score and score kind (results, the
-- passages in rank order without their text), which parts fell back (degraded), how many candidates each branch
-- produced (candidates), stage timings (timings), the requested k, and the search mode.
-- The v1 columns (layers, top_score, used_fallback, chunk_ids, node_ids) stay and are still written. Rows logged
-- before this migration have the new columns null; brain_explain says "logged before evidence v2" for them.
-- Idempotent: safe to apply more than once.

begin;

alter table brain.retrieval_log
  add column if not exists results jsonb,
  add column if not exists degraded jsonb,
  add column if not exists candidates jsonb,
  add column if not exists timings jsonb,
  add column if not exists k int,
  add column if not exists mode text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'retrieval_log_mode_check' and conrelid = 'brain.retrieval_log'::regclass) then
    alter table brain.retrieval_log
      add constraint retrieval_log_mode_check check (mode is null or mode in ('hybrid', 'keyword-only', 'fused-order'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'retrieval_log_results_check' and conrelid = 'brain.retrieval_log'::regclass) then
    alter table brain.retrieval_log
      add constraint retrieval_log_results_check check (results is null or jsonb_typeof(results) = 'array');
  end if;
end $$;

create index if not exists retrieval_log_created_at on brain.retrieval_log (created_at desc);

comment on column brain.retrieval_log.results is
  'Evidence v2: the returned passages in rank order (index 0 is P1), each without content: chunkId (null for fallback), documentId, title, sourceKind, author, origin, occurredAt, headingPath, charStart, charEnd, score, scoreKind, layers, vectorRank, keywordRank, rerankRank, fallbackTerm, viaEntity.';
comment on column brain.retrieval_log.degraded is 'Evidence v2: {embedding, rerank, capReached}.';
comment on column brain.retrieval_log.candidates is 'Evidence v2: {vector, keyword, fused} candidate counts.';
comment on column brain.retrieval_log.timings is 'Evidence v2: {embedMs, sqlMs, rerankMs, graphMs, totalMs}.';
comment on column brain.retrieval_log.top_score is 'The top rerank score; null when no rerank ran (from evidence v2 on; earlier rows may hold an RRF value).';

commit;
