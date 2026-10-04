# Phase 7: Calibrated abstention and the remaining Phase 6 follow-ups

**Roadmap:** `2026-09-30-retrieval-hardening-roadmap.md`, "After Phase 6: next work" items 1–5.

## Why

On the Phase 6 baseline the system answered 16 of the 17 fixture questions that nothing in the corpus answers (abstention 0.06, false-answer 0.94). The only "no answer" signal was the 0.3 rerank threshold, which exists to trigger the literal fallback scan, not to judge whether an answer is present. Clients had no signal at all: `brain_search` never said "the knowledge base may not hold this".

## What the calibration data shows (recorded before any held-out item was searched)

Source: the main-question rows of the 2026-10-04 baseline run in `brain_eval.retrieval_log` (no new Voyage call). Calibration set = the 104 existing fixture items (17 negative, 87 positive).

- Top rerank score, negatives: 0.25 to 0.80 (10 of 17 below 0.55). Positives other than bare-code lookups: lowest 0.574 (graph "What do I know about X?" items sit at 0.57–0.61); the one bare-code item below that is q13 "X-90" at 0.516.
- Lexical coverage (IDF-weighted share of question terms found in the returned passages) separates poorly: paraphrased semantic positives have low coverage by design (0.30–0.50), as low as the near-miss negatives. It is not used.
- Combined rules (score OR coverage) gain 2 negatives on the calibration set at the cost of two more parameters fitted to 17 items. Not used.

**Rule (pre-registered):** evidence is
- `unknown` when no rerank ran (keyword-only or fused-order search): there is no score to judge;
- `strong` when the top rerank score is at least `config.retrieval.answerThreshold`;
- `strong` for a bare literal lookup (the query is only trigger terms such as `X-90`, `$115k`, `REQ-4471`) when every term appears literally in a returned passage: a relevance score means little for a bare code, a literal match means a lot;
- `weak` otherwise.

**Threshold:** 0.56, the midpoint (rounded to two decimals) between the lowest calibration positive (0.574) and the highest calibration negative below it (0.551). On the calibration set this abstains on 10 of 17 negatives and on 0 of 87 positives. The threshold is fixed here and is not changed after the held-out run.

**Held-out set:** 48 fixture items (24 negative, 24 positive) written by an agent that was given the corpus and the golden schema but not the scoring rule, the scores, or this plan, marked `split: "heldout"`. Abstention, false-answer and false-abstention rates are reported for each split; the held-out numbers are the ones the README states. Once reported, the held-out items must not be used to tune the threshold; a future change to the rule needs a new held-out set.

## Tasks

| # | Task | Files | Tests |
|---|---|---|---|
| 1 | Golden baselines store `{id, sha256}` per item; an item edited in place trips "golden set changed" (roadmap item 4) | `src/eval/golden.ts`, `src/eval/baseline.ts`, `src/eval/run.ts`, `src/cli.ts` | unit: same ids with one changed hash → goldenChanged; a baseline without hashes still loads and compares by id |
| 2 | Graph items list every answering document (roadmap item 2): d-738fd2a676, d-16387bfc40, d-0f9be4fbce, d-f3c477f497, d-4f7d1eee17, d-b066e2731d, d-73dbcf5459 | `eval/golden.jsonl` | golden parses |
| 3 | `evidence` on the search result (`strong`/`weak`/`unknown`), `config.retrieval.answerThreshold = 0.56`, logged in `retrieval_log.evidence` (migration 13) and replayed by `brain_explain` | `src/retrieve/evidence.ts`, `src/retrieve/contract.ts`, `src/retrieve/search.ts`, `src/retrieve/explain.ts`, `src/config.ts`, `supabase/migrations/20261004000013_evidence.sql` | unit: the four rule cases; integration: a search logs its evidence and explain shows it |
| 4 | Clients see it: the `brain_search` header line, the server instructions, `ask`'s prompt header | `src/mcp/render.ts`, `src/mcp/server.ts`, `src/retrieve/ask.ts` | unit: weak evidence renders the warning line; instructions mention it; ask prompt carries it |
| 5 | Eval scores abstention from `evidence`: abstained = weak, false answer = strong (on negatives), false abstention = weak on positives; per-split report; gate fails when held-out false abstention rises more than 0.02 over the baseline | `src/eval/golden.ts` (`split`), `src/eval/metrics.ts`, `src/eval/baseline.ts`, `src/cli.ts` | unit: per-split rates from synthetic results; gate on false abstention |
| 6 | Held-out items appended to `eval/golden.jsonl` after automatic checks (schema, verbatim quotes); run once; accept the baseline; run the gate (roadmap item 3) | `eval/golden.jsonl`, `eval/baseline.json` | `npm run eval:gate` passes |
| 7 | README and roadmap: the rule, the threshold and how it was chosen, calibration and held-out numbers, what evidence `weak` means to a client | `README.md`, roadmap | review |

Roadmap item 5 (the weekday in `email--acme-final-round.md`) waits for the next corpus re-ingest, as the roadmap says: changing the file without rebuilding `brain_eval` would leave both versions in the eval database.
