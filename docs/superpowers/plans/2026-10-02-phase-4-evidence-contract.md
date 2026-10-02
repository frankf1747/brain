# Phase 4: Evidence Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every answer can be traced to exactly what the knowledge base returned, and every search can be replayed. `search()` returns one structure, the evidence contract: per passage its document, title, kind, author, origin, date, score and what the score means, which branches found it and at what ranks, the rerank position, and for graph and fallback passages the entity or literal term that brought them in; per search its retrieval id, k, mode, which parts fell back, candidate counts and stage timings. `brain.retrieval_log` stores that structure (passages without their text). The `brain_search` text, the CLI `search` and `ask` output, and the `ask` prompt are all generated from it; `brain_search` also returns it as `structuredContent`. `brain_explain(retrieval_id)` and `brain explain <id>` replay a logged search from the log alone. The owner asked for this in their words: "workflow transparency is important", "users needs to see or know the info it cited that is in the KB, and what is from LLM", and they will "share the logic with professionals".

**Architecture:** `src/retrieve/contract.ts` defines the contract as zod schemas (the TypeScript types are inferred from them, and the MCP `outputSchema` is the same object) plus the small pure functions every consumer shares: `searchMode`, `degradedNote`, `isDegraded`, `hybridLayers`, `isHybrid`, `toLoggedPassages`, `factSource`. `search.ts` is split: `src/retrieve/layers.ts` holds the per-layer SQL (candidates, passage rows, summaries, neighbours, mentions, facts, the fallback scan), and `search.ts` keeps the orchestration (embedding, fusion, rerank, assembling passages with their provenance, timings, the log insert, which returns `retrievalId`). Migration `20261002000011_retrieval_log_v2.sql` adds `results`, `degraded`, `candidates`, `timings` (jsonb), `k`, `mode` and an index on `created_at`; the v1 columns stay and are still written. `src/mcp/render.ts` generates every line from the structure (`searchHeader`, `passageLine`, `factLine`, `renderSearch`, `renderSources`, `renderExplain`). `src/retrieve/explain.ts` reads one log row through `to_jsonb`, so it works on rows logged before the migration and on a database without it. `ask` puts the mode, notes, scores and authors into its prompt. The eval reads `res.timings` and reports p50/p95 per stage.

**Tech Stack:** Postgres 17.6, pgvector 0.8.2 (local Supabase, port 55322), TypeScript ESM run with tsx, vitest, zod 4, postgres.js, commander, @modelcontextprotocol/sdk 1.31.0 (`registerTool` takes `outputSchema`; a tool with one must return `structuredContent`, which the server validates with the zod schema and the client validates against the advertised JSON schema).

**Spec:** `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` §6. Task breakdown: the Phase 4 table in `docs/superpowers/plans/2026-09-30-retrieval-hardening-roadmap.md`. Numbering here: **Task 1** is the contract types (the first half of roadmap 1), **Task 2** is the migration (the schema half of roadmap 2), **Task 3** is roadmap 1 and the write half of roadmap 2 (search returns the contract and logs it, with the breaking-change sweep that keeps every consumer compiling), **Task 4** is roadmap 3 and the CLI `search` half of roadmap 5, **Task 5** is roadmap 4, **Task 6** is the `ask` half of roadmap 5, **Task 7** is roadmap 6, **Task 8** applies the migration to the real database (controller only).
**Prerequisite:** Phase 3 complete and merged (`422d151`). Work on branch `evidence-contract`.
**Working directory:** `/Users/frankfu/Documents/GitHub/brain`

Rules for every task:
- Integration tests run on `brain_test` only: `npm run test:int` recreates it from all migrations. Run one integration file with `bash scripts/prepare-test-db.sh && npx vitest run <file>`. **Only one agent runs `test:int` (or `prepare-test-db.sh`) at a time**: the script drops and recreates `brain_test`, which breaks any other run in progress. Unit tests: `npx vitest run <file>` or `npm run test:unit`. **Unit tests make no network calls** and touch no database; anything that needs a table is an integration test.
- Migrations are applied to `brain_eval` with `psql`. **Never touch the `postgres` database (the real knowledge base) except in Task 8, which the controller runs, not a subagent.** Never use `supabase migration up`: the real database's migration table is out of sync.
- Migration 011 is idempotent (`add column if not exists`, constraints added only when missing, `create index if not exists`) inside `begin`/`commit`. Re-applying it is always safe.
- From Task 3 on, `search()` writes the v2 columns, so migration 011 must be on `brain_eval` (Task 2, Step 6) before anything searches there.
- Tasks 3 and 7 end with `npm run eval:run` (they change how search and the eval measure, not what they rank; the ranks must not move). Tasks 4 and 5 end with one CLI command on `brain_eval` (`OBSIDIAN_AUTO=0 DATABASE_URL=…/brain_eval`, so the real database and the Obsidian mirror are never touched). The rest end with `npm run typecheck` and the test suites.
- Commit per task. The last line of every commit message is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

How the plan answers the owner:
- **Transparency of the workflow:** each passage line says how the passage was found (`vector#2 keyword#5`, `graph via Acme Corp`, `fallback "X-90"`), its score and what kind of score it is, and the header says whether the search ran in full (`mode: hybrid`) or fell back, and why. `brain_explain` replays any search from the log: candidates per branch, stage timings, every rank.
- **What is from the knowledge base and what is from the model:** the text the model reads is generated from the same structure that is logged, and it carries ids for every passage (`doc`, `chunk`) and fact (`from <kind> <doc id>` or `stated by owner`). The server instructions now ask clients to make clear which parts of an answer come from the knowledge base and which are their own; `brain ask` prints its sources under the answer, labelled as the knowledge base's.
- **Logic professionals can check:** the contract is one schema file (`src/retrieve/contract.ts`), the README gains a "Reading a search result" section that defines every field, and the log keeps everything needed to audit a search after the fact.

Decisions the real code forced or settled (details in the self-review notes):
- **The split is worth it.** `search.ts` is 341 lines today and would pass 450 with provenance, timings and the v2 log. The per-layer SQL (about 190 lines) changes when retrieval changes; the orchestration (about 245 lines) changes when the contract changes. Each file now has one reason to change, and `layers.ts` knows nothing about scores or the contract.
- **`structuredContent` carries the passage text.** The MCP spec lets a client read `structuredContent` instead of the text block. A client that did so without `content` would hold ids and scores but no evidence, and its model would cite passages it never saw: the failure the owner wants to rule out. The cost is size: the passage text appears twice for a client that forwards both blocks (at k = 10, about 10 passages of a few hundred tokens each). The log still stores the contract without `content` (the text is in `brain.chunks` and `brain.documents`).
- **Dates are ISO strings in the contract** (`occurredAt`). The SDK validates `structuredContent` with the zod schema, and a `Date` would fail it; ISO strings also make the logged JSON and the sent JSON identical.
- **`score` is null when `scoreKind` is `"none"`** (graph and fallback passages) instead of 0, so no consumer can mistake "not scored" for "scored zero".
- **`degraded.rerank` is true whenever no rerank ran**, including after a failed query embedding (the rerank is skipped then). That keeps one rule: whenever `degraded.rerank` is true, `topScore` and every `rerankRank` are null and every hybrid score is an RRF value.
- **The header states the mode as the contract value** (`mode: hybrid`, `mode: keyword-only`, `mode: fused-order`), the same word the log and `structuredContent` hold, and the line after it keeps Phase 3's four degraded notes, so the four degraded combinations still produce four distinct texts.
- **Fact provenance needs a join.** `brain.current_facts()` does not return `verified_by`; the facts query joins `brain.facts` for it and `brain.chunks`/`brain.documents` for the source document and its kind. A fact can also be extractor-written with its source passage gone (re-chunking sets `source_chunk_id` null); it renders as `extracted; source passage no longer stored` rather than being called the owner's.

---

## File structure

```
supabase/migrations/
  20261002000011_retrieval_log_v2.sql   NEW (T2): results, degraded, candidates, timings, k, mode; checks; created_at index
src/
  retrieve/contract.ts                  NEW (T1): zod schemas and types of the evidence contract; searchMode, degradedNote,
                                        isDegraded, hybridLayers, isHybrid, toLoggedPassages, factSource, NOT_DEGRADED
  retrieve/layers.ts                    NEW (T3): per-layer SQL moved out of search.ts (candidateQueries, loadChunks,
                                        summaryDocuments, entityNeighbors, mentionedChunkIds, factsLayer, fallbackScan,
                                        fallbackWindow)
  retrieve/search.ts                    REWRITE (T3): orchestration; returns the contract; logs v2; re-exports the types
  retrieve/explain.ts                   NEW (T5): explain(sql, id), explainNotFound, Explanation
  retrieve/ask.ts                       MODIFY: p.title (T3); prompt header with mode and notes, provenance per passage,
                                        how to weigh scores and authors (T6)
  mcp/render.ts                         MODIFY: degradedNote/searchMode move to contract.ts (T3); scoreText, foundBy,
                                        passageLine, factLine, searchHeader, renderSearch from the structure, brief mode
                                        (T4); explainLine, renderExplain, orient guidance (T5); renderSources (T6)
  mcp/server.ts                         MODIFY: brain_search outputSchema + structuredContent, description, instructions,
                                        'doc <id>' (T4); brain_explain, read-only; mentions of it (T5)
  cli.ts                                MODIFY: field renames (T3); search prints renderSearch brief (T4); explain command
                                        and hint (T5); ask prints renderSources (T6); eval stages line (T7)
  eval/run.ts                           MODIFY: layers/isDegraded (T3); toQuestionResult reads res.timings, timedSearch
                                        removed, stageLatencyLine (T7)
  eval/metrics.ts                       MODIFY (T7): QuestionResult.timings, Report.stageLatencyMs (optional), Percentiles
  eval/baseline.ts                      MODIFY (T7): ReportSchema.stageLatencyMs optional
README.md                               MODIFY: explain command, ten tools, "Reading a search result" (T5); ask (T6);
                                        eval stage latency (T7)
test/
  unit/search-fixture.ts                NEW (T1): passage(), fact(), searchResult() builders (not a test file)
  unit/contract.test.ts                 NEW (T1)
  integration/retrieval-log.test.ts     NEW (T2)
  integration/search.test.ts            MODIFY (T3)
  unit/render.test.ts                   MODIFY (T3, T4, T5, T6)
  unit/eval.test.ts                     MODIFY (T3, T7)
  integration/mcp-server.test.ts        MODIFY (T4, T5)
  integration/explain.test.ts           NEW (T5)
  unit/ask.test.ts                      NEW (T6)
  integration/ask.test.ts               MODIFY (T6)
  unit/metrics.test.ts                  MODIFY (T7)
  unit/baseline.test.ts                 MODIFY (T7)
```

Breaking-change sweep (every consumer of `SearchResult`, `Passage`, `degraded`, `degradedReason`, `usedFallback`, `documentTitle` and `group`, found with `grep -rnE "\.group\b|group:|degraded|SearchResult|\bPassage\b|PassageGroup|documentTitle|usedFallback|topScore" src test`): `src/retrieve/search.ts`, `src/mcp/render.ts`, `src/cli.ts`, `src/retrieve/ask.ts`, `src/eval/run.ts`, `src/mcp/server.ts` (through `renderSearch`), `test/integration/search.test.ts`, `test/unit/render.test.ts`, `test/unit/eval.test.ts`, `test/integration/mcp-server.test.ts`. `src/obsidian/*` does not read search results (its one `group` is an unrelated local variable in `names.ts`). `src/eval/metrics.ts` keeps its own boolean `QuestionResult.degraded`, now computed with `isDegraded`. Renames: `group` → `layers` (`"hybrid"` becomes `["vector"]`, `["keyword"]` or `["vector","keyword"]`; `"graph"` → `["graph"]`; `"fallback"` → `["fallback"]`), `documentTitle` → `title`, `usedFallback` → `fallbackUsed`, boolean `degraded` + `degradedReason` + `capReached` → `degraded: { embedding, rerank, capReached }` plus `mode`. `degradedReason` is removed: `degradedNote(degraded)` derives the text. `parentContent` is removed (nothing reads it).

---

### Task 1: The evidence contract

**Files:**
- Create: `src/retrieve/contract.ts`
- Create: `test/unit/search-fixture.ts`
- Create: `test/unit/contract.test.ts`

The contract is written as zod schemas so one definition serves three purposes: the TypeScript types (`z.infer`), the MCP `outputSchema` of `brain_search` (Task 4), and parsing log rows in `brain_explain` (Task 5). Nothing imports it yet, so this task changes no behaviour.

Fields, per passage: `chunkId` (null for a fallback window), `documentId`, `title`, `sourceKind`, `author`, `origin`, `occurredAt` (ISO or null), `headingPath`, `content`, `charStart`, `charEnd`, `score` (null when `scoreKind` is `"none"`), `scoreKind` (`"rerank"` | `"rrf"` | `"none"`), `layers` (`("vector"|"keyword"|"graph"|"fallback")[]`), `vectorRank`, `keywordRank`, `rerankRank`, `fallbackTerm`, `viaEntity` (`{ id, name }`). Per search: `retrievalId`, `query`, `k`, `mode` (`"hybrid"` | `"keyword-only"` | `"fused-order"`), `degraded` (`{ embedding, rerank, capReached }`), `fallbackUsed`, `topScore`, `passages`, `documents` (the summary layer, unchanged), `entities` (with `matchedSpan`), `facts` (with `verifiedBy`, `sourceChunkId`, `sourceDocumentId`, `sourceKind`, `confidence`, `verified`), `candidates` (`{ vector, keyword, fused }`), `timings` (`{ embedMs, sqlMs, rerankMs, graphMs, totalMs }`).

- [ ] **Step 1: Write the test fixture builders**

`test/unit/search-fixture.ts` (no `.test.` in the name, so vitest does not collect it; Tasks 3 to 7 reuse it):
```ts
import type { FactRow, Passage, SearchResult } from "../../src/retrieve/contract.js";

/** A hybrid passage found by both branches and reranked first; override any field. */
export function passage(over: Partial<Passage> = {}): Passage {
  return {
    chunkId: "c1",
    documentId: "d1",
    title: "Doc",
    sourceKind: "news",
    author: "other",
    origin: null,
    occurredAt: "2026-09-29T00:00:00.000Z",
    headingPath: [],
    content: "Body text",
    charStart: 0,
    charEnd: 9,
    score: 0.76,
    scoreKind: "rerank",
    layers: ["vector", "keyword"],
    vectorRank: 2,
    keywordRank: 5,
    rerankRank: 1,
    fallbackTerm: null,
    viaEntity: null,
    ...over,
  };
}

/** An extracted fact read from a stored passage; override any field. */
export function fact(over: Partial<FactRow> = {}): FactRow {
  return {
    id: "f1",
    predicate: "visa_status",
    objectText: "F-1 OPT",
    confidence: 0.9,
    verified: false,
    verifiedBy: "extractor:claude-test",
    sourceChunkId: "c9",
    sourceDocumentId: "d9",
    sourceKind: "note",
    ...over,
  };
}

/** A full hybrid search with no passages; override any field. */
export function searchResult(over: Partial<SearchResult> = {}): SearchResult {
  return {
    retrievalId: "r1",
    query: "q",
    k: 10,
    mode: "hybrid",
    degraded: { embedding: false, rerank: false, capReached: false },
    fallbackUsed: false,
    topScore: null,
    passages: [],
    documents: [],
    entities: [],
    facts: [],
    candidates: { vector: 0, keyword: 0, fused: 0 },
    timings: { embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0.5, totalMs: 7 },
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing unit test**

`test/unit/contract.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  SearchResultSchema, LoggedPassageSchema, searchMode, degradedNote, isDegraded, hybridLayers, isHybrid, toLoggedPassages, factSource,
} from "../../src/retrieve/contract.js";
import { passage, fact, searchResult } from "./search-fixture.js";

describe("search mode and degraded notes", () => {
  it("maps the degraded flags to the mode and the four Phase 3 notes", () => {
    const cases = [
      { d: { embedding: false, rerank: false, capReached: false }, mode: "hybrid", note: null },
      { d: { embedding: true, rerank: true, capReached: true }, mode: "keyword-only", note: "Voyage daily cap reached; keyword-only results" },
      { d: { embedding: true, rerank: true, capReached: false }, mode: "keyword-only", note: "query embedding failed; keyword-only results" },
      { d: { embedding: false, rerank: true, capReached: true }, mode: "fused-order", note: "Voyage daily cap reached; results in fused order" },
      { d: { embedding: false, rerank: true, capReached: false }, mode: "fused-order", note: "reranking failed; results in fused order" },
    ] as const;
    for (const c of cases) {
      expect(searchMode(c.d)).toBe(c.mode);
      expect(degradedNote(c.d)).toBe(c.note);
      expect(isDegraded(c.d)).toBe(c.mode !== "hybrid");
    }
  });
});

describe("layers", () => {
  it("names the branches that found a hybrid passage, vector first", () => {
    expect(hybridLayers(2, 5)).toEqual(["vector", "keyword"]);
    expect(hybridLayers(null, 1)).toEqual(["keyword"]);
    expect(hybridLayers(3, null)).toEqual(["vector"]);
    expect(hybridLayers(null, null)).toEqual([]);
  });

  it("tells hybrid passages from graph and fallback ones", () => {
    expect(isHybrid(passage())).toBe(true);
    expect(isHybrid(passage({ layers: ["keyword"] }))).toBe(true);
    expect(isHybrid(passage({ layers: ["graph"] }))).toBe(false);
    expect(isHybrid(passage({ layers: ["fallback"] }))).toBe(false);
  });
});

describe("toLoggedPassages", () => {
  it("keeps every field except the text, in order, including fallback passages without a chunk", () => {
    const fb = passage({ chunkId: null, documentId: "d2", layers: ["fallback"], score: null, scoreKind: "none", vectorRank: null, keywordRank: null, rerankRank: null, fallbackTerm: "X-90" });
    const logged = toLoggedPassages([passage(), fb]);
    expect(logged).toHaveLength(2);
    expect(logged[0]).not.toHaveProperty("content");
    const { content: _c, ...rest } = passage();
    expect(logged[0]).toEqual(rest);
    expect(logged[1]).toMatchObject({ chunkId: null, documentId: "d2", fallbackTerm: "X-90", layers: ["fallback"] });
    expect(logged.every((p) => LoggedPassageSchema.safeParse(p).success)).toBe(true);
  });
});

describe("factSource", () => {
  it("says a fact came from a document, from the owner, or from a passage that is gone", () => {
    expect(factSource(fact())).toEqual({ kind: "document", sourceKind: "note", documentId: "d9" });
    expect(factSource(fact({ sourceChunkId: null, sourceDocumentId: null, sourceKind: null, verifiedBy: "agent:claude-code" }))).toEqual({ kind: "owner" });
    expect(factSource(fact({ sourceChunkId: null, sourceDocumentId: null, sourceKind: null, verifiedBy: null }))).toEqual({ kind: "owner" });
    expect(factSource(fact({ sourceChunkId: null, sourceDocumentId: null, sourceKind: null, verifiedBy: "extractor:claude-test" }))).toEqual({ kind: "unlinked" });
    // Verified by the owner after extraction: still from its document.
    expect(factSource(fact({ verified: true, verifiedBy: "frank" }))).toEqual({ kind: "document", sourceKind: "note", documentId: "d9" });
  });
});

