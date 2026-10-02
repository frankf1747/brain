-- Phase 3: Voyage spending guard (spec §5). One row per Voyage HTTP attempt, written before the request is sent
-- (status reserved) and settled after it (ok with Voyage's usage.total_tokens, or error with 0). A request that
-- would take today's (UTC) total past BRAIN_VOYAGE_DAILY_TOKEN_CAP is never sent and is recorded as refused.
-- The protocol is in src/llm/ledger.ts. Idempotent: safe to apply more than once.

begin;

create table if not exists brain.provider_usage (
  id bigint generated always as identity primary key,
  provider text not null,
  operation text not null check (operation in ('embed_document', 'embed_query', 'rerank')),
  model text not null,
  -- 1 for a request that was sent (or is being sent), 0 for a refusal.
  requests int not null default 1 check (requests >= 0),
  estimated_tokens int not null check (estimated_tokens >= 0),
  -- Null only while reserved; 0 on error and refused rows.
  tokens int check (tokens >= 0),
  status text not null check (status in ('reserved', 'ok', 'error', 'refused')),
  error text,
  client text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists provider_usage_created_at on brain.provider_usage (created_at);
alter table brain.provider_usage enable row level security;

-- Tokens counted against today's cap (UTC day). A reserved row counts at its estimate until it is settled, and for
-- the rest of the day if its process died mid-call: an over-count, the safe side. The reservation in
-- src/llm/ledger.ts and brain_orient both read this function, so they cannot disagree.
create or replace function brain.provider_tokens_today(p_provider text) returns bigint
language sql stable as $$
  select coalesce(sum(coalesce(tokens, estimated_tokens)), 0)::bigint
  from brain.provider_usage
  where provider = p_provider
    and status in ('reserved', 'ok')
    and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
$$;

commit;
