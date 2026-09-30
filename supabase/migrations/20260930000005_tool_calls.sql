-- One row per MCP tool call, so a session's call sequence (orient first? search at all?) can be
-- audited per client. retrieval_log keeps the search-specific detail; this table covers every tool.

create table brain.tool_calls (
  id bigint generated always as identity primary key,
  client text not null,
  tool text not null,
  args jsonb not null default '{}'::jsonb,
  ok boolean not null,
  error text,
  duration_ms int not null,
  created_at timestamptz not null default now()
);

create index tool_calls_created_at on brain.tool_calls (created_at desc);

alter table brain.tool_calls enable row level security;
