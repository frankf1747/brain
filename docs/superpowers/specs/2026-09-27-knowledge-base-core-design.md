# Brain: personal knowledge base, core design

Date: 2026-09-27
Status: approved in conversation, awaiting written review
Scope: sub-project 1 of 3 (schema, storage, ingestion, retrieval). MCP server, Obsidian projection and the ops agent are later sub-projects and are listed under Out of scope.

## 1. Purpose

A single knowledge base that holds anything Frank chooses to put in it, in any form: notes, conversations, news articles, job descriptions, papers, emails, pasted paragraphs. Two consumers:

- Agents, which will read it as external context through MCP (later sub-project).
- Frank, who asks questions across everything ingested and runs analysis over it.

The design goal is stated as two guarantees, and every decision below serves one of them.

**Guarantee 1, recall.** Everything ingested is retrievable, regardless of whether the system understood it. No input is ever transformed in place or discarded.

**Guarantee 2, structure as enrichment.** Entities, relations and facts are extracted into a graph so that a job description, a news piece and a conversation about the same company connect. Extraction is best effort, carries confidence and provenance, and is allowed to be wrong, because guarantee 1 means a bad extraction loses nothing.

## 2. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Store | Postgres on Supabase, pgvector + built-in full-text search | Already in use, reachable from anywhere, one database for vectors, keywords and graph |
| Language | TypeScript, Node 20, ESM | Matches Frank's existing stack and scripts |
| Node modeling | One `nodes` table typed by a registry, JSONB properties | New types are registry rows, not migrations; one ID space for edges and mentions |
| Embeddings | Voyage AI `voyage-4-large`, 1024 dimensions, `input_type` query/document | Anthropic's recommended embedding partner; 32k context |
| Reranker | Voyage `rerank-2.5` (config-switchable to `rerank-3`) | GA model; preview model left as an option |
| Extraction, summaries, answers | Claude Code headless (`claude -p --json-schema`) on Frank's Max subscription by default; `@anthropic-ai/sdk` with `claude-opus-5` as an optional backend (`BRAIN_LLM=api`); Message Batches backfill is API-only | No per-token bill for normal use; the API path stays for bulk backfill or CI |
| Local dev | `supabase start` (Docker) for a real Postgres with pgvector; migrations in `supabase/migrations` | Tests run against the real engine; `supabase db push` promotes to cloud |
| Document kind vs node type | Document kind is metadata on the document; never a node type | A job description is a document; the company it names is an organization node |

## 3. Architecture

```
input (file | text | url | stdin)
  -> store       raw bytes kept, content hash, document row          [guarantee 1]
  -> chunk       section-aware chunks with parent links
  -> summarize   one summary per document, embedded and indexed
  -> embed       Voyage embeddings + Postgres tsvector
  -> extract     entities, relations, facts (Claude, structured output)
  -> resolve     merge extracted entities into existing nodes
  -> link        mentions rows tie chunks to nodes                    [guarantee 2]

query
  -> hybrid search over chunks (vector + keyword, fused, reranked)
  -> summary search over documents
  -> graph expansion from resolved entities
  -> facts always loaded
  -> metadata filters on any of the above
  -> fallback substring scan of raw store when top score is below threshold
```

Every stage after `store` is idempotent and resumable. A document's pipeline state lives in `ingest_jobs`, so a crash at `extract` restarts at `extract`, not at `store`.

## 4. Schema

All tables live in schema `brain`. Extensions: `vector`, `pg_trgm`.

### 4.1 Documents and chunks (recall layer)

**documents**
- `id` uuid pk
- `content_hash` text unique. SHA-256 of raw bytes. Re-ingesting the same content is a no-op that returns the existing id.
- `source_kind` text. Free-form label from the ingester: `note`, `conversation`, `news`, `job_description`, `paper`, `email`, `paste`, and anything else. Not constrained; it is metadata.
- `title` text
- `origin` text nullable. File path, URL, vault and note name, or `stdin`.
- `raw_content` text. The full original text, never modified.
- `mime_type` text
- `metadata` jsonb. Anything the ingester knows: author, publication, tags, vault, page count.
- `occurred_at` timestamptz nullable. When the content is about, if known (article date, conversation date). Distinct from ingestion time.
- `ingested_at` timestamptz default now()
- `summary` text nullable
- `summary_embedding` vector(1024) nullable
- `summary_tsv` tsvector generated from `title || summary`

