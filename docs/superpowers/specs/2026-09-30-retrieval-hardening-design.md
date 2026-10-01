# Brain: retrieval hardening, evidence contract and eval program, design

Date: 2026-09-30 (revised 2026-10-01: §3.1 ef_search and exact-score ranks, §3.2 coverage ranking and weights, PG 17.6)
Status: approved in conversation (sections 1 and 2 reviewed line by line; sections 3 to 7 approved as a package)
Depends on: the three 2026-09-27 specs (core, MCP server, Obsidian projection). This document changes behaviour they describe; where the two disagree, this one wins.
Scope: one sub-project in seven phases, each independently shippable. Phase 0 (eval isolation and baseline) comes first so every later phase is measured.

## 1. Purpose

The knowledge base works at 2 documents. An audit on 2026-09-30 (see §9) found that it would not hold up at the size the owner expects (hundreds to low thousands of short documents: saved posts, notes, emails, conversations, job descriptions), and that three of the owner's requirements are not met:

1. **No misses.** A question whose answer is in the base must surface that passage. Today the keyword side needs every term to match, entity expansion needs capital letters, the fallback needs the whole question as a literal substring, and the search SQL never uses its indexes.
2. **Transparency.** The reader must see what came from the base and what the answering model added. Today scores are hidden, degraded searches are mislabelled, and the only separation between base and model is one sentence in the server instructions.
3. **Evidence.** "It works" must be a measured claim. Today the eval is 14 questions over 6 fictional documents, scored as "any expected document in the top 10", run against the real database.

A fourth problem surfaced during the audit: a saved post by an unknown author produced three facts about the owner and a graph edge from the owner, because the extractor maps "I" to the owner in every document.

The design is also meant to be legible to people outside this project: every retrieval decision is logged in a form that can be replayed, and every quality claim traces to a metric in §7.

## 2. Constraints

| Constraint | Consequence |
|---|---|
| No model call per query. Ingestion keeps using Claude Code on the owner's Max plan; nothing at query time calls a model. | Citation checking (§6) and all eval metrics (§7) are deterministic. Question drafting for the eval runs through Claude Code at the owner's command, never per search. |
| Voyage has a payment method now, but spend must be bounded. | §4: a token ledger and a hard daily cap that stops calls rather than exceeding it. |
| Corpus: short documents, hundreds to low thousands. About 10,000 passages. Postgres 17.6 with pgvector 0.8.2. | Exact vector scans would still be fast at this size. The SQL fix in §3 is done because it is cheap and correct, not because it is urgent. Chunk sizes and the embedding model stay as they are. |
| The MCP tool output is read by a language model. | Structured data is added alongside the text, never instead of it. |

## 3. Phase 1: retrieval correctness

Goal: a passage that answers the question reaches the candidate pool, and the pool is ordered by the reranker rather than by accident.

### 3.1 Search SQL

`hybrid_search` and `summary_search` are rewritten so the vector and keyword branches each read the base table directly with the filters inlined (`with filtered as not materialized`, or the filter repeated per branch; the migration picks whichever `EXPLAIN` shows using the index). pgvector is 0.8.2, so the vector branch runs with `set local hnsw.iterative_scan = relaxed_order` and `hnsw.ef_search = greatest(4 * k, 100)`, which lets a filtered query keep scanning until it has k rows instead of returning short.

The candidate pool is `config.retrieval.candidateK`, default 60, applied to both the vector and the keyword branch of both functions (summary search currently gets only k).

As built: the chunk vector branch reads `chunks` alone and applies document filters through an `EXISTS` inside an `OR`, so the filter stays on the HNSW scan node; the planner would not use HNSW with the join in the same query. The vector branch does `ORDER BY distance LIMIT k` in an inner subquery and numbers rows by exact score outside it, because under `relaxed_order` the index's emission order can be slightly wrong and Postgres 17 otherwise numbers rows in that order. `ef_search` is `greatest(4 × candidateK, 100)`.

Verification: an integration test runs `EXPLAIN` on the function body against the test database and fails if a `CTE Scan` appears under the vector sort or the tsvector filter.

### 3.2 Keyword side

