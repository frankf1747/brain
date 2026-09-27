create table brain.node_types (
  name text primary key,
  description text not null,
  properties_schema jsonb not null default '{"type":"object"}'::jsonb
);
insert into brain.node_types (name, description) values
  ('person', 'A human being'),
  ('organization', 'A company, school, team, agency or other group'),
  ('place', 'A city, country, address, building or region'),
  ('project', 'A bounded piece of work with a goal'),
  ('concept', 'An idea, topic, skill, method or anything that is not one of the other types'),
  ('event', 'Something that happened at a time: a meeting, interview, launch, deadline'),
  ('artifact', 'A made thing: product, paper, tool, dataset, document, course');

create table brain.edge_types (
  name text primary key,
  description text not null,
  directed boolean not null default true
);
insert into brain.edge_types (name, description, directed) values
  ('works_at', 'from person to organization', true),
  ('studied_at', 'from person to organization', true),
  ('knows', 'from person to person', false),
  ('part_of', 'from anything to the larger thing it belongs to', true),
  ('located_in', 'from anything to a place', true),
  ('mentions', 'from an artifact to anything it refers to', true),
  ('related_to', 'undirected catch-all when no other type fits', false),
  ('caused', 'from an event or action to its consequence', true),
  ('precedes', 'from an earlier event to a later one', true),
  ('created', 'from a person or organization to an artifact or project', true),
  ('applied_to', 'from a person to an organization or artifact, for job applications', true);

create table brain.nodes (
  id uuid primary key default gen_random_uuid(),
  type text not null references brain.node_types(name),
  name text not null,
  canonical_name text not null,
  aliases text[] not null default '{}',
  properties jsonb not null default '{}'::jsonb,
  name_embedding vector(1024),
  is_self boolean not null default false,
  verified boolean not null default false,
  verified_by text,
  review_by date,
  merged_into uuid references brain.nodes(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (type, canonical_name)
);
create unique index nodes_single_self_idx on brain.nodes (is_self) where is_self;
create index nodes_name_embedding_idx on brain.nodes
  using hnsw (name_embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index nodes_aliases_idx on brain.nodes using gin (aliases);
create index nodes_canonical_trgm_idx on brain.nodes using gin (canonical_name gin_trgm_ops);

insert into brain.nodes (type, name, canonical_name, is_self, verified, verified_by)
values ('person', 'Frank Fu', 'frank fu', true, true, 'frank');

create table brain.edges (
  id uuid primary key default gen_random_uuid(),
  from_node uuid not null references brain.nodes(id) on delete cascade,
  to_node uuid not null references brain.nodes(id) on delete cascade,
  type text not null references brain.edge_types(name),
  weight real not null default 1,
  confidence real,
  properties jsonb not null default '{}'::jsonb,
  evidence_chunk_id uuid references brain.chunks(id) on delete set null,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now()
);
-- coalesce so two evidence-less edges also collide.
create unique index edges_dedupe_idx on brain.edges
  (from_node, to_node, type, coalesce(evidence_chunk_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index edges_from_idx on brain.edges (from_node);
create index edges_to_idx on brain.edges (to_node);

create table brain.mentions (
  chunk_id uuid not null references brain.chunks(id) on delete cascade,
  node_id uuid not null references brain.nodes(id) on delete cascade,
  confidence real,
  span_start int,
  span_end int,
  primary key (chunk_id, node_id)
);
create index mentions_node_idx on brain.mentions (node_id);

create table brain.facts (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references brain.nodes(id) on delete cascade,
  predicate text not null,
  object_text text not null,
  object_node_id uuid references brain.nodes(id) on delete set null,
  confidence real,
  source_chunk_id uuid references brain.chunks(id) on delete set null,
  verified boolean not null default false,
  verified_by text,
  review_by date,
  valid_from date,
  valid_to date,
  superseded_by uuid references brain.facts(id),
  created_at timestamptz not null default now()
);
create index facts_subject_idx on brain.facts (subject_id, predicate);
create unique index facts_dedupe_idx on brain.facts
  (subject_id, predicate, object_text, coalesce(source_chunk_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Raw extractor output per section, so resolve can be re-run without re-calling the model.
create table brain.extractions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references brain.documents(id) on delete cascade,
  section_chunk_id uuid references brain.chunks(id) on delete cascade,
  model text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (document_id, section_chunk_id)
);

create table brain.retrieval_log (
  id uuid primary key default gen_random_uuid(),
  query text not null,
  filters jsonb not null default '{}'::jsonb,
  layers text[] not null default '{}',
  chunk_ids uuid[] not null default '{}',
  node_ids uuid[] not null default '{}',
  top_score real,
  used_fallback boolean not null default false,
  client text,
  created_at timestamptz not null default now()
);

alter table brain.node_types enable row level security;
alter table brain.edge_types enable row level security;
alter table brain.nodes enable row level security;
alter table brain.edges enable row level security;
alter table brain.mentions enable row level security;
alter table brain.facts enable row level security;
alter table brain.extractions enable row level security;
alter table brain.retrieval_log enable row level security;
