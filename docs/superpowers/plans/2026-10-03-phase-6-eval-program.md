# Phase 6: Eval Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The retrieval eval becomes a program the owner controls and a professional can audit. The fixture corpus grows from 9 to 25 fictional documents with planted traps (near-duplicate posts and codes, a moved interview date, an owner note that a later one supersedes), so the golden set can reach at least 60 items without the real knowledge base, which holds 2 documents. Golden questions are drafted by the model, one call per document, checked automatically, and approved only by the owner through a review sheet edited in a plain text editor or Obsidian; agents never approve. Real searches from the knowledge base's log can be labelled as golden items by the owner. `brain eval sync` copies the real base into its own eval database, `brain_real_eval`, with no model or Voyage call, so fixture evals and real-base evals both keep working. Every report shows how many items the owner approved and how many an agent wrote, and breaks the metrics down by source. The README gains one section, "How retrieval works and how to audit it", with a hand-written diagram. The cheap review follow-ups of Phases 2 and 4 are folded in.

**Architecture:** `src/eval/golden.ts` gains `approved_by` (owner or agent), `corpus` (fixtures or real), `edited` and `retrieval_id`, the rules a schema cannot express (`goldenItemProblems`), and file helpers (`appendGolden`, `goldenLine`, `loadGolden`). `src/eval/draft.ts` asks `ctx.llm.structured` for questions per document (`DraftOutputSchema`), runs the automatic checks (`draftProblems`: verbatim quote, question without its quote, no duplicate by normalised text or Postgres stem Jaccard ≥ 0.8, document present, valid golden item) and writes `eval/drafts.jsonl` and a review sheet. `src/eval/review.ts` renders, strictly parses and applies the sheet (`renderSheet`, `parseSheet`, `applySheet`, `approveSheetFile`). `src/eval/capture.ts` lists logged searches through a read-only connection and labels one (`capturedSearches`, `labelCaptured`). `scripts/sync-eval-db.sh` copies the real base inside the Supabase container with the server's own `pg_dump` and `psql`, in one transaction; `src/eval/sync.ts` checks both URLs first. `src/eval/metrics.ts` reports per source and per approver; `src/eval/run.ts` runs one corpus at a time. `src/cli.ts` adds `eval sync`, `draft`, `approve`, `reject`, `drafts`, `capture`, `label` and `eval run --corpus`. No migration: everything new lives in files or reads existing tables.

**Tech Stack:** Postgres 17.6 (local Supabase, port 55322, container `supabase_db_brain`), TypeScript ESM run with tsx, vitest, zod 4, postgres.js, commander, @modelcontextprotocol/sdk 1.31.

**Spec:** `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` §8. Task breakdown: the Phase 6 table and the review follow-ups in `docs/superpowers/plans/2026-09-30-retrieval-hardening-roadmap.md`. Already done in earlier phases and dropped here: the attribution metric and its gate (roadmap 5, `attributionLeaks` and `attributionGate` in `src/eval/run.ts`), Voyage tokens in the eval report (roadmap 6, `evalVoyageLine`), the verifier metric and its split gate (Phase 5). Numbering here: **Task 1** is the Phase 4 and Phase 2 follow-ups except the output size, **Task 2** the k=30 output size, **Task 3** golden schema v3, **Task 4** the per-source report and `eval run --corpus` (roadmap 6, what remains), **Task 5** `eval sync` (roadmap 1), **Task 6** drafting and the review sheet (roadmap 2 and 3, as library code), **Task 7** their commands, **Task 8** `capture` and `label` (roadmap 4), **Task 9** the fixture corpus, **Tasks 10 to 12** growing the set and the baseline (roadmap 7; controller only, with the owner), **Task 13** the README section and diagram (roadmap 8).
**Prerequisite:** Phase 5 merged (`ed1b118`). Work on branch `eval-program`.
**Working directory:** `/Users/frankfu/Documents/GitHub/brain`

Rules for every task:
- Integration tests run on `brain_test` only: `npm run test:int` recreates it from all migrations. Run one integration file with `bash scripts/prepare-test-db.sh && npx vitest run <file>`. **Only one agent runs `test:int` (or `prepare-test-db.sh`) at a time**: the script drops and recreates `brain_test`, which breaks any other run in progress. Unit tests: `npx vitest run <file>` or `npm run test:unit`; they make no network call and touch no database.
- The fixture eval runs on `brain_eval`; the real-base eval runs on `brain_real_eval`. CLI commands against either use `OBSIDIAN_AUTO=0`, so the Obsidian mirror is never touched.
- **Never write to the `postgres` database (the real knowledge base).** `eval sync` and `eval capture` only read it (a read-only snapshot and a read-only connection). Never use `supabase migration up`. This phase has no migration.
- `test/integration/eval-sync.test.ts` (Task 5) creates and drops its own database, `<test database>_sync_eval` (`brain_test_sync_eval`), through `scripts/prepare-eval-db.sh`. That script must read `EVAL_DB` before the test is ever run: an older copy ignores it and would reset `brain_eval`. The test refuses to start otherwise, and Task 5 changes the script before its first run.
- Agents never approve golden items: they never fill in a review sheet's `decision:` lines and never run `eval label`. The controller runs `eval approve` only on a sheet the owner has filled in and handed back. **Task 11 ends in a hard stop: the controller hands the review sheets to the owner and waits.**
- Commit per task. The last line of every commit message is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

How the plan answers the owner's decisions:
- **Corpus:** Task 9 adds 16 documents (job posts, owner notes, recruiter emails, a meeting transcript, a paper abstract, news, a course note, a cover letter, a project retro, a saved article by someone else, a conversation), each specified by a brief and pinned by `test/unit/corpus-fixtures.test.ts`, which lists every sentence a file must contain verbatim, its author and title, the people and companies shared across files, and what no file may say. The texts are written fresh at implementation time.
- **Approval:** drafts pass five automatic checks (Task 6), go to `eval/drafts.jsonl` and `eval/review/<date>-<n>.md`, and become golden items only through `eval approve --sheet` with the owner's `keep` or `edit` (Tasks 6 and 7); `reject` drops them, empty decisions stay pending, and the sheet is parsed strictly with line numbers. `approved_by` is required on every item; the existing 19 are `agent`.
- **Draft prompt:** 2 to 3 questions per document across keyword, semantic, graph, filter and (for documents the owner did not write) attribution, each with a verbatim quote and exactly two paraphrases, plus one negative question per call, through `ctx.llm.structured` with `DraftOutputSchema`. Idempotent: a document with a pending draft or a golden item is skipped unless `--force`, and a re-drafted question gets the same id and is dropped as a duplicate.
- **Captured questions:** `eval capture` and `eval label` (Task 8), refusing a document that is not in the eval database and saying to run `eval sync` first.
- **`eval sync`:** Task 5; the choice of `pg_dump | psql` inside the container over dblink is justified there. Synced data lives in `brain_real_eval` (`EVAL_REAL_DATABASE_URL`), items carry `corpus`, and `eval run --corpus real` runs only real items there.
- **Metrics:** unchanged definitions and gate; Task 4 adds the per-source breakdown and per-approver counts.
- **Baseline:** Task 12, after the owner's approvals, re-accepts `eval/baseline.json` (and records `eval/baseline-real.json` when real items exist).
- **README:** Task 13, one section plus `docs/retrieval.svg`, and the two stale README items from the roadmap (the eval paragraph quoting the first baseline's p50; the example block without passage bodies and the "Facts about the owner:" heading).
- **Follow-ups:** Task 1 (`explain` reads each evidence v2 column with `safeParse`; four decimals for a pre-v2 top score below 0.05; double quotes in titles; an unclosed front-matter fence throws), Task 2 (the k=30 output size, measured; `structuredContent` drops passage text), Task 9 (an older owner note states `lives_in` Austin, so the Denver note supersedes a real fact; misattribution and supersession golden items).

Decisions the real code forced or settled (details in the self-review notes):
- **The k=30 measurement exceeded the budget, and the text alone exceeds it too.** On a synthetic result of k=30 plus 25 graph passages at the 1,600-character passage cap, text plus full `structuredContent` is 234,728 bytes; without passage text in `structuredContent` it is 146,013 bytes, of which the text is 105,509. So `structuredContent` drops `content` (new `SearchOutputSchema`, `toSearchOutput`), as decided, and the README states that the extreme case still exceeds about 100 KB while the default k=10 stays under it (99,173 bytes at its worst). Lowering the k cap was not decided and is not done.
- **`sync` runs `pg_dump --data-only | psql` inside the `supabase_db_brain` container, not dblink.** Both databases are on the same server, so the container reaches them by name. Its `pg_dump` and `psql` are the server's own 17.6: the host's Homebrew tools are 17.5, and a 17.6 `pg_dump` writes `\restrict` lines that a 17.5 `psql` rejects, so mixing them breaks. dblink would need an extension and a migration on every eval database and a password in a connection string. The restore is one transaction (`begin`, `truncate` of the nine content tables plus `retrieval_log` and `verification_log`, the data, `commit`); a failed dump stops before `commit`, so the target keeps what it had. The `postgres` role is not a superuser here, so `--disable-triggers` is impossible; it is not needed, because each table is one `COPY` and foreign keys are checked at its end (chunks, nodes and facts reference themselves), and pg_dump orders the tables by their foreign keys. The registries (`node_types`, `edge_types`) come from the migrations on both sides and are not copied; they are identical today (7 and 11 rows).
- **The URL check is in TypeScript, the name check in the script.** The container addresses databases by name, so `syncPlan` refuses URLs that are not local or name different ports, and the script checks the container publishes that port (`SYNC_PORT`). The script itself refuses a target not ending in `_eval` and a source ending in `_eval`, so it is safe to run by hand.
- **`prepare-eval-db.sh` takes `EVAL_DB`.** `brain_real_eval` is created by the same script (`npm run eval:prepare-real`), and the sync test creates its throwaway database with it. The name must end in `_eval`.
- **Fixture items name documents by origin; real items by id.** `brain_eval` is rebuilt from `eval/corpus`, so its ids change; `eval sync` keeps the real base's ids. `goldenItemProblems` refuses a fixtures item with a `document_id`.
- **Rules a schema cannot express are checked on every item:** generated and captured items must be `approved_by: "owner"`; `edited` only on generated items; `retrieval_id` exactly on captured items; a filter item needs `filters.sourceKinds`.
- **Golden ids.** A draft's id is `d-` plus the first 10 hex digits of sha256 of its document key (fixture file name or document id) and its normalised question, so the same question drafted twice has the same id; the approved item keeps it. A captured item is `c-` plus the first 8 characters of its retrieval id.
- **Duplicate threshold.** Normalised text (lower case, every run of non-letters and non-digits as one space) equal, or Postgres english stem sets with Jaccard overlap ≥ `DUPLICATE_STEM_JACCARD` = 0.8. "Who led Acme's Series B?" and "Who led the Acme Series B round?" (4 of 5 stems) are duplicates; the same salary question about Acme and about Northwind (4 of 6) is not.
- **One negative per call.** Each document's call returns one negative question, so a full draft run yields about 25 negative drafts; the owner keeps the good ones (spec §8.3 asks for at least 10).
- **The sheet is applied atomically.** Any problem (an unknown id, a changed `document:` line, `keep` with changed fields, a negative turned positive or the reverse, a failed check) applies nothing and lists every problem. Re-applying the same sheet reports items as already applied. `edit` with no change is recorded as `edited: false`.
- **`approve` re-checks every kept and edited item** against its eval database (the document's text, found by id or, for a rebuilt `brain_eval`, by origin; stems for the duplicate check), so a quote that is no longer in a changed fixture cannot slip in. It opens a database only when the sheet keeps or edits something.
- **Captured searches are read through `connectReadOnly`** (`default_transaction_read_only`), so `capture` and `label` cannot write to the real base even by a bug; `label` writes only the golden file.
- **Agent-written fixture items for the planted traps.** Task 9 adds 7 items labelled `approved_by: "agent"` (two misattribution and supersession checks, the moved date, a near-duplicate code, two attribution items, one negative), so the spec's "at least 5 attribution" holds whatever the owner decides about drafts. They count as agent items in every report.
- **A full eval run now costs about 1.3 million Voyage tokens,** more than the eval's default daily cap of 1,000,000: every question and paraphrase reranks every candidate passage, and the corpus nearly quadruples. Task 12 asks the owner to raise `BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP` for the day (or run over two days); the plan never raises a cap itself.
- **`eval run --corpus real` needs `brain_real_eval`.** A missing eval database (SQLSTATE 3D000) gets the commands that create it (`evalDatabaseHint`).
- **The committed baseline test no longer reads `eval/baseline.json`'s shape.** `test/unit/baseline.test.ts` asserted that the committed baseline has no stage latencies; re-accepting it in Task 12 would break that, so Task 4 tests the old shape on a written copy instead.
- **Real-base items carry private quotes into git.** `eval/golden.jsonl` is committed; a `corpus: "real"` item quotes the owner's own documents. Task 11 tells the owner so before they decide.

---

## File structure

```
scripts/
  prepare-eval-db.sh                    MODIFY (T5): EVAL_DB names the database (default brain_eval; must end in _eval)
  sync-eval-db.sh                       NEW (T5): copy the knowledge base into a *_eval database in the container, one transaction
package.json                            MODIFY (T5): eval:prepare-real
src/
  retrieve/explain.ts                   MODIFY (T1): V1RowSchema, v2Field (safeParse per evidence v2 column), Explanation.notes
  mcp/render.ts                         MODIFY (T1): quotedTitle, legacyTopScoreText, notes in renderExplain
  retrieve/contract.ts                  MODIFY (T2): SearchOutputSchema, SearchOutput, toSearchOutput
  mcp/server.ts                         MODIFY (T2): brain_search returns structuredContent without passage text
  eval/golden.ts                        MODIFY (T3): GOLDEN_SOURCES, APPROVERS, CORPORA, approved_by, corpus, edited, retrieval_id,
                                        goldenItemProblems, validateGoldenItem, loadGolden, goldenLine, appendGolden, forCorpus,
                                        approvalCounts
  eval/metrics.ts                       MODIFY (T4): QuestionResult.source/approvedBy, Report.bySource/approvals
  eval/baseline.ts                      MODIFY (T4): optional bySource and approvals
  eval/run.ts                           MODIFY: splitFrontMatter throws on an unclosed fence (T1); breakdownLines, toQuestionResult
                                        source and approver, runEval(…, corpus) (T4)
  eval/db.ts                            MODIFY (T4): EVAL_REAL_DATABASE_URL, evalDatabaseUrl, evalDatabaseHint, makeEvalCtx(corpus)
  eval/sync.ts                          NEW (T5): syncPlan, runSync
  eval/draft.ts                         NEW (T6): DRAFT_KINDS, DraftOutputSchema, DraftSchema, DUPLICATE_STEM_JACCARD,
                                        MAX_DRAFT_CHARS, normalizeQuestion, draftId, docKey, stemJaccard, duplicateOf,
                                        quoteInDocument, questionContainsQuote, toGoldenItem, draftProblems, loadDrafts,
                                        saveDrafts, DRAFT_SYSTEM, draftUserMessage, corpusDocuments, nextSheetPath, draftDocuments
  eval/review.ts                        NEW (T6): DECISIONS, documentLine, renderSheet, parseSheet, applySheet, questionsToStem,
                                        approveSheetFile
  db.ts                                 MODIFY (T8): connectReadOnly
  eval/capture.ts                       NEW (T8): CAPTURE_PASSAGES, capturedSearches, renderCaptured, labelCaptured
  cli.ts                                MODIFY: eval run --corpus and the missing-database hint (T4), eval sync (T5), eval draft,
                                        approve, reject, drafts (T7), eval capture, label (T8)
eval/
  golden.jsonl                          MODIFY: approved_by on every item (T3); 7 agent items for the traps (T9); the owner's
                                        approved drafts (T12)
  corpus/*.md                           NEW (T9): 16 documents, written from the briefs in Task 9
  drafts.jsonl                          NEW (T11): pending drafts (written by eval draft)
  review/<date>-<n>.md                  NEW (T11): review sheets (the owner fills in decisions)
  baseline.json                         MODIFY (T12): re-accepted
  baseline-real.json                    NEW (T12): when real items exist
docs/retrieval.svg                      NEW (T13): the diagram
README.md                               MODIFY (T13): commands, tests paragraph, example block, structuredContent note, the section
test/
  unit/render.test.ts                   MODIFY (T1)
  integration/explain.test.ts           MODIFY (T1)
  unit/eval-attribution.test.ts         MODIFY (T1)
  unit/search-output-size.test.ts       NEW (T2)
  integration/mcp-server.test.ts        MODIFY (T2)
  unit/golden.test.ts                   REPLACE (T3)
  unit/golden-fixtures.test.ts          MODIFY (T3, T9, T12)
  unit/eval.test.ts                     MODIFY (T3, T4)
  unit/metrics.test.ts                  MODIFY (T4)
  unit/baseline.test.ts                 MODIFY (T4)
  unit/eval-db-guard.test.ts            MODIFY (T4)
  unit/eval-sync.test.ts                NEW (T5)
  integration/eval-sync.test.ts         NEW (T5)
  unit/eval-draft.test.ts               NEW (T6)
  unit/eval-review.test.ts              NEW (T6)
  integration/eval-draft.test.ts        NEW (T6)
  integration/eval-cli.test.ts          NEW (T7)
  integration/eval-capture.test.ts      NEW (T8)
  unit/corpus-fixtures.test.ts          NEW (T9)
```

`runEval` gains an optional fourth parameter and `makeEvalCtx` an optional one; their only callers are `src/cli.ts` (`grep -rn "runEval(\|makeEvalCtx(" src test`). `QuestionResult` gains two required fields; it is built only by `toQuestionResult` and by the `result()` helper in `test/unit/metrics.test.ts`, which Task 4 updates. `Explanation` gains `notes`; it is built only by `explain()` and by the fixture in `test/unit/render.test.ts`, which Task 1 updates. `SearchResultSchema` is unchanged; only `brain_search`'s output schema changes, and `test/integration/mcp-server.test.ts` is its only reader in the repo.

---

### Task 1: Review follow-ups: explain reads each column safely, legacy scores, quotes in titles, unclosed front matter

**Files:**
- Modify: `src/retrieve/explain.ts`
- Modify: `src/mcp/render.ts`
- Modify: `src/eval/run.ts`
- Modify: `test/unit/render.test.ts`
- Modify: `test/integration/explain.test.ts`
- Modify: `test/unit/eval-attribution.test.ts`

Four small fixes from the Phase 4 and Phase 2 reviews. `explain()` parsed the whole log row with one schema, so a future required field in the contract (say a new passage field) would make every older row unexplainable; it now reads the v1 columns strictly and each evidence v2 column on its own with `safeParse`, shows an unreadable column as not recorded and says why in `notes`. A pre-v2 top score below 0.05 is an RRF value and gets four decimals (0.0164, not 0.02). A title with double quotes rendered as `""I thought…"`; double quotes inside a title become single quotes. A fixture that opens a front-matter fence and never closes it was stored as body text under its kind's default author; `splitFrontMatter` now throws, and `ingestAll` reports it as `skip <origin>: front matter: …` and `eval ingest` exits 1. An empty block (`---` then `---`) is accepted.

- [ ] **Step 1: Write the failing tests**

In `test/unit/render.test.ts`, replace:
````ts
import {
  renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, passageLine, factLine, scoreText, foundBy, searchHeader,
  renderExplain, explainLine, renderSources, verdictLine, verdictDetail, renderVerification, VERIFY_LIMITS, renderAnswerCheck,
} from "../../src/mcp/render.js";
import type { ClaimResult } from "../../src/verify/verify.js";
import { toLoggedPassages } from "../../src/retrieve/contract.js";
````
with:
````ts
import {
  renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, passageLine, factLine, scoreText, foundBy, searchHeader,
  renderExplain, explainLine, renderSources, verdictLine, verdictDetail, renderVerification, VERIFY_LIMITS, renderAnswerCheck,
  quotedTitle, legacyTopScoreText,
} from "../../src/mcp/render.js";
import type { ClaimResult } from "../../src/verify/verify.js";
import { toLoggedPassages } from "../../src/retrieve/contract.js";
````

In `test/unit/render.test.ts`, replace:
````ts
    v2: true, k: 10, mode: "hybrid", degraded: { embedding: false, rerank: false, capReached: false },
    candidates: { vector: 60, keyword: 12, fused: 64 }, timings: { embedMs: 120.3, sqlMs: 45.1, rerankMs: 210, graphMs: 3.2, totalMs: 380.9 },
    results: toLoggedPassages(fixture.passages), layers: ["hybrid", "summary", "graph", "fallback"], chunkIds: ["c1", "c2", "c3"], nodeIds: ["n1"],
    topScore: 0.76, usedFallback: true,
  };

  it("replays a v2 row: who and when, filters, mode, flags, candidates, timings, and every passage's ranks and score", () => {
````
with:
````ts
    v2: true, k: 10, mode: "hybrid", degraded: { embedding: false, rerank: false, capReached: false },
    candidates: { vector: 60, keyword: 12, fused: 64 }, timings: { embedMs: 120.3, sqlMs: 45.1, rerankMs: 210, graphMs: 3.2, totalMs: 380.9 },
    results: toLoggedPassages(fixture.passages), layers: ["hybrid", "summary", "graph", "fallback"], chunkIds: ["c1", "c2", "c3"], nodeIds: ["n1"],
    topScore: 0.76, usedFallback: true, notes: [],
  };

  it("replays a v2 row: who and when, filters, mode, flags, candidates, timings, and every passage's ranks and score", () => {
````

In `test/unit/render.test.ts`, replace:
````ts
      "filters: none",
      "logged before evidence v2: only the chunk ids, the top score, the layers and the fallback flag were recorded.",
      "layers: hybrid, summary, degraded",
      "top score: 0.03 (before evidence v2 this is an RRF value when the search was degraded)",
      "fallback scan: not used",
      "chunks in rank order (fallback passages were not recorded): c1, c2",
      "entities: none",
````
with:
````ts
      "filters: none",
      "logged before evidence v2: only the chunk ids, the top score, the layers and the fallback flag were recorded.",
      "layers: hybrid, summary, degraded",
      "top score: 0.0310 (before evidence v2 this is an RRF value when the search was degraded)",
      "fallback scan: not used",
      "chunks in rank order (fallback passages were not recorded): c1, c2",
      "entities: none",
````

In `test/unit/render.test.ts`, replace:
````ts
  });
});

describe("other renderers", () => {
  it("renderStatus lists documents whose items about the owner were suppressed", () => {
    const pipeline = [{ stage: "done", count: 1, failed: 0 }];
````
with:
````ts
  });
});

describe("titles and legacy scores", () => {
  it("turns double quotes inside a title into single quotes, so the line has one pair", () => {
    expect(quotedTitle('"I thought it was fine" — a post')).toBe(`"'I thought it was fine' — a post"`);
    expect(quotedTitle("\u201cCurly\u201d title")).toBe(`"'Curly' title"`);
    expect(quotedTitle("Plain")).toBe('"Plain"');
    expect(quotedTitle(null)).toBe("(untitled)");
    const p = passage({ title: '"Quoted" title' });
    expect(passageLine(toLoggedPassages([p])[0], 0)).toContain(` · "'Quoted' title" · `);
    expect(explainLine(toLoggedPassages([p])[0], 0)).toContain(` · "'Quoted' title" · `);
  });

  it("shows a pre-v2 top score below 0.05 with four decimals, so an RRF value is not rounded to 0.02", () => {
    expect(legacyTopScoreText(0.0164)).toBe("0.0164");
    expect(legacyTopScoreText(0.0499)).toBe("0.0499");
    expect(legacyTopScoreText(0.05)).toBe("0.05");
    expect(legacyTopScoreText(0.731)).toBe("0.73");
    expect(legacyTopScoreText(null)).toBe("none");
  });

  it("prints notes about evidence v2 columns that could not be read under the filters line", () => {
    const e: Explanation = {
      retrievalId: "r1", query: "q", client: null, createdAt: "2026-10-02T09:15:00.000Z", filters: {}, v2: false, k: null, mode: null,
      degraded: null, candidates: null, timings: null, results: null, layers: [], chunkIds: [], nodeIds: [], topScore: 0.0164, usedFallback: false,
      notes: ["results could not be read with the current contract (0.newField: Invalid input); shown as not recorded"],
    };
    const lines = renderExplain(e).split("\n");
    expect(lines[3]).toBe("note: results could not be read with the current contract (0.newField: Invalid input); shown as not recorded");
    expect(lines).toContain("top score: 0.0164 (before evidence v2 this is an RRF value when the search was degraded)");
  });
});

describe("other renderers", () => {
  it("renderStatus lists documents whose items about the owner were suppressed", () => {
    const pipeline = [{ stage: "done", count: 1, failed: 0 }];
````

In `test/integration/explain.test.ts`, replace:
````ts
    expect(e.topScore).toBeCloseTo(0.031, 5);
    const text = renderExplain(e);
    expect(text).toContain("logged before evidence v2");
    expect(text).toContain("top score: 0.03");
  });
});
````
with:
````ts
    expect(e.topScore).toBeCloseTo(0.031, 5);
    const text = renderExplain(e);
    expect(text).toContain("logged before evidence v2");
    expect(text).toContain("top score: 0.0310");
    expect(e.notes).toEqual([]);
  });

  it("explains a row whose logged passages no longer fit the contract from its v1 columns, with a note", async () => {
    const [row] = await sql<{ id: string }[]>`
      insert into brain.retrieval_log (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client, results, k, mode)
      values ('future row', '{}'::jsonb, '{hybrid,summary}', '{}'::uuid[], '{}'::uuid[], 0.5, false, 'mcp-stdio',
              '[{"chunkId": "c1"}]'::jsonb, 10, 'hybrid')
      returning id`;
    const e = (await explain(sql, row.id))!;
    expect(e).toMatchObject({ v2: false, results: null, k: 10, mode: "hybrid", layers: ["hybrid", "summary"] });
    expect(e.notes).toHaveLength(1);
    expect(e.notes[0]).toMatch(/^results could not be read with the current contract \(0\.\w+: .*\); shown as not recorded$/);
    const text = renderExplain(e);
    expect(text).toContain(`note: ${e.notes[0]}`);
    expect(text).toContain("logged before evidence v2");
  });
});
````

In `test/unit/eval-attribution.test.ts`, replace:
````ts
  it("accepts quoted values, CRLF line ends and other keys", () => {
    expect(splitFrontMatter('---\r\ntags: x\r\nauthor: "Owner"\r\n---\r\nText')).toEqual({ author: "owner", body: "Text" });
  });
  it("rejects an author outside owner, other and unknown", () => {
    expect(() => splitFrontMatter("---\nauthor: me\n---\nx")).toThrow(/author must be one of/);
  });
````
with:
````ts
  it("accepts quoted values, CRLF line ends and other keys", () => {
    expect(splitFrontMatter('---\r\ntags: x\r\nauthor: "Owner"\r\n---\r\nText')).toEqual({ author: "owner", body: "Text" });
  });
  it("throws when the opening fence has no closing fence, instead of storing the block as body text", () => {
    expect(() => splitFrontMatter("---\nauthor: other\n# Title\n\nBody.\n")).toThrow("front matter: the opening --- has no closing --- line");
    expect(() => splitFrontMatter("---\r\nauthor: other\r\nText")).toThrow(/no closing/);
  });
  it("accepts an empty block", () => {
    expect(splitFrontMatter("---\n---\nText")).toEqual({ author: undefined, body: "Text" });
  });
  it("rejects an author outside owner, other and unknown", () => {
    expect(() => splitFrontMatter("---\nauthor: me\n---\nx")).toThrow(/author must be one of/);
  });
````

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/render.test.ts test/unit/eval-attribution.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/explain.test.ts`
Expected: FAIL. In the unit files, 6 tests: `turns double quotes inside a title into single quotes…`, `shows a pre-v2 top score below 0.05…`, `prints notes about evidence v2 columns…` (the new imports are undefined), `explains what is known about a row logged before evidence v2` (`top score: 0.03` where `0.0310` is expected), `throws when the opening fence has no closing fence…` (`expected [Function] to throw an error`) and `accepts an empty block` (the body still holds `---`). In the integration file, 2 tests: the pre-v2 row (`to contain 'top score: 0.0310'`) and the future row (`ZodError`, since the whole row is parsed at once).

- [ ] **Step 3: Read each evidence v2 column on its own**

Replace the whole of `src/retrieve/explain.ts` with:
````ts
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
  /** Evidence v2 fields that were logged but could not be read with today's contract (shown as not recorded). */
  notes: string[];
}

/** The message for an id that names no logged search. */
export function explainNotFound(retrievalId: string): string {
  return `No logged search has retrieval id "${retrievalId}". The id is on the first line of a brain_search result: retrieval <id> · mode: …`;
}

/** The columns every row has had since migration 001; a row that fails these is not a retrieval_log row. */
const V1RowSchema = z.object({
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
});

/**
 * Evidence v2 (migration 011), read one column at a time with safeParse: absent on a database without it, null on rows
 * logged before it, and unreadable when the contract has since gained a required field. An unreadable column is shown
 * as not recorded, with a note, so a contract change never stops older rows from being explained.
 */
function v2Field<T>(raw: Record<string, unknown>, column: string, schema: z.ZodType<T>, notes: string[]): T | null {
  const value = raw[column];
  if (value === null || value === undefined) return null;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length ? `${issue.path.join(".")}: ` : "";
  notes.push(`${column} could not be read with the current contract (${where}${issue?.message ?? "invalid"}); shown as not recorded`);
  return null;
}

/**
 * Reads one retrieval_log row; null when the id is not a UUID or names no row. It never searches again.
 * to_jsonb reads whichever columns the table has, so a database without migration 011 still explains its rows, and each
 * evidence v2 column is read on its own (v2Field), so a later contract change cannot break explaining older rows.
 */
export async function explain(sql: Db, retrievalId: string): Promise<Explanation | null> {
  if (!UUID.test(retrievalId)) return null;
  const [row] = await sql<{ r: unknown }[]>`select to_jsonb(l) as r from brain.retrieval_log l where l.id = ${retrievalId}`;
  if (!row) return null;
  const raw = (row.r ?? {}) as Record<string, unknown>;
  const r = V1RowSchema.parse(raw);
  const notes: string[] = [];
  const results = v2Field(raw, "results", z.array(LoggedPassageSchema), notes);
  return {
    retrievalId: r.id,
    query: r.query,
    client: r.client ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    filters: r.filters ?? {},
    v2: results !== null,
    k: v2Field(raw, "k", z.number().int(), notes),
    mode: v2Field(raw, "mode", SearchModeSchema, notes),
    degraded: v2Field(raw, "degraded", DegradedSchema, notes),
    candidates: v2Field(raw, "candidates", CandidatesSchema, notes),
    timings: v2Field(raw, "timings", TimingsSchema, notes),
    results,
    layers: r.layers ?? [],
    chunkIds: r.chunk_ids ?? [],
    nodeIds: r.node_ids ?? [],
    topScore: r.top_score ?? null,
    usedFallback: r.used_fallback ?? false,
    notes,
  };
}
````

- [ ] **Step 4: Titles, legacy scores and notes in the renderer**

In `src/mcp/render.ts`, replace:
````ts
  return parts.filter((x): x is string => x !== null).join(" ");
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
````
with:
````ts
  return parts.filter((x): x is string => x !== null).join(" ");
}

/**
 * A title in double quotes for a provenance line. Double quotes inside it (straight or curly) become single quotes, so a
 * title such as `"I thought…" — a post` reads `"'I thought…' — a post"` instead of `""I thought…" — a post"`.
 */
export function quotedTitle(title: string | null): string {
  return title ? `"${title.replace(/["\u201c\u201d]/g, "'")}"` : "(untitled)";
}

/**
 * One passage's provenance line: label, score and score kind, how it was found, source kind, author, title, date,
 * and the ids to read it with (a fallback passage has no chunk, so its character window instead).
 */
export function passageLine(p: LoggedPassage, index: number): string {
  const title = quotedTitle(p.title);
  const date = p.occurredAt ? p.occurredAt.slice(0, 10) : "undated";
  const where = p.chunkId ? `(doc ${p.documentId}, chunk ${p.chunkId})` : `(doc ${p.documentId}, chars ${p.charStart}–${p.charEnd})`;
  return `[P${index + 1}] ${scoreText(p)} · ${foundBy(p)} · ${p.sourceKind} · author: ${p.author} · ${title} · ${date} ${where}`;
````

In `src/mcp/render.ts`, replace:
````ts
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
````
with:
````ts
  const rank = (r: number | null) => (r === null ? "-" : String(r));
  const score = p.score === null ? "-" : p.score.toFixed(p.scoreKind === "rrf" ? 4 : 2);
  const via = p.viaEntity ? ` via ${p.viaEntity.name}` : p.fallbackTerm !== null ? ` "${p.fallbackTerm}"` : "";
  const title = quotedTitle(p.title);
  const where = p.chunkId ? `(doc ${p.documentId}, chunk ${p.chunkId})` : `(doc ${p.documentId}, chars ${p.charStart}–${p.charEnd})`;
  return `#${index + 1} [P${index + 1}] score ${score} (${p.scoreKind}) · layers ${p.layers.join("+")}${via} · vector ${rank(p.vectorRank)} · keyword ${rank(p.keywordRank)} · rerank ${rank(p.rerankRank)} · ${title} · author: ${p.author} · ${p.sourceKind} ${where}`;
}

/**
 * A top score logged before evidence v2: an RRF value (about 0.008 to 0.033) when the search was degraded, else a rerank
 * score. Below 0.05 it gets four decimals, so 0.0164 is not shown as 0.02.
 */
export function legacyTopScoreText(score: number | null): string {
  if (score === null) return "none";
  return score.toFixed(score < 0.05 ? 4 : 2);
}

/** brain_explain and `brain explain`: a logged search replayed from brain.retrieval_log, with no new search. */
export function renderExplain(e: Explanation): string {
  const out = [
    `retrieval ${e.retrievalId} · logged ${e.createdAt} · client ${e.client ?? "unknown"}`,
    `query: "${e.query}"`,
    `filters: ${filtersText(e.filters)}`,
    ...e.notes.map((n) => `note: ${n}`),
  ];
  if (!e.v2 || e.results === null) {
    out.push(
      "logged before evidence v2: only the chunk ids, the top score, the layers and the fallback flag were recorded.",
      `layers: ${e.layers.join(", ") || "none"}`,
      `top score: ${legacyTopScoreText(e.topScore)} (before evidence v2 this is an RRF value when the search was degraded)`,
      `fallback scan: ${e.usedFallback ? "used" : "not used"}`,
      `chunks in rank order (fallback passages were not recorded): ${e.chunkIds.join(", ") || "none"}`,
      `entities: ${e.nodeIds.join(", ") || "none"}`,
````

- [ ] **Step 5: An unclosed front-matter fence throws**

In `src/eval/run.ts`, replace:
````ts
/**
 * Optional front matter at the top of a fixture: `---`, `key: value` lines, `---`. Only `author` is read
 * (owner, other or unknown, optionally quoted); other keys are ignored. Returns the text without the block.
 */
export function splitFrontMatter(text: string): { author: Author | undefined; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { author: undefined, body: text };
  let author: Author | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) {
      if (line.trim()) throw new Error(`front matter: cannot read line "${line}"`);
````
with:
````ts
/**
 * Optional front matter at the top of a fixture: `---`, `key: value` lines, `---`. Only `author` is read
 * (owner, other or unknown, optionally quoted); other keys are ignored. Returns the text without the block.
 * A file that opens a fence and never closes it throws: storing the block as body text with the kind's default
 * author would silently attribute the document to the wrong writer.
 */
export function splitFrontMatter(text: string): { author: Author | undefined; body: string } {
  const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) {
    if (/^---[ \t]*\r?\n/.test(text)) throw new Error("front matter: the opening --- has no closing --- line");
    return { author: undefined, body: text };
  }
  let author: Author | undefined;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) {
      if (line.trim()) throw new Error(`front matter: cannot read line "${line}"`);
````

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/unit/render.test.ts test/unit/eval-attribution.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/explain.test.ts`
Expected: PASS (36 tests).

- [ ] **Step 7: Typecheck and the suites**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: no type errors; unit 390 passed; integration 307 passed.

- [ ] **Step 8: Commit**

```bash
git add src/retrieve/explain.ts src/mcp/render.ts src/eval/run.ts test/unit/render.test.ts test/integration/explain.test.ts test/unit/eval-attribution.test.ts
git commit -m "Review follow-ups: explain reads each evidence v2 column with safeParse and notes what it cannot read; pre-v2 top scores below 0.05 with four decimals; double quotes in titles become single; an unclosed front-matter fence throws

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: brain_search output size at k=30: structuredContent without passage text

**Files:**
- Create: `test/unit/search-output-size.test.ts`
- Modify: `src/retrieve/contract.ts`
- Modify: `src/mcp/server.ts`
- Modify: `test/integration/mcp-server.test.ts`

The Phase 4 review asked to measure one k=30 search, since `structuredContent` repeats every passage's text, and to drop `content` from it if text plus `structuredContent` passes about 100 KB. The measurement is a unit test on the largest result the code can return: k=30 hybrid passages plus 25 graph passages (`maxEntities` 5 × `maxPassagesPerEntity` 5), each at the passage cap (`passageTokens` × 4 = 1,600 characters, the chunker's estimate), 10 facts, 5 entities with 20 neighbours. Measured on this code: text 105,509 bytes, full `structuredContent` 129,219, together 234,728; without passage text, `structuredContent` is 40,504 and the total 146,013. So `structuredContent` drops `content` (`SearchOutputSchema`, `toSearchOutput`). Even so, the text alone passes 100 KB at this extreme, which the README says (Task 13); at the default k=10 the worst case is 99,173 bytes, under it. The search's own result, the log and `brain search --json` keep the text.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/search-output-size.test.ts`:
````ts
import { describe, it, expect } from "vitest";
import { renderSearch } from "../../src/mcp/render.js";
import { SearchOutputSchema, toSearchOutput, type SearchResult } from "../../src/retrieve/contract.js";
import { config } from "../../src/config.js";
import { passage, fact, searchResult } from "./search-fixture.js";

/** About what an MCP client such as Claude Code accepts from one tool call before truncating it (25,000 tokens). */
const OUTPUT_BUDGET_BYTES = 100_000;

const id = (prefix: string, i: number) => `${prefix}${i}`.padEnd(36, "0");

/**
 * The largest brain_search result: k=30 hybrid passages plus 25 graph passages (5 entities × 5 passages), each at the
 * passage cap (passageTokens × 4 characters, the chunker's estimate), 10 facts, and 5 entities with 20 neighbours each.
 */
function worstCase(k = 30): SearchResult {
  const body = "x".repeat(config.chunking.passageTokens * 4);
  const title = "A realistic document title of about sixty characters, ok";
  const hybrid = Array.from({ length: k }, (_, i) =>
    passage({ chunkId: id("c", i), documentId: id("d", i), title, headingPath: ["Section heading", "Subsection"], content: body }));
  const graph = Array.from({ length: config.graph.maxEntities * config.graph.maxPassagesPerEntity }, (_, i) =>
    passage({
      chunkId: id("g", i), documentId: id("e", i), title, headingPath: ["Section heading"], content: body, score: null, scoreKind: "none",
      layers: ["graph"], vectorRank: null, keywordRank: null, rerankRank: null, viaEntity: { id: id("n", 0), name: "Acme Corp" },
    }));
  return searchResult({
    k,
    passages: [...hybrid, ...graph],
    facts: Array.from({ length: config.graph.maxFacts }, (_, i) => fact({ id: id("f", i) })),
    entities: Array.from({ length: config.graph.maxEntities }, (_, i) => ({
      id: id("n", i), type: "organization", name: "Acme Corp", matchedSpan: "acme corp",
      neighbors: Array.from({ length: config.graph.maxNeighbors }, (_, j) => ({ id: id("m", j), type: "person", name: "Priya Natarajan", depth: 1 })),
    })),
  });
}

const bytes = (s: string) => Buffer.byteLength(s);

describe("brain_search output size at k=30 with graph passages", () => {
  const r = worstCase();
  const text = bytes(renderSearch(r));

  it("is over the budget when structuredContent repeats every passage's text, which is why it no longer does", () => {
    expect(r.passages).toHaveLength(55);
    expect(text + bytes(JSON.stringify(r))).toBeGreaterThan(OUTPUT_BUDGET_BYTES);
  });

  it("structuredContent leaves passage text out and still validates against the advertised schema", () => {
    const out = toSearchOutput(r);
    expect(SearchOutputSchema.parse(out)).toEqual(out);
    expect(out.passages.every((p) => !("content" in p))).toBe(true);
    expect(out.passages.map((p) => p.chunkId)).toEqual(r.passages.map((p) => p.chunkId));
    // The saving is the passage text: more than 85 KB on this result.
    expect(bytes(JSON.stringify(r)) - bytes(JSON.stringify(out))).toBeGreaterThan(85_000);
  });

  it("at k=30 the text alone is over the budget (the README says so); at the default k=10 the whole output fits", () => {
    expect(text).toBeGreaterThan(OUTPUT_BUDGET_BYTES);
    const d = worstCase(config.retrieval.defaultK);
    expect(d.passages).toHaveLength(35);
    expect(bytes(renderSearch(d)) + bytes(JSON.stringify(toSearchOutput(d)))).toBeLessThan(OUTPUT_BUDGET_BYTES);
  });
});
````

In `test/integration/mcp-server.test.ts`, replace:
````ts
import { JobManager } from "../../src/mcp/jobs.js";
import { storeDocument } from "../../src/ingest/store.js";
import type { ObsidianAutoProjector } from "../../src/obsidian/auto.js";
import { SearchResultSchema } from "../../src/retrieve/contract.js";
import { renderSearch, renderVerification } from "../../src/mcp/render.js";
import { VerificationSchema } from "../../src/verify/resolve.js";

const sql = testDb();
````
with:
````ts
import { JobManager } from "../../src/mcp/jobs.js";
import { storeDocument } from "../../src/ingest/store.js";
import type { ObsidianAutoProjector } from "../../src/obsidian/auto.js";
import { SearchOutputSchema } from "../../src/retrieve/contract.js";
import { renderVerification } from "../../src/mcp/render.js";
import { VerificationSchema } from "../../src/verify/resolve.js";

const sql = testDb();
````

In `test/integration/mcp-server.test.ts`, replace:
````ts
    await s.close();
  });

  it("brain_search starts with the retrieval id and mode, shows each passage's provenance, and returns the contract as structuredContent", async () => {
    const s = await connect();
    const ing = await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    const id = /document ([0-9a-f-]{36})/.exec(ing.text)![1];
````
with:
````ts
    await s.close();
  });

  it("brain_search starts with the retrieval id and mode, shows each passage's provenance, and returns the contract without passage text as structuredContent", async () => {
    const s = await connect();
    const ing = await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    const id = /document ([0-9a-f-]{36})/.exec(ing.text)![1];
````

In `test/integration/mcp-server.test.ts`, replace:
````ts
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
````
with:
````ts
    const res = await s.client.callTool({ name: "brain_search", arguments: { query: "Acme Corp visa", k: 5 } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    const sc = SearchOutputSchema.parse(res.structuredContent);
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(text.split("\n")[0]).toBe(`retrieval ${sc.retrievalId} · mode: hybrid · ${sc.passages.length} passage${sc.passages.length === 1 ? "" : "s"}`);
    expect(text).toContain(`[P1] ${(sc.passages[0].score as number).toFixed(2)} rerank · `);
    expect(text).toContain(`(doc ${id}, chunk ${sc.passages[0].chunkId})`);
    expect(text).toContain("author: owner");
    expect(text).toContain(`[F1] visa_status: F-1 OPT (unverified · from note ${id})`);
    // The structure leaves passage text out (the text content carries it); everything else is there.
    expect(sc.passages.every((p) => !("content" in p))).toBe(true);
    expect(sc.passages.every((p) => text.includes(`chunk ${p.chunkId})`))).toBe(true);
    expect(text).toContain("I applied to Acme Corp in September.");
    const [log] = await sql<{ client: string; mode: string }[]>`select client, mode from brain.retrieval_log where id = ${sc.retrievalId}`;
    expect(log).toEqual({ client: "test", mode: "hybrid" });
    await s.close();
````

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/search-output-size.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/mcp-server.test.ts`
Expected: FAIL. In the unit file the first test passes (it measures the current output) and the other two fail (`toSearchOutput` is undefined). In the integration file, `brain_search starts with the retrieval id…` fails with `TypeError: Cannot read properties of undefined (reading 'parse')` (`SearchOutputSchema` does not exist yet).

- [ ] **Step 3: The output schema**

In `src/retrieve/contract.ts`, replace:
````ts
  timings: TimingsSchema,
});

export type Layer = z.infer<typeof LayerSchema>;
export type ScoreKind = z.infer<typeof ScoreKindSchema>;
export type SearchMode = z.infer<typeof SearchModeSchema>;
````
with:
````ts
  timings: TimingsSchema,
});

/**
 * brain_search's structuredContent: the result with each passage's text left out, since the text content already
 * carries it. Measured on a synthetic worst case (k=30 plus 25 graph passages of 1,600 characters,
 * test/unit/search-output-size.test.ts), sending the full result made the text plus structuredContent about 235 KB;
 * without passage text it is about 146 KB, of which the text is about 106 KB.
 */
export const SearchOutputSchema = SearchResultSchema.extend({ passages: z.array(LoggedPassageSchema) });

export type Layer = z.infer<typeof LayerSchema>;
export type ScoreKind = z.infer<typeof ScoreKindSchema>;
export type SearchMode = z.infer<typeof SearchModeSchema>;
````

In `src/retrieve/contract.ts`, replace:
````ts
export type Candidates = z.infer<typeof CandidatesSchema>;
export type Timings = z.infer<typeof TimingsSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const NOT_DEGRADED: Degraded = { embedding: false, rerank: false, capReached: false };

````
with:
````ts
export type Candidates = z.infer<typeof CandidatesSchema>;
export type Timings = z.infer<typeof TimingsSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchOutput = z.infer<typeof SearchOutputSchema>;

export const NOT_DEGRADED: Degraded = { embedding: false, rerank: false, capReached: false };

````

In `src/retrieve/contract.ts`, replace:
````ts
  return passages.map(({ content: _content, ...rest }) => rest);
}

export type FactSource =
  | { kind: "document"; sourceKind: string; documentId: string }
  | { kind: "owner" }
````
with:
````ts
  return passages.map(({ content: _content, ...rest }) => rest);
}

/** What brain_search returns as structuredContent: the result without passage text (SearchOutputSchema). */
export function toSearchOutput(r: SearchResult): SearchOutput {
  return { ...r, passages: toLoggedPassages(r.passages) };
}

export type FactSource =
  | { kind: "document"; sourceKind: string; documentId: string }
  | { kind: "owner" }
````

- [ ] **Step 4: brain_search returns it**

In `src/mcp/server.ts`, replace:
````ts
import { suppressedDocuments } from "../ingest/set-author.js";
import { runPipeline, stageCounts } from "../ingest/pipeline.js";
import { search } from "../retrieve/search.js";
import { SearchResultSchema } from "../retrieve/contract.js";
import { orient } from "../retrieve/orient.js";
import { getDocument } from "../retrieve/documents.js";
import { explain, explainNotFound } from "../retrieve/explain.js";
````
with:
````ts
import { suppressedDocuments } from "../ingest/set-author.js";
import { runPipeline, stageCounts } from "../ingest/pipeline.js";
import { search } from "../retrieve/search.js";
import { SearchOutputSchema, toSearchOutput } from "../retrieve/contract.js";
import { orient } from "../retrieve/orient.js";
import { getDocument } from "../retrieve/documents.js";
import { explain, explainNotFound } from "../retrieve/explain.js";
````

In `src/mcp/server.ts`, replace:
````ts
      description:
        "Hybrid keyword and semantic search over everything the owner has saved. Expands entities named in the query (neighbours and up to 5 passages that mention each), and returns up to 10 of the owner's facts that share a term with the query or point at a named entity; use brain_get_facts or brain_orient for the full fact list. " +
        "The first line is `retrieval <id> · mode: hybrid | keyword-only | fused-order · <n> passages`. Each passage line reads `[P1] <score> <score kind> · <how found> · <source kind> · author: <owner|other|unknown> · \"<title>\" · <date> (doc <id>, chunk <id>)`: score kind rerank is 0 to 1 (higher is stronger), rrf means reranking was skipped, and - marks a passage found through a named entity (graph via <entity>) or a literal match (fallback \"<term>\"); how found lists vector#<rank> and keyword#<rank>, plus graph via <entity> when the graph also reached a ranked passage. Each fact says verified or unverified and where it came from: read from a document (from <kind> <doc id>), stated by owner, confirmed by owner (verified, no stored source passage), or extracted from a passage no longer stored. " +
        "Pass the retrieval id to brain_explain to see how the passages were ranked. The same result is returned as structuredContent. " +
        "After answering, pass the retrieval id and your answer's claims to brain_verify, which checks each claim against the passages and facts it cites.",
      inputSchema: {
        query: z.string().min(1),
````
with:
````ts
      description:
        "Hybrid keyword and semantic search over everything the owner has saved. Expands entities named in the query (neighbours and up to 5 passages that mention each), and returns up to 10 of the owner's facts that share a term with the query or point at a named entity; use brain_get_facts or brain_orient for the full fact list. " +
        "The first line is `retrieval <id> · mode: hybrid | keyword-only | fused-order · <n> passages`. Each passage line reads `[P1] <score> <score kind> · <how found> · <source kind> · author: <owner|other|unknown> · \"<title>\" · <date> (doc <id>, chunk <id>)`: score kind rerank is 0 to 1 (higher is stronger), rrf means reranking was skipped, and - marks a passage found through a named entity (graph via <entity>) or a literal match (fallback \"<term>\"); how found lists vector#<rank> and keyword#<rank>, plus graph via <entity> when the graph also reached a ranked passage. Each fact says verified or unverified and where it came from: read from a document (from <kind> <doc id>), stated by owner, confirmed by owner (verified, no stored source passage), or extracted from a passage no longer stored. " +
        "Pass the retrieval id to brain_explain to see how the passages were ranked. The same result is returned as structuredContent, without each passage's text (read it here, or with brain_get_document). " +
        "After answering, pass the retrieval id and your answer's claims to brain_verify, which checks each claim against the passages and facts it cites.",
      inputSchema: {
        query: z.string().min(1),
````

In `src/mcp/server.ts`, replace:
````ts
        until: isoDate.optional().describe("ISO date upper bound, e.g. 2026-09-30"),
        verified_only: z.boolean().optional().describe("Only return facts and neighbour nodes marked verified. Passages are never filtered: documents have no verification state."),
      },
      outputSchema: SearchResultSchema,
    },
    async (a) => {
      try {
        const r = await search(ctx, a.query, { k: a.k, sourceKinds: a.source_kinds, since: dateOrUndefined(a.since), until: dateOrUndefined(a.until), verifiedOnly: a.verified_only, client: opts.client });
        return { content: [{ type: "text", text: renderSearch(r) }], structuredContent: r };
      } catch (e) { return fail(e); }
    },
  );
````
with:
````ts
        until: isoDate.optional().describe("ISO date upper bound, e.g. 2026-09-30"),
        verified_only: z.boolean().optional().describe("Only return facts and neighbour nodes marked verified. Passages are never filtered: documents have no verification state."),
      },
      outputSchema: SearchOutputSchema,
    },
    async (a) => {
      try {
        const r = await search(ctx, a.query, { k: a.k, sourceKinds: a.source_kinds, since: dateOrUndefined(a.since), until: dateOrUndefined(a.until), verifiedOnly: a.verified_only, client: opts.client });
        return { content: [{ type: "text", text: renderSearch(r) }], structuredContent: toSearchOutput(r) };
      } catch (e) { return fail(e); }
    },
  );
````

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/search-output-size.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/mcp-server.test.ts`
Expected: PASS (3 unit tests; 19 integration tests).

- [ ] **Step 6: Typecheck and the suites**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: no type errors; unit 393 passed; integration 307 passed.

- [ ] **Step 7: Commit**

```bash
git add test/unit/search-output-size.test.ts src/retrieve/contract.ts src/mcp/server.ts test/integration/mcp-server.test.ts
git commit -m "brain_search structuredContent without passage text: a k=30 result with 25 graph passages measured 235 KB with it and 146 KB without; the default k=10 stays under 100 KB

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Golden schema v3: who approved each item, which corpus it runs on

**Files:**
- Modify: `src/eval/golden.ts`
- Modify: `eval/golden.jsonl`
- Replace: `test/unit/golden.test.ts`
- Modify: `test/unit/golden-fixtures.test.ts`
- Modify: `test/unit/eval.test.ts`

Every item gains `approved_by` (`owner` or `agent`, required, so no item is silent about who vouched for it) and `corpus` (`fixtures`, the default, or `real`); generated items may carry `edited`, captured items must carry `retrieval_id`. The rules a schema cannot express move into `goldenItemProblems`, shared by `parseGolden` and the draft checks through `validateGoldenItem`: the negative rules as before, plus generated and captured items approved by the owner, `edited` only on generated items, `retrieval_id` exactly on captured items, fixture items naming documents by origin (`brain_eval` is rebuilt, so its ids change), and filter items carrying source kinds. `appendGolden` appends after checking the whole file still parses, so a duplicate id never reaches disk; `goldenLine` writes keys in a fixed order. The 19 existing items are marked `approved_by: "agent"`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `test/unit/golden.test.ts` with:
````ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGolden, validateGoldenItem, goldenLine, appendGolden, loadGolden, forCorpus, approvalCounts, type GoldenItem } from "../../src/eval/golden.js";

const base = {
  id: "q01", question: "What is the salary range?", kind: "keyword",
  expected: [{ origin: "job_description--acme-senior-data-analyst.md" }],
  source: "fixture", approved_by: "agent", approved_at: "2026-09-30",
};
const ok = JSON.stringify(base);
const line = (over: Record<string, unknown>) => JSON.stringify({ ...base, ...over });

describe("parseGolden", () => {
  it("parses one item per non-empty line, with negative false and corpus fixtures by default", () => {
    const items = parseGolden(`${ok}\n\n${ok.replace("q01", "q02")}\n`);
    expect(items.map((i) => i.id)).toEqual(["q01", "q02"]);
    expect(items[0].expected[0].origin).toBe("job_description--acme-senior-data-analyst.md");
    expect(items[0]).toMatchObject({ negative: false, corpus: "fixtures", approved_by: "agent" });
  });
  it("rejects duplicate ids", () => {
    expect(() => parseGolden(`${ok}\n${ok}`)).toThrow(/duplicate id q01/);
  });
  it("requires expected documents unless the item is negative", () => {
    expect(() => parseGolden(line({ id: "q03", kind: "semantic", expected: [] }))).toThrow(/q03.*expected/);
    expect(parseGolden(line({ id: "q04", kind: "negative", expected: [], negative: true }))[0].negative).toBe(true);
  });
  it("rejects a negative item that lists expected documents", () => {
    expect(() => parseGolden(line({ id: "q05", kind: "negative", expected: [{ origin: "a.md" }], negative: true }))).toThrow(/q05.*negative/);
  });
  it("includes the line number in the negative and expected errors", () => {
    expect(() => parseGolden(`${ok}\n${line({ id: "q03", kind: "semantic", expected: [] })}`)).toThrow(/line 2.*q03.*expected/);
    expect(() => parseGolden(`${ok}\n\n${line({ id: "q05", kind: "negative", expected: [{ origin: "a.md" }], negative: true })}`)).toThrow(/line 3.*q05.*negative/);
  });
  it("requires kind negative exactly when negative is true", () => {
    expect(() => parseGolden(line({ id: "q06", kind: "negative", expected: [{ origin: "a.md" }] }))).toThrow(/line 1.*q06.*kind/);
    expect(() => parseGolden(line({ id: "q07", kind: "semantic", expected: [], negative: true }))).toThrow(/line 1.*q07.*kind/);
  });
  it("rejects unknown keys on the item and on expected entries", () => {
    expect(() => parseGolden(line({ expect: [] }))).toThrow(/line 1.*expect/);
    expect(() => parseGolden(line({ expected: [{ origin: "a.md", qoute: "x" }] }))).toThrow(/line 1: expected\.0: .*qoute/);
  });
  it("names the field path in schema errors", () => {
    expect(() => parseGolden(line({ kind: "bogus" }))).toThrow(/line 1: kind: /);
  });
  it("reports the line number of invalid JSON", () => {
    expect(() => parseGolden(`${ok}\n{not json`)).toThrow(/line 2/);
  });
  it("requires approved_by, owner or agent", () => {
    const { approved_by: _drop, ...noApprover } = base;
    expect(() => parseGolden(JSON.stringify(noApprover))).toThrow(/line 1: approved_by: /);
    expect(() => parseGolden(line({ approved_by: "claude" }))).toThrow(/line 1: approved_by: /);
  });
  it("lets only the owner approve generated and captured items", () => {
    expect(() => parseGolden(line({ source: "generated" }))).toThrow(/a generated item must be approved by the owner/);
    expect(parseGolden(line({ source: "generated", approved_by: "owner", edited: true }))[0].edited).toBe(true);
  });
  it("keeps edited for generated items and retrieval_id for captured items", () => {
    expect(() => parseGolden(line({ edited: false }))).toThrow(/edited is only for generated items/);
    expect(() => parseGolden(line({ source: "captured", approved_by: "owner" }))).toThrow(/retrieval_id is required on captured items/);
    const rid = "6f1c2a0e-1111-4222-8333-444455556666";
    expect(parseGolden(line({ source: "captured", approved_by: "owner", retrieval_id: rid }))[0].retrieval_id).toBe(rid);
  });
  it("names fixture documents by origin, since brain_eval's document ids change when it is rebuilt", () => {
    const docId = "0b9c6a38-1111-4222-8333-444455556666";
    expect(() => parseGolden(line({ expected: [{ document_id: docId }] }))).toThrow(/a fixtures item names each expected document by origin/);
    expect(parseGolden(line({ corpus: "real", expected: [{ document_id: docId }] }))[0].corpus).toBe("real");
  });
  it("requires source kinds on a filter item", () => {
    expect(() => parseGolden(line({ kind: "filter" }))).toThrow(/a filter item needs filters.sourceKinds/);
    expect(parseGolden(line({ kind: "filter", filters: { sourceKinds: ["news"] } }))[0].kind).toBe("filter");
  });
});

describe("validateGoldenItem", () => {
  it("returns the item, or every schema error and rule broken", () => {
    expect(validateGoldenItem(base)).toMatchObject({ ok: true, item: { id: "q01" } });
    expect(validateGoldenItem({ ...base, kind: "bogus" })).toMatchObject({ ok: false, errors: expect.stringMatching(/^kind: /) });
    expect(validateGoldenItem({ ...base, kind: "negative" })).toEqual({
      ok: false,
      errors: 'kind "negative" and negative: true must go together',
    });
  });
});

describe("goldenLine, appendGolden, loadGolden", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "golden-"));
  });

  it("writes keys in a fixed order, negative only when true, and round-trips", () => {
    const [item] = parseGolden(line({ source: "generated", approved_by: "owner", edited: false, paraphrases: ["p1", "p2"] }));
    expect(goldenLine(item)).toBe(
      '{"id":"q01","question":"What is the salary range?","kind":"keyword","expected":[{"origin":"job_description--acme-senior-data-analyst.md"}],"paraphrases":["p1","p2"],"source":"generated","corpus":"fixtures","approved_by":"owner","approved_at":"2026-09-30","edited":false}',
    );
    expect(parseGolden(goldenLine(item))[0]).toEqual(item);
  });

  it("appends after the existing lines unchanged, and writes nothing when the result would not parse", async () => {
    const path = join(dir, "golden.jsonl");
    await writeFile(path, ok); // no trailing newline
    const [second] = parseGolden(ok.replace("q01", "q02"));
    await appendGolden(path, [second]);
    expect(await readFile(path, "utf8")).toBe(`${ok}\n${goldenLine(second)}\n`);
    await expect(appendGolden(path, [second])).rejects.toThrow(/duplicate id q02/);
    expect((await loadGolden(path)).map((i) => i.id)).toEqual(["q01", "q02"]);
  });

  it("treats a missing file as an empty set", async () => {
    expect(await loadGolden(join(dir, "none.jsonl"))).toEqual([]);
    const path = join(dir, "new.jsonl");
    await appendGolden(path, parseGolden(ok));
    expect(await readFile(path, "utf8")).toBe(`${goldenLine(parseGolden(ok)[0])}\n`);
  });
});

describe("forCorpus and approvalCounts", () => {
  it("splits items by corpus and counts who approved them", () => {
    const items: GoldenItem[] = parseGolden([
      ok,
      line({ id: "g1", source: "generated", approved_by: "owner", edited: false }),
      line({ id: "r1", corpus: "real", source: "captured", approved_by: "owner", retrieval_id: "6f1c2a0e-1111-4222-8333-444455556666", expected: [{ document_id: "0b9c6a38-1111-4222-8333-444455556666" }] }),
    ].join("\n"));
    expect(forCorpus(items, "fixtures").map((i) => i.id)).toEqual(["q01", "g1"]);
    expect(forCorpus(items, "real").map((i) => i.id)).toEqual(["r1"]);
    expect(approvalCounts(items)).toEqual({ owner: 2, agent: 1 });
  });
});
````

In `test/unit/golden-fixtures.test.ts`, replace:
````ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseGolden } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace } from "../../src/eval/run.js";

````
with:
````ts
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { parseGolden } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace } from "../../src/eval/run.js";

````

In `test/unit/golden-fixtures.test.ts`, replace:
````ts
      }
    }
  });
  it("has at least three attribution items, each naming a fixture marked author: other, and a negative item", async () => {
    const items = await golden();
    const attribution = items.filter((i) => i.kind === "attribution");
````
with:
````ts
      }
    }
  });
  it("every fixtures item names files that exist in eval/corpus, and every real item names documents by id", async () => {
    const files = new Set(await readdir("eval/corpus"));
    for (const item of await golden()) {
      for (const e of item.expected) {
        if (item.corpus === "fixtures") expect([item.id, files.has(e.origin!)]).toEqual([item.id, true]);
        else expect([item.id, typeof e.document_id]).toEqual([item.id, "string"]);
      }
    }
  });
  it("has at least three attribution items, each naming a fixture marked author: other, and a negative item", async () => {
    const items = await golden();
    const attribution = items.filter((i) => i.kind === "attribution");
````

In `test/unit/eval.test.ts`, replace:
````ts
import { passage, searchResult as baseResult } from "./search-fixture.js";

const item: GoldenItem = {
  id: "q05", question: "Why?", kind: "semantic", negative: false, source: "fixture", approved_at: "2026-09-30",
  expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot satisfy all three" }],
};

````
with:
````ts
import { passage, searchResult as baseResult } from "./search-fixture.js";

const item: GoldenItem = {
  id: "q05", question: "Why?", kind: "semantic", negative: false, source: "fixture", corpus: "fixtures", approved_by: "agent", approved_at: "2026-09-30",
  expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot satisfy all three" }],
};

````

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/golden.test.ts test/unit/golden-fixtures.test.ts`
Expected: FAIL, 18 tests: 17 in `golden.test.ts` (its lines carry `approved_by`, an unknown key to the current strict schema, and the new exports are undefined) and the new origin test in `golden-fixtures.test.ts` (`item.corpus` is undefined, so every item is taken for a real one). `npm run typecheck` reports `test/unit/eval.test.ts` and `test/unit/golden-fixtures.test.ts` (`corpus` is not a property of `GoldenItem`) and `test/unit/golden.test.ts` (no exported member `validateGoldenItem`).

- [ ] **Step 3: The schema, the rules and the file helpers**

Replace the whole of `src/eval/golden.ts` with:
````ts
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

export const GOLDEN_KINDS = ["keyword", "semantic", "graph", "filter", "fallback", "attribution", "negative"] as const;
export type GoldenKind = (typeof GOLDEN_KINDS)[number];

/** Where an item came from: written with the fixture corpus, drafted by `eval draft`, or labelled from a logged search. */
export const GOLDEN_SOURCES = ["fixture", "generated", "captured"] as const;
export type GoldenSource = (typeof GOLDEN_SOURCES)[number];

/** Who approved the item. Drafted and captured items are always approved by the owner; agents never approve them. */
export const APPROVERS = ["owner", "agent"] as const;
export type Approver = (typeof APPROVERS)[number];

/** Which eval database the item runs against: brain_eval (eval/corpus) or brain_real_eval (a copy of the real base). */
export const CORPORA = ["fixtures", "real"] as const;
export type Corpus = (typeof CORPORA)[number];

const ExpectedSchema = z.object({
  /** Suffix of documents.origin, e.g. the fixture file name. */
  origin: z.string().min(1).optional(),
  /** A document id, for items about the real base (ids survive `eval sync`). */
  document_id: z.string().uuid().optional(),
  /** Verbatim span from the document; when present, a passage is relevant only if it contains it. */
  quote: z.string().min(1).optional(),
}).strict().refine((e) => e.origin || e.document_id, { message: "expected needs origin or document_id" });

export const GoldenItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(GOLDEN_KINDS),
  expected: z.array(ExpectedSchema),
  filters: z.object({ sourceKinds: z.array(z.string()).optional() }).strict().optional(),
  paraphrases: z.array(z.string().min(1)).optional(),
  source: z.enum(GOLDEN_SOURCES),
  negative: z.boolean().default(false),
  corpus: z.enum(CORPORA).default("fixtures"),
  approved_by: z.enum(APPROVERS),
  approved_at: z.string().min(1),
  /** Generated items only: true when the owner changed the drafted question, quote, kind or paraphrases before approving. */
  edited: z.boolean().optional(),
  /** Captured items only: the logged search the question came from. */
  retrieval_id: z.string().uuid().optional(),
}).strict();
export type GoldenItem = z.infer<typeof GoldenItemSchema>;
export type GoldenInput = z.input<typeof GoldenItemSchema>;
export type Expected = z.infer<typeof ExpectedSchema>;

/** The rules a schema cannot express. Empty means the item is valid. */
export function goldenItemProblems(item: GoldenItem): string[] {
  const out: string[] = [];
  if ((item.kind === "negative") !== item.negative) out.push('kind "negative" and negative: true must go together');
  if (item.negative && item.expected.length > 0) out.push("a negative item must not list expected documents");
  if (!item.negative && item.expected.length === 0) out.push("expected is empty; mark the item negative or list a document");
  if (item.source !== "fixture" && item.approved_by !== "owner") out.push(`a ${item.source} item must be approved by the owner`);
  if (item.edited !== undefined && item.source !== "generated") out.push("edited is only for generated items");
  if ((item.retrieval_id !== undefined) !== (item.source === "captured")) out.push("retrieval_id is required on captured items and only there");
  // brain_eval is rebuilt from eval/corpus, so its document ids change; fixture items name documents by file name.
  if (item.corpus === "fixtures" && item.expected.some((e) => !e.origin)) out.push("a fixtures item names each expected document by origin");
  if (item.kind === "filter" && !item.filters?.sourceKinds?.length) out.push("a filter item needs filters.sourceKinds");
  return out;
}

const issueText = (issues: z.ZodError["issues"]) => issues.map((x) => (x.path.length ? `${x.path.join(".")}: ${x.message}` : x.message)).join("; ");

/** Schema and rules for one item; the errors are what parseGolden would report for it. */
export function validateGoldenItem(raw: unknown): { ok: true; item: GoldenItem } | { ok: false; errors: string } {
  const parsed = GoldenItemSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: issueText(parsed.error.issues) };
  const problems = goldenItemProblems(parsed.data);
  return problems.length ? { ok: false, errors: problems.join("; ") } : { ok: true, item: parsed.data };
}

/**
 * One JSON object per line; blank lines are ignored. Unknown keys are rejected. Throws with the line number
 * (and the field path for schema errors) on the first invalid line.
 */
export function parseGolden(text: string): GoldenItem[] {
  const items: GoldenItem[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`golden line ${i + 1}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = GoldenItemSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`golden line ${i + 1}: ${issueText(parsed.error.issues)}`);
    const item = parsed.data;
    if (seen.has(item.id)) throw new Error(`golden line ${i + 1}: duplicate id ${item.id}`);
    seen.add(item.id);
    const problems = goldenItemProblems(item);
    if (problems.length) throw new Error(`golden line ${i + 1} (${item.id}): ${problems.join("; ")}`);
    items.push(item);
  }
  return items;
}

/** Reads a golden file; a missing file is an empty set. */
export async function loadGolden(path: string): Promise<GoldenItem[]> {
  try {
    return parseGolden(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** One line of eval/golden.jsonl, keys in a fixed order; negative is written only when true. */
export function goldenLine(item: GoldenItem): string {
  const ordered: Record<string, unknown> = { id: item.id, question: item.question, kind: item.kind, expected: item.expected };
  if (item.filters) ordered.filters = item.filters;
  if (item.paraphrases) ordered.paraphrases = item.paraphrases;
  ordered.source = item.source;
  if (item.negative) ordered.negative = true;
  ordered.corpus = item.corpus;
  ordered.approved_by = item.approved_by;
  ordered.approved_at = item.approved_at;
  if (item.edited !== undefined) ordered.edited = item.edited;
  if (item.retrieval_id !== undefined) ordered.retrieval_id = item.retrieval_id;
  return JSON.stringify(ordered);
}

/**
 * Appends items to a golden file after checking the whole result parses (unique ids, every rule). Existing lines are
 * kept byte for byte; nothing is written when any check fails.
 */
export async function appendGolden(path: string, items: GoldenItem[]): Promise<void> {
  if (items.length === 0) return;
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const next = (text === "" || text.endsWith("\n") ? text : text + "\n") + items.map(goldenLine).join("\n") + "\n";
  parseGolden(next);
  await writeFile(path, next);
}

/** The items that run against one corpus. */
export function forCorpus(items: GoldenItem[], corpus: Corpus): GoldenItem[] {
  return items.filter((i) => i.corpus === corpus);
}

/** How many items each approver approved; printed by `eval run` and stated in the README. */
export function approvalCounts(items: GoldenItem[]): Record<Approver, number> {
  return { owner: items.filter((i) => i.approved_by === "owner").length, agent: items.filter((i) => i.approved_by === "agent").length };
}
````

- [ ] **Step 4: Mark the existing items as written by an agent**

Run:
```bash
sed -i '' 's/,"approved_at":/,"approved_by":"agent","approved_at":/' eval/golden.jsonl
grep -c '"approved_by":"agent"' eval/golden.jsonl
```
Expected: `19`. The file now reads:
````json
{"id":"q01","question":"What is the salary range for the Acme Senior Data Analyst role?","kind":"keyword","expected":[{"origin":"job_description--acme-senior-data-analyst.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q02","question":"Who led Acme's Series B?","kind":"keyword","expected":[{"origin":"news--acme-series-b.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q03","question":"Does Acme sponsor work visas?","kind":"semantic","expected":[{"origin":"job_description--acme-senior-data-analyst.md"},{"origin":"conversation--interview-prep-with-priya.md"},{"origin":"email--recruiter-followup-beta-ventures.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q04","question":"What should I study before the SQL screen?","kind":"semantic","expected":[{"origin":"conversation--interview-prep-with-priya.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q05","question":"Why can't you satisfy every fairness definition at once?","kind":"semantic","expected":[{"origin":"note--fairness-in-ml.md","quote":"cannot satisfy all three when base rates differ"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q06","question":"How much did prepending context to chunks reduce retrieval failures?","kind":"semantic","expected":[{"origin":"paper--contextual-retrieval-abstract.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q07","question":"What do I know about Priya Natarajan?","kind":"graph","expected":[{"origin":"conversation--interview-prep-with-priya.md"},{"origin":"job_description--acme-senior-data-analyst.md"},{"origin":"email--recruiter-followup-beta-ventures.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q08","question":"Which companies is Beta Ventures connected to?","kind":"graph","expected":[{"origin":"news--acme-series-b.md"},{"origin":"email--recruiter-followup-beta-ventures.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q09","question":"What is the ZX-9000?","kind":"graph","expected":[{"origin":"news--acme-series-b.md"},{"origin":"job_description--acme-senior-data-analyst.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q10","question":"Acme funding news","kind":"filter","expected":[{"origin":"news--acme-series-b.md"}],"filters":{"sourceKinds":["news"]},"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q11","question":"remote product analyst Denver","kind":"filter","expected":[{"origin":"email--recruiter-followup-beta-ventures.md"}],"filters":{"sourceKinds":["email"]},"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q12","question":"Chouldechova","kind":"keyword","expected":[{"origin":"note--fairness-in-ml.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q13","question":"X-90","kind":"fallback","expected":[{"origin":"news--acme-series-b.md"},{"origin":"job_description--acme-senior-data-analyst.md"},{"origin":"conversation--interview-prep-with-priya.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"q14","question":"$115k","kind":"fallback","expected":[{"origin":"email--recruiter-followup-beta-ventures.md"}],"source":"fixture","approved_by":"agent","approved_at":"2026-09-30"}
{"id":"a01","question":"Why did the Databricks bill in the saved post go up so much?","kind":"attribution","expected":[{"origin":"note--databricks-cost-governance.md","quote":"Each squad created its own interactive cluster"}],"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
{"id":"a02","question":"Who introduced Frank for the analytics lead role at Northwind Robotics?","kind":"attribution","expected":[{"origin":"email--recruiter-intro.md","quote":"He is one of three finalists for the position"}],"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
{"id":"a03","question":"What does the post recommend for Databricks cost governance?","kind":"attribution","expected":[{"origin":"note--databricks-cost-governance.md","quote":"make idle clusters terminate after 20 minutes"}],"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
{"id":"q15","question":"Where do I live now?","kind":"semantic","expected":[{"origin":"note--moved-to-denver.md","quote":"I now live in Denver for good"}],"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
{"id":"n01","question":"How much did I pay for the sushi dinner in Kyoto?","kind":"negative","expected":[],"negative":true,"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
````

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/golden.test.ts test/unit/golden-fixtures.test.ts test/unit/eval.test.ts`
Expected: PASS (22 tests in the two golden files).

- [ ] **Step 6: Typecheck and the unit suite**

Run: `npm run typecheck && npm run test:unit`
Expected: no type errors; unit 404 passed.

- [ ] **Step 7: Commit**

```bash
git add src/eval/golden.ts eval/golden.jsonl test/unit/golden.test.ts test/unit/golden-fixtures.test.ts test/unit/eval.test.ts
git commit -m "Golden schema v3: approved_by (owner or agent) on every item, corpus (fixtures or real), edited and retrieval_id; rules shared through validateGoldenItem; appendGolden checks the whole file first; the 19 existing items are agent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Per-source metrics, approval counts, and `eval run --corpus`

**Files:**
- Modify: `src/eval/metrics.ts`
- Modify: `src/eval/baseline.ts`
- Modify: `src/eval/run.ts`
- Modify: `src/eval/db.ts`
- Modify: `src/cli.ts`
- Modify: `test/unit/metrics.test.ts`
- Modify: `test/unit/baseline.test.ts`
- Modify: `test/unit/eval.test.ts`
- Modify: `test/unit/eval-db-guard.test.ts`

The metrics and the gate do not change. Each result carries its item's source and approver; the report adds rank metrics per source (`fixture`, `generated`, `captured`) over positive items and the number of items per approver, both optional in the baseline schema so older baselines load. `eval run` prints them under the per-kind lines:

```
source fixture    n=24  recall@10=1.00  mrr=0.97
source generated  n=31  recall@10=0.94  mrr=0.88
approved  owner=38  agent=26
```

`--corpus fixtures` (default) runs the fixture items against `brain_eval`; `--corpus real` runs the real items against `brain_real_eval` (`EVAL_REAL_DATABASE_URL`, default `.../brain_real_eval`, which must end in `_eval`) with its own baseline, `eval/baseline-real.json`. A missing eval database is reported with the commands that create it. `test/unit/baseline.test.ts` stops reading the committed baseline's shape (it asserted there were no stage latencies, which Task 12's re-accept would break) and tests an older shape on a written copy.

- [ ] **Step 1: Write the failing tests**

In `test/unit/metrics.test.ts`, replace:
````ts

function result(partial: Partial<QuestionResult>): QuestionResult {
  return {
    id: "q", kind: "keyword", negative: false, expected: [], ranked: [], totalRelevant: 0, topScore: 0.9, hasGraphPassage: false,
    degraded: false, totalMs: 10, timings: { embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0, totalMs: 10 },
    paraphraseRanked: [], paraphraseDegraded: [], ...partial,
  };
````
with:
````ts

function result(partial: Partial<QuestionResult>): QuestionResult {
  return {
    id: "q", kind: "keyword", source: "fixture", approvedBy: "agent", negative: false, expected: [], ranked: [], totalRelevant: 0, topScore: 0.9, hasGraphPassage: false,
    degraded: false, totalMs: 10, timings: { embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0, totalMs: 10 },
    paraphraseRanked: [], paraphraseDegraded: [], ...partial,
  };
````

In `test/unit/metrics.test.ts`, replace:
````ts
      graph: { p50: 1, p95: 2 },
    });
  });
  it("counts paraphrase searches in the degraded fraction", () => {
    const r = summarize([
      result({ id: "1", expected: exp("a"), ranked: ranked("a"), paraphraseRanked: [ranked("a"), ranked("a"), ranked("a")], paraphraseDegraded: [true, false, false] }),
````
with:
````ts
      graph: { p50: 1, p95: 2 },
    });
  });
  it("breaks rank metrics down by golden source over positive items, and counts every item by approver", () => {
    const r = summarize([
      result({ id: "1", source: "fixture", approvedBy: "agent", expected: exp("a"), ranked: ranked("a") }),
      result({ id: "2", source: "generated", approvedBy: "owner", expected: exp("a"), ranked: ranked("b", "a") }),
      result({ id: "3", source: "generated", approvedBy: "owner", expected: exp("z"), ranked: ranked("b") }),
      result({ id: "4", source: "captured", approvedBy: "owner", kind: "negative", negative: true, topScore: 0.1 }),
    ], 0.3);
    expect(Object.keys(r.bySource!).sort()).toEqual(["fixture", "generated"]);
    expect(r.bySource!.fixture).toMatchObject({ n: 1, recallAt10: 1, mrr: 1 });
    expect(r.bySource!.generated).toMatchObject({ n: 2, recallAt10: 0.5, mrr: 0.25 });
    expect(r.approvals).toEqual({ owner: 3, agent: 1 });
  });
  it("counts paraphrase searches in the degraded fraction", () => {
    const r = summarize([
      result({ id: "1", expected: exp("a"), ranked: ranked("a"), paraphraseRanked: [ranked("a"), ranked("a"), ranked("a")], paraphraseDegraded: [true, false, false] }),
````

In `test/unit/baseline.test.ts`, replace:
````ts
    expect(await loadBaseline(join(dir, "b.json"))).toEqual(base);
    expect(await loadBaseline(join(dir, "missing.json"))).toBeNull();
  });
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
  it("throws a clear error on a malformed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseline-"));
````
with:
````ts
    expect(await loadBaseline(join(dir, "b.json"))).toEqual(base);
    expect(await loadBaseline(join(dir, "missing.json"))).toBeNull();
  });
  it("loads a baseline with per-stage latency, per-source metrics and approvals, and one recorded before them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseline-"));
    const p50p95 = { p50: 1, p95: 2 };
    const m = { n: 1, recallAt1: 1, recallAt5: 1, recallAt10: 1, mrr: 1, ndcgAt10: null };
    const full: Baseline = {
      ...base,
      report: report({}, { stageLatencyMs: { embed: p50p95, sql: p50p95, rerank: p50p95, graph: p50p95 }, bySource: { fixture: m }, approvals: { owner: 0, agent: 1 } }),
    };
    await saveBaseline(join(dir, "b.json"), full);
    expect(await loadBaseline(join(dir, "b.json"))).toEqual(full);
    const { stageLatencyMs: _s, bySource: _b, approvals: _a, ...older } = full.report;
    await saveBaseline(join(dir, "old.json"), { ...base, report: older });
    const loaded = await loadBaseline(join(dir, "old.json"));
    expect(loaded!.report.stageLatencyMs).toBeUndefined();
    expect(loaded!.report.bySource).toBeUndefined();
    expect(loaded!.report.approvals).toBeUndefined();
    expect(await loadBaseline("eval/baseline.json")).not.toBeNull();
  });
  it("throws a clear error on a malformed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseline-"));
````

In `test/unit/eval.test.ts`, replace:
````ts
import { describe, it, expect } from "vitest";
import { kindFromFilename, toQuestionResult, firstExpectedRank, normalizeWhitespace, missingQuoteWarning, evalVoyageLine, stageLatencyLine } from "../../src/eval/run.js";
import { summarize } from "../../src/eval/metrics.js";
import type { GoldenItem } from "../../src/eval/golden.js";
import type { Layer, SearchResult } from "../../src/retrieve/contract.js";
````
with:
````ts
import { describe, it, expect } from "vitest";
import { kindFromFilename, toQuestionResult, firstExpectedRank, normalizeWhitespace, missingQuoteWarning, evalVoyageLine, stageLatencyLine, breakdownLines } from "../../src/eval/run.js";
import { summarize } from "../../src/eval/metrics.js";
import type { GoldenItem } from "../../src/eval/golden.js";
import type { Layer, SearchResult } from "../../src/retrieve/contract.js";
````

In `test/unit/eval.test.ts`, replace:
````ts
  });
});

describe("evalVoyageLine", () => {
  it("prints the run's Voyage spend, and warns when the cap refused calls", () => {
    expect(evalVoyageLine({ requests: 30, tokens: 41_200, refused: 0 })).toBe("voyage  tokens=41200 requests=30 refused=0");
````
with:
````ts
  });
});

describe("source and approver", () => {
  it("carries the item's source and approver into the result", () => {
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "x", score: 0.9 }]);
    const q = toQuestionResult({ ...item, source: "generated", approved_by: "owner", edited: false }, res, new Map(), [], 0, []);
    expect(q).toMatchObject({ source: "generated", approvedBy: "owner" });
  });
  it("prints one line per source in the order fixture, generated, captured, then the approval counts", () => {
    const res = searchResult([{ documentId: "d2", layers: ["vector"], content: "x", score: 0.9 }]);
    const origins = new Map([["d2", "/c/note--fairness-in-ml.md"]]);
    const report = summarize([
      toQuestionResult({ ...item, id: "g", source: "generated", approved_by: "owner" }, res, origins, [], 0, []),
      toQuestionResult(item, res, origins, [], 0, []),
    ], 0.3);
    expect(breakdownLines(report)).toEqual([
      "source fixture    n=1  recall@10=1.00  mrr=1.00",
      "source generated  n=1  recall@10=1.00  mrr=1.00",
      "approved  owner=1  agent=1",
    ]);
    const { bySource: _b, approvals: _a, ...older } = report;
    expect(breakdownLines(older)).toEqual([]);
  });
});

describe("evalVoyageLine", () => {
  it("prints the run's Voyage spend, and warns when the cap refused calls", () => {
    expect(evalVoyageLine({ requests: 30, tokens: 41_200, refused: 0 })).toBe("voyage  tokens=41200 requests=30 refused=0");
````

In `test/unit/eval-db-guard.test.ts`, replace:
````ts
import { describe, it, expect } from "vitest";
import { assertEvalDatabase, EVAL_DATABASE_URL } from "../../src/eval/db.js";

describe("eval database guard", () => {
  it("defaults to a *_eval database", () => {
    expect(new URL(EVAL_DATABASE_URL).pathname).toMatch(/_eval$/);
  });
  it("refuses the real and the test database", () => {
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/postgres")).toThrow(/must end in _eval/);
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_test")).toThrow(/must end in _eval/);
````
with:
````ts
import { describe, it, expect } from "vitest";
import { assertEvalDatabase, EVAL_DATABASE_URL, EVAL_REAL_DATABASE_URL, evalDatabaseUrl, evalDatabaseHint } from "../../src/eval/db.js";

describe("eval database guard", () => {
  it("defaults to a *_eval database", () => {
    expect(new URL(EVAL_DATABASE_URL).pathname).toMatch(/_eval$/);
  });
  it("keeps the copy of the real base in its own *_eval database, apart from the fixtures", () => {
    expect(new URL(EVAL_REAL_DATABASE_URL).pathname).toMatch(/_eval$/);
    expect(EVAL_REAL_DATABASE_URL).not.toBe(EVAL_DATABASE_URL);
    expect(evalDatabaseUrl("fixtures")).toBe(EVAL_DATABASE_URL);
    expect(evalDatabaseUrl("real")).toBe(EVAL_REAL_DATABASE_URL);
  });
  it("says how to create a missing eval database, and leaves other errors alone", () => {
    const missing = Object.assign(new Error('database "brain_real_eval" does not exist'), { code: "3D000" });
    expect((evalDatabaseHint(missing, "real") as Error).message).toBe(
      'database "brain_real_eval" does not exist; create it with npm run eval:prepare-real, then npm run brain -- eval sync',
    );
    expect((evalDatabaseHint(missing, "fixtures") as Error).message).toMatch(/npm run eval:prepare, then npm run brain -- eval ingest$/);
    const other = new Error("boom");
    expect(evalDatabaseHint(other, "real")).toBe(other);
  });
  it("refuses the real and the test database", () => {
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/postgres")).toThrow(/must end in _eval/);
    expect(() => assertEvalDatabase("postgresql://postgres:postgres@127.0.0.1:55322/brain_test")).toThrow(/must end in _eval/);
````

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/metrics.test.ts test/unit/baseline.test.ts test/unit/eval.test.ts test/unit/eval-db-guard.test.ts`
Expected: FAIL, 6 tests: `breaks rank metrics down by golden source…` and the baseline round trip (no `bySource`/`approvals` yet), `carries the item's source and approver into the result`, `prints one line per source…` (`breakdownLines is not a function`), `keeps the copy of the real base in its own *_eval database…` (`TypeError: Invalid URL`: `EVAL_REAL_DATABASE_URL` is undefined) and `says how to create a missing eval database…` (`evalDatabaseHint is not a function`).

- [ ] **Step 3: Metrics per source and per approver**

In `src/eval/metrics.ts`, replace:
````ts
import type { Expected, GoldenKind } from "./golden.js";
import type { Timings } from "../retrieve/contract.js";

export interface RankedDoc {
````
with:
````ts
import type { Approver, Expected, GoldenKind, GoldenSource } from "./golden.js";
import type { Timings } from "../retrieve/contract.js";

export interface RankedDoc {
````

In `src/eval/metrics.ts`, replace:
````ts
export interface QuestionResult {
  id: string;
  kind: GoldenKind;
  negative: boolean;
  expected: Expected[];
  ranked: RankedDoc[];
````
with:
````ts
export interface QuestionResult {
  id: string;
  kind: GoldenKind;
  /** The golden item's source (fixture, generated, captured) and who approved it, for the per-source breakdown. */
  source: GoldenSource;
  approvedBy: Approver;
  negative: boolean;
  expected: Expected[];
  ranked: RankedDoc[];
````

In `src/eval/metrics.ts`, replace:
````ts
  latencyMs: Percentiles;
  /** p50/p95 of each search stage over the main questions. Optional: baselines recorded before Phase 4 have none. */
  stageLatencyMs?: StageLatency;
}

export interface Percentiles {
````
with:
````ts
  latencyMs: Percentiles;
  /** p50/p95 of each search stage over the main questions. Optional: baselines recorded before Phase 4 have none. */
  stageLatencyMs?: StageLatency;
  /** Rank metrics per golden source (fixture, generated, captured) over positive items. Optional: added in Phase 6. */
  bySource?: Record<string, RankMetrics>;
  /** Items (positive and negative) per approver. Optional: added in Phase 6. */
  approvals?: Record<Approver, number>;
}

export interface Percentiles {
````

In `src/eval/metrics.ts`, replace:
````ts
  const negatives = results.filter((r) => r.negative);
  const byKind: Record<string, RankMetrics> = {};
  for (const kind of new Set(positives.map((r) => r.kind))) byKind[kind] = rankMetrics(positives.filter((r) => r.kind === kind));
  const latencies = results.map((r) => r.totalMs);
  const stage = (pick: (t: Timings) => number): Percentiles => {
    const xs = results.map((r) => pick(r.timings));
````
with:
````ts
  const negatives = results.filter((r) => r.negative);
  const byKind: Record<string, RankMetrics> = {};
  for (const kind of new Set(positives.map((r) => r.kind))) byKind[kind] = rankMetrics(positives.filter((r) => r.kind === kind));
  const bySource: Record<string, RankMetrics> = {};
  for (const source of new Set(positives.map((r) => r.source))) bySource[source] = rankMetrics(positives.filter((r) => r.source === source));
  const latencies = results.map((r) => r.totalMs);
  const stage = (pick: (t: Timings) => number): Percentiles => {
    const xs = results.map((r) => pick(r.timings));
````

In `src/eval/metrics.ts`, replace:
````ts
    degradedFraction: searches.length ? searches.filter(Boolean).length / searches.length : 0,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    stageLatencyMs: { embed: stage((t) => t.embedMs), sql: stage((t) => t.sqlMs), rerank: stage((t) => t.rerankMs), graph: stage((t) => t.graphMs) },
  };
}
````
with:
````ts
    degradedFraction: searches.length ? searches.filter(Boolean).length / searches.length : 0,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    stageLatencyMs: { embed: stage((t) => t.embedMs), sql: stage((t) => t.sqlMs), rerank: stage((t) => t.rerankMs), graph: stage((t) => t.graphMs) },
    bySource,
    approvals: { owner: results.filter((r) => r.approvedBy === "owner").length, agent: results.filter((r) => r.approvedBy === "agent").length },
  };
}
````

In `src/eval/baseline.ts`, replace:
````ts
  latencyMs: PercentilesSchema,
  // Added in Phase 4; baselines recorded before it have none and still load.
  stageLatencyMs: z.object({ embed: PercentilesSchema, sql: PercentilesSchema, rerank: PercentilesSchema, graph: PercentilesSchema }).optional(),
});

const BaselineSchema = z.object({
````
with:
````ts
  latencyMs: PercentilesSchema,
  // Added in Phase 4; baselines recorded before it have none and still load.
  stageLatencyMs: z.object({ embed: PercentilesSchema, sql: PercentilesSchema, rerank: PercentilesSchema, graph: PercentilesSchema }).optional(),
  // Added in Phase 6; earlier baselines have neither and still load.
  bySource: z.record(z.string(), RankMetricsSchema).optional(),
  approvals: z.object({ owner: z.number(), agent: z.number() }).optional(),
});

const BaselineSchema = z.object({
````

- [ ] **Step 4: Results carry source and approver; one corpus per run**

In `src/eval/run.ts`, replace:
````ts
import { ingestAll, logSkip } from "../ingest/batch.js";
import { search, type SearchOptions, type SearchResult } from "../retrieve/search.js";
import { isDegraded, isHybrid } from "../retrieve/contract.js";
import { parseGolden, type Expected, type GoldenItem } from "./golden.js";
import { summarize, mrr, matchesExpected, type QuestionResult, type RankedDoc, type Report } from "./metrics.js";
import { assertEvalConnection, EVAL_CLIENT } from "./db.js";
import { voyageSpendSince, type VoyageSpend } from "../llm/usage.js";
````
with:
````ts
import { ingestAll, logSkip } from "../ingest/batch.js";
import { search, type SearchOptions, type SearchResult } from "../retrieve/search.js";
import { isDegraded, isHybrid } from "../retrieve/contract.js";
import { parseGolden, forCorpus, type Corpus, type Expected, type GoldenItem } from "./golden.js";
import { summarize, mrr, matchesExpected, type QuestionResult, type RankedDoc, type Report } from "./metrics.js";
import { assertEvalConnection, EVAL_CLIENT } from "./db.js";
import { voyageSpendSince, type VoyageSpend } from "../llm/usage.js";
````

In `src/eval/run.ts`, replace:
````ts
  return `stages  ${part("embed", s.embed)}  ${part("sql", s.sql)}  ${part("rerank", s.rerank)}  ${part("graph", s.graph)}`;
}

/** 1-based rank of the first expected document among distinct ranked documents, or null. */
export function firstExpectedRank(q: QuestionResult): number | null {
  const m = mrr(q.expected, q.ranked);
````
with:
````ts
  return `stages  ${part("embed", s.embed)}  ${part("sql", s.sql)}  ${part("rerank", s.rerank)}  ${part("graph", s.graph)}`;
}

/**
 * The eval output lines for the per-source breakdown (rank metrics over positive items of each golden source, in the
 * order fixture, generated, captured) and the approval counts (every item, negative ones included).
 */
export function breakdownLines(report: Report): string[] {
  const out: string[] = [];
  const order = ["fixture", "generated", "captured"];
  const sources = Object.keys(report.bySource ?? {}).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const source of sources) {
    const m = report.bySource![source];
    out.push(`source ${source.padEnd(10)} n=${m.n}  recall@10=${m.recallAt10.toFixed(2)}  mrr=${m.mrr.toFixed(2)}`);
  }
  if (report.approvals) out.push(`approved  owner=${report.approvals.owner}  agent=${report.approvals.agent}`);
  return out;
}

/** 1-based rank of the first expected document among distinct ranked documents, or null. */
export function firstExpectedRank(q: QuestionResult): number | null {
  const m = mrr(q.expected, q.ranked);
````

In `src/eval/run.ts`, replace:
````ts
  return {
    id: item.id,
    kind: item.kind,
    negative: item.negative,
    expected: item.expected,
    ranked,
````
with:
````ts
  return {
    id: item.id,
    kind: item.kind,
    source: item.source,
    approvedBy: item.approved_by,
    negative: item.negative,
    expected: item.expected,
    ranked,
````

In `src/eval/run.ts`, replace:
````ts
}

/**
 * Runs every golden item (and its paraphrases) against the context's database, which must be the eval database, then
 * scores the citation verifier on verifierPath with that database's stems.
 */
export async function runEval(ctx: Ctx, goldenPath: string, verifierPath = "eval/verifier.jsonl"): Promise<EvalRun> {
  await assertEvalConnection(ctx.sql);
  // The database's clock, so the window matches the ledger's created_at exactly.
  const [{ startedAt }] = await ctx.sql<{ startedAt: Date }[]>`select clock_timestamp() as "startedAt"`;
  const golden = parseGolden(await readFile(goldenPath, "utf8"));
  const results: QuestionResult[] = [];
  for (const g of golden) {
    const opts: SearchOptions = { sourceKinds: g.filters?.sourceKinds, client: "eval", includeFacts: false, k: 10 };
````
with:
````ts
}

/**
 * Runs every golden item of one corpus (and its paraphrases) against the context's database, which must be that
 * corpus's eval database (brain_eval for fixtures, brain_real_eval for real), then scores the citation verifier on
 * verifierPath with that database's stems.
 */
export async function runEval(ctx: Ctx, goldenPath: string, verifierPath = "eval/verifier.jsonl", corpus: Corpus = "fixtures"): Promise<EvalRun> {
  await assertEvalConnection(ctx.sql);
  // The database's clock, so the window matches the ledger's created_at exactly.
  const [{ startedAt }] = await ctx.sql<{ startedAt: Date }[]>`select clock_timestamp() as "startedAt"`;
  const golden = forCorpus(parseGolden(await readFile(goldenPath, "utf8")), corpus);
  const results: QuestionResult[] = [];
  for (const g of golden) {
    const opts: SearchOptions = { sourceKinds: g.filters?.sourceKinds, client: "eval", includeFacts: false, k: 10 };
````

- [ ] **Step 5: The real-base eval database**

In `src/eval/db.ts`, replace:
````ts
import { config, EVAL_VOYAGE_CAP_NAME } from "../config.js";
import { makeCtx, type Ctx } from "../ctx.js";
import type { Db } from "../db.js";

/**
 * The eval ingests fictional documents and logs hundreds of searches, so it only ever runs against a
````
with:
````ts
import { config, EVAL_VOYAGE_CAP_NAME } from "../config.js";
import { makeCtx, type Ctx } from "../ctx.js";
import type { Db } from "../db.js";
import type { Corpus } from "./golden.js";

/**
 * The eval ingests fictional documents and logs hundreds of searches, so it only ever runs against a
````

In `src/eval/db.ts`, replace:
````ts
export const EVAL_DATABASE_URL =
  process.env.EVAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_eval";

/**
 * postgres.js copies unknown URL query parameters into the startup message, so `?database=postgres`
 * would override the path. Only these parameters, which cannot change the target database, are allowed.
````
with:
````ts
export const EVAL_DATABASE_URL =
  process.env.EVAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_eval";

/**
 * The copy of the real knowledge base that `brain eval sync` fills (`eval run --corpus real` runs against it). Kept
 * apart from brain_eval so fixture evals and real-base evals both keep working; its name must end in _eval too.
 */
export const EVAL_REAL_DATABASE_URL =
  process.env.EVAL_REAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_real_eval";

/** The eval database a corpus runs against. */
export function evalDatabaseUrl(corpus: Corpus): string {
  return corpus === "real" ? EVAL_REAL_DATABASE_URL : EVAL_DATABASE_URL;
}

/** A "database does not exist" error (SQLSTATE 3D000) gains the commands that create that corpus's eval database. */
export function evalDatabaseHint(err: unknown, corpus: Corpus): unknown {
  if ((err as { code?: string } | null)?.code !== "3D000") return err;
  const how = corpus === "real" ? "npm run eval:prepare-real, then npm run brain -- eval sync" : "npm run eval:prepare, then npm run brain -- eval ingest";
  return new Error(`${err instanceof Error ? err.message : String(err)}; create it with ${how}`);
}

/**
 * postgres.js copies unknown URL query parameters into the startup message, so `?database=postgres`
 * would override the path. Only these parameters, which cannot change the target database, are allowed.
````

In `src/eval/db.ts`, replace:
````ts
export const EVAL_CLIENT = "eval";

/**
 * A real context (real Voyage, real Claude Code) on the eval database, with the Obsidian mirror off. Its Voyage
 * calls are recorded in brain_eval's own ledger, never the real base's, and capped at the eval's own cap
 * (BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP).
 */
export function makeEvalCtx(): Ctx {
  assertEvalDatabase(EVAL_DATABASE_URL);
  return makeCtx({ databaseUrl: EVAL_DATABASE_URL, obsidian: false, client: EVAL_CLIENT, voyageCap: { tokens: config.evalVoyageDailyTokenCap, name: EVAL_VOYAGE_CAP_NAME } });
}
````
with:
````ts
export const EVAL_CLIENT = "eval";

/**
 * A real context (real Voyage, real Claude Code) on a corpus's eval database, with the Obsidian mirror off. Its Voyage
 * calls are recorded in that eval database's own ledger, never the real base's, and capped at the eval's own cap
 * (BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP, counted per eval database).
 */
export function makeEvalCtx(corpus: Corpus = "fixtures"): Ctx {
  const url = evalDatabaseUrl(corpus);
  assertEvalDatabase(url);
  return makeCtx({ databaseUrl: url, obsidian: false, client: EVAL_CLIENT, voyageCap: { tokens: config.evalVoyageDailyTokenCap, name: EVAL_VOYAGE_CAP_NAME } });
}
````

- [ ] **Step 6: `eval run --corpus` and the breakdown lines**

In `src/cli.ts`, replace:
````ts
    });
  });

const evalCmd = program.command("eval").description("Retrieval eval against the brain_eval database (never the real one)");

evalCmd
  .command("ingest [dir]")
````
with:
````ts
    });
  });

const evalCmd = program.command("eval").description("Retrieval eval against brain_eval (the fixture corpus) or brain_real_eval (a copy of the real base); never the real database itself");

/** --corpus fixtures (brain_eval, eval/corpus) or real (brain_real_eval, filled by `eval sync`). */
function corpusOption(value: string | undefined): "fixtures" | "real" {
  const v = value ?? "fixtures";
  if (v !== "fixtures" && v !== "real") throw new Error(`--corpus must be fixtures or real, got ${JSON.stringify(value)}`);
  return v;
}

evalCmd
  .command("ingest [dir]")
````

In `src/cli.ts`, replace:
````ts

evalCmd
  .command("run")
  .description("Run the golden set and report metrics; --compare shows deltas against eval/baseline.json")
  .option("--golden <path>", "golden set file", "eval/golden.jsonl")
  .option("--baseline <path>", "baseline file", "eval/baseline.json")
  .option("--verifier <path>", "citation verifier set", "eval/verifier.jsonl")
  .option("--verifier-baseline <path>", "citation verifier baseline", "eval/verifier-baseline.json")
  .option("--compare", "compare against the baseline")
````
with:
````ts

evalCmd
  .command("run")
  .description("Run the golden set's items for one corpus and report metrics; --compare shows deltas against the baseline")
  .option("--corpus <corpus>", "fixtures (brain_eval) or real (brain_real_eval, after eval sync)", "fixtures")
  .option("--golden <path>", "golden set file", "eval/golden.jsonl")
  .option("--baseline <path>", "baseline file (default eval/baseline.json, or eval/baseline-real.json with --corpus real)")
  .option("--verifier <path>", "citation verifier set", "eval/verifier.jsonl")
  .option("--verifier-baseline <path>", "citation verifier baseline", "eval/verifier-baseline.json")
  .option("--compare", "compare against the baseline")
````

In `src/cli.ts`, replace:
````ts
  .option("--accept", "overwrite the baseline with this run")
  .option("--json")
  .action(async (opts) => {
    const { makeEvalCtx } = await import("./eval/db.js");
    const { runEval, attributionGate, evalVoyageLine, stageLatencyLine } = await import("./eval/run.js");
    const { compare, gateFailures, loadBaseline, saveBaseline } = await import("./eval/baseline.js");
    const { abstained, falseAnswer } = await import("./eval/metrics.js");
    const { verifierGate, verifierLine, loadVerifierBaseline } = await import("./eval/verifier.js");
    const { execSync } = await import("node:child_process");
    const ctx = makeEvalCtx();
    try {
      const run = await runEval(ctx, opts.golden, opts.verifier);
      const base = opts.compare || opts.gate ? await loadBaseline(opts.baseline) : null;
      const goldenIds = run.results.map((r) => r.id).sort();
      const comparison = base ? compare(base, run.report, run.ranks, goldenIds) : null;
````
with:
````ts
  .option("--accept", "overwrite the baseline with this run")
  .option("--json")
  .action(async (opts) => {
    const { makeEvalCtx, evalDatabaseHint } = await import("./eval/db.js");
    const { runEval, attributionGate, evalVoyageLine, stageLatencyLine, breakdownLines } = await import("./eval/run.js");
    const { compare, gateFailures, loadBaseline, saveBaseline } = await import("./eval/baseline.js");
    const { abstained, falseAnswer } = await import("./eval/metrics.js");
    const { verifierGate, verifierLine, loadVerifierBaseline } = await import("./eval/verifier.js");
    const { execSync } = await import("node:child_process");
    const corpus = corpusOption(opts.corpus);
    opts.baseline ??= corpus === "real" ? "eval/baseline-real.json" : "eval/baseline.json";
    const ctx = makeEvalCtx(corpus);
    try {
      const run = await runEval(ctx, opts.golden, opts.verifier, corpus);
      if (run.results.length === 0) console.error(`eval: no ${corpus} items in ${opts.golden}`);
      const base = opts.compare || opts.gate ? await loadBaseline(opts.baseline) : null;
      const goldenIds = run.results.map((r) => r.id).sort();
      const comparison = base ? compare(base, run.report, run.ranks, goldenIds) : null;
````

In `src/cli.ts`, replace:
````ts
        const o = run.report.overall;
        console.log(`\noverall  n=${o.n}  recall@1=${o.recallAt1.toFixed(2)}  recall@5=${o.recallAt5.toFixed(2)}  recall@10=${o.recallAt10.toFixed(2)}  mrr=${o.mrr.toFixed(2)}  ndcg@10=${o.ndcgAt10 === null ? "n/a" : o.ndcgAt10.toFixed(2)}`);
        for (const [kind, m] of Object.entries(run.report.byKind)) console.log(`${kind.padEnd(11)} n=${m.n}  recall@10=${m.recallAt10.toFixed(2)}  mrr=${m.mrr.toFixed(2)}`);
        const ng = run.report.negatives;
        if (ng.n) console.log(`negatives   n=${ng.n}  abstention=${ng.abstentionRate.toFixed(2)}  false-answer=${ng.falseAnswerRate.toFixed(2)}`);
        if (run.report.paraphrase.n) console.log(`paraphrase  n=${run.report.paraphrase.n}  consistency=${run.report.paraphrase.consistency.toFixed(2)}  mean-recall@10-delta=${run.report.paraphrase.meanRecallDelta >= 0 ? "+" : ""}${run.report.paraphrase.meanRecallDelta.toFixed(3)}`);
````
with:
````ts
        const o = run.report.overall;
        console.log(`\noverall  n=${o.n}  recall@1=${o.recallAt1.toFixed(2)}  recall@5=${o.recallAt5.toFixed(2)}  recall@10=${o.recallAt10.toFixed(2)}  mrr=${o.mrr.toFixed(2)}  ndcg@10=${o.ndcgAt10 === null ? "n/a" : o.ndcgAt10.toFixed(2)}`);
        for (const [kind, m] of Object.entries(run.report.byKind)) console.log(`${kind.padEnd(11)} n=${m.n}  recall@10=${m.recallAt10.toFixed(2)}  mrr=${m.mrr.toFixed(2)}`);
        for (const line of breakdownLines(run.report)) console.log(line);
        const ng = run.report.negatives;
        if (ng.n) console.log(`negatives   n=${ng.n}  abstention=${ng.abstentionRate.toFixed(2)}  false-answer=${ng.falseAnswerRate.toFixed(2)}`);
        if (run.report.paraphrase.n) console.log(`paraphrase  n=${run.report.paraphrase.n}  consistency=${run.report.paraphrase.consistency.toFixed(2)}  mean-recall@10-delta=${run.report.paraphrase.meanRecallDelta >= 0 ? "+" : ""}${run.report.paraphrase.meanRecallDelta.toFixed(3)}`);
````

In `src/cli.ts`, replace:
````ts
        await saveBaseline(opts.baseline, { recordedAt: new Date().toISOString(), commit, goldenIds, report: run.report, ranks: run.ranks });
        console.log(`baseline written to ${opts.baseline} at ${commit}`);
      }
    } finally {
      await ctx.sql.end();
    }
````
with:
````ts
        await saveBaseline(opts.baseline, { recordedAt: new Date().toISOString(), commit, goldenIds, report: run.report, ranks: run.ranks });
        console.log(`baseline written to ${opts.baseline} at ${commit}`);
      }
    } catch (e) {
      throw evalDatabaseHint(e, corpus);
    } finally {
      await ctx.sql.end();
    }
````

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/unit/metrics.test.ts test/unit/baseline.test.ts test/unit/eval.test.ts test/unit/eval-db-guard.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck, the unit suite, and the CLI on an empty golden file**

Run:
```bash
npm run typecheck && npm run test:unit
: > /tmp/brain-empty-golden.jsonl
OBSIDIAN_AUTO=0 npm run brain -- eval run --golden /tmp/brain-empty-golden.jsonl
OBSIDIAN_AUTO=0 npm run brain -- eval run --corpus real
OBSIDIAN_AUTO=0 npm run brain -- eval run --corpus bogus
```
Expected: no type errors; unit 409 passed. The first run (no items, so no search and no Voyage call) prints `eval: no fixtures items in /tmp/brain-empty-golden.jsonl`, `overall  n=0 …`, `approved  owner=0  agent=0`, the attribution, voyage (`tokens=0`) and two verifier lines, and exits 0. The second fails with `database "brain_real_eval" does not exist; create it with npm run eval:prepare-real, then npm run brain -- eval sync` (Task 5 creates it). The third fails with `--corpus must be fixtures or real, got "bogus"`.

- [ ] **Step 9: Commit**

```bash
git add src/eval/metrics.ts src/eval/baseline.ts src/eval/run.ts src/eval/db.ts src/cli.ts test/unit/metrics.test.ts test/unit/baseline.test.ts test/unit/eval.test.ts test/unit/eval-db-guard.test.ts
git commit -m "Eval report per source (fixture, generated, captured) and per approver; eval run --corpus fixtures|real against brain_eval or brain_real_eval with its own baseline; a missing eval database says how to create it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `brain eval sync`: the real base copied into `brain_real_eval`

**Files:**
- Modify: `scripts/prepare-eval-db.sh`
- Create: `scripts/sync-eval-db.sh`
- Create: `src/eval/sync.ts`
- Modify: `src/cli.ts`
- Modify: `package.json`
- Create: `test/unit/eval-sync.test.ts`
- Create: `test/integration/eval-sync.test.ts`

`brain eval sync` replaces `brain_real_eval`'s documents, chunks (embeddings included), ingest jobs, nodes, edges, mentions, facts, extractions and fact events with the real base's, and empties its `retrieval_log` and `verification_log`; `provider_usage` is kept, so the eval's daily Voyage cap still counts the day's spend. No model or Voyage call is made, and the source is only read. Why `pg_dump | psql` inside the container rather than dblink, and why no `--disable-triggers`, is in the decisions above. `syncPlan` checks the URLs (target an eval database, source not one, different databases, both on the local server and the same port); the script checks the names again, that the container is running and publishes the port, and that the target has every table; the restore is one transaction, and the row counts of source and target are compared at the end. Generated columns (`chunks.tsv`, `documents.summary_tsv`) are not dumped and are recomputed by the target, so keyword search works there at once.

**Order matters in this task.** The integration test runs `scripts/prepare-eval-db.sh --reset` with `EVAL_DB=<test database>_sync_eval`. The current script ignores `EVAL_DB` and would drop and recreate `brain_eval` itself, losing the ingested corpus. Step 3 changes the script before Step 4 writes the test, and the test refuses to run against a script that does not read `EVAL_DB`.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/eval-sync.test.ts`:
````ts
import { describe, it, expect } from "vitest";
import { syncPlan } from "../../src/eval/sync.js";

const url = (db: string, host = "127.0.0.1", port = "55322") => `postgresql://postgres:postgres@${host}:${port}/${db}`;

describe("syncPlan", () => {
  it("copies from the knowledge base into a *_eval database on the same local server", () => {
    expect(syncPlan(url("postgres"), url("brain_real_eval"))).toEqual({ sourceDb: "postgres", targetDb: "brain_real_eval", port: "55322" });
    expect(syncPlan(url("postgres", "localhost"), url("brain_real_eval"))).toMatchObject({ port: "55322" });
  });
  it("refuses a target whose name does not end in _eval, or that carries a redirecting parameter", () => {
    expect(() => syncPlan(url("postgres"), url("brain_real"))).toThrow(/must end in _eval/);
    expect(() => syncPlan(url("postgres"), url("brain_real_eval") + "?database=postgres")).toThrow(/parameter "database"/);
  });
  it("refuses an eval database as the source, and the same database on both sides", () => {
    expect(() => syncPlan(url("brain_eval"), url("brain_real_eval"))).toThrow(/the source "brain_eval" is an eval database/);
    expect(() => syncPlan(url("brain_real_eval"), url("brain_real_eval"))).toThrow(/is an eval database/);
  });
  it("refuses a remote server or two different ports, since the copy runs inside the local container", () => {
    expect(() => syncPlan(url("postgres", "db.example.com"), url("brain_real_eval"))).toThrow(/DATABASE_URL must name the local Supabase server/);
    expect(() => syncPlan(url("postgres", "127.0.0.1", "5432"), url("brain_real_eval"))).toThrow(/must name the same server/);
  });
  it("refuses names that are not plain identifiers", () => {
    expect(() => syncPlan(url("Post-gres"), url("brain_real_eval"))).toThrow(/source database name must be a lower-case identifier/);
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/eval-sync.test.ts`
Expected: FAIL: `Failed to load url ../../src/eval/sync.js` (the module does not exist).

- [ ] **Step 3: `prepare-eval-db.sh` takes `EVAL_DB`**

Replace the whole of `scripts/prepare-eval-db.sh` with:
````bash
#!/usr/bin/env bash
# Create an eval database from the migrations if it does not exist, so the eval never touches the real knowledge base
# (the `postgres` database of the same local server). EVAL_DB names it: brain_eval (default) holds the fixture corpus,
# brain_real_eval the copy of the real base that `brain eval sync` fills; the name must end in _eval. Pass --reset to
# drop and recreate it; the ingested corpus costs model and embedding calls, so by default it is kept.
set -euo pipefail

ADMIN_URL="${EVAL_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:55322/postgres}"
EVAL_DB="${EVAL_DB:-brain_eval}"
if [[ ! "$EVAL_DB" =~ ^[a-z_][a-z0-9_]*_eval$ ]]; then
  echo "EVAL_DB must be a lower-case name ending in _eval, got \"${EVAL_DB}\"" >&2
  exit 1
fi
EVAL_URL="${ADMIN_URL%/*}/${EVAL_DB}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "${1:-}" == "--reset" ]]; then
  psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "drop database if exists ${EVAL_DB} with (force)"
fi

exists="$(psql "$ADMIN_URL" -At -c "select 1 from pg_database where datname = '${EVAL_DB}'")"
if [[ "$exists" == "1" ]]; then
  echo "${EVAL_DB} exists; pass --reset to recreate it" >&2
  exit 0
fi

psql "$ADMIN_URL" -q -v ON_ERROR_STOP=1 -c "create database ${EVAL_DB}"
psql "$EVAL_URL" -q -v ON_ERROR_STOP=1 -c "create schema if not exists extensions"
for f in "$HERE"/supabase/migrations/*.sql; do
  PGOPTIONS="--client-min-messages=warning" psql "$EVAL_URL" -q -v ON_ERROR_STOP=1 -f "$f"
done
echo "${EVAL_DB} ready ($(ls "$HERE"/supabase/migrations/*.sql | wc -l | tr -d ' ') migrations)" >&2
````

In `package.json`, replace:
````json
    "test:unit": "vitest run test/unit",
    "test:int": "bash scripts/prepare-test-db.sh && vitest run test/integration",
    "eval:prepare": "bash scripts/prepare-eval-db.sh",
    "eval:run": "tsx src/cli.ts eval run --compare",
    "eval:gate": "tsx src/cli.ts eval run --compare --gate",
    "db:start": "supabase start",
````
with:
````json
    "test:unit": "vitest run test/unit",
    "test:int": "bash scripts/prepare-test-db.sh && vitest run test/integration",
    "eval:prepare": "bash scripts/prepare-eval-db.sh",
    "eval:prepare-real": "EVAL_DB=brain_real_eval bash scripts/prepare-eval-db.sh",
    "eval:run": "tsx src/cli.ts eval run --compare",
    "eval:gate": "tsx src/cli.ts eval run --compare --gate",
    "db:start": "supabase start",
````

Then check the script refuses a name that is not an eval database, and leaves `brain_eval` alone:

Run: `EVAL_DB=brain_test bash scripts/prepare-eval-db.sh; echo "exit $?"; bash scripts/prepare-eval-db.sh; echo "exit $?"`
Expected: `EVAL_DB must be a lower-case name ending in _eval, got "brain_test"`, `exit 1`; then `brain_eval exists; pass --reset to recreate it`, `exit 0`.

- [ ] **Step 4: Write the failing integration test**

Create `test/integration/eval-sync.test.ts`:
````ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { testDb, wipe, fakeCtx, TEST_DATABASE_URL } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { connect, type Db } from "../../src/db.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { search } from "../../src/retrieve/search.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";

const run = promisify(execFile);

// The source is brain_test (seeded below); the target is a throwaway *_eval database named after it.
const sourceDb = new URL(TEST_DATABASE_URL).pathname.slice(1);
const targetDb = `${sourceDb}_sync_eval`;
const port = new URL(TEST_DATABASE_URL).port || "5432";
const adminUrl = process.env.TEST_ADMIN_URL ?? TEST_DATABASE_URL.replace(/\/[^/]+$/, "/postgres");
const targetUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${targetDb}`);
const TABLES = ["documents", "chunks", "ingest_jobs", "nodes", "edges", "mentions", "facts", "extractions", "fact_events"];

const sql = testDb();
let target: Db;

async function sync(src = sourceDb, dst = targetDb) {
  try {
    const { stdout, stderr } = await run("bash", ["scripts/sync-eval-db.sh", src, dst], { env: { ...process.env, SYNC_PORT: port } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function counts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await db.unsafe<{ n: number }[]>(`select count(*)::int as n from brain.${t}`))[0].n;
  return out;
}

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: null } : fakeExtraction;

beforeAll(async () => {
  // An older prepare-eval-db.sh ignores EVAL_DB and would reset brain_eval itself; never run it from here.
  if (!readFileSync("scripts/prepare-eval-db.sh", "utf8").includes('EVAL_DB="${EVAL_DB:-brain_eval}"')) {
    throw new Error("scripts/prepare-eval-db.sh does not read EVAL_DB yet; refusing to run it");
  }
  await run("bash", ["scripts/prepare-eval-db.sh", "--reset"], { env: { ...process.env, EVAL_ADMIN_URL: adminUrl, EVAL_DB: targetDb } });
  target = connect(targetUrl);
  await wipe(sql);
  const ctx = fakeCtx(sql, handler);
  await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT.", sourceKind: "note" });
  await ingest(ctx, { text: "Acme Corp builds the ZX-9000 drill in Austin.", sourceKind: "news" });
  const [fact] = await sql<{ id: string }[]>`select id from brain.facts limit 1`;
  await sql`insert into brain.fact_events (fact_id, event, by, detail) values (${fact.id}, 'restored', 'test', '{}'::jsonb)`;
  await search(ctx, "Acme visa", { client: "test" });
}, 120_000);

afterAll(async () => {
  await target?.end();
  await sql.end();
  const admin = connect(adminUrl);
  await admin.unsafe(`drop database if exists ${targetDb} with (force)`);
  await admin.end();
});

describe("scripts/sync-eval-db.sh", () => {
  it("replaces the target's content with the source's, embeddings and ids included, and leaves the source alone", async () => {
    await target`insert into brain.documents (content_hash, raw_content) values ('stale', 'left over from an earlier sync')`;
    await target`insert into brain.retrieval_log (query) values ('an old eval search')`;
    const before = await counts(sql);
    const sourceLog = (await sql<{ n: number }[]>`select count(*)::int as n from brain.retrieval_log`)[0].n;
    const res = await sync();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`synced ${sourceDb} -> ${targetDb}: documents 2, chunks `);
    expect(res.stderr).not.toContain("circular foreign-key");
    expect(await counts(target)).toEqual(before);
    expect(await counts(sql)).toEqual(before);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from brain.retrieval_log`)[0].n).toBe(sourceLog);
    expect((await target<{ n: number }[]>`select count(*)::int as n from brain.retrieval_log`)[0].n).toBe(0);
    expect(await target`select 1 from brain.documents where content_hash = 'stale'`).toHaveLength(0);
    const [s] = await sql<{ id: string; e: string }[]>`select id, embedding::text as e from brain.chunks where embedding is not null order by id limit 1`;
    const [t] = await target<{ e: string; keyword: boolean }[]>`select embedding::text as e, tsv @@ plainto_tsquery('english', 'Acme') as keyword from brain.chunks where id = ${s.id}`;
    expect(t.e).toBe(s.e);
    expect(t.keyword).toBe(true);
    expect(await target`select 1 from brain.chunks where tsv is null`).toHaveLength(0);
    const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
    expect(await target<{ id: string }[]>`select id from brain.nodes where is_self`).toEqual([{ id: self.id }]);
  });

  it("is repeatable: a second sync gives the same counts", async () => {
    expect((await sync()).code).toBe(0);
    expect(await counts(target)).toEqual(await counts(sql));
  });

  it("refuses a target that is not an eval database and a source that is one, before touching anything", async () => {
    const bad = await sync(sourceDb, sourceDb);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain(`sync: refusing to write to "${sourceDb}": the target database name must end in _eval`);
    const evalSource = await sync(targetDb, targetDb);
    expect(evalSource.code).toBe(1);
    expect(evalSource.stderr).toContain(`the source "${targetDb}" is an eval database`);
  });

  it("leaves the target unchanged when the dump fails", async () => {
    const before = await counts(target);
    const res = await sync(`${sourceDb}_missing`, targetDb);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(`the copy failed; ${targetDb} is unchanged`);
    expect(await counts(target)).toEqual(before);
  });
});
````

- [ ] **Step 5: Run it to verify it fails**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-sync.test.ts`
Expected: FAIL, 4 tests, each with `expected 127 to be …` (bash cannot find `scripts/sync-eval-db.sh`). The throwaway database `brain_test_sync_eval` is created in `beforeAll` and dropped in `afterAll`.

- [ ] **Step 6: The sync script**

Create `scripts/sync-eval-db.sh`:
````bash
#!/usr/bin/env bash
# Copy the knowledge base's content from <source> into <target> (a database whose name ends in _eval, created by
# EVAL_DB=<target> scripts/prepare-eval-db.sh), replacing what the target held. No model or Voyage call is made:
# embeddings are copied as stored. Run by `npm run brain -- eval sync`.
#
# Both databases live on the local Supabase server, so the dump and the restore run inside its container with the
# server's own pg_dump and psql (same version; the backup steps of the phase plans use them too). pg_dump only reads: it runs in a
# read-only snapshot transaction, and the source is additionally opened with default_transaction_read_only=on.
# The restore is one transaction: truncate, copy, commit. If anything fails the target is left as it was.
set -euo pipefail

usage="usage: sync-eval-db.sh <source database> <target database ending in _eval>"
SRC="${1:?$usage}"
DST="${2:?$usage}"
CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_brain}"
# Content tables, in no particular order (pg_dump orders the data by foreign keys). Registries (node_types,
# edge_types) come from the migrations on both sides; logs (retrieval_log, verification_log, tool_calls,
# provider_usage) are not copied.
TABLES=(documents chunks ingest_jobs nodes edges mentions facts extractions fact_events)

die() { echo "sync: $*" >&2; exit 1; }

for n in "$SRC" "$DST"; do
  [[ "$n" =~ ^[a-z_][a-z0-9_]*$ ]] || die "database names must be lower-case identifiers, got \"$n\""
done
[[ "$DST" == *_eval ]] || die "refusing to write to \"$DST\": the target database name must end in _eval"
[[ "$SRC" != *_eval ]] || die "the source \"$SRC\" is an eval database; sync copies the knowledge base into an eval database"
[[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == "true" ]] || die "container $CONTAINER is not running (npm run db:start)"
if [[ -n "${SYNC_PORT:-}" ]]; then
  docker port "$CONTAINER" 5432/tcp | grep -q ":${SYNC_PORT}\$" || die "container $CONTAINER does not publish port ${SYNC_PORT}; the URLs name another server"
fi

src_psql() { docker exec -i -e PGOPTIONS="-c default_transaction_read_only=on" "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -d "$SRC" "$@"; }
dst_psql() { docker exec -i "$CONTAINER" psql -U postgres -X -q -v ON_ERROR_STOP=1 -d "$DST" "$@"; }

list="$(printf "'%s'," "${TABLES[@]}")"
list="${list%,}"
missing="$(dst_psql -At -c "select coalesce(string_agg(t, ', '), '') from unnest(array[${list}]) t where to_regclass('brain.' || t) is null")"
[[ -z "$missing" ]] || die "$DST lacks brain tables ($missing); create it with EVAL_DB=$DST bash scripts/prepare-eval-db.sh"

counts_sql="$(for t in "${TABLES[@]}"; do printf "select '%s', count(*) from brain.%s union all " "$t" "$t"; done)"
counts_sql="${counts_sql% union all }"

dump_args=()
for t in "${TABLES[@]}"; do dump_args+=(-t "brain.$t"); done
truncate_list="$(printf "brain.%s, " "${TABLES[@]}")brain.retrieval_log, brain.verification_log"

errfile="$(mktemp)"
trap 'rm -f "$errfile"' EXIT
# A failed pg_dump stops the group before "commit;", so psql reaches the end of its input inside the transaction and
# rolls it back: the target keeps what it had.
if ! {
  echo "begin;"
  echo "truncate ${truncate_list} restart identity;"
  docker exec -e PGOPTIONS="-c default_transaction_read_only=on" "$CONTAINER" \
    pg_dump -U postgres -d "$SRC" --data-only --no-owner --no-privileges "${dump_args[@]}" 2>"$errfile" || exit 1
  echo "commit;"
} | dst_psql >/dev/null; then
  cat "$errfile" >&2
  die "the copy failed; $DST is unchanged"
fi
# pg_dump warns that chunks, nodes and facts reference themselves (parent_id, merged_into, superseded_by). The copy
# of each table is one COPY statement, and foreign keys are checked at its end, so the order of rows within a table
# does not matter; the warning is dropped and anything else is shown.
grep -v -E '^pg_dump: (warning: there are circular foreign-key constraints on this table:|detail: (chunks|nodes|facts)$|hint: )' "$errfile" >&2 || true

src_counts="$(src_psql -At -F ' ' -c "$counts_sql")"
dst_counts="$(dst_psql -At -F ' ' -c "$counts_sql")"
[[ "$src_counts" == "$dst_counts" ]] || die "row counts differ after the copy (source vs target):
$(paste <(echo "$src_counts") <(echo "$dst_counts"))"
echo "synced $SRC -> $DST: $(echo "$dst_counts" | paste -sd ',' - | sed 's/,/, /g')"
````

Run: `chmod +x scripts/sync-eval-db.sh`

- [ ] **Step 7: The URL check and the command**

Create `src/eval/sync.ts`:
````ts
import { spawn } from "node:child_process";
import { assertEvalDatabase } from "./db.js";

/** What `brain eval sync` copies from and to, read from two connection URLs. */
export interface SyncPlan {
  sourceDb: string;
  targetDb: string;
  /** The port both URLs name; scripts/sync-eval-db.sh checks the Supabase container publishes it. */
  port: string;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Checks the source and target before anything runs. The copy runs inside the local Supabase container, which reaches
 * databases by name, so both URLs must name that local server (same host class, same port); the target must be an eval
 * database (assertEvalDatabase: the name ends in _eval, no query parameter that could redirect it); the source must not
 * be one, and the two must differ.
 */
export function syncPlan(sourceUrl: string, targetUrl: string): SyncPlan {
  assertEvalDatabase(targetUrl);
  const src = new URL(sourceUrl);
  const dst = new URL(targetUrl);
  const name = (u: URL) => decodeURIComponent(u.pathname.replace(/^\//, ""));
  const sourceDb = name(src);
  const targetDb = name(dst);
  for (const [role, db] of [["source", sourceDb], ["target", targetDb]] as const) {
    if (!IDENTIFIER.test(db)) throw new Error(`eval sync: the ${role} database name must be a lower-case identifier, got "${db}"`);
  }
  if (sourceDb.endsWith("_eval")) throw new Error(`eval sync: the source "${sourceDb}" is an eval database; DATABASE_URL must name the knowledge base`);
  if (sourceDb === targetDb) throw new Error("eval sync: source and target are the same database");
  for (const [role, u] of [["DATABASE_URL", src], ["EVAL_REAL_DATABASE_URL", dst]] as const) {
    if (!LOCAL_HOSTS.has(u.hostname)) throw new Error(`eval sync: ${role} must name the local Supabase server (127.0.0.1 or localhost), got ${u.hostname}`);
  }
  const port = (u: URL) => u.port || "5432";
  if (port(src) !== port(dst)) throw new Error(`eval sync: DATABASE_URL (port ${port(src)}) and EVAL_REAL_DATABASE_URL (port ${port(dst)}) must name the same server`);
  return { sourceDb, targetDb, port: port(dst) };
}

/** Runs scripts/sync-eval-db.sh with the plan; its output goes to this process's stdout and stderr. Resolves with its exit code. */
export function runSync(plan: SyncPlan, script = "scripts/sync-eval-db.sh"): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, plan.sourceDb, plan.targetDb], { stdio: "inherit", env: { ...process.env, SYNC_PORT: plan.port } });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
````

In `src/cli.ts`, replace:
````ts
    }
  });

evalCmd
  .command("run")
  .description("Run the golden set's items for one corpus and report metrics; --compare shows deltas against the baseline")
````
with:
````ts
    }
  });

evalCmd
  .command("sync")
  .description("Copy the real knowledge base (DATABASE_URL) into brain_real_eval (EVAL_REAL_DATABASE_URL), replacing its documents, chunks with embeddings, graph and facts; no model or Voyage call, nothing written to the source")
  .action(async () => {
    const { EVAL_REAL_DATABASE_URL } = await import("./eval/db.js");
    const { syncPlan, runSync } = await import("./eval/sync.js");
    const plan = syncPlan(config.databaseUrl, EVAL_REAL_DATABASE_URL);
    console.log(`eval sync: ${plan.sourceDb} -> ${plan.targetDb} (port ${plan.port}); the target's content is replaced, the source is only read`);
    process.exitCode = await runSync(plan);
  });

evalCmd
  .command("run")
  .description("Run the golden set's items for one corpus and report metrics; --compare shows deltas against the baseline")
````

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/unit/eval-sync.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-sync.test.ts`
Expected: PASS (5 unit tests; 4 integration tests). The sync's stderr carries no `circular foreign-key` warning (the script drops that known pg_dump warning and shows anything else).

- [ ] **Step 9: Typecheck and the suites**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: no type errors; unit 414 passed; integration 311 passed. `psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -Atc "select count(*) from pg_database where datname like '%_sync_eval'"` prints `0` (the test dropped its database).

- [ ] **Step 10: Commit**

```bash
git add scripts/prepare-eval-db.sh scripts/sync-eval-db.sh src/eval/sync.ts src/cli.ts package.json test/unit/eval-sync.test.ts test/integration/eval-sync.test.ts
git commit -m "eval sync: the real base's documents, chunks with embeddings, graph, facts, extractions, jobs and fact events copied into brain_real_eval with the server's own pg_dump and psql in one transaction; no model or Voyage call; the source is only read; prepare-eval-db.sh takes EVAL_DB

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Drafting golden questions and the review sheet (library)

**Files:**
- Create: `src/eval/draft.ts`
- Create: `src/eval/review.ts`
- Create: `test/unit/eval-draft.test.ts`
- Create: `test/unit/eval-review.test.ts`
- Create: `test/integration/eval-draft.test.ts`

`draftDocuments` selects documents from the corpus's eval database (skipping, unless forced, any document with a pending draft or a golden item; `--doc`, `--since` and `--limit` narrow it), makes one `ctx.llm.structured` call per document with `DRAFT_SYSTEM`, the document (metadata and text, cut at 40,000 characters) and the other documents' titles, and checks every question with `draftProblems`. A failed call is reported and the run goes on. Passing drafts are appended to `eval/drafts.jsonl` and written to one new sheet, `eval/review/<date>-<n>.md`.

The automatic checks, in `draftProblems`:

| Check | Rule |
|---|---|
| Document exists | The draft's document is in the eval database (by id, or by origin for a rebuilt `brain_eval`). |
| Quote verbatim | The quote appears in the document's stored text after collapsing ASCII whitespace runs (as the eval's own quote matching does); case and punctuation must match. |
| Question without its quote | The question, lower-cased and whitespace-collapsed, does not contain the quote. |
| Not a duplicate | No golden item or other draft has the same normalised question (lower case, runs of non-letters and non-digits as one space) or a Postgres english stem set with Jaccard overlap ≥ 0.8. |
| Valid golden item | The item it would become passes `validateGoldenItem` (kind, fields, filter source kinds, fixtures named by origin). Also: exactly two paraphrases for a question, none and no quote for a negative, and an attribution question only for a document the owner did not write. |

The sheet is Markdown: an introduction (free text, ignored when read back), then one `## d-…` section per draft with `document:`, `decision:`, `kind:`, `question:`, and for a question `quote:` and `paraphrases:` with two `- ` lines. An example section:

```markdown
## d-3f9a2b1c0e

document: job_description--acme-data-analyst-ii.md
decision: edit
kind: keyword
question: What is the salary range for Acme's Data Analyst II opening?
quote: Base salary range $92,000 to $108,000.
paraphrases:
- How much does the Acme Data Analyst II job pay?
- Acme Data Analyst II salary band
```

`parseSheet` accepts CRLF, trailing spaces and blank lines, and reports every other deviation with its line number before anything is applied: a heading that is not `## d-` plus 10 hex digits, an unknown key, a key given twice, a `- ` line outside `paraphrases:`, an empty paraphrase, a decision other than `keep`, `edit`, `reject` or empty, a missing `document:`, `decision:`, `kind:` or `question:` line, an id given twice. `applySheet` then checks every decided item and applies all or nothing. `approveSheetFile` wraps both with the files and the eval database.

- [ ] **Step 1: Write the failing unit tests**

Create `test/unit/eval-draft.test.ts`:
````ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DraftOutputSchema, DUPLICATE_STEM_JACCARD, MAX_DRAFT_CHARS, normalizeQuestion, draftId, docKey, stemJaccard, duplicateOf, quoteInDocument,
  questionContainsQuote, toGoldenItem, draftProblems, draftUserMessage, nextSheetPath, loadDrafts, saveDrafts, type Draft, type CorpusDocument,
} from "../../src/eval/draft.js";
import { validateGoldenItem } from "../../src/eval/golden.js";

const TEXT = "## Compensation and visa\n\nBase salary range $115,000 to $140,000. Acme sponsors H-1B for this role.\nHybrid, three days a week in the Austin office.";
const doc = { id: "0b9c6a38-1111-4222-8333-444455556666", origin: "eval/corpus/job_description--acme-senior-data-analyst.md", title: "Senior Data Analyst, Acme Corp", source_kind: "job_description", author: "other" };

function draft(over: Partial<Draft> = {}): Draft {
  return {
    draft_id: "d-0123456789", corpus: "fixtures", kind: "keyword", question: "What is the pay range for the Acme analyst job?",
    quote: "Base salary range $115,000 to $140,000.", paraphrases: ["How much does the Acme analyst role pay?", "Acme analyst salary band"],
    document: doc, drafted_at: "2026-10-03T10:00:00.000Z", model: "fake", sheet: "eval/review/2026-10-03-1.md", ...over,
  };
}

/** A stem map by hand, as stemAll would build it from Postgres. */
const stems = new Map<string, string[]>([
  ["What is the pay range for the Acme analyst job?", ["acm", "analyst", "job", "pay", "rang"]],
  ["What's the Acme analyst job pay range?", ["acm", "analyst", "job", "pay", "rang"]],
  ["What is the pay range for the Northwind analyst job?", ["analyst", "job", "northwind", "pay", "rang"]],
  ["Who led Acme's Series B?", ["acm", "b", "led", "seri"]],
  ["Who led the Acme Series B round?", ["acm", "b", "led", "round", "seri"]],
]);

describe("question identity", () => {
  it("normalises case, punctuation and spacing", () => {
    expect(normalizeQuestion("  What's the  Acme   role's PAY?! ")).toBe("what s the acme role s pay");
  });
  it("gives a stable id per document and normalised question", () => {
    const a = draftId("job.md", "What is the pay?");
    expect(a).toMatch(/^d-[0-9a-f]{10}$/);
    expect(draftId("job.md", "what is the PAY")).toBe(a);
    expect(draftId("other.md", "What is the pay?")).not.toBe(a);
  });
  it("names fixture documents by file name and real documents by id", () => {
    expect(docKey("fixtures", doc)).toBe("job_description--acme-senior-data-analyst.md");
    expect(docKey("real", doc)).toBe(doc.id);
  });
});

describe("duplicates", () => {
  it("Jaccard over distinct stems, 0 when either side is empty", () => {
    expect(stemJaccard(["a", "b", "c"], ["a", "b", "d"])).toBe(0.5);
    expect(stemJaccard([], ["a"])).toBe(0);
    expect(DUPLICATE_STEM_JACCARD).toBe(0.8);
  });
  it("flags equal normalised text and stem overlap of at least 0.8, and not a question about another company", () => {
    const others = [{ id: "q01", question: "What is the pay range for the Acme analyst job?" }];
    expect(duplicateOf("what is the PAY range for the acme analyst job", others, stems)).toBe("q01");
    expect(duplicateOf("What's the Acme analyst job pay range?", others, stems)).toBe("q01");
    expect(duplicateOf("What is the pay range for the Northwind analyst job?", others, stems)).toBeNull(); // 4/6
    expect(duplicateOf("Who led the Acme Series B round?", [{ id: "q02", question: "Who led Acme's Series B?" }], stems)).toBe("q02"); // 4/5
  });
});

describe("quote checks", () => {
  it("finds the quote verbatim after collapsing whitespace, but not with other case or punctuation", () => {
    expect(quoteInDocument("Base salary range $115,000 to $140,000.", TEXT)).toBe(true);
    expect(quoteInDocument("$140,000. Acme sponsors   H-1B", TEXT)).toBe(true);
    expect(quoteInDocument("Acme sponsors H-1B for this role. Hybrid, three days", TEXT)).toBe(true); // across a line break
    expect(quoteInDocument("base salary range $115,000", TEXT)).toBe(false);
    expect(quoteInDocument("Base salary range $115000", TEXT)).toBe(false);
    expect(quoteInDocument("   ", TEXT)).toBe(false);
  });
  it("catches a question that contains its own quote, in any case", () => {
    expect(questionContainsQuote("Does ACME SPONSORS H-1B for this role?", "Acme sponsors H-1B for this role")).toBe(true);
    expect(questionContainsQuote("Does Acme sponsor visas?", "Acme sponsors H-1B for this role")).toBe(false);
  });
});

describe("toGoldenItem", () => {
  it("makes a generated item approved by the owner, naming a fixture by file name and a real document by id", () => {
    const item = toGoldenItem(draft(), "2026-10-04", false);
    expect(item).toEqual({
      id: "d-0123456789", question: "What is the pay range for the Acme analyst job?", kind: "keyword",
      expected: [{ origin: "job_description--acme-senior-data-analyst.md", quote: "Base salary range $115,000 to $140,000." }],
      paraphrases: ["How much does the Acme analyst role pay?", "Acme analyst salary band"], source: "generated", negative: false,
      corpus: "fixtures", approved_by: "owner", approved_at: "2026-10-04", edited: false,
    });
    expect(validateGoldenItem(item).ok).toBe(true);
    expect(toGoldenItem(draft({ corpus: "real" }), "2026-10-04", true)).toMatchObject({ expected: [{ document_id: doc.id }], corpus: "real", edited: true });
  });
  it("gives a filter item its document's source kind and a negative item no expected document", () => {
    expect(toGoldenItem(draft({ kind: "filter", question: "Acme pay" }), "2026-10-04", false)).toMatchObject({ filters: { sourceKinds: ["job_description"] } });
    expect(toGoldenItem(draft({ kind: "negative", quote: null, paraphrases: [] }), "2026-10-04", false)).toMatchObject({ expected: [], negative: true, kind: "negative" });
  });
});

describe("draftProblems", () => {
  const ok = { documentText: TEXT, others: [], stems };
  it("passes a good draft", () => {
    expect(draftProblems(draft(), ok)).toEqual([]);
    expect(draftProblems(draft({ kind: "negative", question: "What is the Acme signing bonus?", quote: null, paraphrases: [] }), ok)).toEqual([]);
  });
  it("lists every failed check", () => {
    expect(draftProblems(draft({ quote: "Base salary range $115k" }), ok)).toEqual(["the quote is not in the document verbatim"]);
    expect(draftProblems(draft({ question: "Is the base salary range $115,000 to $140,000.?" }), ok)).toEqual(["the question contains its own answer quote"]);
    expect(draftProblems(draft(), { ...ok, others: [{ id: "q01", question: "What's the Acme analyst job pay range?" }] })).toEqual(["duplicates q01"]);
    expect(draftProblems(draft(), { ...ok, documentText: null })).toEqual(["its document is not in the eval database"]);
    expect(draftProblems(draft({ paraphrases: ["only one"] }), ok)).toEqual(["a question needs exactly two paraphrases"]);
    expect(draftProblems(draft({ kind: "attribution", document: { ...doc, author: "owner" } }), ok)).toEqual(["an attribution question needs a document the owner did not write"]);
    expect(draftProblems(draft({ kind: "negative" }), ok)).toEqual(["a negative question has no quote and no paraphrases"]);
    expect(draftProblems(draft({ document: { ...doc, origin: null } }), ok)).toEqual(["not a valid golden item: a fixtures item names each expected document by origin"]);
  });
});

describe("model output and prompt", () => {
  it("wants one to three questions with exactly two paraphrases each, and one negative", () => {
    const q = { kind: "keyword", question: "q", quote: "a quote", paraphrases: ["p1", "p2"] };
    expect(DraftOutputSchema.safeParse({ questions: [q], negative: { question: "n" } }).success).toBe(true);
    expect(DraftOutputSchema.safeParse({ questions: [{ ...q, paraphrases: ["p1"] }], negative: { question: "n" } }).success).toBe(false);
    expect(DraftOutputSchema.safeParse({ questions: [q, q, q, q], negative: { question: "n" } }).success).toBe(false);
    expect(DraftOutputSchema.safeParse({ questions: [{ ...q, kind: "negative" }], negative: { question: "n" } }).success).toBe(false);
    expect(DraftOutputSchema.safeParse({ questions: [q] }).success).toBe(false);
  });
  it("sends the document's metadata, its text cut at the limit, and the other titles", () => {
    const d: CorpusDocument = { ...doc, author: "owner", raw_content: "x".repeat(MAX_DRAFT_CHARS + 5), occurred_at: new Date("2026-09-26T00:00:00Z"), ingested_at: new Date() };
    const msg = draftUserMessage(d, ["Moved to Denver [note]"]);
    expect(msg).toContain("source kind: job_description\nauthor: owner (the owner, Frank Fu)\ndate: 2026-09-26");
    expect(msg).toContain("x".repeat(MAX_DRAFT_CHARS) + "\n[document cut here]\n---");
    expect(msg).not.toContain("x".repeat(MAX_DRAFT_CHARS + 1));
    expect(msg.endsWith("Other documents in the corpus:\n- Moved to Denver [note]")).toBe(true);
  });
});

describe("files", () => {
  it("numbers review sheets per day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-"));
    expect(await nextSheetPath(join(dir, "missing"), "2026-10-03")).toBe(join(dir, "missing", "2026-10-03-1.md"));
    await writeFile(join(dir, "2026-10-03-1.md"), "");
    await writeFile(join(dir, "2026-10-03-2.md"), "");
    await writeFile(join(dir, "2026-10-02-7.md"), "");
    expect(await nextSheetPath(dir, "2026-10-03")).toBe(join(dir, "2026-10-03-3.md"));
  });
  it("saves and loads drafts, and rejects a malformed or repeated line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drafts-"));
    const path = join(dir, "drafts.jsonl");
    expect(await loadDrafts(path)).toEqual([]);
    await saveDrafts(path, [draft(), draft({ draft_id: "d-aaaaaaaaaa" })]);
    expect((await loadDrafts(path)).map((d) => d.draft_id)).toEqual(["d-0123456789", "d-aaaaaaaaaa"]);
    await writeFile(path, JSON.stringify(draft()) + "\n" + JSON.stringify(draft()) + "\n");
    await expect(loadDrafts(path)).rejects.toThrow(/drafts line 2: duplicate draft id d-0123456789/);
    await writeFile(path, JSON.stringify({ ...draft(), extra: 1 }) + "\n");
    await expect(loadDrafts(path)).rejects.toThrow(/drafts line 1: .*extra/);
  });
});
````

Create `test/unit/eval-review.test.ts`:
````ts
import { describe, it, expect } from "vitest";
import { renderSheet, parseSheet, applySheet, documentLine, type ApplyContext } from "../../src/eval/review.js";
import { parseGolden } from "../../src/eval/golden.js";
import type { Draft } from "../../src/eval/draft.js";

const TEXT = "## Compensation and visa\n\nBase salary range $115,000 to $140,000. Acme sponsors H-1B for this role.\nHybrid, three days a week in the Austin office.";
const doc = { id: "0b9c6a38-1111-4222-8333-444455556666", origin: "eval/corpus/job_description--acme-senior-data-analyst.md", title: "Senior Data Analyst, Acme Corp", source_kind: "job_description", author: "other" };

function draft(over: Partial<Draft> = {}): Draft {
  return {
    draft_id: "d-0123456789", corpus: "fixtures", kind: "keyword", question: "What is the pay range for the Acme analyst job?",
    quote: "Base salary range $115,000 to $140,000.", paraphrases: ["How much does the Acme analyst role pay?", "Acme analyst salary band"],
    document: doc, drafted_at: "2026-10-03T10:00:00.000Z", model: "fake", sheet: "eval/review/2026-10-03-1.md", ...over,
  };
}

const keyword = draft();
const semantic = draft({ draft_id: "d-1111111111", kind: "semantic", question: "Can a foreign graduate get a work visa through this Acme job?", quote: "Acme sponsors H-1B for this role.", paraphrases: ["Will Acme sponsor my visa?", "visa sponsorship at Acme"] });
const negative = draft({ draft_id: "d-2222222222", kind: "negative", question: "What signing bonus does Acme offer?", quote: null, paraphrases: [] });
const drafts = [keyword, semantic, negative];
const info = { sheet: "eval/review/2026-10-03-1.md", corpus: "fixtures" as const, model: "opus", day: "2026-10-03", documents: 1 };

const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({ drafts, golden: [], documentText: () => TEXT, stems: new Map(), today: "2026-10-04", ...over });

/** The rendered sheet with each item's `decision:` line set, in item order. */
function decide(text: string, ...decisions: string[]): string {
  let i = 0;
  return text.replace(/^decision:$/gm, () => `decision: ${decisions[i++] ?? ""}`.trimEnd());
}

describe("renderSheet", () => {
  it("writes the instructions, then one section per draft with an empty decision", () => {
    const text = renderSheet(drafts, info);
    expect(text.startsWith("# Eval review 2026-10-03-1\n\nDrafted 2026-10-03 by opus from 1 document of the fixtures corpus: 3 questions.")).toBe(true);
    expect(text).toContain("Apply: `npm run brain -- eval approve --sheet eval/review/2026-10-03-1.md`");
    expect(text).toContain([
      "## d-0123456789", "", "document: job_description--acme-senior-data-analyst.md", "decision:", "kind: keyword",
      "question: What is the pay range for the Acme analyst job?", "quote: Base salary range $115,000 to $140,000.", "paraphrases:",
      "- How much does the Acme analyst role pay?", "- Acme analyst salary band",
    ].join("\n"));
    expect(text).toContain([
      "## d-2222222222", "", "document: none (negative question, drafted from job_description--acme-senior-data-analyst.md)", "decision:", "kind: negative",
      "question: What signing bonus does Acme offer?",
    ].join("\n"));
    expect(documentLine(draft({ corpus: "real" }))).toBe(`Senior Data Analyst, Acme Corp (${doc.id})`);
  });
});

describe("parseSheet", () => {
  it("reads every section back, decisions empty", () => {
    const items = parseSheet(renderSheet(drafts, info));
    expect(items.map((s) => [s.draftId, s.decision, s.kind])).toEqual([["d-0123456789", null, "keyword"], ["d-1111111111", null, "semantic"], ["d-2222222222", null, "negative"]]);
    expect(items[0]).toMatchObject({ line: 14, quote: "Base salary range $115,000 to $140,000.", paraphrases: ["How much does the Acme analyst role pay?", "Acme analyst salary band"] });
    expect(items[2]).toMatchObject({ quote: null, paraphrases: [] });
  });
  it("accepts CRLF line ends, trailing spaces and extra blank lines, as editors leave them", () => {
    const text = decide(renderSheet([keyword], info), "keep").replace(/\n/g, "  \r\n").replace("kind: keyword", "\r\nkind: keyword");
    expect(parseSheet(text)[0]).toMatchObject({ decision: "keep", kind: "keyword" });
  });
  it("reports every problem with its line number, and reads nothing when there is one", () => {
    const bad = renderSheet([keyword], info)
      .replace(/^decision:$/m, "decision: maybe")
      .replace("kind: keyword", "kind: keyword\nkind: semantic\nnotes: looks fine")
      .replace("- Acme analyst salary band", "- Acme analyst salary band\n-")
      .concat("## not-an-id\n");
    expect(() => parseSheet(bad, "s.md")).toThrow(
      [
        "s.md has 5 problems:",
        '  s.md:17: decision must be keep, edit, reject or empty; got "maybe"',
        "  s.md:19: d-0123456789 has a second kind: line",
        '  s.md:20: cannot read "notes: looks fine"; expected one of document: decision: kind: question: quote: paraphrases: or a "- " paraphrase',
        "  s.md:26: empty paraphrase",
        '  s.md:27: a heading must be "## d-" and 10 hex digits, as the sheet was written; got "## not-an-id"',
      ].join("\n"),
    );
  });
  it("puts a stray \"- \" line, outside paraphrases, down as an error", () => {
    const text = renderSheet([keyword], info).replace("kind: keyword", "kind: keyword\n- a note");
    expect(() => parseSheet(text, "s.md")).toThrow('s.md:19: a "- " line belongs under paraphrases:');
  });
  it("requires the document, decision, kind and question lines, and each id once", () => {
    const text = renderSheet([keyword], info).replace(/^decision:\n/m, "");
    expect(() => parseSheet(text, "s.md")).toThrow("s.md:14: d-0123456789 has no decision: line");
    const twice = renderSheet([keyword, keyword], info);
    expect(() => parseSheet(twice, "s.md")).toThrow(/s\.md:\d+: d-0123456789 appears twice/);
  });
});

describe("applySheet", () => {
  it("keeps, edits, rejects and leaves undecided items pending", () => {
    const text = decide(renderSheet(drafts, info), "keep", "edit", "reject").replace("question: Can a foreign graduate get a work visa through this Acme job?", "question: Will Acme sponsor an H-1B for the analyst role?");
    const r = applySheet(parseSheet(text), ctx());
    expect(r.approved.map((a) => [a.id, a.edited, a.approved_by, a.source, a.approved_at])).toEqual([
      ["d-0123456789", false, "owner", "generated", "2026-10-04"],
      ["d-1111111111", true, "owner", "generated", "2026-10-04"],
    ]);
    expect(r.approved[1].question).toBe("Will Acme sponsor an H-1B for the analyst role?");
    expect(r.rejected).toEqual(["d-2222222222"]);
    expect(r.remaining).toEqual([]);
    const pending = applySheet(parseSheet(decide(renderSheet(drafts, info), "keep")), ctx());
    expect(pending.undecided).toEqual(["d-1111111111", "d-2222222222"]);
    expect(pending.remaining.map((d) => d.draft_id)).toEqual(["d-1111111111", "d-2222222222"]);
  });
  it("counts an item applied by an earlier run of the same sheet as already applied", () => {
    const text = decide(renderSheet(drafts, info), "keep", "", "reject");
    const first = applySheet(parseSheet(text), ctx());
    const golden = parseGolden(first.approved.map((a) => JSON.stringify(a)).join("\n"));
    const again = applySheet(parseSheet(text), ctx({ drafts: first.remaining, golden }));
    expect(again).toMatchObject({ approved: [], rejected: [], alreadyApplied: ["d-0123456789", "d-2222222222"], undecided: ["d-1111111111"] });
  });
  it("applies nothing and lists every problem when any item is wrong", () => {
    const text = decide(renderSheet(drafts, info), "keep", "edit", "edit")
      .replace("quote: Base salary range $115,000 to $140,000.", "quote: Base salary range $115,000 to $150,000.")
      .replace("quote: Acme sponsors H-1B for this role.", "quote: Acme sponsors visas.")
      .replace("kind: negative", "kind: keyword")
      .replace("document: job_description--acme-senior-data-analyst.md", "document: somewhere-else.md");
    expect(() => applySheet(parseSheet(text), ctx())).toThrow(
      [
        "nothing applied; fix the sheet and run approve again:",
        '  d-0123456789 (line 14): the document line was changed; it must read "job_description--acme-senior-data-analyst.md"',
        "  d-0123456789 (line 14): decision keep but quote changed; use edit, or undo the change",
        "  d-1111111111 (line 25): the quote is not in the document verbatim",
        "  d-2222222222 (line 36): a negative question cannot become positive",
      ].join("\n"),
    );
  });
  it("rechecks kept items against the golden set and the eval database, and refuses unknown kinds and ids", () => {
    const golden = parseGolden(JSON.stringify({ id: "q01", question: "What is the pay range for the Acme analyst job?", kind: "keyword", expected: [{ origin: "x.md" }], source: "fixture", approved_by: "agent", approved_at: "2026-09-30" }));
    expect(() => applySheet(parseSheet(decide(renderSheet([keyword], info), "keep")), ctx({ golden }))).toThrow(/d-0123456789 \(line 14\): duplicates q01/);
    expect(() => applySheet(parseSheet(decide(renderSheet([keyword], info), "keep")), ctx({ documentText: () => null }))).toThrow(/its document is not in the eval database/);
    const kind = decide(renderSheet([keyword], info), "edit").replace("kind: keyword", "kind: fallback");
    expect(() => applySheet(parseSheet(kind), ctx())).toThrow(/kind must be one of keyword, semantic, graph, filter, attribution; got "fallback"/);
    expect(() => applySheet(parseSheet(decide(renderSheet([keyword], info), "keep")), ctx({ drafts: [] }))).toThrow(/d-0123456789 \(line 14\): no pending draft has this id/);
  });
  it("records edited false for an edit that changed nothing", () => {
    const r = applySheet(parseSheet(decide(renderSheet([keyword], info), "edit")), ctx({ drafts: [keyword] }));
    expect(r.approved[0].edited).toBe(false);
  });
});
````

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/eval-draft.test.ts test/unit/eval-review.test.ts`
Expected: FAIL: `Failed to load url ../../src/eval/draft.js` and `../../src/eval/review.js`.

- [ ] **Step 3: Write the failing integration test**

Create `test/integration/eval-draft.test.ts`:
````ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { FakeLlm } from "../../src/llm/llm.js";
import { draftDocuments, loadDrafts, toGoldenItem, DRAFT_SYSTEM, type DraftOutput } from "../../src/eval/draft.js";
import { approveSheetFile, parseSheet } from "../../src/eval/review.js";
import { loadGolden, validateGoldenItem } from "../../src/eval/golden.js";

const sql = testDb();
afterAll(() => sql.end());

const NOTE = "# Garden plan\n\nI planted 40 tulip bulbs along the north fence on 2026-03-14. The soil there drains slowly, so I mixed in two bags of grit.";
const EMAIL = "# Re: Northwind panel\n\nFrom: Sam Okafor\n\nHi Frank, your panel interview with the analytics team is booked for October 6 at 10:00 in Denver.";

/** The fake model: fixed questions per document, some of which must fail the checks. */
function model(fail: string[] = []) {
  return new FakeLlm(({ system, user }) => {
    if (system !== DRAFT_SYSTEM) throw new Error("unexpected call");
    if (fail.some((f) => user.includes(f))) throw new Error("model unavailable");
    if (user.includes("title: Garden plan")) {
      return {
        questions: [
          { kind: "keyword", question: "How many tulip bulbs did I plant by the fence?", quote: "I planted 40 tulip bulbs along the north fence", paraphrases: ["tulip bulb count", "How many bulbs went in along the fence?"] },
          { kind: "semantic", question: "Why did I add grit to the soil?", quote: "The soil there drains badly", paraphrases: ["reason for the grit", "Why mix grit into the bed?"] },
          { kind: "keyword", question: "Is it true I mixed in two bags of grit?", quote: "mixed in two bags of grit", paraphrases: ["grit bags", "How much grit went in?"] },
        ],
        negative: { question: "What colour were the tulips I planted?" },
      } satisfies DraftOutput;
    }
    return {
      questions: [
        { kind: "attribution", question: "When does Sam say my Northwind panel is?", quote: "booked for October 6 at 10:00 in Denver", paraphrases: ["Northwind panel date", "What day is the panel interview Sam set up?"] },
        { kind: "semantic", question: "When is my Northwind panel interview?", quote: "your panel interview with the analytics team", paraphrases: ["panel interview time", "When do I meet the Northwind analytics team?"] },
      ],
      negative: { question: "Who else is on the Northwind analytics team?" },
    } satisfies DraftOutput;
  });
}

let dir: string;
let paths: { goldenPath: string; draftsPath: string; reviewDir: string };
const now = new Date("2026-10-03T12:00:00Z");

beforeEach(async () => {
  await wipe(sql);
  const ingestCtx = fakeCtx(sql);
  await ingest(ingestCtx, { text: NOTE, title: "Garden plan", sourceKind: "note", origin: "eval/corpus/note--garden-plan.md" }, { until: "chunked" });
  await ingest(ingestCtx, { text: EMAIL, title: "Re: Northwind panel", sourceKind: "email", origin: "eval/corpus/email--northwind-panel.md" }, { until: "chunked" });
  dir = await mkdtemp(join(tmpdir(), "eval-draft-"));
  paths = { goldenPath: join(dir, "golden.jsonl"), draftsPath: join(dir, "drafts.jsonl"), reviewDir: join(dir, "review") };
  await writeFile(paths.goldenPath, JSON.stringify({
    // About another document, so it does not make the email count as covered; its question still blocks a duplicate.
    id: "q01", question: "When is my Northwind panel interview?", kind: "semantic", expected: [{ origin: "news--elsewhere.md" }],
    source: "fixture", approved_by: "agent", approved_at: "2026-09-30",
  }) + "\n");
});

describe("draftDocuments", () => {
  it("makes one model call per document, keeps the drafts that pass every check, and writes them to drafts.jsonl and a review sheet", async () => {
    const llm = model();
    const r = await draftDocuments({ ...fakeCtx(sql), llm }, { corpus: "fixtures", ...paths, now });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].user).toContain("Other documents in the corpus:\n- Garden plan [note]");
    expect(r.drafted).toEqual(["email--northwind-panel.md", "note--garden-plan.md"]);
    expect(r.rejected).toEqual([
      { document: "email--northwind-panel.md", question: "When is my Northwind panel interview?", reasons: ["duplicates q01"] },
      { document: "note--garden-plan.md", question: "Why did I add grit to the soil?", reasons: ["the quote is not in the document verbatim"] },
      { document: "note--garden-plan.md", question: "Is it true I mixed in two bags of grit?", reasons: ["the question contains its own answer quote"] },
    ]);
    expect(r.written.map((d) => [d.kind, d.question])).toEqual([
      ["attribution", "When does Sam say my Northwind panel is?"],
      ["negative", "Who else is on the Northwind analytics team?"],
      ["keyword", "How many tulip bulbs did I plant by the fence?"],
      ["negative", "What colour were the tulips I planted?"],
    ]);
    expect(r.sheet).toBe(join(paths.reviewDir, "2026-10-03-1.md"));
    expect((await loadDrafts(paths.draftsPath)).map((d) => d.draft_id)).toEqual(r.written.map((d) => d.draft_id));
    expect(r.written.every((d) => d.sheet === r.sheet && d.model === "fake" && d.drafted_at === now.toISOString())).toBe(true);
    // Drafted items are golden items waiting only for approval.
    for (const d of r.written) {
      const item = toGoldenItem(d, "2026-10-04", false);
      expect([d.draft_id, "errors" in item ? item.errors : validateGoldenItem(item).ok]).toEqual([d.draft_id, true]);
    }
    expect(parseSheet(await readFile(r.sheet!, "utf8")).map((s) => s.draftId)).toEqual(r.written.map((d) => d.draft_id));
  });

  it("skips documents that already have drafts or golden items, unless forced; a forced re-draft is caught as a duplicate", async () => {
    await draftDocuments({ ...fakeCtx(sql), llm: model() }, { corpus: "fixtures", ...paths, now });
    const again = model();
    const second = await draftDocuments({ ...fakeCtx(sql), llm: again }, { corpus: "fixtures", ...paths, now });
    expect(again.calls).toHaveLength(0);
    expect(second).toMatchObject({ skipped: ["email--northwind-panel.md", "note--garden-plan.md"], written: [], sheet: null });
    const forced = model();
    const third = await draftDocuments({ ...fakeCtx(sql), llm: forced }, { corpus: "fixtures", ...paths, now, force: true, docs: ["note--garden-plan.md"] });
    expect(forced.calls).toHaveLength(1);
    expect(third.written).toEqual([]);
    expect(third.rejected.find((x) => x.question === "How many tulip bulbs did I plant by the fence?")!.reasons).toEqual([expect.stringMatching(/^duplicates d-[0-9a-f]{10}$/)]);
  });

  it("reports a failed model call and goes on with the next document", async () => {
    const r = await draftDocuments({ ...fakeCtx(sql), llm: model(["title: Re: Northwind panel"]) }, { corpus: "fixtures", ...paths, now });
    expect(r.failed).toEqual([{ document: "email--northwind-panel.md", error: "model unavailable" }]);
    expect(r.drafted).toEqual(["note--garden-plan.md"]);
  });
});

describe("approveSheetFile", () => {
  it("applies the owner's decisions: keep and edit go into the golden set, reject drops the draft, the rest stay", async () => {
    const r = await draftDocuments({ ...fakeCtx(sql), llm: model() }, { corpus: "fixtures", ...paths, now });
    const [attribution, negEmail, keyword] = r.written;
    let text = await readFile(r.sheet!, "utf8");
    const set = (id: string, decision: string) => {
      text = text.replace(new RegExp(`(## ${id}\\n\\n[^\\n]*\\n)decision:`), `$1decision: ${decision}`);
    };
    set(attribution.draft_id, "keep");
    set(keyword.draft_id, "edit");
    set(negEmail.draft_id, "reject");
    text = text.replace("question: How many tulip bulbs did I plant by the fence?", "question: How many tulips went in along the north fence?");
    await writeFile(r.sheet!, text);

    const result = await approveSheetFile(r.sheet!, { ...paths, sql: () => sql, today: "2026-10-04" });
    expect(result.approved.map((a) => [a.id, a.edited])).toEqual([[attribution.draft_id, false], [keyword.draft_id, true]]);
    expect(result.rejected).toEqual([negEmail.draft_id]);
    expect(result.undecided).toHaveLength(1);
    const golden = await loadGolden(paths.goldenPath);
    expect(golden.map((g) => [g.id, g.source, g.approved_by])).toEqual([
      ["q01", "fixture", "agent"],
      [attribution.draft_id, "generated", "owner"],
      [keyword.draft_id, "generated", "owner"],
    ]);
    expect(golden[2]).toMatchObject({ question: "How many tulips went in along the north fence?", expected: [{ origin: "note--garden-plan.md", quote: "I planted 40 tulip bulbs along the north fence" }], approved_at: "2026-10-04", edited: true });
    expect((await loadDrafts(paths.draftsPath)).map((d) => d.draft_id)).toEqual(result.undecided);

    // Applying the same sheet again changes nothing.
    const again = await approveSheetFile(r.sheet!, { ...paths, sql: () => sql, today: "2026-10-04" });
    expect(again.approved).toEqual([]);
    expect(again.alreadyApplied.sort()).toEqual([attribution.draft_id, keyword.draft_id, negEmail.draft_id].sort());
    expect(await loadGolden(paths.goldenPath)).toHaveLength(3);
  });

  it("writes nothing when an edit breaks a check, here a question that duplicates a golden item by its stems", async () => {
    const r = await draftDocuments({ ...fakeCtx(sql), llm: model() }, { corpus: "fixtures", ...paths, now });
    const attribution = r.written[0];
    const text = (await readFile(r.sheet!, "utf8"))
      .replace(new RegExp(`(## ${attribution.draft_id}\\n\\n[^\\n]*\\n)decision:`), "$1decision: edit")
      .replace("question: When does Sam say my Northwind panel is?", "question: When's my Northwind panel interview?");
    await writeFile(r.sheet!, text);
    await expect(approveSheetFile(r.sheet!, { ...paths, sql: () => sql })).rejects.toThrow(`${attribution.draft_id} (line 14): duplicates q01`);
    expect(await loadGolden(paths.goldenPath)).toHaveLength(1);
    expect(await loadDrafts(paths.draftsPath)).toHaveLength(4);
  });
});
````

- [ ] **Step 4: Run it to verify it fails**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-draft.test.ts`
Expected: FAIL: `Failed to load url ../../src/eval/draft.js`.

- [ ] **Step 5: The drafts: schemas, checks, prompt and run**

Create `src/eval/draft.ts`:
````ts
import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile, mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import type { Db } from "../db.js";
import { stemAll, type StemMap } from "../verify/terms.js";
import { GOLDEN_KINDS, CORPORA, validateGoldenItem, loadGolden, type Corpus, type GoldenItem, type GoldenKind } from "./golden.js";
import { matchesExpected } from "./metrics.js";
import { normalizeWhitespace } from "./run.js";

/**
 * Drafting golden questions (spec §8.3). `brain eval draft` asks the model, once per document, for 2 to 3 questions
 * the document answers (each with a verbatim answer quote and two paraphrases) and one negative question nothing in
 * the corpus answers. Every draft passes the automatic checks below before it is written to eval/drafts.jsonl and to
 * a review sheet; the owner then keeps, edits or rejects each one (src/eval/review.ts). Nothing here approves.
 */

/** Kinds the model may draft; negative questions are asked for separately. */
export const DRAFT_KINDS = ["keyword", "semantic", "graph", "filter", "attribution"] as const;

/** One model call's answer for one document. */
export const DraftOutputSchema = z.object({
  questions: z
    .array(
      z.object({
        kind: z.enum(DRAFT_KINDS),
        question: z.string().min(1),
        quote: z.string().min(1),
        paraphrases: z.array(z.string().min(1)).length(2),
      }),
    )
    .min(1)
    .max(3),
  negative: z.object({ question: z.string().min(1) }),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

/** The document a draft was written from, as the sheet shows it. */
const DraftDocumentSchema = z.object({
  id: z.string().uuid(),
  origin: z.string().nullable(),
  title: z.string().nullable(),
  source_kind: z.string(),
  author: z.string(),
}).strict();

/** One line of eval/drafts.jsonl: a golden item waiting for the owner, plus where it came from. */
export const DraftSchema = z.object({
  draft_id: z.string().regex(/^d-[0-9a-f]{10}$/),
  corpus: z.enum(CORPORA),
  kind: z.enum(GOLDEN_KINDS),
  question: z.string().min(1),
  quote: z.string().min(1).nullable(),
  paraphrases: z.array(z.string().min(1)),
  document: DraftDocumentSchema,
  drafted_at: z.string().min(1),
  model: z.string().min(1),
  sheet: z.string().min(1),
}).strict();
export type Draft = z.infer<typeof DraftSchema>;
export type DraftDocument = z.infer<typeof DraftDocumentSchema>;

/** Two questions are duplicates when their stem sets overlap at least this much (Jaccard), or their normalised text is equal. */
export const DUPLICATE_STEM_JACCARD = 0.8;

/** The longest document text sent to the model; the quote check always reads the whole text. */
export const MAX_DRAFT_CHARS = 40_000;

/** Lower case, every run of characters that are not letters or digits as one space, trimmed. */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A stable id: the same question drafted from the same document always gets the same id. */
export function draftId(docKey: string, question: string): string {
  return "d-" + createHash("sha256").update(`${docKey}\n${normalizeQuestion(question)}`).digest("hex").slice(0, 10);
}

/** How a draft names its document in the golden set: the fixture file name, or the document id for the real base. */
export function docKey(corpus: Corpus, d: Pick<DraftDocument, "id" | "origin">): string {
  return corpus === "fixtures" && d.origin ? basename(d.origin) : d.id;
}

/** |A ∩ B| / |A ∪ B| over distinct stems; 0 when either is empty. */
export function stemJaccard(a: string[], b: string[]): number {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const s of x) if (y.has(s)) both++;
  return both / (x.size + y.size - both);
}

/**
 * The id of the first existing question that `question` duplicates: equal normalised text, or stem sets (Postgres
 * english lexemes, stopwords removed) with Jaccard ≥ DUPLICATE_STEM_JACCARD. Null when there is none.
 */
export function duplicateOf(question: string, others: { id: string; question: string }[], stems: StemMap): string | null {
  const norm = normalizeQuestion(question);
  const mine = stems.get(question) ?? [];
  for (const o of others) {
    if (normalizeQuestion(o.question) === norm) return o.id;
    if (stemJaccard(mine, stems.get(o.question) ?? []) >= DUPLICATE_STEM_JACCARD) return o.id;
  }
  return null;
}

/** The quote as it is compared: ASCII whitespace runs collapsed, ends trimmed (as the eval's quote matching does). */
const squash = (s: string) => normalizeWhitespace(s).replace(/^ | $/g, "");

/** Whether the quote appears verbatim in the document text after whitespace normalisation (case and punctuation count). */
export function quoteInDocument(quote: string, text: string): boolean {
  const q = squash(quote);
  return q.length > 0 && normalizeWhitespace(text).includes(q);
}

/** Whether the question contains its own answer quote (case-insensitive, whitespace normalised). */
export function questionContainsQuote(question: string, quote: string): boolean {
  const q = squash(quote).toLowerCase();
  return q.length > 0 && normalizeWhitespace(question).toLowerCase().includes(q);
}

/** The golden item a draft becomes once the owner approves it. */
export function toGoldenItem(d: Draft, approvedAt: string, edited: boolean): GoldenItem | { errors: string } {
  const negative = d.kind === "negative";
  const expected = negative ? [] : [{ ...(d.corpus === "fixtures" && d.document.origin ? { origin: basename(d.document.origin) } : { document_id: d.document.id }), ...(d.quote ? { quote: d.quote } : {}) }];
  const raw = {
    id: d.draft_id,
    question: d.question,
    kind: d.kind,
    expected,
    ...(d.kind === "filter" ? { filters: { sourceKinds: [d.document.source_kind] } } : {}),
    ...(d.paraphrases.length ? { paraphrases: d.paraphrases } : {}),
    source: "generated",
    negative,
    corpus: d.corpus,
    approved_by: "owner",
    approved_at: approvedAt,
    edited,
  };
  const v = validateGoldenItem(raw);
  return v.ok ? v.item : { errors: v.errors };
}

export interface CheckContext {
  /** The full text of the draft's document, or null when it is not in the eval database. */
  documentText: string | null;
  /** Golden items and other drafts the question must not duplicate (the draft itself excluded). */
  others: { id: string; question: string }[];
  stems: StemMap;
}

/**
 * Every automatic check, in order; the reasons a draft fails (empty means it passes):
 * the expected document exists; the quote appears verbatim in it after whitespace normalisation; the question does not
 * contain its own quote; it is not a duplicate of a golden item or another draft; kind and fields are valid under the
 * golden schema (as the item it would become); an attribution question needs a document the owner did not write.
 */
export function draftProblems(d: Draft, c: CheckContext): string[] {
  const out: string[] = [];
  const negative = d.kind === "negative";
  if (c.documentText === null) out.push("its document is not in the eval database");
  if (!negative) {
    if (!d.quote) out.push("a question needs a quote");
    else {
      if (c.documentText !== null && !quoteInDocument(d.quote, c.documentText)) out.push("the quote is not in the document verbatim");
      if (questionContainsQuote(d.question, d.quote)) out.push("the question contains its own answer quote");
    }
    if (d.paraphrases.length !== 2) out.push("a question needs exactly two paraphrases");
  } else if (d.quote || d.paraphrases.length) out.push("a negative question has no quote and no paraphrases");
  if (d.kind === "attribution" && d.document.author === "owner") out.push("an attribution question needs a document the owner did not write");
  const dup = duplicateOf(d.question, c.others, c.stems);
  if (dup) out.push(`duplicates ${dup}`);
  const item = toGoldenItem(d, "2000-01-01", false);
  if ("errors" in item) out.push(`not a valid golden item: ${item.errors}`);
  return out;
}

/** Reads eval/drafts.jsonl (missing means none); each line must be a valid draft, with unique ids. */
export async function loadDrafts(path: string): Promise<Draft[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Draft[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`drafts line ${i + 1}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = DraftSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`drafts line ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ")}`);
    if (seen.has(parsed.data.draft_id)) throw new Error(`drafts line ${i + 1}: duplicate draft id ${parsed.data.draft_id}`);
    seen.add(parsed.data.draft_id);
    out.push(parsed.data);
  });
  return out;
}

/** Rewrites eval/drafts.jsonl with exactly these drafts. */
export async function saveDrafts(path: string, drafts: Draft[]): Promise<void> {
  await writeFile(path, drafts.map((d) => JSON.stringify(d)).join("\n") + (drafts.length ? "\n" : ""));
}

export const DRAFT_SYSTEM = [
  "You write evaluation questions for the search engine of a personal knowledge base. Its owner is Frank Fu; the documents are things he wrote or saved. You get one document and the titles of the other documents in the corpus.",
  "Write 2 or 3 questions that this document answers, each of a different kind where the document allows:",
  "- keyword: uses an exact name, number, code or rare term that appears in the document.",
  "- semantic: asks about the meaning in other words than the document uses.",
  "- graph: asks about a named person, company or place in the document and how it relates to others, e.g. \"What do I know about <name>?\".",
  "- filter: a short search-style query that makes sense when only documents of this document's source kind are searched.",
  "- attribution: only when the author is not the owner: asks what that author says, naming them or their piece, so it cannot be read as something the owner said.",
  "Rules for every question:",
  "- Ask it as the owner would: first person about the owner's own documents (\"Where did I…\"), plainly otherwise.",
  "- quote: 5 to 30 words copied exactly, character for character, from one place in the document, containing the answer. Do not fix spelling or punctuation and do not join two places.",
  "- The question must not contain the quote, or most of its words.",
  "- paraphrases: exactly two other ways to ask the same question, worded differently from it and from each other.",
  "Then write one negative question: in the same area as this document, specific, and answered neither by this document nor, judging by their titles, by any other document listed (for example a detail this document leaves out).",
].join("\n");

export interface CorpusDocument extends DraftDocument {
  raw_content: string;
  occurred_at: Date | null;
  ingested_at: Date;
}

/** The user message for one document: its metadata, its text (cut at MAX_DRAFT_CHARS), and the other titles. */
export function draftUserMessage(doc: CorpusDocument, otherTitles: string[]): string {
  const text = doc.raw_content.length > MAX_DRAFT_CHARS ? doc.raw_content.slice(0, MAX_DRAFT_CHARS) + "\n[document cut here]" : doc.raw_content;
  return [
    "Document",
    `title: ${doc.title ?? "(untitled)"}`,
    `source kind: ${doc.source_kind}`,
    `author: ${doc.author}${doc.author === "owner" ? " (the owner, Frank Fu)" : ""}`,
    `date: ${doc.occurred_at ? doc.occurred_at.toISOString().slice(0, 10) : "unknown"}`,
    "---",
    text,
    "---",
    "Other documents in the corpus:",
    ...(otherTitles.length ? otherTitles.map((t) => `- ${t}`) : ["- none"]),
  ].join("\n");
}

/** Every document of the eval database, oldest origin first. */
export async function corpusDocuments(sql: Db): Promise<CorpusDocument[]> {
  return sql<CorpusDocument[]>`
    select id, origin, title, source_kind, author, raw_content, occurred_at, ingested_at
    from brain.documents order by origin nulls last, ingested_at, id`;
}

/** The next free review sheet path for a date: eval/review/2026-10-03-1.md, -2.md, … */
export async function nextSheetPath(reviewDir: string, day: string): Promise<string> {
  let names: string[] = [];
  try {
    names = await readdir(reviewDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const re = new RegExp(`^${day}-(\\d+)\\.md$`);
  const used = names.map((n) => re.exec(n)?.[1]).filter((x): x is string => !!x).map(Number);
  return join(reviewDir, `${day}-${(used.length ? Math.max(...used) : 0) + 1}.md`);
}

export interface DraftRunOptions {
  corpus: Corpus;
  goldenPath: string;
  draftsPath: string;
  reviewDir: string;
  /** Only documents ingested at or after this time. */
  since?: Date;
  /** At most this many documents get a model call. */
  limit?: number;
  /** Draft documents that already have drafts or golden items. */
  force?: boolean;
  /** Only these documents: a file name (origin suffix) or a document id each. */
  docs?: string[];
  /** The run's time (tests pass a fixed one). */
  now?: Date;
}

export interface DraftRunResult {
  /** Documents that got a model call. */
  drafted: string[];
  /** Documents left out because they already have drafts or golden items (without --force). */
  skipped: string[];
  written: Draft[];
  rejected: { document: string; question: string; reasons: string[] }[];
  failed: { document: string; error: string }[];
  sheet: string | null;
}

const label = (corpus: Corpus, d: DraftDocument) => (corpus === "fixtures" && d.origin ? basename(d.origin) : `${d.title ?? "(untitled)"} (${d.id})`);

/**
 * One model call per selected document (ctx.llm.structured with DraftOutputSchema), the automatic checks on every
 * question, then the passing drafts appended to eval/drafts.jsonl and written to one new review sheet. Idempotent: a
 * document that already has a pending draft or a golden item is skipped unless force is set, and a question already
 * drafted gets the same id and is reported as a duplicate.
 */
export async function draftDocuments(ctx: Ctx, opts: DraftRunOptions): Promise<DraftRunResult> {
  const { renderSheet } = await import("./review.js");
  const now = opts.now ?? new Date();
  const golden = await loadGolden(opts.goldenPath);
  const drafts = await loadDrafts(opts.draftsPath);
  const all = await corpusDocuments(ctx.sql);
  const result: DraftRunResult = { drafted: [], skipped: [], written: [], rejected: [], failed: [], sheet: null };

  const sheet = await nextSheetPath(opts.reviewDir, now.toISOString().slice(0, 10));
  const covered = (d: CorpusDocument) =>
    drafts.some((x) => x.document.id === d.id || (x.document.origin !== null && x.document.origin === d.origin)) ||
    golden.some((g) => g.corpus === opts.corpus && g.expected.some((e) => matchesExpected(e, { documentId: d.id, origin: d.origin })));
  const wanted = (d: CorpusDocument) =>
    !opts.docs?.length || opts.docs.some((w) => w === d.id || (d.origin !== null && (d.origin === w || d.origin.endsWith("/" + w))));

  const selected: CorpusDocument[] = [];
  for (const d of all) {
    if (opts.since && d.ingested_at < opts.since) continue;
    if (!wanted(d)) continue;
    if (!opts.force && covered(d)) {
      result.skipped.push(label(opts.corpus, d));
      continue;
    }
    selected.push(d);
  }
  const todo = opts.limit === undefined ? selected : selected.slice(0, opts.limit);

  const others: { id: string; question: string }[] = [
    ...golden.map((g) => ({ id: g.id, question: g.question })),
    ...drafts.map((d) => ({ id: d.draft_id, question: d.question })),
  ];
  for (const doc of todo) {
    const name = label(opts.corpus, doc);
    const document: DraftDocument = { id: doc.id, origin: doc.origin, title: doc.title, source_kind: doc.source_kind, author: doc.author };
    let out: DraftOutput;
    try {
      out = await ctx.llm.structured({
        schema: DraftOutputSchema,
        system: DRAFT_SYSTEM,
        user: draftUserMessage(doc, all.filter((o) => o.id !== doc.id).map((o) => `${o.title ?? "(untitled)"} [${o.source_kind}]`)),
      });
    } catch (err) {
      result.failed.push({ document: name, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    result.drafted.push(name);
    const key = docKey(opts.corpus, document);
    const candidates: Draft[] = [
      ...out.questions.map((q) => ({ kind: q.kind as GoldenKind, question: q.question.trim(), quote: q.quote, paraphrases: q.paraphrases.map((p) => p.trim()) })),
      { kind: "negative" as GoldenKind, question: out.negative.question.trim(), quote: null, paraphrases: [] },
    ].map((c) => ({
      draft_id: draftId(key, c.question),
      corpus: opts.corpus,
      ...c,
      document,
      drafted_at: now.toISOString(),
      model: ctx.llm.model,
      sheet,
    }));
    const stems = await stemAll(ctx.sql, [...candidates.map((c) => c.question), ...others.map((o) => o.question)]);
    for (const c of candidates) {
      const reasons = draftProblems(c, { documentText: doc.raw_content, others, stems });
      if (reasons.length) {
        result.rejected.push({ document: name, question: c.question, reasons });
        continue;
      }
      result.written.push(c);
      others.push({ id: c.draft_id, question: c.question });
    }
  }

  if (result.written.length) {
    await appendFile(opts.draftsPath, result.written.map((d) => JSON.stringify(d)).join("\n") + "\n");
    await mkdir(opts.reviewDir, { recursive: true });
    await writeFile(sheet, renderSheet(result.written, { sheet, corpus: opts.corpus, model: ctx.llm.model, day: now.toISOString().slice(0, 10), documents: result.drafted.length }));
    result.sheet = sheet;
  }
  return result;
}
````

- [ ] **Step 6: The review sheet: render, parse, apply, approve**

Create `src/eval/review.ts`:
````ts
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Db } from "../db.js";
import { stemAll, type StemMap } from "../verify/terms.js";
import { appendGolden, loadGolden, type Corpus, type GoldenItem, type GoldenKind } from "./golden.js";
import { DRAFT_KINDS, draftProblems, loadDrafts, saveDrafts, toGoldenItem, type Draft } from "./draft.js";

/**
 * The review sheet: a Markdown file the owner edits in a plain text editor or Obsidian to keep, edit or reject each
 * draft, and `brain eval approve --sheet` reads back. One `## <draft id>` section per draft, `key: value` lines, the
 * two paraphrases as `- ` lines under `paraphrases:`. Parsing is strict: any line it cannot place is an error with its
 * line number, and nothing is applied while any error remains.
 */

export const DECISIONS = ["keep", "edit", "reject"] as const;
export type Decision = (typeof DECISIONS)[number];

/** How the sheet names a draft's document; also checked on the way back in, so the line cannot be edited by mistake. */
export function documentLine(d: Draft): string {
  const doc = d.corpus === "fixtures" && d.document.origin ? basename(d.document.origin) : `${d.document.title ?? "(untitled)"} (${d.document.id})`;
  return d.kind === "negative" ? `none (negative question, drafted from ${doc})` : doc;
}

export interface SheetInfo {
  sheet: string;
  corpus: Corpus;
  model: string;
  day: string;
  documents: number;
}

/** The sheet for a batch of drafts. */
export function renderSheet(drafts: Draft[], info: SheetInfo): string {
  const out = [
    `# Eval review ${basename(info.sheet, ".md")}`,
    "",
    `Drafted ${info.day} by ${info.model} from ${info.documents} document${info.documents === 1 ? "" : "s"} of the ${info.corpus} corpus: ${drafts.length} question${drafts.length === 1 ? "" : "s"}. Every quote was found verbatim in its document, and no question repeats a golden item or another draft.`,
    "",
    "For each item, set `decision:` to one of:",
    "- `keep`: approve it as written.",
    "- `edit`: approve it after your changes. Change `kind`, `question`, `quote` or the two lines under `paraphrases:` in place.",
    "- `reject`: discard it.",
    "",
    `Leave \`decision:\` empty to decide later. Do not change the \`## d-…\` headings or the \`document:\` lines. Kinds: ${DRAFT_KINDS.join(", ")} (a negative item stays negative). A filter item searches only its document's source kind. A quote must stay a verbatim span of the document.`,
    "",
    `Apply: \`npm run brain -- eval approve --sheet ${info.sheet}\``,
  ];
  for (const d of drafts) {
    out.push("", `## ${d.draft_id}`, "", `document: ${documentLine(d)}`, "decision:", `kind: ${d.kind}`, `question: ${d.question}`);
    if (d.kind !== "negative") out.push(`quote: ${d.quote ?? ""}`, "paraphrases:", ...d.paraphrases.map((p) => `- ${p}`));
  }
  return out.join("\n") + "\n";
}

/** One section of a sheet as the owner left it. */
export interface SheetItem {
  draftId: string;
  /** 1-based line of the heading. */
  line: number;
  decision: Decision | null;
  document: string;
  kind: string;
  question: string;
  quote: string | null;
  paraphrases: string[];
}

const KEYS = ["document", "decision", "kind", "question", "quote", "paraphrases"] as const;
const HEADING = /^## (d-[0-9a-f]{10})\s*$/;

/** Parses a sheet; throws one error listing every problem with its line number. */
export function parseSheet(text: string, path = "sheet"): SheetItem[] {
  const errors: string[] = [];
  const items: SheetItem[] = [];
  type Open = { item: SheetItem; seen: Set<string>; inParaphrases: boolean; hasQuote: boolean; hasParaphrases: boolean };
  let open: Open | null = null;
  const close = (o: Open | null) => {
    if (!o) return;
    for (const k of ["document", "decision", "kind", "question"]) if (!o.seen.has(k)) errors.push(`${path}:${o.item.line}: ${o.item.draftId} has no ${k}: line`);
    items.push(o.item);
  };
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## ") || line === "##") {
      close(open);
      const m = HEADING.exec(line);
      if (!m) {
        errors.push(`${path}:${n}: a heading must be "## d-" and 10 hex digits, as the sheet was written; got "${line}"`);
        open = null;
        return;
      }
      if (items.some((x) => x.draftId === m[1])) errors.push(`${path}:${n}: ${m[1]} appears twice`);
      open = { item: { draftId: m[1], line: n, decision: null, document: "", kind: "", question: "", quote: null, paraphrases: [] }, seen: new Set(), inParaphrases: false, hasQuote: false, hasParaphrases: false };
      return;
    }
    if (!open) return; // the introduction before the first item is free text
    const o: Open = open;
    if (line.trim() === "") return;
    const bullet = /^\s*-(?: (.*))?$/.exec(line);
    if (bullet) {
      const value = (bullet[1] ?? "").trim();
      if (!o.inParaphrases) errors.push(`${path}:${n}: a "- " line belongs under paraphrases:`);
      else if (value === "") errors.push(`${path}:${n}: empty paraphrase`);
      else o.item.paraphrases.push(value);
      return;
    }
    const kv = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (!kv || !(KEYS as readonly string[]).includes(kv[1])) {
      errors.push(`${path}:${n}: cannot read "${line}"; expected one of ${KEYS.map((k) => k + ":").join(" ")} or a "- " paraphrase`);
      return;
    }
    const [key, value = ""] = [kv[1], (kv[2] ?? "").trim()];
    if (o.seen.has(key)) {
      errors.push(`${path}:${n}: ${o.item.draftId} has a second ${key}: line`);
      return;
    }
    o.seen.add(key);
    o.inParaphrases = key === "paraphrases";
    if (key === "paraphrases") {
      if (value) errors.push(`${path}:${n}: put each paraphrase on its own "- " line under paraphrases:`);
      return;
    }
    if (key === "decision") {
      if (value === "") o.item.decision = null;
      else if ((DECISIONS as readonly string[]).includes(value)) o.item.decision = value as Decision;
      else errors.push(`${path}:${n}: decision must be keep, edit, reject or empty; got "${value}"`);
      return;
    }
    if (key === "quote") {
      o.item.quote = value;
      return;
    }
    if (key === "document") o.item.document = value;
    else if (key === "kind") o.item.kind = value;
    else if (key === "question") o.item.question = value;
  });
  close(open);
  if (errors.length) throw new Error(`${path} has ${errors.length} problem${errors.length === 1 ? "" : "s"}:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  return items;
}

export interface ApplyContext {
  drafts: Draft[];
  golden: GoldenItem[];
  /** Full text of a draft's document in its eval database, or null when it is not there. */
  documentText: (d: Draft) => string | null;
  stems: StemMap;
  /** YYYY-MM-DD. */
  today: string;
}

export interface ApplyResult {
  approved: GoldenItem[];
  rejected: string[];
  undecided: string[];
  /** Kept or rejected in an earlier run of the same sheet. */
  alreadyApplied: string[];
  /** The drafts that stay pending. */
  remaining: Draft[];
}

/** The draft as the sheet item would make it. */
function edited(d: Draft, s: SheetItem): Draft {
  return { ...d, kind: s.kind as GoldenKind, question: s.question, quote: d.kind === "negative" ? null : s.quote, paraphrases: d.kind === "negative" ? [] : s.paraphrases };
}

function changedFields(d: Draft, s: SheetItem): string[] {
  const out: string[] = [];
  if (s.kind !== d.kind) out.push("kind");
  if (s.question !== d.question) out.push("question");
  if (d.kind !== "negative") {
    if (s.quote !== d.quote) out.push("quote");
    if (JSON.stringify(s.paraphrases) !== JSON.stringify(d.paraphrases)) out.push("paraphrases");
  }
  return out;
}

/**
 * Applies a parsed sheet. keep and edit become golden items (source generated, approved_by owner, approved_at today,
 * edited when any field changed); reject drops the draft; an empty decision leaves it pending. Every kept or edited
 * item passes the automatic checks again against the eval database. Throws, applying nothing, when any item has a
 * problem: an unknown draft id, a changed document line, keep with changed fields, a negative turned positive (or the
 * reverse), an unknown kind, or a failed check.
 */
export function applySheet(items: SheetItem[], c: ApplyContext): ApplyResult {
  const errors: string[] = [];
  const byId = new Map(c.drafts.map((d) => [d.draft_id, d]));
  const goldenIds = new Set(c.golden.map((g) => g.id));
  const result: ApplyResult = { approved: [], rejected: [], undecided: [], alreadyApplied: [], remaining: [] };
  const others = [...c.golden.map((g) => ({ id: g.id, question: g.question }))];
  for (const s of items) {
    const d = byId.get(s.draftId);
    if (!d) {
      if (s.decision !== null && (goldenIds.has(s.draftId) || s.decision === "reject")) result.alreadyApplied.push(s.draftId);
      else if (s.decision === null) result.undecided.push(s.draftId);
      else errors.push(`${s.draftId} (line ${s.line}): no pending draft has this id`);
      continue;
    }
    if (s.document !== documentLine(d)) errors.push(`${s.draftId} (line ${s.line}): the document line was changed; it must read "${documentLine(d)}"`);
    if (s.decision === null) {
      result.undecided.push(s.draftId);
      continue;
    }
    if (s.decision === "reject") {
      result.rejected.push(s.draftId);
      continue;
    }
    const changed = changedFields(d, s);
    if (s.decision === "keep" && changed.length) {
      errors.push(`${s.draftId} (line ${s.line}): decision keep but ${changed.join(", ")} changed; use edit, or undo the change`);
      continue;
    }
    if ((s.kind === "negative") !== (d.kind === "negative")) {
      errors.push(`${s.draftId} (line ${s.line}): ${d.kind === "negative" ? "a negative question cannot become positive" : "a question with a quote cannot become negative; reject it instead"}`);
      continue;
    }
    if (s.kind !== "negative" && !(DRAFT_KINDS as readonly string[]).includes(s.kind)) {
      errors.push(`${s.draftId} (line ${s.line}): kind must be one of ${DRAFT_KINDS.join(", ")}; got "${s.kind}"`);
      continue;
    }
    const next = edited(d, s);
    // Against the golden set and the items approved above; pending drafts were compared with each other when drafted.
    const problems = draftProblems(next, { documentText: c.documentText(d), others, stems: c.stems });
    if (problems.length) {
      errors.push(`${s.draftId} (line ${s.line}): ${problems.join("; ")}`);
      continue;
    }
    const item = toGoldenItem(next, c.today, changed.length > 0);
    if ("errors" in item) {
      errors.push(`${s.draftId} (line ${s.line}): ${item.errors}`);
      continue;
    }
    result.approved.push(item);
    others.push({ id: item.id, question: item.question });
  }
  if (errors.length) throw new Error(`nothing applied; fix the sheet and run approve again:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  const gone = new Set([...result.approved.map((a) => a.id), ...result.rejected]);
  result.remaining = c.drafts.filter((d) => !gone.has(d.draft_id));
  return result;
}

/** The questions whose stems approve needs: every kept or edited question as the sheet has it, golden items, other drafts. */
export function questionsToStem(items: SheetItem[], drafts: Draft[], golden: GoldenItem[]): string[] {
  return [...items.map((s) => s.question), ...drafts.map((d) => d.question), ...golden.map((g) => g.question)];
}

export interface ApproveOptions {
  goldenPath: string;
  draftsPath: string;
  /** The eval database of a corpus (brain_eval or brain_real_eval), opened and checked by the caller; only read. */
  sql: (corpus: Corpus) => Db | Promise<Db>;
  /** YYYY-MM-DD; defaults to today (UTC). */
  today?: string;
}

/**
 * `brain eval approve --sheet`: parses the sheet, rechecks every kept or edited item against its eval database (the
 * document's text, Postgres stems for the duplicate check), then appends the approved items to the golden set and
 * rewrites eval/drafts.jsonl without the approved and rejected drafts. Nothing is written when anything fails.
 */
export async function approveSheetFile(sheetPath: string, opts: ApproveOptions): Promise<ApplyResult> {
  const items = parseSheet(await readFile(sheetPath, "utf8"), sheetPath);
  const drafts = await loadDrafts(opts.draftsPath);
  const golden = await loadGolden(opts.goldenPath);
  const byId = new Map(drafts.map((d) => [d.draft_id, d]));
  const toCheck = items.filter((s) => s.decision === "keep" || s.decision === "edit").map((s) => byId.get(s.draftId)).filter((d): d is Draft => !!d);
  const corpora = [...new Set(toCheck.map((d) => d.corpus))];
  if (corpora.length > 1) throw new Error(`${sheetPath} mixes the ${corpora.join(" and ")} corpora; approve each corpus's drafts from its own sheet`);
  const texts = new Map<string, string>();
  let stems: StemMap = new Map();
  if (corpora.length === 1) {
    const sql = await opts.sql(corpora[0]);
    // brain_eval is rebuilt from eval/corpus, so a fixture is found by its origin when its id has changed.
    const rows = await sql<{ id: string; origin: string | null; raw_content: string }[]>`
      select id, origin, raw_content from brain.documents
      where id = any(${toCheck.map((d) => d.document.id)}::uuid[]) or origin = any(${toCheck.map((d) => d.document.origin ?? "")}::text[])`;
    for (const r of rows) {
      texts.set(r.id, r.raw_content);
      if (r.origin) texts.set(`origin:${r.origin}`, r.raw_content);
    }
    stems = await stemAll(sql, questionsToStem(items, drafts, golden));
  }
  const result = applySheet(items, {
    drafts,
    golden,
    documentText: (d) => texts.get(d.document.id) ?? (d.document.origin ? texts.get(`origin:${d.document.origin}`) : undefined) ?? null,
    stems,
    today: opts.today ?? new Date().toISOString().slice(0, 10),
  });
  await appendGolden(opts.goldenPath, result.approved);
  await saveDrafts(opts.draftsPath, result.remaining);
  return result;
}
````

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/unit/eval-draft.test.ts test/unit/eval-review.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-draft.test.ts`
Expected: PASS (15 and 11 unit tests; 5 integration tests). The integration test runs the real stems from Postgres: an edit to "When's my Northwind panel interview?" is refused as a duplicate of "When is my Northwind panel interview?".

- [ ] **Step 8: Typecheck and the suites**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: no type errors; unit 440 passed; integration 316 passed.

- [ ] **Step 9: Commit**

```bash
git add src/eval/draft.ts src/eval/review.ts test/unit/eval-draft.test.ts test/unit/eval-review.test.ts test/integration/eval-draft.test.ts
git commit -m "Draft golden questions: one structured model call per document, automatic checks (verbatim quote, question without its quote, no duplicate by text or stem Jaccard 0.8, document present, valid golden item), eval/drafts.jsonl and a strictly parsed review sheet applied all or nothing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `brain eval draft`, `approve`, `reject`, `drafts`

**Files:**
- Modify: `src/cli.ts`
- Create: `test/integration/eval-cli.test.ts`

The commands around Task 6's library. `eval draft` opens the corpus's eval database with a real context (Claude Code on the Max plan for the calls; no Voyage call is made), checks the connection, drafts, and prints one line per document (`skip`, `drafted`, `dropped` with the reasons, `failed`) and where the sheet is. `eval approve --sheet` opens an eval database only when the sheet keeps or edits something, checks the connection before reading, and prints the counts and the golden set's new totals by approver. `eval reject --id` drops pending drafts and exits 1 naming any id that is not pending. `eval drafts` lists what is pending. The test runs the commands that need no eval database (a sheet of rejections, `drafts`, `reject`); `draftDocuments` and `approveSheetFile` are tested in Task 6.

- [ ] **Step 1: Write the failing test**

Create `test/integration/eval-cli.test.ts`:
````ts
import { describe, it, expect, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TEST_DATABASE_URL } from "./helpers.js";
import { renderSheet } from "../../src/eval/review.js";
import type { Draft } from "../../src/eval/draft.js";

const run = promisify(execFile);

/** Runs `brain eval …` with every database URL on brain_test, which the eval commands that write refuse (not *_eval). */
async function brainEval(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("node_modules/.bin/tsx", ["src/cli.ts", "eval", ...args], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, EVAL_DATABASE_URL: TEST_DATABASE_URL, EVAL_REAL_DATABASE_URL: TEST_DATABASE_URL, OBSIDIAN_AUTO: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

const doc = { id: "0b9c6a38-1111-4222-8333-444455556666", origin: "eval/corpus/note--garden-plan.md", title: "Garden plan", source_kind: "note", author: "owner" };
const draft = (id: string, question: string, kind = "keyword"): Draft => ({
  draft_id: id, corpus: "fixtures", kind: kind as Draft["kind"], question, quote: kind === "negative" ? null : "I planted 40 tulip bulbs",
  paraphrases: kind === "negative" ? [] : ["p one", "p two"], document: doc, drafted_at: "2026-10-03T12:00:00.000Z", model: "fake", sheet: "eval/review/2026-10-03-1.md",
});

let dir: string;
let drafts: string;
let golden: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eval-cli-"));
  drafts = join(dir, "drafts.jsonl");
  golden = join(dir, "golden.jsonl");
  await writeFile(drafts, [draft("d-aaaaaaaaaa", "How many tulip bulbs did I plant?"), draft("d-bbbbbbbbbb", "What colour were the tulips?", "negative")].map((d) => JSON.stringify(d)).join("\n") + "\n");
  await writeFile(golden, "");
});

describe("brain eval drafts, reject, approve (CLI)", () => {
  it("lists pending drafts with their document and sheet", async () => {
    const r = await brainEval(["drafts", "--drafts", drafts]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("d-aaaaaaaaaa  fixtures keyword     note--garden-plan.md\n    How many tulip bulbs did I plant?\n    sheet eval/review/2026-10-03-1.md");
    expect(r.stdout).toContain("d-bbbbbbbbbb  fixtures negative    none (negative question, drafted from note--garden-plan.md)");
    expect(r.stdout.trim().endsWith("2 pending")).toBe(true);
  });

  it("rejects drafts by id and exits 1 naming an id that is not pending", async () => {
    const r = await brainEval(["reject", "--id", "d-aaaaaaaaaa", "d-cccccccccc", "--drafts", drafts]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("rejected 1; 1 drafts pending");
    expect(r.stderr).toContain("no pending draft d-cccccccccc");
    expect((await readFile(drafts, "utf8")).trim().split("\n").map((l) => JSON.parse(l).draft_id)).toEqual(["d-bbbbbbbbbb"]);
  });

  it("applies a sheet of rejections without opening an eval database, and reports a malformed sheet without changing anything", async () => {
    const sheet = join(dir, "2026-10-03-1.md");
    const text = renderSheet([draft("d-aaaaaaaaaa", "How many tulip bulbs did I plant?"), draft("d-bbbbbbbbbb", "What colour were the tulips?", "negative")], { sheet, corpus: "fixtures", model: "fake", day: "2026-10-03", documents: 1 });
    await writeFile(sheet, text.replace("decision:\nkind: keyword", "decision: maybe\nkind: keyword"));
    const bad = await brainEval(["approve", "--sheet", sheet, "--drafts", drafts, "--golden", golden]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain(`${sheet}:17: decision must be keep, edit, reject or empty; got "maybe"`);
    await writeFile(sheet, text.replace(/^decision:$/gm, "decision: reject"));
    const ok = await brainEval(["approve", "--sheet", sheet, "--drafts", drafts, "--golden", golden]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("approved 0 (0 edited), rejected 2, undecided 0, already applied 0");
    expect(ok.stdout).toContain(`${golden} now has 0 items: 0 approved by the owner, 0 written by an agent`);
    expect(await readFile(drafts, "utf8")).toBe("");
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-cli.test.ts`
Expected: FAIL, 3 tests, each with `error: unknown command 'drafts'` (or `'reject'`, `'approve'`) on stderr.

- [ ] **Step 3: The commands**

In `src/cli.ts`, replace:
````ts
    }
  });

evalCmd
  .command("verifier")
  .description("Score the citation verifier on its labelled set: each item, the confusion matrices, precision and recall of supported on the regular and full views (no model or Voyage call)")
````
with:
````ts
    }
  });

evalCmd
  .command("draft")
  .description("Draft golden questions: one model call per document (2-3 questions with a verbatim quote and two paraphrases, plus one negative), automatic checks, then eval/drafts.jsonl and a review sheet for the owner")
  .option("--corpus <corpus>", "fixtures (brain_eval) or real (brain_real_eval)", "fixtures")
  .option("--since <date>", "only documents ingested on or after this date")
  .option("--limit <n>", "at most this many documents (model calls)")
  .option("--doc <document...>", "only these documents: file name or document id")
  .option("--force", "also draft documents that already have drafts or golden items")
  .option("--golden <path>", "golden set file", "eval/golden.jsonl")
  .option("--drafts <path>", "pending drafts file", "eval/drafts.jsonl")
  .option("--review-dir <dir>", "where review sheets are written", "eval/review")
  .action(async (opts) => {
    const corpus = corpusOption(opts.corpus);
    const limit = opts.limit === undefined ? undefined : Number(opts.limit);
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error(`--limit needs a positive whole number, got ${JSON.stringify(opts.limit)}`);
    const { makeEvalCtx, assertEvalConnection, evalDatabaseHint } = await import("./eval/db.js");
    const { draftDocuments } = await import("./eval/draft.js");
    const ctx = makeEvalCtx(corpus);
    try {
      await assertEvalConnection(ctx.sql);
      const r = await draftDocuments(ctx, {
        corpus, goldenPath: opts.golden, draftsPath: opts.drafts, reviewDir: opts.reviewDir,
        since: opts.since ? new Date(opts.since) : undefined, limit, force: !!opts.force, docs: opts.doc,
      });
      for (const d of r.skipped) console.log(`skip     ${d} (has drafts or golden items; --force drafts it again)`);
      for (const d of r.drafted) console.log(`drafted  ${d}`);
      for (const x of r.rejected) console.log(`dropped  ${x.document}: "${x.question}": ${x.reasons.join("; ")}`);
      for (const f of r.failed) console.log(`failed   ${f.document}: ${f.error}`);
      if (r.sheet) {
        console.log(`\n${r.written.length} drafts written to ${opts.drafts} and ${r.sheet}.`);
        console.log(`The owner reviews the sheet (keep, edit or reject each item), then: npm run brain -- eval approve --sheet ${r.sheet}`);
      } else console.log("\nNo new drafts.");
      if (r.failed.length) process.exitCode = 1;
    } catch (e) {
      throw evalDatabaseHint(e, corpus);
    } finally {
      await ctx.sql.end();
    }
  });

evalCmd
  .command("approve")
  .description("Apply the owner's decisions in a review sheet: keep and edit go into the golden set (approved_by owner), reject drops the draft, undecided items stay")
  .requiredOption("--sheet <file>", "the review sheet, eval/review/<date>-<n>.md")
  .option("--golden <path>", "golden set file", "eval/golden.jsonl")
  .option("--drafts <path>", "pending drafts file", "eval/drafts.jsonl")
  .action(async (opts) => {
    const { connect } = await import("./db.js");
    const { evalDatabaseUrl, assertEvalDatabase, assertEvalConnection } = await import("./eval/db.js");
    const { approveSheetFile } = await import("./eval/review.js");
    const { loadGolden, approvalCounts } = await import("./eval/golden.js");
    const opened: ReturnType<typeof connect>[] = [];
    try {
      const r = await approveSheetFile(opts.sheet, {
        goldenPath: opts.golden,
        draftsPath: opts.drafts,
        sql: async (corpus) => {
          const url = evalDatabaseUrl(corpus);
          assertEvalDatabase(url);
          const sql = connect(url);
          opened.push(sql);
          await assertEvalConnection(sql);
          return sql;
        },
      });
      const edited = r.approved.filter((a) => a.edited).length;
      console.log(`approved ${r.approved.length} (${edited} edited), rejected ${r.rejected.length}, undecided ${r.undecided.length}, already applied ${r.alreadyApplied.length}`);
      const golden = await loadGolden(opts.golden);
      const c = approvalCounts(golden);
      console.log(`${opts.golden} now has ${golden.length} items: ${c.owner} approved by the owner, ${c.agent} written by an agent`);
    } finally {
      for (const s of opened) await s.end();
    }
  });

evalCmd
  .command("reject")
  .description("Drop pending drafts by id")
  .requiredOption("--id <draft id...>", "draft ids, d- and 10 hex digits")
  .option("--drafts <path>", "pending drafts file", "eval/drafts.jsonl")
  .action(async (opts: { id: string[]; drafts: string }) => {
    const { loadDrafts, saveDrafts } = await import("./eval/draft.js");
    const drafts = await loadDrafts(opts.drafts);
    const ids = new Set(opts.id);
    const unknown = opts.id.filter((id) => !drafts.some((d) => d.draft_id === id));
    await saveDrafts(opts.drafts, drafts.filter((d) => !ids.has(d.draft_id)));
    console.log(`rejected ${opts.id.length - unknown.length}; ${drafts.length - (opts.id.length - unknown.length)} drafts pending`);
    for (const id of unknown) console.error(`no pending draft ${id}`);
    if (unknown.length) process.exitCode = 1;
  });

evalCmd
  .command("drafts")
  .description("List pending drafts: id, corpus, kind, document, question, and the review sheet they are on")
  .option("--drafts <path>", "pending drafts file", "eval/drafts.jsonl")
  .action(async (opts) => {
    const { loadDrafts } = await import("./eval/draft.js");
    const { documentLine } = await import("./eval/review.js");
    const drafts = await loadDrafts(opts.drafts);
    if (drafts.length === 0) return void console.log("No pending drafts.");
    for (const d of drafts) console.log(`${d.draft_id}  ${d.corpus.padEnd(8)} ${d.kind.padEnd(11)} ${documentLine(d)}\n    ${d.question}\n    sheet ${d.sheet}`);
    console.log(`${drafts.length} pending`);
  });

evalCmd
  .command("verifier")
  .description("Score the citation verifier on its labelled set: each item, the confusion matrices, precision and recall of supported on the regular and full views (no model or Voyage call)")
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-cli.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck, the suites, and the help text**

Run: `npm run typecheck && npm run test:unit && npm run test:int && npm run brain -- eval --help`
Expected: no type errors; unit 440 passed; integration 319 passed; the help lists `ingest`, `sync`, `run`, `draft`, `approve`, `reject`, `drafts`, `verifier`.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/integration/eval-cli.test.ts
git commit -m "eval draft, approve --sheet, reject --id, drafts: the commands around drafting and the owner's review sheet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `brain eval capture` and `brain eval label`: golden items from real searches

**Files:**
- Modify: `src/db.ts`
- Create: `src/eval/capture.ts`
- Modify: `src/cli.ts`
- Create: `test/integration/eval-capture.test.ts`

`eval capture` lists recent searches from a retrieval log, newest first: id, time, client, mode and source-kind filter, the query, and the first 3 passages with score, source kind, title and document id (a row logged before evidence v2 says it has no passages). With `--corpus real` (default) it reads the knowledge base's log through `connectReadOnly`, so it cannot write there; with `--corpus fixtures`, `brain_eval`'s own log. `eval label <retrieval id> --expect <document> [--quote "…"] [--kind …]` or `--negative` writes one golden item: the logged query as the question, `source: "captured"`, `approved_by: "owner"`, today's date, the retrieval id, the expected document named by id (real) or file name (fixtures), and the logged source kinds for a filter item. It refuses an unknown retrieval id, a document missing from the corpus's eval database (for the real base: "run `npm run brain -- eval sync` first", since sync keeps document ids), a document name that matches more than one document, a quote that is not verbatim in the document, the same search labelled twice, and a question that duplicates a golden item. The owner runs `label`; it is how the owner approves a captured question.

The flow for a question asked of the real base:
1. Ask it in Claude Code; the `brain_search` call is logged in the real base.
2. `npm run brain -- eval capture --client mcp-stdio` shows it with its retrieval id and the documents it returned.
3. `npm run eval:prepare-real` once, then `npm run brain -- eval sync` whenever the real base has new documents.
4. `OBSIDIAN_AUTO=0 npm run brain -- eval label <retrieval id> --expect <document id> --quote "<verbatim span>"`.
5. `OBSIDIAN_AUTO=0 npm run brain -- eval run --corpus real --compare`.

- [ ] **Step 1: Write the failing test**

Create `test/integration/eval-capture.test.ts`:
````ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, wipe, fakeCtx, TEST_DATABASE_URL } from "./helpers.js";
import { connectReadOnly } from "../../src/db.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { search } from "../../src/retrieve/search.js";
import { capturedSearches, renderCaptured, labelCaptured } from "../../src/eval/capture.js";
import { loadGolden } from "../../src/eval/golden.js";

const sql = testDb();
// The retrieval log is read through a read-only connection, as `brain eval capture` reads the real base.
const log = connectReadOnly(TEST_DATABASE_URL);
afterAll(() => Promise.all([sql.end(), log.end()]));

const run = promisify(execFile);

/** Runs `brain eval …` with every database URL on brain_test; the commands that need an eval database refuse it. */
async function brainEval(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("node_modules/.bin/tsx", ["src/cli.ts", "eval", ...args], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, EVAL_DATABASE_URL: TEST_DATABASE_URL, EVAL_REAL_DATABASE_URL: TEST_DATABASE_URL, OBSIDIAN_AUTO: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

let goldenPath: string;
let docId: string;
let retrievalId: string;

beforeEach(async () => {
  await wipe(sql);
  const ctx = fakeCtx(sql);
  const doc = await ingest(ctx, { text: "# Moved to Denver\n\nI signed a lease in the Highland neighborhood, so I now live in Denver for good.", title: "Moved to Denver", sourceKind: "note", origin: "eval/corpus/note--moved-to-denver.md" }, { until: "chunked" });
  docId = doc.id;
  retrievalId = (await search(ctx, "where do I live now", { client: "mcp-stdio", k: 3 })).retrievalId;
  await search(ctx, "denver lease", { client: "cli", sourceKinds: ["note"] });
  goldenPath = join(await mkdtemp(join(tmpdir(), "capture-")), "golden.jsonl");
  await writeFile(goldenPath, "");
});

describe("capturedSearches", () => {
  it("lists recent searches newest first with their top passages, filtered by client", async () => {
    const all = await capturedSearches(log);
    expect(all.map((s) => s.query)).toEqual(["denver lease", "where do I live now"]);
    expect(all[0].sourceKinds).toEqual(["note"]);
    const mcp = await capturedSearches(log, { client: "mcp-stdio" });
    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toMatchObject({ id: retrievalId, client: "mcp-stdio", mode: "hybrid", query: "where do I live now" });
    expect(mcp[0].passages![0]).toMatchObject({ label: "P1", title: "Moved to Denver", documentId: docId, sourceKind: "note" });
    const text = renderCaptured(mcp, "real");
    expect(text).toContain(`${retrievalId}  `);
    expect(text).toContain('  "where do I live now"');
    expect(text).toMatch(/ {4}P1 \d\.\d\d rerank · note · "Moved to Denver" \(doc [0-9a-f-]{36}\)/);
    expect(text).toContain("npm run brain -- eval label <retrieval id> --expect <document id> [--quote");
    expect(await capturedSearches(log, { since: new Date(Date.now() + 60_000) })).toEqual([]);
  });

  it("shows a row logged before evidence v2 without passages", async () => {
    await sql`insert into brain.retrieval_log (query, client) values ('old question', 'mcp-stdio')`;
    const [old] = await capturedSearches(log, { limit: 1 });
    expect(old.passages).toBeNull();
    expect(renderCaptured([old], "real")).toContain("(logged before evidence v2: no passages recorded)");
  });

  it("cannot write through the read-only connection", async () => {
    await expect(log`insert into brain.tool_calls (client, tool, args, ok) values ('x', 'y', '{}'::jsonb, true)`).rejects.toThrow(/read-only transaction/);
  });
});

describe("labelCaptured", () => {
  it("writes a captured item approved by the owner: the logged query, the expected document by id, the quote, the retrieval id", async () => {
    const item = await labelCaptured(log, sql, { retrievalId, expect: docId, quote: "I now live in Denver for good", corpus: "real", goldenPath, today: "2026-10-04" });
    expect(item).toEqual({
      id: `c-${retrievalId.slice(0, 8)}`, question: "where do I live now", kind: "semantic",
      expected: [{ document_id: docId, quote: "I now live in Denver for good" }], source: "captured", negative: false, corpus: "real",
      approved_by: "owner", approved_at: "2026-10-04", retrieval_id: retrievalId,
    });
    expect(await loadGolden(goldenPath)).toEqual([item]);
  });

  it("names a fixture by file name, and takes a negative or a filter item from the logged search", async () => {
    const fixture = await labelCaptured(log, sql, { retrievalId, expect: "note--moved-to-denver.md", corpus: "fixtures", goldenPath, today: "2026-10-04" });
    expect(fixture.expected).toEqual([{ origin: "note--moved-to-denver.md" }]);
    const [lease] = await capturedSearches(log, { client: "cli" });
    const filter = await labelCaptured(log, sql, { retrievalId: lease.id, expect: docId, kind: "filter", corpus: "real", goldenPath });
    expect(filter.filters).toEqual({ sourceKinds: ["note"] });
  });

  it("refuses a document missing from the eval database, with how to fix it, and a quote that is not verbatim", async () => {
    await expect(labelCaptured(log, sql, { retrievalId, expect: "00000000-0000-4000-8000-000000000000", corpus: "real", goldenPath })).rejects.toThrow(
      "document 00000000-0000-4000-8000-000000000000 is not in brain_real_eval; run npm run brain -- eval sync first",
    );
    await expect(labelCaptured(log, sql, { retrievalId, expect: "nowhere.md", corpus: "fixtures", goldenPath })).rejects.toThrow(/is not in brain_eval; ingest it with npm run brain -- eval ingest/);
    await expect(labelCaptured(log, sql, { retrievalId, expect: docId, quote: "I now live in Boulder", corpus: "real", goldenPath })).rejects.toThrow(/the quote is not in document .* verbatim/);
    expect(await loadGolden(goldenPath)).toEqual([]);
  });

  it("refuses an unknown retrieval id, the same search twice, and a duplicate question", async () => {
    await expect(labelCaptured(log, sql, { retrievalId: "00000000-0000-4000-8000-000000000000", negative: true, corpus: "real", goldenPath })).rejects.toThrow(/No logged search has retrieval id/);
    await labelCaptured(log, sql, { retrievalId, negative: true, corpus: "real", goldenPath });
    await expect(labelCaptured(log, sql, { retrievalId, negative: true, corpus: "real", goldenPath })).rejects.toThrow(`retrieval ${retrievalId} is already golden item c-${retrievalId.slice(0, 8)}`);
    const again = (await search(fakeCtx(sql), "Where do I live now?", { client: "mcp-stdio" })).retrievalId;
    await expect(labelCaptured(log, sql, { retrievalId: again, expect: docId, corpus: "real", goldenPath })).rejects.toThrow(`the question duplicates golden item c-${retrievalId.slice(0, 8)}`);
  });

  it("checks the flags: --negative takes no document, a positive item needs one", async () => {
    await expect(labelCaptured(log, sql, { retrievalId, negative: true, expect: docId, corpus: "real", goldenPath })).rejects.toThrow(/--negative takes no --expect/);
    await expect(labelCaptured(log, sql, { retrievalId, corpus: "real", goldenPath })).rejects.toThrow(/--expect <document> is required/);
    await expect(labelCaptured(log, sql, { retrievalId, expect: docId, kind: "filter", corpus: "real", goldenPath })).rejects.toThrow(/no source kind filter/);
  });
});

describe("brain eval capture and label (CLI)", () => {
  it("capture lists the knowledge base's recent searches through a read-only connection", async () => {
    const r = await brainEval(["capture", "--client", "mcp-stdio"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${retrievalId}  `);
    expect(r.stdout).toContain('  "where do I live now"');
  });

  it("label refuses an eval database whose name does not end in _eval", async () => {
    const r = await brainEval(["label", retrievalId, "--negative", "--golden", goldenPath]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Refusing to run the eval against ".*": the database name must end in _eval/);
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-capture.test.ts`
Expected: FAIL: `Cannot find module '../../src/eval/capture.js'`.

- [ ] **Step 3: A connection that cannot write**

In `src/db.ts`, replace:
````ts
  return postgres(url, { max: 10, onnotice: () => {} });
}

export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
````
with:
````ts
  return postgres(url, { max: 10, onnotice: () => {} });
}

/**
 * A connection that cannot write: every transaction it opens is read-only (default_transaction_read_only), so code that
 * only reads another database, such as `brain eval capture` reading the real base's search log, cannot change it.
 */
export function connectReadOnly(url: string): Db {
  return postgres(url, { max: 2, onnotice: () => {}, connection: { default_transaction_read_only: true } });
}

export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
````

- [ ] **Step 4: Capture and label**

Create `src/eval/capture.ts`:
````ts
import { basename } from "node:path";
import type { Db } from "../db.js";
import { UUID } from "../retrieve/documents.js";
import { LoggedPassageSchema } from "../retrieve/contract.js";
import { stemAll } from "../verify/terms.js";
import { appendGolden, loadGolden, validateGoldenItem, type Corpus, type GoldenItem, type GoldenKind } from "./golden.js";
import { duplicateOf, quoteInDocument } from "./draft.js";

/**
 * Golden items from real questions (spec §8.3). `brain eval capture` lists recent searches from a retrieval log;
 * `brain eval label` turns one into a golden item (source captured, approved by the owner, who runs it) after checking
 * the expected document is in the eval database the item will run against.
 */

/** How many passages of each search `capture` shows. */
export const CAPTURE_PASSAGES = 3;

export interface CapturedPassage {
  label: string;
  title: string | null;
  score: number | null;
  scoreKind: string;
  documentId: string;
  sourceKind: string;
}

export interface CapturedSearch {
  id: string;
  createdAt: string;
  client: string | null;
  query: string;
  mode: string | null;
  sourceKinds: string[];
  /** The first CAPTURE_PASSAGES passages; null for a row logged before evidence v2 (no passages recorded). */
  passages: CapturedPassage[] | null;
}

export interface CaptureOptions {
  since?: Date;
  client?: string;
  /** Default 20. */
  limit?: number;
}

/** Recent searches, newest first. Read-only. */
export async function capturedSearches(sql: Db, opts: CaptureOptions = {}): Promise<CapturedSearch[]> {
  const rows = await sql<{ id: string; created_at: Date; client: string | null; query: string; mode: string | null; filters: Record<string, unknown> | null; results: unknown }[]>`
    select id, created_at, client, query, mode, filters, results
    from brain.retrieval_log
    where (${opts.since ?? null}::timestamptz is null or created_at >= ${opts.since ?? null}::timestamptz)
      and (${opts.client ?? null}::text is null or client = ${opts.client ?? null}::text)
    order by created_at desc
    limit ${opts.limit ?? 20}`;
  return rows.map((r) => {
    const parsed = LoggedPassageSchema.array().safeParse(r.results);
    const sourceKinds = Array.isArray(r.filters?.sourceKinds) ? (r.filters!.sourceKinds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    return {
      id: r.id,
      createdAt: r.created_at.toISOString(),
      client: r.client,
      query: r.query,
      mode: r.mode,
      sourceKinds,
      passages: r.results === null || !parsed.success
        ? null
        : parsed.data.slice(0, CAPTURE_PASSAGES).map((p, i) => ({ label: `P${i + 1}`, title: p.title, score: p.score, scoreKind: p.scoreKind, documentId: p.documentId, sourceKind: p.sourceKind })),
    };
  });
}

/** What `brain eval capture` prints: one block per search, then how to label one. */
export function renderCaptured(searches: CapturedSearch[], corpus: Corpus): string {
  if (searches.length === 0) return "No logged searches match.";
  const out: string[] = [];
  for (const s of searches) {
    const filters = s.sourceKinds.length ? ` · source_kinds ${s.sourceKinds.join(", ")}` : "";
    out.push(`${s.id}  ${s.createdAt.slice(0, 16).replace("T", " ")}  ${s.client ?? "unknown"}  ${s.mode ?? "pre-v2"}${filters}`, `  "${s.query}"`);
    if (s.passages === null) out.push("    (logged before evidence v2: no passages recorded)");
    else if (s.passages.length === 0) out.push("    (no passages)");
    for (const p of s.passages ?? []) {
      const score = p.score === null ? "-" : `${p.score.toFixed(p.scoreKind === "rrf" ? 4 : 2)} ${p.scoreKind}`;
      out.push(`    ${p.label} ${score} · ${p.sourceKind} · ${p.title ? `"${p.title}"` : "(untitled)"} (doc ${p.documentId})`);
    }
  }
  out.push(
    "",
    `Label one: npm run brain -- eval label <retrieval id> --expect <document id${corpus === "fixtures" ? " or file name" : ""}> [--quote "<verbatim span>"] [--kind semantic] [--corpus ${corpus}]`,
    "or, for a question the knowledge base cannot answer: npm run brain -- eval label <retrieval id> --negative",
  );
  return out.join("\n");
}

export interface LabelOptions {
  retrievalId: string;
  /** A document id, or (fixtures) a file name or origin suffix. Required unless negative. */
  expect?: string;
  quote?: string;
  negative?: boolean;
  /** Default semantic; negative with --negative. */
  kind?: GoldenKind;
  corpus: Corpus;
  goldenPath: string;
  /** YYYY-MM-DD; defaults to today (UTC). */
  today?: string;
}

const where = (corpus: Corpus) =>
  corpus === "real"
    ? "brain_real_eval; run npm run brain -- eval sync first (it copies the real knowledge base into brain_real_eval, document ids included)"
    : "brain_eval; ingest it with npm run brain -- eval ingest";

/**
 * Writes one golden item from a logged search: the search's query as the question, source captured, approved_by owner,
 * the retrieval id kept. logSql reads the retrieval log the search is in (the real base for corpus real, opened read-
 * only); evalSql is the eval database the item will run against, which must hold the expected document. Refuses an
 * unknown retrieval id, a document not in the eval database (or matching more than one), a quote that is not verbatim
 * in it, and a question that duplicates a golden item.
 */
export async function labelCaptured(logSql: Db, evalSql: Db, opts: LabelOptions): Promise<GoldenItem> {
  if (!UUID.test(opts.retrievalId)) throw new Error(`"${opts.retrievalId}" is not a retrieval id; brain eval capture lists them`);
  const [row] = await logSql<{ query: string; filters: Record<string, unknown> | null }[]>`
    select query, filters from brain.retrieval_log where id = ${opts.retrievalId}`;
  if (!row) throw new Error(`No logged search has retrieval id "${opts.retrievalId}"; brain eval capture lists them`);
  const kind: GoldenKind = opts.negative ? "negative" : opts.kind ?? "semantic";
  if (opts.negative && (opts.expect || opts.quote)) throw new Error("--negative takes no --expect or --quote: nothing in the knowledge base answers it");
  if (!opts.negative && kind === "negative") throw new Error("use --negative for a question the knowledge base cannot answer");
  if (!opts.negative && !opts.expect) throw new Error("--expect <document> is required unless --negative");

  const expected: GoldenItem["expected"] = [];
  if (!opts.negative) {
    const want = opts.expect!;
    const docs = await evalSql<{ id: string; origin: string | null; raw_content: string }[]>`
      select id, origin, raw_content from brain.documents
      where id::text = ${want} or origin = ${want} or right(origin, length(${want}) + 1) = '/' || ${want}`;
    if (docs.length === 0) throw new Error(`document ${want} is not in ${where(opts.corpus)}`);
    if (docs.length > 1) throw new Error(`${want} matches ${docs.length} documents in the eval database; pass a document id`);
    const doc = docs[0];
    if (opts.quote !== undefined && !quoteInDocument(opts.quote, doc.raw_content)) throw new Error(`the quote is not in document ${doc.id} verbatim (whitespace may differ, nothing else)`);
    const name = opts.corpus === "fixtures" && doc.origin ? { origin: basename(doc.origin) } : { document_id: doc.id };
    expected.push({ ...name, ...(opts.quote !== undefined ? { quote: opts.quote } : {}) });
  }

  const sourceKinds = Array.isArray(row.filters?.sourceKinds) ? (row.filters!.sourceKinds as string[]) : [];
  if (kind === "filter" && sourceKinds.length === 0) throw new Error("the logged search had no source kind filter, so it cannot be a filter item; pick another --kind");
  const v = validateGoldenItem({
    id: `c-${opts.retrievalId.slice(0, 8)}`,
    question: row.query,
    kind,
    expected,
    ...(kind === "filter" ? { filters: { sourceKinds } } : {}),
    source: "captured",
    negative: kind === "negative",
    corpus: opts.corpus,
    approved_by: "owner",
    approved_at: opts.today ?? new Date().toISOString().slice(0, 10),
    retrieval_id: opts.retrievalId,
  });
  if (!v.ok) throw new Error(`not a valid golden item: ${v.errors}`);
  const golden = await loadGolden(opts.goldenPath);
  const same = golden.find((g) => g.retrieval_id === opts.retrievalId);
  if (same) throw new Error(`retrieval ${opts.retrievalId} is already golden item ${same.id}`);
  const stems = await stemAll(evalSql, [row.query, ...golden.map((g) => g.question)]);
  const dup = duplicateOf(row.query, golden.map((g) => ({ id: g.id, question: g.question })), stems);
  if (dup) throw new Error(`the question duplicates golden item ${dup}`);
  await appendGolden(opts.goldenPath, [v.item]);
  return v.item;
}
````

- [ ] **Step 5: The commands**

In `src/cli.ts`, replace:
````ts
    console.log(`${drafts.length} pending`);
  });

evalCmd
  .command("verifier")
  .description("Score the citation verifier on its labelled set: each item, the confusion matrices, precision and recall of supported on the regular and full views (no model or Voyage call)")
````
with:
````ts
    console.log(`${drafts.length} pending`);
  });

evalCmd
  .command("capture")
  .description("List recent logged searches (query, mode, top passages with titles and scores, retrieval id) to label as golden items; reads the log only")
  .option("--corpus <corpus>", "real: the knowledge base's log (DATABASE_URL, opened read-only); fixtures: brain_eval's log", "real")
  .option("--since <date>", "only searches on or after this date")
  .option("--client <client>", "only searches from this client: mcp-stdio, mcp-http, cli")
  .option("--limit <n>", "at most this many searches", "20")
  .action(async (opts) => {
    const corpus = corpusOption(opts.corpus);
    const { connectReadOnly } = await import("./db.js");
    const { EVAL_DATABASE_URL } = await import("./eval/db.js");
    const { capturedSearches, renderCaptured } = await import("./eval/capture.js");
    const sql = connectReadOnly(corpus === "real" ? config.databaseUrl : EVAL_DATABASE_URL);
    try {
      const rows = await capturedSearches(sql, { since: opts.since ? new Date(opts.since) : undefined, client: opts.client, limit: Number(opts.limit) });
      console.log(renderCaptured(rows, corpus));
    } finally {
      await sql.end();
    }
  });

evalCmd
  .command("label <retrievalId>")
  .description("Write a golden item (source captured, approved_by owner) from a logged search; the expected document must be in the corpus's eval database")
  .option("--expect <document>", "the document that answers it: document id (or, for fixtures, file name)")
  .option("--quote <text>", "a verbatim span of that document that answers it")
  .option("--negative", "nothing in the knowledge base answers it")
  .option("--kind <kind>", "keyword, semantic, graph, filter, fallback or attribution", "semantic")
  .option("--corpus <corpus>", "real (log: DATABASE_URL read-only; documents: brain_real_eval) or fixtures (both brain_eval)", "real")
  .option("--golden <path>", "golden set file", "eval/golden.jsonl")
  .action(async (retrievalId: string, opts) => {
    const corpus = corpusOption(opts.corpus);
    const { connect, connectReadOnly } = await import("./db.js");
    const { evalDatabaseUrl, assertEvalDatabase, assertEvalConnection, evalDatabaseHint } = await import("./eval/db.js");
    const { labelCaptured } = await import("./eval/capture.js");
    const { GOLDEN_KINDS } = await import("./eval/golden.js");
    if (!(GOLDEN_KINDS as readonly string[]).includes(opts.kind)) throw new Error(`--kind must be one of ${GOLDEN_KINDS.join(", ")}, got ${JSON.stringify(opts.kind)}`);
    const evalUrl = evalDatabaseUrl(corpus);
    assertEvalDatabase(evalUrl);
    const log = connectReadOnly(corpus === "real" ? config.databaseUrl : evalUrl);
    const evalSql = connect(evalUrl);
    try {
      await assertEvalConnection(evalSql);
      const item = await labelCaptured(log, evalSql, { retrievalId, expect: opts.expect, quote: opts.quote, negative: !!opts.negative, kind: opts.kind, corpus, goldenPath: opts.golden });
      console.log(`golden item ${item.id} written to ${opts.golden}: "${item.question}" (${item.kind}, ${corpus})`);
    } catch (e) {
      throw evalDatabaseHint(e, corpus);
    } finally {
      await Promise.all([log.end(), evalSql.end()]);
    }
  });

evalCmd
  .command("verifier")
  .description("Score the citation verifier on its labelled set: each item, the confusion matrices, precision and recall of supported on the regular and full views (no model or Voyage call)")
````

- [ ] **Step 6: Run the test to verify it passes**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-capture.test.ts`
Expected: PASS (10 tests). The read-only test shows the guard: an insert through `connectReadOnly` fails with `cannot execute INSERT in a read-only transaction`.

- [ ] **Step 7: Typecheck and the suites**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: no type errors; unit 440 passed; integration 329 passed.

- [ ] **Step 8: Commit**

```bash
git add src/db.ts src/eval/capture.ts src/cli.ts test/integration/eval-capture.test.ts
git commit -m "eval capture lists logged searches through a read-only connection; eval label writes a captured golden item approved by the owner after checking the document is in the eval database (eval sync first for the real base)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The fixture corpus: 25 documents with shared people and planted traps

**Files:**
- Create: `test/unit/corpus-fixtures.test.ts`
- Create: 16 files in `eval/corpus/` (listed below)
- Modify: `eval/golden.jsonl`
- Modify: `test/unit/golden-fixtures.test.ts`

The real knowledge base holds 2 documents, so the golden set grows on the fixture corpus. Sixteen new documents join the nine existing ones (which stay byte for byte: `eval/verifier.jsonl` quotes them). The texts are fictional and written fresh for this eval at implementation time; do not copy any real article, post or email. What each file must say is fixed by `test/unit/corpus-fixtures.test.ts`: its author (front matter, or its kind's default from `config.authorDefaults`), its title (the first line, `# <title>`), every sentence listed under `required` (verbatim, whitespace aside), and nothing listed under `forbidden`; names shared across files; no answer to the negative questions; 60 to 400 words. The briefs below say what else each file contains and which trap it plants, so two writers produce documents that plant the same facts. Write each file as `# <title>`, then a blank line, then the body; files that need front matter start with it (`---`, `author: …`, `---`).

Entities shared across files, so graph questions have something to traverse: Priya Natarajan (Acme hiring manager), Luis Ortega (Acme VP of Operations), Marcus Hale (Acme CEO), Jordan Ellis (Beta Ventures talent partner), Dana Whitfield (Beta Ventures partner, Acme board), Sam Okafor (Northwind recruiter), Taylor Brooks (Northwind VP of Operations), Wei Zhang (the owner's former colleague at Brightline Analytics, now at Northwind), Acme Corp, Northwind Robotics, Beta Ventures, Brightline Analytics, Quill Health, the ZX-9000. The counts the test requires are in `SHARED`.

Seven golden items written by the agent pin the traps (`approved_by: "agent"`, counted as agent items everywhere): f01 (misattribution: the owner's years of experience against two third-party posts), f02 (supersession: where the owner lived before Denver), f03 (a near-duplicate code), f04 (a moved date), a04 and a05 (attribution: claims by Hannah Leclerc and Priya Natarajan), n02 (negative: no document states a result of the SQL screen). With a04 and a05 the set holds the spec's five attribution items whatever the owner decides about drafts; `test/unit/golden-fixtures.test.ts` now requires five, and judges a fixture's author by its front matter or its kind's default (emails have no front matter).

- [ ] **Step 1: Write the failing test**

Create `test/unit/corpus-fixtures.test.ts`:
````ts
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { splitFrontMatter, normalizeWhitespace, kindFromFilename } from "../../src/eval/run.js";
import { defaultAuthor } from "../../src/ingest/author.js";

/**
 * The fixture corpus, file by file: who wrote it, its title, and the sentences each file must contain verbatim. The
 * golden set and eval/verifier.jsonl quote these files, and the briefs in the Phase 6 plan were written against this
 * list, so a rewrite of any file keeps the facts it plants. The first nine files predate Phase 6 and are checked for
 * title and author only (eval/verifier.jsonl and test/unit/verifier-fixtures.test.ts pin their text).
 */
const CORPUS: Record<string, { author: "owner" | "other"; title: string; required?: string[]; forbidden?: string[] }> = {
  "conversation--interview-prep-with-priya.md": { author: "owner", title: "Interview prep call with Priya Natarajan" },
  "email--recruiter-followup-beta-ventures.md": { author: "other", title: "Re: Analyst opening at a Beta Ventures portfolio company" },
  "email--recruiter-intro.md": { author: "other", title: "Introducing Frank Fu for the Northwind Robotics analytics lead opening" },
  "job_description--acme-senior-data-analyst.md": { author: "other", title: "Senior Data Analyst, Acme Corp (Austin, TX)" },
  "news--acme-series-b.md": { author: "other", title: "Acme Corp raises $40M Series B led by Beta Ventures" },
  "note--databricks-cost-governance.md": { author: "other", title: "What a runaway Databricks bill taught me about cost governance" },
  "note--fairness-in-ml.md": { author: "owner", title: "Notes on fairness in machine learning" },
  "note--moved-to-denver.md": { author: "owner", title: "Moved to Denver" },
  "paper--contextual-retrieval-abstract.md": { author: "other", title: "Contextual Retrieval: prepending document context to chunks" },
  "note--settling-in-austin.md": {
    author: "owner", title: "Settling in Austin",
    required: ["Date: 2026-03-02", "I live in Austin now, in a one-bedroom apartment in East Austin.", "My lease runs for twelve months, through February 2027.", "I am on F-1 OPT"],
    forbidden: ["Denver"],
  },
  "note--job-search-priorities.md": {
    author: "owner", title: "Job search priorities, end of September",
    required: [
      "Date: 2026-09-28", "I am targeting analytics lead or senior data analyst roles.", "My minimum base salary is $130,000.",
      "Northwind Robotics is my first choice and Acme Corp is my second.", "Any role must be based in Denver or fully remote, because I moved to Denver this month.",
      "I still need an employer that will sponsor an H-1B.", "Wei Zhang, who now works at Northwind, says the analytics team is growing.",
    ],
  },
  "job_description--acme-data-analyst-ii.md": {
    author: "other", title: "Data Analyst II, Acme Corp (Austin, TX)",
    required: [
      "Requisition REQ-4417.", "Support the ZX-9000 service team with weekly warranty reports.", "## Compensation and visa", "Base salary range $92,000 to $108,000.",
      "Acme does not sponsor visas for this role.", "On-site five days a week in the Austin office.", "Hiring manager: Priya Natarajan.",
      "The team reports to Luis Ortega, VP of Operations.",
    ],
  },
  "job_description--northwind-analytics-lead.md": {
    author: "other", title: "Analytics Lead, Northwind Robotics (Denver, CO)",
    required: [
      "Requisition NWR-0912.", "You will lead a team of four analysts", "Reports to Taylor Brooks, VP of Operations.", "Base salary range $150,000 to $175,000.",
      "Northwind sponsors H-1B transfers and new H-1B petitions for this role.", "Hybrid, two days a week in the Denver office.",
    ],
  },
  "meeting--acme-case-study-panel.md": {
    author: "owner", title: "Acme case study panel, transcript",
    required: [
      "Date: 2026-09-29", "ZX-9000",
      "Frank: Failures cluster in units built in the third quarter of 2025, and almost all of those used bearings from Kessler Bearings.",
      "The field-failure rate was 4.2 percent for those units against 1.1 percent for the rest.",
      "Luis Ortega: The role needs three days a week in Austin, but we can offer $8,000 in relocation support.",
      "Priya Natarajan: We will make a decision by October 10.",
    ],
  },
  "paper--late-interaction-reranking-abstract.md": {
    author: "other", title: "Late-interaction reranking for long documents",
    required: ["Abstract.", "SpanRank", "Across 12 datasets the method cut the top-20 retrieval failure rate by 21 percent", "added 38 milliseconds of latency per query"],
  },
  "news--acme-zx-9100-launch.md": {
    author: "other", title: "Acme Corp unveils the ZX-9100 drill",
    required: ["AUSTIN, September 8, 2026.", "the successor to the ZX-9000", "The ZX-9100 is priced at $1.2 million per unit", "CEO Marcus Hale", "the expanded Austin facility will add 120 jobs"],
  },
  "news--beta-ventures-fund-iii.md": {
    author: "other", title: "Beta Ventures closes $310 million Fund III",
    required: ["SAN FRANCISCO, September 15, 2026.", "Beta Ventures has closed its third fund at $310 million", "partner Dana Whitfield", "Its portfolio includes Acme Corp and Northwind Robotics.", "run by Jordan Ellis"],
  },
  "note--causal-inference-lecture-4.md": {
    author: "owner", title: "DATA 6100 lecture 4: difference-in-differences",
    required: ["Date: 2026-09-17", "DATA 6100 Causal Inference for Analysts", "Professor Elena Marsh", "The key assumption is parallel trends", "synthetic control", "Problem set 2 is due on 2026-10-08."],
  },
  "application--northwind-cover-letter.md": {
    author: "owner", title: "Cover letter: Analytics Lead, Northwind Robotics",
    required: [
      "Date: 2026-09-27", "Dear Taylor Brooks,", "Sam Okafor suggested I write to you directly", "I have four years of experience in analytics",
      "my churn model cut monthly churn by 9 percent", "I led the migration of 140 dbt models to Snowflake", "My F-1 OPT STEM extension is valid until 2027-06-30",
    ],
  },
  "note--churn-model-retro.md": {
    author: "owner", title: "Retro: Atlas churn model",
    required: [
      "Date: 2026-06-12", "We shipped the Atlas churn model in May 2026", "Brightline Analytics", "The final model reached an AUC of 0.81",
      "Monthly churn fell by 9 percent in the first quarter after launch.", "label leakage from the account_closed_at column", "Wei Zhang rebuilt the feature pipeline",
    ],
  },
  "article--metric-trees.md": {
    author: "other", title: "Metric trees: how I stopped arguing about dashboards",
    required: ["By Hannah Leclerc", "I have built metric trees at three companies over 12 years", "Start from one north-star metric", "no more than four levels deep"],
  },
  "email--acme-final-round.md": {
    author: "other", title: "Acme Senior Data Analyst: final round",
    required: [
      "From: Priya Natarajan, Hiring Manager, Acme Corp", "Date: 2026-09-30", "Hi Frank,", "Requisition REQ-4471.", "we would like to invite you to a final round on October 7",
      "We will make a decision by October 10, and any offer would need an answer by October 17.",
    ],
  },
  "email--northwind-panel-rescheduled.md": {
    author: "other", title: "Northwind panel moved to October 8",
    required: [
      "From: Sam Okafor, Technical Recruiter, Northwind Robotics", "Date: 2026-10-01", "Hi Frank,",
      "Your panel interview has moved from October 6 to October 8 at 1:00 pm Mountain Time.", "Taylor Brooks", "Ana Duarte, a senior analyst on the team, will join the panel.",
    ],
  },
  "conversation--coffee-with-jordan-ellis.md": {
    author: "owner", title: "Coffee with Jordan Ellis",
    required: [
      "Date: 2026-09-24", "Jordan said Quill Health, another Beta Ventures portfolio company, is hiring a data science manager in Boulder.",
      "he advised me to ask Northwind for a base of at least $160,000", "Dana Whitfield sits on the boards of both Acme Corp and Quill Health",
    ],
  },
  "note--visa-timeline.md": {
    author: "owner", title: "Visa timeline",
    required: [
      "Date: 2026-09-21", "My OPT STEM extension ends on 2027-06-30.", "The next H-1B registration window opens in March 2027.",
      "If I am not selected in the lottery, I have a 60-day grace period after my OPT ends.",
      "Acme Corp sponsors H-1B for the senior analyst role, and Northwind Robotics sponsors new petitions.",
    ],
  },
};

/** People and companies the graph questions traverse: each must appear in at least this many files. */
const SHARED: Record<string, number> = {
  "Priya Natarajan": 5, "Jordan Ellis": 3, "Sam Okafor": 3, "Taylor Brooks": 3, "Dana Whitfield": 3, "Wei Zhang": 2, "Luis Ortega": 2,
  "Marcus Hale": 2, "Beta Ventures": 4, "Northwind Robotics": 7, "Acme Corp": 10, "ZX-9000": 5, "Brightline Analytics": 2, "Quill Health": 1,
};

const read = async (name: string) => splitFrontMatter(await readFile(`eval/corpus/${name}`, "utf8"));

describe("eval/corpus", () => {
  it("holds exactly the 25 files listed", async () => {
    expect((await readdir("eval/corpus")).sort()).toEqual(Object.keys(CORPUS).sort());
  });

  it("each file has its title, its author (front matter, or its kind's default), and every required sentence verbatim", async () => {
    for (const [name, spec] of Object.entries(CORPUS)) {
      const { author, body } = await read(name);
      const effective = author ?? defaultAuthor(kindFromFilename(name));
      expect([name, effective]).toEqual([name, spec.author]);
      expect([name, body.split("\n")[0]]).toEqual([name, `# ${spec.title}`]);
      const text = normalizeWhitespace(body);
      for (const r of spec.required ?? []) expect([name, r, text.includes(normalizeWhitespace(r))]).toEqual([name, r, true]);
      for (const f of spec.forbidden ?? []) expect([name, f, text.includes(f)]).toEqual([name, f, false]);
    }
  });

  it("names the shared people and companies across files, so graph questions have something to traverse", async () => {
    const texts = await Promise.all(Object.keys(CORPUS).map(async (n) => (await read(n)).body));
    for (const [entity, min] of Object.entries(SHARED)) {
      expect([entity, texts.filter((t) => t.includes(entity)).length >= min]).toEqual([entity, true]);
    }
  });

  it("answers none of the negative questions: no Kyoto dinner, no result of the Acme SQL screen", async () => {
    for (const name of Object.keys(CORPUS)) {
      const { body } = await read(name);
      expect([name, /kyoto|sushi/i.test(body)]).toEqual([name, false]);
      expect([name, /SQL screen[^.]*\b(passed|failed|score|scored|result)/i.test(body)]).toEqual([name, false]);
    }
  });

  it("keeps the new files short: 60 to 400 words each", async () => {
    for (const [name, spec] of Object.entries(CORPUS)) {
      if (!spec.required) continue;
      const words = (await read(name)).body.split(/\s+/).filter(Boolean).length;
      expect([name, words >= 60 && words <= 400]).toEqual([name, true]);
    }
  });
});
````

In `test/unit/golden-fixtures.test.ts`, replace:
````ts
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { parseGolden } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace } from "../../src/eval/run.js";

const golden = async () => parseGolden(await readFile("eval/golden.jsonl", "utf8"));
const fixture = async (origin: string) => splitFrontMatter(await readFile(`eval/corpus/${origin}`, "utf8"));
````
with:
````ts
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { parseGolden } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace, kindFromFilename } from "../../src/eval/run.js";
import { defaultAuthor } from "../../src/ingest/author.js";

const golden = async () => parseGolden(await readFile("eval/golden.jsonl", "utf8"));
const fixture = async (origin: string) => splitFrontMatter(await readFile(`eval/corpus/${origin}`, "utf8"));
````

In `test/unit/golden-fixtures.test.ts`, replace:
````ts
      }
    }
  });
  it("has at least three attribution items, each naming a fixture marked author: other, and a negative item", async () => {
    const items = await golden();
    const attribution = items.filter((i) => i.kind === "attribution");
    expect(attribution.length).toBeGreaterThanOrEqual(3);
    for (const a of attribution) {
      for (const e of a.expected) expect([a.id, (await fixture(e.origin!)).author]).toEqual([a.id, "other"]);
    }
    expect(items.some((i) => i.negative)).toBe(true);
  });
````
with:
````ts
      }
    }
  });
  it("has at least five attribution items, each naming a fixture the owner did not write (front matter or its kind's default), and a negative item", async () => {
    const items = await golden();
    const attribution = items.filter((i) => i.kind === "attribution");
    expect(attribution.length).toBeGreaterThanOrEqual(5);
    for (const a of attribution) {
      for (const e of a.expected) expect([a.id, (await fixture(e.origin!)).author ?? defaultAuthor(kindFromFilename(e.origin!))]).toEqual([a.id, "other"]);
    }
    expect(items.some((i) => i.negative)).toBe(true);
  });
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/corpus-fixtures.test.ts test/unit/golden-fixtures.test.ts`
Expected: FAIL, 6 tests: all five in `corpus-fixtures.test.ts` (the 16 new files do not exist yet, so the listing differs and reading them fails with `ENOENT`) and `has at least five attribution items` (3 so far).

- [ ] **Step 3: Write the 16 documents from these briefs**

**`eval/corpus/note--settling-in-austin.md`**: no front matter (the `note` default is `owner`); title `# Settling in Austin`.
- Content: Owner note written shortly after arriving in Austin, seven months before the existing `note--moved-to-denver.md`. A date line, then two short paragraphs: where the owner lives and the lease; practical life (commute, keeping visa documents together, plans for spring such as finishing a dbt migration at work and applying to analytics roles in Texas).
- Must contain, verbatim:
  - `Date: 2026-03-02`
  - `I live in Austin now, in a one-bedroom apartment in East Austin.`
  - `My lease runs for twelve months, through February 2027.`
  - `I am on F-1 OPT`
- Must not contain: `Denver`
- Traps and links: **Supersession trap** (closes the roadmap follow-up): an owner document dated 2026-03-02 states `lives_in` Austin, so ingesting it and `note--moved-to-denver.md` (2026-09-26) leaves Denver current and Austin superseded, with a `fact_events` row. It must not mention Denver. Golden item f02 quotes it.

**`eval/corpus/note--job-search-priorities.md`**: no front matter (the `note` default is `owner`); title `# Job search priorities, end of September`.
- Content: Owner note listing current job-search rules: target roles, minimum base salary, ranking of the two companies, location rule, sponsorship need, why Northwind is first (Wei Zhang's remark), why Acme is second (three days in Austin), and one or two things the owner will not do again.
- Must contain, verbatim:
  - `Date: 2026-09-28`
  - `I am targeting analytics lead or senior data analyst roles.`
  - `My minimum base salary is $130,000.`
  - `Northwind Robotics is my first choice and Acme Corp is my second.`
  - `Any role must be based in Denver or fully remote, because I moved to Denver this month.`
  - `I still need an employer that will sponsor an H-1B.`
  - `Wei Zhang, who now works at Northwind, says the analytics team is growing.`
- Traps and links: Number trap: `$130,000` against the salary ranges in the job posts. Graph link: Wei Zhang works at Northwind (he also appears in the churn retro). States a `targeting_role`.

**`eval/corpus/job_description--acme-data-analyst-ii.md`**: no front matter (the `job_description` default is `other`); title `# Data Analyst II, Acme Corp (Austin, TX)`.
- Content: A second Acme job post, deliberately built like `job_description--acme-senior-data-analyst.md`: the same three headings (`## Responsibilities`, `## Requirements`, `## Compensation and visa`), three responsibilities (one being the ZX-9000 warranty reports), two requirements (2+ years, SQL, dbt familiarity), then the compensation paragraph.
- Must contain, verbatim:
  - `Requisition REQ-4417.`
  - `Support the ZX-9000 service team with weekly warranty reports.`
  - `## Compensation and visa`
  - `Base salary range $92,000 to $108,000.`
  - `Acme does not sponsor visas for this role.`
  - `On-site five days a week in the Austin office.`
  - `Hiring manager: Priya Natarajan.`
  - `The team reports to Luis Ortega, VP of Operations.`
- Traps and links: **Near-duplicate distractor** for q01 and q03: same company, city, team, hiring manager and headings, but a lower salary, no visa sponsorship and five days on site. **Code trap:** `REQ-4417` against `REQ-4471` in `email--acme-final-round.md`.

**`eval/corpus/job_description--northwind-analytics-lead.md`**: no front matter (the `job_description` default is `other`); title `# Analytics Lead, Northwind Robotics (Denver, CO)`.
- Content: Northwind Robotics' post for the analytics lead role (the role in `email--recruiter-intro.md`): one line on what Northwind makes (autonomous warehouse carts), `## The role` (team of four, what they own, who it reports to), `## What we look for` (three bullets), `## Compensation and visa`.
- Must contain, verbatim:
  - `Requisition NWR-0912.`
  - `You will lead a team of four analysts`
  - `Reports to Taylor Brooks, VP of Operations.`
  - `Base salary range $150,000 to $175,000.`
  - `Northwind sponsors H-1B transfers and new H-1B petitions for this role.`
  - `Hybrid, two days a week in the Denver office.`
- Traps and links: Graph: Taylor Brooks as VP of Operations at Northwind, a title Luis Ortega holds at Acme (entity confusion trap). Numbers against the owner's $130,000 minimum and Jordan's $160,000 advice.

**`eval/corpus/meeting--acme-case-study-panel.md`**: front matter `author: owner`; title `# Acme case study panel, transcript`.
- Content: A transcript of the Acme case-study panel on 2026-09-29, speaker-labelled lines (`Frank:`, `Priya Natarajan:`, `Luis Ortega:`), with a `Present:` line naming Luis Ortega as VP of Operations, Acme Corp. Priya opens; Frank presents the ZX-9000 warranty finding in two sentences on one line; Luis asks whether it is the bearings or the build quarter and Frank answers that units from that quarter with the other supplier's bearings fail at the normal rate; Luis notes Frank is in Denver now and Frank confirms he moved last week; Luis states the relocation offer; Priya closes with the decision date.
- Must contain, verbatim:
  - `Date: 2026-09-29`
  - `ZX-9000`
  - `Frank: Failures cluster in units built in the third quarter of 2025, and almost all of those used bearings from Kessler Bearings.`
  - `The field-failure rate was 4.2 percent for those units against 1.1 percent for the rest.`
  - `Luis Ortega: The role needs three days a week in Austin, but we can offer $8,000 in relocation support.`
  - `Priya Natarajan: We will make a decision by October 10.`
- Traps and links: Front matter `author: owner` (a meeting has no default author). Numbers 4.2 and 1.1 percent, $8,000, October 10 (repeated in the final-round email). Must not state any result of the SQL screen.

**`eval/corpus/paper--late-interaction-reranking-abstract.md`**: no front matter (the `paper` default is `other`); title `# Late-interaction reranking for long documents`.
- Content: One-paragraph abstract of a fictional paper: cross-encoders are accurate but slow on long documents; SpanRank scores documents by best-matching spans from token embeddings stored at indexing time; the result; the latency cost; gains largest for documents longer than 4,000 tokens.
- Must contain, verbatim:
  - `Abstract.`
  - `SpanRank`
  - `Across 12 datasets the method cut the top-20 retrieval failure rate by 21 percent`
  - `added 38 milliseconds of latency per query`
- Traps and links: **Near-duplicate distractor** for q06: another retrieval-failure paper, with 12 datasets and 21 percent against the contextual-retrieval abstract's 9 datasets and 49 percent.

**`eval/corpus/news--acme-zx-9100-launch.md`**: no front matter (the `news` default is `other`); title `# Acme Corp unveils the ZX-9100 drill`.
- Content: Two-paragraph news item with a dateline: Acme introduces the ZX-9100, successor to the ZX-9000, at its Austin plant; price and a speed claim (about 30 percent faster in hard rock); a quote from CEO Marcus Hale; deliveries from the first quarter of 2027; the expanded facility's jobs.
- Must contain, verbatim:
  - `AUSTIN, September 8, 2026.`
  - `the successor to the ZX-9000`
  - `The ZX-9100 is priced at $1.2 million per unit`
  - `CEO Marcus Hale`
  - `the expanded Austin facility will add 120 jobs`
- Traps and links: **Code trap:** `ZX-9100` against `ZX-9000` (q09 asks what the ZX-9000 is). Marcus Hale appears in the Series B news too.

**`eval/corpus/news--beta-ventures-fund-iii.md`**: no front matter (the `news` default is `other`); title `# Beta Ventures closes $310 million Fund III`.
- Content: Two-paragraph news item with a dateline: Beta Ventures closes Fund III; what it invests in (industrial and logistics companies); its portfolio; a quote from partner Dana Whitfield; plans to grow the talent program run by Jordan Ellis.
- Must contain, verbatim:
  - `SAN FRANCISCO, September 15, 2026.`
  - `Beta Ventures has closed its third fund at $310 million`
  - `partner Dana Whitfield`
  - `Its portfolio includes Acme Corp and Northwind Robotics.`
  - `run by Jordan Ellis`
- Traps and links: Graph: Beta Ventures connects Acme Corp, Northwind Robotics, Dana Whitfield and Jordan Ellis (q08 asks which companies Beta Ventures is connected to). Number `$310 million` against the Series B's `$40 million`.

**`eval/corpus/note--causal-inference-lecture-4.md`**: no front matter (the `note` default is `owner`); title `# DATA 6100 lecture 4: difference-in-differences`.
- Content: Owner course note: a date line, the course line, then three short paragraphs on difference-in-differences (what it compares; the parallel-trends assumption and how to check it on the pre-period), synthetic control when no single control group is credible, and the problem-set due date.
- Must contain, verbatim:
  - `Date: 2026-09-17`
  - `DATA 6100 Causal Inference for Analysts`
  - `Professor Elena Marsh`
  - `The key assumption is parallel trends`
  - `synthetic control`
  - `Problem set 2 is due on 2026-10-08.`
- Traps and links: A course code (`DATA 6100`) and a date (`2026-10-08`) for keyword and fallback questions; a topic unrelated to the job search, for semantic questions and negatives.

**`eval/corpus/application--northwind-cover-letter.md`**: front matter `author: owner`; title `# Cover letter: Analytics Lead, Northwind Robotics`.
- Content: The owner's cover letter for the Northwind analytics lead role, dated 2026-09-27: salutation to Taylor Brooks; Sam Okafor's suggestion; experience (four years, most recently at Brightline Analytics, the churn model result, the dbt migration and the review process); wanting to build Northwind's analytics function; the OPT STEM date and the need for H-1B sponsorship; signed Frank Fu.
- Must contain, verbatim:
  - `Date: 2026-09-27`
  - `Dear Taylor Brooks,`
  - `Sam Okafor suggested I write to you directly`
  - `I have four years of experience in analytics`
  - `my churn model cut monthly churn by 9 percent`
  - `I led the migration of 140 dbt models to Snowflake`
  - `My F-1 OPT STEM extension is valid until 2027-06-30`
- Traps and links: Front matter `author: owner` (an application has no default author). **Misattribution check** (roadmap follow-up): the owner's years of experience (four) sit beside two documents by other people that state theirs in the first person (`note--databricks-cost-governance.md`, close to a decade; `article--metric-trees.md`, 12 years); golden item f01 expects this letter. The 9 percent churn figure matches the retro.

**`eval/corpus/note--churn-model-retro.md`**: no front matter (the `note` default is `owner`); title `# Retro: Atlas churn model`.
- Content: Owner project retro dated 2026-06-12: what shipped and when and where (Brightline Analytics), the AUC on the holdout month, the churn result; what went wrong (label leakage from `account_closed_at`, filled in after a customer leaves; three weeks lost); what went right (Wei Zhang's point-in-time feature pipeline; a ranked call list for customer success every Monday); one lesson.
- Must contain, verbatim:
  - `Date: 2026-06-12`
  - `We shipped the Atlas churn model in May 2026`
  - `Brightline Analytics`
  - `The final model reached an AUC of 0.81`
  - `Monthly churn fell by 9 percent in the first quarter after launch.`
  - `label leakage from the account_closed_at column`
  - `Wei Zhang rebuilt the feature pipeline`
- Traps and links: Numbers `0.81` and `9 percent`; a column name with an underscore (`account_closed_at`) for keyword and fallback questions; Wei Zhang links to the job-search note.

**`eval/corpus/article--metric-trees.md`**: front matter `author: other`; title `# Metric trees: how I stopped arguing about dashboards`.
- Content: A short article by someone else that the owner saved: byline, then three paragraphs in the first person on metric trees: the author's experience, how to build one (one north-star metric, break into inputs, no more than four levels), one owner and one definition per node.
- Must contain, verbatim:
  - `By Hannah Leclerc`
  - `I have built metric trees at three companies over 12 years`
  - `Start from one north-star metric`
  - `no more than four levels deep`
- Traps and links: Front matter `author: other` (an article has no default author). **Attribution trap:** first-person claims by someone else ("I have built metric trees at three companies over 12 years") must produce no fact about the owner; golden item a04.

**`eval/corpus/email--acme-final-round.md`**: no front matter (the `email` default is `other`); title `# Acme Senior Data Analyst: final round`.
- Content: Email from Priya Natarajan to Frank, dated 2026-09-30: thanks for the case study; the requisition line; an invitation to a final round on October 7 with the CFO; the decision and answer dates; signed Priya.
- Must contain, verbatim:
  - `From: Priya Natarajan, Hiring Manager, Acme Corp`
  - `Date: 2026-09-30`
  - `Hi Frank,`
  - `Requisition REQ-4471.`
  - `we would like to invite you to a final round on October 7`
  - `We will make a decision by October 10, and any offer would need an answer by October 17.`
- Traps and links: **Code trap:** `REQ-4471` (golden item f03) against `REQ-4417`. Dates October 7, 10 and 17. Golden item a05.

**`eval/corpus/email--northwind-panel-rescheduled.md`**: no front matter (the `email` default is `other`); title `# Northwind panel moved to October 8`.
- Content: Email from Sam Okafor to Frank, dated 2026-10-01: the panel interview moves, because Taylor Brooks is travelling on the 6th; Ana Duarte joins the panel; everything else stays (ninety minutes, the Denver office, a short break); signed Sam.
- Must contain, verbatim:
  - `From: Sam Okafor, Technical Recruiter, Northwind Robotics`
  - `Date: 2026-10-01`
  - `Hi Frank,`
  - `Your panel interview has moved from October 6 to October 8 at 1:00 pm Mountain Time.`
  - `Taylor Brooks`
  - `Ana Duarte, a senior analyst on the team, will join the panel.`
- Traps and links: **Contradiction trap:** `email--recruiter-intro.md` (2026-09-28) says the panel is on October 6; this later email moves it to October 8. Golden item f04 expects this email for the current date.

**`eval/corpus/conversation--coffee-with-jordan-ellis.md`**: no front matter (the `conversation` default is `owner`); title `# Coffee with Jordan Ellis`.
- Content: Owner's notes of a coffee with Jordan Ellis in Denver (LoDo) on 2026-09-24: Jordan had heard about the move; the Quill Health opening and his offer to introduce; his advice on the Northwind base salary, since the role leads a team; Dana Whitfield's board seats.
- Must contain, verbatim:
  - `Date: 2026-09-24`
  - `Jordan said Quill Health, another Beta Ventures portfolio company, is hiring a data science manager in Boulder.`
  - `he advised me to ask Northwind for a base of at least $160,000`
  - `Dana Whitfield sits on the boards of both Acme Corp and Quill Health`
- Traps and links: Graph: Jordan Ellis and Dana Whitfield link Beta Ventures, Acme Corp and Quill Health. Number `$160,000` against the post's range and the owner's `$130,000` minimum.

**`eval/corpus/note--visa-timeline.md`**: no front matter (the `note` default is `owner`); title `# Visa timeline`.
- Content: Owner note dated 2026-09-21 on the visa calendar: when OPT STEM ends, when the H-1B registration window opens, the grace period, which employers sponsor, and that an offer must land before February so the registration can be filed in March.
- Must contain, verbatim:
  - `Date: 2026-09-21`
  - `My OPT STEM extension ends on 2027-06-30.`
  - `The next H-1B registration window opens in March 2027.`
  - `If I am not selected in the lottery, I have a 60-day grace period after my OPT ends.`
  - `Acme Corp sponsors H-1B for the senior analyst role, and Northwind Robotics sponsors new petitions.`
- Traps and links: Dates `2027-06-30` (also in the cover letter) and March 2027; `60-day`. Consistent with `visa_status` F-1 OPT in the other owner documents.

After writing each file, run `npx vitest run test/unit/corpus-fixtures.test.ts` and fix what it reports before the next one.

- [ ] **Step 4: Add the agent-written items for the traps**

In `eval/golden.jsonl`, replace:
````json
{"id":"a03","question":"What does the post recommend for Databricks cost governance?","kind":"attribution","expected":[{"origin":"note--databricks-cost-governance.md","quote":"make idle clusters terminate after 20 minutes"}],"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
{"id":"q15","question":"Where do I live now?","kind":"semantic","expected":[{"origin":"note--moved-to-denver.md","quote":"I now live in Denver for good"}],"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
{"id":"n01","question":"How much did I pay for the sushi dinner in Kyoto?","kind":"negative","expected":[],"negative":true,"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
````
with:
````json
{"id":"a03","question":"What does the post recommend for Databricks cost governance?","kind":"attribution","expected":[{"origin":"note--databricks-cost-governance.md","quote":"make idle clusters terminate after 20 minutes"}],"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
{"id":"q15","question":"Where do I live now?","kind":"semantic","expected":[{"origin":"note--moved-to-denver.md","quote":"I now live in Denver for good"}],"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
{"id":"n01","question":"How much did I pay for the sushi dinner in Kyoto?","kind":"negative","expected":[],"negative":true,"source":"fixture","approved_by":"agent","approved_at":"2026-10-01"}
{"id":"f01","question":"How many years of analytics experience do I have?","kind":"semantic","expected":[{"origin":"application--northwind-cover-letter.md","quote":"I have four years of experience in analytics"}],"source":"fixture","corpus":"fixtures","approved_by":"agent","approved_at":"2026-10-03"}
{"id":"f02","question":"Where did I live before I moved to Denver?","kind":"semantic","expected":[{"origin":"note--settling-in-austin.md","quote":"I live in Austin now, in a one-bedroom apartment in East Austin."}],"source":"fixture","corpus":"fixtures","approved_by":"agent","approved_at":"2026-10-03"}
{"id":"f03","question":"REQ-4471","kind":"fallback","expected":[{"origin":"email--acme-final-round.md"}],"source":"fixture","corpus":"fixtures","approved_by":"agent","approved_at":"2026-10-03"}
{"id":"f04","question":"When is my Northwind panel interview now that it was rescheduled?","kind":"semantic","expected":[{"origin":"email--northwind-panel-rescheduled.md","quote":"Your panel interview has moved from October 6 to October 8 at 1:00 pm Mountain Time."}],"source":"fixture","corpus":"fixtures","approved_by":"agent","approved_at":"2026-10-03"}
{"id":"a04","question":"How many companies has Hannah Leclerc built metric trees at, according to her article?","kind":"attribution","expected":[{"origin":"article--metric-trees.md","quote":"I have built metric trees at three companies over 12 years"}],"source":"fixture","corpus":"fixtures","approved_by":"agent","approved_at":"2026-10-03"}
{"id":"a05","question":"By when did Priya Natarajan say I would have to answer an Acme offer?","kind":"attribution","expected":[{"origin":"email--acme-final-round.md","quote":"any offer would need an answer by October 17"}],"source":"fixture","corpus":"fixtures","approved_by":"agent","approved_at":"2026-10-03"}
{"id":"n02","question":"What score did I get on the Acme SQL screen?","kind":"negative","expected":[],"source":"fixture","negative":true,"corpus":"fixtures","approved_by":"agent","approved_at":"2026-10-03"}
````

Use the date of this commit for `approved_at`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/corpus-fixtures.test.ts test/unit/golden-fixtures.test.ts test/unit/verifier-fixtures.test.ts test/unit/golden.test.ts`
Expected: PASS. `verifier-fixtures` still passes: the nine original files are unchanged.

- [ ] **Step 6: Typecheck and the unit suite**

Run: `npm run typecheck && npm run test:unit && git status --short eval/corpus | wc -l`
Expected: no type errors; unit 445 passed; `16` new files.

- [ ] **Step 7: Commit**

```bash
git add eval/corpus eval/golden.jsonl test/unit/corpus-fixtures.test.ts test/unit/golden-fixtures.test.ts
git commit -m "Fixture corpus 9 -> 25 documents: job posts, owner notes, recruiter emails, a meeting transcript, a paper abstract, news, a course note, a cover letter, a retro, a saved article; shared people and companies; near-duplicate posts and codes, a moved date, a superseded lives_in; 7 agent items pin the traps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Ingest the new documents into `brain_eval` (run by the controller, not a subagent)

**Files:** none changed. Output goes into the PR description.

This task spends model calls and Voyage tokens: the 16 new documents get a summary and an extraction each (about 32 Claude Code calls on the Max plan) and their passages, summaries and entity names are embedded (about 11,000 Voyage tokens). The nine existing documents are already ingested and are reported as `dup`. Run each command yourself and read its output before the next. Stop and tell the owner if anything does not match.

- [ ] **Step 1: Preflight**

Run:
```bash
git log --oneline -1
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -Atc "select count(*) from brain.documents; select count(*) from information_schema.columns where table_schema = 'brain' and table_name = 'retrieval_log' and column_name = 'facts'"
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval OBSIDIAN_AUTO=0 npm run brain -- usage --days 1
```
Expected: the Task 9 commit; `9` documents and `1` (migration 012 is on `brain_eval`); today's tokens well under the eval cap. If `brain_eval` is missing, `npm run eval:prepare` creates it and the next step ingests all 25 documents (about 50 Claude Code calls).

- [ ] **Step 2: Ingest**

Run: `OBSIDIAN_AUTO=0 npm run brain -- eval ingest`
Expected: 9 lines `dup  done       eval/corpus/<file>` and 16 lines `new  done       eval/corpus/<file>`, exit 0. A line ending in `ERROR …` means a stage failed: run `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval OBSIDIAN_AUTO=0 npm run brain -- retry` and check again; a `spend_cap` error means the eval's daily cap was reached (tell the owner).

- [ ] **Step 3: Every document finished, authors as intended**

Run:
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval OBSIDIAN_AUTO=0 npm run brain -- status
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "select author, count(*) from brain.documents group by 1 order by 1"
```
Expected: `done` 25 with no failures (the suppressed list may name documents by other authors; that is the author gate working); `other 14`, `owner 11`.

- [ ] **Step 4: The supersession the corpus plants**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "
select f.object_text, f.superseded_by is not null as superseded, d.origin
from brain.facts f
join brain.nodes s on s.id = brain.canonical_node(f.subject_id) and s.is_self
left join brain.chunks c on c.id = f.source_chunk_id
left join brain.documents d on d.id = c.document_id
where f.predicate = 'lives_in' order by superseded, d.origin"
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -Atc "select count(*) from brain.fact_events where event = 'superseded'"
```
Expected: every current (`f`) row says Denver; a superseded (`t`) row says Austin with origin `eval/corpus/note--settling-in-austin.md`; at least one `superseded` event. Extraction is model output: if no Austin fact was extracted, or Austin is current, show the owner the rows before going on (the corpus still holds the trap for retrieval; only the fact check is affected).

- [ ] **Step 5: A first run on the current golden set (no accept)**

Run: `OBSIDIAN_AUTO=0 npm run eval:run`
Expected: 26 items (19 original, 7 from Task 9), `golden set changed since the baseline`, `degraded=0%`, `attribution  self-facts-from-others=0  self-edges-from-others=0`, the voyage line (about 200,000 tokens: each search reranks nearly every passage of the larger corpus), and both verifier lines as before. Note which original items got worse (the near-duplicate post, the second retrieval paper, the ZX-9100 news and the Austin note are built to compete with q01, q03, q06, q09 and q15); they are explained in Task 12's commit, not fixed. Do not accept.

- [ ] **Step 6: PR notes**

Paste into the PR description: the ingest summary, the status and author counts, the `lives_in` rows, and the eval run's summary lines with the items that got worse.

---

### Task 11: `brain_real_eval`, the drafts, and the owner's review (run by the controller; ends in a hard stop)

**Files:**
- Create: `eval/drafts.jsonl`, `eval/review/<date>-1.md`, `-2.md`, `-3.md` (written by `eval draft`)

This task makes about 27 Claude Code calls (one per document: 25 fixtures and 2 real documents) and no Voyage call. `eval sync` reads the real base and writes only `brain_real_eval`.

- [ ] **Step 1: Create and fill `brain_real_eval`**

Run:
```bash
npm run eval:prepare-real
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -Atc "set default_transaction_read_only = on; select count(*) from brain.documents; select count(*) from brain.chunks; select count(*) from brain.retrieval_log"
npm run brain -- eval sync
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -Atc "set default_transaction_read_only = on; select count(*) from brain.retrieval_log"
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_real_eval -Atc "select count(*) from brain.documents; select count(*) from brain.chunks where embedding is not null; select count(*) from brain.retrieval_log"
```
Expected: `brain_real_eval ready (12 migrations)`; the real base's counts (2 documents, 8 chunks, and its number of searches); `eval sync: postgres -> brain_real_eval (port 55322); …` then `synced postgres -> brain_real_eval: documents 2, chunks 8, …`; the real base's search count unchanged; in `brain_real_eval` 2 documents, every chunk embedded that is embedded in the source, and 0 searches.

- [ ] **Step 2: Draft the fixture documents that have no items yet**

Run: `OBSIDIAN_AUTO=0 npm run brain -- eval draft`
Expected: 14 `skip` lines (the nine original documents and the five that Task 9's items name), 11 `drafted` lines, some `dropped` lines with their reasons (a quote not verbatim, a question containing its quote, a duplicate), no `failed` line, and `<n> drafts written to eval/drafts.jsonl and eval/review/<date>-1.md`. A `failed` line is a model or CLI error for that document: run the same command again (documents with drafts are skipped).

- [ ] **Step 3: Draft the documents that already have items**

Run:
```bash
OBSIDIAN_AUTO=0 npm run brain -- eval draft --force \
  --doc conversation--interview-prep-with-priya.md \
  --doc email--recruiter-followup-beta-ventures.md \
  --doc email--recruiter-intro.md \
  --doc job_description--acme-senior-data-analyst.md \
  --doc news--acme-series-b.md \
  --doc note--databricks-cost-governance.md \
  --doc note--fairness-in-ml.md \
  --doc note--moved-to-denver.md \
  --doc paper--contextual-retrieval-abstract.md \
  --doc note--settling-in-austin.md \
  --doc application--northwind-cover-letter.md \
  --doc email--acme-final-round.md \
  --doc email--northwind-panel-rescheduled.md \
  --doc article--metric-trees.md
```
Expected: 14 `drafted` lines; `dropped` lines include questions that duplicate existing golden items (`duplicates q01` and the like); a second sheet, `eval/review/<date>-2.md`.

- [ ] **Step 4: Draft the real documents**

Run: `OBSIDIAN_AUTO=0 npm run brain -- eval draft --corpus real`
Expected: 2 `drafted` lines and `eval/review/<date>-3.md`. (If the real base has more documents by now, more lines.)

- [ ] **Step 5: Check what is pending**

Run:
```bash
npm run brain -- eval drafts | tail -1
grep -c '"kind":"negative"' eval/drafts.jsonl
grep -c '"corpus":"real"' eval/drafts.jsonl
```
Expected: `<n> pending` (about 60 to 90), about 27 negatives (one per document), and the real drafts' count.

- [ ] **Step 6: Commit**

```bash
git add eval/drafts.jsonl eval/review
git commit -m "Eval drafts for the owner's review: one model call per document (25 fixtures, 2 real), automatic checks passed, three review sheets with empty decisions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: HARD STOP: hand the sheets to the owner and wait**

Send the owner this message (fill in the counts) and the three sheets (as files, or their paths), then stop. Do not fill in any `decision:` line, do not run `eval approve`, and do not go on to Task 12 until the owner says the sheets are done.

> The eval drafts are ready for your review: `eval/review/<date>-1.md` (<n1> questions from the 11 new fixture documents without items), `-2.md` (<n2> from the 14 documents that already have items) and `-3.md` (<n3> from your real knowledge base). Every quote was checked verbatim against its document and no question repeats an existing item.
>
> For each item, set `decision:` to `keep`, `edit` (and change the question, quote, kind or paraphrases in place) or `reject`; leave it empty to decide later. Any text editor or Obsidian works; do not change the `## d-…` headings or the `document:` lines.
>
> To finish Phase 6 the golden set needs at least 60 items, at least 10 negative and at least 5 attribution. It has 26 now (2 negative, 5 attribution), so keep or edit at least 34 drafts, including at least 8 negative questions (the ones under `document: none (negative question, …)`). Keep a negative only if you are sure nothing in the corpus answers it.
>
> `-3.md` quotes your own documents. `eval/golden.jsonl` is committed to git, so a kept real item puts that quote in the repository; reject them if you would rather not.
>
> The next step runs the full eval twice, about 1.3 million Voyage tokens each, more than the eval's default daily cap of 1,000,000. Please set `BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP=4000000` in `.env` for the day, or tell me to spread the runs over two days.
>
> Tell me when the sheets are done.

---

### Task 12: Apply the owner's decisions, meet the target, re-accept the baseline (run by the controller, after the owner)

**Files:**
- Modify: `test/unit/golden-fixtures.test.ts`
- Modify: `eval/golden.jsonl`, `eval/drafts.jsonl`, `eval/review/*.md` (as the owner left them)
- Modify: `eval/baseline.json`
- Create: `eval/baseline-real.json` (when real items were kept)

Start only after the owner has said the sheets are done. The controller applies the owner's decisions; it does not change them. Two full eval runs at about 1.3 million Voyage tokens each.

- [ ] **Step 1: Write the failing target test**

In `test/unit/golden-fixtures.test.ts`, replace:
````ts
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { parseGolden } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace, kindFromFilename } from "../../src/eval/run.js";
import { defaultAuthor } from "../../src/ingest/author.js";

````
with:
````ts
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { parseGolden, approvalCounts, GOLDEN_KINDS } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace, kindFromFilename } from "../../src/eval/run.js";
import { defaultAuthor } from "../../src/ingest/author.js";

````

In `test/unit/golden-fixtures.test.ts`, replace:
````ts
    }
    expect(items.some((i) => i.negative)).toBe(true);
  });
});
````
with:
````ts
    }
    expect(items.some((i) => i.negative)).toBe(true);
  });

  it("meets the Phase 6 target (spec §8.3): at least 60 items, 10 negative, 5 attribution, every kind, and the owner's approvals", async () => {
    const items = await golden();
    const count = (kind: string) => items.filter((i) => i.kind === kind).length;
    expect({
      items: items.length >= 60,
      negative: count("negative") >= 10,
      attribution: count("attribution") >= 5,
      everyKind: GOLDEN_KINDS.every((k) => count(k) > 0),
      ownerApproved: approvalCounts(items).owner > 0,
      generatedOrCapturedByOwner: items.filter((i) => i.source !== "fixture").every((i) => i.approved_by === "owner"),
    }).toEqual({ items: true, negative: true, attribution: true, everyKind: true, ownerApproved: true, generatedOrCapturedByOwner: true });
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/golden-fixtures.test.ts`
Expected: FAIL: `meets the Phase 6 target` with `items: false`, `negative: false`, `ownerApproved: false` (26 items, 2 negative, none approved by the owner yet).

- [ ] **Step 3: Apply each sheet**

Run, for each sheet the owner handed back:
```bash
OBSIDIAN_AUTO=0 npm run brain -- eval approve --sheet eval/review/<date>-1.md
OBSIDIAN_AUTO=0 npm run brain -- eval approve --sheet eval/review/<date>-2.md
OBSIDIAN_AUTO=0 npm run brain -- eval approve --sheet eval/review/<date>-3.md
npm run brain -- eval drafts | tail -1
```
Expected per sheet: `approved <a> (<e> edited), rejected <r>, undecided <u>, already applied 0` and `eval/golden.jsonl now has <n> items: <o> approved by the owner, <g> written by an agent`. If a sheet reports problems (`<sheet>:<line>: …` or `nothing applied; …`), nothing was written: send the messages to the owner and wait for the corrected sheet; do not edit decisions, questions or quotes yourself.

- [ ] **Step 4: Run the target test to verify it passes**

Run: `npx vitest run test/unit/golden-fixtures.test.ts && npm run test:unit`
Expected: PASS, and the unit suite green (446). `golden-fixtures` also re-checks that every kept or edited quote is verbatim in its fixture. If the target test still fails, tell the owner exactly what is missing (for example "4 more negative items") and offer the two ways to close it: more drafts (`eval draft --force --doc <file>` on documents the owner names, then a new sheet and this task again), or captured questions (`eval capture`, then the owner runs `eval label`).

- [ ] **Step 5: Check the Voyage budget for today**

Run: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval OBSIDIAN_AUTO=0 npm run brain -- usage --days 1`
Expected: the cap (`of <cap> tokens`) leaves room for about 2.7 million tokens. If it does not, ask the owner to raise `BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP` or wait until 00:00 UTC; never change it yourself.

- [ ] **Step 6: Run the eval and record the baseline**

Run: `OBSIDIAN_AUTO=0 npm run brain -- eval run --compare --accept | tee /tmp/brain-eval-phase6.txt`
Expected: every item listed with its rank; `overall  n=<positives> …`; one line per kind (all seven kinds present); `source fixture …` and `source generated …` (and `source captured …` if the owner labelled searches); `approved  owner=<o>  agent=<g>`; `negatives   n=<≥10> abstention=… false-answer=…`; `paraphrase  n=… consistency=…`; `degraded=0%`; `attribution  self-facts-from-others=0  self-edges-from-others=0`; the voyage line with `refused=0`; both verifier lines; `golden set changed since the baseline`; then `baseline written to eval/baseline.json at <commit>`. If any search ran degraded (cap refusals or Voyage errors), do not keep this baseline: restore it with `git checkout eval/baseline.json`, fix the cause, and run again.

- [ ] **Step 7: The gate passes on the new baseline**

Run: `npm run eval:gate; echo "exit $?"`
Expected: the same report, `vs baseline  recall@10 +0.000  mrr +0.000` give or take a rank that moved by rerank noise (within the 0.02 tolerance), no `GATE:` line, `exit 0`.

- [ ] **Step 8: The real base, when real items were kept**

Run (skip if `grep -c '"corpus":"real"' eval/golden.jsonl` prints 0):
```bash
OBSIDIAN_AUTO=0 npm run brain -- eval run --corpus real --compare --accept | tee /tmp/brain-eval-phase6-real.txt
OBSIDIAN_AUTO=0 npm run brain -- eval run --corpus real --gate; echo "exit $?"
```
Expected: the real items only, `degraded=0%`, `baseline written to eval/baseline-real.json`, then `exit 0`.

- [ ] **Step 9: Commit**

```bash
git add test/unit/golden-fixtures.test.ts eval/golden.jsonl eval/drafts.jsonl eval/review eval/baseline.json eval/baseline-real.json
git commit -m "Golden set grown to <n> items (<o> approved by the owner, <g> written by an agent; <neg> negative, <att> attribution) from the owner's review sheets; baseline re-accepted. Original items that got worse against the new trap documents: <ids and why>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

In the commit message, replace the placeholders with the numbers from `/tmp/brain-eval-phase6.txt` and list each original item (q01 to q15, a01 to a03, n01) whose rank got worse, with the trap document that now outranks its expected document. Leave `eval/baseline-real.json` out of `git add` if Step 8 was skipped.

---

### Task 13: README: "How retrieval works and how to audit it", and the diagram

**Files:**
- Create: `docs/retrieval.svg`
- Modify: `README.md`

One section for a professional reader: the five layers with their parameters, the evidence contract and `brain_explain`, `brain_verify` and its limits, authorship and facts, the spend cap, and the eval program (corpora, golden set with owner and agent counts, how items are made and approved, the metrics with definitions, the gate, the current numbers, how to reproduce). The diagram is hand-written SVG with a light and a dark palette (`prefers-color-scheme`), 1200 × 560, no external tool. The two stale README items from the roadmap are fixed: the tests paragraph that quoted the first baseline's p50 and 14 questions, and the example block that showed provenance lines without passage bodies and facts without the "Facts about the owner:" heading. The commands list gains the new eval commands, and "Reading a search result" says what `structuredContent` leaves out and why. The section's numbers are placeholders in «guillemets», filled in Step 3 from Task 12's output.

- [ ] **Step 1: The diagram**

Create `docs/retrieval.svg`:
````xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 560" width="1200" height="560" role="img" aria-labelledby="title desc">
  <title id="title">How a brain search runs and how it is audited</title>
  <desc id="desc">A query goes through five layers: hybrid passages (vector and keyword candidates fused with reciprocal rank fusion, then reranked), document summaries, graph expansion from named entities, facts about the owner, and a literal scan when the best hit is weak. Their output becomes one evidence contract, which is rendered for the client and logged to brain.retrieval_log. brain_explain replays the log; brain_verify checks an answer's claims against the cited passages and facts and logs to brain.verification_log.</desc>
  <style>
    .bg { fill: #ffffff; }
    .box { fill: #f6f7f9; stroke: #5b6472; stroke-width: 1.2; }
    .key { fill: #eaf1fb; stroke: #2f5d9a; stroke-width: 1.4; }
    .log { fill: #fbf3e6; stroke: #9a6a1f; stroke-width: 1.2; }
    .t { font: 600 14px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #1d2430; }
    .s { font: 12px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #4a5361; }
    .h { font: 600 12px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #5b6472; letter-spacing: 0.06em; }
    .a { stroke: #5b6472; stroke-width: 1.4; fill: none; marker-end: url(#arrow); }
    .d { stroke: #9a6a1f; stroke-width: 1.4; fill: none; stroke-dasharray: 5 4; marker-end: url(#arrow-log); }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #14181f; }
      .box { fill: #1e242d; stroke: #8b95a5; }
      .key { fill: #19283d; stroke: #7aa7e0; }
      .log { fill: #2b2216; stroke: #d0a25a; }
      .t { fill: #e8ecf2; }
      .s, .h { fill: #b3bcc9; }
      .a { stroke: #8b95a5; }
      .d { stroke: #d0a25a; }
      #arrow path { fill: #8b95a5; }
      #arrow-log path { fill: #d0a25a; }
    }
  </style>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#5b6472"/>
    </marker>
    <marker id="arrow-log" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#9a6a1f"/>
    </marker>
  </defs>
  <rect class="bg" x="0" y="0" width="1200" height="560"/>

  <!-- Query -->
  <rect class="key" x="24" y="250" width="120" height="64" rx="8"/>
  <text class="t" x="84" y="278" text-anchor="middle">Query</text>
  <text class="s" x="84" y="297" text-anchor="middle">plain words</text>

  <!-- Layers column -->
  <text class="h" x="180" y="36">FIVE LAYERS</text>

  <rect class="box" x="180" y="48" width="132" height="44" rx="6"/>
  <text class="t" x="246" y="68" text-anchor="middle">Vector</text>
  <text class="s" x="246" y="84" text-anchor="middle">HNSW index</text>

  <rect class="box" x="180" y="104" width="132" height="44" rx="6"/>
  <text class="t" x="246" y="124" text-anchor="middle">Keyword</text>
  <text class="s" x="246" y="140" text-anchor="middle">GIN, OR of stems</text>

  <rect class="box" x="340" y="76" width="118" height="44" rx="6"/>
  <text class="t" x="399" y="96" text-anchor="middle">RRF fusion</text>
  <text class="s" x="399" y="112" text-anchor="middle">k = 60</text>

  <rect class="box" x="486" y="76" width="118" height="44" rx="6"/>
  <text class="t" x="545" y="96" text-anchor="middle">Rerank</text>
  <text class="s" x="545" y="112" text-anchor="middle">Voyage, 0 to 1</text>
  <text class="s" x="180" y="168">1. Hybrid passages: 60 candidates per branch, fused, reranked</text>

  <rect class="box" x="180" y="186" width="424" height="44" rx="6"/>
  <text class="t" x="392" y="206" text-anchor="middle">2. Document summaries</text>
  <text class="s" x="392" y="222" text-anchor="middle">vector and keyword over each document's summary, fused</text>

  <rect class="box" x="180" y="244" width="424" height="44" rx="6"/>
  <text class="t" x="392" y="264" text-anchor="middle">3. Graph expansion</text>
  <text class="s" x="392" y="280" text-anchor="middle">entities named in the query: neighbours, up to 5 passages each</text>

  <rect class="box" x="180" y="302" width="424" height="44" rx="6"/>
  <text class="t" x="392" y="322" text-anchor="middle">4. Facts about the owner</text>
  <text class="s" x="392" y="338" text-anchor="middle">sharing a query term or linked to a named entity, at most 10</text>

  <rect class="box" x="180" y="360" width="424" height="44" rx="6"/>
  <text class="t" x="392" y="380" text-anchor="middle">5. Literal scan (fallback)</text>
  <text class="s" x="392" y="396" text-anchor="middle">exact codes and figures, only when the best score is under 0.3 or degraded</text>

  <path class="a" d="M144,270 C162,270 162,70 178,70"/>
  <path class="a" d="M144,276 C164,276 164,126 178,126"/>
  <path class="a" d="M144,282 L178,208"/>
  <path class="a" d="M144,282 L178,266"/>
  <path class="a" d="M144,286 L178,324"/>
  <path class="a" d="M144,292 C162,292 162,382 178,382"/>
  <path class="a" d="M312,70 L338,94"/>
  <path class="a" d="M312,126 L338,104"/>
  <path class="a" d="M458,98 L484,98"/>

  <!-- Evidence contract -->
  <rect class="key" x="648" y="176" width="288" height="138" rx="8"/>
  <text class="t" x="792" y="202" text-anchor="middle">Evidence contract</text>
  <text class="s" x="664" y="226">retrieval id, mode, degraded flags</text>
  <text class="s" x="664" y="246">per passage: score and kind, layers,</text>
  <text class="s" x="664" y="264">vector, keyword and rerank ranks, author</text>
  <text class="s" x="664" y="284">facts with source and verification</text>
  <text class="s" x="664" y="302">candidates and stage timings</text>
  <path class="a" d="M604,98 C628,98 628,200 646,206"/>
  <path class="a" d="M604,208 L646,226"/>
  <path class="a" d="M604,266 L646,250"/>
  <path class="a" d="M604,324 L646,282"/>
  <path class="a" d="M604,382 C628,382 628,300 646,300"/>

  <!-- Outputs -->
  <rect class="box" x="648" y="48" width="288" height="72" rx="8"/>
  <text class="t" x="792" y="74" text-anchor="middle">brain_search result</text>
  <text class="s" x="792" y="94" text-anchor="middle">[P1] lines with provenance, [F1] facts;</text>
  <text class="s" x="792" y="110" text-anchor="middle">structuredContent without passage text</text>
  <path class="a" d="M792,176 L792,122"/>

  <rect class="log" x="648" y="360" width="288" height="56" rx="8"/>
  <text class="t" x="792" y="384" text-anchor="middle">brain.retrieval_log</text>
  <text class="s" x="792" y="402" text-anchor="middle">every search, passages without text</text>
  <path class="d" d="M792,314 L792,358"/>

  <rect class="box" x="648" y="448" width="288" height="56" rx="8"/>
  <text class="t" x="792" y="472" text-anchor="middle">brain_explain</text>
  <text class="s" x="792" y="490" text-anchor="middle">replays a search from the log, no new search</text>
  <path class="a" d="M792,416 L792,446"/>

  <!-- Answer path -->
  <rect class="box" x="980" y="48" width="196" height="72" rx="8"/>
  <text class="t" x="1078" y="74" text-anchor="middle">Client's answer</text>
  <text class="s" x="1078" y="94" text-anchor="middle">claims citing [P#] and [F#]</text>
  <text class="s" x="1078" y="110" text-anchor="middle">plus the retrieval id</text>
  <path class="a" d="M936,84 L978,84"/>

  <rect class="box" x="980" y="176" width="196" height="72" rx="8"/>
  <text class="t" x="1078" y="202" text-anchor="middle">brain_verify</text>
  <text class="s" x="1078" y="222" text-anchor="middle">each claim against the passages</text>
  <text class="s" x="1078" y="238" text-anchor="middle">and facts it cites, no model</text>
  <path class="a" d="M1078,120 L1078,174"/>
  <path class="a" d="M936,380 C964,380 964,230 978,226"/>
  <text class="s" x="948" y="300" transform="rotate(-90 948 300)" text-anchor="middle">resolves P and F labels</text>

  <rect class="log" x="980" y="292" width="196" height="56" rx="8"/>
  <text class="t" x="1078" y="316" text-anchor="middle">brain.verification_log</text>
  <text class="s" x="1078" y="334" text-anchor="middle">every verdict with its evidence</text>
  <path class="d" d="M1078,248 L1078,290"/>

  <rect class="box" x="980" y="392" width="196" height="72" rx="8"/>
  <text class="t" x="1078" y="418" text-anchor="middle">Verdicts</text>
  <text class="s" x="1078" y="438" text-anchor="middle">supported, partial, unsupported,</text>
  <text class="s" x="1078" y="454" text-anchor="middle">uncited, bad citation</text>
  <path class="a" d="M1150,248 C1190,300 1190,360 1150,390"/>

  <text class="s" x="24" y="524">No model call at query time: ranking is Postgres and Voyage (under a daily token cap), verification is Postgres stemming plus rules.</text>
  <text class="s" x="24" y="544">Solid arrows: data flow. Dashed: written to an audit table.</text>
</svg>
````

Run: `xmllint --noout docs/retrieval.svg && echo ok`
Expected: `ok`. Open it in a browser in light and dark mode: every label sits inside its box and no arrow crosses a label.

- [ ] **Step 2: The README**

In `README.md`, replace:
````markdown
npm run brain -- facts [--all]
npm run brain -- set-author <document-id> <owner|other|unknown>
npm run brain -- eval ingest [dir]
npm run brain -- eval run [--golden eval/golden.jsonl] [--baseline eval/baseline.json] [--verifier eval/verifier.jsonl] [--verifier-baseline eval/verifier-baseline.json] [--compare] [--gate] [--accept] [--json]
npm run brain -- eval verifier [--file eval/verifier.jsonl] [--baseline eval/verifier-baseline.json] [--gate] [--accept] [--json]
npm run brain -- backfill [--limit 500] [--poll 30]
```

````
with:
````markdown
npm run brain -- facts [--all]
npm run brain -- set-author <document-id> <owner|other|unknown>
npm run brain -- eval ingest [dir]
npm run brain -- eval sync
npm run brain -- eval run [--corpus fixtures|real] [--golden eval/golden.jsonl] [--baseline eval/baseline.json] [--verifier eval/verifier.jsonl] [--verifier-baseline eval/verifier-baseline.json] [--compare] [--gate] [--accept] [--json]
npm run brain -- eval verifier [--file eval/verifier.jsonl] [--baseline eval/verifier-baseline.json] [--gate] [--accept] [--json]
npm run brain -- eval draft [--corpus fixtures|real] [--since 2026-09-01] [--limit 10] [--doc <file name or id>...] [--force]
npm run brain -- eval drafts
npm run brain -- eval approve --sheet eval/review/<date>-<n>.md
npm run brain -- eval reject --id <draft id>...
npm run brain -- eval capture [--corpus real|fixtures] [--since 2026-09-01] [--client mcp-stdio] [--limit 20]
npm run brain -- eval label <retrieval-id> (--expect <document> [--quote "<verbatim span>"] [--kind semantic] | --negative) [--corpus real|fixtures]
npm run brain -- backfill [--limit 500] [--poll 30]
```

````

In `README.md`, replace:
````markdown

- `npm run test:unit` needs nothing.
- `npm run test:int` needs `npm run db:start`. It recreates a separate `brain_test` database from the migrations and runs there with fakes for Claude and Voyage, so your real knowledge base is never touched. The test helper refuses any database whose name does not end in `_test`.
- The retrieval eval runs only against `brain_eval` and checks the live connection before any write (`npm run eval:prepare` creates it from the migrations; `--reset` recreates it). `npm run brain -- eval ingest` loads `eval/corpus`; `npm run eval:run` scores `eval/golden.jsonl` and compares with `eval/baseline.json`; `npm run eval:gate` exits 1 on a regression (recall@10 or MRR down more than 0.02, abstention down, any degraded search, a changed golden set, no baseline, or the citation verifier failing its gate on `eval/verifier.jsonl`: regular precision of `supported` below 0.9, full precision more than 0.02 below `eval/verifier-baseline.json`, a changed verifier set, or no verifier baseline; see "Checking an answer against its sources"). Each run also prints `voyage tokens=… requests=… refused=…`: the Voyage tokens that run used, from `brain_eval`'s own ledger and cap (not part of the baseline). After a deliberate change, `npm run brain -- eval run --accept` records the new baseline. `eval:prepare` only creates `brain_eval`; to bring an existing one up to date after a new migration, apply that migration file to it with `psql .../brain_eval -v ON_ERROR_STOP=1 -f <file>`. Metrics: set recall@1/5/10 over the top-k passages, MRR over distinct documents, nDCG@10 against all quote-bearing passages, paraphrase consistency, abstention and false-answer rate on negatives, degraded fraction, nearest-rank latency from each search's own `timings.totalMs`, and p50/p95 per stage (embed, sql, rerank, graph; recorded in baselines from Phase 4 on). Baseline on 2026-09-30 (commit `2b3426d`, before any retrieval change): recall@1 0.79, recall@10 1.00, MRR 1.00, p50 236 ms, 0% degraded, 14 questions over 6 documents. The set is small and has no negatives yet, so treat it as a regression check until Phase 6 of `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` grows it.

## Layout

````
with:
````markdown

- `npm run test:unit` needs nothing.
- `npm run test:int` needs `npm run db:start`. It recreates a separate `brain_test` database from the migrations and runs there with fakes for Claude and Voyage, so your real knowledge base is never touched. The test helper refuses any database whose name does not end in `_test`.
- The retrieval eval runs only against databases whose names end in `_eval`: `brain_eval` holds the fixture corpus (`npm run eval:prepare`, then `npm run brain -- eval ingest`) and `brain_real_eval` a copy of the real base (`npm run eval:prepare-real`, then `npm run brain -- eval sync`). Each run checks the live connection before any write. `npm run eval:gate` is the regression gate. The metrics, the gate, how golden questions are written and approved, the current numbers and how to reproduce them are in "How retrieval works and how to audit it" below.

## Layout

````

In `README.md`, replace:
````markdown

### Reading a search result

Every search (`brain_search`, `brain search`, `brain ask`) returns one structure, the evidence contract in `src/retrieve/contract.ts`, and logs it to `brain.retrieval_log`. The text is generated from that structure, so what the model reads, what you read and what is logged say the same thing. `brain_search` also returns it as `structuredContent`; `brain search --json` prints it.

```
retrieval 6f1c2a0e-… · mode: hybrid · 7 passages

[P1] 0.76 rerank · vector#2 keyword#5 · note · author: other · "Databricks costs" · 2026-09-29 (doc 31f1…, chunk 5ec6…)
[P6] - · graph via Acme Corp · note · author: owner · "Acme notes" · undated (doc 8b0d…, chunk 77a1…)
[P7] - · fallback "X-90" · news · author: other · "Zorblax news" · 2026-08-02 (doc 4c3e…, chars 0–260)
[F1] visa_status: F-1 OPT (unverified · from note 9a2e…)
[F2] lives_in: Denver (unverified · stated by owner)
```

- `retrieval <id>`: the log row. `npm run brain -- explain <id>` or `brain_explain` replays the search from the log without searching again: query, filters, client, time, mode, which parts fell back, candidate counts per branch, stage timings, and each passage's rank, score and branch ranks.
- `mode`: `hybrid` means vector and keyword candidates, reranked. `keyword-only` means the query embedding failed or the Voyage cap refused it, so there were only keyword candidates and nothing was reranked. `fused-order` means the rerank failed or was refused, so the candidates are in reciprocal-rank-fusion order. A degraded search says why on the next line.
- Score and kind: `rerank` is the reranker's relevance, 0 to 1, higher is stronger. `rrf` (about 0.008 to 0.033) only orders the passages of one degraded search and is not comparable with rerank scores. `-` means the passage was not scored: it came from graph expansion or the literal scan. The log's `top_score` and the fallback threshold use rerank scores only, so a degraded search has no top score.
````
with:
````markdown

### Reading a search result

Every search (`brain_search`, `brain search`, `brain ask`) returns one structure, the evidence contract in `src/retrieve/contract.ts`, and logs it to `brain.retrieval_log`. The text is generated from that structure, so what the model reads, what you read and what is logged say the same thing. `brain_search` also returns it as `structuredContent`, without each passage's text, which the text content already carries (`brain search --json` prints the full structure, text included). Measured on the largest possible result (k=30 plus 25 graph passages at the 1,600-character passage cap, `test/unit/search-output-size.test.ts`), repeating the text in `structuredContent` would bring one call to about 235 KB; without it the call is about 146 KB, of which the text is about 106 KB, which is more than some clients show from one tool call (Claude Code's default limit is 25,000 tokens). At the default k=10 the largest result stays under 100 KB.

```
retrieval 6f1c2a0e-… · mode: hybrid · 3 passages

[P1] 0.76 rerank · vector#2 keyword#5 · note · author: other · "Databricks costs" · 2026-09-29 (doc 31f1…, chunk 5ec6…)
  What a runaway Databricks bill taught me
Three months later the invoice had nearly quadrupled, from about $41,000 a month to $157,000…

[P2] - · graph via Acme Corp · note · author: owner · "Acme notes" · undated (doc 8b0d…, chunk 77a1…)
Priya confirmed Acme sponsors H-1B and has done it for two analysts on her team…

[P3] - · fallback "X-90" · news · author: other · "Zorblax news" · 2026-08-02 (doc 4c3e…, chars 0–260)
…the X-90 replaces the older model in all Texas plants…

Documents by summary: Databricks costs [note] (doc 31f1…); Acme notes [note] (doc 8b0d…)
Entity organization: Acme Corp (node 2d1e…, matched "acme corp") — Priya Natarajan (person), Austin, TX (place)
Facts about the owner:
[F1] visa_status: F-1 OPT (unverified · from note 9a2e…)
[F2] lives_in: Denver (unverified · stated by owner)
```

Each passage is its provenance line, then its heading path (indented, when it has one) and its full text; `brain search` on the command line prints the text as one line of at most 240 characters instead. After the passages come the documents whose summaries matched, the entities named in the query with their neighbours, and the facts about the owner.

- `retrieval <id>`: the log row. `npm run brain -- explain <id>` or `brain_explain` replays the search from the log without searching again: query, filters, client, time, mode, which parts fell back, candidate counts per branch, stage timings, and each passage's rank, score and branch ranks.
- `mode`: `hybrid` means vector and keyword candidates, reranked. `keyword-only` means the query embedding failed or the Voyage cap refused it, so there were only keyword candidates and nothing was reranked. `fused-order` means the rerank failed or was refused, so the candidates are in reciprocal-rank-fusion order. A degraded search says why on the next line.
- Score and kind: `rerank` is the reranker's relevance, 0 to 1, higher is stronger. `rrf` (about 0.008 to 0.033) only orders the passages of one degraded search and is not comparable with rerank scores. `-` means the passage was not scored: it came from graph expansion or the literal scan. The log's `top_score` and the fallback threshold use rerank scores only, so a degraded search has no top score.
````

In `README.md`, replace:
````markdown

Claude Desktop and ChatGPT take the same URL and header in their connector settings. Alternative with no hosting: run `npm run mcp:http` on the Mac and expose the port through Tailscale or a Cloudflare Tunnel.

## Obsidian

Every save writes twice: to the database, which is the retrieval layer, and to a read-only markdown mirror in your Obsidian vault, which is there for reading and for Obsidian's graph view. The vault and folder come from `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_FOLDER`.
````
with:
````markdown

Claude Desktop and ChatGPT take the same URL and header in their connector settings. Alternative with no hosting: run `npm run mcp:http` on the Mac and expose the port through Tailscale or a Cloudflare Tunnel.

## How retrieval works and how to audit it

This section is for a reader who wants to check the method rather than use the tool. Every claim below points at the code or table that implements it.

![A query runs through five layers into one evidence contract, which is shown to the client, logged, replayed by brain_explain and used by brain_verify](docs/retrieval.svg)

No model is called at query time. Ranking is Postgres plus Voyage (embeddings and a reranker, under a daily token cap); answer checking is Postgres stemming plus fixed rules. Claude is used only when a document is ingested (summary and entity extraction) and when the owner asks for draft eval questions.

### The five layers

`search()` in `src/retrieve/search.ts` runs, for one query:

1. **Hybrid passages.** A vector branch (HNSW over Voyage embeddings of each passage) and a keyword branch (a GIN index over the stems of each passage's text, heading path and title, matching any query stem and ranked by how many distinct stems match) each return up to 60 candidates. They are fused with reciprocal rank fusion (k = 60) and reranked by Voyage; the top k (default 10, at most 30) are returned with the rerank score, 0 to 1. If the query embedding fails or is refused, the search is keyword-only; if the rerank fails or is refused, the passages keep their fused order. The result says which (`mode`).
2. **Document summaries.** The same two branches over each document's summary, fused, listed after the passages.
3. **Graph expansion.** Entities named in the query (any case, names up to six words, at most 5) are matched to graph nodes; each adds up to 20 neighbours and up to 5 passages that mention it. A graph passage has no score; a ranked passage the graph also reached keeps its score and gains the entity.
4. **Facts about the owner.** Current facts that share a stem with the query or point at a named entity, at most 10, entity-linked first.
5. **Literal scan.** When the query holds an exact-string term (a code such as `X-90`, a figure such as `$115k`, a version) and the best rerank score is below 0.3 or the search was degraded, documents containing the term are scanned and a window around the match is returned.

`test/integration/search-plan.test.ts` fails if a query plan stops using the HNSW or GIN index.

### The evidence contract and brain_explain

Every search returns one structure (`SearchResult` in `src/retrieve/contract.ts`): the retrieval id, the mode and which parts degraded, candidate counts per branch, stage timings, and for every passage its score and score kind, the layers that found it, its vector, keyword and rerank ranks, its document's author, source kind, date and ids. The text an MCP client reads is generated from this structure (see "Reading a search result"). The structure, minus passage text, is written to `brain.retrieval_log` for every search, so `brain_explain <retrieval id>` (or `npm run brain -- explain <id>`) replays how a past search ranked its passages without searching again.

### brain_verify and its limits

After answering, a client passes the retrieval id and its claims, each with the `[P#]`/`[F#]` labels it cites, to `brain_verify`. Each claim gets `supported`, `partial`, `unsupported`, `uncited` or `bad_citation` from word overlap (Postgres stems), numbers, dates and codes, negation and polarity words, checked only against the passages and facts it cites; every verification is written to `brain.verification_log`. It checks vocabulary, not logic: reversed relations, swapped entities, antonyms and numbers attached to the wrong thing can pass, and a correct paraphrase in other words can fail. "Checking an answer against its sources" defines every rule and lists every limit. Measured on `eval/verifier.jsonl` (104 claims written and labelled by an agent, 27 of them known limits labelled with their true verdict): on the 77 claims the method is designed for, precision of `supported` is «verifier regular precision» and recall «verifier regular recall»; on all 104, precision is «verifier full precision» and recall «verifier full recall» («verifier date»).

### Authorship and facts

Every document records who wrote it (`owner`, `other`, `unknown`). Only documents the owner wrote produce facts about the owner or relationships from the owner; for others, those statements are kept in the stored extraction but not written, and counted. Single-valued facts (`lives_in`, `visa_status`, `current_employer` and five more) keep one current value: a newer owner document supersedes the older value, and every supersession is logged in `brain.fact_events`. The eval measures leaks directly: the number of facts about the owner, and edges from the owner, whose evidence lies in a document the owner did not write. It must be 0.

### The spend cap

Every Voyage request is recorded in `brain.provider_usage` and refused before it is sent when the day's tokens plus its estimate would pass `BRAIN_VOYAGE_DAILY_TOKEN_CAP` (5,000,000 by default; there is no setting that turns it off). Each eval database counts against its own `BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP` (1,000,000 by default). A refused query embedding or rerank makes the search degraded, which the result says and the eval gate rejects. Details are under "Voyage spending cap".

### The eval program

**Two corpora, two databases.** `brain_eval` holds `eval/corpus`: 25 fictional documents (job posts, owner notes, recruiter emails, a meeting transcript, paper abstracts, news, a course note, a cover letter, a project retro, a saved article by someone else), written for this eval with shared people and companies so graph questions have something to traverse, and with planted traps: a near-duplicate job post with a different salary and visa policy, near-duplicate requisition codes (`REQ-4471`, `REQ-4417`), product codes one digit apart (`ZX-9000`, `ZX-9100`), two retrieval papers with different numbers, an interview date that a later email moves, and an owner note that says where the owner lives, superseded by a later one. `test/unit/corpus-fixtures.test.ts` pins every planted sentence. `brain_real_eval` is a copy of the real knowledge base made by `npm run brain -- eval sync` (documents, chunks with their embeddings, graph, facts; no model or Voyage call; the source is only read, through a read-only snapshot). Golden items carry `corpus: "fixtures"` or `"real"`, and `eval run --corpus real` runs the real ones against `brain_real_eval`.

**The golden set** is `eval/golden.jsonl`: «items» items, «owner» approved by the owner and «agent» written by an agent (the original fixture items and a few that pin the corpus traps), «fixtures items» on the fixture corpus and «real items» on the real base; «negative» negative and «attribution» attribution items. Each item has a question, its kind (keyword, semantic, graph, filter, fallback, attribution, negative), the expected documents with an optional verbatim answer quote, optional paraphrases, its source (`fixture`, `generated`, `captured`) and who approved it. Items come from three places:

- `fixture`: written with the corpus, labelled `approved_by: "agent"`.
- `generated`: `npm run brain -- eval draft` makes one Claude Code call per document for 2 to 3 questions across kinds, each with a verbatim answer quote and two paraphrases, plus one question nothing in the corpus answers. Every draft is checked automatically: the quote must appear verbatim in the document (whitespace aside); the question must not contain its quote; it must not duplicate a golden item or another draft (same normalised text, or Postgres stem sets with Jaccard overlap of at least 0.8); the document must be in the eval database; the item must be valid under the golden schema. Passing drafts go to `eval/drafts.jsonl` and a review sheet, `eval/review/<date>-<n>.md`, where the owner marks each `keep`, `edit` (changing question, quote, kind or paraphrases in place) or `reject`. `npm run brain -- eval approve --sheet <file>` checks every kept and edited item again and only then adds them with `approved_by: "owner"`, the date, and whether they were edited. Agents never approve.
- `captured`: `npm run brain -- eval capture` lists recent real searches from the knowledge base's log (opened read-only); `npm run brain -- eval label <retrieval id> --expect <document id> [--quote "…"]` turns one into an item approved by the owner, after checking the document is in `brain_real_eval` (run `eval sync` first; it keeps document ids).

**Metrics** (`src/eval/metrics.ts`, `src/eval/run.ts`; no model call):

| Metric | Definition | Over |
|---|---|---|
| Recall@k, k = 1, 5, 10 | Share of an item's expected documents found among the documents of its top k passages, averaged | positive items |
| MRR | Mean of 1 / rank of the first expected document, ranks counted over distinct documents; 0 on a miss | positive items |
| nDCG@10 | Binary relevance per passage: a stored passage of an expected document that contains the quote (whitespace aside); the ideal ranking puts every such passage in the corpus first, up to 10 | items with quotes |
| Paraphrase consistency | Share of paraphrases whose top 10 finds the same set of expected documents as the original question | positive items with paraphrases |
| Abstention rate | Share of negative items whose top rerank score is below 0.3 and that got no graph-only passage | negative items |
| False-answer rate | Share of negative items whose top rerank score is 0.3 or more | negative items |
| Degraded fraction | Share of searches (questions and paraphrases) that ran without the embedding or the rerank | all searches |
| Latency | Nearest-rank p50 and p95 of each search's own total time, and per stage (embed, SQL, rerank, graph) | all items |
| Attribution leaks | Facts about, and edges from, the owner whose evidence is in a document the owner did not write | whole database |
| Voyage | Tokens, requests and refused calls of the run, from the eval database's ledger | the run |
| Verifier | Precision and recall of `supported`, and accuracy, on `eval/verifier.jsonl`, regular and full views | verifier set |

Every run prints these overall, per kind, per source (`fixture`, `generated`, `captured`) and the count of items per approver.

**The gate.** `npm run eval:gate` exits 1 when recall@10 or MRR falls more than 0.02 below `eval/baseline.json` (or `eval/baseline-real.json` for `--corpus real`), the abstention rate falls, negative items disappear, any search ran degraded, the golden set changed since the baseline, there is no baseline, any attribution leak exists, or the verifier fails its gate (regular precision of `supported` below 0.9, full precision more than 0.02 below `eval/verifier-baseline.json`, a changed verifier set, or no verifier baseline).

**Current numbers.** Baseline recorded on «baseline date» at commit `«baseline commit»` over the fixture corpus («fixtures items» items, «paraphrase searches» paraphrase searches): recall@1 «recall@1», recall@5 «recall@5», recall@10 «recall@10», MRR «mrr», nDCG@10 «ndcg@10»; paraphrase consistency «consistency»; abstention «abstention» and false answers «false answers» on «negative» negatives; degraded «degraded»; latency p50 «p50» ms, p95 «p95» ms; attribution leaks 0. Per source: «per-source line». One full run used «voyage tokens» Voyage tokens. On the real base: «real summary».

**Reproduce.**

```bash
npm run db:start
npm run eval:prepare                                  # creates brain_eval from the migrations
OBSIDIAN_AUTO=0 npm run brain -- eval ingest          # 25 documents: about 50 Claude Code calls, about 20,000 Voyage tokens
npm run eval:gate                                     # every metric above, compared with eval/baseline.json
npm run brain -- eval verifier                        # the verifier alone, item by item, no Voyage call
npm run eval:prepare-real && npm run brain -- eval sync && npm run brain -- eval run --corpus real --compare
```

A rebuilt `brain_eval` re-runs summarisation and entity extraction, which are model output and can differ between runs, so graph-dependent ranks can move slightly; the baseline is tied to the database it was recorded on. A full run reranks every candidate passage of every question and paraphrase, about «voyage tokens» tokens, so raise `BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP` if the default 1,000,000 a day refuses calls (the run then says it ran degraded and the gate fails).

## Obsidian

Every save writes twice: to the database, which is the retrieval layer, and to a read-only markdown mirror in your Obsidian vault, which is there for reading and for Obsidian's graph view. The vault and folder come from `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_FOLDER`.
````

- [ ] **Step 3: Fill in the numbers**

Replace each «placeholder» in the new section with the value from these sources (two decimals for rates, as `eval run` prints them):

| Placeholder | Source |
|---|---|
| «verifier regular precision», «verifier regular recall», «verifier full precision», «verifier full recall», «verifier date» | `npm run brain -- eval verifier \| tail -4`, the `verifier regular` and `verifier full` lines, and today's date (on `ed1b118` they read 1.00, 0.98, 0.67, 0.85) |
| «items», «owner», «agent», «negative», «attribution», «fixtures items», «real items» | `node -e 'const l=require("fs").readFileSync("eval/golden.jsonl","utf8").trim().split("\n").map(JSON.parse);const c=f=>l.filter(f).length;console.log({items:l.length,owner:c(i=>i.approved_by==="owner"),agent:c(i=>i.approved_by==="agent"),negative:c(i=>i.kind==="negative"),attribution:c(i=>i.kind==="attribution"),fixtures:c(i=>(i.corpus??"fixtures")==="fixtures"),real:c(i=>i.corpus==="real")})'` |
| «baseline date», «baseline commit», «recall@1», «recall@5», «recall@10», «mrr», «ndcg@10», «consistency», «abstention», «false answers», «degraded», «p50», «p95» | `eval/baseline.json` (`recordedAt`, `commit`, `report.overall`, `report.paraphrase.consistency`, `report.negatives`, `report.degradedFraction` as a percentage, `report.latencyMs`) |
| «paraphrase searches» | `report.paraphrase.n` in `eval/baseline.json` |
| «per-source line» | the `source …` lines of `/tmp/brain-eval-phase6.txt`, as one sentence ("fixture items recall@10 1.00 and MRR 0.97 (n=24); generated items …") |
| «voyage tokens» | the `voyage  tokens=…` line of `/tmp/brain-eval-phase6.txt`, rounded to two significant figures ("1.3 million") |
| «real summary» | from `/tmp/brain-eval-phase6-real.txt`: "<n> items, recall@10 …, MRR …"; or, with no real items, "no real items yet; `eval sync` and `eval label` add them" |

- [ ] **Step 4: Check the README against the code and the files**

Run:
```bash
grep -c "«" README.md
grep -n "DUPLICATE_STEM_JACCARD = \|MAX_DRAFT_CHARS = \|CAPTURE_PASSAGES = \|candidateK: \|fallbackThreshold: \|k = 60" src/eval/draft.ts src/eval/capture.ts src/config.ts src/retrieve/fuse.ts
ls eval/corpus | wc -l
npm run test:unit
```
Expected: `0` (every placeholder filled); `DUPLICATE_STEM_JACCARD = 0.8`, `MAX_DRAFT_CHARS = 40_000`, `CAPTURE_PASSAGES = 3`, `candidateK: 60`, `fallbackThreshold: 0.3`, `k = 60`, matching the section; `25`; the unit suite green.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/retrieval.svg
git commit -m "README: how retrieval works and how to audit it (five layers, evidence contract, brain_explain, brain_verify and its limits, authorship, spend cap, the eval program with definitions, owner and agent counts, current numbers, reproduction) and docs/retrieval.svg; the stale eval paragraph and example block fixed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec §8.1 (isolation, two ways to fill): `eval ingest` unchanged; `eval sync` (Task 5) into its own `brain_real_eval`, so the fixture corpus in `brain_eval` is never replaced; both refuse any database whose name does not end in `_eval`. The spec's "`pg_dump --data-only` and `pg_restore`" became `pg_dump --data-only | psql` in plain format inside the container (one transaction, decisions above); the table list adds `extractions`, `ingest_jobs` and `fact_events` as the roadmap and the owner asked.
- Spec §8.2 (golden v2): every field kept; v3 adds `approved_by`, `corpus`, `edited`, `retrieval_id` (Task 3). Attribution items still name `author: other` fixtures (now judged by front matter or the kind's default).
- Spec §8.3 (growing the set): `eval draft [--since] [--limit]` plus `--doc`, `--force`, `--corpus` (Task 6, 7); `eval approve` works from the review sheet instead of `--all | --id`, as the owner decided, and `eval reject --id` stays; `eval capture [--since]` plus `--client`; `eval label … --expect … [--quote] [--negative]` plus `--kind` (Task 8). The target (60 items, 10 negative, 5 attribution, every kind) is a unit test (Task 12).
- Spec §8.4 (metrics): unchanged, already implemented through Phase 5; per-source and per-approver added (Task 4). Spec §8.5 (baseline and gate): unchanged; `eval/baseline-real.json` for the real corpus. Spec §8.6: done in Phase 2; Task 9 adds the older `lives_in` note the roadmap asked for.
- Roadmap Phase 6 tasks 1 to 8: Tasks 5, 6, 6 and 7, 8, (done), 4, 9 to 12, 13. "Done when": at least 60 approved items (Task 12's test), `eval:gate` wired with all metrics (Task 12 Step 7), the README section (Task 13). Roadmap follow-ups: Phase 2's unclosed fence (Task 1), the superseding fixture (Task 9), misattribution items (Task 9, f01); Phase 4's k=30 size (Task 2), `renderExplain` decimals, `safeParse`, quotes in titles (Task 1), the README example block and eval paragraph (Task 13). Not done (not asked): edge supersession and `retrieval_log` retention.
- The owner's decisions 1 to 9: corpus (Task 9), approval (Tasks 3, 6, 7, 11, 12), draft prompt (Task 6), captured questions (Task 8), sync and the separate database (Tasks 4, 5), metrics (Task 4), baseline after the owner's approval (Tasks 11 and 12, with the hard stop), README and diagram (Task 13), follow-ups (Tasks 1, 2, 9).

How this plan was validated: every code task was built in a scratch clone of the repository (`git clone` of `eval-program` at `ed1b118` into the session scratchpad) against private scratch databases, `brain_p6s_test` and `brain_p6s_eval`, created and dropped through a connection to `template1` (never `postgres`, `brain_test` or `brain_eval`) and built from the migrations; the sync test's throwaway database was `brain_p6s_test_sync_eval`, also created and dropped through `template1` (`TEST_ADMIN_URL`). One commit per task; at each, `npm run typecheck` reported no errors and the unit suite passed with the counts given in the steps (390, 393, 404, 409, 414, 440, 440, 440, 445). The integration suite passed at the end (329 tests) except `test/integration/eval-db.test.ts`, which expects the refused name to be `brain_test` and sees `brain_p6s_test` (it fails the same way on the untouched `ed1b118` and passes on the real `brain_test`). Every "verify it fails" expectation was produced by running that task's new tests against the previous task's state, except Task 5's integration test, which was run with the new `prepare-eval-db.sh` and the sync script moved away (running it against the old script would have reset the shared `brain_eval`). The output sizes in Task 2 are measured values. `eval run` on an empty golden file, `eval run --corpus real` and `--corpus bogus` (Task 4), and the sync script's refusals (Task 5) were run as CLI commands against the scratch databases; the review sheet format was checked by rendering, editing and re-parsing it in the tests, and the diagram by viewing it in a browser in light and dark mode. Not run in scratch, because they need Claude Code or Voyage, or the owner: Tasks 10 to 12 (ingest, the real drafting calls, approval, the eval runs) and the numbers of Task 13. The draft prompt was exercised only through a fake model (`FakeLlm`), so its real output quality is unknown until Task 11. Finally, the plan text itself was checked mechanically: a script applied every "Create", "Replace the whole of" and "replace … with …" block, in order, to a fresh checkout of `ed1b118` (copying the scratch versions of the 16 corpus documents, which the plan gives as briefs), and the resulting tree was identical to the validated scratch state.

Places where the real code forced a decision that differs from, or adds to, the brief (the decisions above give the reasons):
- `structuredContent` drops passage text, and the text alone still passes 100 KB at k=30 with five named entities; the default k=10 stays under.
- `sync` runs inside the container because the host's `psql` (17.5) cannot read a 17.6 `pg_dump`'s `\restrict` lines, and needs no `--disable-triggers` (which the non-superuser `postgres` role could not use).
- `prepare-eval-db.sh` gained `EVAL_DB`; the sync test refuses to run against a script without it.
- `connectReadOnly` for every read of the real base's log.
- Fixture items by origin, real items by id; captured ids `c-<8>`, draft ids `d-<10>`.
- `approve` reopens the eval database to re-check kept and edited items, and applies all or nothing.
- Seven agent-written fixture items pin the traps; they count as agent items.
- The eval's default daily Voyage cap is now too small for one full run; the owner raises it.
- `test/unit/baseline.test.ts` no longer reads the committed baseline's shape.
- Front-matter authors are judged with the kind's default in the golden-fixtures test, since the new emails carry no front matter.

Types and names used across tasks: `quotedTitle`, `legacyTopScoreText`, `Explanation.notes` (T1); `SearchOutputSchema`, `SearchOutput`, `toSearchOutput` (T2, used by `server.ts`); `GOLDEN_SOURCES`, `GoldenSource`, `APPROVERS`, `Approver`, `CORPORA`, `Corpus`, `GoldenInput`, `goldenItemProblems`, `validateGoldenItem`, `loadGolden`, `goldenLine`, `appendGolden`, `forCorpus`, `approvalCounts` (T3, used by `metrics.ts`, `run.ts`, `db.ts` (T4), `draft.ts`, `review.ts` (T6), `capture.ts` (T8), `cli.ts`); `QuestionResult.source`, `QuestionResult.approvedBy`, `Report.bySource`, `Report.approvals`, `breakdownLines`, `EVAL_REAL_DATABASE_URL`, `evalDatabaseUrl`, `evalDatabaseHint`, `makeEvalCtx(corpus)` (T4, used by `cli.ts` in T4, T5, T7, T8); `SyncPlan`, `syncPlan`, `runSync` (T5); `DRAFT_KINDS`, `DraftOutputSchema`, `DraftOutput`, `DraftSchema`, `Draft`, `DraftDocument`, `DUPLICATE_STEM_JACCARD`, `MAX_DRAFT_CHARS`, `normalizeQuestion`, `draftId`, `docKey`, `stemJaccard`, `duplicateOf`, `quoteInDocument`, `questionContainsQuote`, `toGoldenItem`, `CheckContext`, `draftProblems`, `loadDrafts`, `saveDrafts`, `DRAFT_SYSTEM`, `CorpusDocument`, `draftUserMessage`, `corpusDocuments`, `nextSheetPath`, `DraftRunOptions`, `DraftRunResult`, `draftDocuments` (T6, `duplicateOf` and `quoteInDocument` reused by `capture.ts` in T8); `DECISIONS`, `Decision`, `documentLine`, `SheetInfo`, `renderSheet`, `SheetItem`, `parseSheet`, `ApplyContext`, `ApplyResult`, `applySheet`, `questionsToStem`, `ApproveOptions`, `approveSheetFile` (T6, used by `cli.ts` in T7); `connectReadOnly`, `CAPTURE_PASSAGES`, `CapturedPassage`, `CapturedSearch`, `CaptureOptions`, `capturedSearches`, `renderCaptured`, `LabelOptions`, `labelCaptured` (T8). Reused from earlier phases: `normalizeWhitespace`, `splitFrontMatter`, `kindFromFilename`, `matchesExpected`, `stemAll`, `StemMap`, `UUID`, `LoggedPassageSchema`, `toLoggedPassages`, `assertEvalDatabase`, `assertEvalConnection`, `defaultAuthor`, `FakeLlm`.

Estimated spend of the implementation (Tasks 10 to 12; Tasks 1 to 9 and 13 spend nothing):
- Claude Code calls (Max plan): about 32 to ingest the 16 new documents (one summary and one extraction each; about 50 if `brain_eval` has to be rebuilt with all 25), and about 27 to draft (25 fixtures, 2 real). About 60 in all, plus any `--force` re-drafts the owner asks for (one each).
- Voyage tokens: about 11,000 to embed the new documents (passages, summaries, entity names); about 200,000 for Task 10's run on 26 items; about 1.3 million per full run once the set has about 70 items with paraphrases (each search reranks nearly every passage of the corpus, about 8,000 tokens), and Task 12 runs it twice, so about 2.7 million; the real-corpus runs are small (a 2-document base). About 3 million tokens in all, nearly all rerank, on the eval's own ledger and cap.

Known limits, not addressed here:
- The real base has 2 documents, so the real-corpus eval is thin until the owner saves more and runs `eval sync`; the program measures the method on the fixture corpus.
- The fixture corpus and most golden questions are machine-written; the owner's approval checks that each question is fair and answerable, not that the corpus resembles their real material.
- One negative per document yields many similar negatives; the duplicate check catches near-identical wording only.
- The draft quality depends on the model's output, seen first in Task 11; a high drop rate means the prompt needs work, which is a follow-up.
- `brain_eval`'s summaries and extractions are model output, so a rebuilt database can move graph-dependent ranks; the baseline is tied to the database it was recorded on.
- `retrieval_log` still has no retention policy; `eval sync` empties only `brain_real_eval`'s.