`websearch_to_tsquery` ANDs every term. It is replaced by a query builder in SQL (`brain.query_to_tsquery(text)`) that:

- keeps quoted phrases as phrase matches (`<->` operators),
- ORs the remaining stems, dropping unquoted stems shorter than 2 characters (exact strings such as `X-90` are the fallback scan's job, §3.4).

The query is also exposed as its units (`brain.query_units(text) returns tsquery[]`: one per phrase, one per stem). Keyword ranking is, in order: **coverage** (how many distinct units the passage matches), then `ts_rank_cd` with normalisation 1 (divided by 1 + log length, so long passages are not favoured), then id. Coverage comes first because, measured during review, `ts_rank_cd` on an OR query is roughly a weighted count of occurrences: a passage repeating one term six times outranked a passage matching four distinct question terms. (The originally specified normalisation 32 is monotonic and so changes nothing in a rank-only output.)

The chunk `tsv` becomes weighted: content as weight A, heading path as B, context prefix (title, summary line, heading path) as C. Title and summary words still make every passage of the document findable, but content decides the order. (The first version put the context prefix at A; review on `brain_eval` showed the model-written summary line then dominated, and every passage of a document tied.) `documents.summary_tsv` has the title at A and the summary at B. A migration recomputes both for existing rows. The context prefix used for embeddings is unchanged. The context prefix is written by the embed stage, so a document whose embedding failed is keyword-searchable by content only until `brain retry` completes it.

### 3.3 Entity detection in the query

`detectEntities` no longer needs capitals. It takes every span of one to six consecutive tokens of the query (a leading "the" is allowed on spans of two or more tokens), canonicalises each the same way node names are canonicalised, and resolves them in one SQL call against `nodes.canonical_name` and `nodes.aliases`. Longer spans win over shorter spans they contain ("Databricks cost governance" beats "Databricks"). Quoted strings are still matched whole. Spans starting or ending with a stopword are skipped. At most 5 entities are kept per query, longest span first. Aliases are stored canonical at resolve time, so the lookup is an index lookup on `canonical_name` and the GIN index on `aliases`.

### 3.4 Fallback scan

The trigram fallback runs per term rather than per query. Trigger terms are: any quoted string, and any token that contains a digit or a symbol character (`X-90`, `$115k`, `F-1`, `rerank-2.5`). Each trigger term is searched with `ILIKE` over `raw_content`; documents are ranked by the number of trigger terms they match, then by `occurred_at`. The `fallbackThreshold` on rerank score is kept as a second trigger for the same per-term scan. If the query has no trigger terms the fallback does not run, even when the top score is low; the OR keyword branch (§3.2) already covers weak natural-language matches.

### 3.5 Graph and facts budgets

- `neighbors()` is rewritten to join on `edges.from_node` and `edges.to_node` directly and canonicalise the results afterwards, so `edges_from_idx` and `edges_to_idx` apply. Signature unchanged.
- Per detected entity: at most 20 neighbours, ordered by edge confidence then name; at most 5 mentioned level-1 passages, ordered by document `occurred_at` desc then chunk ordinal. Mentions stored on level-0 sections are mapped to the first level-1 passage of that section so they are no longer invisible.
- Facts returned by a search are the 10 whose predicate, object text or linked node overlaps the query's content terms (same stem overlap used in §6), plus any fact whose object node is a detected entity. `brain_get_facts` and `brain_orient` still list everything.
- Graph passages stay after the k hybrid passages, so a search returns at most k + 5 × entities passages. The contract (§5) labels them.

### 3.6 `verified_only`

Passages have no verification state. The flag keeps filtering facts and neighbour nodes only, and the tool description says so.

### 3.7 Unchanged

Chunk sizes (1500 / 400 tokens, 15% overlap), `voyage-4-large`, `rerank-2.5`, RRF with k=60, the two-level chunk structure, and the summary stage.

## 4. Phase 2: authorship and facts about the owner

Goal: a fact about the owner exists only because the owner said it, and the base records who wrote every document.

### 4.1 Author field

`documents.author text not null default 'unknown'`, values `owner`, `other`, `unknown`.

Set at ingest:
- `brain_ingest` and `brain ingest --author` accept it.
- Default by source kind when absent: `resume`, `note`, `conversation`, `paste` → `owner`; `news`, `paper`, `job_description`, `email` → `other`; anything else → `unknown`. The mapping lives in `config.authorDefaults`.
- Migration backfills existing documents by the same mapping.
- `brain set-author <document> <author>` changes it and re-runs resolution for that document (§4.3), so wrongly attributed facts and edges are removed. The MCP server gets no write tool for this; it is a deliberate CLI step like `verify-fact`.

The author is shown in `brain_get_document`, in every passage line of `brain_search` (§5.3), and in the Obsidian document note.

### 4.2 Extraction prompt

The document header given to the extractor gains `Author: owner|other|unknown` and `Origin: ...`. The rule about first-person pronouns becomes conditional:

- `owner`: "I", "me", "my" refer to the owner, as today.
- `other` or `unknown`: first-person pronouns refer to the document's author, who is not the owner. `facts_about_self` must be empty unless the text names the owner and states something about them. Relations from the owner are allowed only when the owner is named.

### 4.3 Hard gate in resolve

`resolve` writes `facts_about_self` and relations whose `from` is the self node only when `document.author = 'owner'`. For other documents these items stay in the stored extraction payload with `suppressed: "author_not_owner"` and a count is recorded in `documents.metadata.suppressed_self_items`. `brain_status` and `brain status` show the count per document. Re-running resolution (via `set-author` or `brain retry --stage resolved`) first deletes the facts, edges and mentions that document produced, then applies the gate again.

### 4.4 Supersession by the extractor

`config.singleValuedPredicates` lists predicates that hold one current value: `lives_in`, `visa_status`, `targeting_role`, `pursuing_degree`, `employment_status`, `current_employer`, `phone`, `email`. When an owner-authored document yields such a fact with a different `object_text` from the current one, and its `valid_from` (or the document's `occurred_at`) is not earlier than the current fact's, the extractor inserts the new fact and sets `superseded_by` on the old one. Otherwise it inserts without superseding. Multi-valued predicates always add. Every supersession is logged to `brain.fact_events (fact_id, event, by, document_id, created_at)`.

### 4.5 Cleanup of the current base

After the migration backfill marks the Databricks post `owner` (it is a `note`), the owner runs `brain set-author <id> other`. Resolution re-runs and removes `view_on`, `recommends`, `has_experience_with: Databricks cost governance`, and the edge from the owner to the cost-governance concept. If the experience fact is true, the owner re-adds it with `brain_add_fact` or `brain add-fact`.

## 5. Phase 3: Voyage spending guard

Goal: Voyage spend is visible at all times and cannot exceed a daily limit.

### 5.1 Ledger

`brain.provider_usage (id, provider, operation, model, requests int, tokens int, client, created_at)` with one row per API call. `operation` is `embed_document`, `embed_query` or `rerank`. The Voyage client records `usage.total_tokens` from every response (both the embeddings and rerank endpoints return it). Failed calls are recorded with `tokens = 0` and `error` text.

### 5.2 Cap

`BRAIN_VOYAGE_DAILY_TOKEN_CAP`, default 5,000,000 tokens per UTC day. Before each call the client sums today's tokens; if the sum plus the batch's estimated tokens (characters / 4) exceeds the cap it throws `SpendCapError` without calling Voyage.

Behaviour on the cap:
- Ingestion: the pipeline marks the document `stage = chunked, error = spend_cap` and stops; `brain retry` and the next day's first ingest resume it. Nothing is lost because raw text and keyword search already work.
- Search: degrades to keyword-only with `degraded.capReached = true` (§5.3). The text output says "Voyage daily cap reached; keyword-only results" rather than "embeddings unavailable".

### 5.3 Visibility

- `brain usage [--days 30]` prints tokens and requests per day and operation, and the estimated cost using `BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED` and `..._RERANK` from `.env` (defaults 0, which prints tokens only; the owner copies the current prices from Voyage's pricing page into `.env`).
- `brain_orient` adds one line: today's Voyage tokens against the cap.
- The query-time client gets 3 attempts with backoff capped at 10 seconds total, up from 1 rate-limit attempt. With a paid tier that is enough; without it the search still fails fast.

## 6. Phase 4: the evidence contract

Goal: every answer can be traced to exactly what the base returned, and every search can be replayed.

### 6.1 Structured search result

`search()` returns, per passage:

```
chunkId, documentId, title, sourceKind, author, origin, occurredAt, headingPath,
content, score, scoreKind: "rerank" | "rrf" | "none",
layers: ("vector" | "keyword" | "graph" | "fallback")[],
vectorRank, keywordRank, rerankRank (each nullable)
```

and, per search:

```
retrievalId, k, degraded: { embedding: bool, rerank: bool, capReached: bool },
fallbackUsed, entities: [{ nodeId, name, type, matchedSpan }],
facts: [{ id, predicate, objectText, verifiedBy, sourceChunkId, confidence }],
candidates: { vector: n, keyword: n, fused: n }, timings: { embedMs, sqlMs, rerankMs, totalMs }
```

### 6.2 Retrieval log

`retrieval_log` gains `results jsonb` (the per-passage array above minus `content`), `degraded jsonb`, `candidates jsonb`, `timings jsonb`, `k int`, and an index on `created_at`. `layers` and `top_score` stay for compatibility. `used_fallback` stays.

### 6.3 MCP rendering

The text is generated from the structure. Each passage line becomes:

```
[P3] 0.76 · vector+keyword · note · author: other · "I thought Databricks was supposed to be cheaper!!" · 2026-09-29 (doc 31f1…, chunk 5ec6…)
```

Graph passages show `graph via <entity>` in place of the layers; fallback passages show `fallback: "<term>"`. The header line states the mode exactly: `mode: full`, `mode: keyword-only (query embedding failed)`, `mode: rerank skipped (fused order)`, or `mode: keyword-only (Voyage daily cap reached)`. The retrieval id is on the header so the client can pass it to `brain_verify` or `brain_explain`. Facts show `verified`/`unverified` and `from <source kind> <doc id>` so the model can tell an extracted fact from one the owner stated.

The same tool result also carries `structuredContent` (the §6.1 object) for clients that use it.

### 6.4 `brain_explain`

`brain_explain(retrieval_id)` replays a logged search from `retrieval_log`: the query, filters, mode, how many candidates each branch produced, and for every returned passage its vector rank, keyword rank, rerank rank and score, with the document title and author. It reads the log only; it does not search again. CLI: `brain explain <retrieval id>`.

## 7. Phase 5: deterministic citation verification

Goal: after a client model writes an answer, the owner can see which claims the cited passages actually support.

### 7.1 Tool

`brain_verify({ retrieval_id, claims: [{ text, cites: ["P3", "F1"] }] })`. `P` and `F` labels are resolved through the retrieval log; chunk ids and fact ids are accepted directly.

### 7.2 Method

For each claim:
1. Content terms: the claim's stems after stopword removal, using Postgres `to_tsvector('english')` so the stemming matches the index.
2. Numbers and dates in the claim are extracted separately. Each must appear verbatim (after normalising `1,000` to `1000` and `~11%` to `11%`) in at least one cited text.
3. Support = fraction of content terms present in the union of the cited passages' stems (passage content plus heading path; for a fact, predicate plus object text).
4. Verdict: `supported` when support ≥ 0.6 and every number matched; `partial` when support ≥ 0.3 or a number is missing; `unsupported` below 0.3; `uncited` when `cites` is empty; `bad_citation` when a cited label does not exist in that retrieval.

The response lists each claim with its verdict, its support value, the missing terms and missing numbers, and ends with a one-line summary (`4 supported, 1 partial, 1 unsupported`). The server instructions are extended: after composing an answer from `brain_search` results, the client calls `brain_verify` with its claims and presents anything not `supported` as the model's own addition.

### 7.3 Limits, stated in the tool description

A paraphrase with different vocabulary can score `partial` even when correct; the verifier never scores `supported` when the claim's terms are absent from the citation. It checks vocabulary overlap, not logic. That is the right trade for a check that costs no model call.

The CLI `ask` command runs the same verifier on its own answer and prints the verdicts under the sources.

## 8. Phase 0 and 6: the eval program

Phase 0 (first, before any retrieval change): isolate the eval and record a baseline on the current code. Phase 6 (last): the full program.

### 8.1 Isolation

Eval runs only against a database whose name ends in `_eval`, created by `scripts/prepare-eval-db.sh` from the migrations, the same way the test database is. `runEval` and `ingestCorpus` call `assertEvalDatabase` and refuse anything else. `EVAL_DATABASE_URL` defaults to `.../brain_eval`. Real Voyage and real Claude Code are used; the spending guard applies.

Two ways to fill it:
- `brain eval ingest` ingests `eval/corpus` (fixtures in the repo; deterministic; for regression).
- `brain eval sync` copies the real base's `documents`, `chunks` (with embeddings), `nodes`, `edges`, `mentions` and `facts` into the eval database with `pg_dump --data-only` and `pg_restore`, after truncating. No re-embedding and no model calls, so it is free. This is what lets questions about the owner's real documents be evaluated without touching the real base.

### 8.2 Golden set, version 2

`eval/golden.jsonl`, one object per line:

```
id, question, kind, expected: [{ origin | document_id, quote? }], filters?,
paraphrases?: string[], source: "fixture" | "generated" | "captured",
negative?: true, approved_at
```

- `kind` ∈ keyword, semantic, graph, filter, fallback, attribution, negative.
- `quote` is a verbatim span from the expected document; when present, passage-level relevance is defined as "contains the quote".
- `negative` questions have no answer in the base; the correct behaviour is a top rerank score below `fallbackThreshold` and no graph passage.
- Attribution items name a fixture document with `author: other` and assert that ingesting it produces zero self facts and zero edges from the self node.

Existing 14 items are converted with `source: "fixture"`.

### 8.3 Growing the set

- `brain eval draft [--since date] [--limit n]`: for each real document without drafts, one Claude Code call produces 2 to 3 questions, each with the verbatim answer quote and two paraphrases. Output goes to `eval/drafts.jsonl`. This is the only model use in the eval program, and it runs only when the owner invokes it.
- `brain eval approve [--all | --id ...]` moves drafts into the golden set with `approved_at`; `brain eval reject --id` deletes them.
- `brain eval capture [--since date]` lists recent `retrieval_log` rows (query, mode, top passages). `brain eval label <retrieval id> --expect <document id or origin> [--quote "..."] [--negative]` writes a golden item with `source: "captured"`.

Target: at least 60 approved items before Phase 6 is declared done, across all kinds, at least 10 negative, at least 5 attribution.

### 8.4 Metrics

All computed by `src/eval/metrics.ts`, no model calls:

| Metric | Definition | Over |
|---|---|---|
| Set recall@k, k ∈ {1, 5, 10} | fraction of expected documents present among the top-k passages' documents, averaged over questions | all non-negative items |
| MRR | 1 / rank of the first expected document | same |
| nDCG@10 | passage-level, relevance 1 when the passage contains the quote, else 0 | items with quotes |
| Paraphrase consistency | fraction of paraphrases whose top-10 contains the same expected documents as the original | items with paraphrases |
| Abstention rate | fraction of negative items where top rerank score < threshold and no graph passage | negative items |
| False answer rate | fraction of negative items that returned a passage with score ≥ threshold | negative items |
| Attribution | self facts and self edges produced by `author: other` fixtures; must be 0 | attribution items |
| Verifier accuracy | precision and recall of `supported` against hand-labelled (claim, citation, verdict) triples in `eval/verifier.jsonl` | verifier set |
| Degraded fraction | share of eval searches that ran with any `degraded` flag; must be 0 | all |
| Latency | p50 and p95 of `timings.totalMs`, and per stage | all |
| Voyage tokens | tokens per query and per ingested document, from the ledger | all |

Per-kind breakdowns are always printed.

### 8.5 Baseline and gate

`eval/baseline.json` holds the last accepted run: metrics overall and per kind, plus per-question ranks. `brain eval run --compare` prints each metric with its delta and lists every question whose rank got worse, by id. `npm run eval:gate` fails when set recall@10 or MRR drops by more than 0.02, when any attribution item fails, when abstention falls, or when degraded fraction is above 0. `brain eval accept` overwrites the baseline after a deliberate change.

Phase 0 records the baseline on the current code before any retrieval change; the README reports the numbers and the date.

### 8.6 Fixture corpus additions

`eval/corpus` gains: the Databricks post as `note--databricks-cost-governance.md` with front matter `author: other`; a second first-person third-party piece (`email--recruiter-intro.md`, `author: other`) that mentions the owner by name; an owner-authored note that supersedes a single-valued fact; and three documents with exact-string targets (a product code, a dollar figure, a model name with a dot) for the fallback.

## 9. Audit findings this design answers

From the 2026-09-30 audit (full report in the conversation; summarised here so the design is self-contained):

| Finding | Evidence | Answered in |
|---|---|---|
| `hybrid_search` never uses HNSW or GIN | `EXPLAIN` shows `Sort` over `CTE Scan on filtered` with `enable_seqscan=off` | §3.1 |
| Keyword branch ANDs all terms | `websearch_to_tsquery` in migration 004 | §3.2 |
| `tsv` covers content only | migration 001 line 41 | §3.2 |
| Entity detection needs capitals | `src/retrieve/entities.ts` | §3.3 |
| Fallback needs the whole query as a substring | `search.ts` raw scan | §3.4 |
| `neighbors()` cannot use edge indexes; no limits on neighbours, graph passages or facts | migration 003, `search.ts` | §3.5 |
| "I" maps to owner in every document; no author field | `extract.ts` prompt; `documents` schema | §4 |
| Extractor never supersedes | `resolve.ts` | §4.4 |
| Voyage usage not recorded; free-tier limit caused a silent keyword-only search | `voyage.ts`; retrieval log row at 06:30:53 | §5 |
| Scores hidden; degraded mislabelled; no replay | `render.ts` | §6 |
| No citation check | server instructions only | §7 |
| Eval tiny, any-hit scoring, runs on the real database | `src/eval/run.ts` | §8 |

## 10. Testing

- Every phase starts with failing tests (unit where no database is needed, integration against `brain_test` otherwise), in the existing vitest layout.
- SQL changes get an `EXPLAIN` assertion (§3.1) in addition to behaviour tests.
- The spending guard is tested with a fake clock and a fake Voyage that reports usage.
- The verifier has a unit test file with at least 20 (claim, citation, verdict) cases, including numbers, dates, paraphrases and bad labels.
- The eval program's own code (metrics, golden parsing, baseline comparison) is unit tested with synthetic results.
- Each phase ends with `brain eval run --compare` against the Phase 0 baseline; a phase that regresses a metric is not merged until the regression is explained and either fixed or accepted with a note in the plan.

## 11. Out of scope

- Any model call at query time, including query rewriting, HyDE, multi-query expansion, or LLM-as-judge in the eval. If the owner later allows API spend, these are the first candidates.
- Re-chunking or re-embedding the corpus with a different strategy; the eval will say whether that is needed.
- Replacing Voyage with a local model.
- Verification of passages (as opposed to facts and nodes).
- A web UI. The CLI and MCP tools are the interfaces; the README gains a "How retrieval works and how to audit it" section for sharing the approach.

## 12. Phase order and definition of done

| Phase | Content | Done when |
|---|---|---|
| 0 | Eval isolation, golden v2 conversion, metrics module, baseline on current code | `brain eval run` refuses the real database; `eval/baseline.json` committed; README reports the numbers |
| 1 | Retrieval correctness (§3) | `EXPLAIN` test green; eval delta reviewed and accepted |
| 2 | Authorship and facts (§4) | Attribution fixtures produce 0 self facts; Databricks cleanup done on the real base |
| 3 | Spending guard (§5) | Ledger rows appear for every call; cap test green; `brain usage` prints |
| 4 | Evidence contract (§6) | `brain_search` output carries mode, scores and author; `brain_explain` replays a logged search |
| 5 | Citation verification (§7) | `brain_verify` live; verifier test cases green; server instructions updated |
| 6 | Eval program (§8) | ≥ 60 approved golden items; `npm run eval:gate` wired; all metrics reported |