**chunks**
- `id` uuid pk
- `document_id` uuid fk documents on delete cascade
- `parent_id` uuid nullable fk chunks. Section-level parent of a paragraph-level chunk.
- `level` smallint. 0 = section (about 1500 tokens), 1 = passage (about 400 tokens, 15% overlap). Search runs over level 1; results expand to the level 0 parent on request.
- `ordinal` int. Position within the document at that level.
- `heading_path` text[]. Markdown or detected headings above this chunk.
- `content` text. The chunk text as it appears in the document.
- `context_prefix` text. Deterministic: title, one-line document summary, heading path. Prepended before embedding so a passage that says "they raised the offer" embeds with the company name. Per-chunk LLM-written context is a later option, not in v1.
- `embedding` vector(1024). Embedding of `context_prefix || content`.
- `tsv` tsvector generated from `content`.
- `token_count` int, `char_start` int, `char_end` int

Indexes: HNSW on `chunks.embedding` and `documents.summary_embedding` (cosine), GIN on both tsvector columns, GIN trigram on `documents.raw_content` for the fallback scan, btree on `(document_id, level, ordinal)`.

### 4.2 Graph (enrichment layer)

**node_types**
- `name` text pk. Seeded: `person`, `organization`, `place`, `project`, `concept`, `event`, `artifact`.
- `description` text
- `properties_schema` jsonb. JSON Schema validated in the application layer on write.

**edge_types**
- `name` text pk. Seeded: `works_at`, `studied_at`, `knows`, `part_of`, `located_in`, `mentions`, `related_to`, `caused`, `precedes`, `created`, `applied_to`.
- `description` text
- `directed` boolean

**nodes**
- `id` uuid pk
- `type` text fk node_types
- `name` text. Display name.
- `canonical_name` text. Lowercased, punctuation-stripped, used for exact matching. Unique with `type`.
- `aliases` text[]
- `properties` jsonb
- `name_embedding` vector(1024). Embedding of `type: name (aliases)`, used for fuzzy entity resolution.
- `is_self` boolean default false. Exactly one node (type person) has this true; it is Frank. Facts default to it as subject.
- `verified` boolean default false, `verified_by` text nullable (`frank` or `extractor:<model>`), `review_by` date nullable
- `merged_into` uuid nullable fk nodes. Set when the ops process merges duplicates; readers follow it. Nothing is deleted.
- `created_at`, `updated_at`

**edges**
- `id` uuid pk
- `from_node`, `to_node` uuid fk nodes
- `type` text fk edge_types
- `weight` real default 1
- `confidence` real. From the extractor, 0 to 1.
- `properties` jsonb
- `evidence_chunk_id` uuid nullable fk chunks. The passage that supports the edge.
- `valid_from`, `valid_to` date nullable. "Worked at X" ends by setting `valid_to`, not by deletion.
- `created_at`
- Unique on `(from_node, to_node, type, evidence_chunk_id)` so re-extraction does not duplicate.

**mentions**
- `chunk_id` uuid fk chunks, `node_id` uuid fk nodes, pk on both
- `confidence` real
- `span_start`, `span_end` int nullable

### 4.3 Facts (the always-loaded layer)

**facts**
- `id` uuid pk
- `subject_id` uuid fk nodes, default the `is_self` node
- `predicate` text. Free-form but normalized lowercase snake_case, for example `visa_status`, `prefers`, `graduated_from`, `salary_expectation`.
- `object_text` text. Human-readable value.
- `object_node_id` uuid nullable fk nodes. Set when the object is an entity.
- `confidence` real
- `source_chunk_id` uuid nullable fk chunks
- `verified` boolean, `verified_by` text, `review_by` date
- `valid_from`, `valid_to` date nullable
- `superseded_by` uuid nullable fk facts. A correction inserts a new fact and points the old one here, so history survives and the current view is `where superseded_by is null and (valid_to is null or valid_to >= today)`.
- `created_at`

### 4.4 Operations

