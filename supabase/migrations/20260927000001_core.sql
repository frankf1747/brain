create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create schema if not exists brain;

-- Recall layer. raw_content is never modified after insert.
create table brain.documents (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null unique,
  source_kind text not null default 'paste',
  title text,
  origin text,
  raw_content text not null,
  mime_type text not null default 'text/plain',
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz,
  ingested_at timestamptz not null default now(),
  summary text,
  summary_line text,
  summary_embedding vector(1024),
  summary_tsv tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))
  ) stored
);
create index documents_summary_embedding_idx on brain.documents
  using hnsw (summary_embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index documents_summary_tsv_idx on brain.documents using gin (summary_tsv);
create index documents_raw_trgm_idx on brain.documents using gin (raw_content gin_trgm_ops);
create index documents_source_kind_idx on brain.documents (source_kind);
create index documents_occurred_at_idx on brain.documents (occurred_at);

create table brain.chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references brain.documents(id) on delete cascade,
  parent_id uuid references brain.chunks(id) on delete cascade,
  level smallint not null check (level in (0, 1)),
  ordinal int not null,
  heading_path text[] not null default '{}',
  content text not null,
  context_prefix text not null default '',
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('english', content)) stored,
  token_count int not null,
  char_start int not null,
  char_end int not null,
  unique (document_id, level, ordinal)
);
create index chunks_embedding_idx on brain.chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index chunks_tsv_idx on brain.chunks using gin (tsv);
create index chunks_document_idx on brain.chunks (document_id, level, ordinal);

-- stage = last completed stage. error is non-null when the next stage failed.
create table brain.ingest_jobs (
  document_id uuid primary key references brain.documents(id) on delete cascade,
  stage text not null check (stage in
    ('stored', 'chunked', 'summarized', 'embedded', 'extracted', 'resolved', 'done')),
  error text,
  attempts int not null default 0,
  updated_at timestamptz not null default now()
);
create index ingest_jobs_stage_idx on brain.ingest_jobs (stage);

alter table brain.documents enable row level security;
alter table brain.chunks enable row level security;
alter table brain.ingest_jobs enable row level security;
