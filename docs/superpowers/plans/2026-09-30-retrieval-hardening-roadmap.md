# Retrieval Hardening Roadmap (Phases 2–6)

**Spec:** `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md`
**Detailed plans so far:** `2026-09-30-phase-0-eval-isolation.md`, `2026-09-30-phase-1-retrieval-correctness.md`.

This document fixes the task breakdown, file layout and acceptance tests for the remaining phases so that each can be expanded into a step-by-step plan (same format as Phases 0 and 1) when its turn comes. Expansion happens one phase at a time, after the previous phase's eval delta has been reviewed, so that each plan is written against the code as it then is rather than as it is imagined now.

Rules that apply to every phase:
- Tests first. Unit tests where no database is needed; integration tests against `brain_test` otherwise.
- Every phase ends with `npm run eval:run`; a regression is explained in the commit or fixed before `eval run --accept`.
- One migration file per phase, numbered after the last one that exists.
- Commit per task with the attribution line.

---

## Phase 2: Authorship and facts about the owner (spec §4)

| # | Task | Files | Tests that prove it |
|---|---|---|---|
| 1 | `documents.author` column (`owner`/`other`/`unknown`, default `unknown`), backfill by source kind, `config.authorDefaults` | `supabase/migrations/20260930000009_author.sql`, `src/config.ts`, `src/ingest/store.ts` (`StoreInput.author`) | integration: ingest without author stores the mapped default; with `author: "other"` stores that; migration backfills a pre-existing `note` to `owner` |
| 2 | Author on the inputs: `brain ingest --author`, `brain_ingest` `author` parameter, shown in `brain_get_document` and the Obsidian document note | `src/cli.ts`, `src/mcp/server.ts`, `src/mcp/render.ts`, `src/retrieve/documents.ts`, `src/obsidian/render.ts` | unit: render shows `author: other`; integration: MCP ingest with `author` round-trips through `brain_get_document` |
| 3 | Extraction header carries `Author:` and `Origin:`; pronoun rule conditional on author | `src/ingest/stages/extract.ts` (`extractionSystem`, `buildExtractionRequests`) | unit: system prompt for `author: other` contains the "not the owner" rule and the `facts_about_self must be empty` sentence; for `owner` contains the current rule |
| 4 | Hard gate in resolve: self facts and self-origin relations written only when `author = owner`; otherwise kept in the payload as `suppressed: "author_not_owner"` and counted in `documents.metadata.suppressed_self_items` | `src/ingest/stages/resolve.ts` | integration: first-person text with `author: other` and a fake extraction containing one self fact and one self relation produces 0 facts, 0 self edges, `suppressed_self_items = 2`; same text with `author: owner` produces both |
| 5 | Re-run resolution cleanly: `undoResolution(documentId)` deletes the facts, edges and mentions that document produced (by `source_chunk_id` / `evidence_chunk_id` / `chunk_id` in that document's chunks) before `runResolve` reapplies | `src/ingest/stages/resolve.ts` | integration: ingest as `owner`, switch to `other`, re-resolve: facts gone, nodes stay |
| 6 | `brain set-author <document> <author>` runs the backfill rule override and re-resolution; `brain status` and `brain_status` show suppressed counts | `src/cli.ts`, `src/mcp/server.ts`, `src/mcp/render.ts` | integration: CLI command flips author and removes facts |
| 7 | Supersession by the extractor for `config.singleValuedPredicates`; `brain.fact_events` log | migration (same file as task 1), `src/ingest/stages/resolve.ts`, `src/graph/facts.ts` | integration: two owner notes with `lives_in` Austin then Denver: one current fact (Denver), old one `superseded_by` set, one `fact_events` row; `skill` twice: two current facts |
| 8 | Fixture corpus additions and attribution golden items: `note--databricks-cost-governance.md` (`author: other` front matter), `email--recruiter-intro.md` (`author: other`, names Frank), `note--moved-to-denver.md` (`owner`, supersedes) ; `kindFromFilename` reads `author` from front matter | `eval/corpus/*`, `src/eval/run.ts`, `eval/golden.jsonl` (3 `attribution` items) | eval: attribution metric = 0 self facts from `other` fixtures; unit: front matter parsing |
| 9 | Real-base cleanup: migration backfill, `brain set-author <databricks doc> other`, verify facts F11/F18/F4 and the self→cost-governance edge are gone; `brain_orient` shows the remaining facts | manual, documented in README | `brain facts` output pasted in the PR description |

Done when: attribution fixtures produce 0 self facts and 0 self edges; the real base no longer attributes the Databricks post to the owner; `npm run eval:gate` passes.

---

## Phase 3: Voyage spending guard (spec §5)

| # | Task | Files | Tests that prove it |
|---|---|---|---|
| 1 | `brain.provider_usage` table; `VoyageClient` records `usage.total_tokens`, requests, operation, model, client, error per call | `supabase/migrations/20260930000010_provider_usage.sql`, `src/llm/voyage.ts` (constructor takes `sql` and `client` label; `embed`/`rerank` insert a row), `src/ctx.ts` | unit (fake fetch): embed and rerank each insert one row with the token count from the response; a 500 inserts a row with `tokens 0` and the error |
| 2 | Daily cap: `BRAIN_VOYAGE_DAILY_TOKEN_CAP` (default 5,000,000); estimate `chars/4` before the call; `SpendCapError` when today's sum + estimate exceeds it | `src/llm/voyage.ts`, `src/llm/errors.ts`, `src/config.ts` | unit with injected clock and seeded usage rows: the call that would cross the cap throws before fetch is called; a call under the cap proceeds |
| 3 | Pipeline behaviour on the cap: embed stage records `error = spend_cap` and stops; `brain retry` resumes | `src/ingest/pipeline.ts`, `src/ingest/stages/embed.ts` | integration: with cap 1, ingest stops at `chunked` with `spend_cap`; raising the cap and `retry` finishes |
| 4 | Search behaviour on the cap: keyword-only with `degraded.capReached` (the `degraded` object lands in Phase 4; until then a boolean `capReached` on `SearchResult`) and an accurate message | `src/retrieve/search.ts`, `src/mcp/render.ts` | integration: with cap 1, search returns keyword hits and `capReached: true`; render says "daily cap reached" |
| 5 | Query-time retry budget: 3 attempts, backoff capped at 10 s total | `src/ctx.ts`, `src/llm/voyage.ts` | unit: two 429s then success returns the result within the budget; three 429s throws |
| 6 | `brain usage [--days N]` and the `brain_orient` line; price env vars (`BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED`, `..._RERANK`, default 0 prints tokens only) | `src/cli.ts`, `src/retrieve/orient.ts`, `src/mcp/render.ts`, `.env.example`, `README.md` | integration: seeded rows across two days print per-day totals; orient text contains `Voyage today:` |

Done when: every Voyage call has a ledger row; cap tests green; `brain usage` prints; README documents the cap and prices.

---

## Phase 4: Evidence contract (spec §6)

| # | Task | Files | Tests that prove it |
|---|---|---|---|
| 1 | `SearchResult` v2: per-passage `author`, `origin`, `occurredAt`, `scoreKind`, `layers[]`, `vectorRank`, `keywordRank`, `rerankRank`; per-search `retrievalId`, `degraded {embedding, rerank, capReached}`, `fallbackUsed`, `entities[].matchedSpan`, `facts[].verifiedBy/sourceChunkId/confidence`, `candidates`, `timings` | `src/retrieve/search.ts` (split: `search.ts` orchestration, `retrieve/layers.ts` per-layer queries, `retrieve/contract.ts` types) | integration: a hybrid passage found by both branches reports both ranks and `layers: ["vector","keyword"]`; a graph passage reports `layers: ["graph"]` and `scoreKind: "none"`; timings are positive |
| 2 | `retrieval_log` v2: `results jsonb`, `degraded jsonb`, `candidates jsonb`, `timings jsonb`, `k int`, index on `created_at`; `retrievalId` returned to the caller | `supabase/migrations/20260930000011_retrieval_log_v2.sql`, `src/retrieve/search.ts` | integration: after a search the log row's `results` has one entry per passage with `score` and `layers`; `degraded` is a JSON object |
| 3 | MCP rendering from the structure: header `mode:` line (four exact variants), `retrieval: <id>`, per-passage provenance line, graph `via <entity>`, fallback `"<term>"`, facts `from <kind> <doc id>`; `structuredContent` alongside text | `src/mcp/render.ts`, `src/mcp/server.ts` | unit: render of a fixture result matches a snapshot string; four degraded combinations produce the four mode lines; `structuredContent` equals the result minus `content` |
| 4 | `brain_explain(retrieval_id)` and `brain explain <id>`: replay from the log, no new search | `src/retrieve/explain.ts`, `src/mcp/server.ts`, `src/mcp/render.ts`, `src/cli.ts` | integration: explain of a logged search lists each passage with its ranks and the mode; unknown id returns a readable error |
| 5 | CLI `search` prints mode and scores; `ask` passes `degraded` and `fallbackUsed` into its prompt header | `src/cli.ts`, `src/retrieve/ask.ts` | unit: ask prompt contains `Search mode: keyword-only` when degraded |
| 6 | Eval reads `timings` and `degraded` from the result instead of wall-clock and the boolean | `src/eval/run.ts` | unit: `toQuestionResult` uses `res.timings.totalMs` |

Done when: `brain_search` output shows mode, scores, layers and author on every passage; `brain_explain` replays a logged search; eval reports stage timings.

---

## Phase 5: Deterministic citation verification (spec §7)

| # | Task | Files | Tests that prove it |
|---|---|---|---|
| 1 | Term extraction shared with Postgres: `stems(text)` via `select lexeme from unnest(to_tsvector('english', $1))`; number/date extraction with normalisation (`1,000`→`1000`, `~11%`→`11%`, `$115k` kept) | `src/verify/terms.ts` | integration (needs Postgres for stemming): stems of "Databricks saves money" are `databrick`, `save`, `money`; numbers of "lifted ~11% and 1,000 orders" are `11%`, `1000` |
| 2 | `verifyClaims(sql, retrievalId, claims)`: resolve `P`/`F` labels through `retrieval_log.results` and the facts table; compute support, missing terms, missing numbers; verdicts `supported` / `partial` / `unsupported` / `uncited` / `bad_citation` with the thresholds in spec §7.2 | `src/verify/verify.ts` | unit with an in-memory passage map (20+ cases in `test/unit/verify.test.ts`): exact restatement → supported; paraphrase with half the terms → partial; number absent → partial with `missingNumbers`; no cites → uncited; `P99` → bad_citation; claim citing two passages whose union covers it → supported |
| 3 | `brain_verify` tool and `brain verify <retrieval id> --claims <file.json>` | `src/mcp/server.ts`, `src/mcp/render.ts`, `src/cli.ts` | integration: a search then verify of two claims returns the two verdicts and the summary line |
| 4 | Server instructions: after composing an answer, call `brain_verify`; present non-supported claims as the model's own | `src/mcp/server.ts` | unit: instructions text contains the sentence |
| 5 | `ask` runs the verifier on its own answer: split the answer into sentences, attach the `[P..]`/`[F..]` labels found in each, verify, print verdicts under the sources | `src/retrieve/ask.ts`, `src/cli.ts` | integration with a fake LLM that returns a fixed answer citing P1: output contains `supported` for the restated sentence |
| 6 | Verifier golden set `eval/verifier.jsonl` (hand-labelled triples, 30+) and the `verifierAccuracy` metric (precision/recall of `supported`) | `eval/verifier.jsonl`, `src/eval/metrics.ts`, `src/eval/run.ts` | unit: metric computed from a synthetic set; eval prints `verifier precision/recall` |

Done when: `brain_verify` is live; the unit cases are green; `eval` reports verifier precision and recall ≥ 0.9 on the labelled set; README documents the verdicts and their limits.

---

## Phase 6: Eval program (spec §8, remaining parts)

| # | Task | Files | Tests that prove it |
|---|---|---|---|
| 1 | `brain eval sync`: `pg_dump --data-only` of `brain.documents, chunks, nodes, edges, mentions, facts, extractions, ingest_jobs` from `DATABASE_URL` into `EVAL_DATABASE_URL` after truncate; refuses unless the target name ends in `_eval` | `scripts/sync-eval-db.sh`, `src/cli.ts` | manual: after sync, `select count(*) from brain.documents` matches the real base; `retrieval_log` is empty |
| 2 | `brain eval draft [--since] [--limit]`: one Claude Code call per real document without drafts, producing 2–3 questions with verbatim quote and two paraphrases, appended to `eval/drafts.jsonl` with `source: "generated"`; a draft is rejected at write time if its quote is not found verbatim in the document | `src/eval/draft.ts`, `src/cli.ts` | unit with a fake LLM: drafts with a bad quote are dropped and reported; integration: drafted items parse as golden items minus `approved_at` |
| 3 | `brain eval approve [--all | --id ...]` and `brain eval reject --id ...` | `src/eval/golden.ts` (append), `src/cli.ts` | unit: approve moves a draft into golden with today's `approved_at`; reject removes it |
| 4 | `brain eval capture [--since]` lists `retrieval_log` rows (query, mode, top passages with titles); `brain eval label <retrieval id> --expect <doc id or origin> [--quote] [--negative]` writes a golden item with `source: "captured"` | `src/eval/capture.ts`, `src/cli.ts` | integration: a logged search becomes a golden item with `document_id` and the given quote |
| 5 | Attribution metric: `attribution` items name a fixture document; after `eval ingest`, the metric counts self facts and self edges whose source chunk belongs to an `author: other` document; must be 0 | `src/eval/metrics.ts`, `src/eval/run.ts` | unit: synthetic counts; integration: Phase 2 fixtures yield 0 |
| 6 | Voyage tokens per query and per ingested document from `provider_usage` (Phase 3) in the report; gate adds attribution failures | `src/eval/run.ts`, `src/eval/baseline.ts` | unit: gate fails on `attribution.failures > 0` |
| 7 | Grow the golden set to ≥ 60 approved items (≥ 10 negative, ≥ 5 attribution, every kind represented), using `draft` on the real documents and `capture` on logged searches; accept the new baseline | `eval/golden.jsonl`, `eval/baseline.json` | `brain eval run` prints `n=60+`; per-kind lines all non-empty |
| 8 | README "How retrieval works and how to audit it": the five layers, the evidence contract, `brain_explain`, `brain_verify`, the eval metrics with definitions, the baseline numbers and date; one diagram (SVG in `docs/`) | `README.md`, `docs/retrieval.svg` | review |

Done when: ≥ 60 approved golden items; `npm run eval:gate` wired with all metrics; README section published.

---

## Order and gating

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6
baseline    retrieval   authorship   spend cap   evidence    verifier    eval program
```

Phases 2 and 3 do not depend on each other and could be swapped; Phase 4 depends on 3 (the `capReached` flag) and Phase 5 on 4 (labels resolved through the v2 log). Phase 6 depends on 2, 3 and 5 for its metrics.