**ingest_jobs**
- `document_id` uuid pk fk documents
- `stage` text: `stored`, `chunked`, `summarized`, `embedded`, `extracted`, `resolved`, `done`, `failed`
- `error` text nullable, `attempts` int, `updated_at`

**retrieval_log**
- `id` uuid pk, `query` text, `filters` jsonb, `layers` text[], `chunk_ids` uuid[], `node_ids` uuid[], `top_score` real, `used_fallback` boolean, `client` text, `created_at`
- Feeds the later ops agent (what is asked often, what is answered poorly, what is never touched).

### 4.5 Access

Row-level security enabled on every table with no anon policies. The CLI uses the service role key from `.env`, which is git-ignored. Per-client bearer tokens are the MCP sub-project's concern.

### 4.6 SQL functions

- `brain.hybrid_search(query_text, query_embedding, k, filters jsonb)`: runs vector top-k and keyword top-k over `chunks`, fuses with reciprocal rank fusion, returns candidates with both ranks. Reranking happens in the application after this.
- `brain.summary_search(...)`: same over `documents`.
- `brain.neighbors(node_id, depth, edge_types[])`: recursive CTE, depth capped at 2, follows `merged_into`.
- `brain.current_facts(subject_id)`: applies the supersession and validity filter.

## 5. Ingestion pipeline

Package `src/ingest/`. One module per stage, each exporting `run(documentId)` and being safe to re-run.

1. **store.** Accepts text plus metadata, or a file path, or a URL, or stdin. Files: markdown, txt, html (stripped to text with the title kept), pdf (text extracted per page; pages recorded in metadata), json and csv (stored raw, chunked as text). Computes the hash, inserts or returns the existing document, writes `ingest_jobs.stage = stored`.
2. **chunk.** Splits by headings when present, otherwise by paragraph boundaries, into level 0 sections and level 1 passages with overlap. Records heading paths and character offsets. Deterministic, no LLM.
3. **summarize.** One Claude call per document, structured output: a one-line summary, a paragraph summary, suggested `occurred_at` if the text implies a date, and a suggested title if none was given. Long documents are summarized per section and then reduced.
4. **embed.** Batches chunk texts (with `context_prefix`) to Voyage with `input_type: document`. Fills `embedding`. Runs after `summarize` because `context_prefix` needs the one-line summary.
5. **extract.** Claude with structured output, one call per level 0 section (long documents) or per document (short ones), given the node and edge type registries. Returns entities with type, name, aliases and a quote; relations with type, endpoints, confidence, validity dates and a quote; facts about Frank with predicate, value, confidence and a quote. Anything it cannot type becomes a `concept` with `properties.untyped_hint` for later review. Quotes are located in the chunk text to fill `mentions` spans and `evidence_chunk_id`.
6. **resolve.** For each extracted entity: exact match on `(type, canonical_name)`, then alias match, then cosine similarity on `name_embedding` above 0.92 within the same type, else create. Matches between 0.85 and 0.92 create the node and set `properties.possible_duplicate_of`. Then writes edges, mentions and facts.

Backfill mode runs stages 4 and 5 through the Message Batches API for anything over about fifty documents.

## 6. Retrieval

Package `src/retrieve/`. One entry point, `search(query, options)`, which the CLI and the later MCP server both call.

1. Embed the query with `input_type: query`. In parallel, run `hybrid_search` on chunks and `summary_search` on documents.
2. Rerank the top 40 fused chunk candidates with Voyage rerank against the original query; keep the top `k` (default 10).
3. Detect entities in the query by resolving capitalized spans and quoted names against `nodes` (exact and alias). For each hit, pull `neighbors` at depth 1 and the chunks that mention them, and add those chunks as a labeled "graph" group.
4. Load `current_facts` for the self node when `options.includeFacts` (default true).
5. Apply filters (`source_kind`, date range, `verified_only`) inside the SQL, not after, so recall inside the filter is preserved.
6. If the best reranked score is below a threshold (tuned on the golden set), run a trigram substring scan over `documents.raw_content` and return those with `used_fallback: true`.
7. Write one `retrieval_log` row.

The response is structured: `passages[]` (chunk, parent, document, score, group), `documents[]` (summary hits), `entities[]` (with neighbors), `facts[]`, `used_fallback`. Every passage carries its document id and offsets so an answer can cite it.