describe("SearchResultSchema", () => {
  it("accepts a full result and rejects anything that is not plain JSON", () => {
    const r = searchResult({ passages: [passage()], facts: [fact()], topScore: 0.76 });
    expect(SearchResultSchema.safeParse(r).success).toBe(true);
    const withDate = { ...r, passages: [{ ...passage(), occurredAt: new Date("2026-09-29T00:00:00Z") }] };
    expect(SearchResultSchema.safeParse(withDate).success).toBe(false);
    expect(SearchResultSchema.safeParse({ ...r, mode: "full" }).success).toBe(false);
    expect(SearchResultSchema.safeParse({ ...r, passages: [passage({ layers: ["hybrid" as never] })] }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/unit/contract.test.ts`
Expected: FAIL: `Failed to load url ../../src/retrieve/contract.js` (the module does not exist).

- [ ] **Step 4: Write `src/retrieve/contract.ts`**

```ts
import { z } from "zod";
import { EXTRACTOR_BY_PREFIX } from "../graph/supersede.js";

/**
 * The evidence contract (spec §6.1): what one search returned and how each passage was found. search() builds it,
 * brain_search renders it as text and returns it as structuredContent, brain.retrieval_log stores it (passages
 * without their text), and brain_explain replays it from the log. Every field is plain JSON (dates are ISO 8601
 * strings), so the same object is logged, sent and rendered without conversion.
 */

/** How a passage was found: the vector branch, the keyword branch, entity expansion, or the literal substring scan. */
export const LayerSchema = z.enum(["vector", "keyword", "graph", "fallback"]);

/** What `score` means: the reranker's relevance (0 to 1), a reciprocal-rank-fusion value (reranking skipped), or none. */
export const ScoreKindSchema = z.enum(["rerank", "rrf", "none"]);

/**
 * hybrid: vector and keyword candidates, reranked. keyword-only: the query embedding failed or was refused, so there
 * were no vector candidates and no rerank. fused-order: vector and keyword candidates, but the rerank failed or was
 * refused, so they are in reciprocal-rank-fusion order.
 */
export const SearchModeSchema = z.enum(["hybrid", "keyword-only", "fused-order"]);

export const PassageSchema = z.object({
  /** Null for a fallback passage: a window of the raw document, not a stored chunk. */
  chunkId: z.string().nullable(),
  documentId: z.string(),
  title: z.string().nullable(),
  sourceKind: z.string(),
  /** Who wrote the document: owner, other or unknown. */
  author: z.string(),
  origin: z.string().nullable(),
  /** The date the document is about (ISO 8601), or null when it has none. */
  occurredAt: z.string().nullable(),
  headingPath: z.array(z.string()),
  content: z.string(),
  /** The passage's character window in the document's raw text. */
  charStart: z.number().int(),
  charEnd: z.number().int(),
  /** Null exactly when scoreKind is "none" (graph and fallback passages). */
  score: z.number().nullable(),
  scoreKind: ScoreKindSchema,
  layers: z.array(LayerSchema),
  /** 1-based rank among the vector branch's candidates; hybrid passages only. */
  vectorRank: z.number().int().nullable(),
  /** 1-based rank among the keyword branch's candidates; hybrid passages only. */
  keywordRank: z.number().int().nullable(),
  /** 1-based position in the reranker's output; null when the rerank did not run. */
  rerankRank: z.number().int().nullable(),
  /** The trigger term the literal scan matched; fallback passages only. */
  fallbackTerm: z.string().nullable(),
  /** The entity named in the query whose mentions brought this passage in; graph passages only. */
  viaEntity: z.object({ id: z.string(), name: z.string() }).nullable(),
});

/** A passage as brain.retrieval_log.results stores it: everything except the text. */
export const LoggedPassageSchema = PassageSchema.omit({ content: true });

export const DocHitSchema = z.object({
  documentId: z.string(),
  title: z.string().nullable(),
  sourceKind: z.string(),
  summary: z.string().nullable(),
  /** Reciprocal-rank-fusion value of the summary search. */
  score: z.number(),
});

export const NeighborSchema = z.object({ id: z.string(), type: z.string(), name: z.string(), depth: z.number().int() });

export const EntityHitSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  /** The canonicalised query span that matched this node. */
  matchedSpan: z.string(),
  neighbors: z.array(NeighborSchema),
});

export const FactRowSchema = z.object({
  id: z.string(),
  predicate: z.string(),
  objectText: z.string(),
  confidence: z.number().nullable(),
  verified: z.boolean(),
  /** extractor:<model> for an extracted fact, agent:<client> for brain_add_fact, the verifier's name after verify-fact. */
  verifiedBy: z.string().nullable(),
  /** The passage the extractor read it from; null for a fact the owner stated (or whose passage was re-chunked away). */
  sourceChunkId: z.string().nullable(),
  sourceDocumentId: z.string().nullable(),
  /** source_kind of the source document. */
  sourceKind: z.string().nullable(),
});

export const DegradedSchema = z.object({
  /** The query embedding failed or was refused: no vector candidates, keyword-only. */
  embedding: z.boolean(),
  /** No rerank ran on the candidates (it failed, was refused, or was skipped after the embedding failed). */
  rerank: z.boolean(),
  /** The Voyage daily cap refused the query embedding or the rerank. */
  capReached: z.boolean(),
});

export const CandidatesSchema = z.object({
  /** Passages the vector branch returned (0 in keyword-only mode). */
  vector: z.number().int(),
  /** Passages the keyword branch returned. */
  keyword: z.number().int(),
  /** Distinct passages after fusing the two branches: what the reranker scored or fused order cut from. */
  fused: z.number().int(),
});

/** Milliseconds, one decimal. Stages: the query embedding; candidate, passage, fact and fallback SQL; the rerank; graph expansion. */
export const TimingsSchema = z.object({
  embedMs: z.number(),
  sqlMs: z.number(),
  rerankMs: z.number(),
  graphMs: z.number(),
  /** The whole search up to the retrieval_log insert. */
  totalMs: z.number(),
});

export const SearchResultSchema = z.object({
  /** brain.retrieval_log id; brain_explain(retrieval_id) replays this search. */
  retrievalId: z.string(),
  query: z.string(),
  k: z.number().int(),
  mode: SearchModeSchema,
  degraded: DegradedSchema,
  fallbackUsed: z.boolean(),
  /** The top rerank score; null when no rerank ran (degraded) or nothing was reranked. */
  topScore: z.number().nullable(),
  passages: z.array(PassageSchema),
  documents: z.array(DocHitSchema),
  entities: z.array(EntityHitSchema),
  facts: z.array(FactRowSchema),
  candidates: CandidatesSchema,
  timings: TimingsSchema,
});

export type Layer = z.infer<typeof LayerSchema>;
export type ScoreKind = z.infer<typeof ScoreKindSchema>;
export type SearchMode = z.infer<typeof SearchModeSchema>;
export type Passage = z.infer<typeof PassageSchema>;
export type LoggedPassage = z.infer<typeof LoggedPassageSchema>;
export type DocHit = z.infer<typeof DocHitSchema>;
export type Neighbor = z.infer<typeof NeighborSchema>;
export type EntityHit = z.infer<typeof EntityHitSchema>;
export type FactRow = z.infer<typeof FactRowSchema>;
export type Degraded = z.infer<typeof DegradedSchema>;
export type Candidates = z.infer<typeof CandidatesSchema>;
export type Timings = z.infer<typeof TimingsSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const NOT_DEGRADED: Degraded = { embedding: false, rerank: false, capReached: false };

export function isDegraded(d: Degraded): boolean {
  return d.embedding || d.rerank;
}

export function searchMode(d: Degraded): SearchMode {
  if (d.embedding) return "keyword-only";
  if (d.rerank) return "fused-order";
  return "hybrid";
}

/** The one-line reason for a degraded search (the four notes from Phase 3), or null for a hybrid search. */
export function degradedNote(d: Degraded): string | null {
  if (d.embedding) return d.capReached ? "Voyage daily cap reached; keyword-only results" : "query embedding failed; keyword-only results";
  if (d.rerank) return d.capReached ? "Voyage daily cap reached; results in fused order" : "reranking failed; results in fused order";
  return null;
}

/** The branches that returned a hybrid passage, vector first. */
export function hybridLayers(vectorRank: number | null, keywordRank: number | null): Layer[] {
  return [...(vectorRank !== null ? (["vector"] as const) : []), ...(keywordRank !== null ? (["keyword"] as const) : [])];
}

/** Found by the vector or keyword branch (as opposed to graph expansion or the literal scan). */
export function isHybrid(p: Pick<Passage, "layers">): boolean {
  return p.layers.includes("vector") || p.layers.includes("keyword");
}

/** What retrieval_log.results stores: each passage without its text, in rank order (index 0 is P1). */
export function toLoggedPassages(passages: Passage[]): LoggedPassage[] {
  return passages.map(({ content: _content, ...rest }) => rest);
}

export type FactSource =
  | { kind: "document"; sourceKind: string; documentId: string }
  | { kind: "owner" }
  | { kind: "unlinked" };

/**
 * Where a fact came from. "document": the extractor read it from a passage that is still stored. "owner": no source
 * passage and not written by the extractor (brain_add_fact, or set by hand). "unlinked": written by the extractor,
 * but its source passage is gone (re-chunked).
 */
export function factSource(f: Pick<FactRow, "sourceChunkId" | "sourceDocumentId" | "sourceKind" | "verifiedBy">): FactSource {
  if (f.sourceChunkId && f.sourceDocumentId && f.sourceKind) return { kind: "document", sourceKind: f.sourceKind, documentId: f.sourceDocumentId };
  if (!(f.verifiedBy ?? "").startsWith(EXTRACTOR_BY_PREFIX)) return { kind: "owner" };
  return { kind: "unlinked" };
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/unit/contract.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck and the unit suite**

Run: `npm run typecheck && npm run test:unit`
Expected: all green. Nothing else changed, so the integration suite is not needed here.

- [ ] **Step 7: Commit**

```bash
git add src/retrieve/contract.ts test/unit/search-fixture.ts test/unit/contract.test.ts
git commit -m "Evidence contract: zod schemas and types for a search result, mode and degraded notes, fact provenance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `retrieval_log` v2

**Files:**
- Create: `supabase/migrations/20261002000011_retrieval_log_v2.sql`
- Create: `test/integration/retrieval-log.test.ts`

`brain.retrieval_log` is defined in `20260927000002_graph.sql` with `id, query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client, created_at` and row level security. The migration adds the v2 columns, all nullable so the old insert keeps working (and rows logged before it stay as they are), two checks (`mode` is one of the three modes; `results` is a JSON array), and an index on `created_at` for listing recent searches (Phase 6's `eval capture` reads it that way). Fallback passages have no chunk id, which is why `results` is jsonb rather than another uuid array: each entry carries `documentId` and `fallbackTerm` instead.

- [ ] **Step 1: Write the failing integration test**

`test/integration/retrieval-log.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { testDb, wipe } from "./helpers.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("brain.retrieval_log v2 (migration 011)", () => {
  it("has the v2 columns, the created_at index and the checks, and re-applies cleanly", async () => {
    const cols = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
      where table_schema = 'brain' and table_name = 'retrieval_log' and column_name in ('results', 'degraded', 'candidates', 'timings', 'k', 'mode')
      order by column_name`;
    expect(cols).toEqual([
      { column_name: "candidates", data_type: "jsonb" },
      { column_name: "degraded", data_type: "jsonb" },
      { column_name: "k", data_type: "integer" },
      { column_name: "mode", data_type: "text" },
      { column_name: "results", data_type: "jsonb" },
      { column_name: "timings", data_type: "jsonb" },
    ]);
    const [idx] = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = 'brain' and indexname = 'retrieval_log_created_at'`;
    expect(idx.indexdef).toContain("(created_at DESC)");
    await expect(sql`insert into brain.retrieval_log (query, mode) values ('q', 'full')`).rejects.toThrow(/retrieval_log_mode_check/);
    await expect(sql`insert into brain.retrieval_log (query, results) values ('q', '{}'::jsonb)`).rejects.toThrow(/retrieval_log_results_check/);
    const file = await readFile(new URL("../../supabase/migrations/20261002000011_retrieval_log_v2.sql", import.meta.url), "utf8");
    // The file has its own begin/commit, so it runs on one reserved connection, exactly as psql runs it.
    const conn = await sql.reserve();
    try {
      await conn.unsafe(file);
      await conn.unsafe(file);
    } finally {
      conn.release();
    }
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_constraint where conrelid = 'brain.retrieval_log'::regclass and conname like 'retrieval_log_%_check'`;
    expect(n).toBe(2);
  });

  it("still takes a v1 insert, leaving the v2 columns null", async () => {
    const [row] = await sql<{ results: unknown; degraded: unknown; k: number | null; mode: string | null }[]>`
      insert into brain.retrieval_log (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client)
      values ('q', '{}'::jsonb, '{hybrid,summary}', '{}'::uuid[], '{}'::uuid[], 0.5, false, 'cli')
      returning results, degraded, k, mode`;
    expect(row).toEqual({ results: null, degraded: null, k: null, mode: null });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/retrieval-log.test.ts`
Expected: FAIL: the column list is `[]`; the second test fails with `column "results" does not exist`.

- [ ] **Step 3: Write the migration**

`supabase/migrations/20261002000011_retrieval_log_v2.sql`:
```sql
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
```

- [ ] **Step 4: Run the test**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/retrieval-log.test.ts`
Expected: PASS (2 tests). The test also applies the file twice on one reserved connection (postgres.js refuses `begin` inside `unsafe` on a pooled connection), which proves it is idempotent.

- [ ] **Step 5: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. The current `search()` still inserts only the v1 columns, which the second test shows is allowed.

- [ ] **Step 6: Apply to the eval database**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20261002000011_retrieval_log_v2.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20261002000011_retrieval_log_v2.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "
select column_name, data_type from information_schema.columns
where table_schema = 'brain' and table_name = 'retrieval_log' and column_name in ('results','degraded','candidates','timings','k','mode')
order by column_name"
```
Expected: the first run prints `BEGIN`, `ALTER TABLE`, `DO`, `CREATE INDEX`, five `COMMENT`, `COMMIT`; the second the same with `NOTICE: column "…" of relation "retrieval_log" already exists, skipping` lines and `NOTICE: relation "retrieval_log_created_at" already exists, skipping`; the query lists the six columns (`candidates jsonb`, `degraded jsonb`, `k integer`, `mode text`, `results jsonb`, `timings jsonb`). If `brain_eval` does not exist, run `npm run eval:prepare` first (it applies every migration, 011 included).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261002000011_retrieval_log_v2.sql test/integration/retrieval-log.test.ts
git commit -m "retrieval_log v2: results, degraded, candidates, timings, k and mode columns, checks, created_at index

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `search()` returns the contract and logs it

**Files:**
- Create: `src/retrieve/layers.ts`
- Rewrite: `src/retrieve/search.ts`
- Modify: `src/mcp/render.ts` (field renames; `degradedNote` and `searchMode` move to `contract.ts`)
- Modify: `src/cli.ts` (field renames)
- Modify: `src/retrieve/ask.ts` (field rename)
- Modify: `src/eval/run.ts` (`layers`, `isDegraded`)
- Modify: `test/integration/search.test.ts`
- Modify: `test/unit/render.test.ts`
- Modify: `test/unit/eval.test.ts`

What changes in `search()`:
- **Per hybrid passage**, `vectorRank` and `keywordRank` come from the `hybrid_search` candidate row (each is null when that branch did not return the passage), `layers` lists the branches that did (`hybridLayers`), `rerankRank` is its 1-based position in the reranker's output, `scoreKind` is `"rerank"`. When the rerank did not run (it failed, was refused, or was skipped because the embedding failed) the scores are the RRF values, `scoreKind` is `"rrf"` and `rerankRank` is null.
- **Graph passages**: `layers: ["graph"]`, `score: null`, `scoreKind: "none"`, no ranks, `viaEntity: { id, name }` of the entity whose mentions brought the passage in. **Fallback passages**: `layers: ["fallback"]`, `chunkId: null`, `score: null`, `scoreKind: "none"`, `fallbackTerm` (the first trigger term the document contains, the one the window is centred on).
- **`topScore`** is the highest rerank score, or null when no rerank score exists. This fixes the Phase 1 review item: in a degraded search `top_score` used to hold an RRF value (about 0.03), which is on another scale. The fallback trigger is unchanged in effect: a degraded search has no rerank score, so it always scans when the query has trigger terms (`isDegraded(...) || topScore === null || topScore < threshold`).
- **`degraded`**: `embedding` (the query embedding failed or was refused), `rerank` (no rerank ran), `capReached` (the Voyage cap refused either call). `mode` follows from it (`searchMode`).
- **`candidates`**: `vector` and `keyword` count the `hybrid_search` rows with that rank set; `fused` counts the distinct passages after fusion that the reranker scored (or fused order cut from).
- **`timings`** (ms, one decimal, `performance.now()`), disjoint stages: `embedMs` the query embedding call; `sqlMs` the candidate queries (entity detection runs alongside them and is counted here), loading passage rows, the summary documents, the facts query and the fallback scan; `rerankMs` the rerank call (0 when skipped); `graphMs` the neighbour and mention queries per entity; `totalMs` everything up to the log insert.
- **Facts** gain `verifiedBy` (from `brain.facts`, since `current_facts()` does not return it), `sourceDocumentId` and `sourceKind` (from the source chunk's document).
- **The log insert** writes the v1 columns as before plus `results` (`toLoggedPassages(passages)`), `degraded`, `candidates`, `timings`, `k`, `mode`, and returns `id`, which comes back as `retrievalId`.

`search.ts` re-exports the contract types, so `import type { SearchResult } from "./search.js"` keeps working for every consumer. The consumers change only as far as they must to compile and say the same as before (`render.ts` prints `p.layers.join("+")` where it printed `p.group`); Task 4 rewrites the rendering.

- [ ] **Step 1: Write the failing integration tests**

In `test/integration/search.test.ts`, after:
```ts
import { reciprocalRankFusion } from "../../src/retrieve/fuse.js";
```
add:
```ts
import { isHybrid, factSource, type LoggedPassage } from "../../src/retrieve/contract.js";
import { addFact } from "../../src/graph/facts.js";
```

In `"falls back to keyword-only search when the query embedding fails"`, replace:
```ts
      const res = await search(ctx, "What did Zorblax Industries release?");
      expect(res.degraded).toBe(true);
      expect(res.degradedReason).toBe("embedding");
      expect(res.capReached).toBe(false);
      expect(res.passages.some((p) => p.content.includes("ZX-9000"))).toBe(true);
```
with:
```ts
      const res = await search(ctx, "What did Zorblax Industries release?");
      expect(res.degraded).toEqual({ embedding: true, rerank: true, capReached: false });
      expect(res.mode).toBe("keyword-only");
      expect(res.topScore).toBeNull();
      expect(res.candidates.vector).toBe(0);
      expect(res.passages.some((p) => p.content.includes("ZX-9000"))).toBe(true);
      // No vectors: every hybrid passage was found by the keyword branch alone, in RRF order, unreranked.
      const hybrid = res.passages.filter(isHybrid);
      expect(hybrid.length).toBeGreaterThan(0);
      for (const p of hybrid) {
        expect(p).toMatchObject({ layers: ["keyword"], vectorRank: null, scoreKind: "rrf", rerankRank: null });
        expect(p.keywordRank).toBeGreaterThan(0);
      }
```

In `"does not call the reranker after the query embedding failed"`, replace:
```ts
      const res = await search(ctx, "Zorblax Industries drill");
      expect(res.degraded).toBe(true);
      expect(rerankCalls).toEqual([]);
```
with:
```ts
      const res = await search(ctx, "Zorblax Industries drill");
      expect(res.degraded).toEqual({ embedding: true, rerank: true, capReached: false });
      expect(rerankCalls).toEqual([]);
```

In `"uses the query-time embedder and reranker when the context has them"`, replace:
```ts
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res.degraded).toBe(false);
    expect(used).toEqual(["embed", "rerank"]);
```
with:
```ts
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res.mode).toBe("hybrid");
    expect(used).toEqual(["embed", "rerank"]);
```

In `"keeps fused order with RRF scores when the reranker fails"`, replace:
```ts
      const res = await search(ctx, "Zorblax Industries drill");
      expect(res.degraded).toBe(true);
      expect(res.degradedReason).toBe("rerank");
      expect(res.capReached).toBe(false);
      const hybrid = res.passages.filter((p) => p.group === "hybrid");
      expect(hybrid.length).toBeGreaterThan(0);
      expect(hybrid.map((p) => p.chunkId)).toEqual(fused.slice(0, hybrid.length).map((f) => f.id));
      expect(hybrid.map((p) => p.score)).toEqual(fused.slice(0, hybrid.length).map((f) => f.fused));
```
with:
```ts
      const res = await search(ctx, "Zorblax Industries drill");
      expect(res.degraded).toEqual({ embedding: false, rerank: true, capReached: false });
      expect(res.mode).toBe("fused-order");
      const hybrid = res.passages.filter((p) => isHybrid(p));
      expect(hybrid.length).toBeGreaterThan(0);
      expect(hybrid.map((p) => p.chunkId)).toEqual(fused.slice(0, hybrid.length).map((f) => f.id));
      expect(hybrid.map((p) => p.score)).toEqual(fused.slice(0, hybrid.length).map((f) => f.fused));
      expect(hybrid.every((p) => p.scoreKind === "rrf" && p.rerankRank === null)).toBe(true);
      // RRF values are never a top score: the log's top_score is null too.
      expect(res.topScore).toBeNull();
      const [log] = await sql<{ top_score: number | null }[]>`select top_score from brain.retrieval_log where id = ${res.retrievalId}`;
      expect(log.top_score).toBeNull();
```

In `"is not degraded when embedding and reranking succeed"`, replace:
```ts
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res.degraded).toBe(false);
    expect(res.degradedReason).toBeNull();
    expect(res.capReached).toBe(false);
  });
```
with:
```ts
    const res = await search(ctx, "What did Zorblax Industries release?");
    expect(res.degraded).toEqual({ embedding: false, rerank: false, capReached: false });
    expect(res.mode).toBe("hybrid");
  });
```

In the three Voyage-ledger tests, replace:
```ts
      expect(res).toMatchObject({ degraded: true, degradedReason: "cap", capReached: true });
```
with:
```ts
      expect(res).toMatchObject({ mode: "keyword-only", degraded: { embedding: true, rerank: true, capReached: true } });
```

replace:
```ts
      expect(res).toMatchObject({ degraded: true, degradedReason: "rerank", capReached: true });
```
with:
```ts
      expect(res).toMatchObject({ mode: "fused-order", degraded: { embedding: false, rerank: true, capReached: true } });
```

and replace:
```ts
    expect(res).toMatchObject({ degraded: false, degradedReason: null, capReached: false });
```
with:
```ts
    expect(res).toMatchObject({ mode: "hybrid", degraded: { embedding: false, rerank: false, capReached: false } });
```

In `"applies since/until to graph and fallback passages too"`, replace:
```ts
.map((p) => p.group)).toEqual([]);
```
with:
```ts
.map((p) => p.layers)).toEqual([]);
```

In `"keyword side matches a question that shares only some terms with the passage"`, replace:
```ts
      // Hybrid group only: entity detection
```
with:
```ts
      // Hybrid passages only: entity detection
```

Then, everywhere else in `test/integration/search.test.ts`, replace:
- every `documentTitle` with `title` (9 occurrences)
- every `usedFallback` with `fallbackUsed` (3 occurrences)
- every `p.group === "hybrid"` with `isHybrid(p)` (5 occurrences)
- every `p.group === "graph"` with `p.layers.includes("graph")` (3 occurrences)
- every `p.group === "fallback"` with `p.layers.includes("fallback")` (8 occurrences)

After this, `grep -nE "\.group\b|degradedReason|documentTitle|usedFallback" test/integration/search.test.ts` prints nothing.

Add these tests inside `describe("search", …)`, before `"detects an entity from a lowercase query and expands its neighbours"`. Before:
```ts
  it("detects an entity from a lowercase query and expands its neighbours", async () => {
```
add:
```ts
  it("reports how each hybrid passage was found: branch ranks, layers, rerank position and score kind", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Zorblax Industries drill", { includeFacts: false });
    const hybrid = res.passages.filter(isHybrid);
    expect(hybrid.length).toBeGreaterThan(1);
    // Only the Zorblax passage shares a term with the query, so it is the one passage both branches found.
    const both = hybrid.find((p) => p.content.includes("ZX-9000"))!;
    expect(both.layers).toEqual(["vector", "keyword"]);
    expect(both.vectorRank).toBeGreaterThan(0);
    expect(both.keywordRank).toBe(1);
    const vectorOnly = hybrid.find((p) => !p.content.includes("ZX-9000"))!;
    expect(vectorOnly).toMatchObject({ layers: ["vector"], keywordRank: null });
    expect(hybrid.map((p) => p.rerankRank)).toEqual(hybrid.map((_p, i) => i + 1));
    expect(hybrid.every((p) => p.scoreKind === "rerank" && p.fallbackTerm === null && p.viaEntity === null)).toBe(true);
    expect(res.topScore).toBe(Math.max(...hybrid.map((p) => p.score as number)));
    expect(res.candidates.keyword).toBe(1);
    expect(res.candidates.fused).toBeGreaterThanOrEqual(res.candidates.vector);
    expect(res.candidates.fused).toBeLessThanOrEqual(res.candidates.vector + res.candidates.keyword);
    expect(both).toMatchObject({ title: "Zorblax news", sourceKind: "news", author: "owner", occurredAt: null });
  });

  it("times each stage; the stages are disjoint and fit inside the total", async () => {
    const ctx = await seed();
    const { timings } = await search(ctx, "What did Zorblax Industries release?");
    for (const v of Object.values(timings)) expect(v).toBeGreaterThanOrEqual(0);
    expect(timings.sqlMs).toBeGreaterThan(0);
    expect(timings.totalMs).toBeGreaterThan(0);
    // Each stage is rounded to 0.1 ms, so allow 0.05 ms per stage.
    expect(timings.embedMs + timings.sqlMs + timings.rerankMs + timings.graphMs).toBeLessThanOrEqual(timings.totalMs + 0.25);
  });

  it("reports a graph passage with layers graph, no score, no ranks, and the entity that brought it in", async () => {
    const ctx = await seed();
    ctx.reranker = { rerank: async () => [] };
    const res = await search(ctx, "Zorblax Industries", { includeFacts: false });
    const entity = res.entities.find((e) => e.name === "Zorblax Industries")!;
    const graph = res.passages.filter((p) => p.layers.includes("graph"));
    expect(graph.length).toBe(1);
    expect(graph[0]).toMatchObject({
      layers: ["graph"], score: null, scoreKind: "none", vectorRank: null, keywordRank: null, rerankRank: null, fallbackTerm: null,
      viaEntity: { id: entity.id, name: "Zorblax Industries" }, title: "Zorblax news",
    });
    expect(res.topScore).toBeNull();
    expect(res.mode).toBe("hybrid");
  });

  it("reports a fallback passage with its document, the matched term, and no chunk or score", async () => {
    const ctx = await seed();
    const res = await search(ctx, "X-90");
    const fb = res.passages.find((p) => p.layers.includes("fallback"))!;
    expect(fb).toMatchObject({
      chunkId: null, title: "Zorblax news", layers: ["fallback"], score: null, scoreKind: "none", fallbackTerm: "X-90",
      vectorRank: null, keywordRank: null, rerankRank: null, viaEntity: null, headingPath: [],
    });
    expect(fb.charEnd).toBeGreaterThan(fb.charStart);
  });

  it("says where each fact came from: the extractor's document, or the owner", async () => {
    const ctx = await seed();
    const zorblax = (await sql<{ id: string }[]>`select id from brain.documents where title = 'Zorblax news'`)[0];
    await addFact(sql, { predicate: "lives_in", objectText: "Austin", by: "agent:test" });
    const visa = (await search(ctx, "visa status")).facts.find((f) => f.predicate === "visa_status")!;
    expect(visa.verifiedBy).toMatch(/^extractor:/);
    expect(visa).toMatchObject({ sourceDocumentId: zorblax.id, sourceKind: "news", verified: false });
    expect(visa.sourceChunkId).not.toBeNull();
    expect(factSource(visa)).toEqual({ kind: "document", sourceKind: "news", documentId: zorblax.id });
    const lives = (await search(ctx, "where do I live", { k: 3 })).facts.find((f) => f.predicate === "lives_in")!;
    expect(lives).toMatchObject({ verifiedBy: "agent:test", sourceChunkId: null, sourceDocumentId: null, sourceKind: null, confidence: 1 });
    expect(factSource(lives)).toEqual({ kind: "owner" });
  });

  it("logs each passage without its text, the degraded flags, candidates, timings, k and mode, and returns the log id", async () => {
    const ctx = weakRerank(await seed());
    const res = await search(ctx, "Zorblax ZX-9000", { k: 5, includeFacts: false });
    expect(res.fallbackUsed).toBe(true);
    const rows = await sql<{
      id: string; results: LoggedPassage[]; degraded: unknown; candidates: unknown; timings: unknown; k: number; mode: string;
      chunk_ids: string[]; used_fallback: boolean; layers: string[]; top_score: number | null;
    }[]>`select id, results, degraded, candidates, timings, k, mode, chunk_ids, used_fallback, layers, top_score from brain.retrieval_log`;
    expect(rows).toHaveLength(1);
    const [log] = rows;
    expect(log.id).toBe(res.retrievalId);
    expect(log.results).toHaveLength(res.passages.length);
    for (const [i, entry] of log.results.entries()) {
      expect(entry).not.toHaveProperty("content");
      expect(entry).toEqual(Object.fromEntries(Object.entries(res.passages[i]).filter(([key]) => key !== "content")));
      expect(entry).toHaveProperty("score");
      expect(entry).toHaveProperty("layers");
    }
    const fb = log.results.find((e) => e.layers.includes("fallback"))!;
    expect(fb).toMatchObject({ chunkId: null, fallbackTerm: "ZX-9000" });
    expect(fb.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(log.degraded).toEqual({ embedding: false, rerank: false, capReached: false });
    expect(log.candidates).toEqual(res.candidates);
    expect(log.timings).toEqual(res.timings);
    expect(log.k).toBe(5);
    expect(log.mode).toBe("hybrid");
    // The v1 columns are still written.
    expect(log.used_fallback).toBe(true);
    expect(log.layers).toContain("fallback");
    expect(log.chunk_ids).toEqual(res.passages.map((p) => p.chunkId).filter((id) => id !== null));
    expect(log.top_score).toBeCloseTo(0.01, 5);
  });

```

- [ ] **Step 2: Update the unit tests to the new shape**

In `test/unit/render.test.ts`, replace everything above `describe("other renderers", () => {` (the imports and the whole `describe("renderSearch", …)` block) with:
```ts
import { describe, it, expect } from "vitest";
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus } from "../../src/mcp/render.js";
import { passage, fact, searchResult } from "./search-fixture.js";

describe("renderSearch", () => {
  it("numbers passages with ids, lists entities, facts and the fallback notice", () => {
    const text = renderSearch(searchResult({
      passages: [
        passage({ headingPath: ["H"] }),
        passage({
          chunkId: null, documentId: "d2", title: null, sourceKind: "note", author: "owner", content: "raw hit", score: null, scoreKind: "none",
          layers: ["fallback"], vectorRank: null, keywordRank: null, rerankRank: null, fallbackTerm: "hit",
        }),
      ],
      documents: [{ documentId: "d1", title: "Doc", sourceKind: "news", summary: "S", score: 0.1 }],
      entities: [{ id: "n1", type: "organization", name: "Acme", matchedSpan: "acme", neighbors: [{ id: "n2", type: "place", name: "Austin", depth: 1 }] }],
      facts: [fact({ verified: true })],
      fallbackUsed: true,
      topScore: 0.76,
    }));
    expect(text).toContain("[P1] vector+keyword · news · author: other · Doc (document d1, chunk c1)");
    expect(text).toContain("[P2] fallback · note · author: owner (document d2)");
    expect(text).toContain("organization: Acme (node n1) — Austin (place)");
    expect(text).toContain("[F1] visa_status: F-1 OPT (verified)");
    expect(text).toContain("weak match");
  });

  it("says so when nothing was found", () => {
    expect(renderSearch(searchResult({ fallbackUsed: true }))).toContain("No passages matched");
  });

  it("names which part of a degraded search fell back, on its own line near the top", () => {
    const cases = [
      { degraded: { embedding: true, rerank: true, capReached: true }, note: "Voyage daily cap reached; keyword-only results" },
      { degraded: { embedding: true, rerank: true, capReached: false }, note: "query embedding failed; keyword-only results" },
      { degraded: { embedding: false, rerank: true, capReached: true }, note: "Voyage daily cap reached; results in fused order" },
      { degraded: { embedding: false, rerank: true, capReached: false }, note: "reranking failed; results in fused order" },
    ];
    for (const c of cases) {
      const lines = renderSearch(searchResult({ degraded: c.degraded })).split("\n");
      expect(lines.indexOf(`(${c.note})`)).toBeGreaterThanOrEqual(0);
      expect(lines.indexOf(`(${c.note})`)).toBeLessThan(3);
    }
  });

  it("prints no degraded note for a hybrid search", () => {
    expect(renderSearch(searchResult())).not.toMatch(/keyword-only results|fused order/);
  });
});

```

Replace `test/unit/eval.test.ts` with:
```ts
import { describe, it, expect } from "vitest";
import { kindFromFilename, toQuestionResult, firstExpectedRank, normalizeWhitespace, missingQuoteWarning, evalVoyageLine } from "../../src/eval/run.js";
import type { GoldenItem } from "../../src/eval/golden.js";
import type { Layer, SearchResult } from "../../src/retrieve/contract.js";
import { passage, searchResult as baseResult } from "./search-fixture.js";

const item: GoldenItem = {
  id: "q05", question: "Why?", kind: "semantic", negative: false, source: "fixture", approved_at: "2026-09-30",
  expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot satisfy all three" }],
};

type P = { documentId: string; layers: Layer[]; content: string; score: number; chunkId?: string | null };

function searchResult(passages: P[], degraded = false): SearchResult {
  return baseResult({
    query: "Why?",
    passages: passages.map((p, i) => passage({ chunkId: p.chunkId === undefined ? `c${i}` : p.chunkId, documentId: p.documentId, content: p.content, score: p.score, layers: p.layers })),
    topScore: passages[0]?.score ?? null,
    mode: degraded ? "keyword-only" : "hybrid",
    degraded: { embedding: degraded, rerank: degraded, capReached: false },
  });
}

describe("toQuestionResult", () => {
  it("records ranked documents with origins, quote hits, top score and graph presence", () => {
    const res = searchResult([
      { documentId: "d1", layers: ["vector"], content: "Demographic parity asks that positive rates match.", score: 0.4 },
      { documentId: "d2", layers: ["vector"], content: "shows you cannot satisfy all three when base rates differ", score: 0.3 },
      { documentId: "d3", layers: ["graph"], content: "x", score: 0 },
    ]);
    const origins = new Map([["d1", "/c/other.md"], ["d2", "/c/note--fairness-in-ml.md"], ["d3", null]]);
    const q = toQuestionResult(item, res, origins, 42, [], 2, [true]);
    expect(q.ranked.map((d) => d.documentId)).toEqual(["d1", "d2", "d3"]);
    expect(q.ranked.map((d) => d.containsQuote)).toEqual([false, true, false]);
    expect(q.topScore).toBe(0.4);
    expect(q.hasGraphPassage).toBe(true);
    expect(q.totalMs).toBe(42);
    expect(q.totalRelevant).toBe(2);
    expect(q.paraphraseDegraded).toEqual([true]);
    expect(firstExpectedRank(q)).toBe(2);
  });
  it("a passage counts as containing the quote only when it belongs to an expected document", () => {
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "you cannot satisfy all three", score: 0.4 }]);
    const q = toQuestionResult(item, res, new Map([["d1", "/c/other.md"]]), 1, [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(false);
  });
  it("matches quotes with whitespace runs collapsed on both sides", () => {
    const spaced: GoldenItem = { ...item, expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot  satisfy\nall three" }] };
    const res = searchResult([{ documentId: "d2", layers: ["vector"], content: "you cannot\n\tsatisfy all   three here", score: 0.4 }]);
    const q = toQuestionResult(spaced, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), 1, [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(true);
  });
  it("a fallback window (no chunk) is never a relevant passage, since totalRelevant counts chunks", () => {
    const res = searchResult([{ documentId: "d2", layers: ["fallback"], content: "you cannot satisfy all three", score: 0, chunkId: null }]);
    const q = toQuestionResult(item, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), 1, [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(false);
  });
  it("rank is null on a miss", () => {
    const q = toQuestionResult(item, searchResult([{ documentId: "d9", layers: ["vector"], content: "x", score: 0.9 }]), new Map([["d9", "/c/z.md"]]), 1, [], 0, []);
    expect(firstExpectedRank(q)).toBeNull();
  });
  it("reads the source kind from the file name prefix", () => {
    expect(kindFromFilename("news--acme-series-b.md")).toBe("news");
    expect(kindFromFilename("plain.md")).toBe("note");
  });
});

describe("normalizeWhitespace", () => {
  it("collapses ASCII whitespace runs only, matching the SQL class, so an NBSP is kept", () => {
    expect(normalizeWhitespace("a \t\r\n\f\vb")).toBe("a b");
    expect(normalizeWhitespace("a\u00a0b")).toBe("a\u00a0b");
    expect(normalizeWhitespace("a \u00a0 b")).toBe("a \u00a0 b");
  });
  it("an NBSP in a quote does not match a plain space in a passage", () => {
    const nbsp: GoldenItem = { ...item, expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot\u00a0satisfy" }] };
    const res = searchResult([{ documentId: "d2", layers: ["vector"], content: "you cannot satisfy all three", score: 0.4 }]);
    expect(toQuestionResult(nbsp, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), 1, [], 1, []).ranked[0].containsQuote).toBe(false);
  });
});

describe("missingQuoteWarning", () => {
  it("warns when an item has quotes but no passage of its expected documents contains one", () => {
    expect(missingQuoteWarning(item, 0)).toBe("eval: q05 quote not found in any passage of its expected documents");
    expect(missingQuoteWarning(item, 2)).toBeNull();
    expect(missingQuoteWarning({ ...item, expected: [{ origin: "a.md" }] }, 0)).toBeNull();
  });
});

describe("evalVoyageLine", () => {
  it("prints the run's Voyage spend, and warns when the cap refused calls", () => {
    expect(evalVoyageLine({ requests: 30, tokens: 41_200, refused: 0 })).toBe("voyage  tokens=41200 requests=30 refused=0");
    expect(evalVoyageLine({ requests: 3, tokens: 90, refused: 2 })).toBe(
      "voyage  tokens=90 requests=3 refused=2  (brain_eval's daily cap refused calls; those searches ran degraded)",
    );
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/render.test.ts test/unit/eval.test.ts`
Expected: FAIL: render prints `undefined` where the layers belong and no degraded note (the old `degradedNote` reads `degradedReason`); `hasGraphPassage` is false because the old code reads `p.group`. `npm run typecheck` also fails on the new literals.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/search.test.ts`
Expected: FAIL: `res.mode`, `res.candidates`, `res.retrievalId` and `p.layers` are undefined; the log row has no `results`.

- [ ] **Step 4: Write `src/retrieve/layers.ts`**

The SQL is moved from `search.ts` unchanged, except that `loadChunks` also selects `d.origin` and `d.occurred_at` (and no longer joins the parent chunk, whose text nothing read), the fallback scan selects `d.origin` and `d.occurred_at`, and the facts query joins `brain.facts`, `brain.chunks` and `brain.documents` for `verified_by` and the source document.

```ts
import { config } from "../config.js";
import type { Db } from "../db.js";
import type { DocHit, FactRow, Neighbor } from "./contract.js";

/**
 * The per-layer queries search() runs (spec §3). Each function is one SQL round trip (or one per entity) and knows
 * nothing about ranking, scores or the evidence contract; search.ts orchestrates them and builds the result.
 */

export interface Filters {
  kinds: string[] | null;
  since: Date | null;
  until: Date | null;
  verifiedOnly: boolean;
}

export interface ChunkCandidate {
  chunk_id: string;
  vector_rank: number | null;
  keyword_rank: number | null;
}

export interface DocCandidate {
  document_id: string;
  vector_rank: number | null;
  keyword_rank: number | null;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  content: string;
  heading_path: string[];
  context_prefix: string;
  char_start: number;
  char_end: number;
  document_title: string | null;
  source_kind: string;
  author: string;
  origin: string | null;
  occurred_at: Date | null;
}

/** The same date window hybrid_search and summary_search apply, for queries that read documents directly. */
function inDateRange(sql: Db, alias: string, since: Date | null, until: Date | null) {
  const at = sql`coalesce(${sql(alias)}.occurred_at, ${sql(alias)}.ingested_at)`;
  return sql`(${since}::timestamptz is null or ${at} >= ${since}::timestamptz)
    and (${until}::timestamptz is null or ${at} <= ${until}::timestamptz)`;
}

/**
 * Layer 1: passage candidates (hybrid_search) and document candidates (summary_search), candidateK per branch.
 * qvec null means keyword-only: hybrid_search returns no vector ranks.
 */
export async function candidateQueries(sql: Db, query: string, qvec: string | null, f: Filters): Promise<{ chunks: ChunkCandidate[]; docs: DocCandidate[] }> {
  // pgvector 0.8: with iterative scans the HNSW index keeps going until `limit k` rows satisfy the
  // source_kind/date filters; ef_search = greatest(4 * candidateK, 100) bounds the first pass (spec §3.1).
  // SET LOCAL needs a transaction; the two searches share its connection and run one after the other.
  const efSearch = Math.max(4 * config.retrieval.candidateK, 100);
  const [chunks, docs] = await sql.begin(async (tx) => {
    await tx.unsafe(`set local hnsw.iterative_scan = 'relaxed_order'; set local hnsw.ef_search = ${efSearch}`);
    return Promise.all([
      tx<ChunkCandidate[]>`
        select chunk_id, vector_rank, keyword_rank
        from brain.hybrid_search(${query}, ${qvec}::vector, ${config.retrieval.candidateK}, ${f.kinds}::text[], ${f.since}, ${f.until})`,
      tx<DocCandidate[]>`
        select document_id, vector_rank, keyword_rank
        from brain.summary_search(${query}, ${qvec}::vector, ${config.retrieval.candidateK}, ${f.kinds}::text[], ${f.since}, ${f.until})`,
    ]);
  });
  return { chunks, docs };
}

/** Passage rows with their document's title, kind, author, origin and date. */
export async function loadChunks(sql: Db, ids: string[]): Promise<Map<string, ChunkRow>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<ChunkRow[]>`
    select c.id, c.document_id, c.content, c.heading_path, c.context_prefix, c.char_start, c.char_end,
           d.title as document_title, d.source_kind, d.author, d.origin, d.occurred_at
    from brain.chunks c
    join brain.documents d on d.id = c.document_id
    where c.id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

/** Layer 3: the fused summary hits, in the given order, with their documents' summaries. */
export async function summaryDocuments(sql: Db, fused: { id: string; fused: number }[]): Promise<DocHit[]> {
  if (fused.length === 0) return [];
  const rows = await sql<{ id: string; title: string | null; source_kind: string; summary: string | null }[]>`
    select id, title, source_kind, summary from brain.documents where id = any(${fused.map((d) => d.id)}::uuid[])`;
  return fused
    .map((d) => {
      const r = rows.find((x) => x.id === d.id);
      return r ? { documentId: r.id, title: r.title, sourceKind: r.source_kind, summary: r.summary, score: d.fused } : null;
    })
    .filter((d): d is DocHit => d !== null);
}

/** Layer 4a: an entity's direct neighbours, strongest edge first, capped (spec §3.5). */
export async function entityNeighbors(sql: Db, nodeId: string, verifiedOnly: boolean): Promise<Neighbor[]> {
  return sql<Neighbor[]>`
    select nb.node_id as id, x.type, x.name, nb.depth
    from brain.neighbors(${nodeId}, 1, null) nb
    join brain.nodes x on x.id = nb.node_id
    left join brain.edges e on e.id = nb.via_edge
    where nb.depth > 0 and ${verifiedOnly ? sql`x.verified` : sql`true`}
    order by nb.depth, e.confidence desc nulls last, x.name
    limit ${config.graph.maxNeighbors}`;
}

/**
 * Layer 4b: passages that mention the entity (or a node merged into it), newest document first, capped.
 * A mention stored on a level-0 section (quote not located) maps to that section's first passage.
 */
export async function mentionedChunkIds(sql: Db, nodeId: string, f: Filters): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select c.id
    from (
      select distinct case when c0.level = 1 then c0.id
                           else (select p.id from brain.chunks p where p.parent_id = c0.id order by p.ordinal limit 1) end as id
      from brain.mentions m join brain.chunks c0 on c0.id = m.chunk_id
      where m.node_id = any(brain.node_members(${nodeId}))
    ) pm
    join brain.chunks c on c.id = pm.id
    join brain.documents d on d.id = c.document_id
    where (${f.kinds}::text[] is null or d.source_kind = any(${f.kinds}::text[]))
      and ${inDateRange(sql, "d", f.since, f.until)}
    order by coalesce(d.occurred_at, d.ingested_at) desc, c.ordinal, c.id
    limit ${config.graph.maxPassagesPerEntity}`;
  return rows.map((r) => r.id);
}

/**
 * Layer 5: current facts about the owner whose predicate or value shares a stem with the query, or whose object
 * node is a detected entity, capped; entity-linked facts rank first so the cap never drops them (spec §3.5).
 * Each fact carries who recorded it and, for an extracted fact, the passage and document it came from.
 */
export async function factsLayer(sql: Db, query: string, entityIds: string[], verifiedOnly: boolean): Promise<FactRow[]> {
  const rows = await sql<{
    id: string; predicate: string; object_text: string; confidence: number | null; verified: boolean; verified_by: string | null;
    source_chunk_id: string | null; source_document_id: string | null; source_kind: string | null;
  }[]>`
    select f.id, f.predicate, f.object_text, f.confidence, f.verified, ff.verified_by, f.source_chunk_id,
           c.document_id as source_document_id, d.source_kind
    from brain.current_facts(null) f
    join brain.facts ff on ff.id = f.id
    left join brain.chunks c on c.id = f.source_chunk_id
    left join brain.documents d on d.id = c.document_id
    cross join (select brain.query_to_tsquery(${query}) as q) q
    where ((q.q is not null and to_tsvector('english', replace(f.predicate, '_', ' ') || ' ' || f.object_text) @@ q.q)
           or brain.canonical_node(f.object_node_id) = any(${entityIds}::uuid[]))
      and ${verifiedOnly ? sql`f.verified` : sql`true`}
    order by coalesce(brain.canonical_node(f.object_node_id) = any(${entityIds}::uuid[]), false) desc, f.verified desc, f.confidence desc nulls last, f.created_at desc, f.id
    limit ${config.graph.maxFacts}`;
  return rows.map((f) => ({
    id: f.id, predicate: f.predicate, objectText: f.object_text, confidence: f.confidence, verified: f.verified, verifiedBy: f.verified_by,
    sourceChunkId: f.source_chunk_id, sourceDocumentId: f.source_document_id, sourceKind: f.source_kind,
  }));
}

export interface FallbackHit {
  id: string;
  title: string | null;
  source_kind: string;
  author: string;
  origin: string | null;
  occurred_at: Date | null;
  raw_content: string;
  /** The trigger terms this document contains, in query order. */
  matched: string[];
  /** How many trigger terms it contains. */
  n: number;
}

/** Fallback: documents whose raw text contains a trigger term literally, most terms first, then newest; at most 10. */
export async function fallbackScan(sql: Db, terms: string[], f: Filters): Promise<FallbackHit[]> {
  return sql<FallbackHit[]>`
    select d.id, d.title, d.source_kind, d.author, d.origin, d.occurred_at, d.raw_content,
           array(select t from unnest(${terms}::text[]) with ordinality u(t, o)
                 where d.raw_content ilike '%' || brain.like_literal(t) || '%' order by o) as matched,
           (select count(*)::int from unnest(${terms}::text[]) t where d.raw_content ilike '%' || brain.like_literal(t) || '%') as n
    from brain.documents d
    where (${f.kinds}::text[] is null or d.source_kind = any(${f.kinds}::text[]))
      and ${inDateRange(sql, "d", f.since, f.until)}
      and d.raw_content ilike any (array(select '%' || brain.like_literal(t) || '%' from unnest(${terms}::text[]) t))
    order by n desc, coalesce(d.occurred_at, d.ingested_at) desc
    limit 10`;
}

/** 200 characters either side of the first case-insensitive occurrence of term, clipped to the document. */
export function fallbackWindow(raw: string, term: string): { start: number; end: number } {
  const at = Math.max(0, raw.toLowerCase().indexOf(term.toLowerCase()));
  return { start: Math.max(0, at - 200), end: Math.min(raw.length, at + term.length + 200) };
}
```

- [ ] **Step 5: Rewrite `src/retrieve/search.ts`**

```ts
import type postgres from "postgres";
import { config } from "../config.js";
import type { Ctx } from "../ctx.js";
import { toVector } from "../db.js";
import { reciprocalRankFusion } from "./fuse.js";
import { triggerTerms } from "./fallback.js";
import { detectEntities } from "./entities.js";
import { isSpendCap } from "../llm/errors.js";
import {
  candidateQueries, loadChunks, summaryDocuments, entityNeighbors, mentionedChunkIds, factsLayer, fallbackScan, fallbackWindow,
  type ChunkRow, type Filters,
} from "./layers.js";
import {
  hybridLayers, isDegraded, searchMode, toLoggedPassages,
  type Candidates, type Degraded, type EntityHit, type FactRow, type Passage, type SearchResult, type Timings,
} from "./contract.js";

export type {
  SearchResult, Passage, LoggedPassage, DocHit, Neighbor, EntityHit, FactRow, Degraded, Candidates, Timings, SearchMode, Layer, ScoreKind,
} from "./contract.js";

export interface SearchOptions {
  k?: number;
  sourceKinds?: string[];
  since?: Date;
  until?: Date;
  verifiedOnly?: boolean;
  includeFacts?: boolean;
  client?: string;
}

/** Milliseconds since `start` (a performance.now() value), to one decimal. */
function elapsed(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}

type HowFound = Pick<Passage, "score" | "scoreKind" | "layers" | "vectorRank" | "keywordRank" | "rerankRank" | "viaEntity">;

function chunkPassage(row: ChunkRow, how: HowFound): Passage {
  return {
    chunkId: row.id,
    documentId: row.document_id,
    title: row.document_title,
    sourceKind: row.source_kind,
    author: row.author,
    origin: row.origin,
    occurredAt: row.occurred_at ? row.occurred_at.toISOString() : null,
    headingPath: row.heading_path,
    content: row.content,
    charStart: row.char_start,
    charEnd: row.char_end,
    fallbackTerm: null,
    ...how,
  };
}

/**
 * One search over every layer (spec §3), returned as the evidence contract (spec §6.1) and logged to
 * brain.retrieval_log, whose id comes back as `retrievalId`. Timings are disjoint stages: entity detection runs
 * alongside the candidate SQL and is counted in sqlMs; graphMs is the neighbour and mention queries.
 */
export async function search(ctx: Ctx, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  if (!query.trim()) throw new Error("Search query is empty");
  const started = performance.now();
  const { sql } = ctx;
  const k = opts.k ?? config.retrieval.defaultK;
  const filters: Filters = { kinds: opts.sourceKinds ?? null, since: opts.since ?? null, until: opts.until ?? null, verifiedOnly: opts.verifiedOnly ?? false };
  const degraded: Degraded = { embedding: false, rerank: false, capReached: false };
  const timings: Timings = { embedMs: 0, sqlMs: 0, rerankMs: 0, graphMs: 0, totalMs: 0 };

  // Layer 1a: the query embedding. Without it the search is keyword-only and nothing is reranked.
  let qvec: string | null = null;
  let t = performance.now();
  try {
    const [queryVector] = await (ctx.queryEmbedder ?? ctx.embedder).embed([query], "query");
    qvec = toVector(queryVector);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    degraded.embedding = true;
    degraded.rerank = true;
    if (isSpendCap(err)) {
      degraded.capReached = true;
      process.stderr.write(`brain: Voyage daily cap reached, keyword search only: ${message}\n`);
    } else {
      process.stderr.write(`brain: query embedding failed, keyword search only: ${message}\n`);
    }
  }
  timings.embedMs = elapsed(t);

  // Layer 1b: passage and summary candidates, alongside entity detection; then the fused passages' rows.
  t = performance.now();
  const [{ chunks: chunkCands, docs: docCands }, entityRefs] = await Promise.all([
    candidateQueries(sql, query, qvec, filters),
    detectEntities(sql, query),
  ]);
  const fused = reciprocalRankFusion(chunkCands.map((c) => ({ id: c.chunk_id, vectorRank: c.vector_rank, keywordRank: c.keyword_rank })));
  const rows = await loadChunks(sql, fused.map((f) => f.id));
  timings.sqlMs += elapsed(t);
  const present = fused.filter((f) => rows.has(f.id));
  const candidates: Candidates = {
    vector: chunkCands.filter((c) => c.vector_rank !== null).length,
    keyword: chunkCands.filter((c) => c.keyword_rank !== null).length,
    fused: present.length,
  };

  // Layer 2: rerank the fused candidates; fused order (RRF values) when the rerank cannot run.
  const fusedOrder = () => present.slice(0, k).map((f, index) => ({ index, score: f.fused }));
  let reranked: { index: number; score: number }[] = [];
  if (present.length && degraded.embedding) {
    // Voyage just failed for the query embedding; a rerank call would most likely fail too, after its own retries.
    reranked = fusedOrder();
  } else if (present.length) {
    t = performance.now();
    try {
      reranked = await (ctx.queryReranker ?? ctx.reranker).rerank(
        query,
        present.map((f) => {
          const r = rows.get(f.id)!;
          return (r.context_prefix ? r.context_prefix + "\n\n" : "") + r.content;
        }),
        k,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      degraded.rerank = true;
      if (isSpendCap(err)) {
        degraded.capReached = true;
        process.stderr.write(`brain: Voyage daily cap reached, keeping fused order: ${message}\n`);
      } else {
        process.stderr.write(`brain: reranking failed, keeping fused order: ${message}\n`);
      }
      reranked = fusedOrder();
    }
    timings.rerankMs = elapsed(t);
  }
  const passages: Passage[] = reranked.map((h, i) => {
    const f = present[h.index];
    return chunkPassage(rows.get(f.id)!, {
      score: h.score,
      scoreKind: degraded.rerank ? "rrf" : "rerank",
      layers: hybridLayers(f.vectorRank, f.keywordRank),
      vectorRank: f.vectorRank,
      keywordRank: f.keywordRank,
      rerankRank: degraded.rerank ? null : i + 1,
      viaEntity: null,
    });
  });
  // Rerank scores only: RRF values are on another scale and must never reach top_score or the fallback threshold.
  const rerankScores = passages.filter((p) => p.scoreKind === "rerank").map((p) => p.score as number);
  const topScore = rerankScores.length ? Math.max(...rerankScores) : null;

  // Layer 3: document summaries. The pool is candidateK per branch; fusion orders it and the caller sees the top k.
  t = performance.now();
  const documents = await summaryDocuments(
    sql,
    reciprocalRankFusion(docCands.map((d) => ({ id: d.document_id, vectorRank: d.vector_rank, keywordRank: d.keyword_rank }))).slice(0, k),
  );
  timings.sqlMs += elapsed(t);

  // Layer 4: graph expansion from entities named in the query, with budgets (spec §3.5).
  t = performance.now();
  const seen = new Set(passages.map((p) => p.chunkId));
  const entities: EntityHit[] = [];
  for (const ref of entityRefs) {
    entities.push({ id: ref.id, type: ref.type, name: ref.name, matchedSpan: ref.matchedSpan, neighbors: await entityNeighbors(sql, ref.id, filters.verifiedOnly) });
    const newIds = (await mentionedChunkIds(sql, ref.id, filters)).filter((id) => !seen.has(id));
    const extra = await loadChunks(sql, newIds);
    for (const id of newIds) {
      const row = extra.get(id);
      if (!row) continue;
      passages.push(chunkPassage(row, {
        score: null, scoreKind: "none", layers: ["graph"], vectorRank: null, keywordRank: null, rerankRank: null,
        viaEntity: { id: ref.id, name: ref.name },
      }));
      seen.add(id);
    }
  }
  timings.graphMs = elapsed(t);

  // Layer 5: facts about the owner (brain_orient and brain_get_facts still list every current fact).
  let facts: FactRow[] = [];
  if (opts.includeFacts !== false) {
    t = performance.now();
    facts = await factsLayer(sql, query, entityRefs.map((e) => e.id), filters.verifiedOnly);
    timings.sqlMs += elapsed(t);
  }

  // Fallback: literal substring scan for exact-string terms (codes, figures, versions), when the search was degraded
  // or the best rerank score is weak. Natural-language queries have no trigger terms and skip it. A degraded search
  // has no rerank score (topScore null), so it always scans.
  let fallbackUsed = false;
  const terms = triggerTerms(query);
  const weak = isDegraded(degraded) || topScore === null || topScore < config.retrieval.fallbackThreshold;
  if (terms.length && weak) {
    t = performance.now();
    const hits = await fallbackScan(sql, terms, filters);
    timings.sqlMs += elapsed(t);
    for (const h of hits) {
      fallbackUsed = true;
      const term = h.matched[0];
      const { start, end } = fallbackWindow(h.raw_content, term);
      passages.push({
        chunkId: null,
        documentId: h.id,
        title: h.title,
        sourceKind: h.source_kind,
        author: h.author,
        origin: h.origin,
        occurredAt: h.occurred_at ? h.occurred_at.toISOString() : null,
        headingPath: [],
        content: h.raw_content.slice(start, end),
        charStart: start,
        charEnd: end,
        score: null,
        scoreKind: "none",
        layers: ["fallback"],
        vectorRank: null,
        keywordRank: null,
        rerankRank: null,
        fallbackTerm: term,
        viaEntity: null,
      });
    }
  }

  const mode = searchMode(degraded);
  // The v1 columns stay filled for compatibility; results, degraded, candidates, timings, k and mode are v2 (spec §6.2).
  const layers = [
    "hybrid", "summary", ...(entities.length ? ["graph"] : []), ...(facts.length ? ["facts"] : []), ...(fallbackUsed ? ["fallback"] : []),
    ...(isDegraded(degraded) ? ["degraded"] : []), ...(degraded.capReached ? ["cap_reached"] : []),
  ];
  const logFilters = { sourceKinds: filters.kinds, since: filters.since, until: filters.until, verifiedOnly: filters.verifiedOnly };
  const json = (v: unknown) => sql.json(v as postgres.JSONValue);
  timings.totalMs = elapsed(started);
  const [logged] = await sql<{ id: string }[]>`
    insert into brain.retrieval_log
      (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client, results, degraded, candidates, timings, k, mode)
    values (${query}, ${json(logFilters)}, ${layers}::text[],
            ${passages.map((p) => p.chunkId).filter((id): id is string => id !== null)}::uuid[],
            ${entities.map((e) => e.id)}::uuid[], ${topScore}, ${fallbackUsed}, ${opts.client ?? "cli"},
            ${json(toLoggedPassages(passages))}, ${json(degraded)}, ${json(candidates)}, ${json(timings)}, ${k}, ${mode})
    returning id`;

  return { retrievalId: logged.id, query, k, mode, degraded, fallbackUsed, topScore, passages, documents, entities, facts, candidates, timings };
}
```

- [ ] **Step 6: Keep every consumer compiling**

In `src/mcp/render.ts`, after:
```ts
import type { SearchResult } from "../retrieve/search.js";
```
add:
```ts
import { degradedNote } from "../retrieve/contract.js";
```

delete (both now live in `contract.ts`, on the `degraded` object):
```ts
/** The one-line note for a degraded search, or null for a full hybrid search. */
export function degradedNote(r: Pick<SearchResult, "degradedReason" | "capReached">): string | null {
  switch (r.degradedReason) {
    case "cap":
      return "Voyage daily cap reached; keyword-only results";
    case "embedding":
      return "query embedding failed; keyword-only results";
    case "rerank":
      return r.capReached ? "Voyage daily cap reached; results in fused order" : "reranking failed; results in fused order";
    default:
      return null;
  }
}

/** The search mode, as the CLI prints it on its `mode:` line. */
export function searchMode(r: Pick<SearchResult, "degradedReason" | "capReached">): string {
  return degradedNote(r) ?? "hybrid (vector and keyword, reranked)";
}

```

and in `renderSearch` replace:
```ts
  const note = degradedNote(r);
  if (note) out.push(`(${note})`);
  if (r.usedFallback) out.push("(weak match: results include raw substring hits)\n");
```
with:
```ts
  const note = degradedNote(r.degraded);
  if (note) out.push(`(${note})`);
  if (r.fallbackUsed) out.push("(weak match: results include raw substring hits)\n");
```

and:
```ts
    const title = p.documentTitle ? ` · ${p.documentTitle}` : "";
    out.push(`[P${i + 1}] ${p.group} · 
```
with:
```ts
    const title = p.title ? ` · ${p.title}` : "";
    out.push(`[P${i + 1}] ${p.layers.join("+")} · 
```

In `src/cli.ts`, after:
```ts
import { ask } from "./retrieve/ask.js";
```
add:
```ts
import { degradedNote, searchMode } from "./retrieve/contract.js";
```

in the `search` action replace:
```ts
      const { searchMode } = await import("./mcp/render.js");
      console.log(`mode: ${searchMode(res)}\n`);
      if (res.usedFallback) console.log("(weak match: included raw substring hits)\n");
      res.passages.forEach((p, i) => {
        console.log(`[P${i + 1}] ${p.group} ${p.score.toFixed(3)} ${p.sourceKind}${p.documentTitle ? " · " + p.documentTitle : ""}`);
```
with:
```ts
      const note = degradedNote(res.degraded);
      console.log(`mode: ${searchMode(res.degraded)}${note ? ` (${note})` : ""}\n`);
      if (res.fallbackUsed) console.log("(weak match: included raw substring hits)\n");
      res.passages.forEach((p, i) => {
        console.log(`[P${i + 1}] ${p.layers.join("+")} ${p.score === null ? "-" : p.score.toFixed(3)} ${p.sourceKind}${p.title ? " · " + p.title : ""}`);
```

and in the `ask` action replace:
```ts
      result.passages.forEach((p, i) => console.log(`[P${i + 1}] ${p.sourceKind}${p.documentTitle ? " · " + p.documentTitle : ""} (${p.documentId})`));
```
with:
```ts
      result.passages.forEach((p, i) => console.log(`[P${i + 1}] ${p.sourceKind}${p.title ? " · " + p.title : ""} (${p.documentId})`));
```

In `src/retrieve/ask.ts`, in `buildAskPrompt`, replace:
```ts
${p.documentTitle ? ": " + p.documentTitle : ""}
```
with:
```ts
${p.title ? ": " + p.title : ""}
```

In `src/eval/run.ts`, after:
```ts
import { search, type SearchOptions, type SearchResult } from "../retrieve/search.js";
```
add:
```ts
import { isDegraded } from "../retrieve/contract.js";
```

in `toQuestionResult` replace:
```ts
    hasGraphPassage: res.passages.some((p) => p.group === "graph"),
    degraded: res.degraded,
```
with:
```ts
    hasGraphPassage: res.passages.some((p) => p.layers.includes("graph")),
    degraded: isDegraded(res.degraded),
```

and in `runEval` replace:
```ts
paras.map((r) => r.degraded)
```
with:
```ts
paras.map((r) => isDegraded(r.degraded))
```

Then confirm the sweep is complete: `grep -rnE "\.group\b|degradedReason|documentTitle|usedFallback|parentContent" src test` prints only `src/obsidian/names.ts` (an unrelated local `group`).

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/render.test.ts test/unit/eval.test.ts test/unit/contract.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/search.test.ts`
Expected: PASS (36 tests).

- [ ] **Step 8: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. `test/integration/mcp-server.test.ts` still passes unchanged: the MCP text keeps `(document <id>, chunk <id>)` until Task 4.

- [ ] **Step 9: Eval, and the first v2 log rows on `brain_eval`**

Run:
```bash
npm run eval:run
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "
select mode, k, jsonb_array_length(results) as passages, degraded, candidates, timings->>'totalMs' as total_ms, top_score
from brain.retrieval_log where client = 'eval' order by created_at desc limit 3"
```
Expected: the same per-question ranks as `eval/baseline.json`, `degraded=0%`, `vs baseline` deltas `+0.000`, no regressions (nothing that ranks changed: the same candidates, fusion and rerank). The latency numbers now come from the search's own clock, so they move slightly; they are not gated. The three log rows have `mode hybrid`, `k 10`, a passage count, `degraded {"rerank": false, "embedding": false, "capReached": false}`, candidate counts, a positive total, and a `top_score` between 0 and 1. If `search` fails with `column "results" of relation "retrieval_log" does not exist`, Task 2 Step 6 was skipped.

- [ ] **Step 10: Commit**

```bash
git add src/retrieve/layers.ts src/retrieve/search.ts src/mcp/render.ts src/cli.ts src/retrieve/ask.ts src/eval/run.ts \
  test/integration/search.test.ts test/unit/render.test.ts test/unit/eval.test.ts
git commit -m "Search returns the evidence contract: per-passage ranks, layers, score kind; degraded flags, candidates, timings; logged as retrieval_log v2 with the id returned

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Render from the structure; `structuredContent`; CLI `search`

**Files:**
- Modify: `src/mcp/render.ts` (`scoreText`, `foundBy`, `passageLine`, `factLine`, `searchHeader`, `renderSearch` with a brief mode)
- Modify: `src/mcp/server.ts` (`outputSchema`, `structuredContent`, description, instructions, `doc <id>`)
- Modify: `src/cli.ts` (`search` prints the same provenance)
- Modify: `test/unit/render.test.ts`
- Modify: `test/integration/mcp-server.test.ts`

The text the model reads, line by line (an excerpt of the unit test's fixture; P2 is left out here):

```
retrieval 6f1c2a0e-… · mode: hybrid · 4 passages
(weak match: results include raw substring hits)

[P1] 0.76 rerank · vector#2 keyword#5 · news · author: other · "Doc" · 2026-09-29 (doc d1, chunk c1)
  H > Sub
Body text

[P3] - · graph via Acme · note · author: owner · "Acme memo" · 2026-01-25 (doc d3, chunk c3)
Graph body

[P4] - · fallback "X-90" · note · author: unknown · "Codes" · undated (doc d4, chars 10–30)
Order X-90 today

Documents by summary: Doc [news] (doc d1)
Entity organization: Acme (node n1, matched "acme") — Austin (place)
Facts about the owner:
[F1] visa_status: F-1 OPT (unverified · from note d9)
[F2] lives_in: Austin (verified · stated by owner)
```

- Header: `retrieval <id> · mode: <mode> · <n> passages`. A degraded search keeps Phase 3's note on the next line (one of four); a fallback scan adds the weak-match note. The id is the full UUID, since `brain_explain` and Phase 5's `brain_verify` take it.
- Score: rerank scores with two decimals, RRF values with four (they run from about 0.008 to 0.033, and two decimals would print `0.03` for most of them), `-` for none.
- How found: `vector#n keyword#n` (either alone in keyword-only mode or when one branch missed the passage), `graph via <entity>`, `fallback "<term>"`.
- Ids: `(doc <id>, chunk <id>)`; a fallback window has no chunk, so `(doc <id>, chars <start>–<end>)`. "document" becomes "doc", so the `brain_get_document` description changes with it.
- Facts: `verified`/`unverified`, then `from <kind> <doc id>` (the extractor read it there), `stated by owner` (no source passage, not written by the extractor), or `extracted; source passage no longer stored`.
- Entities show the matched span, so a professional can see which words of the query triggered graph expansion.

`brain_search` declares `outputSchema: SearchResultSchema` and returns `{ content: [text], structuredContent: result }`. The SDK validates the result with the zod schema before sending (a `Date` or a stray field type would fail), and the client validates it against the JSON schema from `tools/list`. The structure includes passage `content` (see the header for why). The CLI prints `renderSearch(res, { brief: true })`: the same header and provenance lines, each passage cut to one 240-character line.

The `brain_explain` mentions are added in Task 5, when the tool exists.

- [ ] **Step 1: Write the failing unit tests**

In `test/unit/render.test.ts`, replace everything above `describe("other renderers", () => {` with:
```ts
import { describe, it, expect } from "vitest";
import {
  renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, passageLine, factLine, scoreText, foundBy, searchHeader,
} from "../../src/mcp/render.js";
import { passage, fact, searchResult } from "./search-fixture.js";

const graphPassage = passage({
  chunkId: "c3", documentId: "d3", title: "Acme memo", sourceKind: "note", author: "owner", occurredAt: "2026-01-25T00:00:00.000Z",
  content: "Graph body", score: null, scoreKind: "none", layers: ["graph"], vectorRank: null, keywordRank: null, rerankRank: null,
  viaEntity: { id: "n1", name: "Acme" },
});
const fallbackPassage = passage({
  chunkId: null, documentId: "d4", title: "Codes", sourceKind: "note", author: "unknown", occurredAt: null, content: "Order X-90 today",
  charStart: 10, charEnd: 30, score: null, scoreKind: "none", layers: ["fallback"], vectorRank: null, keywordRank: null, rerankRank: null,
  fallbackTerm: "X-90",
});

const fixture = searchResult({
  fallbackUsed: true,
  topScore: 0.76,
  passages: [
    passage({ headingPath: ["H", "Sub"] }),
    passage({
      chunkId: "c2", documentId: "d2", title: null, sourceKind: "note", author: "owner", occurredAt: null, content: "  Second body  ",
      score: 0.41, layers: ["vector"], vectorRank: 1, keywordRank: null, rerankRank: 2,
    }),
    graphPassage,
    fallbackPassage,
  ],
  documents: [{ documentId: "d1", title: "Doc", sourceKind: "news", summary: "S", score: 0.03 }],
  entities: [{ id: "n1", type: "organization", name: "Acme", matchedSpan: "acme", neighbors: [{ id: "n2", type: "place", name: "Austin", depth: 1 }] }],
  facts: [
    fact(),
    fact({ id: "f2", predicate: "lives_in", objectText: "Austin", verified: true, verifiedBy: "agent:claude-code", sourceChunkId: null, sourceDocumentId: null, sourceKind: null }),
    fact({ id: "f3", predicate: "prefers", objectText: "tea", sourceChunkId: null, sourceDocumentId: null, sourceKind: null }),
  ],
});

describe("renderSearch", () => {
  it("generates the whole text from the structure", () => {
    expect(renderSearch(fixture)).toBe(
      [
        "retrieval r1 · mode: hybrid · 4 passages",
        "(weak match: results include raw substring hits)",
        "",
        '[P1] 0.76 rerank · vector#2 keyword#5 · news · author: other · "Doc" · 2026-09-29 (doc d1, chunk c1)',
        "  H > Sub",
        "Body text",
        "",
        "[P2] 0.41 rerank · vector#1 · note · author: owner · (untitled) · undated (doc d2, chunk c2)",
        "Second body",
        "",
        '[P3] - · graph via Acme · note · author: owner · "Acme memo" · 2026-01-25 (doc d3, chunk c3)',
        "Graph body",
        "",
        '[P4] - · fallback "X-90" · note · author: unknown · "Codes" · undated (doc d4, chars 10–30)',
        "Order X-90 today",
        "",
        "Documents by summary: Doc [news] (doc d1)",
        'Entity organization: Acme (node n1, matched "acme") — Austin (place)',
        "Facts about the owner:",
        "[F1] visa_status: F-1 OPT (unverified · from note d9)",
        "[F2] lives_in: Austin (verified · stated by owner)",
        "[F3] prefers: tea (unverified · extracted; source passage no longer stored)",
      ].join("\n"),
    );
  });

  it("brief mode keeps every provenance line and cuts each passage to one line", () => {
    const long = passage({ content: "word ".repeat(100) + "\n\nend" });
    const text = renderSearch(searchResult({ passages: [long] }), { brief: true });
    expect(text.split("\n")[0]).toBe("retrieval r1 · mode: hybrid · 1 passage");
    expect(text).toContain(passageLine(long, 0));
    const body = text.split("\n")[3];
    expect(body.startsWith("     word word")).toBe(true);
    expect(body.length).toBe(5 + 240);
  });

  it("states the mode exactly and keeps the four degraded notes on the line after the header", () => {
    const cases = [
      { degraded: { embedding: true, rerank: true, capReached: true }, mode: "keyword-only" as const, note: "Voyage daily cap reached; keyword-only results" },
      { degraded: { embedding: true, rerank: true, capReached: false }, mode: "keyword-only" as const, note: "query embedding failed; keyword-only results" },
      { degraded: { embedding: false, rerank: true, capReached: true }, mode: "fused-order" as const, note: "Voyage daily cap reached; results in fused order" },
      { degraded: { embedding: false, rerank: true, capReached: false }, mode: "fused-order" as const, note: "reranking failed; results in fused order" },
    ];
    for (const c of cases) {
      const lines = renderSearch(searchResult({ retrievalId: "r9", mode: c.mode, degraded: c.degraded })).split("\n");
      expect(lines[0]).toBe(`retrieval r9 · mode: ${c.mode} · 0 passages`);
      expect(lines[1]).toBe(`(${c.note})`);
    }
    const hybrid = renderSearch(searchResult()).split("\n");
    expect(hybrid[0]).toBe("retrieval r1 · mode: hybrid · 0 passages");
    expect(hybrid[1]).toBe("");
  });

  it("says so when nothing was found", () => {
    expect(renderSearch(searchResult())).toContain("No passages matched.");
  });

  it("shows RRF scores with four decimals when reranking was skipped, and keyword ranks alone in keyword-only mode", () => {
    const p = passage({ score: 1 / 61, scoreKind: "rrf", layers: ["keyword"], vectorRank: null, keywordRank: 1, rerankRank: null });
    expect(scoreText(p)).toBe("0.0164 rrf");
    expect(foundBy(p)).toBe("keyword#1");
    expect(scoreText(graphPassage)).toBe("-");
    expect(foundBy(graphPassage)).toBe("graph via Acme");
    expect(foundBy(fallbackPassage)).toBe('fallback "X-90"');
  });

  it("factLine and searchHeader are what renderSearch prints", () => {
    expect(factLine(fact(), 0)).toBe("[F1] visa_status: F-1 OPT (unverified · from note d9)");
    expect(searchHeader(fixture)).toBe("retrieval r1 · mode: hybrid · 4 passages");
  });
});

```

- [ ] **Step 2: Write the failing integration tests**

In `test/integration/mcp-server.test.ts`, after:
```ts
import type { ObsidianAutoProjector } from "../../src/obsidian/auto.js";
```
add:
```ts
import { SearchResultSchema } from "../../src/retrieve/contract.js";
import { renderSearch } from "../../src/mcp/render.js";
```

In `"ingests quickly, finishes in the background, then searches and reads"`, replace:
```ts
    expect(search.text).toContain(`document ${id}`);
```
with:
```ts
    expect(search.text).toContain(`doc ${id}`);
```

Add before `"logs every tool call in order, with the client, outcome, and no saved text"`. Before:
```ts
  it("logs every tool call in order, with the client, outcome, and no saved text", async () => {
```
add:
```ts
  it("tells clients how to read modes and scores, and to keep their own words apart from the knowledge base", async () => {
    const s = await connect(true);
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain("Every brain_search result starts with `retrieval <id> · mode: <mode>`");
    expect(instructions).toContain("so you can tell strong evidence from weak");
    expect(instructions).toContain("Make clear which parts of the answer come from the knowledge base and which are your own");
    const searchTool = (await s.client.listTools()).tools.find((t) => t.name === "brain_search")!;
    expect(searchTool.description).toContain("score kind rerank is 0 to 1");
    expect(searchTool.description).toContain("structuredContent");
    expect(searchTool.outputSchema).toBeDefined();
    await s.close();
  });

  it("brain_search starts with the retrieval id and mode, shows each passage's provenance, and returns the contract as structuredContent", async () => {
    const s = await connect();
    const ing = await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    const id = /document ([0-9a-f-]{36})/.exec(ing.text)![1];
    await s.jobs.drain();
    await s.client.listTools(); // the client validates structuredContent against the advertised outputSchema
    const res = await s.client.callTool({ name: "brain_search", arguments: { query: "Acme Corp visa", k: 5 } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    const sc = SearchResultSchema.parse(res.structuredContent);
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(text.split("\n")[0]).toBe(`retrieval ${sc.retrievalId} · mode: hybrid · ${sc.passages.length} passage${sc.passages.length === 1 ? "" : "s"}`);
    expect(text).toContain(`[P1] ${(sc.passages[0].score as number).toFixed(2)} rerank · `);
    expect(text).toContain(`(doc ${id}, chunk ${sc.passages[0].chunkId})`);
    expect(text).toContain("author: owner");
    expect(text).toContain(`[F1] visa_status: F-1 OPT (unverified · from note ${id})`);
    // The text is generated from the structure alone, and the structure carries every passage's text.
    expect(renderSearch(sc)).toBe(text);
    expect(sc.passages.every((p) => text.includes(p.content.trim()))).toBe(true);
    const [log] = await sql<{ client: string; mode: string }[]>`select client, mode from brain.retrieval_log where id = ${sc.retrievalId}`;
    expect(log).toEqual({ client: "test", mode: "hybrid" });
    await s.close();
  });

```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/render.test.ts`
Expected: FAIL: the old text has no `retrieval … · mode: …` header (the snapshot and header assertions fail), and `passageLine`, `factLine`, `scoreText`, `foundBy` and `searchHeader` are not functions.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/mcp-server.test.ts`
Expected: FAIL: the instructions lack the new sentences, `outputSchema` is undefined, `structuredContent` is undefined, the text has no `retrieval` header and says `document <id>`.

- [ ] **Step 4: Generate the text from the structure in `src/mcp/render.ts`**

In `src/mcp/render.ts`, replace the two imports:
```ts
import type { SearchResult } from "../retrieve/search.js";
import { degradedNote } from "../retrieve/contract.js";
```
with:
```ts
import { degradedNote, factSource, type FactRow, type LoggedPassage, type SearchResult } from "../retrieve/contract.js";
```

and replace the whole `renderSearch` function with:
```ts
/** "0.76 rerank", "0.0328 rrf" (reranking skipped), or "-" for a passage with no score (graph and fallback). */
export function scoreText(p: Pick<LoggedPassage, "score" | "scoreKind">): string {
  if (p.score === null || p.scoreKind === "none") return "-";
  return `${p.score.toFixed(p.scoreKind === "rrf" ? 4 : 2)} ${p.scoreKind}`;
}

/** How a passage was found: its rank in each branch, the entity it came through, or the literal term it contains. */
export function foundBy(p: Pick<LoggedPassage, "layers" | "vectorRank" | "keywordRank" | "viaEntity" | "fallbackTerm">): string {
  if (p.layers.includes("graph")) return `graph via ${p.viaEntity?.name ?? "an entity"}`;
  if (p.layers.includes("fallback")) return `fallback "${p.fallbackTerm ?? ""}"`;
  const ranks = [p.vectorRank !== null ? `vector#${p.vectorRank}` : null, p.keywordRank !== null ? `keyword#${p.keywordRank}` : null];
  return ranks.filter((x): x is string => x !== null).join(" ");
}

/**
 * One passage's provenance line: label, score and score kind, how it was found, source kind, author, title, date,
 * and the ids to read it with (a fallback passage has no chunk, so its character window instead).
 */
export function passageLine(p: LoggedPassage, index: number): string {
  const title = p.title ? `"${p.title}"` : "(untitled)";
  const date = p.occurredAt ? p.occurredAt.slice(0, 10) : "undated";
  const where = p.chunkId ? `(doc ${p.documentId}, chunk ${p.chunkId})` : `(doc ${p.documentId}, chars ${p.charStart}–${p.charEnd})`;
  return `[P${index + 1}] ${scoreText(p)} · ${foundBy(p)} · ${p.sourceKind} · author: ${p.author} · ${title} · ${date} ${where}`;
}

/** One fact: verification state, and whether the extractor read it from a document or the owner stated it. */
export function factLine(f: FactRow, index: number): string {
  const src = factSource(f);
  const from =
    src.kind === "document" ? `from ${src.sourceKind} ${src.documentId}`
    : src.kind === "owner" ? "stated by owner"
    : "extracted; source passage no longer stored";
  return `[F${index + 1}] ${f.predicate}: ${f.objectText} (${f.verified ? "verified" : "unverified"} · ${from})`;
}

/** First line of every search: the id brain_explain takes, the exact mode, and the passage count. */
export function searchHeader(r: Pick<SearchResult, "retrievalId" | "mode" | "passages">): string {
  const n = r.passages.length;
  return `retrieval ${r.retrievalId} · mode: ${r.mode} · ${n} passage${n === 1 ? "" : "s"}`;
}

/**
 * The brain_search text, generated from the evidence contract alone. brief (the CLI's `brain search`) prints each
 * passage as one line of at most 240 characters instead of its heading path and full text.
 */
export function renderSearch(r: SearchResult, opts: { brief?: boolean } = {}): string {
  const out = [searchHeader(r)];
  const note = degradedNote(r.degraded);
  if (note) out.push(`(${note})`);
  if (r.fallbackUsed) out.push("(weak match: results include raw substring hits)");
  out.push("");
  if (r.passages.length === 0) out.push("No passages matched.");
  r.passages.forEach((p, i) => {
    const body = opts.brief
      ? `     ${p.content.replace(/\s+/g, " ").trim().slice(0, 240)}`
      : `${p.headingPath.length ? `  ${p.headingPath.join(" > ")}\n` : ""}${p.content.trim()}`;
    out.push(`${passageLine(p, i)}\n${body}\n`);
  });
  if (r.documents.length) out.push("Documents by summary: " + r.documents.map((d) => `${d.title ?? "(untitled)"} [${d.sourceKind}] (doc ${d.documentId})`).join("; "));
  for (const e of r.entities) {
    const n = e.neighbors.map((x) => `${x.name} (${x.type})`).join(", ") || "no neighbors";
    out.push(`Entity ${e.type}: ${e.name} (node ${e.id}, matched "${e.matchedSpan}") — ${n}`);
  }
  if (r.facts.length) out.push("Facts about the owner:\n" + r.facts.map(factLine).join("\n"));
  return out.join("\n");
}

```

- [ ] **Step 5: `structuredContent`, the description and the instructions in `src/mcp/server.ts`**

In `src/mcp/server.ts`, after:
```ts
import { search } from "../retrieve/search.js";
```
add:
```ts
import { SearchResultSchema } from "../retrieve/contract.js";
```

replace:
```ts
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
```
with:
```ts
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
```

In `instructions`, replace step 4:
```ts
    "4. Answer from the returned passages and cite them as [P1], [F1]. If nothing relevant comes back, say so rather than answering from elsewhere, and name any other source you use.",
  ];
```
with:
```ts
    "4. Answer from the returned passages and cite them as [P1], [F1]. Make clear which parts of the answer come from the knowledge base and which are your own. If nothing relevant comes back, say so rather than answering from elsewhere, and name any other source you use.",
    "Every brain_search result starts with `retrieval <id> · mode: <mode>`. Mode hybrid is a full search; keyword-only and fused-order mean part of it fell back, so treat its ranking as weaker. Each passage shows its score and score kind (rerank: 0 to 1, higher is stronger; rrf: reranking was skipped; -: found through a named entity or a literal match, unscored), the search branches that found it with their ranks, and who wrote it, so you can tell strong evidence from weak.",
  ];
```

Replace the `brain_search` description:
```ts
      description: "Hybrid keyword and semantic search over everything the owner has saved. Expands entities named in the query (neighbours and up to 5 passages that mention each), and returns up to 10 of the owner's facts that share a term with the query or point at a named entity; use brain_get_facts or brain_orient for the full fact list. Returns numbered passages and facts with document and chunk ids.",
```
with:
```ts
      description:
        "Hybrid keyword and semantic search over everything the owner has saved. Expands entities named in the query (neighbours and up to 5 passages that mention each), and returns up to 10 of the owner's facts that share a term with the query or point at a named entity; use brain_get_facts or brain_orient for the full fact list. " +
        "The first line is `retrieval <id> · mode: hybrid | keyword-only | fused-order · <n> passages`. Each passage line reads `[P1] <score> <score kind> · <how found> · <source kind> · author: <owner|other|unknown> · \"<title>\" · <date> (doc <id>, chunk <id>)`: score kind rerank is 0 to 1 (higher is stronger), rrf means reranking was skipped, and - marks a passage found through a named entity (graph via <entity>) or a literal match (fallback \"<term>\"); how found lists vector#<rank> and keyword#<rank>. Each fact says verified or unverified and whether it was read from a document (from <kind> <doc id>) or stated by the owner. " +
        "The same result is returned as structuredContent.",
```

Give it the output schema and return the structure with the text:
```ts
        verified_only: z.boolean().optional().describe("Only return facts and neighbour nodes marked verified. Passages are never filtered: documents have no verification state."),
      },
    },
    async (a) => {
      try {
        const r = await search(ctx, a.query, { k: a.k, sourceKinds: a.source_kinds, since: dateOrUndefined(a.since), until: dateOrUndefined(a.until), verifiedOnly: a.verified_only, client: opts.client });
        return text(renderSearch(r));
```
with:
```ts
        verified_only: z.boolean().optional().describe("Only return facts and neighbour nodes marked verified. Passages are never filtered: documents have no verification state."),
      },
      outputSchema: SearchResultSchema,
    },
    async (a) => {
      try {
        const r = await search(ctx, a.query, { k: a.k, sourceKinds: a.source_kinds, since: dateOrUndefined(a.since), until: dateOrUndefined(a.until), verifiedOnly: a.verified_only, client: opts.client });
        return { content: [{ type: "text", text: renderSearch(r) }], structuredContent: r };
```

In `brain_get_document`, replace:
```ts
document_id: z.string().describe("UUID shown as 'document <id>' in brain_search results")
```
with:
```ts
document_id: z.string().describe("UUID shown as 'doc <id>' in brain_search results")
```

- [ ] **Step 6: The CLI `search` prints the same provenance**

In `src/cli.ts`, replace:
```ts
import { degradedNote, searchMode } from "./retrieve/contract.js";
```
with:
```ts
import { renderSearch } from "./mcp/render.js";
```

and in the `search` action replace:
```ts
      const note = degradedNote(res.degraded);
      console.log(`mode: ${searchMode(res.degraded)}${note ? ` (${note})` : ""}\n`);
      if (res.fallbackUsed) console.log("(weak match: included raw substring hits)\n");
      res.passages.forEach((p, i) => {
        console.log(`[P${i + 1}] ${p.layers.join("+")} ${p.score === null ? "-" : p.score.toFixed(3)} ${p.sourceKind}${p.title ? " · " + p.title : ""}`);
        console.log(`     ${p.content.replace(/\s+/g, " ").slice(0, 240)}\n`);
      });
      if (res.documents.length) console.log("Documents: " + res.documents.map((d) => d.title ?? d.documentId).join(" | "));
      for (const e of res.entities) console.log(`Entity ${e.type}: ${e.name} -> ${e.neighbors.map((n) => `${n.name} (${n.type})`).join(", ") || "no neighbors"}`);
      if (res.facts.length) console.log("Facts: " + res.facts.map((f) => `${f.predicate}=${f.objectText}`).join("; "));
```
with:
```ts
      console.log(renderSearch(res, { brief: true }));
```

`--json` still prints the whole result: the full contract, passage text included.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/render.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/mcp-server.test.ts test/integration/search.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green.

- [ ] **Step 9: One CLI search on `brain_eval`**

Run:
```bash
OBSIDIAN_AUTO=0 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval npm run brain -- search "Who led Acme's Series B?" -k 3
```
Expected: the first line is `retrieval <uuid> · mode: hybrid · <n> passages` (n is 3 plus any graph or fallback passages), then a blank line, then lines like `[P1] 0.8x rerank · vector#1 keyword#1 · news · author: other · "…" · … (doc …, chunk …)` each followed by one indented line of text, then the summary, entity and fact lines. Note the retrieval id for Task 5. `OBSIDIAN_AUTO=0` keeps the Obsidian mirror off and `DATABASE_URL` keeps the real database out of it; the search costs one query embedding and one rerank against `brain_eval`'s own cap.

- [ ] **Step 10: Commit**

```bash
git add src/mcp/render.ts src/mcp/server.ts src/cli.ts test/unit/render.test.ts test/integration/mcp-server.test.ts
git commit -m "brain_search text generated from the evidence contract: retrieval id and mode header, per-passage score, ranks, author, date and ids, fact provenance; structuredContent with outputSchema; CLI search prints the same

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `brain_explain` and `brain explain`

**Files:**
- Create: `src/retrieve/explain.ts`
- Modify: `src/mcp/render.ts` (`explainLine`, `renderExplain`, orient guidance)
- Modify: `src/mcp/server.ts` (`brain_explain`, read-only; mentions in the instructions and the `brain_search` description)
- Modify: `src/cli.ts` (`explain` command; hint under `search`)
- Modify: `README.md`
- Create: `test/integration/explain.test.ts`
- Modify: `test/unit/render.test.ts`
- Modify: `test/integration/mcp-server.test.ts`

`explain(sql, id)` reads one row with `select to_jsonb(l) from brain.retrieval_log l where l.id = $1` and parses it with zod. `to_jsonb` returns whichever columns exist, so the same code explains a v2 row, a row logged before migration 011 (v2 columns null), and a row in a database that does not have 011 at all (v2 keys absent). It never embeds, reranks or writes. A malformed id and an unknown id both return null, and both callers print `explainNotFound(id)`, which says where the id comes from. The tool is registered with the read tools, so `BRAIN_MCP_READONLY=1` exposes it.

What it prints for a v2 row:

```
retrieval r1 · logged 2026-10-02T09:15:00.000Z · client mcp-stdio
query: "acme X-90"
filters: source_kinds note, news · since 2026-09-01T00:00:00.000Z
mode: hybrid · k 10
degraded: embedding no · rerank no · cap reached no
candidates: vector 60 · keyword 12 · fused 64
timings: embed 120.3 ms · sql 45.1 ms · rerank 210.0 ms · graph 3.2 ms · total 380.9 ms
top rerank score: 0.76
fallback scan: used

Passages in rank order (P labels as brain_search showed them): 4
#1 [P1] score 0.76 (rerank) · layers vector+keyword · vector 2 · keyword 5 · rerank 1 · "Doc" · author: other · news (doc d1, chunk c1)
#2 [P2] score 0.41 (rerank) · layers vector · vector 1 · keyword - · rerank 2 · (untitled) · author: owner · note (doc d2, chunk c2)
#3 [P3] score - (none) · layers graph via Acme · vector - · keyword - · rerank - · "Acme memo" · author: owner · note (doc d3, chunk c3)
#4 [P4] score - (none) · layers fallback "X-90" · vector - · keyword - · rerank - · "Codes" · author: unknown · note (doc d4, chars 10–30)
```

For a row logged before evidence v2 it prints the query, filters and client, then `logged before evidence v2: …` and what is known: layers, top score (with the warning that it is an RRF value when that search was degraded), the fallback flag, the chunk ids in rank order and the entity ids.

- [ ] **Step 1: Write the failing unit tests**

In `test/unit/render.test.ts`, replace the imports:
```ts
import {
  renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, passageLine, factLine, scoreText, foundBy, searchHeader,
} from "../../src/mcp/render.js";
import { passage, fact, searchResult } from "./search-fixture.js";
```
with:
```ts
import {
  renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, passageLine, factLine, scoreText, foundBy, searchHeader,
  renderExplain,
} from "../../src/mcp/render.js";
import { toLoggedPassages } from "../../src/retrieve/contract.js";
import type { Explanation } from "../../src/retrieve/explain.js";
import { passage, fact, searchResult } from "./search-fixture.js";
```

Add before `describe("other renderers", () => {` (it reuses the `fixture` defined at the top of the file). Before:
```ts
describe("other renderers", () => {
```
add:
```ts
describe("renderExplain", () => {
  const base: Explanation = {
    retrievalId: "r1", query: "acme X-90", client: "mcp-stdio", createdAt: "2026-10-02T09:15:00.000Z",
    filters: { sourceKinds: ["note", "news"], since: "2026-09-01T00:00:00.000Z", until: null, verifiedOnly: false },
    v2: true, k: 10, mode: "hybrid", degraded: { embedding: false, rerank: false, capReached: false },
    candidates: { vector: 60, keyword: 12, fused: 64 }, timings: { embedMs: 120.3, sqlMs: 45.1, rerankMs: 210, graphMs: 3.2, totalMs: 380.9 },
    results: toLoggedPassages(fixture.passages), layers: ["hybrid", "summary", "graph", "fallback"], chunkIds: ["c1", "c2", "c3"], nodeIds: ["n1"],
    topScore: 0.76, usedFallback: true,
  };

  it("replays a v2 row: who and when, filters, mode, flags, candidates, timings, and every passage's ranks and score", () => {
    expect(renderExplain(base)).toBe(
      [
        "retrieval r1 · logged 2026-10-02T09:15:00.000Z · client mcp-stdio",
        'query: "acme X-90"',
        "filters: source_kinds note, news · since 2026-09-01T00:00:00.000Z",
        "mode: hybrid · k 10",
        "degraded: embedding no · rerank no · cap reached no",
        "candidates: vector 60 · keyword 12 · fused 64",
        "timings: embed 120.3 ms · sql 45.1 ms · rerank 210.0 ms · graph 3.2 ms · total 380.9 ms",
        "top rerank score: 0.76",
        "fallback scan: used",
        "",
        "Passages in rank order (P labels as brain_search showed them): 4",
        '#1 [P1] score 0.76 (rerank) · layers vector+keyword · vector 2 · keyword 5 · rerank 1 · "Doc" · author: other · news (doc d1, chunk c1)',
        "#2 [P2] score 0.41 (rerank) · layers vector · vector 1 · keyword - · rerank 2 · (untitled) · author: owner · note (doc d2, chunk c2)",
        '#3 [P3] score - (none) · layers graph via Acme · vector - · keyword - · rerank - · "Acme memo" · author: owner · note (doc d3, chunk c3)',
        '#4 [P4] score - (none) · layers fallback "X-90" · vector - · keyword - · rerank - · "Codes" · author: unknown · note (doc d4, chars 10–30)',
      ].join("\n"),
    );
  });

  it("shows the degraded note and an RRF ranking for a degraded row", () => {
    const rrf = passage({ score: 1 / 61, scoreKind: "rrf", layers: ["keyword"], vectorRank: null, keywordRank: 1, rerankRank: null });
    const t = renderExplain({
      ...base, mode: "keyword-only", degraded: { embedding: true, rerank: true, capReached: true }, topScore: null, results: toLoggedPassages([rrf]),
      filters: {},
    });
    expect(t).toContain("filters: none");
    expect(t).toContain("mode: keyword-only · k 10");
    expect(t).toContain("degraded: embedding yes · rerank yes · cap reached yes\n(Voyage daily cap reached; keyword-only results)");
    expect(t).toContain("top rerank score: none (no rerank ran, or it returned nothing)");
    expect(t).toContain("#1 [P1] score 0.0164 (rrf) · layers keyword · vector - · keyword 1 · rerank -");
  });

  it("explains what is known about a row logged before evidence v2", () => {
    const t = renderExplain({
      ...base, v2: false, k: null, mode: null, degraded: null, candidates: null, timings: null, results: null, filters: {},
      layers: ["hybrid", "summary", "degraded"], chunkIds: ["c1", "c2"], nodeIds: [], topScore: 0.031, usedFallback: false,
    });
    expect(t.split("\n")).toEqual([
      "retrieval r1 · logged 2026-10-02T09:15:00.000Z · client mcp-stdio",
      'query: "acme X-90"',
      "filters: none",
      "logged before evidence v2: only the chunk ids, the top score, the layers and the fallback flag were recorded.",
      "layers: hybrid, summary, degraded",
      "top score: 0.03 (before evidence v2 this is an RRF value when the search was degraded)",
      "fallback scan: not used",
      "chunks in rank order (fallback passages were not recorded): c1, c2",
      "entities: none",
    ]);
  });
});

```

- [ ] **Step 2: Write the failing integration tests**

`test/integration/explain.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";
import { explain, explainNotFound } from "../../src/retrieve/explain.js";
import { toLoggedPassages } from "../../src/retrieve/contract.js";
import { renderExplain } from "../../src/mcp/render.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM
    ? { title: "Untitled", summary_line: "A note.", summary: "A note.", occurred_at: null }
    : { entities: [], relations: [], facts_about_self: [] };

async function seed() {
  const ctx = fakeCtx(sql, handler);
  await ingest(ctx, { text: "Zorblax Industries in Austin released the ZX-9000 drill.", sourceKind: "news", title: "Zorblax news" });
  await ingest(ctx, { text: "Gardening notes: tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
  return ctx;
}

describe("explain", () => {
  it("replays a logged search from the log alone: mode, candidates, timings, and each passage's ranks and score", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Zorblax drill ZX-9000", { k: 5, sourceKinds: ["news", "note"] });
    const before = await sql`select id from brain.retrieval_log`;
    const embed = vi.spyOn(ctx.embedder, "embed");
    const e = (await explain(sql, res.retrievalId))!;
    expect(embed).not.toHaveBeenCalled();
    expect((await sql`select id from brain.retrieval_log`).length).toBe(before.length);
    expect(e).toMatchObject({
      retrievalId: res.retrievalId, query: "Zorblax drill ZX-9000", client: "cli", v2: true, k: 5, mode: res.mode,
      degraded: res.degraded, candidates: res.candidates, timings: res.timings, usedFallback: res.fallbackUsed,
    });
    expect(e.filters).toMatchObject({ sourceKinds: ["news", "note"], verifiedOnly: false });
    expect(e.results).toEqual(toLoggedPassages(res.passages));
    expect(e.topScore).toBeCloseTo(res.topScore as number, 5);
    expect(Number.isNaN(Date.parse(e.createdAt))).toBe(false);

    const text = renderExplain(e);
    expect(text.split("\n")[0]).toContain(`retrieval ${res.retrievalId} · logged `);
    expect(text).toContain(`mode: ${res.mode} · k 5`);
    expect(text).toContain(`candidates: vector ${res.candidates.vector} · keyword ${res.candidates.keyword} · fused ${res.candidates.fused}`);
    res.passages.forEach((p, i) => expect(text).toContain(`#${i + 1} [P${i + 1}] score `));
    const top = res.passages[0];
    expect(text).toContain(`#1 [P1] score ${(top.score as number).toFixed(2)} (rerank) · layers ${top.layers.join("+")} · vector ${top.vectorRank ?? "-"} · keyword ${top.keywordRank ?? "-"} · rerank 1`);
  });

  it("returns null for an unknown or malformed id, and the message says where the id comes from", async () => {
    expect(await explain(sql, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await explain(sql, "not-an-id")).toBeNull();
    expect(explainNotFound("abc")).toBe(
      'No logged search has retrieval id "abc". The id is on the first line of a brain_search result: retrieval <id> · mode: …',
    );
  });

  it("explains what is available for a row logged before evidence v2", async () => {
    const [row] = await sql<{ id: string }[]>`
      insert into brain.retrieval_log (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client)
      values ('old question', '{}'::jsonb, '{hybrid,summary,degraded}', '{}'::uuid[], '{}'::uuid[], 0.031, false, 'mcp-stdio')
      returning id`;
    const e = (await explain(sql, row.id))!;
    expect(e).toMatchObject({ v2: false, results: null, mode: null, k: null, degraded: null, client: "mcp-stdio", layers: ["hybrid", "summary", "degraded"] });
    expect(e.topScore).toBeCloseTo(0.031, 5);
    const text = renderExplain(e);
    expect(text).toContain("logged before evidence v2");
    expect(text).toContain("top score: 0.03");
  });
});
```

In `test/integration/mcp-server.test.ts`, replace the tool-list test:
```ts
  it("lists nine tools, or six when read-only", async () => {
    const a = await connect();
    expect((await a.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "brain_add_fact", "brain_get_document", "brain_get_facts", "brain_get_node", "brain_ingest", "brain_orient", "brain_search", "brain_status", "brain_supersede_fact",
    ]);
    await a.close();
    const b = await connect(true);
    expect((await b.client.listTools()).tools.length).toBe(6);
    await b.close();
  });
```
with:
```ts
  it("lists ten tools, or seven when read-only (brain_explain is read-only)", async () => {
    const a = await connect();
    expect((await a.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "brain_add_fact", "brain_explain", "brain_get_document", "brain_get_facts", "brain_get_node", "brain_ingest", "brain_orient", "brain_search", "brain_status", "brain_supersede_fact",
    ]);
    await a.close();
    const b = await connect(true);
    expect((await b.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "brain_explain", "brain_get_document", "brain_get_facts", "brain_get_node", "brain_orient", "brain_search", "brain_status",
    ]);
    await b.close();
  });

  it("brain_explain replays a brain_search from its retrieval id, also read-only, and says when the id is unknown", async () => {
    const s = await connect();
    await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    await s.jobs.drain();
    const found = await s.call("brain_search", { query: "Acme Corp visa", k: 5 });
    const id = /^retrieval ([0-9a-f-]{36}) · mode: hybrid/.exec(found.text)![1];
    await s.close();
    const ro = await connect(true);
    const ex = await ro.call("brain_explain", { retrieval_id: id });
    expect(ex.isError).toBe(false);
    expect(ex.text.split("\n")[0]).toMatch(new RegExp(`^retrieval ${id} · logged \\S+ · client test$`));
    expect(ex.text).toContain('query: "Acme Corp visa"');
    expect(ex.text).toContain("mode: hybrid · k 5");
    expect(ex.text).toMatch(/#1 \[P1\] score \d\.\d\d \(rerank\) · layers /);
    const missing = await ro.call("brain_explain", { retrieval_id: "00000000-0000-0000-0000-000000000000" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('No logged search has retrieval id "00000000-0000-0000-0000-000000000000"');
    expect((await sql`select id from brain.retrieval_log`).length).toBe(1);
    await ro.close();
  });
```

In `"tells clients how to read modes and scores, …"`, replace:
```ts
    expect(searchTool.description).toContain("structuredContent");
```
with:
```ts
    expect(searchTool.description).toContain("structuredContent");
    expect(searchTool.description).toContain("brain_explain");
    expect(instructions).toContain("brain_explain with the retrieval id replays how that search ranked its passages");
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/render.test.ts`
Expected: FAIL: `renderExplain is not a function` (the `Explanation` import is type-only and erased).

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/explain.test.ts test/integration/mcp-server.test.ts`
Expected: FAIL: `explain.js` does not exist; the tool list has no `brain_explain`.

- [ ] **Step 4: Write `src/retrieve/explain.ts`**

```ts
import { z } from "zod";
import type { Db } from "../db.js";
import { UUID } from "./documents.js";
import {
  CandidatesSchema, DegradedSchema, LoggedPassageSchema, SearchModeSchema, TimingsSchema,
  type Candidates, type Degraded, type LoggedPassage, type SearchMode, type Timings,
} from "./contract.js";

/** A logged search, replayed from brain.retrieval_log alone (spec §6.4). */
export interface Explanation {
  retrievalId: string;
  query: string;
  client: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** As logged: sourceKinds, since, until, verifiedOnly. */
  filters: Record<string, unknown>;
  /** False for a row logged before evidence v2 (migration 011): only the v1 fields below are known. */
  v2: boolean;
  k: number | null;
  mode: SearchMode | null;
  degraded: Degraded | null;
  candidates: Candidates | null;
  timings: Timings | null;
  /** The returned passages in rank order (index 0 is P1), without their text. */
  results: LoggedPassage[] | null;
  layers: string[];
  chunkIds: string[];
  nodeIds: string[];
  topScore: number | null;
  usedFallback: boolean;
}

/** The message for an id that names no logged search. */
export function explainNotFound(retrievalId: string): string {
  return `No logged search has retrieval id "${retrievalId}". The id is on the first line of a brain_search result: retrieval <id> · mode: …`;
}

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);

const LogRowSchema = z.object({
  id: z.string(),
  query: z.string(),
  client: z.string().nullish(),
  created_at: z.string(),
  filters: z.record(z.string(), z.unknown()).nullish(),
  layers: z.array(z.string()).nullish(),
  chunk_ids: z.array(z.string()).nullish(),
  node_ids: z.array(z.string()).nullish(),
  top_score: z.number().nullish(),
  used_fallback: z.boolean().nullish(),
  // Evidence v2 (migration 011); absent on a database without it, null on rows logged before it.
  results: nullable(z.array(LoggedPassageSchema)),
  degraded: nullable(DegradedSchema),
  candidates: nullable(CandidatesSchema),
  timings: nullable(TimingsSchema),
  k: nullable(z.number().int()),
  mode: nullable(SearchModeSchema),
});

/**
 * Reads one retrieval_log row; null when the id is not a UUID or names no row. It never searches again.
 * to_jsonb reads whichever columns the table has, so a database without migration 011 still explains its rows.
 */
export async function explain(sql: Db, retrievalId: string): Promise<Explanation | null> {
  if (!UUID.test(retrievalId)) return null;
  const [row] = await sql<{ r: unknown }[]>`select to_jsonb(l) as r from brain.retrieval_log l where l.id = ${retrievalId}`;
  if (!row) return null;
  const r = LogRowSchema.parse(row.r);
  return {
    retrievalId: r.id,
    query: r.query,
    client: r.client ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    filters: r.filters ?? {},
    v2: r.results !== null,
    k: r.k,
    mode: r.mode,
    degraded: r.degraded,
    candidates: r.candidates,
    timings: r.timings,
    results: r.results,
    layers: r.layers ?? [],
    chunkIds: r.chunk_ids ?? [],
    nodeIds: r.node_ids ?? [],
    topScore: r.top_score ?? null,
    usedFallback: r.used_fallback ?? false,
  };
}
```

- [ ] **Step 5: Render it in `src/mcp/render.ts`**

In `src/mcp/render.ts`, replace the contract import:
```ts
import { degradedNote, factSource, type FactRow, type LoggedPassage, type SearchResult } from "../retrieve/contract.js";
```
with:
```ts
import { NOT_DEGRADED, degradedNote, factSource, searchMode, type FactRow, type LoggedPassage, type SearchResult } from "../retrieve/contract.js";
import type { Explanation } from "../retrieve/explain.js";
```

Add before `export function renderOrient`. Before:
```ts
export function renderOrient(o: Orientation): string {
```
add:
```ts
const yesNo = (b: boolean) => (b ? "yes" : "no");
const msText = (n: number) => `${n.toFixed(1)} ms`;

function filtersText(f: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(f.sourceKinds) && f.sourceKinds.length) parts.push(`source_kinds ${f.sourceKinds.join(", ")}`);
  if (typeof f.since === "string") parts.push(`since ${f.since}`);
  if (typeof f.until === "string") parts.push(`until ${f.until}`);
  if (f.verifiedOnly === true) parts.push("verified_only");
  return parts.length ? parts.join(" · ") : "none";
}

/** One passage in brain_explain: rank and label, score with its kind, layers, every branch rank, title, author, ids. */
export function explainLine(p: LoggedPassage, index: number): string {
  const rank = (r: number | null) => (r === null ? "-" : String(r));
  const score = p.score === null ? "-" : p.score.toFixed(p.scoreKind === "rrf" ? 4 : 2);
  const via = p.viaEntity ? ` via ${p.viaEntity.name}` : p.fallbackTerm !== null ? ` "${p.fallbackTerm}"` : "";
  const title = p.title ? `"${p.title}"` : "(untitled)";
  const where = p.chunkId ? `(doc ${p.documentId}, chunk ${p.chunkId})` : `(doc ${p.documentId}, chars ${p.charStart}–${p.charEnd})`;
  return `#${index + 1} [P${index + 1}] score ${score} (${p.scoreKind}) · layers ${p.layers.join("+")}${via} · vector ${rank(p.vectorRank)} · keyword ${rank(p.keywordRank)} · rerank ${rank(p.rerankRank)} · ${title} · author: ${p.author} · ${p.sourceKind} ${where}`;
}

/** brain_explain and `brain explain`: a logged search replayed from brain.retrieval_log, with no new search. */
export function renderExplain(e: Explanation): string {
  const out = [
    `retrieval ${e.retrievalId} · logged ${e.createdAt} · client ${e.client ?? "unknown"}`,
    `query: "${e.query}"`,
    `filters: ${filtersText(e.filters)}`,
  ];
  if (!e.v2 || e.results === null) {
    out.push(
      "logged before evidence v2: only the chunk ids, the top score, the layers and the fallback flag were recorded.",
      `layers: ${e.layers.join(", ") || "none"}`,
      `top score: ${e.topScore === null ? "none" : e.topScore.toFixed(2)} (before evidence v2 this is an RRF value when the search was degraded)`,
      `fallback scan: ${e.usedFallback ? "used" : "not used"}`,
      `chunks in rank order (fallback passages were not recorded): ${e.chunkIds.join(", ") || "none"}`,
      `entities: ${e.nodeIds.join(", ") || "none"}`,
    );
    return out.join("\n");
  }
  const d = e.degraded ?? NOT_DEGRADED;
  out.push(`mode: ${e.mode ?? searchMode(d)} · k ${e.k ?? "unknown"}`);
  out.push(`degraded: embedding ${yesNo(d.embedding)} · rerank ${yesNo(d.rerank)} · cap reached ${yesNo(d.capReached)}`);
  const note = degradedNote(d);
  if (note) out.push(`(${note})`);
  if (e.candidates) out.push(`candidates: vector ${e.candidates.vector} · keyword ${e.candidates.keyword} · fused ${e.candidates.fused}`);
  if (e.timings) {
    const t = e.timings;
    out.push(`timings: embed ${msText(t.embedMs)} · sql ${msText(t.sqlMs)} · rerank ${msText(t.rerankMs)} · graph ${msText(t.graphMs)} · total ${msText(t.totalMs)}`);
  }
  out.push(`top rerank score: ${e.topScore === null ? "none (no rerank ran, or it returned nothing)" : e.topScore.toFixed(2)}`);
  out.push(`fallback scan: ${e.usedFallback ? "used" : "not used"}`);
  out.push("", `Passages in rank order (P labels as brain_search showed them): ${e.results.length}`);
  if (e.results.length === 0) out.push("none");
  e.results.forEach((p, i) => out.push(explainLine(p, i)));
  return out.join("\n");
}

```

In `renderOrient`'s guidance line, replace:
```ts
brain_get_document to read more of a hit; brain_ingest
```
with:
```ts
brain_get_document to read more of a hit; brain_explain to see how a search ranked its passages; brain_ingest
```

- [ ] **Step 6: The tool in `src/mcp/server.ts`**

In `src/mcp/server.ts`, after:
```ts
import { getDocument } from "../retrieve/documents.js";
```
add:
```ts
import { explain, explainNotFound } from "../retrieve/explain.js";
```

replace:
```ts
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus } from "./render.js";
```
with:
```ts
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, renderExplain } from "./render.js";
```

In `instructions`, at the end of the line that starts `"Every brain_search result starts with`, replace:
```ts
 so you can tell strong evidence from weak.",
```
with:
```ts
 so you can tell strong evidence from weak. brain_explain with the retrieval id replays how that search ranked its passages.",
```

In the `brain_search` description, replace:
```ts
        "The same result is returned as structuredContent.",
```
with:
```ts
        "Pass the retrieval id to brain_explain to see how the passages were ranked. The same result is returned as structuredContent.",
```

Register the tool with the read tools, before the read-only cut-off. Before:
```ts
  if (opts.readOnly) return server;
```
add:
```ts
  register(
    "brain_explain",
    {
      title: "Explain a search",
      description:
        "Replays a logged brain_search from its retrieval id (the id on the result's first line) without searching again: the query, filters, client and time, the mode and which parts fell back, how many candidates each branch produced, stage timings, and for every returned passage its rank and label, score and score kind, layers, vector, keyword and rerank ranks, title and author. Reads the log only.",
      inputSchema: { retrieval_id: z.string().min(1).describe("The id after 'retrieval' on the first line of a brain_search result") },
    },
    async (a) => {
      try {
        const e = await explain(ctx.sql, a.retrieval_id);
        return e ? text(renderExplain(e)) : fail(new Error(explainNotFound(a.retrieval_id)));
      } catch (e) { return fail(e); }
    },
  );

```

- [ ] **Step 7: The CLI command in `src/cli.ts`**

In `src/cli.ts`, replace:
```ts
import { renderSearch } from "./mcp/render.js";
```
with:
```ts
import { renderSearch, renderExplain } from "./mcp/render.js";
import { explain, explainNotFound } from "./retrieve/explain.js";
```

Replace the end of the `search` action and add the `explain` command after it:
```ts
      console.log(renderSearch(res, { brief: true }));
    });
  });
```
with:
```ts
      console.log(renderSearch(res, { brief: true }));
      console.log(`\nbrain explain ${res.retrievalId} replays how these passages were ranked.`);
    });
  });

program
  .command("explain <retrievalId>")
  .description("Replay a logged search from its retrieval id: mode, candidates, timings, and each passage's ranks and score")
  .action(async (retrievalId: string) => {
    await withCtx(async (ctx) => {
      const e = await explain(ctx.sql, retrievalId);
      if (!e) {
        console.error(explainNotFound(retrievalId));
        process.exitCode = 1;
        return;
      }
      console.log(renderExplain(e));
    });
  });
```

- [ ] **Step 8: README: the command, the tool, and how to read a search result**

In `README.md`, under Commands, after:
```
npm run brain -- search "<query>" [--kind news note] [--since 2026-01-01] [--until 2026-12-31] [--verified] [-k 10] [--json]
```
add:
```
npm run brain -- explain <retrieval-id>
```

replace:
```markdown
The server exposes the knowledge base as nine tools:
```
with:
```markdown
The server exposes the knowledge base as ten tools:
```

after:
```markdown
- `brain_status`: pipeline progress for documents.
```
add:
```markdown
- `brain_explain`: replay a logged search from its retrieval id: mode, candidate counts, timings, and each passage's ranks and score.
```

replace:
```markdown
With `BRAIN_MCP_READONLY=1` only the six read tools (the first six) are exposed.
```
with:
```markdown
With `BRAIN_MCP_READONLY=1` only the seven read tools (the first seven) are exposed.
```

and after the `brain.tool_calls` psql block in the MCP section (just before `### Claude Code (this Mac)`), leaving one blank line between them:
````markdown
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select created_at, client, tool, ok, args from brain.tool_calls order by created_at desc limit 20;"
```
````
add:
````markdown
### Reading a search result

Every search (`brain_search`, `brain search`, `brain ask`) returns one structure, the evidence contract in `src/retrieve/contract.ts`, and logs it to `brain.retrieval_log`. The text is generated from that structure, so what the model reads, what you read and what is logged say the same thing. `brain_search` also returns it as `structuredContent`; `brain search --json` prints it.

```
retrieval 6f1c2a0e-… · mode: hybrid · 7 passages

[P1] 0.76 rerank · vector#2 keyword#5 · note · author: other · "Databricks costs" · 2026-09-29 (doc 31f1…, chunk 5ec6…)
[P6] - · graph via Acme Corp · note · author: owner · "Acme notes" · undated (doc 8b0d…, chunk 77a1…)
[P7] - · fallback "X-90" · news · author: other · "Zorblax news" · 2026-08-02 (doc 4c3e…, chars 0–260)
[F1] visa_status: F-1 OPT (unverified · from note 9a2e…)
[F2] lives_in: Denver (verified · stated by owner)
```

- `retrieval <id>`: the log row. `npm run brain -- explain <id>` or `brain_explain` replays the search from the log without searching again: query, filters, client, time, mode, which parts fell back, candidate counts per branch, stage timings, and each passage's rank, score and branch ranks.
- `mode`: `hybrid` means vector and keyword candidates, reranked. `keyword-only` means the query embedding failed or the Voyage cap refused it, so there were only keyword candidates and nothing was reranked. `fused-order` means the rerank failed or was refused, so the candidates are in reciprocal-rank-fusion order. A degraded search says why on the next line.
- Score and kind: `rerank` is the reranker's relevance, 0 to 1, higher is stronger. `rrf` (about 0.008 to 0.033) only orders the passages of one degraded search and is not comparable with rerank scores. `-` means the passage was not scored: it came from graph expansion or the literal scan. The log's `top_score` and the fallback threshold use rerank scores only, so a degraded search has no top score.
- How found: `vector#n` and `keyword#n` are the passage's rank among each branch's candidates (up to 60 per branch). `graph via <entity>`: the passage mentions an entity named in the query. `fallback "<term>"`: the document contains an exact-string term from the query (a code, figure or version); the passage is a window of the raw document, not a stored chunk, so it has a character range instead of a chunk id.
- `author`: who wrote the document (`owner`, `other`, `unknown`). A passage by someone else says what they wrote, not what is true of you.
- Facts: `verified` once you confirmed it with `verify-fact`. `from <kind> <doc id>` means the extractor read it from that document; `stated by owner` means it was recorded on your word (`brain_add_fact`, or by hand) with no source passage.
- Knowledge base or model: passages and facts come from the base, with ids you can open. In an answer, anything without a `[P…]` or `[F…]` citation is the model's own; the server instructions ask clients to make that split clear.

`brain.retrieval_log` keeps, per search, the query, filters, client, time, `mode`, `degraded` (`embedding`, `rerank`, `capReached`), `candidates` (`vector`, `keyword`, `fused`), `timings` (`embedMs`, `sqlMs`, `rerankMs`, `graphMs`, `totalMs`), `k`, and `results`: every returned passage in rank order with everything above except its text. Rows logged before migration 011 have only chunk ids, layers and a top score (which may be an RRF value); explain says "logged before evidence v2".
````

- [ ] **Step 9: Run the tests**

Run: `npx vitest run test/unit/render.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/explain.test.ts test/integration/mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 10: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green.

- [ ] **Step 11: Explain the Task 4 search on `brain_eval`**

Run (with the retrieval id from Task 4 Step 9, or from any `search` run now, which prints the hint):
```bash
OBSIDIAN_AUTO=0 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval npm run brain -- explain <retrieval-id>
OBSIDIAN_AUTO=0 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval npm run brain -- explain 00000000-0000-0000-0000-000000000000; echo "exit $?"
```
Expected: the first prints `retrieval <id> · logged <time> · client cli`, the query, `filters: none`, `mode: hybrid · k 3`, the degraded line (all `no`), candidate counts (vector up to 60), timings, the top rerank score, and one `#n [Pn] …` line per passage, matching the search output's order and scores. The second prints `No logged search has retrieval id "00000000-0000-0000-0000-000000000000". …` and `exit 1`. Neither calls Voyage.

- [ ] **Step 12: Commit**

```bash
git add src/retrieve/explain.ts src/mcp/render.ts src/mcp/server.ts src/cli.ts README.md \
  test/integration/explain.test.ts test/unit/render.test.ts test/integration/mcp-server.test.ts
git commit -m "brain_explain and brain explain: replay a logged search from retrieval_log, including rows logged before evidence v2; README explains how to read a search result

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `ask` weighs its evidence

**Files:**
- Rewrite: `src/retrieve/ask.ts`
- Modify: `src/mcp/render.ts` (`renderSources`)
- Modify: `src/cli.ts` (`ask` prints its sources with provenance)
- Modify: `README.md`
- Create: `test/unit/ask.test.ts`
- Modify: `test/unit/render.test.ts`
- Modify: `test/integration/ask.test.ts`

The prompt gains a header (`Search mode: <mode>`, with the degraded note in parentheses, and a weak-match line when the fallback scan ran), and each passage line carries its score and kind, how it was found, and its author, using the same `scoreText`/`foundBy`/`factLine` as `brain_search`. The system prompt keeps its four sentences unchanged ("using only the passages and facts provided", cite as `[P1]`/`[F1]`, say so plainly, "Never state anything the material does not support.") and adds how to weigh the material: what the scores mean, that another author's passage is not a fact about the owner, and to say the evidence is weak when the mode is not hybrid or every score is low. Under the answer, the CLI prints `renderSources`: the header and the provenance lines, labelled as the knowledge base's, and the `brain explain` hint, so the reader can tell the model's words from the sources.

- [ ] **Step 1: Write the failing unit tests**

`test/unit/ask.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildAskPrompt, ASK_SYSTEM } from "../../src/retrieve/ask.js";
import { passage, fact, searchResult } from "./search-fixture.js";

describe("buildAskPrompt", () => {
  it("states the search mode, and each passage's score, how it was found, and author", () => {
    const prompt = buildAskPrompt("Why?", searchResult({ passages: [passage()], facts: [fact()] }));
    expect(prompt).toBe(
      [
        "Question: Why?",
        "",
        "Search mode: hybrid",
        "",
        "Facts about the owner:",
        "[F1] visa_status: F-1 OPT (unverified · from note d9)",
        "",
        "Passages:",
        "[P1] 0.76 rerank · vector#2 keyword#5 · author: other · news: Doc",
        "Body text",
      ].join("\n"),
    );
  });

  it("says when the search was degraded or fell back to literal matches", () => {
    const degraded = searchResult({
      mode: "keyword-only",
      degraded: { embedding: true, rerank: true, capReached: false },
      fallbackUsed: true,
      passages: [
        passage({ score: 1 / 61, scoreKind: "rrf", layers: ["keyword"], vectorRank: null, keywordRank: 1, rerankRank: null }),
        passage({ chunkId: null, author: "unknown", score: null, scoreKind: "none", layers: ["fallback"], vectorRank: null, keywordRank: null, rerankRank: null, fallbackTerm: "X-90" }),
      ],
    });
    const prompt = buildAskPrompt("What is X-90?", degraded);
    expect(prompt).toContain("Search mode: keyword-only (query embedding failed; keyword-only results)");
    expect(prompt).toContain("Weak match: some passages are literal substring hits (fallback), not ranked passages.");
    expect(prompt).toContain("[P1] 0.0164 rrf · keyword#1 · author: other · news: Doc");
    expect(prompt).toContain('[P2] - · fallback "X-90" · author: unknown · news: Doc');
    expect(buildAskPrompt("q", searchResult())).toContain("Passages:\n(none)");
  });

  it("keeps the rule that the answer comes only from the material, and says how to weigh it", () => {
    expect(ASK_SYSTEM).toContain("using only the passages and facts provided");
    expect(ASK_SYSTEM).toContain("Never state anything the material does not support.");
    expect(ASK_SYSTEM).toContain("When the search mode is not hybrid, or every score is low, say the evidence is weak.");
  });
});
```

In `test/unit/render.test.ts`, replace:
```ts
  renderExplain,
} from
```
with:
```ts
  renderExplain, renderSources,
} from
```

and add before `describe("renderExplain", () => {`. Before:
```ts
describe("renderExplain", () => {
```
add:
```ts
describe("renderSources", () => {
  it("lists what a brain ask answer could cite, marked as the knowledge base's, with the explain hint", () => {
    const r = searchResult({ passages: [passage()], facts: [fact()], degraded: { embedding: false, rerank: true, capReached: false }, mode: "fused-order" });
    expect(renderSources(r).split("\n")).toEqual([
      "Sources from the knowledge base (the answer above is the model's, written from these):",
      "retrieval r1 · mode: fused-order · 1 passage",
      "(reranking failed; results in fused order)",
      '[P1] 0.76 rerank · vector#2 keyword#5 · news · author: other · "Doc" · 2026-09-29 (doc d1, chunk c1)',
      "[F1] visa_status: F-1 OPT (unverified · from note d9)",
      "brain explain r1 replays how these passages were ranked.",
    ]);
  });
});

```

- [ ] **Step 2: Write the failing integration assertion**

In `test/integration/ask.test.ts`, replace:
```ts
    expect(call.user).toContain("[F1] visa_status: F-1 OPT");
```
with:
```ts
    expect(call.user).toContain("[F1] visa_status: F-1 OPT");
    expect(call.user).toContain("Search mode: hybrid");
    expect(call.user).toMatch(/\[P1\] \d\.\d\d rerank · [^\n]*· author: owner · /);
    expect(result.retrievalId).toMatch(/^[0-9a-f-]{36}$/);
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/ask.test.ts test/unit/render.test.ts`
Expected: FAIL: the prompt starts with `Question: Why?` then `Facts about the owner:` (no `Search mode:` line), passages read `[P1] (news: Doc)`, `ASK_SYSTEM` lacks the weighing sentence; `renderSources is not a function`.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/ask.test.ts`
Expected: FAIL: the prompt does not contain `Search mode: hybrid`.

- [ ] **Step 4: Rewrite `src/retrieve/ask.ts`**

```ts
import type { Ctx } from "../ctx.js";
import { search, type SearchOptions, type SearchResult } from "./search.js";
import { degradedNote } from "./contract.js";
import { factLine, foundBy, scoreText } from "../mcp/render.js";

export const ASK_SYSTEM =
  "You answer questions for the owner of a personal knowledge base using only the passages and facts provided. Cite passages as [P1], [P2] and facts as [F1], [F2] right after the claim they support. If the material does not contain the answer, say so plainly. Never state anything the material does not support. " +
  "Each passage shows its score and who wrote it: a rerank score runs from 0 to 1 and higher is stronger; rrf or - means the passage was not reranked. A passage whose author is not the owner says what someone else wrote, not what is true of the owner. When the search mode is not hybrid, or every score is low, say the evidence is weak.";

/** The prompt: the question, how the search ran, then facts and passages with their provenance. */
export function buildAskPrompt(question: string, result: SearchResult): string {
  const note = degradedNote(result.degraded);
  const header = [
    `Search mode: ${result.mode}${note ? ` (${note})` : ""}`,
    ...(result.fallbackUsed ? ["Weak match: some passages are literal substring hits (fallback), not ranked passages."] : []),
  ].join("\n");
  const passages = result.passages
    .map((p, i) => `[P${i + 1}] ${scoreText(p)} · ${foundBy(p)} · author: ${p.author} · ${p.sourceKind}${p.title ? ": " + p.title : ""}\n${p.content}`)
    .join("\n\n");
  const facts = result.facts.map((f, i) => factLine(f, i)).join("\n");
  return `Question: ${question}\n\n${header}\n\nFacts about the owner:\n${facts || "(none)"}\n\nPassages:\n${passages || "(none)"}`;
}

export async function ask(ctx: Ctx, question: string, opts: SearchOptions = {}): Promise<{ answer: string; result: SearchResult }> {
  const result = await search(ctx, question, { ...opts, client: opts.client ?? "ask" });
  const answer = await ctx.llm.text({ system: ASK_SYSTEM, user: buildAskPrompt(question, result) });
  return { answer, result };
}
```

`ask.ts` imports the three line formatters from `src/mcp/render.ts` so the prompt and `brain_search` cannot drift apart. There is no cycle: `render.ts` imports only types and `contract.ts` from `retrieve/`.

- [ ] **Step 5: `renderSources` and the CLI**

In `src/mcp/render.ts`, add before `const yesNo = …` (after `renderSearch`). Before:
```ts
const yesNo = (b: boolean) => (b ? "yes" : "no");
```
add:
```ts
/** Printed under a `brain ask` answer: what it could cite, with the same provenance lines as brain_search. */
export function renderSources(r: SearchResult): string {
  const note = degradedNote(r.degraded);
  return [
    "Sources from the knowledge base (the answer above is the model's, written from these):",
    searchHeader(r),
    ...(note ? [`(${note})`] : []),
    ...r.passages.map((p, i) => passageLine(p, i)),
    ...r.facts.map((f, i) => factLine(f, i)),
    `brain explain ${r.retrievalId} replays how these passages were ranked.`,
  ].join("\n");
}

```

In `src/cli.ts`, replace:
```ts
import { renderSearch, renderExplain } from "./mcp/render.js";
```
with:
```ts
import { renderSearch, renderExplain, renderSources } from "./mcp/render.js";
```

and in the `ask` action replace:
```ts
      result.passages.forEach((p, i) => console.log(`[P${i + 1}] ${p.sourceKind}${p.title ? " · " + p.title : ""} (${p.documentId})`));
      result.facts.forEach((f, i) => console.log(`[F${i + 1}] ${f.predicate}: ${f.objectText}`));
```
with:
```ts
      console.log(renderSources(result));
```

In `README.md`, in "Reading a search result", replace:
```markdown
the server instructions ask clients to make that split clear.
```
with:
```markdown
the server instructions ask clients to make that split clear. `brain ask` gives its model the same mode, scores and authors, and prints its sources under the answer.
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/unit/ask.test.ts test/unit/render.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/ask.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. (`brain ask` is not run against a real model here: it would spend a Claude Code call; the prompt is covered by the unit test byte for byte.)

- [ ] **Step 8: Commit**

```bash
git add src/retrieve/ask.ts src/mcp/render.ts src/cli.ts README.md test/unit/ask.test.ts test/unit/render.test.ts test/integration/ask.test.ts
git commit -m "ask: prompt states the search mode, degraded and fallback notes, and each passage's score, ranks and author; CLI prints its sources with provenance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The eval reads the search's own timings

**Files:**
- Modify: `src/eval/metrics.ts` (`QuestionResult.timings`, `Report.stageLatencyMs` optional, `Percentiles`, `StageLatency`)
- Modify: `src/eval/baseline.ts` (`ReportSchema.stageLatencyMs` optional)
- Modify: `src/eval/run.ts` (`toQuestionResult` reads `res.timings`; `timedSearch` removed; `stageLatencyLine`)
- Modify: `src/cli.ts` (prints the stages line)
- Modify: `README.md`
- Modify: `test/unit/eval.test.ts`
- Modify: `test/unit/metrics.test.ts`
- Modify: `test/unit/baseline.test.ts`

`toQuestionResult` takes `totalMs` from `res.timings.totalMs` instead of a wall-clock measurement around the call (which also counted the log insert and the event loop), keeps the stage timings, and loses its `totalMs` parameter. `summarize` adds `stageLatencyMs`: nearest-rank p50 and p95 of `embedMs`, `sqlMs`, `rerankMs` and `graphMs` over the main questions (the same population as `latencyMs`). `Report.stageLatencyMs` and its schema key are optional, so the committed `eval/baseline.json` (recorded before Phase 4) still loads, and a baseline recorded after this task carries the stages. `degraded` was already switched to the structured flags in Task 3 (`isDegraded`).

- [ ] **Step 1: Write the failing unit tests**

Replace `test/unit/eval.test.ts` with:
```ts
import { describe, it, expect } from "vitest";
import { kindFromFilename, toQuestionResult, firstExpectedRank, normalizeWhitespace, missingQuoteWarning, evalVoyageLine, stageLatencyLine } from "../../src/eval/run.js";
import { summarize } from "../../src/eval/metrics.js";
import type { GoldenItem } from "../../src/eval/golden.js";
import type { Layer, SearchResult } from "../../src/retrieve/contract.js";
import { passage, searchResult as baseResult } from "./search-fixture.js";

const item: GoldenItem = {
  id: "q05", question: "Why?", kind: "semantic", negative: false, source: "fixture", approved_at: "2026-09-30",
  expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot satisfy all three" }],
};

type P = { documentId: string; layers: Layer[]; content: string; score: number; chunkId?: string | null };

function searchResult(passages: P[], degraded = false, totalMs = 7): SearchResult {
  return baseResult({
    timings: { embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0.5, totalMs },
    query: "Why?",
    passages: passages.map((p, i) => passage({ chunkId: p.chunkId === undefined ? `c${i}` : p.chunkId, documentId: p.documentId, content: p.content, score: p.score, layers: p.layers })),
    topScore: passages[0]?.score ?? null,
    mode: degraded ? "keyword-only" : "hybrid",
    degraded: { embedding: degraded, rerank: degraded, capReached: false },
  });
}

describe("toQuestionResult", () => {
  it("records ranked documents with origins, quote hits, top score and graph presence", () => {
    const res = searchResult([
      { documentId: "d1", layers: ["vector"], content: "Demographic parity asks that positive rates match.", score: 0.4 },
      { documentId: "d2", layers: ["vector"], content: "shows you cannot satisfy all three when base rates differ", score: 0.3 },
      { documentId: "d3", layers: ["graph"], content: "x", score: 0 },
    ], false, 42);
    const origins = new Map([["d1", "/c/other.md"], ["d2", "/c/note--fairness-in-ml.md"], ["d3", null]]);
    const q = toQuestionResult(item, res, origins, [], 2, [true]);
    expect(q.ranked.map((d) => d.documentId)).toEqual(["d1", "d2", "d3"]);
    expect(q.ranked.map((d) => d.containsQuote)).toEqual([false, true, false]);
    expect(q.topScore).toBe(0.4);
    expect(q.hasGraphPassage).toBe(true);
    expect(q.totalMs).toBe(42);
    expect(q.timings).toEqual(res.timings);
    expect(q.totalRelevant).toBe(2);
    expect(q.paraphraseDegraded).toEqual([true]);
    expect(firstExpectedRank(q)).toBe(2);
  });
  it("a passage counts as containing the quote only when it belongs to an expected document", () => {
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "you cannot satisfy all three", score: 0.4 }]);
    const q = toQuestionResult(item, res, new Map([["d1", "/c/other.md"]]), [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(false);
  });
  it("matches quotes with whitespace runs collapsed on both sides", () => {
    const spaced: GoldenItem = { ...item, expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot  satisfy\nall three" }] };
    const res = searchResult([{ documentId: "d2", layers: ["vector"], content: "you cannot\n\tsatisfy all   three here", score: 0.4 }]);
    const q = toQuestionResult(spaced, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(true);
  });
  it("a fallback window (no chunk) is never a relevant passage, since totalRelevant counts chunks", () => {
    const res = searchResult([{ documentId: "d2", layers: ["fallback"], content: "you cannot satisfy all three", score: 0, chunkId: null }]);
    const q = toQuestionResult(item, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(false);
  });
  it("takes the latency from the search's own timings, not wall-clock around the call", () => {
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "x", score: 0.9 }], false, 123.4);
    const q = toQuestionResult(item, res, new Map([["d1", "/c/z.md"]]), [], 0, []);
    expect(q.totalMs).toBe(123.4);
    expect(q.timings).toEqual({ embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0.5, totalMs: 123.4 });
  });
  it("records degraded from the structured flags", () => {
    const q = toQuestionResult(item, searchResult([], true), new Map(), [], 0, []);
    expect(q.degraded).toBe(true);
    expect(q.topScore).toBeNull();
  });
  it("rank is null on a miss", () => {
    const q = toQuestionResult(item, searchResult([{ documentId: "d9", layers: ["vector"], content: "x", score: 0.9 }]), new Map([["d9", "/c/z.md"]]), [], 0, []);
    expect(firstExpectedRank(q)).toBeNull();
  });
  it("reads the source kind from the file name prefix", () => {
    expect(kindFromFilename("news--acme-series-b.md")).toBe("news");
    expect(kindFromFilename("plain.md")).toBe("note");
  });
});

describe("normalizeWhitespace", () => {
  it("collapses ASCII whitespace runs only, matching the SQL class, so an NBSP is kept", () => {
    expect(normalizeWhitespace("a \t\r\n\f\vb")).toBe("a b");
    expect(normalizeWhitespace("a\u00a0b")).toBe("a\u00a0b");
    expect(normalizeWhitespace("a \u00a0 b")).toBe("a \u00a0 b");
  });
  it("an NBSP in a quote does not match a plain space in a passage", () => {
    const nbsp: GoldenItem = { ...item, expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot\u00a0satisfy" }] };
    const res = searchResult([{ documentId: "d2", layers: ["vector"], content: "you cannot satisfy all three", score: 0.4 }]);
    expect(toQuestionResult(nbsp, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), [], 1, []).ranked[0].containsQuote).toBe(false);
  });
});

describe("missingQuoteWarning", () => {
  it("warns when an item has quotes but no passage of its expected documents contains one", () => {
    expect(missingQuoteWarning(item, 0)).toBe("eval: q05 quote not found in any passage of its expected documents");
    expect(missingQuoteWarning(item, 2)).toBeNull();
    expect(missingQuoteWarning({ ...item, expected: [{ origin: "a.md" }] }, 0)).toBeNull();
  });
});

describe("stageLatencyLine", () => {
  it("prints p50 and p95 per stage, and nothing for a report from before Phase 4", () => {
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "x", score: 0.9 }]);
    const report = summarize([toQuestionResult(item, res, new Map(), [], 0, [])], 0.3);
    expect(stageLatencyLine(report)).toBe("stages  embed p50=1ms p95=1ms  sql p50=2ms p95=2ms  rerank p50=3ms p95=3ms  graph p50=0.5ms p95=0.5ms");
    const { stageLatencyMs: _drop, ...old } = report;
    expect(stageLatencyLine(old)).toBeNull();
  });
});

describe("evalVoyageLine", () => {
  it("prints the run's Voyage spend, and warns when the cap refused calls", () => {
    expect(evalVoyageLine({ requests: 30, tokens: 41_200, refused: 0 })).toBe("voyage  tokens=41200 requests=30 refused=0");
    expect(evalVoyageLine({ requests: 3, tokens: 90, refused: 2 })).toBe(
      "voyage  tokens=90 requests=3 refused=2  (brain_eval's daily cap refused calls; those searches ran degraded)",
    );
  });
});
```

In `test/unit/metrics.test.ts`, in `result`, replace:
```ts
    degraded: false, totalMs: 10, paraphraseRanked: [], paraphraseDegraded: [], ...partial,
```
with:
```ts
    degraded: false, totalMs: 10, timings: { embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0, totalMs: 10 },
    paraphraseRanked: [], paraphraseDegraded: [], ...partial,
```

Add inside `describe("summarize", …)`, before `"counts paraphrase searches in the degraded fraction"`. Before:
```ts
  it("counts paraphrase searches in the degraded fraction", () => {
```
add:
```ts
  it("reports p50 and p95 per search stage", () => {
    const t = (embedMs: number, sqlMs: number, rerankMs: number, graphMs: number) => ({ embedMs, sqlMs, rerankMs, graphMs, totalMs: embedMs + sqlMs + rerankMs + graphMs });
    const r = summarize([
      result({ id: "1", timings: t(100, 10, 200, 1) }),
      result({ id: "2", timings: t(120, 30, 250, 2) }),
      result({ id: "3", timings: t(400, 20, 220, 0) }),
    ], 0.3);
    expect(r.stageLatencyMs).toEqual({
      embed: { p50: 120, p95: 400 },
      sql: { p50: 20, p95: 30 },
      rerank: { p50: 220, p95: 250 },
      graph: { p50: 1, p95: 2 },
    });
  });
```

In `test/unit/baseline.test.ts`, inside `describe("loadBaseline", …)`, after the round-trip test:
```ts
    expect(await loadBaseline(join(dir, "missing.json"))).toBeNull();
  });
```
add:
```ts
  it("loads a baseline with per-stage latency, and one recorded before Phase 4 without it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseline-"));
    const p50p95 = { p50: 1, p95: 2 };
    const withStages: Baseline = { ...base, report: report({}, { stageLatencyMs: { embed: p50p95, sql: p50p95, rerank: p50p95, graph: p50p95 } }) };
    await saveBaseline(join(dir, "b.json"), withStages);
    expect(await loadBaseline(join(dir, "b.json"))).toEqual(withStages);
    const committed = await loadBaseline("eval/baseline.json");
    expect(committed).not.toBeNull();
    expect(committed!.report.stageLatencyMs).toBeUndefined();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/eval.test.ts test/unit/metrics.test.ts test/unit/baseline.test.ts`
Expected: FAIL: `stageLatencyLine is not a function`; `toQuestionResult` still reads its fourth argument as `totalMs`, so `q.totalMs` is an array and `q.timings` is undefined; `r.stageLatencyMs` is undefined; the loaded baseline drops the unknown `stageLatencyMs` key. `npm run typecheck` also fails (six arguments where seven are declared).

- [ ] **Step 3: Stage percentiles in `src/eval/metrics.ts`**

In `src/eval/metrics.ts`, after:
```ts
import type { Expected, GoldenKind } from "./golden.js";
```
add:
```ts
import type { Timings } from "../retrieve/contract.js";
```

in `QuestionResult` replace:
```ts
  degraded: boolean;
  totalMs: number;
  paraphraseRanked: RankedDoc[][];
```
with:
```ts
  degraded: boolean;
  /** The search's own total (timings.totalMs), not wall-clock around the call. */
  totalMs: number;
  /** The search's stage timings. */
  timings: Timings;
  paraphraseRanked: RankedDoc[][];
```

in `Report` replace:
```ts
  degradedFraction: number;
  latencyMs: { p50: number; p95: number };
}
```
with:
```ts
  degradedFraction: number;
  latencyMs: Percentiles;
  /** p50/p95 of each search stage over the main questions. Optional: baselines recorded before Phase 4 have none. */
  stageLatencyMs?: StageLatency;
}

export interface Percentiles {
  p50: number;
  p95: number;
}

export interface StageLatency {
  embed: Percentiles;
  sql: Percentiles;
  rerank: Percentiles;
  graph: Percentiles;
}
```

in `summarize`, after:
```ts
  const latencies = results.map((r) => r.totalMs);
```
add:
```ts
  const stage = (pick: (t: Timings) => number): Percentiles => {
    const xs = results.map((r) => pick(r.timings));
    return { p50: percentile(xs, 50), p95: percentile(xs, 95) };
  };
```

and replace:
```ts
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  };
```
with:
```ts
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    stageLatencyMs: { embed: stage((t) => t.embedMs), sql: stage((t) => t.sqlMs), rerank: stage((t) => t.rerankMs), graph: stage((t) => t.graphMs) },
  };
```

- [ ] **Step 4: Accept them in old and new baselines (`src/eval/baseline.ts`)**

In `src/eval/baseline.ts`, replace:
```ts
const ReportSchema = z.object({
  n: z.number(),
```
with:
```ts
const PercentilesSchema = z.object({ p50: z.number(), p95: z.number() });

const ReportSchema = z.object({
  n: z.number(),
```

and:
```ts
  latencyMs: z.object({ p50: z.number(), p95: z.number() }),
});
```
with:
```ts
  latencyMs: PercentilesSchema,
  // Added in Phase 4; baselines recorded before it have none and still load.
  stageLatencyMs: z.object({ embed: PercentilesSchema, sql: PercentilesSchema, rerank: PercentilesSchema, graph: PercentilesSchema }).optional(),
});
```

- [ ] **Step 5: Read `res.timings` in `src/eval/run.ts`**

In `src/eval/run.ts`, add before `firstExpectedRank`. Before:
```ts
/** 1-based rank of the first expected document among distinct ranked documents, or null. */
```
add:
```ts
/** The eval output line for per-stage latency, or null for a report recorded before Phase 4. */
export function stageLatencyLine(report: Report): string | null {
  const s = report.stageLatencyMs;
  if (!s) return null;
  const part = (name: string, p: { p50: number; p95: number }) => `${name} p50=${p.p50}ms p95=${p.p95}ms`;
  return `stages  ${part("embed", s.embed)}  ${part("sql", s.sql)}  ${part("rerank", s.rerank)}  ${part("graph", s.graph)}`;
}

```

In `toQuestionResult`, drop the `totalMs` parameter:
```ts
  originById: Map<string, string | null>,
  totalMs: number,
  paraphraseRanked: RankedDoc[][],
```
with:
```ts
  originById: Map<string, string | null>,
  paraphraseRanked: RankedDoc[][],
```

and read the search's own timings:
```ts
    degraded: isDegraded(res.degraded),
    totalMs,
```
with:
```ts
    degraded: isDegraded(res.degraded),
    totalMs: res.timings.totalMs,
    timings: res.timings,
```

Delete `timedSearch` (nothing else uses it):
```ts
async function timedSearch(ctx: Ctx, question: string, opts: SearchOptions): Promise<{ res: SearchResult; ms: number }> {
  const t0 = Date.now();
  const res = await search(ctx, question, opts);
  return { res, ms: Date.now() - t0 };
}

```

and in `runEval` replace:
```ts
    const main = await timedSearch(ctx, g.question, opts);
    const paras: SearchResult[] = [];
    for (const p of g.paraphrases ?? []) paras.push((await timedSearch(ctx, p, opts)).res);
    const origins = await originsFor(ctx, [main.res, ...paras]);
```
with:
```ts
    const main = await search(ctx, g.question, opts);
    const paras: SearchResult[] = [];
    for (const p of g.paraphrases ?? []) paras.push(await search(ctx, p, opts));
    const origins = await originsFor(ctx, [main, ...paras]);
```

and:
```ts
    results.push(toQuestionResult(g, main.res, origins, main.ms, paraphraseRanked, totalRelevant, paras.map((r) => isDegraded(r.degraded))));
```
with:
```ts
    results.push(toQuestionResult(g, main, origins, paraphraseRanked, totalRelevant, paras.map((r) => isDegraded(r.degraded))));
```

- [ ] **Step 6: Print the stages**

In `src/cli.ts`, in `eval run`, replace:
```ts
    const { runEval, attributionGate, evalVoyageLine } = await import("./eval/run.js");
```
with:
```ts
    const { runEval, attributionGate, evalVoyageLine, stageLatencyLine } = await import("./eval/run.js");
```

and after:
```ts
        console.log(`degraded=${(run.report.degradedFraction * 100).toFixed(0)}%  latency p50=${run.report.latencyMs.p50}ms p95=${run.report.latencyMs.p95}ms`);
```
add:
```ts
        const stages = stageLatencyLine(run.report);
        if (stages) console.log(stages);
```

In `README.md`, in the Tests section, replace:
```markdown
paraphrase consistency, abstention and false-answer rate on negatives, degraded fraction, nearest-rank latency.
```
with:
```markdown
paraphrase consistency, abstention and false-answer rate on negatives, degraded fraction, nearest-rank latency from each search's own `timings.totalMs`, and p50/p95 per stage (embed, sql, rerank, graph; recorded in baselines from Phase 4 on).
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/eval.test.ts test/unit/metrics.test.ts test/unit/baseline.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green (`test/integration/eval-*.test.ts` call `countRelevantPassages` and `attributionLeaks`, not `toQuestionResult`).

- [ ] **Step 9: Eval**

Run: `npm run eval:run`
Expected: the same ranks as `eval/baseline.json`, `degraded=0%`, no regressions, and a new line after the latency line:
```
stages  embed p50=…ms p95=…ms  sql p50=…ms p95=…ms  rerank p50=…ms p95=…ms  graph p50=…ms p95=…ms
```
with embed and rerank (Voyage round trips) well above sql and graph. Do not run `--accept`: nothing ranks differently, and the committed baseline is the Phase 0 reference. (A later deliberate `--accept` records `stageLatencyMs` in it.)

- [ ] **Step 10: Commit**

```bash
git add src/eval/metrics.ts src/eval/baseline.ts src/eval/run.ts src/cli.ts README.md test/unit/eval.test.ts test/unit/metrics.test.ts test/unit/baseline.test.ts
git commit -m "Eval reads each search's own timings; p50/p95 per stage (embed, sql, rerank, graph), optional in the baseline schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Turn the contract on in the real knowledge base (run by the controller, not a subagent)

**Files:** none changed in the repo. Output goes into the PR description.

This is the only step that touches the `postgres` database. Run each command yourself and read its output before the next. Never use `supabase migration up`. Stop and ask the owner if anything below does not match what is expected.

Order matters: the new `search()` writes the v2 columns, so until migration 011 is applied, every search from new code fails with `column "results" of relation "retrieval_log" does not exist`. Old processes keep working after the migration (their insert names only v1 columns), but they log v1 rows and print the old text until restarted. Apply first, then restart, then verify.

- [ ] **Step 1: Back up the brain schema**

Run:
```bash
ts=$(date +%Y%m%d-%H%M%S)
docker exec supabase_db_brain pg_dump -U postgres -d postgres -n brain -Fc > ~/brain-pre-011-$ts.dump
ls -l ~/brain-pre-011-$ts.dump
docker exec -i supabase_db_brain pg_restore --list < ~/brain-pre-011-$ts.dump | grep -c "TABLE DATA brain"
```
Expected: a dump file of non-trivial size; the table-data count is 14 (the `brain` tables after Phase 3; 011 adds none). Note the file name for the PR.

- [ ] **Step 2: Apply migration 011**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20261002000011_retrieval_log_v2.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select count(*) filter (where column_name in ('results','degraded','candidates','timings','k','mode')) as v2_columns,
       (select count(*) from pg_indexes where schemaname = 'brain' and indexname = 'retrieval_log_created_at') as created_at_index,
       (select count(*) from brain.retrieval_log) as rows_before,
       (select count(*) from brain.retrieval_log where results is not null) as v2_rows
from information_schema.columns where table_schema = 'brain' and table_name = 'retrieval_log'"
```
Expected: `BEGIN`, `ALTER TABLE`, `DO`, `CREATE INDEX`, five `COMMENT`, `COMMIT`; then `6 | 1 | <n> | 0` (every existing row is a v1 row).

- [ ] **Step 3: Restart every running brain process**

Run:
```bash
pgrep -fl "src/mcp/(stdio|http-main)\.ts|src/cli\.ts" || echo "no brain processes running"
```
For each listed process: an MCP HTTP server (`npm run mcp:http`) is restarted; an MCP stdio server belongs to a Claude Code session and is restarted by restarting that session (or by `/mcp` reconnect). A long-running CLI command (`project-obsidian --watch`, `backfill`) is stopped and started again. Re-run the `pgrep` and confirm every remaining process started after Step 2 (`ps -o lstart= -p <pid>`).

- [ ] **Step 4: One search on the real knowledge base, and its log row**

Run:
```bash
npm run brain -- search "what am I working on" -k 3
```
Expected: the first line is `retrieval <uuid> · mode: hybrid · <n> passages` (3 hybrid passages plus any graph or fallback ones), then provenance lines such as `[P1] 0.6x rerank · vector#… keyword#… · note · author: owner · "…" · 2026-… (doc …, chunk …)` each followed by one line of text, then entity and fact lines (`[F1] … (verified · stated by owner)` or `(unverified · from <kind> <doc id>)`), and last `brain explain <uuid> replays how these passages were ranked.` If the mode is not `hybrid`, read the degraded note on the second line: `Voyage daily cap reached` means the real cap was hit (`npm run brain -- usage`), anything else is a Voyage outage; show the owner before going on.

Then, with that id:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select client, k, mode, jsonb_array_length(results) as passages, degraded, candidates, timings, top_score, used_fallback
from brain.retrieval_log where id = '<uuid>'"
```
Expected: `cli | 3 | hybrid | <n> | {"rerank": false, "embedding": false, "capReached": false} | {"fused": …, "vector": 60, "keyword": …} | {…, "totalMs": …} | <0..1> | f`.

- [ ] **Step 5: `brain explain` on that search, on an old row, and on an unknown id**

Run:
```bash
npm run brain -- explain <uuid>
old=$(psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -Atc "select id from brain.retrieval_log where results is null order by created_at desc limit 1")
npm run brain -- explain "$old"
npm run brain -- explain 00000000-0000-0000-0000-000000000000; echo "exit $?"
```
Expected: the first replays Step 4: `retrieval <uuid> · logged … · client cli`, `query: "what am I working on"`, `filters: none`, `mode: hybrid · k 3`, the degraded line (all `no`), candidates and timings matching the psql row, `top rerank score: …`, and one `#n [Pn] score … (rerank|none) · layers … · vector … · keyword … · rerank … · "<title>" · author: … · <kind> (doc …, …)` line per passage, in the same order and with the same scores as the search output. The second prints the old row's query and `logged before evidence v2: …` with its layers, top score, chunk ids and entities (skip it if Step 2 showed no rows before). The third prints `No logged search has retrieval id "00000000-0000-0000-0000-000000000000". …` and `exit 1`.

- [ ] **Step 6: The MCP tools from a restarted session**

From a Claude Code session restarted in Step 3:
1. Call `brain_orient`. Expected: the usual counts and the `Voyage today:` line; the guidance line now mentions `brain_explain`.
2. Call `brain_search` with a question about the owner. Expected: the text starts with `retrieval <uuid> · mode: hybrid · …`, passages carry `score kind`, ranks, `author:` and `(doc …, chunk …)`; the client shows no output-schema error (it validates `structuredContent` against the advertised schema).
3. Call `brain_explain` with that id. Expected: the replay as in Step 5.
4. If an HTTP server runs with `BRAIN_MCP_READONLY=1`, list its tools. Expected: seven, including `brain_explain`.

Check the log of those calls:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select created_at, client, tool, ok from brain.tool_calls order by created_at desc limit 5"
```
Expected: `brain_orient`, `brain_search`, `brain_explain` rows with `ok = t` and the session's client label.

- [ ] **Step 7: PR description**

Paste into the PR: the backup file name, the Step 2 counts, the Step 4 search output and log row, the Step 5 explain output (the v2 replay, the old-row explanation and the unknown-id message), and the tool calls from Step 6.

---

## Self-review notes

- Spec §6.1 (structured result): Task 1 (schemas and types), Task 3 (`search()` fills every field: per-passage provenance, `retrievalId`, `k`, `mode`, `degraded`, `fallbackUsed`, `entities[].matchedSpan`, facts with `verifiedBy`/`sourceChunkId`/`sourceDocumentId`/`sourceKind`/`confidence`/`verified`, `candidates`, `timings` with the extra `graphMs`).
- Spec §6.2 (log): Task 2 (columns, checks, index), Task 3 (written on every search, id returned). `layers`, `top_score`, `used_fallback`, `chunk_ids`, `node_ids` are still written.
- Spec §6.3 (rendering): Task 4 (header, passage lines, graph and fallback forms, facts, `structuredContent`, description, instructions), Task 5 (the `brain_explain` mentions), Task 4 Step 6 (CLI `search`, decision 3b).
- Spec §6.4 (`brain_explain`): Task 5, read-only, with old-row and unknown-id handling.
- Decision 5 (`ask`): Task 6. Decision 6 (eval): Task 3 (`isDegraded`) and Task 7 (timings, stage percentiles, optional schema key). Decision 7 (sweep): the list under the file structure; every file is touched in Task 3, and `grep` confirms it. Decision 8: Task 8.
- The owner's three requirements: see "How the plan answers the owner" in the header; the README section in Task 5 is written for a professional reader.

Every code block in this plan was run before it was written down: each task's state was built in a scratch copy of the repository, and `npm run typecheck`, the unit suite and the integration suite (on a separate scratch database, never `brain_test`, `brain_eval` or `postgres`) were green at every task boundary. Every "Replace … with …" block was applied mechanically to the files as they are on `422d151` and compared with the tested state.

Places where the real code forced a decision that differs from, or adds to, the brief:
- **`structuredContent` includes passage `content`** (the roadmap's test said "the result minus `content`"). A client may read `structuredContent` instead of the text; without the text it would have ids but no evidence. The log, which has no such reader, stores the contract without `content`.
- **The header prints the contract's mode value** (`mode: hybrid`, `keyword-only`, `fused-order`) rather than spec §6.3's prose variants (`mode: full`, `keyword-only (query embedding failed)`, …). The reason is on the next line, using Phase 3's four notes, so the four degraded combinations still render four different texts, and the header word is the same one `structuredContent`, the log and `brain_explain` use.
- **`degraded.rerank` is true whenever no rerank ran**, including when it was skipped after a failed embedding. With that rule, whenever `degraded.rerank` is true, `topScore` and every `rerankRank` are null, and `searchMode` needs only the two flags.
- **`score` is `number | null`** (null for graph and fallback passages). The old code used 0, which a consumer could read as a real score.
- **`occurredAt` is an ISO string**, not a `Date`, because the SDK validates `structuredContent` with the zod schema and the same JSON goes into the log.
- **`entities[].id`, not `nodeId`** (spec §6.1 says `nodeId`). `id` is what `EntityRef`, `brain_get_node` and the renderer already use; renaming it would touch `entities.ts` and its tests for no gain.
- **`charStart`/`charEnd` stay on passages** (not in the brief's list): fallback windows need them for provenance (`chars 10–30`) and the existing fallback tests read them. **`parentContent` is removed**: nothing read it, and `loadChunks` no longer joins the parent chunk.
- **`documents` (the summary layer) stays in the contract** unchanged; the brief's list did not mention it, and it is rendered as before (with `doc <id>`).
- **Fact provenance needs a join**: `brain.current_facts()` returns no `verified_by`, so `factsLayer` joins `brain.facts`, and `brain.chunks`/`brain.documents` for the source document. A third case beyond the brief: an extractor fact whose source chunk is gone renders `extracted; source passage no longer stored`, not "stated by owner". A fact with no source chunk and a null `verified_by` counts as the owner's, matching `brain.fact_owner_held`.
- **Timings**: entity detection runs in parallel with the candidate SQL, so it is counted in `sqlMs`; the facts query, the summary documents and the fallback scan are SQL too and are counted there; `graphMs` is the neighbour and mention queries. Stages are disjoint, so their sum is at most `totalMs` (the test allows 0.05 ms rounding per stage). `totalMs` stops before the log insert, because it is written by that insert.
- **`topScore` is the maximum rerank score**, not the first hybrid passage's. Voyage and the fake reranker return hits sorted, so the value is the same; the maximum states the intent.
- **`rerankRank` is the position in the reranker's output** (1-based), which is also the passage's position among hybrid passages.
- **`brain_explain` reads the row with `to_jsonb`**, so it works on rows logged before 011 and on a database without 011. A malformed id is reported like an unknown one, with a message that says where the id comes from.
- **`doc <id>` replaces `document <id>`** in the search text (the brief's line format), so the `brain_get_document` description and one `mcp-server` assertion change with it.
- **The server instructions gain a sentence in step 4**: "Make clear which parts of the answer come from the knowledge base and which are your own." It is the owner's requirement in the client's system prompt; Phase 5's `brain_verify` will check it mechanically.
- **`ask.ts` imports the line formatters from `mcp/render.ts`** so the prompt and `brain_search` share one wording. No import cycle.
- **CLI output is generated by `render.ts` functions** (`renderSearch(res, { brief: true })`, `renderSources`, `renderExplain`), which makes it unit-testable; `cli.ts` itself has no tests.
- **`QuestionResult` gains a required `timings`** (an internal type, not part of the baseline); `Report.stageLatencyMs` is optional in the type and the schema, so `eval/baseline.json` loads unchanged. The baseline is not re-accepted.
- **Two checks in the migration** (`retrieval_log_mode_check`, `retrieval_log_results_check`), added inside a `DO` block only when missing, so the file stays idempotent.
- **Read-only mode exposes seven tools** (`brain_explain` joins the six read tools).
- **Migration name** is `20261002000011_retrieval_log_v2.sql` as decided (the roadmap said `20260930000011`).
- **`search.ts` is split** into `search.ts` (orchestration, 245 lines) and `layers.ts` (per-layer SQL, 194 lines); see the header for the reasoning.

Types and names used across tasks: `SearchResultSchema`, `PassageSchema`, `LoggedPassageSchema`, `DegradedSchema`, `CandidatesSchema`, `TimingsSchema`, `SearchModeSchema` and the inferred types, `NOT_DEGRADED`, `isDegraded`, `searchMode`, `degradedNote`, `hybridLayers`, `isHybrid`, `toLoggedPassages`, `factSource` (T1) are used by `search.ts` (T3), `render.ts` (T3–T6), `server.ts` (T4), `explain.ts` (T5), `ask.ts` (T6), `eval/run.ts` and `eval/metrics.ts` (T3, T7). `test/unit/search-fixture.ts` (`passage`, `fact`, `searchResult`, T1) is used by the render, eval, contract and ask unit tests. `Filters`, `ChunkRow`, `candidateQueries`, `loadChunks`, `summaryDocuments`, `entityNeighbors`, `mentionedChunkIds`, `factsLayer`, `fallbackScan`, `fallbackWindow` (T3) are used only by `search.ts`. `scoreText`, `foundBy`, `passageLine`, `factLine`, `searchHeader` (T4) are used by `renderSources` and `ask.ts` (T6); `explainLine`, `renderExplain` (T5) by `server.ts` and `cli.ts`. `Explanation`, `explain`, `explainNotFound` (T5). `Percentiles`, `StageLatency`, `stageLatencyLine` (T7). Removed: `PassageGroup`, `DegradedReason`, `SearchResult.degradedReason`/`usedFallback`/`capReached` (now `degraded.capReached`), `Passage.group`/`documentTitle`/`parentContent`, `render.ts`'s `degradedNote`/`searchMode` (moved to `contract.ts` with new signatures), `eval/run.ts`'s `timedSearch`.

Known limits, not addressed here:
- A client that forwards both blocks sees each passage's text twice (once in the text, once in `structuredContent`).
- `results` records title and author as they were at search time. After `set-author` changes a document, `brain_explain` still shows the old author for earlier searches; that is the point of a replay, but it can surprise.
- Rows logged before 011 keep a `top_score` that may be an RRF value (degraded searches); `brain_explain` warns about it, and nothing else reads it yet.
- `retrieval_log` now stores a few kilobytes per search (`results`), with no retention policy. The `created_at` index makes a later cleanup by date cheap.
- Timings exclude the log insert and rendering; the MCP layer's own duration is in `brain.tool_calls.duration_ms`.
- The text and `structuredContent` say what was retrieved and how; they cannot show which parts of a client's answer came from the model. That needs the client's cooperation (the new instruction) and Phase 5's `brain_verify`.