`ask(query)` wraps `search` and one Claude call that answers with citations to passage ids and refuses to assert anything not in the passages or facts.

## 7. CLI

`brain` binary via `tsx`, commands:

- `brain ingest <path|url|-> [--kind X] [--title T] [--occurred-at D] [--meta k=v]`. Directories recurse.
- `brain status` shows pipeline stage counts and failures.
- `brain retry [--stage S]` re-runs failed or stalled jobs.
- `brain search "<query>" [--kind X] [--since D] [--verified] [--k N] [--json]`
- `brain ask "<question>"`
- `brain node <name|id>` shows a node, its facts, edges and evidence.
- `brain facts [--all]` lists current facts about Frank.
- `brain eval` runs the golden set and reports recall@10 and MRR per layer.

## 8. Error handling

- Ingestion never fails silently. Each stage catches, writes `ingest_jobs.error`, increments `attempts`, and leaves the document at the last completed stage. `store` is the only stage whose failure means the document does not exist, and it has no external dependencies.
- External calls (Voyage, Claude) retry with backoff through the SDKs' built-in retries, then fail the stage. Rate limits are respected via the SDKs.
- Extraction output is validated against a Zod schema. A document whose extraction cannot be parsed after two attempts is marked `extracted` with `metadata.extraction = "skipped"` and remains fully searchable; guarantee 1 holds.
- Resolution never merges automatically below the 0.92 threshold. False merges are the costliest error in a graph, so the design accepts more duplicates in exchange.
- Nothing is deleted by any pipeline or CLI path. `merged_into`, `superseded_by` and `valid_to` are the only ways an item leaves the current view.

## 9. Testing

- **Unit (vitest):** chunker (boundaries, overlap, heading paths, offsets round-trip to the original text), content hashing, reciprocal rank fusion, canonical name normalization, entity resolution decision table, facts supersession query, Zod schemas for extraction output.
- **Integration (vitest against `supabase start`):** migrations apply cleanly; ingest a fixture set of six documents of different kinds; assert every chunk is reachable by id, by keyword and by vector; assert re-ingest is a no-op; assert a failure injected at `extract` leaves the document searchable and `retry` completes it.
- **Retrieval eval:** `eval/golden.jsonl`, about thirty questions with known source document ids, covering exact-name lookups, paraphrase lookups, cross-source entity questions, date-filtered questions, and two questions designed to need the fallback. `brain eval` prints recall@10 and MRR per layer and overall. This is the number that gates changes to chunking, embedding or fusion.
- LLM calls in unit tests are replaced with recorded fixtures; integration tests hit the real APIs behind an env flag.

## 10. Out of scope for this sub-project

Listed so they are not forgotten, each gets its own spec:

- **MCP server** exposing `search`, `ask`, `get_node`, `get_facts`, `neighbors`, `orient` (the llms.txt-style map of the base), and gated write tools. Remote over HTTP with per-client bearer tokens.
- **Obsidian projection.** One read-only markdown note per node into a vault folder, edges as wikilinks, regenerated from the database.
- **Ops agent.** Periodic audit for duplicate nodes, stale facts past `review_by`, contradictions, untyped concepts that cluster, and retrieval-log gaps. Proposes; Frank approves.
- **Per-chunk LLM context prefixes**, two-way Obsidian sync, multi-user access, a web UI.

## 11. Open items the implementer must settle, with defaults

- Voyage batch sizes and Postgres HNSW parameters: use provider defaults and `m=16, ef_construction=64`, tune only if the eval says so.
- Rerank threshold for the fallback: start at 0.3 on Voyage's relevance score, tune on the golden set.
- PDF extraction library: `pdf-parse` or `unpdf`; pick whichever handles the fixture PDFs correctly.
- Repo remote: `gh` is not installed on this machine; Frank creates the GitHub remote and the plan includes the `git remote add` step.
- Claude Code backend limits: the Max plan has rolling usage windows. Ingesting a few hundred documents fits; thousands at once will hit the window, and `brain retry` resumes when it opens. For a large one-time import, set `BRAIN_LLM=api` and use `brain backfill`.
- The Claude Code backend calls the official `claude` binary only. The subscription token is never extracted for use with the SDK.
