# Phase 5: Deterministic Citation Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can see, claim by claim, what in an answer came from the knowledge base and what the model added. After a client writes an answer from a `brain_search` result, `brain_verify(retrieval_id, claims)` checks each claim against the passages and facts it cites and returns a verdict (`supported`, `partial`, `unsupported`, `uncited`, `bad_citation`) with the evidence: the support value, the claim's words missing from the cited text, the numbers missing, whether negation differs, and which cites name nothing. `brain verify` does the same from the CLI, and `brain ask` runs it on its own answer and prints the verdicts under its sources. **No model is called at query time**: the owner is on a Max plan and will not pay per query, and a deterministic check gives the same verdict every time and can be audited. Every verification is logged to `brain.verification_log`. The logic is shown to professionals, so every threshold is defined below and every limit is stated in the tool description, the README and the eval set.

**Architecture:** `src/verify/terms.ts` extracts the evidence: Postgres `to_tsvector('english', …)` lexemes (one round trip per verification, `stemAll`), numbers, dates and codes normalised in TypeScript (`extractNumbers`, `citedNumberSet`), negation words from the raw text (`hasNegation`), the claim's words for display (`claimWords`), and sentences (`splitSentences`). `src/verify/verify.ts` is the method: pure functions over an injected stem map (`checkClaim`, `verdictOf`, `judge`, `summarizeVerdicts`) plus the zod schemas of a claim result, and `verifyTexts`, which fetches the stems and judges. `src/verify/resolve.ts` resolves cites through `brain.retrieval_log` (P labels through `results`, F labels through the new `facts` column, raw chunk and fact ids through the tables), loads the cited texts (chunk content and heading path from `brain.chunks`; fallback windows cut from `documents.raw_content`), judges, and writes one `brain.verification_log` row (`verifyClaims`). `src/verify/answer.ts` splits an answer into claims for `ask`. Migration `20261003000012_verification_log.sql` adds `retrieval_log.facts` and `brain.verification_log`; `search()` writes `facts`. `src/mcp/render.ts` renders a verification; `src/mcp/server.ts` registers `brain_verify` (read-only safe) and extends the instructions; `src/cli.ts` adds `verify` and `eval verifier`. `src/eval/verifier.ts` scores the verifier on `eval/verifier.jsonl` (63 agent-labelled claims with their cited texts inline) and gates on precision of `supported`.

**Tech Stack:** Postgres 17.6 (local Supabase, port 55322), TypeScript ESM run with tsx, vitest, zod 4, postgres.js, commander, @modelcontextprotocol/sdk 1.31 (`registerTool` with `outputSchema`; a tool with one returns `structuredContent`, which the server validates with the zod schema and the client validates against the advertised JSON schema).

**Spec:** `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` §7. Task breakdown: the Phase 5 table in `docs/superpowers/plans/2026-09-30-retrieval-hardening-roadmap.md`. Numbering here: **Task 1** is roadmap 1 (terms), **Task 2** is the method half of roadmap 2 (pure, unit-tested with an injected stem map), **Task 3** is migration 012 (the facts log that F labels need, and the audit table), **Task 4** is the resolution half of roadmap 2 (labels through the log, the audit row), **Task 5** is roadmap 3 and 4 (`brain_verify`, `brain verify`, server instructions), **Task 6** is roadmap 5 (`ask`), **Task 7** is roadmap 6 (verifier golden set and metric), **Task 8** is the README section (the roadmap's "done when"), **Task 9** applies migration 012 to the real database (controller only).
**Prerequisite:** Phase 4 merged (`8101b2d`) and its review follow-ups (`ba335d3`). Work on branch `citation-check`.
**Working directory:** `/Users/frankfu/Documents/GitHub/brain`

Rules for every task:
- Integration tests run on `brain_test` only: `npm run test:int` recreates it from all migrations. Run one integration file with `bash scripts/prepare-test-db.sh && npx vitest run <file>`. **Only one agent runs `test:int` (or `prepare-test-db.sh`) at a time**: the script drops and recreates `brain_test`, which breaks any other run in progress. Unit tests: `npx vitest run <file>` or `npm run test:unit`. **Unit tests make no network calls** and touch no database; anything that needs Postgres (stemming included) is an integration test.
- Migrations are applied to `brain_eval` with `psql`. **Never touch the `postgres` database (the real knowledge base) except in Task 9, which the controller runs, not a subagent.** Never use `supabase migration up`: the real database's migration table is out of sync.
- Migration 012 is idempotent (`add column if not exists`, the check added only when missing, `create table if not exists`, `create index if not exists`) inside `begin`/`commit`. Re-applying it is always safe.
- From Task 3 on, `search()` writes `retrieval_log.facts`, so migration 012 must be on `brain_eval` (Task 3, Step 9) before anything searches there.
- CLI commands on `brain_eval` use `OBSIDIAN_AUTO=0 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval`, so the real database and the Obsidian mirror are never touched.
- Commit per task. The last line of every commit message is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

How the plan answers the owner:
- **What came from the knowledge base and what the model added:** each claim of an answer gets a verdict against the exact passages and facts it cites, resolved through the logged search (the same P and F labels the client saw). `uncited` marks the model's own statements; `partial` and `unsupported` show which of the claim's words and numbers the cited text lacks, in the claim's own words. The server instructions tell clients to call `brain_verify` after answering and to mark anything not `supported` as their own addition or as weakly supported. `brain ask` does this for its own answer.
- **No per-query cost:** the check is Postgres stemming plus TypeScript; nothing calls a model or Voyage. `eval verifier` is free too: its items carry their cited texts inline, so it needs no ingested corpus and no search.
- **Logic professionals can check:** the method is one pure file (`src/verify/verify.ts`) with its definitions in a header comment; the thresholds are named constants (`SUPPORTED_MIN = 0.6`, `PARTIAL_MIN = 0.3`, `VERIFIER_PRECISION_MIN = 0.9`); the limits are in the tool description, the README and as counted errors in the eval set; every verification is logged with its evidence.

Every threshold and rule, defined (the README repeats this for the owner):

| Term | Definition |
|---|---|
| Cited text, passage | The passage's heading path joined with ` > `, a line break, then its content. Content is read from `brain.chunks` by the chunk id logged in `retrieval_log.results`; a fallback passage (no chunk) is `documents.raw_content.slice(charStart, charEnd)`, cut in JavaScript exactly as `search()` cut it. |
| Cited text, fact | `predicate` with `_` replaced by spaces, `: `, then `objectText` (`visa status: F-1 OPT`), from `retrieval_log.facts` (the fact as that search returned it) or, for a raw fact id, from `brain.facts`. |
| Content terms | The distinct lexemes Postgres `to_tsvector('english', word)` gives for each whitespace-separated word of the claim, after removing citation labels, numbers, dates and codes, and the filler words `yes yeah yep ok okay sure indeed also however therefore thus moreover furthermore additionally overall finally`; keeping lexemes that contain a letter and are not `never without none neither cannot`. A negative contraction is stemmed as its base (`doesn't` → `does`, `won't` → `will`). |
| Cited stems | The union of the lexemes of every sentence of every cited text. |
| Support | \|content terms ∩ cited stems\| / \|content terms\|; null when the claim has no content terms or no good cite. Shown with 2 decimals, stored with 3; compared unrounded. |
| Numbers | Every number, date and code in the claim, in canonical form (below), must be in the cited texts' number set. |
| Canonical forms | `1,000` → `1000`; `1.5k` → `1500`; `~11%`, `11 %`, `11 percent`, `11 per cent` → `11%`; `$115k`, `$115K`, `$115,000`, `115,000 dollars`, `USD 115000` → `$115000` (k, m, mm, b, bn, thousand, million, billion scale); `2026-09-29`, `Sep 29, 2026`, `September 29th 2026`, `29 September 2026` → `2026-09-29`; `September 2026`, `2026-09` → `2026-09`; `October 6`, `6 Oct` → `--10-06` (a lower-case "may" is never a month here); `3rd`, `21st` → themselves; `two`…`ninety`, `twenty-five`, `two hundred` → digits (`one` and `first` are not read); a token with a letter and a digit (`H-1B`, `F-1`, `ZX-9000`, `top-20`) is a code, upper-cased. Years are plain numbers. |
| Cited number set | Each canonical value in the cited texts, plus: a full date's month, year and `--MM-DD`; a month's year; a sum's bare amount (`$115000` also gives `115000`). |
| Negation words | `not no never without none neither nor cannot` as whole words, and any word ending in `n't` or `n’t`, case-insensitive, read from the raw text. |
| Negation mismatch | The claim has a negation word and no cited sentence has both a negation word and a matched term; or the claim has none and some cited sentence has both. |
| Sentence | A line, split further at `.` `!` `?` (with any closing quotes, brackets and following `[P1]`-style labels) when whitespace follows and the next word does not start with a lower-case letter; never after `mr mrs ms dr prof sr jr st e.g i.e vs cf approx no fig u.s u.k` or a single-letter initial; never at a decimal point. A leading list marker is dropped. |
| `bad_citation` | Every cite names nothing: a P or F label beyond what that search returned, a label on a search logged before its column existed, a passage since deleted, an unknown id, or text that is not a label or id. |
| `uncited` | No cites. |
| `supported` | Support ≥ `SUPPORTED_MIN` (0.6), no missing number, no negation mismatch. With no content terms: no numbers and no negation mismatch. |
| `partial` | Support ≥ `PARTIAL_MIN` (0.3) and not supported. With no content terms: numbers all present, or a negation mismatch. |
| `unsupported` | Support < 0.3. With no content terms: a number missing. |
| Gate | `eval run --gate` and `eval verifier --gate` fail when precision of `supported` on `eval/verifier.jsonl` is below `VERIFIER_PRECISION_MIN` (0.9) or undefined. |

Decisions the real code forced or settled (details in the self-review notes):
- **`retrieval_log` did not store facts.** `search()` returned facts but logged only passages (`results`), so F labels could not be resolved after the fact. Migration 012 adds `facts jsonb`, `search()` writes it (an empty array when facts are off), and rows logged before it report F labels as `bad_citation` with a note that says why and what to cite instead (a fact id).
- **"Yes." is not term-free in Postgres.** The english stopword list keeps `yes` (and `also`, `however`, `indeed`), so "Yes [P1]." would have one content term and score `unsupported`. A short, listed set of filler words is skipped before stemming, so it has none, as decided.
- **Codes are checked like numbers.** Postgres splits `ZX-9000` into `zx` and `-9000` and `F-1` into `f` and `-1`, so as words a claim about the ZX-8000 would match a source about the ZX-9000. A token with a letter and a digit is extracted as a code and must appear as written.
- **Negation words that survive stemming are not content terms.** `never`, `without`, `none`, `neither` and `cannot` are lexemes in the english configuration; counting them as terms would penalise a negated claim twice (a missing term and a mismatch) and a negated source not at all.
- **"Near a matched term" is "in the same sentence as a matched term".** Postgres positions do not line up with a TypeScript tokenizer (`isn't` is two Postgres tokens), so a word window would be fragile; the cited texts are stemmed per sentence anyway, so the sentence is the window. The eval set records the cost: one long list sentence with an unrelated "without" (item v10).
- **A missing number caps, it never raises.** The brief lists "support ≥ 0.3, or a number missing, or a negation mismatch" for `partial` and "support < 0.3" for `unsupported`; for a claim below 0.3 with a missing number, `unsupported` wins.
- **A term-free claim with numbers is `partial` when the numbers are present and `unsupported` when one is missing.** The brief fixed only the no-number case (`supported`).
- **Resolution lives in `src/verify/resolve.ts`**, not in `verify.ts`, so the method file stays pure and its unit tests import no database code. `verifyTexts` (stems plus judging) stays in `verify.ts` because the eval uses it without any log.
- **The eval set carries cited texts inline** (`cites: [{label, text, heading_path?}]`, facts as `{label, predicate, object_text}`, a missing label as `{label, missing: true}`) with `retrieval: {documents: [...]}` naming the fixture files the texts are quoted from; a unit test checks every text is verbatim in its fixture.
- **`badLabels` carries a reason** (`{label, reason}`), not just the label, because a professional reading the log needs to know whether the label was out of range, unlogged or deleted.
- **`brain_verify` logs its claims as a count in `brain.tool_calls`** (`claims_n`), like `brain_ingest` logs `text_chars`; the full claims are in `brain.verification_log`.

---

## File structure

```
supabase/migrations/
  20261003000012_verification_log.sql   NEW (T3): retrieval_log.facts (+ check); brain.verification_log, indexes, RLS
src/
  verify/terms.ts                       NEW (T1): stemAll, stems, isContentLexeme, hasNegation, NEGATION_WORDS, FILLER_WORDS,
                                        claimWords, extractNumbers, citedNumberSet, splitSentences
  verify/verify.ts                      NEW (T2): SUPPORTED_MIN, PARTIAL_MIN, VERDICTS and schemas (ClaimResult, Summary,
                                        ResolvedCite, BadLabel), passageText, factText, stripLabels, LABEL_GROUP_RE,
                                        stemInputs, checkClaim, verdictOf, judge, verifyTexts, summarizeVerdicts
  verify/resolve.ts                     NEW (T4): MAX_CLAIMS, MAX_CLAIM_CHARS, MAX_CITES, ClaimInputSchema, ClaimsSchema,
                                        VerificationSchema, parseCite, NOTE_NO_RESULTS, NOTE_NO_FACTS, verifyClaims
  verify/answer.ts                      NEW (T6): labelsIn, claimsFromAnswer
  retrieve/search.ts                    MODIFY (T3): log facts
  retrieve/ask.ts                       MODIFY (T6): AskResult; verify the answer on ask's own retrieval id
  mcp/render.ts                         MODIFY: verdictLine, verdictDetail, VERIFY_LIMITS, renderVerification, orient
                                        guidance (T5); renderAnswerCheck (T6)
  mcp/server.ts                         MODIFY (T5): brain_verify (read-only safe), instructions step 5, brain_search
                                        description, claims logged as a count
  cli.ts                                MODIFY: verify (T5); ask prints the check (T6); eval run --verifier and line and
                                        gate, eval verifier (T7)
  eval/verifier.ts                      NEW (T7): VERIFIER_CASES, VerifierItemSchema, parseVerifierSet, toClaim,
                                        verifierReport, VERIFIER_PRECISION_MIN, verifierGate, verifierLine,
                                        runVerifierSet, runVerifierFile, renderVerifierRun
  eval/run.ts                           MODIFY (T7): EvalRun.verifier; runEval(ctx, golden, verifierPath)
eval/
  verifier.jsonl                        NEW (T7): 63 labelled claims with their cited texts
README.md                               MODIFY (T8): commands, tools, eval gate, "Checking an answer against its sources"
test/
  unit/verify-terms.test.ts             NEW (T1)
  integration/verify-terms.test.ts      NEW (T1)
  unit/verify.test.ts                   NEW (T2)
  integration/verification-log.test.ts  NEW (T3)
  integration/helpers.ts                MODIFY (T3): wipe truncates verification_log
  integration/retrieval-log.test.ts     MODIFY (T3): counts migration 011's two checks by name
  integration/verify.test.ts            NEW (T4)
  unit/render.test.ts                   MODIFY (T5, T6)
  integration/mcp-server.test.ts        MODIFY (T5)
  unit/verify-answer.test.ts            NEW (T6)
  integration/ask.test.ts               MODIFY (T6)
  unit/eval-verifier.test.ts            NEW (T7)
  unit/verifier-fixtures.test.ts        NEW (T7)
  integration/eval-verifier.test.ts     NEW (T7)
```

Nothing else reads `ask()`'s return value except `src/cli.ts` and `test/integration/ask.test.ts` (`grep -rn "ask(" src test`); both keep working because `AskResult` only adds fields. `runEval` gains an optional third parameter; its only caller is `src/cli.ts`.

---

### Task 1: Terms: stems from Postgres, numbers, dates, codes, negation, sentences

**Files:**
- Create: `src/verify/terms.ts`
- Create: `test/unit/verify-terms.test.ts`
- Create: `test/integration/verify-terms.test.ts`

Everything the verifier reads from a text. Stems come from Postgres so they match the keyword index exactly (`select lexeme from unnest(to_tsvector('english', …))`); `stemAll` stems every distinct string of a verification in one query (`unnest(text[]) with ordinality` joined laterally to `unnest(to_tsvector(...))`). The rest is pure TypeScript: number, date and code extraction in a fixed rule order (each match is blanked so later rules cannot read it again, and the blanked text is what words are read from), the cited-number expansions, negation words from the raw text (the english configuration drops `not`, `no`, `nor` and the `n't` of contractions), the claim's words for display, and the sentence splitter that `ask` and the negation rule both use. Nothing imports this file yet.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/verify-terms.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extractNumbers, citedNumberSet, hasNegation, claimWords, isContentLexeme, splitSentences } from "../../src/verify/terms.js";

const values = (t: string) => extractNumbers(t).values;

describe("extractNumbers", () => {
  it("normalises thousands separators and percent forms", () => {
    expect(values("lifted ~11% and 1,000 orders")).toEqual(["11%", "1000"]);
    expect(values("11 % or 11 percent or 11 per cent")).toEqual(["11%", "11%", "11%"]);
    expect(values("4+ years, about 300 people, 2.50 hours")).toEqual(["4", "300", "2.5"]);
  });

  it("gives $115k, $115K, $115,000, 115,000 dollars and USD 115000 one form, and applies k/m/b scales", () => {
    expect(values("$115k, $115K, $115,000, 115,000 dollars, USD 115000")).toEqual(["$115000", "$115000", "$115000", "$115000", "$115000"]);
    expect(values("$40M, $40 million, $1.5B, 1.5k orders, 2 million users")).toEqual(["$40000000", "$40000000", "$1500000000", "1500", "2000000"]);
  });

  it("reads ISO and written dates as ISO, a month with a year as YYYY-MM, and a month and day as --MM-DD", () => {
    expect(values("Sep 29, 2026; September 29th 2026; 29 September 2026; 2026-09-29")).toEqual(["2026-09-29", "2026-09-29", "2026-09-29", "2026-09-29"]);
    expect(values("in March 2026, 2026-03, and on October 6 or 6 Oct")).toEqual(["2026-03", "2026-03", "--10-06", "--10-06"]);
    expect(values("AUSTIN, March 12, 2026. Founded in 2019.")).toEqual(["2026-03-12", "2019"]);
  });

  it("does not read a lower-case may followed by or following a number as a month", () => {
    expect(values("the top 5 may help")).toEqual(["5"]);
    expect(values("on May 5")).toEqual(["--05-05"]);
  });

  it("keeps codes whole and upper-cased, so the digits of F-1 or ZX-9000 are never read as numbers", () => {
    expect(values("on F-1 OPT, sponsors h-1b, the ZX-9000 and X-90, in Q3")).toEqual(["F-1", "H-1B", "ZX-9000", "X-90", "Q3"]);
    expect(values("ranges 2019-2023")).toEqual(["2019", "2023"]);
  });

  it("reads digit ordinals and number words, but not 'one' or 'first'", () => {
    expect(values("the 3rd, 21st and 12th")).toEqual(["3rd", "21st", "12th"]);
    expect(values("two hundred workers, three finalists, twenty-five seats, one of the first")).toEqual(["200", "3", "25"]);
  });

  it("blanks what it extracted, so the rest has only words", () => {
    expect(extractNumbers("Acme pays $115k on F-1 since 2019").rest.split(/\s+/).filter(Boolean)).toEqual(["Acme", "pays", "on", "since"]);
  });
});

describe("citedNumberSet", () => {
  it("adds what a cited value implies: a date's month, year and month-day; a sum's bare amount", () => {
    expect([...citedNumberSet(["2026-09-29", "$115000", "2026-03", "11%"])].sort()).toEqual(
      ["$115000", "--09-29", "11%", "115000", "2026", "2026-03", "2026-09", "2026-09-29"],
    );
  });
});

describe("hasNegation", () => {
  it("finds not, no, never, without, none, neither, nor, cannot and n't as whole words, in any case", () => {
    for (const t of ["Acme does not sponsor", "No.", "never again", "without a visa", "none of them", "neither", "nor", "I cannot", "Acme doesn't", "Acme doesn’t", "It WON'T"]) {
      expect([t, hasNegation(t)]).toEqual([t, true]);
    }
    for (const t of ["Acme sponsors H-1B", "nothing notable", "knowledge", "Nordic", "nonetheless", "denote"]) {
      expect([t, hasNegation(t)]).toEqual([t, false]);
    }
  });
});

describe("claimWords and isContentLexeme", () => {
  it("strips punctuation for display and reduces negative contractions to their base for stemming", () => {
    expect(claimWords(`Acme doesn't, won't sponsor "visas".`)).toEqual([
      { display: "Acme", stemKey: "Acme" },
      { display: "doesn't", stemKey: "does" },
      { display: "won't", stemKey: "will" },
      { display: "sponsor", stemKey: "sponsor" },
      { display: "visas", stemKey: "visas" },
    ]);
  });

  it("skips answer and connective words, which state nothing a source could confirm", () => {
    expect(claimWords("Yes, however Acme also sponsors").map((w) => w.display)).toEqual(["Acme", "sponsors"]);
    expect(claimWords("Yes.")).toEqual([]);
  });

  it("counts lexemes with a letter, except negation words", () => {
    expect(["databrick", "h-1b", "115k", "2026", "-09", "never", "without", "none", "neither", "cannot"].map(isContentLexeme)).toEqual(
      [true, true, true, false, false, false, false, false, false, false],
    );
  });
});

describe("splitSentences", () => {
  it("splits on . ! ? and line breaks, keeps labels with their sentence, and drops list markers", () => {
    expect(splitSentences("Acme sponsors visas [P1]. It is hybrid. [P2] Is it remote? No!\n- first point\n2. second point")).toEqual([
      "Acme sponsors visas [P1].", "It is hybrid. [P2]", "Is it remote?", "No!", "first point", "second point",
    ]);
  });

  it("does not split after abbreviations, initials or decimal points, or before a lower-case word", () => {
    expect(splitSentences("Use a warehouse, e.g. Snowflake. Dr. Smith and J. Doe agreed 1.5 was fine. U.S. firms pay more. It rose ca. two points.")).toEqual([
      "Use a warehouse, e.g. Snowflake.", "Dr. Smith and J. Doe agreed 1.5 was fine.", "U.S. firms pay more.", "It rose ca. two points.",
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(splitSentences(" \n\n ")).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing integration test**

Create `test/integration/verify-terms.test.ts`:
```ts
import { describe, it, expect, afterAll } from "vitest";
import { testDb } from "./helpers.js";
import { stems, stemAll } from "../../src/verify/terms.js";

const sql = testDb();
afterAll(() => sql.end());

describe("stems from Postgres", () => {
  it("are the english configuration's lexemes, as the keyword index stores them", async () => {
    expect(await stems(sql, "Databricks saves money")).toEqual(["databrick", "money", "save"]);
    expect(await stems(sql, "The cluster was not shut down")).toEqual(["cluster", "shut"]);
    expect(await stems(sql, "")).toEqual([]);
  });

  it("stems many texts in one query and maps each distinct text to its lexemes", async () => {
    const texts = ["Acme sponsors visas", "sponsorship", "Acme sponsors visas", "the of and"];
    let queries = 0;
    const counting = new Proxy(sql, { apply: (target, self, args) => (queries++, Reflect.apply(target as never, self, args)) });
    const map = await stemAll(counting, texts);
    expect(queries).toBe(1);
    expect([...map.entries()]).toEqual([
      ["Acme sponsors visas", ["acm", "sponsor", "visa"]],
      ["sponsorship", ["sponsorship"]],
      ["the of and", []],
    ]);
    expect((await stemAll(counting, [])).size).toBe(0);
    expect(queries).toBe(1);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/verify-terms.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/verify-terms.test.ts`
Expected: FAIL: `Error: Cannot find module '../../src/verify/terms.js' imported from …/test/unit/verify-terms.test.ts`, `Test Files 1 failed`, `Tests no tests` (the `&&` stops there; the integration file fails the same way).

- [ ] **Step 4: Write `src/verify/terms.ts`**

Create `src/verify/terms.ts`:
```ts
import type { Db } from "../db.js";

/**
 * Term extraction for the citation verifier (spec §7.2). Three kinds of evidence are read from a claim and from the
 * text it cites:
 *  - content terms: Postgres `to_tsvector('english', …)` lexemes, so stemming and stopwords are exactly the keyword
 *    index's (stemAll, one round trip for a whole verification);
 *  - numbers, dates and codes, normalised in TypeScript to one canonical spelling each (extractNumbers);
 *  - negation words, read from the raw text, because the english configuration drops most of them as stopwords
 *    (hasNegation).
 * Everything here except stemAll is pure.
 */

/** Lexemes per input string, as Postgres produced them; built by stemAll, or by hand in unit tests. */
export type StemMap = Map<string, string[]>;

/**
 * The lexemes of every distinct text, from Postgres, in one round trip: `select lexeme from unnest(to_tsvector(...))`.
 * Each text maps to its distinct lexemes in sorted order (an empty list for a text that is all stopwords).
 */
export async function stemAll(sql: Db, texts: string[]): Promise<StemMap> {
  const unique = [...new Set(texts)];
  const map: StemMap = new Map(unique.map((t) => [t, [] as string[]]));
  if (unique.length === 0) return map;
  const rows = await sql<{ i: number; lexeme: string }[]>`
    select t.i::int as i, v.lexeme
    from unnest(${unique}::text[]) with ordinality as t(s, i)
    cross join lateral unnest(to_tsvector('english', t.s)) as v
    order by t.i, v.lexeme`;
  for (const r of rows) map.get(unique[r.i - 1])!.push(r.lexeme);
  return map;
}

/** The lexemes of one text (stemAll for a single string). */
export async function stems(sql: Db, text: string): Promise<string[]> {
  return (await stemAll(sql, [text])).get(text)!;
}

/**
 * Negation lexemes that survive the english stopword list. They are checked by hasNegation, so they are not counted
 * as content terms (otherwise a negated claim would be penalised twice, and a negated source not at all).
 */
const NEGATION_LEXEMES = new Set(["never", "without", "none", "neither", "cannot"]);

/** A lexeme that counts as a content term: it has a letter (pure digits are numbers) and is not a negation word. */
export function isContentLexeme(lexeme: string): boolean {
  return /\p{L}/u.test(lexeme) && !NEGATION_LEXEMES.has(lexeme);
}

/** The negation words: not, no, never, without, none, neither, nor, cannot, and any word ending in n't (or n’t). */
export const NEGATION_WORDS = ["not", "no", "never", "without", "none", "neither", "nor", "cannot", "n't"] as const;
const NEGATION_RE = /(?<![\p{L}\p{N}])(?:not|no|never|without|none|neither|nor|cannot)(?![\p{L}\p{N}])|\p{L}n['’]t(?!\p{L})/iu;

/** True when the raw text contains a negation word (case-insensitive, whole words; n't as a word ending). */
export function hasNegation(text: string): boolean {
  return NEGATION_RE.test(text);
}

/** won't, can't, shan't and ain't do not end in their base word plus n't. */
const CONTRACTION_BASE: Record<string, string> = { wo: "will", ca: "can", sha: "shall", ai: "is" };

export interface ClaimWord {
  /** The word as the user wrote it, without surrounding punctuation: what missingTerms shows. */
  display: string;
  /** What is stemmed: the word, with a negative contraction reduced to its base (doesn't → does, won't → will). */
  stemKey: string;
}

/**
 * Answer and connective words that state nothing a source could confirm. The english stopword list keeps them
 * ("Yes." has the lexeme yes), so claimWords skips them: "Yes [P1]." has no content terms.
 */
export const FILLER_WORDS = new Set([
  "yes", "yeah", "yep", "ok", "okay", "sure", "indeed", "also", "however", "therefore", "thus", "moreover", "furthermore",
  "additionally", "overall", "finally",
]);

/**
 * A claim's words, split on whitespace, in order, without FILLER_WORDS. Postgres never joins tokens across
 * whitespace, so stemming the words one by one gives the same lexemes as stemming the whole text.
 */
export function claimWords(text: string): ClaimWord[] {
  const out: ClaimWord[] = [];
  for (const raw of text.split(/\s+/)) {
    const display = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!display || FILLER_WORDS.has(display.toLowerCase())) continue;
    const m = /^(\p{L}+)n['’]t$/iu.exec(display);
    const stemKey = m ? (CONTRACTION_BASE[m[1].toLowerCase()] ?? m[1]) : display;
    out.push({ display, stemKey });
  }
  return out;
}

/** Month number by the first three letters of its name. */
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const month = (name: string) => pad(MONTHS[name.slice(0, 3).toLowerCase()]);
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?!\\p{L})\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const NUM = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?";

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const UNITS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const WORD_SCALE: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };

const pad = (n: number) => String(n).padStart(2, "0");

/** A plain decimal string: thousands separators dropped, the scale applied, at most 6 decimals, no trailing zeros. */
function canonNumber(int: string, frac: string | undefined, scale = 1): string {
  const n = Number(int.replace(/,/g, "") + (frac ? "." + frac : "")) * scale;
  return String(Math.round(n * 1e6) / 1e6);
}

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** A token with both a letter and a digit (F-1, H-1B, ZX-9000, Q3), unless it is a number with a scale or ordinal suffix. */
function isCode(token: string): boolean {
  return /\p{L}/u.test(token) && /\p{N}/u.test(token) && !/^\d+(?:[.,]\d+)*(?:k|m|mm|b|bn|st|nd|rd|th)$/i.test(token);
}

type Rule = [RegExp, (m: string[]) => string | null];

/**
 * The extraction rules, applied in this order; each match is replaced by a space so later rules cannot read it again.
 * A rule returning null leaves its match in place. The canonical forms:
 *   dates     2026-09-29 (full), 2026-09 (month and year), --09-29 (month and day, no year)
 *   money     $115000 ($115k, $115K, $115,000, 115,000 dollars, USD 115000; k/m/b and thousand/million/billion scale)
 *   percent   11% (11%, ~11%, 11 %, 11 percent, 11 per cent)
 *   codes     H-1B, F-1, ZX-9000 (upper-cased tokens with a letter and a digit)
 *   ordinals  3rd, 21st (digits only: "first" is too often not a number)
 *   numbers   1000 (1,000), 1500 (1.5k), 40000000 (40 million), 4 (4+); years are plain numbers (2026)
 *   words     two to ninety, optionally hyphenated with a unit and followed by hundred/thousand/million/billion
 *             ("two hundred" is 200); "one" is not read, since it is usually a pronoun ("one of", "no one")
 */
const RULES: Rule[] = [
  // ISO date, then ISO month.
  [/(?<![\p{N}-])(\d{4})-(\d{2})-(\d{2})(?![\p{N}-])/giu, (m) => `${m[1]}-${m[2]}-${m[3]}`],
  [/(?<![\p{N}-])(\d{4})-(\d{2})(?![\p{N}-])/giu, (m) => (Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}` : null)],
  // Sep 29, 2026 · September 29th 2026 · 29 September 2026 · September 2026.
  [new RegExp(`(?<![\\p{L}])${MONTH}\\s+${DAY},?\\s+(\\d{4})(?!\\p{N})`, "giu"), (m) => `${m[3]}-${month(m[1])}-${pad(Number(m[2]))}`],
  [new RegExp(`(?<![\\p{L}\\p{N}])${DAY}\\s+(?:of\\s+)?${MONTH},?\\s+(\\d{4})(?!\\p{N})`, "giu"), (m) => `${m[3]}-${month(m[2])}-${pad(Number(m[1]))}`],
  [new RegExp(`(?<![\\p{L}])${MONTH},?\\s+(\\d{4})(?!\\p{N})`, "giu"), (m) => `${m[2]}-${month(m[1])}`],
  // Sep 29 · 29 Sep (no year). A lower-case "may" here is the verb ("5 may help"), not the month.
  [new RegExp(`(?<![\\p{L}])${MONTH}\\s+${DAY}(?![\\p{L}\\p{N}])`, "giu"), (m) => (m[1] === "may" ? null : `--${month(m[1])}-${pad(Number(m[2]))}`)],
  [new RegExp(`(?<![\\p{L}\\p{N}])${DAY}\\s+(?:of\\s+)?${MONTH}`, "giu"), (m) => (m[2] === "may" ? null : `--${month(m[2])}-${pad(Number(m[1]))}`)],
  // Money.
  [new RegExp(`(?:US)?\\$\\s?${NUM}(?:(k|mm|m|bn|b)(?![\\p{L}\\p{N}])|\\s?(thousand|million|billion)(?!\\p{L}))?`, "giu"), (m) => "$" + canonNumber(m[1], m[2], SCALE[(m[3] ?? m[4] ?? "").toLowerCase()] ?? 1)],
  [new RegExp(`(?<![\\p{L}\\p{N}.])${NUM}(?:\\s?(thousand|million|billion))?\\s+(?:dollars|usd)(?!\\p{L})`, "giu"), (m) => "$" + canonNumber(m[1], m[2], SCALE[(m[3] ?? "").toLowerCase()] ?? 1)],
  [new RegExp(`(?<![\\p{L}])usd\\s?${NUM}`, "giu"), (m) => "$" + canonNumber(m[1], m[2])],
  // Percent.
  [new RegExp(`(?<![\\p{L}\\p{N}.])${NUM}\\s?(?:%|percent(?!\\p{L})|per\\s+cent(?!\\p{L}))`, "giu"), (m) => canonNumber(m[1], m[2]) + "%"],
  // Codes.
  [/(?<![\p{L}\p{N}-])[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+(?![\p{L}\p{N}])|(?<![\p{L}\p{N}-])[\p{L}\p{N}]+(?![\p{L}\p{N}-])/gu, (m) => (isCode(m[0]) ? m[0].toUpperCase() : null)],
  // Ordinals.
  [/(?<![\p{L}\p{N}])(\d+)(?:st|nd|rd|th)(?![\p{L}\p{N}])/giu, (m) => ordinal(Number(m[1]))],
  // Plain numbers, with an attached k/m/b or a following thousand/million/billion.
  [new RegExp(`(?<![\\p{L}\\p{N}.])${NUM}(?:(k|mm|m|bn|b)(?![\\p{L}\\p{N}])|\\s?(thousand|million|billion)(?!\\p{L}))?`, "giu"), (m) => canonNumber(m[1], m[2], SCALE[(m[3] ?? m[4] ?? "").toLowerCase()] ?? 1)],
  // Number words.
  [
    /(?<![\p{L}-])(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-(one|two|three|four|five|six|seven|eight|nine))?(?:\s+(hundred|thousand|million|billion))?(?![\p{L}-])/giu,
    (m) => String((WORD_NUMBERS[m[1].toLowerCase()] + (m[2] ? UNITS[m[2].toLowerCase()] : 0)) * (m[3] ? WORD_SCALE[m[3].toLowerCase()] : 1)),
  ],
];

/**
 * The numbers, dates and codes in a text, in canonical form (see RULES), and the text with them blanked out (`rest`),
 * which is what content terms are read from, so "2026" or "H-1B" is checked as a number or code, never as a word.
 */
export function extractNumbers(text: string): { values: string[]; rest: string } {
  const values: string[] = [];
  let rest = text;
  for (const [re, canon] of RULES) {
    rest = rest.replace(re, (match: string, ...more: unknown[]) => {
      // more is the capture groups (string or undefined), then the match offset (a number), then the whole string.
      const m = [match, ...(more.slice(0, more.findIndex((x) => typeof x === "number")) as string[])];
      const v = canon(m);
      if (v === null) return match;
      values.push(v);
      return " ";
    });
  }
  return { values, rest };
}

/**
 * What the cited texts state, for matching a claim's numbers: each canonical value, plus what it implies. A full date
 * also states its month (2026-09), its year (2026) and its month-day (--09-29); a month states its year; a sum of money
 * also states the bare amount ($115000 states 115000). Nothing else is implied: a claim's "$115000" needs "$" in the
 * source (or "dollars"/"USD"), and a percentage needs "%" (or "percent").
 */
export function citedNumberSet(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    out.add(v);
    let m: RegExpExecArray | null;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) out.add(`${m[1]}-${m[2]}`).add(m[1]).add(`--${m[2]}-${m[3]}`);
    else if ((m = /^(\d{4})-(\d{2})$/.exec(v))) out.add(m[1]);
    else if (v.startsWith("$")) out.add(v.slice(1));
  }
  return out;
}

/** Never ends a sentence: titles, Latin abbreviations, and U.S./U.K. ("e.g. Snowflake", "Dr. Smith"). */
const NEVER_ENDS = new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "e.g", "i.e", "vs", "cf", "approx", "no", "fig", "u.s", "u.k"]);

/**
 * Splits text into sentences. Every line break ends a sentence, and a leading list marker (-, *, •, 1., 1)) is dropped.
 * Within a line, a sentence ends at . ! or ? (with any closing quotes or brackets and any citation labels such as
 * [P1] that follow it) when whitespace follows and the next word does not start with a lower-case letter. A full stop
 * does not end a sentence after an abbreviation in NEVER_ENDS or a single-letter initial ("J. Smith"); a decimal
 * point never does, since no whitespace follows it.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (!line) continue;
    let start = 0;
    const re = /[.!?]+["'”’)\]]*(?:\s*\[[^\]\n]{1,40}\])*(?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const end = m.index + m[0].length;
      const next = line.slice(end).trimStart();
      if (next === "") break;
      if (line[m.index] === ".") {
        const before = line.slice(start, m.index).split(/\s+/).pop()!.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
        if (NEVER_ENDS.has(before) || /^\p{L}$/u.test(before)) continue;
        if (/^\p{Ll}/u.test(next)) continue;
      }
      out.push(line.slice(start, end).trim());
      start = end;
    }
    const tail = line.slice(start).trim();
    if (tail) out.push(tail);
  }
  return out;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/verify-terms.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/verify-terms.test.ts`
Expected: PASS (15 unit tests, 2 integration tests). The integration test also proves the roadmap's example (`databrick`, `money`, `save`) and that `stemAll` makes one query for four texts and none for zero.

- [ ] **Step 6: Typecheck and the suites**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green (unit 315 tests, integration 289).

- [ ] **Step 7: Commit**

```bash
git add src/verify/terms.ts test/unit/verify-terms.test.ts test/integration/verify-terms.test.ts
git commit -m "Verifier terms: Postgres stems in one round trip, normalised numbers, dates and codes, negation words, sentences

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The method: support, numbers, negation, verdicts (pure)

**Files:**
- Create: `src/verify/verify.ts`
- Create: `test/unit/verify.test.ts`

The verifier's core, as pure functions over a stem map (`StemMap`, from `stemAll` in production, from a small stand-in stemmer in the unit tests, so they need no database). `stemInputs(claim, cited)` lists every string `checkClaim` will look up (the claim's words and the cited texts' sentences), so a caller builds the map with one `stemAll` and `checkClaim` throws if a string is missing. `verdictOf` applies the rules in the order of the table in the header; `judge` assembles one `ClaimResult` (the claim with labels stripped, its labels, verdict, support rounded to 3 decimals, matched and missing terms as the claim's own words, missing numbers, negation mismatch, bad labels, resolved cites); `verifyTexts` stems everything for a list of claims in one query and judges each. The zod schemas here are reused by `brain_verify`'s `outputSchema` (Task 5).

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/verify.test.ts` (27 cases, more than the roadmap's 20):
```ts
import { describe, it, expect } from "vitest";
import {
  judge, checkClaim, stemInputs, stripLabels, summarizeVerdicts, verdictOf, passageText, factText, SUPPORTED_MIN, PARTIAL_MIN,
  type BadLabel, type CitedText,
} from "../../src/verify/verify.js";
import type { StemMap } from "../../src/verify/terms.js";

/**
 * A stand-in for Postgres's english stemming, so these tests need no database: lower-case, split on anything but
 * letters, digits, hyphens and apostrophes, drop a possessive 's and a small stopword list, and strip a final s from
 * words longer than three letters. test/integration/verify-terms.test.ts checks the real stems.
 */
const STOP = new Set("a an the is are was were be been to of in on for and or it its i am has have had that this with at by as from not no nor does do did will can he she they we".split(" "));
function fakeLexemes(s: string): string[] {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^\p{L}\p{N}'’-]+/u)) {
    const w = raw.replace(/['’]s$/, "").replace(/^[-'’]+|[-'’]+$/g, "");
    if (!w || STOP.has(w)) continue;
    out.add(w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return [...out].sort();
}
const stemsFor = (claim: string, cited: CitedText[]): StemMap => new Map(stemInputs(claim, cited).map((s) => [s, fakeLexemes(s)]));

const P = (text: string, label = "P1"): CitedText => ({ label, kind: "passage", text });
const F = (predicate: string, objectText: string, label = "F1"): CitedText => ({ label, kind: "fact", text: factText(predicate, objectText) });

function run(claim: string, cited: CitedText[], bad: BadLabel[] = []) {
  return judge({ text: claim, labels: [...cited.map((c) => c.label), ...bad.map((b) => b.label)], cited, cites: [], badLabels: bad }, stemsFor(claim, cited));
}

describe("verdicts", () => {
  it("an exact restatement is supported with support 1", () => {
    const r = run("Acme sponsors H-1B visas.", [P("Acme sponsors H-1B for this role and other visas.")]);
    expect(r).toMatchObject({ verdict: "supported", support: 1, matchedTerms: ["Acme", "sponsors", "visas"], missingTerms: [], missingNumbers: [], negationMismatch: false });
  });

  it("a paraphrase with half its terms in the source is partial, and missingTerms are the claim's own words", () => {
    const r = run("Acme pays engineers well in Denver offices.", [P("Acme pays well.")]);
    expect(r).toMatchObject({ verdict: "partial", support: 0.5, matchedTerms: ["Acme", "pays", "well"], missingTerms: ["engineers", "Denver", "offices"] });
  });

  it("an unrelated claim is unsupported", () => {
    const r = run("Northwind hired a product analyst in Denver.", [P("Acme sponsors visas.")]);
    expect(r).toMatchObject({ verdict: "unsupported", support: 0, missingTerms: ["Northwind", "hired", "product", "analyst", "Denver"] });
  });

  it("applies the thresholds exactly: 0.6 is supported, 0.3 is partial, below 0.3 is unsupported", () => {
    expect(SUPPORTED_MIN).toBe(0.6);
    expect(PARTIAL_MIN).toBe(0.3);
    const src = [P("alpha bravo charlie")];
    expect(run("alpha bravo charlie delta echo", src)).toMatchObject({ verdict: "supported", support: 0.6 });
    expect(run("alpha bravo delta echo foxtrot", src)).toMatchObject({ verdict: "partial", support: 0.4 });
    expect(run("alpha bravo charlie delta echo foxtrot golf hotel india juliet", src)).toMatchObject({ verdict: "partial", support: 0.3 });
    expect(run("alpha delta echo foxtrot", src)).toMatchObject({ verdict: "unsupported", support: 0.25 });
  });

  it("a claim with no cites is uncited, whatever it says", () => {
    expect(run("Acme sponsors visas.", [])).toMatchObject({ verdict: "uncited", support: null, matchedTerms: [], missingTerms: [] });
  });

  it("a claim whose only cite does not exist is bad_citation", () => {
    const r = run("Acme sponsors visas.", [], [{ label: "P99", reason: "no P99 in this search (it returned 3 passages)" }]);
    expect(r).toMatchObject({ verdict: "bad_citation", support: null, labels: ["P99"], badLabels: [{ label: "P99" }] });
  });

  it("a claim with good and bad cites is judged on the good ones, and still reports the bad ones", () => {
    const r = run("Acme sponsors visas.", [P("Acme sponsors visas.")], [{ label: "P9", reason: "no P9" }]);
    expect(r).toMatchObject({ verdict: "supported", labels: ["P1", "P9"], badLabels: [{ label: "P9", reason: "no P9" }] });
  });

  it("a claim spanning two passages is supported by their union, and only partial by either alone", () => {
    const claim = "Acme sponsors visas; the role is hybrid with good salary.";
    const a = P("Acme sponsors visas.", "P1");
    const b = P("The role is hybrid and the salary is good.", "P2");
    expect(run(claim, [a, b])).toMatchObject({ verdict: "supported", support: 1 });
    expect(run(claim, [a]).verdict).toBe("partial");
    expect(run(claim, [b]).verdict).toBe("partial");
  });

  it("a fact is cited as its predicate with spaces plus its object", () => {
    expect(factText("visa_status", "F-1 OPT")).toBe("visa status: F-1 OPT");
    expect(run("Visa status is F-1 OPT.", [F("visa_status", "F-1 OPT")])).toMatchObject({ verdict: "supported", support: 1 });
  });

  it("a passage's heading path counts as cited text", () => {
    expect(passageText(["Compensation and visa"], "Acme sponsors H-1B.")).toBe("Compensation and visa\nAcme sponsors H-1B.");
    expect(passageText([], "Body")).toBe("Body");
    expect(run("Compensation includes a visa.", [P(passageText(["Compensation and visa"], "Base pay is listed."))]).verdict).toBe("supported");
  });
});

describe("numbers and dates", () => {
  it("a number the source does not state caps the claim at partial and is listed", () => {
    const r = run("Acme pays $140,000.", [P("Acme pays $115,000 base.")]);
    expect(r).toMatchObject({ verdict: "partial", support: 1, missingNumbers: ["$140000"] });
  });

  it("a missing number never raises a verdict above unsupported", () => {
    expect(run("Northwind hired 9 analysts in Denver.", [P("Acme sponsors visas.")])).toMatchObject({ verdict: "unsupported", missingNumbers: ["9"] });
  });

  it("matches $115k to $115,000, ~11% to 11 percent, and a written date to an ISO one", () => {
    expect(run("Acme pays $115k.", [P("Acme pays $115,000.")]).verdict).toBe("supported");
    expect(run("Retention rose ~11%.", [P("Retention rose 11 percent.")]).verdict).toBe("supported");
    expect(run("The screen is on Sep 22, 2026.", [P("SQL screen on 2026-09-22.")]).verdict).toBe("supported");
  });

  it("a full date in the source also states its year and its month", () => {
    expect(run("The screen is in 2026.", [P("SQL screen on 2026-09-22.")])).toMatchObject({ verdict: "supported", missingNumbers: [] });
    expect(run("The screen is in September 2026.", [P("SQL screen on 2026-09-22.")])).toMatchObject({ verdict: "supported", missingNumbers: [] });
  });

  it("a code must appear as written: ZX-8000 is not ZX-9000", () => {
    expect(run("Acme makes the ZX-8000 drill.", [P("Acme makes the ZX-9000 drill.")])).toMatchObject({ verdict: "partial", support: 1, missingNumbers: ["ZX-8000"] });
  });
});

describe("negation", () => {
  it("a negated claim whose source does not negate is capped at partial", () => {
    expect(run("Acme does not sponsor visas.", [P("Acme sponsors visas.")])).toMatchObject({ verdict: "partial", support: 1, negationMismatch: true });
  });

  it("a plain claim whose source negates a matched term in the same sentence is capped at partial", () => {
    expect(run("Acme sponsors visas.", [P("Acme does not sponsor visas.")])).toMatchObject({ verdict: "partial", negationMismatch: true });
  });

  it("a negated claim with a negated source is supported, contractions included", () => {
    expect(run("Acme doesn't sponsor visas.", [P("Acme does not sponsor visas.")])).toMatchObject({ verdict: "supported", negationMismatch: false });
  });

  it("a negation in a source sentence without a matched term does not count", () => {
    expect(run("Acme sponsors visas.", [P("Acme sponsors visas. The weather was not warm.")])).toMatchObject({ verdict: "supported", negationMismatch: false });
  });
});

describe("claims without content terms", () => {
  it("'Yes [P1].' is supported: it has no terms, numbers or negation to check", () => {
    expect(run("Yes [P1].", [P("Acme sponsors visas.")])).toMatchObject({ verdict: "supported", support: null, matchedTerms: [], missingTerms: [] });
  });

  it("'No [P1].' is partial: its negation is not in the source", () => {
    expect(run("No [P1].", [P("Acme sponsors visas.")])).toMatchObject({ verdict: "partial", negationMismatch: true });
  });

  it("a bare figure is partial when the source states it and unsupported when it does not", () => {
    expect(run("$115,000 to $140,000 [P1].", [P("Base salary range $115,000 to $140,000.")])).toMatchObject({ verdict: "partial", support: null, missingNumbers: [] });
    expect(run("$150,000 [P1].", [P("Base salary range $115,000 to $140,000.")])).toMatchObject({ verdict: "unsupported", missingNumbers: ["$150000"] });
  });

  it("'Yes.' with no cite is uncited", () => {
    expect(run("Yes.", []).verdict).toBe("uncited");
  });
});

describe("helpers", () => {
  it("stripLabels removes [P1], [F2], [P1, F2] and [P1][F2], and the space they leave before punctuation", () => {
    expect(stripLabels("Acme sponsors visas [P1].")).toBe("Acme sponsors visas.");
    expect(stripLabels("Acme [P1, F2] pays [p3][F4] well [P5; P6] ")).toBe("Acme pays well");
  });

  it("checkClaim refuses a stem map that lacks an input, so a caller cannot judge with missing stems", () => {
    expect(() => checkClaim("Acme sponsors visas.", [P("Acme")], new Map())).toThrow(/no stems for "Acme"/);
  });

  it("verdictOf follows the rule order in its comment", () => {
    const base = { termCount: 2, support: 1, matchedTerms: [], missingTerms: [], numberCount: 0, missingNumbers: [], negationMismatch: false };
    expect(verdictOf(base, 0, 0)).toBe("uncited");
    expect(verdictOf(base, 0, 1)).toBe("bad_citation");
    expect(verdictOf({ ...base, support: 0.2, missingNumbers: ["5"], negationMismatch: true }, 1, 0)).toBe("unsupported");
    expect(verdictOf({ ...base, negationMismatch: true }, 1, 0)).toBe("partial");
  });

  it("summarizeVerdicts counts each verdict and writes the non-zero counts in verdict order", () => {
    const s = summarizeVerdicts([{ verdict: "partial" }, { verdict: "supported" }, { verdict: "supported" }, { verdict: "bad_citation" }]);
    expect(s).toEqual({ supported: 2, partial: 1, unsupported: 0, uncited: 0, bad_citation: 1, text: "2 supported, 1 partial, 1 bad citation" });
    expect(summarizeVerdicts([]).text).toBe("no claims");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unit/verify.test.ts`
Expected: FAIL: `Error: Cannot find module '../../src/verify/verify.js' imported from …/test/unit/verify.test.ts`, `Tests no tests`.

- [ ] **Step 3: Write `src/verify/verify.ts`**

Create `src/verify/verify.ts`:
```ts
import { z } from "zod";
import type { Db } from "../db.js";
import { claimWords, citedNumberSet, extractNumbers, hasNegation, isContentLexeme, splitSentences, stemAll, type StemMap } from "./terms.js";

/**
 * The citation verifier's method (spec §7.2): for one claim and the texts it cites, how much of the claim's
 * vocabulary the cited texts contain, whether they state every number and date the claim states, and whether
 * negation agrees. No model is called. Everything here is pure except verifyTexts, which fetches the stems.
 *
 * Definitions:
 *  - content terms: the distinct Postgres english lexemes of the claim's words, after labels ([P1]), numbers, dates
 *    and codes are removed, keeping lexemes that contain a letter and are not negation words (terms.ts).
 *  - cited stems: the union of the lexemes of every cited text. A passage's text is its heading path plus its content;
 *    a fact's is its predicate with underscores as spaces, a colon, and its object text.
 *  - support: |content terms ∩ cited stems| / |content terms|; null when the claim has no content terms.
 *  - numbers: every number, date and code in the claim must be in the cited texts' citedNumberSet.
 *  - negation mismatch: the claim has a negation word, but no sentence of the cited texts has one together with a
 *    matched term; or the claim has none, but such a sentence does.
 */

/** Lowest support for `supported`. */
export const SUPPORTED_MIN = 0.6;
/** Lowest support for `partial`; below it a claim with good citations is `unsupported`. */
export const PARTIAL_MIN = 0.3;

export const VERDICTS = ["supported", "partial", "unsupported", "uncited", "bad_citation"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ResolvedCiteSchema = z.object({
  /** The cite as given, normalised: P1, F2, or a chunk or fact id. */
  label: z.string(),
  kind: z.enum(["passage", "fact"]),
  /** The passage's document; for a fact, the document it was extracted from, or null when the owner stated it. */
  documentId: z.string().nullable(),
  /** Null for a fallback passage (a window of the raw document) and for facts. */
  chunkId: z.string().nullable(),
  /** Set for facts only. */
  factId: z.string().nullable(),
  /** The passage's document title; for a fact, the fact itself ("visa_status: F-1 OPT"). */
  title: z.string().nullable(),
});
export type ResolvedCite = z.infer<typeof ResolvedCiteSchema>;

export const BadLabelSchema = z.object({ label: z.string(), reason: z.string() });
export type BadLabel = z.infer<typeof BadLabelSchema>;

export const ClaimResultSchema = z.object({
  /** The claim as checked: the given text with citation labels removed. */
  claim: z.string(),
  /** The cites as given, normalised and without duplicates, in order. */
  labels: z.array(z.string()),
  verdict: VerdictSchema,
  /** Share of content terms found in the cited texts, 3 decimals; null without content terms or without a good cite. */
  support: z.number().nullable(),
  /** Content terms found, as the claim's own words (the first word that produced each stem). */
  matchedTerms: z.array(z.string()),
  /** Content terms not found, as the claim's own words. */
  missingTerms: z.array(z.string()),
  /** The claim's numbers, dates and codes (canonical form) that no cited text states. */
  missingNumbers: z.array(z.string()),
  negationMismatch: z.boolean(),
  /** Cites that name nothing in that search (or in the knowledge base), with the reason. */
  badLabels: z.array(BadLabelSchema),
  /** The good cites, resolved. */
  cites: z.array(ResolvedCiteSchema),
});
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

export const SummarySchema = z.object({
  supported: z.number().int(),
  partial: z.number().int(),
  unsupported: z.number().int(),
  uncited: z.number().int(),
  bad_citation: z.number().int(),
  /** "4 supported, 1 partial, 1 unsupported": the non-zero counts in verdict order. */
  text: z.string(),
});
export type Summary = z.infer<typeof SummarySchema>;

/** One cited text: a passage (heading path plus content) or a fact (predicate plus object). */
export interface CitedText {
  label: string;
  kind: "passage" | "fact";
  text: string;
}

/** A passage's cited text: its heading path joined with " > ", then its content. */
export function passageText(headingPath: string[], content: string): string {
  return [headingPath.join(" > "), content].filter((s) => s.trim() !== "").join("\n");
}

/** A fact's cited text: "visa status: F-1 OPT". */
export function factText(predicate: string, objectText: string): string {
  return `${predicate.replace(/_/g, " ")}: ${objectText}`;
}

/** [P1], [F2], [P1, F2] and [P1][F2], case-insensitive. */
export const LABEL_GROUP_RE = /\[\s*[PF]\d+(?:\s*[,;]\s*[PF]\d+)*\s*\]/gi;

/** The claim without its citation labels, with the space a label leaves before punctuation removed. */
export function stripLabels(text: string): string {
  return text.replace(LABEL_GROUP_RE, " ").replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim();
}

/** Every string checkClaim will look up in the stem map: the claim's words and the cited texts' sentences. */
export function stemInputs(claimText: string, cited: CitedText[]): string[] {
  const { rest } = extractNumbers(stripLabels(claimText));
  return [...claimWords(rest).map((w) => w.stemKey), ...cited.flatMap((c) => splitSentences(c.text))];
}

export interface ClaimCheck {
  /** Number of content terms in the claim. */
  termCount: number;
  /** Null when termCount is 0. Unrounded. */
  support: number | null;
  matchedTerms: string[];
  missingTerms: string[];
  /** Number of numbers, dates and codes in the claim. */
  numberCount: number;
  missingNumbers: string[];
  negationMismatch: boolean;
}

function lexemesOf(stems: StemMap, text: string): string[] {
  const l = stems.get(text);
  if (!l) throw new Error(`no stems for ${JSON.stringify(text)}; build the map from stemInputs`);
  return l;
}

/** Compares one claim with its cited texts. `stems` must hold every string stemInputs(claimText, cited) returns. */
export function checkClaim(claimText: string, cited: CitedText[], stems: StemMap): ClaimCheck {
  const claim = stripLabels(claimText);
  const { values: numbers, rest } = extractNumbers(claim);

  // Content terms in first-seen order, each shown as the first claim word that produced it.
  const word = new Map<string, string>();
  for (const w of claimWords(rest)) {
    for (const lexeme of lexemesOf(stems, w.stemKey)) if (isContentLexeme(lexeme) && !word.has(lexeme)) word.set(lexeme, w.display);
  }

  const sentences = cited.flatMap((c) => splitSentences(c.text)).map((s) => ({ text: s, lexemes: new Set(lexemesOf(stems, s)) }));
  const citedStems = new Set(sentences.flatMap((s) => [...s.lexemes]));
  const matched = [...word.keys()].filter((l) => citedStems.has(l));
  const missing = [...word.keys()].filter((l) => !citedStems.has(l));

  const citedNumbers = citedNumberSet(cited.flatMap((c) => extractNumbers(c.text).values));
  const missingNumbers = [...new Set(numbers)].filter((n) => !citedNumbers.has(n));

  const matchedSet = new Set(matched);
  const citedNegates = sentences.some((s) => hasNegation(s.text) && [...s.lexemes].some((l) => matchedSet.has(l)));

  return {
    termCount: word.size,
    support: word.size === 0 ? null : matched.length / word.size,
    matchedTerms: [...new Set(matched.map((l) => word.get(l)!))],
    missingTerms: [...new Set(missing.map((l) => word.get(l)!))],
    numberCount: numbers.length,
    missingNumbers,
    negationMismatch: hasNegation(claim) !== citedNegates,
  };
}

/**
 * The verdict, from the first rule that applies:
 *  1. no good cite: bad_citation if any cite was given (all of them bad), else uncited;
 *  2. no content terms (e.g. "Yes."): supported if it has no numbers and no negation mismatch; partial if it has
 *     numbers and the cited texts state all of them, or a negation mismatch; unsupported if a number is missing;
 *  3. support < PARTIAL_MIN: unsupported (a missing number or a negation mismatch never raises a verdict);
 *  4. support ≥ SUPPORTED_MIN, no missing number, no negation mismatch: supported;
 *  5. otherwise partial.
 */
export function verdictOf(check: ClaimCheck, goodCites: number, badCites: number): Verdict {
  if (goodCites === 0) return badCites > 0 ? "bad_citation" : "uncited";
  if (check.support === null) {
    if (check.numberCount === 0) return check.negationMismatch ? "partial" : "supported";
    return check.missingNumbers.length === 0 ? "partial" : "unsupported";
  }
  if (check.support < PARTIAL_MIN) return "unsupported";
  if (check.support >= SUPPORTED_MIN && check.missingNumbers.length === 0 && !check.negationMismatch) return "supported";
  return "partial";
}

/** One claim ready to judge: its text, its normalised labels, the good cites' texts and resolutions, and the bad ones. */
export interface ClaimToJudge {
  text: string;
  labels: string[];
  cited: CitedText[];
  cites: ResolvedCite[];
  badLabels: BadLabel[];
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Judges one claim. Pure: `stems` must hold every string stemInputs(claim.text, claim.cited) returns. */
export function judge(claim: ClaimToJudge, stems: StemMap): ClaimResult {
  const empty: ClaimCheck = { termCount: 0, support: null, matchedTerms: [], missingTerms: [], numberCount: 0, missingNumbers: [], negationMismatch: false };
  const check = claim.cited.length ? checkClaim(claim.text, claim.cited, stems) : empty;
  return {
    claim: stripLabels(claim.text),
    labels: claim.labels,
    verdict: verdictOf(check, claim.cited.length, claim.badLabels.length),
    support: check.support === null ? null : round3(check.support),
    matchedTerms: check.matchedTerms,
    missingTerms: check.missingTerms,
    missingNumbers: check.missingNumbers,
    negationMismatch: check.negationMismatch,
    badLabels: claim.badLabels,
    cites: claim.cites,
  };
}

/** Judges every claim with one stem query for all of them. */
export async function verifyTexts(sql: Db, claims: ClaimToJudge[]): Promise<ClaimResult[]> {
  const stems = await stemAll(sql, claims.flatMap((c) => (c.cited.length ? stemInputs(c.text, c.cited) : [])));
  return claims.map((c) => judge(c, stems));
}

const SUMMARY_WORDS: Record<Verdict, string> = { supported: "supported", partial: "partial", unsupported: "unsupported", uncited: "uncited", bad_citation: "bad citation" };

/** Counts per verdict and the one-line text ("4 supported, 1 partial, 1 unsupported"; "no claims" when empty). */
export function summarizeVerdicts(results: Pick<ClaimResult, "verdict">[]): Summary {
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, results.filter((r) => r.verdict === v).length])) as Record<Verdict, number>;
  const text = VERDICTS.filter((v) => counts[v] > 0).map((v) => `${counts[v]} ${SUMMARY_WORDS[v]}`).join(", ") || "no claims";
  return { ...counts, text };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/verify.test.ts`
Expected: PASS (27 tests).

- [ ] **Step 5: Typecheck and the unit suite**

Run: `npm run typecheck && npm run test:unit`
Expected: all green (342 tests). Nothing outside `src/verify/` imports the file yet, so the integration suite is not needed here.

- [ ] **Step 6: Commit**

```bash
git add src/verify/verify.ts test/unit/verify.test.ts
git commit -m "Verifier method: support over Postgres stems, every number present, negation agrees; verdicts with fixed thresholds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 012: `retrieval_log.facts` and `brain.verification_log`

**Files:**
- Create: `supabase/migrations/20261003000012_verification_log.sql`
- Create: `test/integration/verification-log.test.ts`
- Modify: `src/retrieve/search.ts` (log `facts`)
- Modify: `test/integration/helpers.ts` (`wipe` truncates `verification_log`)
- Modify: `test/integration/retrieval-log.test.ts` (count migration 011's checks by name)

`brain.retrieval_log` (migrations 002 and 011) stores each search's passages in `results` but not its facts, so an `F1` cannot be resolved once the search is over. The migration adds `facts jsonb` (null on older rows, with a check that it is an array) and creates `brain.verification_log`: `id uuid primary key default gen_random_uuid()`, `retrieval_id uuid not null`, `client text not null`, `claims`, `results` (arrays) and `summary` (an object) as jsonb, `created_at`; indexes on `retrieval_id` and `created_at desc`; row level security on, like every brain table. There is deliberately no foreign key to `retrieval_log`, so an audit row survives any later cleanup of the search log (and `wipe`'s `truncate brain.retrieval_log` keeps working). `search()` then writes `facts` with every search: the facts it returned, in order (index 0 is F1), and `[]` when facts are off.

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/verification-log.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("migration 012: retrieval_log.facts and brain.verification_log", () => {
  it("adds the facts column and the verification_log table with its indexes, checks and row level security, and re-applies cleanly", async () => {
    const [col] = await sql<{ data_type: string }[]>`
      select data_type from information_schema.columns where table_schema = 'brain' and table_name = 'retrieval_log' and column_name = 'facts'`;
    expect(col.data_type).toBe("jsonb");
    const cols = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'brain' and table_name = 'verification_log' order by ordinal_position`;
    expect(cols).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "retrieval_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "client", data_type: "text", is_nullable: "NO" },
      { column_name: "claims", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "results", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "summary", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);
    const idx = await sql<{ indexname: string }[]>`select indexname from pg_indexes where schemaname = 'brain' and tablename = 'verification_log' order by indexname`;
    expect(idx.map((i) => i.indexname)).toEqual(["verification_log_created_at", "verification_log_pkey", "verification_log_retrieval_id"]);
    const [rls] = await sql<{ relrowsecurity: boolean }[]>`select relrowsecurity from pg_class where oid = 'brain.verification_log'::regclass`;
    expect(rls.relrowsecurity).toBe(true);
    await expect(sql`insert into brain.retrieval_log (query, facts) values ('q', '{}'::jsonb)`).rejects.toThrow(/retrieval_log_facts_check/);
    await expect(sql`
      insert into brain.verification_log (retrieval_id, client, claims, results, summary)
      values (gen_random_uuid(), 'test', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)`).rejects.toThrow(/verification_log_claims_check/);
    const file = await readFile(new URL("../../supabase/migrations/20261003000012_verification_log.sql", import.meta.url), "utf8");
    const conn = await sql.reserve();
    try {
      await conn.unsafe(file);
      await conn.unsafe(file);
    } finally {
      conn.release();
    }
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_constraint where conrelid = 'brain.retrieval_log'::regclass and conname = 'retrieval_log_facts_check'`;
    expect(n).toBe(1);
  });

  it("search logs the facts it returned, in order, so F1 is the first one", async () => {
    const ctx = fakeCtx(sql, ({ system }) =>
      system === SUMMARY_SYSTEM
        ? { title: "T", summary_line: "L", summary: "S", occurred_at: null }
        : { entities: [], relations: [], facts_about_self: [{ predicate: "visa_status", object_text: "F-1 OPT", object_key: null, confidence: 1, valid_from: null, valid_to: null, quote: "F-1 OPT" }] });
    await ingest(ctx, { text: "I am on F-1 OPT and looking for a visa sponsor.", sourceKind: "note" });
    const res = await search(ctx, "visa status", { k: 3 });
    expect(res.facts.length).toBe(1);
    const [row] = await sql<{ facts: unknown }[]>`select facts from brain.retrieval_log where id = ${res.retrievalId}`;
    expect(row.facts).toEqual(res.facts);
    const none = await search(ctx, "visa status", { k: 3, includeFacts: false });
    const [empty] = await sql<{ facts: unknown }[]>`select facts from brain.retrieval_log where id = ${none.retrievalId}`;
    expect(empty.facts).toEqual([]);
  });

  it("wipe empties verification_log", async () => {
    await sql`
      insert into brain.verification_log (retrieval_id, client, claims, results, summary)
      values (gen_random_uuid(), 'test', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`;
    await wipe(sql);
    expect((await sql`select id from brain.verification_log`).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/verification-log.test.ts`
Expected: FAIL, 3 tests: `TypeError: Cannot read properties of undefined (reading 'data_type')` (no `facts` column), `PostgresError: column "facts" does not exist`, and `PostgresError: relation "brain.verification_log" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261003000012_verification_log.sql`:
```sql
-- Phase 5: deterministic citation verification (spec §7).
-- 1. brain.retrieval_log.facts: the facts each search returned, in order (index 0 is F1), so brain_verify can resolve
--    F labels exactly as the search showed them. Rows logged before this migration have it null; their F labels
--    are reported as bad citations, with that reason.
-- 2. brain.verification_log: one row per brain_verify call (and per `brain verify` and `brain ask`): the claims as
--    given, each claim's verdict and evidence, and the summary. No foreign key to retrieval_log, so an audit row
--    outlives any later cleanup of the search log.
-- Idempotent: safe to apply more than once.

begin;

alter table brain.retrieval_log add column if not exists facts jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'retrieval_log_facts_check' and conrelid = 'brain.retrieval_log'::regclass) then
    alter table brain.retrieval_log
      add constraint retrieval_log_facts_check check (facts is null or jsonb_typeof(facts) = 'array');
  end if;
end $$;

comment on column brain.retrieval_log.facts is
  'Phase 5: the facts the search returned, in order (index 0 is F1): id, predicate, objectText, confidence, verified, verifiedBy, sourceChunkId, sourceDocumentId, sourceKind. Null on rows logged before migration 012.';

create table if not exists brain.verification_log (
  id uuid primary key default gen_random_uuid(),
  retrieval_id uuid not null,
  client text not null,
  claims jsonb not null check (jsonb_typeof(claims) = 'array'),
  results jsonb not null check (jsonb_typeof(results) = 'array'),
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists verification_log_retrieval_id on brain.verification_log (retrieval_id);
create index if not exists verification_log_created_at on brain.verification_log (created_at desc);
alter table brain.verification_log enable row level security;

comment on table brain.verification_log is
  'Phase 5: one row per citation check. claims: [{text, cites}] as given. results: per claim, verdict, support, matchedTerms, missingTerms, missingNumbers, negationMismatch, badLabels and the resolved cites. summary: counts per verdict and the one-line text.';

commit;
```

- [ ] **Step 4: `search()` logs the facts it returned**

In `src/retrieve/search.ts`, replace:
```ts
  // The v1 columns stay filled for compatibility; results, degraded, candidates, timings, k and mode are v2 (spec §6.2).
```
with:
```ts
  // The v1 columns stay filled for compatibility; results, degraded, candidates, timings, k and mode are v2 (spec §6.2);
  // facts (migration 012) lets brain_verify resolve F labels as this search showed them.
```

In `src/retrieve/search.ts`, replace:
```ts
      (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client, results, degraded, candidates, timings, k, mode)
```
with:
```ts
      (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client, results, degraded, candidates, timings, k, mode, facts)
```

In `src/retrieve/search.ts`, replace:
```ts
            ${json(toLoggedPassages(passages))}, ${json(degraded)}, ${json(candidates)}, ${json(timings)}, ${k}, ${mode})
```
with:
```ts
            ${json(toLoggedPassages(passages))}, ${json(degraded)}, ${json(candidates)}, ${json(timings)}, ${k}, ${mode}, ${json(facts)})
```

- [ ] **Step 5: `wipe` empties the audit table**

In `test/integration/helpers.ts`, replace:
```ts
  await sql`truncate brain.retrieval_log`;
```
with:
```ts
  await sql`truncate brain.retrieval_log`;
  await sql`truncate brain.verification_log`;
```

- [ ] **Step 6: Keep migration 011's test about migration 011**

`test/integration/retrieval-log.test.ts` counts constraints named `retrieval_log_%_check` and expects 2; migration 012 adds a third (`retrieval_log_facts_check`). Count 011's two by name instead.

In `test/integration/retrieval-log.test.ts`, replace:
```ts
      select count(*)::int as n from pg_constraint where conrelid = 'brain.retrieval_log'::regclass and conname like 'retrieval_log_%_check'`;
```
with:
```ts
      select count(*)::int as n from pg_constraint
      where conrelid = 'brain.retrieval_log'::regclass and conname in ('retrieval_log_mode_check', 'retrieval_log_results_check')`;
```

- [ ] **Step 7: Run the tests**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/verification-log.test.ts test/integration/retrieval-log.test.ts`
Expected: PASS (3 + 2 tests). The first test also applies the file twice on one reserved connection, which proves it is idempotent.

- [ ] **Step 8: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green (unit 342, integration 292).

- [ ] **Step 9: Apply to the eval database, then run the eval**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20261003000012_verification_log.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20261003000012_verification_log.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "
select (select data_type from information_schema.columns where table_schema = 'brain' and table_name = 'retrieval_log' and column_name = 'facts') as facts,
       (select count(*) from information_schema.columns where table_schema = 'brain' and table_name = 'verification_log') as verification_log_columns,
       (select count(*) from pg_indexes where schemaname = 'brain' and tablename = 'verification_log') as indexes"
npm run eval:run
```
Expected: the first run prints `BEGIN`, `ALTER TABLE`, `DO`, `COMMENT`, `CREATE TABLE`, `CREATE INDEX`, `CREATE INDEX`, `ALTER TABLE`, `COMMENT`, `COMMIT`; the second the same with `NOTICE: … already exists, skipping` for the column, the table and both indexes; the query prints `jsonb | 7 | 3`. If `brain_eval` does not exist, run `npm run eval:prepare` first (it applies every migration, 012 included). The eval then runs as before: the same per-question ranks, `vs baseline  recall@10 +0.000  mrr +0.000` and no `worse` lines (this task changes what is logged, not what is ranked).

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/20261003000012_verification_log.sql test/integration/verification-log.test.ts src/retrieve/search.ts test/integration/helpers.ts test/integration/retrieval-log.test.ts
git commit -m "Migration 012: retrieval_log.facts (F labels resolvable after the search) and brain.verification_log; search logs its facts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Resolve cites through the log; `verifyClaims` writes the audit row

**Files:**
- Create: `src/verify/resolve.ts`
- Create: `test/integration/verify.test.ts`

`verifyClaims(sql, retrievalId, claims, { client })` validates the claims (at most 50, each at most 2,000 characters with at most 20 cites; one place enforces the limits for MCP, the CLI and `ask`), reads the `retrieval_log` row with `to_jsonb` (so it works on rows logged before migrations 011 and 012), resolves each cite, judges every claim with one stem query, writes one `brain.verification_log` row, and returns the verification with its `verificationId`. Null means the retrieval id is not a UUID or names no logged search (the caller reuses Phase 4's `explainNotFound` message).

Cites: `P3` (any case, brackets allowed) is `results[2]`; its text is read from `brain.chunks` by chunk id (content plus heading path), or, for a fallback passage, cut from `documents.raw_content` with the logged `charStart`/`charEnd`. `F1` is `facts[0]` exactly as the search returned it. A UUID is looked up as a chunk, then as a fact. Anything else, or a label out of range, a passage deleted since, or a label on a row logged before its column existed, is a bad label with a reason; retrieval-level reasons also go into `notes`. Duplicate cites within a claim count once. The lookups run only when needed: chunks (with any raw ids), fallback documents, facts by raw id.

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/verify.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";
import { verifyClaims, parseCite, NOTE_NO_FACTS, NOTE_NO_RESULTS } from "../../src/verify/resolve.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const visaFact = { predicate: "visa_status", object_text: "F-1 OPT", object_key: null, confidence: 1, valid_from: null, valid_to: null, quote: "I am on F-1 OPT" };
const handler = ({ system, user }: { system: string; user: string }) =>
  system === SUMMARY_SYSTEM
    ? { title: "Untitled", summary_line: "A note.", summary: "A note.", occurred_at: null }
    : { entities: [], relations: [], facts_about_self: user.includes("F-1 OPT") ? [visaFact] : [] };

async function seed() {
  const ctx = fakeCtx(sql, handler);
  await ingest(ctx, { text: "Acme Corp sponsors H-1B visas for analysts. Base salary is $115,000 to $140,000. I am on F-1 OPT.", sourceKind: "note", title: "Acme visa note" });
  await ingest(ctx, { text: "Gardening notes: tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
  return ctx;
}

describe("parseCite", () => {
  it("normalises labels and ids and rejects anything else", () => {
    expect(parseCite(" [p3] ")).toEqual({ kind: "P", index: 2, label: "P3" });
    expect(parseCite("F01")).toEqual({ kind: "F", index: 0, label: "F1" });
    expect(parseCite("0E2F1C3A-0000-4000-8000-000000000001")).toEqual({ kind: "id", id: "0e2f1c3a-0000-4000-8000-000000000001", label: "0e2f1c3a-0000-4000-8000-000000000001" });
    expect(parseCite("doc 7")).toEqual({ kind: "invalid", label: "doc 7" });
  });
});

describe("verifyClaims", () => {
  it("resolves P and F labels through the logged search, judges each claim, and writes one audit row", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Acme visa sponsorship salary F-1 OPT", { k: 3, client: "test" });
    const p1 = res.passages[0];
    expect(p1.title).toBe("Acme visa note");
    expect(res.facts.map((f) => f.predicate)).toEqual(["visa_status"]);

    const v = (await verifyClaims(sql, res.retrievalId, [
      { text: "Acme Corp sponsors H-1B visas for analysts [P1].", cites: ["P1"] },
      { text: "Acme pays $150,000.", cites: ["p1"] },
      { text: "Acme was founded by astronauts on the moon.", cites: ["P1"] },
      { text: "My visa status is F-1 OPT.", cites: ["F1"] },
      { text: "Acme sponsors visas.", cites: ["P99"] },
      { text: "I think Acme is a good fit.", cites: [] },
      { text: "Acme sponsors H-1B visas.", cites: [p1.chunkId!, "P1", "nonsense"] },
      { text: "My visa status is F-1 OPT.", cites: [res.facts[0].id] },
    ], { client: "test" }))!;

    expect(v.retrievalId).toBe(res.retrievalId);
    expect(v.claims.map((c) => c.verdict)).toEqual(["supported", "partial", "unsupported", "supported", "bad_citation", "uncited", "supported", "supported"]);
    expect(v.claims[0]).toMatchObject({ claim: "Acme Corp sponsors H-1B visas for analysts.", labels: ["P1"], support: 1, missingNumbers: [] });
    expect(v.claims[0].cites).toEqual([{ label: "P1", kind: "passage", documentId: p1.documentId, chunkId: p1.chunkId, factId: null, title: "Acme visa note" }]);
    expect(v.claims[1]).toMatchObject({ labels: ["P1"], missingNumbers: ["$150000"] });
    expect(v.claims[2].missingTerms).toEqual(expect.arrayContaining(["founded", "astronauts", "moon"]));
    expect(v.claims[3].cites).toEqual([{ label: "F1", kind: "fact", documentId: p1.documentId, chunkId: null, factId: res.facts[0].id, title: "visa_status: F-1 OPT" }]);
    expect(v.claims[4].badLabels).toEqual([{ label: "P99", reason: `no P99 in this search (it returned ${res.passages.length} passage${res.passages.length === 1 ? "" : "s"})` }]);
    expect(v.claims[6]).toMatchObject({ labels: [p1.chunkId, "P1", "nonsense"], badLabels: [{ label: "nonsense", reason: "not a label (P1, F1) or a passage or fact id" }] });
    expect(v.claims[7].cites[0]).toMatchObject({ kind: "fact", factId: res.facts[0].id });
    expect(v.summary).toEqual({ supported: 4, partial: 1, unsupported: 1, uncited: 1, bad_citation: 1, text: "4 supported, 1 partial, 1 unsupported, 1 uncited, 1 bad citation" });
    expect(v.notes).toEqual([]);

    const rows = await sql<{ id: string; retrieval_id: string; client: string; claims: unknown; results: unknown; summary: unknown }[]>`
      select id, retrieval_id, client, claims, results, summary from brain.verification_log`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: v.verificationId, retrieval_id: res.retrievalId, client: "test", results: v.claims, summary: v.summary });
    expect((rows[0].claims as { text: string }[])[1]).toEqual({ text: "Acme pays $150,000.", cites: ["p1"] });
  });

  it("rebuilds a fallback passage from its document's raw text and character window", async () => {
    const ctx = await seed();
    ctx.reranker = { rerank: async (_q: string, docs: string[], k: number) => docs.slice(0, k).map((_d, index) => ({ index, score: 0.01 })) };
    const res = await search(ctx, "H-1B", { k: 3 });
    const i = res.passages.findIndex((p) => p.chunkId === null);
    expect(i).toBeGreaterThanOrEqual(0);
    const label = `P${i + 1}`;
    const v = (await verifyClaims(sql, res.retrievalId, [{ text: "Acme Corp sponsors H-1B visas.", cites: [label] }], { client: "test" }))!;
    expect(v.claims[0]).toMatchObject({ verdict: "supported", cites: [{ label, kind: "passage", chunkId: null, documentId: res.passages[i].documentId }] });
  });

  it("reports labels it cannot resolve: a passage no longer stored, and searches logged before facts or passages were recorded", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Acme visa F-1 OPT", { k: 3 });
    await sql`update brain.retrieval_log set facts = null where id = ${res.retrievalId}`;
    const noFacts = (await verifyClaims(sql, res.retrievalId, [{ text: "My visa status is F-1 OPT.", cites: ["F1"] }], { client: "test" }))!;
    expect(noFacts.claims[0]).toMatchObject({ verdict: "bad_citation", badLabels: [{ label: "F1", reason: "facts were not logged for this search (before migration 012)" }] });
    expect(noFacts.notes).toEqual([NOTE_NO_FACTS]);

    const [old] = await sql<{ id: string }[]>`
      insert into brain.retrieval_log (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client)
      values ('old', '{}'::jsonb, '{hybrid}', '{}'::uuid[], '{}'::uuid[], 0.5, false, 'cli') returning id`;
    const v1 = (await verifyClaims(sql, old.id, [{ text: "Acme sponsors visas.", cites: ["P1", "F1", res.passages[0].chunkId!] }], { client: "test" }))!;
    expect(v1.claims[0].verdict).toBe("supported");
    expect(v1.claims[0].badLabels.map((b) => b.label)).toEqual(["P1", "F1"]);
    expect(v1.notes).toEqual([NOTE_NO_RESULTS, NOTE_NO_FACTS]);

    await sql`delete from brain.chunks where id = ${res.passages[0].chunkId}`;
    const gone = (await verifyClaims(sql, res.retrievalId, [{ text: "Acme sponsors visas.", cites: ["P1"] }], { client: "test" }))!;
    expect(gone.claims[0]).toMatchObject({ verdict: "bad_citation", badLabels: [{ label: "P1", reason: "P1's passage is no longer stored (its document was re-chunked or deleted)" }] });
  });

  it("returns null for an unknown or malformed retrieval id and writes nothing", async () => {
    expect(await verifyClaims(sql, "00000000-0000-0000-0000-000000000000", [{ text: "x", cites: [] }], { client: "test" })).toBeNull();
    expect(await verifyClaims(sql, "not-an-id", [{ text: "x", cites: [] }], { client: "test" })).toBeNull();
    expect((await sql`select id from brain.verification_log`).length).toBe(0);
  });

  it("refuses no claims, more than 50 claims, a claim over 2,000 characters, and more than 20 cites", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    await expect(verifyClaims(sql, id, [], { client: "test" })).rejects.toThrow("claims: Too small: expected array to have >=1 items");
    await expect(verifyClaims(sql, id, Array.from({ length: 51 }, () => ({ text: "x", cites: [] })), { client: "test" })).rejects.toThrow("claims: Too big: expected array to have <=50 items");
    await expect(verifyClaims(sql, id, [{ text: "x".repeat(2001), cites: [] }], { client: "test" })).rejects.toThrow("claims.0.text: Too big: expected string to have <=2000 characters");
    await expect(verifyClaims(sql, id, [{ text: "x", cites: Array.from({ length: 21 }, (_, i) => `P${i + 1}`) }], { client: "test" })).rejects.toThrow("claims.0.cites: Too big: expected array to have <=20 items");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/verify.test.ts`
Expected: FAIL: `Error: Cannot find module '../../src/verify/resolve.js' imported from …/test/integration/verify.test.ts`, `Tests no tests`.

- [ ] **Step 3: Write `src/verify/resolve.ts`**

Create `src/verify/resolve.ts`:
```ts
import { z } from "zod";
import type postgres from "postgres";
import type { Db } from "../db.js";
import { UUID } from "../retrieve/documents.js";
import { FactRowSchema, LoggedPassageSchema, type FactRow, type LoggedPassage } from "../retrieve/contract.js";
import {
  ClaimResultSchema, SummarySchema, factText, passageText, summarizeVerdicts, verifyTexts,
  type BadLabel, type CitedText, type ClaimToJudge, type ResolvedCite,
} from "./verify.js";

/**
 * brain_verify end to end (spec §7.1): resolve each claim's cites through the logged search, load the cited texts,
 * judge every claim (verify.ts), write one audit row to brain.verification_log, and return the verification.
 * Round trips: the retrieval_log row, the cited chunks (with any raw ids), fallback documents, facts named by raw id,
 * one stem query for everything, and the audit insert; each lookup is skipped when nothing needs it.
 */

export const MAX_CLAIMS = 50;
export const MAX_CLAIM_CHARS = 2000;
export const MAX_CITES = 20;

export const ClaimInputSchema = z.object({
  text: z.string().trim().min(1).max(MAX_CLAIM_CHARS).describe("One claim of the answer, as written (labels inside it are ignored)"),
  cites: z
    .array(z.string().trim().min(1).max(100))
    .max(MAX_CITES)
    .describe("What the claim cites: P1, F2 (labels from that brain_search result), or a chunk or fact id; [] for a claim of your own"),
});
export type ClaimInput = z.infer<typeof ClaimInputSchema>;

export const ClaimsSchema = z.array(ClaimInputSchema).min(1).max(MAX_CLAIMS);

export const VerificationSchema = z.object({
  /** brain.verification_log id. */
  verificationId: z.string(),
  retrievalId: z.string(),
  claims: z.array(ClaimResultSchema),
  summary: SummarySchema,
  /** Notes about the search as a whole, e.g. that it was logged before facts were recorded. */
  notes: z.array(z.string()),
});
export type Verification = z.infer<typeof VerificationSchema>;

export type ParsedCite =
  | { kind: "P" | "F"; index: number; label: string }
  | { kind: "id"; id: string; label: string }
  | { kind: "invalid"; label: string };

/** P3, p3 and [P3] are P3 (index 2); F1 likewise; a UUID is a chunk or fact id; anything else is invalid. */
export function parseCite(raw: string): ParsedCite {
  const s = raw.trim().replace(/^\[\s*/, "").replace(/\s*\]$/, "");
  const m = /^([PF])(\d+)$/i.exec(s);
  if (m) {
    const kind = m[1].toUpperCase() as "P" | "F";
    return { kind, index: Number(m[2]) - 1, label: `${kind}${Number(m[2])}` };
  }
  if (UUID.test(s)) return { kind: "id", id: s.toLowerCase(), label: s.toLowerCase() };
  return { kind: "invalid", label: s };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const NOTE_NO_RESULTS =
  "This search was logged before evidence v2 (migration 011), so its P labels cannot be resolved; cite chunk ids instead.";
export const NOTE_NO_FACTS =
  "This search was logged before migration 012, which records the facts a search returned, so its F labels cannot be resolved; cite fact ids instead.";

interface LoggedRetrieval {
  id: string;
  /** Null for a row logged before migration 011. */
  results: LoggedPassage[] | null;
  /** Null for a row logged before migration 012. */
  facts: FactRow[] | null;
}

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);
const LogRowSchema = z.object({ id: z.string(), results: nullable(z.array(LoggedPassageSchema)), facts: nullable(z.array(FactRowSchema)) });

/** One retrieval_log row; to_jsonb reads whichever columns exist, so this works before migrations 011 and 012 too. */
async function loadRetrieval(sql: Db, retrievalId: string): Promise<LoggedRetrieval | null> {
  if (!UUID.test(retrievalId)) return null;
  const [row] = await sql<{ r: unknown }[]>`select to_jsonb(l) as r from brain.retrieval_log l where l.id = ${retrievalId}`;
  return row ? LogRowSchema.parse(row.r) : null;
}

interface ChunkText { id: string; document_id: string; heading_path: string[]; content: string; title: string | null }
interface FactText { id: string; predicate: string; object_text: string; document_id: string | null }

/** Resolves every claim's cites to cited texts (good) or reasons (bad), with as few lookups as the cites need. */
async function resolveClaims(sql: Db, retrieval: LoggedRetrieval, claims: ClaimInput[]): Promise<{ toJudge: ClaimToJudge[]; notes: string[] }> {
  const parsed = claims.map((c) => {
    const seen = new Set<string>();
    return c.cites.map(parseCite).filter((p) => (seen.has(p.label) ? false : (seen.add(p.label), true)));
  });
  const passageAt = (p: ParsedCite) => (p.kind === "P" && retrieval.results ? retrieval.results[p.index] : undefined);

  const chunkIds = new Set<string>();
  const fallbackDocIds = new Set<string>();
  const rawIds = new Set<string>();
  for (const p of parsed.flat()) {
    const logged = passageAt(p);
    if (logged) logged.chunkId ? chunkIds.add(logged.chunkId) : fallbackDocIds.add(logged.documentId);
    if (p.kind === "id") rawIds.add(p.id);
  }

  const lookupChunks = [...new Set([...chunkIds, ...rawIds])];
  const chunks = new Map<string, ChunkText>();
  if (lookupChunks.length) {
    for (const c of await sql<ChunkText[]>`
      select c.id, c.document_id, c.heading_path, c.content, d.title
      from brain.chunks c join brain.documents d on d.id = c.document_id
      where c.id = any(${lookupChunks}::uuid[])`) chunks.set(c.id, c);
  }
  const raws = new Map<string, string>();
  if (fallbackDocIds.size) {
    for (const d of await sql<{ id: string; raw_content: string }[]>`
      select id, raw_content from brain.documents where id = any(${[...fallbackDocIds]}::uuid[])`) raws.set(d.id, d.raw_content);
  }
  const factIds = [...rawIds].filter((id) => !chunks.has(id));
  const facts = new Map<string, FactText>();
  if (factIds.length) {
    for (const f of await sql<FactText[]>`
      select f.id, f.predicate, f.object_text, c.document_id
      from brain.facts f left join brain.chunks c on c.id = f.source_chunk_id
      where f.id = any(${factIds}::uuid[])`) facts.set(f.id, f);
  }

  const notes = new Set<string>();
  const toJudge = claims.map((claim, i): ClaimToJudge => {
    const cited: CitedText[] = [];
    const cites: ResolvedCite[] = [];
    const badLabels: BadLabel[] = [];
    const bad = (label: string, reason: string) => badLabels.push({ label, reason });
    const passage = (label: string, documentId: string, chunkId: string | null, title: string | null, text: string) => {
      cited.push({ label, kind: "passage", text });
      cites.push({ label, kind: "passage", documentId, chunkId, factId: null, title });
    };
    const fact = (label: string, id: string, predicate: string, objectText: string, documentId: string | null) => {
      cited.push({ label, kind: "fact", text: factText(predicate, objectText) });
      cites.push({ label, kind: "fact", documentId, chunkId: null, factId: id, title: `${predicate}: ${objectText}` });
    };
    for (const p of parsed[i]) {
      if (p.kind === "P") {
        if (!retrieval.results) { notes.add(NOTE_NO_RESULTS); bad(p.label, "passages were not logged for this search (before migration 011)"); continue; }
        const logged = retrieval.results[p.index];
        if (!logged) { bad(p.label, `no ${p.label} in this search (it returned ${plural(retrieval.results.length, "passage")})`); continue; }
        if (logged.chunkId) {
          const c = chunks.get(logged.chunkId);
          if (!c) { bad(p.label, `${p.label}'s passage is no longer stored (its document was re-chunked or deleted)`); continue; }
          passage(p.label, logged.documentId, logged.chunkId, logged.title, passageText(c.heading_path, c.content));
        } else {
          // A fallback passage is a window of the raw document; JS slices UTF-16 units exactly as search() cut it.
          const raw = raws.get(logged.documentId);
          if (raw === undefined) { bad(p.label, `${p.label}'s document is no longer stored`); continue; }
          passage(p.label, logged.documentId, null, logged.title, raw.slice(logged.charStart, logged.charEnd));
        }
      } else if (p.kind === "F") {
        if (!retrieval.facts) { notes.add(NOTE_NO_FACTS); bad(p.label, "facts were not logged for this search (before migration 012)"); continue; }
        const f = retrieval.facts[p.index];
        if (!f) { bad(p.label, `no ${p.label} in this search (it returned ${plural(retrieval.facts.length, "fact")})`); continue; }
        // The fact as the search showed it, even if it has been superseded since.
        fact(p.label, f.id, f.predicate, f.objectText, f.sourceDocumentId);
      } else if (p.kind === "id") {
        const c = chunks.get(p.id);
        const f = facts.get(p.id);
        if (c) passage(p.label, c.document_id, c.id, c.title, passageText(c.heading_path, c.content));
        else if (f) fact(p.label, f.id, f.predicate, f.object_text, f.document_id);
        else bad(p.label, "no passage or fact has this id");
      } else {
        bad(p.label, "not a label (P1, F1) or a passage or fact id");
      }
    }
    return { text: claim.text, labels: parsed[i].map((p) => p.label), cited, cites, badLabels };
  });
  return { toJudge, notes: [...notes] };
}

/**
 * Checks claims against what they cite in one logged search, writes one brain.verification_log row, and returns the
 * verification. Null when the retrieval id is not a UUID or names no logged search. Throws on invalid claims (empty,
 * more than MAX_CLAIMS, a claim over MAX_CLAIM_CHARS characters, more than MAX_CITES cites).
 */
export async function verifyClaims(sql: Db, retrievalId: string, claims: ClaimInput[], opts: { client: string }): Promise<Verification | null> {
  const parsed = ClaimsSchema.safeParse(claims);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((x) => (x.path.length ? `claims.${x.path.join(".")}: ${x.message}` : `claims: ${x.message}`));
    throw new Error(`Invalid claims (at most ${MAX_CLAIMS} claims of at most ${MAX_CLAIM_CHARS} characters, ${MAX_CITES} cites each): ${issues.join("; ")}`);
  }
  const retrieval = await loadRetrieval(sql, retrievalId);
  if (!retrieval) return null;
  const { toJudge, notes } = await resolveClaims(sql, retrieval, parsed.data);
  const results = await verifyTexts(sql, toJudge);
  const summary = summarizeVerdicts(results);
  const json = (v: unknown) => sql.json(v as postgres.JSONValue);
  const [row] = await sql<{ id: string }[]>`
    insert into brain.verification_log (retrieval_id, client, claims, results, summary)
    values (${retrieval.id}, ${opts.client}, ${json(parsed.data)}, ${json(results)}, ${json(summary)})
    returning id`;
  return { verificationId: row.id, retrievalId: retrieval.id, claims: results, summary, notes };
}
```

- [ ] **Step 4: Run the test**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/verify.test.ts`
Expected: PASS (6 tests). The first test checks eight claims at once: a restatement, a wrong figure (`$150000` missing), an unrelated claim, a fact, `P99`, an uncited opinion, a chunk id next to `P1` and a nonsense cite, and a fact id; then the audit row.

- [ ] **Step 5: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green (unit 342, integration 298).

- [ ] **Step 6: Commit**

```bash
git add src/verify/resolve.ts test/integration/verify.test.ts
git commit -m "verifyClaims: P and F labels through retrieval_log, chunk and fact ids, fallback windows from raw text; one verification_log row per check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `brain_verify`, `brain verify`, and the server instructions

**Files:**
- Modify: `src/mcp/render.ts` (`verdictLine`, `verdictDetail`, `VERIFY_LIMITS`, `renderVerification`; orient guidance)
- Modify: `src/mcp/server.ts` (the tool, instructions step 5, `brain_search` description, claims logged as a count)
- Modify: `src/cli.ts` (`verify`)
- Modify: `test/unit/render.test.ts`
- Modify: `test/integration/mcp-server.test.ts`

The text is generated from the verification alone, so the MCP text, `structuredContent`, the CLI and the log say the same thing. One line per claim (`✓ supported 0.83 — "<claim>" [P1]`; marks `✓` supported, `~` partial, `✗` unsupported, `○` uncited, `!` bad citation; support with two decimals or `-`), then, under every claim that is not supported, what its cited text lacks (`missing terms: …` in the claim's words, `missing numbers: …` in canonical form, `negation differs from the cited text`, `bad citation P9: <reason>`); under a supported claim only its bad cites. Then `Summary: …`, any notes, and one line saying what is and is not checked. `brain_verify` is registered before the read-only cut-off: it changes no knowledge-base content and only writes its audit row, the same way `brain_search` writes `retrieval_log`. Its description states the method, the thresholds and the limits from spec §7.3, plus the 50-claim and 2,000-character limits; `outputSchema` is `VerificationSchema`. The server instructions gain step 5 (call `brain_verify` after composing an answer; mark anything not supported as the client's own addition or as weakly supported), and the `brain_search` description points to it.

- [ ] **Step 1: Write the failing unit tests**

In `test/unit/render.test.ts`, replace:
```ts
  renderExplain, explainLine, renderSources,
} from "../../src/mcp/render.js";
```
with:
```ts
  renderExplain, explainLine, renderSources, verdictLine, verdictDetail, renderVerification, VERIFY_LIMITS,
} from "../../src/mcp/render.js";
import type { ClaimResult } from "../../src/verify/verify.js";
```

In `test/unit/render.test.ts`, replace:
```ts
describe("renderExplain", () => {
```
with:
```ts
describe("renderVerification", () => {
  const claim = (over: Partial<ClaimResult> = {}): ClaimResult => ({
    claim: "Acme sponsors H-1B visas.", labels: ["P1"], verdict: "supported", support: 1, matchedTerms: ["Acme", "sponsors", "visas"],
    missingTerms: [], missingNumbers: [], negationMismatch: false, badLabels: [],
    cites: [{ label: "P1", kind: "passage", documentId: "d1", chunkId: "c1", factId: null, title: "Doc" }], ...over,
  });

  it("prints one line per claim with its mark, verdict, support and cites", () => {
    expect(verdictLine(claim({ support: 0.833 }))).toBe('✓ supported 0.83 — "Acme sponsors H-1B visas." [P1]');
    expect(verdictLine(claim({ verdict: "partial", support: 0.5, labels: ["P1", "F2"] }))).toBe('~ partial 0.50 — "Acme sponsors H-1B visas." [P1, F2]');
    expect(verdictLine(claim({ verdict: "unsupported", support: 0 }))).toBe('✗ unsupported 0.00 — "Acme sponsors H-1B visas." [P1]');
    expect(verdictLine(claim({ verdict: "uncited", support: null, labels: [], cites: [] }))).toBe('○ uncited - — "Acme sponsors H-1B visas."');
    expect(verdictLine(claim({ verdict: "bad_citation", support: null, labels: ["P9"], cites: [] }))).toBe('! bad citation - — "Acme sponsors H-1B visas." [P9]');
  });

  it("says under each claim that is not supported what its cited text lacks, and lists bad cites under any claim", () => {
    expect(verdictDetail(claim())).toBeNull();
    expect(verdictDetail(claim({ badLabels: [{ label: "P9", reason: "no P9 in this search (it returned 3 passages)" }] }))).toBe(
      "    bad citation P9: no P9 in this search (it returned 3 passages)",
    );
    expect(verdictDetail(claim({ verdict: "partial", support: 0.5, missingTerms: ["Denver"], missingNumbers: ["$140000"], negationMismatch: true }))).toBe(
      "    missing terms: Denver · missing numbers: $140000 · negation differs from the cited text",
    );
    expect(verdictDetail(claim({ verdict: "partial", support: null }))).toBe("    no content words to compare");
    expect(verdictDetail(claim({ verdict: "uncited", support: null, labels: [], cites: [] }))).toBe("    no citation: nothing from the knowledge base backs this");
    expect(verdictDetail(claim({ verdict: "bad_citation", support: null, cites: [], badLabels: [{ label: "P9", reason: "r" }] }))).toBe("    bad citation P9: r");
  });

  it("renders the whole verification: header, claims, summary, notes and what was not checked", () => {
    const text = renderVerification({
      verificationId: "v1", retrievalId: "r1", notes: ["Old search."],
      claims: [claim(), claim({ claim: "Acme pays $150,000.", verdict: "partial", support: 1, missingNumbers: ["$150000"] })],
      summary: { supported: 1, partial: 1, unsupported: 0, uncited: 0, bad_citation: 0, text: "1 supported, 1 partial" },
    });
    expect(text.split("\n")).toEqual([
      "verification v1 · retrieval r1 · 2 claims",
      '✓ supported 1.00 — "Acme sponsors H-1B visas." [P1]',
      '~ partial 1.00 — "Acme pays $150,000." [P1]',
      "    missing numbers: $150000",
      "Summary: 1 supported, 1 partial",
      "Note: Old search.",
      VERIFY_LIMITS,
    ]);
  });
});

describe("renderExplain", () => {
```

In `test/unit/render.test.ts`, replace:
```ts
    expect(t).toContain("brain_search");
  });
  it("renderOrient says the Voyage ledger is unavailable instead of failing"
```
with:
```ts
    expect(t).toContain("brain_search");
    expect(t).toContain("brain_verify to check an answer's claims against the passages and facts they cite");
  });
  it("renderOrient says the Voyage ledger is unavailable instead of failing"
```

- [ ] **Step 2: Write the failing integration tests**

In `test/integration/mcp-server.test.ts`, replace:
```ts
import { renderSearch } from "../../src/mcp/render.js";
```
with:
```ts
import { renderSearch, renderVerification } from "../../src/mcp/render.js";
import { VerificationSchema } from "../../src/verify/resolve.js";
```

In `test/integration/mcp-server.test.ts`, replace:
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
```
with:
```ts
  it("lists eleven tools, or eight when read-only (brain_explain and brain_verify are read-only)", async () => {
    const a = await connect();
    expect((await a.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "brain_add_fact", "brain_explain", "brain_get_document", "brain_get_facts", "brain_get_node", "brain_ingest", "brain_orient", "brain_search", "brain_status", "brain_supersede_fact", "brain_verify",
    ]);
    await a.close();
    const b = await connect(true);
    expect((await b.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "brain_explain", "brain_get_document", "brain_get_facts", "brain_get_node", "brain_orient", "brain_search", "brain_status", "brain_verify",
    ]);
```

In `test/integration/mcp-server.test.ts`, replace:
```ts
  it("tells clients to route questions about the owner through orient then search", async () => {
```
with:
```ts
  it("brain_verify checks an answer's claims against a brain_search result, read-only, and logs one audit row", async () => {
    const s = await connect();
    await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    await s.jobs.drain();
    const found = await s.call("brain_search", { query: "Acme Corp visa", k: 5 });
    const id = /^retrieval ([0-9a-f-]{36}) · mode: hybrid/.exec(found.text)![1];
    await s.close();
    const ro = await connect(true);
    await ro.client.listTools(); // the client validates structuredContent against the advertised outputSchema
    const res = await ro.client.callTool({
      name: "brain_verify",
      arguments: {
        retrieval_id: id,
        claims: [
          { text: "I applied to Acme Corp in September.", cites: ["P1"] },
          { text: "Northwind builds rockets in Ohio.", cites: ["P1"] },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    const v = VerificationSchema.parse(res.structuredContent);
    expect(v.claims.map((c) => c.verdict)).toEqual(["supported", "unsupported"]);
    expect(renderVerification(v)).toBe(text);
    expect(text).toContain('✓ supported 1.00 — "I applied to Acme Corp in September." [P1]');
    expect(text).toContain('✗ unsupported 0.00 — "Northwind builds rockets in Ohio." [P1]\n    missing terms: Northwind, builds, rockets, Ohio');
    expect(text).toContain("Summary: 1 supported, 1 unsupported");
    const [row] = await sql<{ retrieval_id: string; client: string }[]>`select retrieval_id, client from brain.verification_log where id = ${v.verificationId}`;
    expect(row).toEqual({ retrieval_id: id, client: "test" });
    const [call] = await sql<{ args: Record<string, unknown> }[]>`select args from brain.tool_calls where tool = 'brain_verify'`;
    expect(call.args).toEqual({ retrieval_id: id, claims_n: 2 });

    const missing = await ro.call("brain_verify", { retrieval_id: "00000000-0000-0000-0000-000000000000", claims: [{ text: "x", cites: [] }] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('No logged search has retrieval id "00000000-0000-0000-0000-000000000000"');
    const tooMany = await ro.call("brain_verify", { retrieval_id: id, claims: Array.from({ length: 51 }, () => ({ text: "x", cites: [] })) });
    expect(tooMany.isError).toBe(true);
    const tooLong = await ro.call("brain_verify", { retrieval_id: id, claims: [{ text: "x".repeat(2001), cites: [] }] });
    expect(tooLong.isError).toBe(true);
    expect((await sql`select id from brain.verification_log`).length).toBe(1);
    await ro.close();
  });

  it("tells clients to route questions about the owner through orient then search", async () => {
```

In `test/integration/mcp-server.test.ts`, replace:
```ts
    expect(instructions).toContain("brain_explain with the retrieval id replays how that search ranked its passages");
```
with:
```ts
    expect(instructions).toContain("brain_explain with the retrieval id replays how that search ranked its passages");
    expect(instructions).toContain("After composing an answer from brain_search results, call brain_verify with the retrieval id and the answer's claims");
    expect(instructions).toContain("mark every claim whose verdict is not supported as your own addition or as weakly supported");
    expect(instructions.indexOf("brain_search")).toBeLessThan(instructions.indexOf("brain_verify"));
    expect(searchTool.description).toContain("brain_verify");
    const verifyTool = (await s.client.listTools()).tools.find((t) => t.name === "brain_verify")!;
    expect(verifyTool.description).toContain("it checks vocabulary overlap, not logic");
    expect(verifyTool.description).toContain("At most 50 claims of at most 2,000 characters each");
    expect(verifyTool.outputSchema).toBeDefined();
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/render.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/mcp-server.test.ts`
Expected: FAIL. Unit: 4 tests (`TypeError: verdictLine is not a function`, `verdictDetail is not a function`, `renderVerification is not a function`, and the orient guidance assertion). Integration (run it on its own to see it): 3 tests (the tool list has ten names, `brain_verify` returns `isError`, and the instructions lack step 5).

- [ ] **Step 4: Render a verification in `src/mcp/render.ts`**

In `src/mcp/render.ts`, replace:
```ts
import { voyageTodayLine } from "../llm/usage.js";
```
with:
```ts
import { voyageTodayLine } from "../llm/usage.js";
import type { ClaimResult, Verdict } from "../verify/verify.js";
import type { Verification } from "../verify/resolve.js";
```

In `src/mcp/render.ts`, replace:
```ts
const yesNo = (b: boolean) => (b ? "yes" : "no");
```
with:
```ts
const VERDICT_MARK: Record<Verdict, string> = { supported: "✓", partial: "~", unsupported: "✗", uncited: "○", bad_citation: "!" };

/** One checked claim: mark, verdict, support with two decimals (- when there is none), the claim, and its cites. */
export function verdictLine(c: ClaimResult): string {
  const support = c.support === null ? "-" : c.support.toFixed(2);
  return `${VERDICT_MARK[c.verdict]} ${c.verdict.replace("_", " ")} ${support} — "${c.claim}"${c.labels.length ? ` [${c.labels.join(", ")}]` : ""}`;
}

/**
 * The line under a claim that is not supported: what its cited texts lack (terms as the claim wrote them, numbers in
 * canonical form), whether negation differs, and why any cite is bad. Under a supported claim only its bad cites are
 * listed, and nothing when it has none.
 */
export function verdictDetail(c: ClaimResult): string | null {
  if (c.verdict === "uncited") return "    no citation: nothing from the knowledge base backs this";
  const bad = c.badLabels.map((b) => `bad citation ${b.label}: ${b.reason}`);
  if (c.verdict === "supported") return bad.length ? `    ${bad.join(" · ")}` : null;
  const parts = [
    c.support === null && c.verdict !== "bad_citation" ? "no content words to compare" : null,
    c.missingTerms.length ? `missing terms: ${c.missingTerms.join(", ")}` : null,
    c.missingNumbers.length ? `missing numbers: ${c.missingNumbers.join(", ")}` : null,
    c.negationMismatch ? "negation differs from the cited text" : null,
    ...bad,
  ].filter((x): x is string => x !== null);
  return parts.length ? `    ${parts.join(" · ")}` : null;
}

/** What was checked and what was not; printed under every verification. */
export const VERIFY_LIMITS =
  "Checked: content words (stemmed), numbers, dates and codes, and negation. Not checked: reasoning, paraphrase in other words, sarcasm, relations between quantities.";

/** brain_verify, `brain verify` and the check under `brain ask`: one line per claim, details for the rest, the summary. */
export function renderVerification(v: Verification): string {
  const n = v.claims.length;
  const out = [`verification ${v.verificationId} · retrieval ${v.retrievalId} · ${n} claim${n === 1 ? "" : "s"}`];
  for (const c of v.claims) {
    out.push(verdictLine(c));
    const detail = verdictDetail(c);
    if (detail) out.push(detail);
  }
  out.push(`Summary: ${v.summary.text}`);
  for (const note of v.notes) out.push(`Note: ${note}`);
  out.push(VERIFY_LIMITS);
  return out.join("\n");
}

const yesNo = (b: boolean) => (b ? "yes" : "no");
```

In `src/mcp/render.ts`, replace:
```ts
brain_explain to see how a search ranked its passages; brain_ingest
```
with:
```ts
brain_explain to see how a search ranked its passages; brain_verify to check an answer's claims against the passages and facts they cite; brain_ingest
```

- [ ] **Step 5: The tool, the instructions and the search description in `src/mcp/server.ts`**

In `src/mcp/server.ts`, replace:
```ts
import { explain, explainNotFound } from "../retrieve/explain.js";
```
with:
```ts
import { explain, explainNotFound } from "../retrieve/explain.js";
import { verifyClaims, VerificationSchema, ClaimInputSchema, MAX_CLAIMS } from "../verify/resolve.js";
```

In `src/mcp/server.ts`, replace:
```ts
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, renderExplain } from "./render.js";
```
with:
```ts
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, renderExplain, renderVerification } from "./render.js";
```

In `src/mcp/server.ts`, replace:
```ts
    "Every brain_search result starts with `retrieval <id> · mode: <mode>`.
```
with:
```ts
    "5. After composing an answer from brain_search results, call brain_verify with the retrieval id and the answer's claims, each with the labels it cites. When presenting the answer, mark every claim whose verdict is not supported as your own addition or as weakly supported.",
    "Every brain_search result starts with `retrieval <id> · mode: <mode>`.
```

In `src/mcp/server.ts`, replace:
```ts
  /** Records each call in brain.tool_calls. Saved text is logged as its length only; a failed log write never fails the tool. */
  const record = async (tool: string, args: Record<string, unknown>, started: number, res: ToolResult) => {
    const { text: body, ...rest } = args;
    const logged = typeof body === "string" ? { ...rest, text_chars: body.length } : args;
```
with:
```ts
  /**
   * Records each call in brain.tool_calls. Saved text is logged as its length only, and brain_verify's claims as their
   * count (brain.verification_log keeps them); a failed log write never fails the tool.
   */
  const record = async (tool: string, args: Record<string, unknown>, started: number, res: ToolResult) => {
    const { text: body, claims, ...rest } = args;
    const logged: Record<string, unknown> = { ...rest };
    if (typeof body === "string") logged.text_chars = body.length;
    if (Array.isArray(claims)) logged.claims_n = claims.length;
```

In `src/mcp/server.ts`, replace:
```ts
        "Pass the retrieval id to brain_explain to see how the passages were ranked. The same result is returned as structuredContent.",
```
with:
```ts
        "Pass the retrieval id to brain_explain to see how the passages were ranked. The same result is returned as structuredContent. " +
        "After answering, pass the retrieval id and your answer's claims to brain_verify, which checks each claim against the passages and facts it cites.",
```

In `src/mcp/server.ts`, replace:
```ts
  if (opts.readOnly) return server;
```
with:
```ts
  register(
    "brain_verify",
    {
      title: "Check an answer against its sources",
      description:
        "Checks each claim of an answer you wrote from a brain_search result against the passages and facts it cites, with no model call. Pass the retrieval id from the result's first line and each claim with the labels it cites (P1, F2; passage chunk ids and fact ids also work; [] for a claim of your own). " +
        "For each claim it compares the claim's content words (Postgres English stemming, stopwords removed) with the cited texts, requires every number, date and code in the claim to appear in them (1,000 = 1000, ~11% = 11 percent, $115k = $115,000, Sep 29, 2026 = 2026-09-29), and checks that negation agrees. " +
        "Verdicts: supported (at least 60% of the claim's content words are in the cited text, every number appears, negation agrees); partial (at least 30%, or a number is missing, or negation differs); unsupported (under 30%); uncited (no cites); bad_citation (no cite exists in that search). " +
        "Limits: it checks vocabulary overlap, not logic. A correct paraphrase in different words can score partial or unsupported; it never scores supported when most of the claim's words are absent from the cited text. It does not check reasoning, sarcasm, certainty (may versus will), or relations between quantities (more than, fell from X to Y). " +
        `At most ${MAX_CLAIMS} claims of at most 2,000 characters each. Writes one audit row to brain.verification_log and changes nothing in the knowledge base. The same result is returned as structuredContent.`,
      inputSchema: {
        retrieval_id: z.string().min(1).describe("The id after 'retrieval' on the first line of the brain_search result the answer was written from"),
        claims: z.array(ClaimInputSchema).min(1).max(MAX_CLAIMS).describe("The answer split into claims (one sentence each is usual), each with the labels it cites"),
      },
      outputSchema: VerificationSchema,
    },
    async (a) => {
      try {
        const v = await verifyClaims(ctx.sql, a.retrieval_id, a.claims, { client: opts.client });
        return v ? { content: [{ type: "text", text: renderVerification(v) }], structuredContent: v } : fail(new Error(explainNotFound(a.retrieval_id)));
      } catch (e) { return fail(e); }
    },
  );

  if (opts.readOnly) return server;
```

- [ ] **Step 6: The CLI command in `src/cli.ts`**

In `src/cli.ts`, replace:
```ts
import { renderSearch, renderExplain, renderSources } from "./mcp/render.js";
```
with:
```ts
import { renderSearch, renderExplain, renderSources, renderVerification } from "./mcp/render.js";
```

In `src/cli.ts`, replace:
```ts
program
  .command("ask <question>")
```
with:
```ts
program
  .command("verify <retrievalId>")
  .description("Check claims against the passages and facts they cite in a logged search (no model call)")
  .option("--claims <file>", 'JSON file with an array of {"text": "...", "cites": ["P1", "F2"]}')
  .option("--claim <text>", "a single claim; give each label it cites with --cite")
  .option("--cite <label>", "a label the --claim cites: P1, F2, or a chunk or fact id; repeat for more", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--json", "print the verification as JSON")
  .action(async (retrievalId: string, opts: { claims?: string; claim?: string; cite: string[]; json?: boolean }) => {
    if (Boolean(opts.claims) === Boolean(opts.claim)) throw new Error('Pass either --claims <file.json> or --claim "<text>" (with --cite for each label it cites)');
    if (opts.claims && opts.cite.length) throw new Error("--cite goes with --claim; in a --claims file each claim lists its own cites");
    const { verifyClaims } = await import("./verify/resolve.js");
    let claims: unknown = [{ text: opts.claim, cites: opts.cite }];
    if (opts.claims) {
      const { readFile } = await import("node:fs/promises");
      try {
        claims = JSON.parse(await readFile(opts.claims, "utf8"));
      } catch (e) {
        throw new Error(`Cannot read ${opts.claims} as JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await withCtx(async (ctx) => {
      // verifyClaims validates the claims (an array of {text, cites}, at most 50) and says what is wrong.
      const v = await verifyClaims(ctx.sql, retrievalId, claims as never, { client: "cli" });
      if (!v) {
        console.error(explainNotFound(retrievalId));
        process.exitCode = 1;
        return;
      }
      console.log(opts.json ? JSON.stringify(v, null, 2) : renderVerification(v));
    });
  });

program
  .command("ask <question>")
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/render.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/mcp-server.test.ts`
Expected: PASS (unit 20 tests, integration 19).

- [ ] **Step 8: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green (unit 345, integration 299).

- [ ] **Step 9: One search and one `brain verify` on `brain_eval`**

Run:
```bash
export OBSIDIAN_AUTO=0 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval
npm run brain -- search "Does Acme sponsor visas?" -k 3
```
Note the retrieval id on the first line and which `[P#]` is the job description's compensation passage (the `"Senior Data Analyst, Acme Corp (Austin, TX)"` line whose text mentions H-1B). Then, with that id and label:
```bash
cat > /tmp/brain-claims.json <<'EOF'
[{"text": "Acme sponsors H-1B for this role.", "cites": ["P1"]},
 {"text": "The base salary is $115k to $150k.", "cites": ["P1"]},
 {"text": "It looks like a strong fit.", "cites": []}]
EOF
npm run brain -- verify <id> --claims /tmp/brain-claims.json
npm run brain -- verify <id> --claim "Acme sponsors H-1B for this role." --cite P1
npm run brain -- verify 00000000-0000-0000-0000-000000000000 --claim x; echo "exit $?"
psql "$DATABASE_URL" -c "select client, jsonb_array_length(claims) as claims, summary->>'text' as summary from brain.verification_log order by created_at desc limit 2"
unset DATABASE_URL
```
(Change `P1` in both commands to the label you noted if it is not P1.) Expected: the first verify prints `verification <uuid> · retrieval <id> · 3 claims`, `✓ supported 1.00 — "Acme sponsors H-1B for this role." [P1]`, `~ partial … — "The base salary is $115k to $150k." [P1]` with `    missing numbers: $150000` under it, `○ uncited - — "It looks like a strong fit."` with `    no citation: nothing from the knowledge base backs this`, `Summary: 1 supported, 1 partial, 1 uncited`, and the `Checked: …` line. The second prints one supported claim. The third prints `No logged search has retrieval id "00000000-0000-0000-0000-000000000000". …` and `exit 1`. The query shows `cli | 1 | 1 supported` and `cli | 3 | 1 supported, 1 partial, 1 uncited`.

- [ ] **Step 10: Commit**

```bash
git add src/mcp/render.ts src/mcp/server.ts src/cli.ts test/unit/render.test.ts test/integration/mcp-server.test.ts
git commit -m "brain_verify and brain verify: per-claim verdicts with missing terms and numbers; instructions tell clients to mark unsupported claims as their own

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `ask` checks its own answer

**Files:**
- Create: `src/verify/answer.ts`
- Create: `test/unit/verify-answer.test.ts`
- Modify: `src/retrieve/ask.ts`
- Modify: `src/mcp/render.ts` (`renderAnswerCheck`)
- Modify: `src/cli.ts` (`ask` prints the check)
- Modify: `test/unit/render.test.ts`
- Modify: `test/integration/ask.test.ts`

`claimsFromAnswer(answer)` splits the answer with `splitSentences` (Task 1: line breaks; `.` `!` `?` not after an abbreviation, an initial or a decimal point; a label written after the full stop stays with its sentence), takes each sentence's `[P#]`/`[F#]` labels as its cites, strips them from the text, skips a sentence that is only labels, cuts a sentence to 2,000 characters, and returns at most 50 claims with a count of the rest. `ask()` runs `verifyClaims` on its own search's retrieval id (client `ask`, the same label its search logs) and returns the verification with the answer. A failure in the check (for example, migration 012 missing) is returned as `verificationError` and never loses the answer. The CLI prints the check under the sources.

- [ ] **Step 1: Write the failing unit tests**

Create `test/unit/verify-answer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { claimsFromAnswer, labelsIn } from "../../src/verify/answer.js";

describe("labelsIn", () => {
  it("finds every label form once, in order, normalised", () => {
    expect(labelsIn("Acme [P1] pays [p2, F1] well [P1][F03].")).toEqual(["P1", "P2", "F1", "F3"]);
    expect(labelsIn("No labels here.")).toEqual([]);
  });
});

describe("claimsFromAnswer", () => {
  it("makes one claim per sentence, citing the labels inside it, with the labels stripped", () => {
    const answer = "Acme sponsors H-1B visas [P1]. The salary is $115k to $140k, e.g. base pay [P2][F1]. I would apply.\n- Hybrid, three days a week [P3]";
    expect(claimsFromAnswer(answer)).toEqual({
      claims: [
        { text: "Acme sponsors H-1B visas.", cites: ["P1"] },
        { text: "The salary is $115k to $140k, e.g. base pay.", cites: ["P2", "F1"] },
        { text: "I would apply.", cites: [] },
        { text: "Hybrid, three days a week", cites: ["P3"] },
      ],
      dropped: 0,
    });
  });

  it("keeps a label written after the full stop with its sentence, and skips a line that is only labels", () => {
    expect(claimsFromAnswer("Acme is in Austin. [P2] It raised $40M.\n[P3]").claims).toEqual([
      { text: "Acme is in Austin.", cites: ["P2"] },
      { text: "It raised $40M.", cites: [] },
    ]);
  });

  it("returns at most 50 claims and counts the rest, and cuts a sentence to 2,000 characters", () => {
    const many = Array.from({ length: 53 }, (_, i) => `Claim number ${i + 1} [P1].`).join(" ");
    const r = claimsFromAnswer(many);
    expect(r.claims).toHaveLength(50);
    expect(r.dropped).toBe(3);
    expect(claimsFromAnswer("a".repeat(2500)).claims[0].text).toHaveLength(2000);
    expect(claimsFromAnswer("")).toEqual({ claims: [], dropped: 0 });
  });
});
```

In `test/unit/render.test.ts`, replace:
```ts
  renderExplain, explainLine, renderSources, verdictLine, verdictDetail, renderVerification, VERIFY_LIMITS,
```
with:
```ts
  renderExplain, explainLine, renderSources, verdictLine, verdictDetail, renderVerification, VERIFY_LIMITS, renderAnswerCheck,
```

In `test/unit/render.test.ts`, replace:
```ts
describe("renderExplain", () => {
```
with:
```ts
describe("renderAnswerCheck", () => {
  const v = {
    verificationId: "v1", retrievalId: "r1", notes: [],
    claims: [{ claim: "Acme sponsors visas.", labels: ["P1"], verdict: "supported" as const, support: 1, matchedTerms: [], missingTerms: [], missingNumbers: [], negationMismatch: false, badLabels: [], cites: [] }],
    summary: { supported: 1, partial: 0, unsupported: 0, uncited: 0, bad_citation: 0, text: "1 supported" },
  };

  it("introduces the verification, and says when sentences were left out", () => {
    expect(renderAnswerCheck(v, null, 0).split("\n").slice(0, 3)).toEqual([
      "Each sentence of the answer, checked against what it cites (no model call):",
      "verification v1 · retrieval r1 · 1 claim",
      '✓ supported 1.00 — "Acme sponsors visas." [P1]',
    ]);
    expect(renderAnswerCheck(v, null, 0)).not.toContain("Only the first");
    expect(renderAnswerCheck(v, null, 4).split("\n").at(-1)).toBe("Only the first 1 sentences were checked; 4 more were not.");
  });

  it("says why the check did not run, or that there was nothing to check", () => {
    expect(renderAnswerCheck(null, "relation \"brain.verification_log\" does not exist", 0)).toBe(
      'Could not check the answer against its sources: relation "brain.verification_log" does not exist',
    );
    expect(renderAnswerCheck(null, null, 0)).toBe("The answer has no sentences to check.");
  });
});

describe("renderExplain", () => {
```

- [ ] **Step 2: Write the failing integration tests**

In `test/integration/ask.test.ts`, replace:
```ts
    expect(result.retrievalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.passages.length).toBeGreaterThan(0);
  });
```
with:
```ts
    expect(result.retrievalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.passages.length).toBeGreaterThan(0);
  });

  it("checks its own answer sentence by sentence against the labels each sentence cites, on its own retrieval id", async () => {
    const ctx = fakeCtx(sql, ({ system }) => {
      if (system === SUMMARY_SYSTEM) return { title: "T", summary_line: "L", summary: "S", occurred_at: null };
      if (system === ASK_SYSTEM) return "Zorblax released the ZX-9000 [P1]. Your visa status is F-1 OPT [F1]. It is the best drill on the market.";
      return { entities: [], relations: [], facts_about_self: [{ predicate: "visa_status", object_text: "F-1 OPT", object_key: null, confidence: 1, valid_from: null, valid_to: null, quote: "F-1 OPT" }] };
    });
    await ingest(ctx, { text: "Zorblax released the ZX-9000. I am on F-1 OPT." });
    const { result, verification, verificationError, droppedClaims } = await ask(ctx, "What did Zorblax release, and what is my visa status?");
    expect(verificationError).toBeNull();
    expect(droppedClaims).toBe(0);
    expect(verification!.retrievalId).toBe(result.retrievalId);
    expect(verification!.claims.map((c) => [c.claim, c.labels, c.verdict])).toEqual([
      ["Zorblax released the ZX-9000.", ["P1"], "supported"],
      ["Your visa status is F-1 OPT.", ["F1"], "supported"],
      ["It is the best drill on the market.", [], "uncited"],
    ]);
    expect(verification!.summary.text).toBe("2 supported, 1 uncited");
    const [row] = await sql<{ client: string; retrieval_id: string }[]>`select client, retrieval_id from brain.verification_log`;
    expect(row).toEqual({ client: "ask", retrieval_id: result.retrievalId });
  });

  it("still returns the answer when the check fails", async () => {
    const ctx = fakeCtx(sql, ({ system }) => (system === ASK_SYSTEM ? "Nothing is stored [P1]." : { title: "T", summary_line: "L", summary: "S", occurred_at: null }));
    await sql`alter table brain.verification_log rename to verification_log_hidden`;
    try {
      const { answer, verification, verificationError } = await ask(ctx, "Anything?");
      expect(answer).toBe("Nothing is stored [P1].");
      expect(verification).toBeNull();
      expect(verificationError).toContain('relation "brain.verification_log" does not exist');
    } finally {
      await sql`alter table brain.verification_log_hidden rename to verification_log`;
    }
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/verify-answer.test.ts test/unit/render.test.ts; bash scripts/prepare-test-db.sh && npx vitest run test/integration/ask.test.ts`
Expected: FAIL. Unit: `Error: Cannot find module '../../src/verify/answer.js'` for the new file, and 2 render tests with `TypeError: renderAnswerCheck is not a function`. Integration: 2 tests with `AssertionError: expected undefined to be null` (`ask()` returns no `verificationError` yet).

- [ ] **Step 4: Write `src/verify/answer.ts`**

Create `src/verify/answer.ts`:
```ts
import { splitSentences } from "./terms.js";
import { LABEL_GROUP_RE, stripLabels } from "./verify.js";
import { MAX_CLAIM_CHARS, MAX_CLAIMS, type ClaimInput } from "./resolve.js";

/** The [P#] and [F#] labels inside a sentence ([P1], [F2], [P1, F2], [P1][F2]), normalised (p01 is P1), each once, in order. */
export function labelsIn(sentence: string): string[] {
  const out: string[] = [];
  for (const group of sentence.match(LABEL_GROUP_RE) ?? []) {
    for (const l of group.match(/[PF]\d+/gi) ?? []) {
      const label = `${l[0].toUpperCase()}${Number(l.slice(1))}`;
      if (!out.includes(label)) out.push(label);
    }
  }
  return out;
}

/**
 * An answer as claims, the way `brain ask` checks its own answer: one claim per sentence (splitSentences: line breaks,
 * and . ! ? not after an abbreviation, initial or decimal point), citing the labels inside that sentence, with the
 * labels removed from its text. A sentence with no letter or digit once its labels are removed (a lone "[P1]") is
 * skipped. At most MAX_CLAIMS claims are returned (`dropped` counts the rest), and a sentence longer than
 * MAX_CLAIM_CHARS characters is cut to that length.
 */
export function claimsFromAnswer(answer: string): { claims: ClaimInput[]; dropped: number } {
  const all = splitSentences(answer)
    .map((s) => ({ text: stripLabels(s).slice(0, MAX_CLAIM_CHARS), cites: labelsIn(s) }))
    .filter((c) => /[\p{L}\p{N}]/u.test(c.text));
  return { claims: all.slice(0, MAX_CLAIMS), dropped: Math.max(0, all.length - MAX_CLAIMS) };
}
```

- [ ] **Step 5: `ask()` verifies its answer (`src/retrieve/ask.ts`)**

In `src/retrieve/ask.ts`, replace:
```ts
import { factLine, foundBy, scoreText } from "../mcp/render.js";
```
with:
```ts
import { factLine, foundBy, scoreText } from "../mcp/render.js";
import { claimsFromAnswer } from "../verify/answer.js";
import { verifyClaims, type Verification } from "../verify/resolve.js";
```

In `src/retrieve/ask.ts`, replace:
```ts
export async function ask(ctx: Ctx, question: string, opts: SearchOptions = {}): Promise<{ answer: string; result: SearchResult }> {
  const result = await search(ctx, question, { ...opts, client: opts.client ?? "ask" });
  const answer = await ctx.llm.text({ system: ASK_SYSTEM, user: buildAskPrompt(question, result) });
  return { answer, result };
}
```
with:
```ts
export interface AskResult {
  answer: string;
  result: SearchResult;
  /** The answer checked sentence by sentence against what each sentence cites; null when it has no sentence or the check failed. */
  verification: Verification | null;
  /** Why the check failed (the answer is still returned); null when it ran or there was nothing to check. */
  verificationError: string | null;
  /** Sentences past the first 50, which were not checked. */
  droppedClaims: number;
}

/**
 * Searches, asks the model to answer from the result, then checks the answer with the citation verifier: each
 * sentence is a claim citing the [P#]/[F#] labels inside it, resolved through this search's retrieval id. The check
 * makes no model call; a failure there is reported in verificationError and never loses the answer.
 */
export async function ask(ctx: Ctx, question: string, opts: SearchOptions = {}): Promise<AskResult> {
  const client = opts.client ?? "ask";
  const result = await search(ctx, question, { ...opts, client });
  const answer = await ctx.llm.text({ system: ASK_SYSTEM, user: buildAskPrompt(question, result) });
  const { claims, dropped } = claimsFromAnswer(answer);
  let verification: Verification | null = null;
  let verificationError: string | null = null;
  if (claims.length) {
    try {
      verification = await verifyClaims(ctx.sql, result.retrievalId, claims, { client });
    } catch (e) {
      verificationError = e instanceof Error ? e.message : String(e);
    }
  }
  return { answer, result, verification, verificationError, droppedClaims: dropped };
}
```

- [ ] **Step 6: `renderAnswerCheck` and the CLI**

In `src/mcp/render.ts`, replace:
```ts
const yesNo = (b: boolean) => (b ? "yes" : "no");
```
with:
```ts
/** Printed under a `brain ask` answer and its sources: the answer checked sentence by sentence, or why it was not. */
export function renderAnswerCheck(v: Verification | null, error: string | null, dropped: number): string {
  if (error) return `Could not check the answer against its sources: ${error}`;
  if (!v) return "The answer has no sentences to check.";
  return [
    "Each sentence of the answer, checked against what it cites (no model call):",
    renderVerification(v),
    ...(dropped ? [`Only the first ${v.claims.length} sentences were checked; ${dropped} more were not.`] : []),
  ].join("\n");
}

const yesNo = (b: boolean) => (b ? "yes" : "no");
```

In `src/cli.ts`, replace:
```ts
import { renderSearch, renderExplain, renderSources, renderVerification } from "./mcp/render.js";
```
with:
```ts
import { renderSearch, renderExplain, renderSources, renderVerification, renderAnswerCheck } from "./mcp/render.js";
```

In `src/cli.ts`, replace:
```ts
      const { answer, result } = await ask(ctx, question, searchOptions(opts));
      console.log(answer + "\n");
      console.log(renderSources(result));
```
with:
```ts
      const { answer, result, verification, verificationError, droppedClaims } = await ask(ctx, question, searchOptions(opts));
      console.log(answer + "\n");
      console.log(renderSources(result));
      console.log("\n" + renderAnswerCheck(verification, verificationError, droppedClaims));
```

In `src/cli.ts`, replace:
```ts
  .description("Answer a question with citations")
```
with:
```ts
  .description("Answer a question with citations, then check each sentence against what it cites")
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/verify-answer.test.ts test/unit/render.test.ts test/unit/ask.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/ask.test.ts`
Expected: PASS (unit 4 + 22 + 4 tests, integration 3).

- [ ] **Step 8: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green (unit 351, integration 301).

- [ ] **Step 9: One `brain ask` on `brain_eval`**

Run:
```bash
OBSIDIAN_AUTO=0 DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/brain_eval npm run brain -- ask "Does Acme sponsor visas, and what does the Senior Data Analyst role pay?"
```
This makes one model call for the answer (Claude Code, as `ask` always has) and none for the check. Expected: the answer with `[P…]` labels; the `Sources from the knowledge base …` block; then `Each sentence of the answer, checked against what it cites (no model call):`, `verification <uuid> · retrieval <uuid> · <n> claims` (the same retrieval id as the sources block), one verdict line per sentence (the sentences restating the H-1B sponsorship and the $115,000 to $140,000 range should be `✓ supported`; a sentence without a label is `○ uncited`), `Summary: …` and the `Checked: …` line. The exact sentences depend on the model; what must hold is that every sentence appears once, that sentences with labels show them, and that the retrieval ids match.

- [ ] **Step 10: Commit**

```bash
git add src/verify/answer.ts test/unit/verify-answer.test.ts src/retrieve/ask.ts src/mcp/render.ts src/cli.ts test/unit/render.test.ts test/integration/ask.test.ts
git commit -m "ask checks its own answer: one claim per sentence with the labels inside it, verified on ask's retrieval id, printed under the sources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The verifier's golden set and metric

**Files:**
- Create: `src/eval/verifier.ts`
- Create: `eval/verifier.jsonl`
- Create: `test/unit/eval-verifier.test.ts`
- Create: `test/unit/verifier-fixtures.test.ts`
- Create: `test/integration/eval-verifier.test.ts`
- Modify: `src/eval/run.ts` (`EvalRun.verifier`)
- Modify: `src/cli.ts` (`eval run --verifier`, its line and gate; `eval verifier`)

Each item of `eval/verifier.jsonl` is `{id, case, retrieval: {documents}, claim, cites, expected_verdict, note, labelled_by: "agent:claude"}`. Cites carry their text inline (passages verbatim from `eval/corpus`, with an optional heading path; facts as predicate and value; a label that is not in the retrieval as `{label, missing: true}`), so the set is stable without retrieval ids, needs no ingested corpus, makes no model or Voyage call, and runs exactly the judging code `brain_verify` runs (`verifyTexts`) with Postgres stems. A unit test checks every passage text is verbatim in a fixture the item names.

Labelling policy (stated in the README): an item is labelled `supported` only when its cited text really supports it. A claim that is true but that the method by design cannot recognise (a paraphrase in other words, a bare figure, a term-free "No.") is labelled with the verdict the method is designed to give, so it documents the limit without counting as an error. A claim that is not supported but that the method would pass (the three `known_limit` items: certainty, a reversed quantity relation, one added detail) is labelled `partial`, so it counts as a precision error. Precision of `supported` against these labels is therefore a lower bound on precision against the truth: every claim labelled `supported` is truly supported.

The 63 items: 35 labelled `supported` (restatements of every fixture, three claims spanning two passages, three facts, five number forms, three date forms, two negation agreements, two hedged claims, a term-free "Yes.", a good cite next to a missing one) and 28 not (seven wrong numbers, dates or codes, four negation flips, three unrelated claims, a wrong fact, two uncited, one bad citation, an added detail below 0.6, four paraphrases, two term-free answers, three known limits). On the scratch database the set scored precision 0.92 (34 of the 37 claims marked supported are labelled supported; the 3 errors are the known limits), recall 0.97 (v10 is the one miss: an unrelated "without" in a long cited sentence), accuracy 0.92; the integration test pins the five misses so any change in behaviour shows.

- [ ] **Step 1: Write the labelled set**

Create `eval/verifier.jsonl`:
```json
{"id": "v01", "case": "exact", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "Acme sponsors H-1B for the Senior Data Analyst role.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "supported", "note": "Restates the compensation section; the role's name comes from the heading path.", "labelled_by": "agent:claude"}
{"id": "v02", "case": "exact", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "Beta Ventures led Acme's $40 million Series B.", "cites": [{"label": "P1", "text": "AUSTIN, March 12, 2026. Acme Corp, maker of the ZX-9000 industrial drill, announced a $40 million Series B round led by Beta Ventures with participation from Lonestar Capital. The company said it will use the funds to expand its Austin manufacturing facility and grow its analytics and software teams by roughly 40 people over the next year."}], "expected_verdict": "supported", "note": "Restatement.", "labelled_by": "agent:claude"}
{"id": "v03", "case": "exact", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "Acme was founded in 2019 and employs about 300 people.", "cites": [{"label": "P1", "text": "Acme was founded in 2019 and employs about 300 people."}], "expected_verdict": "supported", "note": "Verbatim apart from the sentence frame.", "labelled_by": "agent:claude"}
{"id": "v04", "case": "exact", "retrieval": {"documents": ["note--moved-to-denver.md"]}, "claim": "I signed a lease in the Highland neighborhood of Denver.", "cites": [{"label": "P1", "text": "This week I finished moving from Austin to Denver. I signed a lease in the Highland neighborhood, so I now live in Denver for good. Hybrid roles are still fine, but from here on I want positions based in Denver or fully remote."}], "expected_verdict": "supported", "note": "Restatement of the owner's note.", "labelled_by": "agent:claude"}
{"id": "v05", "case": "exact", "retrieval": {"documents": ["paper--contextual-retrieval-abstract.md"]}, "claim": "Prepending context to each chunk reduced the top-20 retrieval failure rate by 49 percent.", "cites": [{"label": "P1", "text": "Abstract. Retrieval-augmented generation systems split documents into chunks and embed each chunk independently, which discards the context a chunk needs to be understood. We propose prepending a short, document-specific context string to each chunk before embedding and before building the BM25 index. On a benchmark of 9 datasets the method reduced the top-20 retrieval failure rate by 49 percent, and by 67 percent when combined with a reranker. The context strings are generated once per chunk with a language model and cached, so the cost is paid at indexing time rather than at query time."}], "expected_verdict": "supported", "note": "Restatement; top-20 is checked as a code and 49 percent as 49%.", "labelled_by": "agent:claude"}
{"id": "v06", "case": "exact", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "The Acme role is hybrid, three days a week in the Austin office.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "supported", "note": "Restatement; 'three' is checked as the number 3.", "labelled_by": "agent:claude"}
{"id": "v07", "case": "exact", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "Dana Whitfield of Beta Ventures will join Acme's board.", "cites": [{"label": "P1", "text": "\"Demand for the ZX-9000 has outpaced our capacity for two quarters,\" said CEO Marcus Hale. Beta Ventures partner Dana Whitfield will join Acme's board."}], "expected_verdict": "supported", "note": "Restatement.", "labelled_by": "agent:claude"}
{"id": "v08", "case": "exact", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "Demand for the ZX-9000 outpaced Acme's capacity for two quarters.", "cites": [{"label": "P1", "text": "\"Demand for the ZX-9000 has outpaced our capacity for two quarters,\" said CEO Marcus Hale. Beta Ventures partner Dana Whitfield will join Acme's board."}], "expected_verdict": "supported", "note": "Restatement; ZX-9000 is a code and 'two' the number 2.", "labelled_by": "agent:claude"}
{"id": "v09", "case": "exact", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "The role requires 4+ years in analytics and strong SQL and Python.", "cites": [{"label": "P1", "text": "- 4+ years in analytics; strong SQL and Python.\n- Experience with dbt and a modern warehouse (Snowflake or BigQuery).\n- Comfortable presenting to executives.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Requirements"]}], "expected_verdict": "supported", "note": "Restatement; 'requires' matches the Requirements heading.", "labelled_by": "agent:claude"}
{"id": "v10", "case": "exact", "retrieval": {"documents": ["note--databricks-cost-governance.md"]}, "claim": "Morgan Reyes advises making idle clusters terminate after 20 minutes.", "cites": [{"label": "P1", "text": "My advice to anyone starting out: write cluster policies before the first job runs, give every pool a hard worker limit, make idle clusters terminate after 20 minutes, and refuse to launch anything without a cost-center tag. Then look at the billing dashboard together every week."}], "expected_verdict": "supported", "note": "True: the author's advice. Known miss: the cited sentence also says 'without a cost-center tag', and a negation word in a source sentence that shares a matched word counts as the source negating, so the verifier says partial.", "labelled_by": "agent:claude"}
{"id": "v11", "case": "exact", "retrieval": {"documents": ["note--fairness-in-ml.md"]}, "claim": "Equal opportunity means matching true positive rates.", "cites": [{"label": "P1", "text": "My view: pick the metric that matches the harm. For a hiring screen, false negatives on qualified candidates from underrepresented groups are the harm I care about, so equal opportunity (matching true positive rates) is the right target. Reporting one number hides the trade-off; report the confusion matrix per group."}], "expected_verdict": "supported", "note": "Restatement of the owner's note.", "labelled_by": "agent:claude"}
{"id": "v12", "case": "exact", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "Acme's Operations Analytics team is in Austin.", "cites": [{"label": "P1", "text": "Acme Corp builds industrial drilling equipment, including the ZX-9000 line. We are hiring a Senior Data Analyst to join the Operations Analytics team in Austin.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)"]}], "expected_verdict": "supported", "note": "Restatement.", "labelled_by": "agent:claude"}
{"id": "v13", "case": "exact", "retrieval": {"documents": ["email--recruiter-followup-beta-ventures.md"]}, "claim": "Jordan passed Frank's resume to Priya Natarajan.", "cites": [{"label": "P1", "text": "From: Jordan Ellis, Talent Partner, Beta Ventures\nDate: 2026-09-20\n\nHi Frank,\n\nFollowing up on our chat. One of our portfolio companies, Acme Corp in Austin, is hiring a Senior Data Analyst. I have passed your resume to Priya Natarajan, the hiring manager. Compensation is in the $115k to $140k range and they sponsor visas."}], "expected_verdict": "supported", "note": "Restatement; the email is from Jordan Ellis to Frank.", "labelled_by": "agent:claude"}
{"id": "v14", "case": "exact", "retrieval": {"documents": ["email--recruiter-followup-beta-ventures.md"]}, "claim": "Northwind Robotics in Denver is looking for a fully remote product analyst.", "cites": [{"label": "P1", "text": "Separately, another portfolio company, Northwind Robotics in Denver, is looking for a product analyst. Fully remote, $105k to $125k. Let me know if you want an intro."}], "expected_verdict": "supported", "note": "Restatement.", "labelled_by": "agent:claude"}
{"id": "v15", "case": "exact", "retrieval": {"documents": ["email--recruiter-intro.md"]}, "claim": "Frank's panel interview for the Northwind analytics lead role is booked for October 6.", "cites": [{"label": "P1", "text": "Let me introduce Frank Fu. We had a long call last Thursday and I came away convinced he would do well as analytics lead on your team. He is one of three finalists for the position, and his panel interview is booked for October 6."}], "expected_verdict": "supported", "note": "True (the email is about the Northwind opening); 'October 6' is checked as --10-06.", "labelled_by": "agent:claude"}
{"id": "v16", "case": "two_passages", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md", "news--acme-series-b.md"]}, "claim": "Acme sponsors H-1B, and its Series B was led by Beta Ventures.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}, {"label": "P2", "text": "AUSTIN, March 12, 2026. Acme Corp, maker of the ZX-9000 industrial drill, announced a $40 million Series B round led by Beta Ventures with participation from Lonestar Capital. The company said it will use the funds to expand its Austin manufacturing facility and grow its analytics and software teams by roughly 40 people over the next year."}], "expected_verdict": "supported", "note": "Each half is in a different passage; their union covers the claim.", "labelled_by": "agent:claude"}
{"id": "v17", "case": "two_passages", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md", "news--acme-series-b.md"]}, "claim": "The Acme role pays $115,000 to $140,000, and Acme employs about 300 people.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}, {"label": "P2", "text": "Acme was founded in 2019 and employs about 300 people."}], "expected_verdict": "supported", "note": "Figures from two passages.", "labelled_by": "agent:claude"}
{"id": "v18", "case": "two_passages", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md", "conversation--interview-prep-with-priya.md"]}, "claim": "Priya Natarajan is the hiring manager, and she confirmed Acme sponsors H-1B.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}, {"label": "P2", "text": "I told her I am on F-1 OPT and asked about sponsorship. She confirmed Acme sponsors H-1B and has done it for two analysts on her team. I mentioned I prefer hybrid over fully remote, and that Austin works for me."}], "expected_verdict": "supported", "note": "Hiring manager from the job description, the confirmation from the call notes.", "labelled_by": "agent:claude"}
{"id": "v19", "case": "fact", "retrieval": {"documents": []}, "claim": "My visa status is F-1 OPT.", "cites": [{"label": "F1", "predicate": "visa_status", "object_text": "F-1 OPT"}], "expected_verdict": "supported", "note": "A fact is cited as 'visa status: F-1 OPT'.", "labelled_by": "agent:claude"}
{"id": "v20", "case": "fact", "retrieval": {"documents": []}, "claim": "I live in Denver.", "cites": [{"label": "F1", "predicate": "lives_in", "object_text": "Denver"}], "expected_verdict": "supported", "note": "Fact restatement.", "labelled_by": "agent:claude"}
{"id": "v21", "case": "fact", "retrieval": {"documents": []}, "claim": "I prefer hybrid work.", "cites": [{"label": "F1", "predicate": "prefers", "object_text": "hybrid over fully remote"}], "expected_verdict": "supported", "note": "True; 'work' is not in the fact.", "labelled_by": "agent:claude"}
{"id": "v22", "case": "number_form", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "The role's base salary is $115k to $140k.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "supported", "note": "$115k and $115,000 are both $115000.", "labelled_by": "agent:claude"}
{"id": "v23", "case": "number_form", "retrieval": {"documents": ["paper--contextual-retrieval-abstract.md"]}, "claim": "With a reranker, the failure rate fell 67%.", "cites": [{"label": "P1", "text": "Abstract. Retrieval-augmented generation systems split documents into chunks and embed each chunk independently, which discards the context a chunk needs to be understood. We propose prepending a short, document-specific context string to each chunk before embedding and before building the BM25 index. On a benchmark of 9 datasets the method reduced the top-20 retrieval failure rate by 49 percent, and by 67 percent when combined with a reranker. The context strings are generated once per chunk with a language model and cached, so the cost is paid at indexing time rather than at query time."}], "expected_verdict": "supported", "note": "67% and '67 percent' are both 67%.", "labelled_by": "agent:claude"}
{"id": "v24", "case": "number_form", "retrieval": {"documents": ["note--databricks-cost-governance.md"]}, "claim": "The Databricks invoice rose from about $41k a month to $157k.", "cites": [{"label": "P1", "text": "When we finished migrating to Databricks I expected our compute spend to fall. Three months later the invoice had nearly quadrupled, from about $41,000 a month to $157,000, and the first person to notice was someone in finance."}], "expected_verdict": "supported", "note": "$41k is $41,000; 'rose' is not in the passage ('quadrupled'), the rest is.", "labelled_by": "agent:claude"}
{"id": "v25", "case": "number_form", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "Acme announced a $40M Series B.", "cites": [{"label": "P1", "text": "AUSTIN, March 12, 2026. Acme Corp, maker of the ZX-9000 industrial drill, announced a $40 million Series B round led by Beta Ventures with participation from Lonestar Capital. The company said it will use the funds to expand its Austin manufacturing facility and grow its analytics and software teams by roughly 40 people over the next year."}], "expected_verdict": "supported", "note": "$40M and '$40 million' are both $40000000.", "labelled_by": "agent:claude"}
{"id": "v26", "case": "number_form", "retrieval": {"documents": ["email--recruiter-followup-beta-ventures.md"]}, "claim": "Recruiter Jordan Ellis quoted compensation of $115,000 to $140,000.", "cites": [{"label": "P1", "text": "From: Jordan Ellis, Talent Partner, Beta Ventures\nDate: 2026-09-20\n\nHi Frank,\n\nFollowing up on our chat. One of our portfolio companies, Acme Corp in Austin, is hiring a Senior Data Analyst. I have passed your resume to Priya Natarajan, the hiring manager. Compensation is in the $115k to $140k range and they sponsor visas."}], "expected_verdict": "supported", "note": "The email says $115k to $140k; 'recruiter' and 'quoted' are not in it.", "labelled_by": "agent:claude"}
{"id": "v27", "case": "date_form", "retrieval": {"documents": ["conversation--interview-prep-with-priya.md"]}, "claim": "The SQL screen is on Sep 22, 2026.", "cites": [{"label": "P1", "text": "Next step: SQL screen on 2026-09-22."}], "expected_verdict": "supported", "note": "'Sep 22, 2026' and 2026-09-22 are the same date.", "labelled_by": "agent:claude"}
{"id": "v28", "case": "date_form", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "Acme announced its Series B on 12 March 2026.", "cites": [{"label": "P1", "text": "AUSTIN, March 12, 2026. Acme Corp, maker of the ZX-9000 industrial drill, announced a $40 million Series B round led by Beta Ventures with participation from Lonestar Capital. The company said it will use the funds to expand its Austin manufacturing facility and grow its analytics and software teams by roughly 40 people over the next year."}], "expected_verdict": "supported", "note": "'12 March 2026' and 'March 12, 2026' are both 2026-03-12.", "labelled_by": "agent:claude"}
{"id": "v29", "case": "date_form", "retrieval": {"documents": ["email--recruiter-followup-beta-ventures.md"]}, "claim": "Jordan Ellis followed up in September 2026.", "cites": [{"label": "P1", "text": "From: Jordan Ellis, Talent Partner, Beta Ventures\nDate: 2026-09-20\n\nHi Frank,\n\nFollowing up on our chat. One of our portfolio companies, Acme Corp in Austin, is hiring a Senior Data Analyst. I have passed your resume to Priya Natarajan, the hiring manager. Compensation is in the $115k to $140k range and they sponsor visas."}], "expected_verdict": "supported", "note": "'September 2026' is 2026-09, which the date 2026-09-20 states.", "labelled_by": "agent:claude"}
{"id": "v30", "case": "negation", "retrieval": {"documents": ["note--databricks-cost-governance.md"]}, "claim": "No cluster carried a team tag.", "cites": [{"label": "P1", "text": "The causes were boring. Each squad created its own interactive cluster and nobody shut them down at the end of the day. Autoscaling had no ceiling, so a single bad join could grab two hundred workers. And because no cluster carried a team tag, I had no way to say who was spending what."}], "expected_verdict": "supported", "note": "Claim and source both negate the same words.", "labelled_by": "agent:claude"}
{"id": "v31", "case": "negation", "retrieval": {"documents": ["note--fairness-in-ml.md"]}, "claim": "You cannot satisfy demographic parity, equalized odds and calibration together when base rates differ.", "cites": [{"label": "P1", "text": "Fairness is not one metric. Demographic parity asks that positive rates match across groups. Equalized odds asks that true positive and false positive rates match. Calibration asks that predicted probabilities mean the same thing for every group. Chouldechova's impossibility result shows you cannot satisfy all three when base rates differ."}], "expected_verdict": "supported", "note": "Both negate ('cannot').", "labelled_by": "agent:claude"}
{"id": "v32", "case": "hedged", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "Acme probably sponsors H-1B visas for this role.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "supported", "note": "A weaker claim than the source; 'probably' is an extra word, so support is below 1.", "labelled_by": "agent:claude"}
{"id": "v33", "case": "hedged", "retrieval": {"documents": ["conversation--interview-prep-with-priya.md"]}, "claim": "Priya may have suggested that I brush up on window functions.", "cites": [{"label": "P1", "text": "She said the case study uses a real dataset with about 18 months of field-failure records and that they care more about how I structure the problem than about the exact answer. She suggested I brush up on window functions and cohort analysis."}], "expected_verdict": "supported", "note": "A hedged restatement of what the notes say she suggested.", "labelled_by": "agent:claude"}
{"id": "v34", "case": "no_terms", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "Yes.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "supported", "note": "Answer to 'Does Acme sponsor H-1B for this role?'. No content words, numbers or negation: nothing to contradict the cite.", "labelled_by": "agent:claude"}
{"id": "v35", "case": "bad_citation", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "Acme sponsors H-1B for this role.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}, {"label": "P9", "missing": true}], "expected_verdict": "supported", "note": "One good cite supports it; P9 is reported as a bad citation alongside.", "labelled_by": "agent:claude"}
{"id": "v36", "case": "wrong_number", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "Acme employs about 400 people.", "cites": [{"label": "P1", "text": "Acme was founded in 2019 and employs about 300 people."}], "expected_verdict": "partial", "note": "The source says about 300.", "labelled_by": "agent:claude"}
{"id": "v37", "case": "wrong_number", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "The Acme role pays $115,000 to $150,000.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "partial", "note": "The source's ceiling is $140,000.", "labelled_by": "agent:claude"}
{"id": "v38", "case": "wrong_number", "retrieval": {"documents": ["paper--contextual-retrieval-abstract.md"]}, "claim": "The paper tested the method on 12 datasets.", "cites": [{"label": "P1", "text": "Abstract. Retrieval-augmented generation systems split documents into chunks and embed each chunk independently, which discards the context a chunk needs to be understood. We propose prepending a short, document-specific context string to each chunk before embedding and before building the BM25 index. On a benchmark of 9 datasets the method reduced the top-20 retrieval failure rate by 49 percent, and by 67 percent when combined with a reranker. The context strings are generated once per chunk with a language model and cached, so the cost is paid at indexing time rather than at query time."}], "expected_verdict": "partial", "note": "The source says 9 datasets.", "labelled_by": "agent:claude"}
{"id": "v39", "case": "wrong_number", "retrieval": {"documents": ["email--recruiter-intro.md"]}, "claim": "Sam Okafor has filled nine analyst seats at Northwind since 2021.", "cites": [{"label": "P1", "text": "For context, I have filled nine analyst seats at Northwind since 2023, and I like to keep strong candidates moving fast."}], "expected_verdict": "partial", "note": "The source says since 2023.", "labelled_by": "agent:claude"}
{"id": "v40", "case": "wrong_number", "retrieval": {"documents": ["email--recruiter-intro.md"]}, "claim": "Frank is one of four finalists for the analytics lead position.", "cites": [{"label": "P1", "text": "Let me introduce Frank Fu. We had a long call last Thursday and I came away convinced he would do well as analytics lead on your team. He is one of three finalists for the position, and his panel interview is booked for October 6."}], "expected_verdict": "partial", "note": "The source says three finalists; 'four' is checked as 4.", "labelled_by": "agent:claude"}
{"id": "v41", "case": "wrong_number", "retrieval": {"documents": ["conversation--interview-prep-with-priya.md"]}, "claim": "The SQL screen is on 2026-09-23.", "cites": [{"label": "P1", "text": "Next step: SQL screen on 2026-09-22."}], "expected_verdict": "partial", "note": "The source says 2026-09-22.", "labelled_by": "agent:claude"}
{"id": "v42", "case": "wrong_number", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "Acme makes the ZX-8000 drill.", "cites": [{"label": "P1", "text": "AUSTIN, March 12, 2026. Acme Corp, maker of the ZX-9000 industrial drill, announced a $40 million Series B round led by Beta Ventures with participation from Lonestar Capital. The company said it will use the funds to expand its Austin manufacturing facility and grow its analytics and software teams by roughly 40 people over the next year."}], "expected_verdict": "partial", "note": "The source names the ZX-9000; codes must match as written.", "labelled_by": "agent:claude"}
{"id": "v43", "case": "negation", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "Acme does not sponsor H-1B for this role.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "partial", "note": "The source says Acme sponsors H-1B: negation flipped.", "labelled_by": "agent:claude"}
{"id": "v44", "case": "negation", "retrieval": {"documents": ["conversation--interview-prep-with-priya.md"]}, "claim": "The case study does not use a real dataset.", "cites": [{"label": "P1", "text": "She said the case study uses a real dataset with about 18 months of field-failure records and that they care more about how I structure the problem than about the exact answer. She suggested I brush up on window functions and cohort analysis."}], "expected_verdict": "partial", "note": "The source says it uses a real dataset.", "labelled_by": "agent:claude"}
{"id": "v45", "case": "negation", "retrieval": {"documents": ["note--databricks-cost-governance.md"]}, "claim": "Every cluster carried a team tag.", "cites": [{"label": "P1", "text": "The causes were boring. Each squad created its own interactive cluster and nobody shut them down at the end of the day. Autoscaling had no ceiling, so a single bad join could grab two hundred workers. And because no cluster carried a team tag, I had no way to say who was spending what."}], "expected_verdict": "partial", "note": "The source says no cluster carried one: the source negates, the claim does not.", "labelled_by": "agent:claude"}
{"id": "v46", "case": "negation", "retrieval": {"documents": ["note--databricks-cost-governance.md"]}, "claim": "Autoscaling had a ceiling.", "cites": [{"label": "P1", "text": "The causes were boring. Each squad created its own interactive cluster and nobody shut them down at the end of the day. Autoscaling had no ceiling, so a single bad join could grab two hundred workers. And because no cluster carried a team tag, I had no way to say who was spending what."}], "expected_verdict": "partial", "note": "The source says it had no ceiling.", "labelled_by": "agent:claude"}
{"id": "v47", "case": "unrelated", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "Tomatoes need full sun and deep watering.", "cites": [{"label": "P1", "text": "AUSTIN, March 12, 2026. Acme Corp, maker of the ZX-9000 industrial drill, announced a $40 million Series B round led by Beta Ventures with participation from Lonestar Capital. The company said it will use the funds to expand its Austin manufacturing facility and grow its analytics and software teams by roughly 40 people over the next year."}], "expected_verdict": "unsupported", "note": "Nothing in common with the cited passage.", "labelled_by": "agent:claude"}
{"id": "v48", "case": "unrelated", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "Northwind Robotics is hiring a product analyst in Denver.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "unsupported", "note": "True elsewhere (the Beta Ventures email), but not in the cited passage. 'hiring' and 'analyst' do appear in it ('Hiring manager', the heading), so support is 0.33 and the verifier says partial, not unsupported.", "labelled_by": "agent:claude"}
{"id": "v49", "case": "unrelated", "retrieval": {"documents": ["note--fairness-in-ml.md"]}, "claim": "Morgan Reyes recommends terminating idle clusters after 20 minutes.", "cites": [{"label": "P1", "text": "Fairness is not one metric. Demographic parity asks that positive rates match across groups. Equalized odds asks that true positive and false positive rates match. Calibration asks that predicted probabilities mean the same thing for every group. Chouldechova's impossibility result shows you cannot satisfy all three when base rates differ."}], "expected_verdict": "unsupported", "note": "True in another document; the cited passage is about fairness.", "labelled_by": "agent:claude"}
{"id": "v50", "case": "fact", "retrieval": {"documents": []}, "claim": "I live in Austin.", "cites": [{"label": "F1", "predicate": "lives_in", "object_text": "Denver"}], "expected_verdict": "partial", "note": "The fact says Denver.", "labelled_by": "agent:claude"}
{"id": "v51", "case": "uncited", "retrieval": {"documents": []}, "claim": "I think Acme would be a great fit for me.", "cites": [], "expected_verdict": "uncited", "note": "The model's own opinion, with no cite.", "labelled_by": "agent:claude"}
{"id": "v52", "case": "uncited", "retrieval": {"documents": []}, "claim": "Acme sponsors H-1B.", "cites": [], "expected_verdict": "uncited", "note": "True, but nothing is cited, so it is the model's statement.", "labelled_by": "agent:claude"}
{"id": "v53", "case": "bad_citation", "retrieval": {"documents": []}, "claim": "Acme sponsors H-1B.", "cites": [{"label": "P7", "missing": true}], "expected_verdict": "bad_citation", "note": "P7 is not in the retrieval.", "labelled_by": "agent:claude"}
{"id": "v54", "case": "partial_overlap", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "The Acme analyst will manage a team of data engineers in Denver.", "cites": [{"label": "P1", "text": "Acme Corp builds industrial drilling equipment, including the ZX-9000 line. We are hiring a Senior Data Analyst to join the Operations Analytics team in Austin.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)"]}], "expected_verdict": "partial", "note": "Shares Acme, analyst, team and data with the source; managing engineers and Denver are not in it.", "labelled_by": "agent:claude"}
{"id": "v55", "case": "paraphrase", "retrieval": {"documents": ["note--moved-to-denver.md"]}, "claim": "Frank relocated from Austin to Denver.", "cites": [{"label": "P1", "text": "This week I finished moving from Austin to Denver. I signed a lease in the Highland neighborhood, so I now live in Denver for good. Hybrid roles are still fine, but from here on I want positions based in Denver or fully remote."}], "expected_verdict": "partial", "note": "True, but in other words ('relocated' for 'moving', 'Frank' for 'I'): the documented limit.", "labelled_by": "agent:claude"}
{"id": "v56", "case": "paraphrase", "retrieval": {"documents": ["note--databricks-cost-governance.md"]}, "claim": "Each team spun up its own cluster and left it running overnight.", "cites": [{"label": "P1", "text": "The causes were boring. Each squad created its own interactive cluster and nobody shut them down at the end of the day. Autoscaling had no ceiling, so a single bad join could grab two hundred workers. And because no cluster carried a team tag, I had no way to say who was spending what."}], "expected_verdict": "partial", "note": "True in other words ('squad', 'created', 'nobody shut them down'); also the source's 'no cluster carried a team tag' negates matched words.", "labelled_by": "agent:claude"}
{"id": "v57", "case": "paraphrase", "retrieval": {"documents": ["conversation--interview-prep-with-priya.md"]}, "claim": "Priya wants candidates to review window functions and cohort analysis.", "cites": [{"label": "P1", "text": "She said the case study uses a real dataset with about 18 months of field-failure records and that they care more about how I structure the problem than about the exact answer. She suggested I brush up on window functions and cohort analysis."}], "expected_verdict": "partial", "note": "Roughly what the notes say, in other words.", "labelled_by": "agent:claude"}
{"id": "v58", "case": "paraphrase", "retrieval": {"documents": ["news--acme-series-b.md"]}, "claim": "The startup secured fresh capital from a VC firm.", "cites": [{"label": "P1", "text": "AUSTIN, March 12, 2026. Acme Corp, maker of the ZX-9000 industrial drill, announced a $40 million Series B round led by Beta Ventures with participation from Lonestar Capital. The company said it will use the funds to expand its Austin manufacturing facility and grow its analytics and software teams by roughly 40 people over the next year."}], "expected_verdict": "unsupported", "note": "True in substance (a $40 million round led by Beta Ventures), with almost no shared words: the documented limit.", "labelled_by": "agent:claude"}
{"id": "v59", "case": "no_terms", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "$115,000 to $140,000.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "partial", "note": "A bare figure: the source states it, but no words say what it measures.", "labelled_by": "agent:claude"}
{"id": "v60", "case": "no_terms", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "No.", "cites": [{"label": "P1", "text": "Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. Hiring manager: Priya Natarajan.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)", "Compensation and visa"]}], "expected_verdict": "partial", "note": "Answer to 'Is the role fully remote?' (it is hybrid). A negation with nothing negated in the source is capped at partial.", "labelled_by": "agent:claude"}
{"id": "v61", "case": "known_limit", "retrieval": {"documents": ["conversation--interview-prep-with-priya.md"]}, "claim": "Priya required that I brush up on window functions.", "cites": [{"label": "P1", "text": "She said the case study uses a real dataset with about 18 months of field-failure records and that they care more about how I structure the problem than about the exact answer. She suggested I brush up on window functions and cohort analysis."}], "expected_verdict": "partial", "note": "Overstates the source ('suggested'). Known limit: certainty is not checked, so the verifier says supported (a counted precision error).", "labelled_by": "agent:claude"}
{"id": "v62", "case": "known_limit", "retrieval": {"documents": ["note--databricks-cost-governance.md"]}, "claim": "The Databricks invoice fell from $157,000 a month to $41,000.", "cites": [{"label": "P1", "text": "When we finished migrating to Databricks I expected our compute spend to fall. Three months later the invoice had nearly quadrupled, from about $41,000 a month to $157,000, and the first person to notice was someone in finance."}], "expected_verdict": "partial", "note": "Reverses the direction (it rose). Known limit: relations between quantities are not checked, so the verifier says supported (a counted precision error).", "labelled_by": "agent:claude"}
{"id": "v63", "case": "known_limit", "retrieval": {"documents": ["job_description--acme-senior-data-analyst.md"]}, "claim": "Acme's Austin analytics team is hiring interns.", "cites": [{"label": "P1", "text": "Acme Corp builds industrial drilling equipment, including the ZX-9000 line. We are hiring a Senior Data Analyst to join the Operations Analytics team in Austin.", "heading_path": ["Senior Data Analyst, Acme Corp (Austin, TX)"]}], "expected_verdict": "partial", "note": "Adds one detail (interns) to five matching words. Known limit: one unsupported word among many matching ones stays above 0.6 (a counted precision error).", "labelled_by": "agent:claude"}
```

- [ ] **Step 2: Write the failing unit tests**

Create `test/unit/eval-verifier.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  parseVerifierSet, toClaim, verifierReport, verifierGate, verifierLine, renderVerifierRun, VERIFIER_PRECISION_MIN, type VerifierItem,
} from "../../src/eval/verifier.js";
import type { Verdict } from "../../src/verify/verify.js";

const item = (over: Partial<VerifierItem> = {}): VerifierItem => ({
  id: "v1", case: "exact", retrieval: { documents: ["news--acme-series-b.md"] }, claim: "Acme was founded in 2019.",
  cites: [{ label: "P1", text: "Acme was founded in 2019 and employs about 300 people." }], expected_verdict: "supported", note: "n", labelled_by: "agent:claude",
  ...over,
});

const pairs = (spec: [Verdict, Verdict, number][]) => spec.flatMap(([expected, predicted, n]) => Array.from({ length: n }, () => ({ expected, predicted })));

describe("verifierReport", () => {
  it("computes precision and recall of supported, accuracy, and the confusion matrix (rows labelled, columns verifier)", () => {
    const r = verifierReport(pairs([["supported", "supported", 18], ["supported", "partial", 2], ["partial", "supported", 2], ["partial", "partial", 6], ["unsupported", "unsupported", 2]]));
    expect(r.n).toBe(30);
    expect(r.precision).toBeCloseTo(18 / 20, 10);
    expect(r.recall).toBeCloseTo(18 / 20, 10);
    expect(r.accuracy).toBeCloseTo(26 / 30, 10);
    expect(r.confusion.supported).toEqual({ supported: 18, partial: 2, unsupported: 0, uncited: 0, bad_citation: 0 });
    expect(r.confusion.partial.supported).toBe(2);
  });

  it("leaves precision and recall undefined (null) when nothing is marked or labelled supported", () => {
    const r = verifierReport(pairs([["partial", "unsupported", 3]]));
    expect(r).toMatchObject({ n: 3, precision: null, recall: null, accuracy: 0 });
    expect(verifierReport([])).toMatchObject({ n: 0, precision: null, recall: null, accuracy: 0 });
  });
});

describe("verifierGate and verifierLine", () => {
  it("fails below 0.9 precision of supported, passes at exactly 0.9, and fails when precision is undefined", () => {
    expect(VERIFIER_PRECISION_MIN).toBe(0.9);
    expect(verifierGate(verifierReport(pairs([["supported", "supported", 9], ["partial", "supported", 1]])))).toEqual([]);
    expect(verifierGate(verifierReport(pairs([["supported", "supported", 8], ["partial", "supported", 2]])))).toEqual(["verifier: precision of supported is 0.800, below 0.9"]);
    expect(verifierGate(verifierReport(pairs([["supported", "partial", 3]])))).toEqual(["verifier: no claim was marked supported, so precision of supported is undefined"]);
  });

  it("prints n, precision, recall and accuracy on one line", () => {
    expect(verifierLine(verifierReport(pairs([["supported", "supported", 9], ["partial", "supported", 1], ["supported", "partial", 1]])))).toBe(
      "verifier  n=11  supported precision=0.90 recall=0.90  accuracy=0.82",
    );
    expect(verifierLine(verifierReport([]))).toBe("verifier  n=0  supported precision=n/a recall=n/a  accuracy=0.00");
  });
});

describe("parseVerifierSet and toClaim", () => {
  it("parses one item per line and rejects bad JSON, unknown keys, an unknown case and duplicate ids, with the line number", () => {
    const line = JSON.stringify(item());
    expect(parseVerifierSet(`${line}\n\n`)).toHaveLength(1);
    expect(() => parseVerifierSet("{")).toThrow(/^verifier line 1: invalid JSON/);
    expect(() => parseVerifierSet(`${line}\n${JSON.stringify({ ...item({ id: "v2" }), extra: 1 })}`)).toThrow(/^verifier line 2: .*extra/);
    expect(() => parseVerifierSet(JSON.stringify({ ...item(), case: "vibes" }))).toThrow(/^verifier line 1: case/);
    expect(() => parseVerifierSet(`${line}\n${line}`)).toThrow("verifier line 2: duplicate id v1");
  });

  it("turns passages, facts and missing labels into what the judge reads", () => {
    const c = toClaim(item({
      cites: [
        { label: "P1", text: "Base pay.", heading_path: ["Job", "Compensation"] },
        { label: "F1", predicate: "visa_status", object_text: "F-1 OPT" },
        { label: "P9", missing: true },
      ],
    }));
    expect(c).toEqual({
      text: "Acme was founded in 2019.",
      labels: ["P1", "F1", "P9"],
      cited: [{ label: "P1", kind: "passage", text: "Job > Compensation\nBase pay." }, { label: "F1", kind: "fact", text: "visa status: F-1 OPT" }],
      cites: [],
      badLabels: [{ label: "P9", reason: "not in the retrieval" }],
    });
  });
});

describe("renderVerifierRun", () => {
  it("marks each item ok or MISS, prints the confusion matrix and the summary line", () => {
    const result = (verdict: Verdict, support: number | null) => ({
      claim: "c", labels: [], verdict, support, matchedTerms: [], missingTerms: [], missingNumbers: [], negationMismatch: false, badLabels: [], cites: [],
    });
    const items = [
      { id: "v1", case: "exact" as const, expected: "supported" as const, predicted: "supported" as const, result: result("supported", 1) },
      { id: "v2", case: "known_limit" as const, expected: "partial" as const, predicted: "supported" as const, result: result("supported", 0.75) },
    ];
    const lines = renderVerifierRun({ items, report: verifierReport(items) });
    expect(lines.slice(0, 2)).toEqual([
      "ok    v1    exact           supported 1.00",
      "MISS  v2    known_limit     expected partial, got supported 0.75",
    ]);
    expect(lines).toContain("confusion (rows: labelled, columns: verifier)");
    expect(lines).toContain("partial" + " ".repeat(6) + "            1            0            0            0            0");
    expect(lines.at(-1)).toBe("verifier  n=2  supported precision=0.50 recall=1.00  accuracy=0.50");
  });
});
```

Create `test/unit/verifier-fixtures.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseVerifierSet, VERIFIER_CASES } from "../../src/eval/verifier.js";
import { splitFrontMatter, normalizeWhitespace } from "../../src/eval/run.js";

const set = async () => parseVerifierSet(await readFile("eval/verifier.jsonl", "utf8"));

describe("eval/verifier.jsonl", () => {
  it("has at least 40 items covering every case, at least 20 labelled supported, all labelled by an agent until the owner adds their own", async () => {
    const items = await set();
    expect(items.length).toBeGreaterThanOrEqual(40);
    for (const c of VERIFIER_CASES) expect([c, items.some((i) => i.case === c)]).toEqual([c, true]);
    expect(items.filter((i) => i.expected_verdict === "supported").length).toBeGreaterThanOrEqual(20);
    expect(items.every((i) => i.labelled_by === "agent:claude" || i.labelled_by === "owner")).toBe(true);
  });

  it("quotes every passage verbatim from a fixture the item names, once front matter is stripped", async () => {
    for (const item of await set()) {
      for (const c of item.cites) {
        if (!("text" in c)) continue;
        const bodies = await Promise.all(item.retrieval.documents.map(async (d) => normalizeWhitespace(splitFrontMatter(await readFile(`eval/corpus/${d}`, "utf8")).body)));
        expect([item.id, bodies.some((b) => b.includes(normalizeWhitespace(c.text)))]).toEqual([item.id, true]);
      }
    }
  });

  it("labels uncited items uncited and items whose only cites are missing bad_citation", async () => {
    for (const item of await set()) {
      if (item.cites.length === 0) expect([item.id, item.expected_verdict]).toEqual([item.id, "uncited"]);
      if (item.cites.length > 0 && item.cites.every((c) => "missing" in c)) expect([item.id, item.expected_verdict]).toEqual([item.id, "bad_citation"]);
    }
  });
});
```

- [ ] **Step 3: Write the failing integration test**

Create `test/integration/eval-verifier.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { runVerifierFile, verifierGate, verifierLine } from "../../src/eval/verifier.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("the verifier eval on eval/verifier.jsonl", () => {
  it("passes the gate (precision of supported at least 0.9) with real Postgres stems, and writes nothing", async () => {
    const run = (await runVerifierFile(sql, "eval/verifier.jsonl"))!;
    const misses = run.items.filter((i) => i.expected !== i.predicted).map((i) => `${i.id} ${i.case}: expected ${i.expected}, got ${i.predicted}`);
    expect([verifierLine(run.report), verifierGate(run.report)]).toEqual([verifierLine(run.report), []]);
    expect(run.report.precision).toBeGreaterThanOrEqual(0.9);
    // Every miss is one the set documents: the three known limits and the two notes that say "the verifier says partial".
    expect(misses).toEqual([
      "v10 exact: expected supported, got partial",
      "v48 unrelated: expected unsupported, got partial",
      "v61 known_limit: expected partial, got supported",
      "v62 known_limit: expected partial, got supported",
      "v63 known_limit: expected partial, got supported",
    ]);
    expect((await sql`select id from brain.verification_log`).length).toBe(0);
  });

  it("returns null for a missing file", async () => {
    expect(await runVerifierFile(sql, "eval/no-such-file.jsonl")).toBeNull();
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run test/unit/eval-verifier.test.ts test/unit/verifier-fixtures.test.ts; bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-verifier.test.ts`
Expected: FAIL: `Error: Cannot find module '../../src/eval/verifier.js'` for all three files, `Tests no tests`.

- [ ] **Step 5: Write `src/eval/verifier.ts`**

Create `src/eval/verifier.ts`:
```ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Db } from "../db.js";
import { VERDICTS, VerdictSchema, factText, passageText, verifyTexts, type ClaimResult, type ClaimToJudge, type Verdict } from "../verify/verify.js";

/**
 * The verifier's own eval (spec §7, roadmap Phase 5 task 6). Each item of eval/verifier.jsonl is a claim, the texts it
 * cites (quoted verbatim from eval/corpus, or a fact written out), and the verdict a careful reader assigns. Items carry
 * their cited texts inline, so the set needs no ingested corpus and no retrieval ids: it runs the same judging code as
 * brain_verify (verify.ts) with stems from Postgres, and nothing else. No model and no Voyage call.
 */

/** What each item exercises; the fixture test requires every case at least once. */
export const VERIFIER_CASES = [
  "exact", "paraphrase", "wrong_number", "negation", "unrelated", "two_passages", "no_terms", "fact", "number_form", "date_form",
  "hedged", "partial_overlap", "uncited", "bad_citation", "known_limit",
] as const;

const PassageCiteSchema = z.object({
  label: z.string().regex(/^P\d+$/),
  /** Verbatim from one of the item's retrieval.documents (whitespace may differ). */
  text: z.string().min(1),
  heading_path: z.array(z.string()).optional(),
}).strict();
const FactCiteSchema = z.object({ label: z.string().regex(/^F\d+$/), predicate: z.string().min(1), object_text: z.string().min(1) }).strict();
/** A label the retrieval does not have. */
const MissingCiteSchema = z.object({ label: z.string().min(1), missing: z.literal(true) }).strict();

export const VerifierItemSchema = z.object({
  id: z.string().min(1),
  case: z.enum(VERIFIER_CASES),
  /** The fixture files (eval/corpus) the passage texts are quoted from. */
  retrieval: z.object({ documents: z.array(z.string().min(1)) }).strict(),
  claim: z.string().min(1).max(2000),
  cites: z.array(z.union([PassageCiteSchema, FactCiteSchema, MissingCiteSchema])),
  expected_verdict: VerdictSchema,
  note: z.string().min(1),
  /** agent:<name> or owner. */
  labelled_by: z.string().min(1),
}).strict();
export type VerifierItem = z.infer<typeof VerifierItemSchema>;

/** One JSON object per line; blank lines are ignored. Throws with the line number on the first invalid line or duplicate id. */
export function parseVerifierSet(text: string): VerifierItem[] {
  const items: VerifierItem[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`verifier line ${i + 1}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = VerifierItemSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`verifier line ${i + 1}: ${parsed.error.issues.map((x) => (x.path.length ? `${x.path.join(".")}: ${x.message}` : x.message)).join("; ")}`);
    }
    if (seen.has(parsed.data.id)) throw new Error(`verifier line ${i + 1}: duplicate id ${parsed.data.id}`);
    seen.add(parsed.data.id);
    items.push(parsed.data);
  }
  return items;
}

/** An item as the judge sees it: passages as heading path plus text, facts as predicate plus object, missing labels as bad. */
export function toClaim(item: VerifierItem): ClaimToJudge {
  const claim: ClaimToJudge = { text: item.claim, labels: item.cites.map((c) => c.label), cited: [], cites: [], badLabels: [] };
  for (const c of item.cites) {
    if ("missing" in c) claim.badLabels.push({ label: c.label, reason: "not in the retrieval" });
    else if ("text" in c) claim.cited.push({ label: c.label, kind: "passage", text: passageText(c.heading_path ?? [], c.text) });
    else claim.cited.push({ label: c.label, kind: "fact", text: factText(c.predicate, c.object_text) });
  }
  return claim;
}

export interface VerifierReport {
  n: number;
  /** Share of items whose verdict equals the label. */
  accuracy: number;
  /** Of the items the verifier marked supported, the share labelled supported; null when it marked none. */
  precision: number | null;
  /** Of the items labelled supported, the share the verifier marked supported; null when none is labelled supported. */
  recall: number | null;
  /** confusion[expected][predicted]: item counts. */
  confusion: Record<Verdict, Record<Verdict, number>>;
}

export function verifierReport(pairs: { expected: Verdict; predicted: Verdict }[]): VerifierReport {
  const confusion = Object.fromEntries(VERDICTS.map((e) => [e, Object.fromEntries(VERDICTS.map((p) => [p, 0]))])) as Record<Verdict, Record<Verdict, number>>;
  for (const { expected, predicted } of pairs) confusion[expected][predicted]++;
  const tp = confusion.supported.supported;
  const markedSupported = VERDICTS.reduce((s, e) => s + confusion[e].supported, 0);
  const labelledSupported = VERDICTS.reduce((s, p) => s + confusion.supported[p], 0);
  const correct = VERDICTS.reduce((s, v) => s + confusion[v][v], 0);
  return {
    n: pairs.length,
    accuracy: pairs.length ? correct / pairs.length : 0,
    precision: markedSupported ? tp / markedSupported : null,
    recall: labelledSupported ? tp / labelledSupported : null,
    confusion,
  };
}

/** The gate's floor for precision of `supported`: a claim wrongly marked supported is worse than one wrongly flagged. */
export const VERIFIER_PRECISION_MIN = 0.9;
const EPSILON = 1e-9;

/** Reasons the verifier set fails the gate; empty means pass. */
export function verifierGate(r: VerifierReport): string[] {
  if (r.precision === null) return ["verifier: no claim was marked supported, so precision of supported is undefined"];
  if (r.precision < VERIFIER_PRECISION_MIN - EPSILON) return [`verifier: precision of supported is ${r.precision.toFixed(3)}, below ${VERIFIER_PRECISION_MIN}`];
  return [];
}

const ratio = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));

/** The one line `eval run` prints. */
export function verifierLine(r: VerifierReport): string {
  return `verifier  n=${r.n}  supported precision=${ratio(r.precision)} recall=${ratio(r.recall)}  accuracy=${ratio(r.accuracy)}`;
}

export interface VerifierItemResult {
  id: string;
  case: VerifierItem["case"];
  expected: Verdict;
  predicted: Verdict;
  result: ClaimResult;
}

export interface VerifierRun {
  items: VerifierItemResult[];
  report: VerifierReport;
}

/** Judges every item with one stem query. Read-only: it writes nothing (not even verification_log). */
export async function runVerifierSet(sql: Db, items: VerifierItem[]): Promise<VerifierRun> {
  const results = await verifyTexts(sql, items.map(toClaim));
  const out = items.map((it, i) => ({ id: it.id, case: it.case, expected: it.expected_verdict, predicted: results[i].verdict, result: results[i] }));
  return { items: out, report: verifierReport(out) };
}

/** runVerifierSet on a file; null when the file does not exist. */
export async function runVerifierFile(sql: Db, path: string): Promise<VerifierRun | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return runVerifierSet(sql, parseVerifierSet(text));
}

/** `brain eval verifier`: one line per item (ok or MISS), the confusion matrix, and the summary line. */
export function renderVerifierRun(run: VerifierRun): string[] {
  const support = (s: number | null) => (s === null ? "-" : s.toFixed(2));
  const lines = run.items.map((i) =>
    i.expected === i.predicted
      ? `ok    ${i.id.padEnd(5)} ${i.case.padEnd(15)} ${i.predicted} ${support(i.result.support)}`
      : `MISS  ${i.id.padEnd(5)} ${i.case.padEnd(15)} expected ${i.expected}, got ${i.predicted} ${support(i.result.support)}`,
  );
  const w = 13;
  lines.push("", "confusion (rows: labelled, columns: verifier)", "".padEnd(w) + VERDICTS.map((v) => v.padStart(w)).join(""));
  for (const e of VERDICTS) lines.push(e.padEnd(w) + VERDICTS.map((p) => String(run.report.confusion[e][p]).padStart(w)).join(""));
  lines.push("", verifierLine(run.report));
  return lines;
}
```

- [ ] **Step 6: Score it in every eval run (`src/eval/run.ts`)**

In `src/eval/run.ts`, replace:
```ts
import { parseAuthor, type Author } from "../ingest/author.js";
```
with:
```ts
import { parseAuthor, type Author } from "../ingest/author.js";
import { runVerifierFile, type VerifierRun } from "./verifier.js";
```

In `src/eval/run.ts`, replace:
```ts
  /** Voyage spend of this run (searches and anything else under the eval client) in brain_eval's ledger. Kept out of Report. */
  voyage: VoyageSpend;
}
```
with:
```ts
  /** Voyage spend of this run (searches and anything else under the eval client) in brain_eval's ledger. Kept out of Report. */
  voyage: VoyageSpend;
  /** The citation verifier scored on its own labelled set (no model or Voyage call); null when the file is missing. Kept out of Report. */
  verifier: VerifierRun | null;
}
```

In `src/eval/run.ts`, replace:
```ts
/** Runs every golden item (and its paraphrases) against the context's database, which must be the eval database. */
export async function runEval(ctx: Ctx, goldenPath: string): Promise<EvalRun> {
```
with:
```ts
/**
 * Runs every golden item (and its paraphrases) against the context's database, which must be the eval database, then
 * scores the citation verifier on verifierPath with that database's stems.
 */
export async function runEval(ctx: Ctx, goldenPath: string, verifierPath = "eval/verifier.jsonl"): Promise<EvalRun> {
```

In `src/eval/run.ts`, replace:
```ts
    voyage: await voyageSpendSince(ctx.sql, startedAt, EVAL_CLIENT),
  };
```
with:
```ts
    voyage: await voyageSpendSince(ctx.sql, startedAt, EVAL_CLIENT),
    verifier: await runVerifierFile(ctx.sql, verifierPath),
  };
```

- [ ] **Step 7: The CLI: `eval run` prints and gates it; `eval verifier` shows the detail**

In `src/cli.ts`, replace:
```ts
  .option("--baseline <path>", "baseline file", "eval/baseline.json")
```
with:
```ts
  .option("--baseline <path>", "baseline file", "eval/baseline.json")
  .option("--verifier <path>", "citation verifier set", "eval/verifier.jsonl")
```

In `src/cli.ts`, replace:
```ts
    const { abstained, falseAnswer } = await import("./eval/metrics.js");
```
with:
```ts
    const { abstained, falseAnswer } = await import("./eval/metrics.js");
    const { verifierGate, verifierLine } = await import("./eval/verifier.js");
```

In `src/cli.ts`, replace:
```ts
      const run = await runEval(ctx, opts.golden);
```
with:
```ts
      const run = await runEval(ctx, opts.golden, opts.verifier);
```

In `src/cli.ts`, replace:
```ts
      if (opts.gate) failures.push(...attributionGate(run.attribution));
```
with:
```ts
      if (opts.gate) failures.push(...attributionGate(run.attribution));
      if (opts.gate && run.verifier) failures.push(...verifierGate(run.verifier.report));
```

In `src/cli.ts`, replace:
```ts
        console.log(evalVoyageLine(run.voyage));
```
with:
```ts
        console.log(evalVoyageLine(run.voyage));
        console.log(run.verifier ? verifierLine(run.verifier.report) : `verifier  no set at ${opts.verifier}`);
```

In `src/cli.ts`, replace:
```ts
program
  .command("backfill")
```
with:
```ts
evalCmd
  .command("verifier")
  .description("Score the citation verifier on its labelled set: each item, the confusion matrix, precision and recall of supported (no model or Voyage call)")
  .option("--file <path>", "verifier set", "eval/verifier.jsonl")
  .option("--gate", "exit 1 when precision of supported is below 0.9")
  .option("--json")
  .action(async (opts) => {
    const { makeEvalCtx, assertEvalConnection } = await import("./eval/db.js");
    const { runVerifierFile, renderVerifierRun, verifierGate } = await import("./eval/verifier.js");
    const ctx = makeEvalCtx();
    try {
      await assertEvalConnection(ctx.sql);
      const run = await runVerifierFile(ctx.sql, opts.file);
      if (!run) throw new Error(`No verifier set at ${opts.file}`);
      const failures = opts.gate ? verifierGate(run.report) : [];
      if (opts.json) console.log(JSON.stringify({ ...run, failures }, null, 2));
      else for (const line of [...renderVerifierRun(run), ...failures.map((f) => `GATE: ${f}`)]) console.log(line);
      if (failures.length) process.exitCode = 1;
    } finally {
      await ctx.sql.end();
    }
  });

program
  .command("backfill")
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/unit/eval-verifier.test.ts test/unit/verifier-fixtures.test.ts && bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-verifier.test.ts`
Expected: PASS (unit 7 + 3 tests, integration 2).

- [ ] **Step 9: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green (unit 361, integration 303).

- [ ] **Step 10: The verifier eval and the full eval on `brain_eval`**

Run:
```bash
npm run brain -- eval verifier --gate; echo "exit $?"
npm run eval:run
```
Expected: `eval verifier` prints 63 lines, all `ok` except
```
MISS  v10   exact           expected supported, got partial 0.63
MISS  v48   unrelated       expected unsupported, got partial 0.33
MISS  v61   known_limit     expected partial, got supported 0.60
MISS  v62   known_limit     expected partial, got supported 0.75
MISS  v63   known_limit     expected partial, got supported 0.83
```
then the confusion matrix (`supported` row `34 1 0 0 0`, `partial` row `3 18 0 0 0`, `unsupported` row `0 1 3 0 0`, `uncited` row `0 0 0 2 0`, `bad_citation` row `0 0 0 0 1`), `verifier  n=63  supported precision=0.92 recall=0.97  accuracy=0.92`, and `exit 0`. `eval:run` prints the retrieval report as in Task 3, then after the `voyage …` line `verifier  n=63  supported precision=0.92 recall=0.97  accuracy=0.92`; the ranks do not move.

- [ ] **Step 11: Commit**

```bash
git add src/eval/verifier.ts eval/verifier.jsonl test/unit/eval-verifier.test.ts test/unit/verifier-fixtures.test.ts test/integration/eval-verifier.test.ts src/eval/run.ts src/cli.ts
git commit -m "Verifier eval: 63 agent-labelled claims with inline cited texts; precision/recall of supported and the confusion matrix; gate at 0.9 precision

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: README: "Checking an answer against its sources"

**Files:**
- Modify: `README.md`

The owner shows this logic to professionals, so the section defines every rule and threshold, says plainly what is not checked, explains how to read the output with one worked example from the eval corpus (the output below was produced by `brain verify` on a database holding that passage), states the eval numbers and the labelling policy, and says the labels were written by an agent and need the owner's review. The commands, the tool list, the read-only count, the eval gate and the `retrieval_log` paragraph are updated with it.

- [ ] **Step 1: Commands**

In `README.md`, replace:
````markdown
npm run brain -- ask "<question>"
````
with:
````markdown
npm run brain -- ask "<question>"
npm run brain -- verify <retrieval-id> --claims <claims.json>
npm run brain -- verify <retrieval-id> --claim "<text>" [--cite P1 --cite F2]
````

In `README.md`, replace:
````markdown
npm run brain -- eval run [--golden eval/golden.jsonl] [--baseline eval/baseline.json] [--compare] [--gate] [--accept] [--json]
````
with:
````markdown
npm run brain -- eval run [--golden eval/golden.jsonl] [--baseline eval/baseline.json] [--verifier eval/verifier.jsonl] [--compare] [--gate] [--accept] [--json]
npm run brain -- eval verifier [--file eval/verifier.jsonl] [--gate] [--json]
````

- [ ] **Step 2: The eval gate, the tools and the read-only count**

In `README.md`, replace:
````markdown
`npm run eval:gate` exits 1 on a regression (recall@10 or MRR down more than 0.02, abstention down, any degraded search, a changed golden set, or no baseline).
````
with:
````markdown
`npm run eval:gate` exits 1 on a regression (recall@10 or MRR down more than 0.02, abstention down, any degraded search, a changed golden set, no baseline, or precision of the citation verifier's `supported` below 0.9 on `eval/verifier.jsonl`; see "Checking an answer against its sources").
````

In `README.md`, replace:
````markdown
The server exposes the knowledge base as ten tools:
````
with:
````markdown
The server exposes the knowledge base as eleven tools:
````

In `README.md`, replace:
````markdown
- `brain_explain`: replay a logged search from its retrieval id: mode, candidate counts, timings, and each passage's ranks and score.
````
with:
````markdown
- `brain_explain`: replay a logged search from its retrieval id: mode, candidate counts, timings, and each passage's ranks and score.
- `brain_verify`: check each claim of an answer against the passages and facts it cites in a logged search, with no model call (see "Checking an answer against its sources").
````

In `README.md`, replace:
````markdown
With `BRAIN_MCP_READONLY=1` only the seven read tools (the first seven) are exposed.
````
with:
````markdown
With `BRAIN_MCP_READONLY=1` only the eight read tools (the first eight) are exposed. `brain_verify` counts as a read tool: it changes nothing in the knowledge base and only writes its audit row, as `brain_search` writes `brain.retrieval_log`.
````

- [ ] **Step 3: "Reading a search result" points to the check**

In `README.md`, replace:
````markdown
`brain ask` gives its model the same mode, scores and authors, and prints its sources under the answer.
````
with:
````markdown
`brain ask` gives its model the same mode, scores and authors, prints its sources under the answer, and checks each sentence against what it cites. `brain_verify` does the same check for any MCP client.
````

In `README.md`, replace:
````markdown
Rows logged before migration 011 have only chunk ids, layers and a top score (which may be an RRF value); explain says "logged before evidence v2".
````
with:
````markdown
Rows logged before migration 011 have only chunk ids, layers and a top score (which may be an RRF value); explain says "logged before evidence v2". From migration 012 each row also keeps `facts`, the facts the search returned in order (index 0 is F1), which `brain_verify` resolves F labels from.
````

- [ ] **Step 4: The section**

In `README.md`, replace:
````markdown
### Claude Code (this Mac)
````
with:
````markdown
### Checking an answer against its sources

`brain_verify` (MCP), `npm run brain -- verify` and `brain ask` check an answer claim by claim against the passages and facts each claim cites, so you can see what came from the knowledge base and what the model added. The check is deterministic: no model is called, so it costs nothing per query and gives the same verdict every time. The code is `src/verify/` (`terms.ts` for the extraction, `verify.ts` for the method, `resolve.ts` for looking up cites); every verification is logged to `brain.verification_log`.

How a claim is checked:

1. Cites are resolved through the search the answer came from: `P3` is the third passage of that retrieval (its text is read from `brain.chunks`; a fallback passage is cut from the document's raw text by its character window), `F1` is the first fact that search returned, as it was then. A chunk id or fact id also works. A passage's cited text is its heading path plus its content; a fact's is its predicate (underscores as spaces) plus its value.
2. Numbers, dates and codes are read from the claim and normalised: `1,000` is `1000`; `~11%`, `11 %` and `11 percent` are `11%`; `$115k`, `$115K`, `$115,000` and `115,000 dollars` are `$115000` (k, m, b, thousand, million and billion scale the number); `Sep 29, 2026`, `29 September 2026` and `2026-09-29` are `2026-09-29`; `September 2026` is `2026-09`; `October 6` is `--10-06`; `3rd` is `3rd`; `two` to `ninety` and `two hundred` are numbers (`one` and `first` are not, since they are usually not counts); a token with a letter and a digit (`H-1B`, `F-1`, `ZX-9000`) is a code, compared as written. Every one of them must appear in the cited texts. A full date in a source also states its month, year and month-day; a sum of money also states the bare amount.
3. Content terms are the rest of the claim's words, stemmed by Postgres (`to_tsvector('english', …)`, the same stemming as the keyword index), without stopwords, without negation words, and without answer words such as "yes", "also" and "however". Support is the share of the claim's distinct content terms that appear among the cited texts' stems.
4. Negation: the words not, no, never, without, none, neither, nor, cannot and anything ending in n't are read from the raw text. There is a negation mismatch when the claim has one and no sentence of the cited texts has one together with a matched term, or the other way round.

Verdicts, from the first rule that applies:

| Verdict | Rule |
|---|---|
| `bad_citation` | Every cite names nothing in that search (`P9` when it returned 5 passages; `F1` on a search logged before facts were recorded; a passage since re-chunked). Bad cites next to a good one are listed but do not change the verdict. |
| `uncited` | No cites: the model's own statement. |
| `supported` | Support at least 0.6, every number present, no negation mismatch. A claim with no content terms ("Yes [P1].") is supported when it has no numbers and no negation mismatch, since it states nothing the source could contradict; with numbers it is at most partial, because nothing says what the figure measures. |
| `partial` | Support at least 0.3, or support at least 0.6 with a missing number or a negation mismatch. |
| `unsupported` | Support below 0.3. A missing number never raises a verdict. |

What it does not check: logic and reasoning; a paraphrase in different words (a correct claim can be partial or unsupported, which is the safe direction); sarcasm; certainty ("may" against "will"); relations between quantities ("more than", "fell from X to Y": the numbers are present, so the order is not checked); and an added detail when most of the claim's words match (one new word among five matching ones still passes 0.6). Slash dates (`9/29/2026`) are read as three numbers, and a bare `5m` is read as 5 million.

Reading the output. Worked example: a search returned the compensation section of `eval/corpus/job_description--acme-senior-data-analyst.md` as P1 ("Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. …", under the heading "Compensation and visa"), and the answer was "Acme sponsors H-1B visas for this role [P1]. The base salary is $115k to $150k [P1]. The role is not hybrid [P1]. The company will pay for relocation to Austin [P1]. It looks like a strong fit."

```
verification 12bf8876-… · retrieval a4cf4454-… · 5 claims
✓ supported 1.00 — "Acme sponsors H-1B visas for this role." [P1]
~ partial 1.00 — "The base salary is $115k to $150k." [P1]
    missing numbers: $150000
~ partial 1.00 — "The role is not hybrid." [P1]
    negation differs from the cited text
✗ unsupported 0.25 — "The company will pay for relocation to Austin." [P1]
    missing terms: company, pay, relocation
○ uncited - — "It looks like a strong fit."
    no citation: nothing from the knowledge base backs this
Summary: 1 supported, 2 partial, 1 unsupported, 1 uncited
```

Each line is the verdict, the support (`-` when there is none), the claim and its cites. The line under a claim says what its cited text lacks: terms in the claim's own words, numbers in their normalised form. "visas" in the first claim matched the heading. `$115k` matched `$115,000`; `$150k` did not. Present anything not `supported` as the model's own or as weakly supported; the server instructions ask MCP clients to do exactly that after calling `brain_verify`.

`brain_verify` takes at most 50 claims of at most 2,000 characters, with at most 20 cites each. `brain ask` splits its own answer into sentences (a line break, or `.` `!` `?` followed by a word that does not start in lower case, never after `e.g.`, `Dr.`, `U.S.` or an initial, never at a decimal point), cites the `[P#]`/`[F#]` labels inside each sentence, and prints the check under its sources.

How well it works is measured on `eval/verifier.jsonl`: 63 claims quoted against the eval corpus, covering restatements, paraphrases, wrong numbers, negation flips, unrelated claims, claims spanning two passages, claims without content words, facts, number and date forms, hedging, added details, and three known limits (certainty, a reversed quantity relation, one added detail) labelled not supported so they count as errors. `npm run brain -- eval verifier` prints each item, the confusion matrix, precision and recall of `supported`, and accuracy; `eval run` prints the one-line summary, and `eval run --gate` fails when precision of `supported` is below 0.9 (a claim wrongly marked supported is worse than one wrongly flagged). On 2026-10-03: precision 0.92, recall 0.97, accuracy 0.92 (34 of 37 claims marked supported were labelled supported; the three errors are the known limits). A paraphrase that is true but the method cannot recognise is labelled with the verdict the method is designed to give, so these numbers measure the stated method; a claim labelled `supported` is always one its cited text really supports. These labels were written by an agent (`labelled_by: "agent:claude"`), not by the owner: review them, and add your own with `labelled_by: "owner"`.

### Claude Code (this Mac)
````

- [ ] **Step 5: Check the README against the code**

Run: `grep -n "SUPPORTED_MIN = \|PARTIAL_MIN = \|VERIFIER_PRECISION_MIN = \|MAX_CLAIMS = \|MAX_CLAIM_CHARS = \|MAX_CITES = " src/verify/*.ts src/eval/verifier.ts && grep -c "brain_verify" README.md && npm run test:unit`
Expected: `SUPPORTED_MIN = 0.6`, `PARTIAL_MIN = 0.3`, `VERIFIER_PRECISION_MIN = 0.9`, `MAX_CLAIMS = 50`, `MAX_CLAIM_CHARS = 2000`, `MAX_CITES = 20`, matching the README's numbers; at least 6 mentions of `brain_verify`; unit suite green (361).

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "README: checking an answer against its sources (verdicts, thresholds, what is and is not checked, worked example, eval numbers)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Turn verification on in the real knowledge base (run by the controller, not a subagent)

**Files:** none changed in the repo. Output goes into the PR description.

This is the only task that touches the `postgres` database. Run each command yourself and read its output before the next. Never use `supabase migration up`. Stop and ask the owner if anything below does not match what is expected.

Order matters: from Task 3 on, `search()` writes `retrieval_log.facts`, so until migration 012 is applied, every search from new code fails with `column "facts" of relation "retrieval_log" does not exist`. Old processes keep working after the migration (their insert does not name `facts`), but they log rows without facts (their F labels cannot be verified) and have no `brain_verify` until restarted. Apply first, then restart, then verify.

- [ ] **Step 1: Back up the brain schema**

Run:
```bash
ts=$(date +%Y%m%d-%H%M%S)
docker exec supabase_db_brain pg_dump -U postgres -d postgres -n brain -Fc > ~/brain-pre-012-$ts.dump
ls -l ~/brain-pre-012-$ts.dump
docker exec -i supabase_db_brain pg_restore --list < ~/brain-pre-012-$ts.dump | grep -c "TABLE DATA brain"
```
Expected: a dump file of non-trivial size; the table-data count is 14 (the `brain` tables after Phase 4; 012 adds `verification_log`, so a later dump shows 15). Note the file name for the PR.

- [ ] **Step 2: Apply migration 012**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20261003000012_verification_log.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select (select data_type from information_schema.columns where table_schema = 'brain' and table_name = 'retrieval_log' and column_name = 'facts') as facts,
       (select count(*) from pg_indexes where schemaname = 'brain' and tablename = 'verification_log') as indexes,
       (select relrowsecurity from pg_class where oid = 'brain.verification_log'::regclass) as rls,
       (select count(*) from brain.retrieval_log) as searches,
       (select count(*) from brain.retrieval_log where facts is not null) as with_facts,
       (select count(*) from brain.verification_log) as verifications"
```
Expected: `BEGIN`, `ALTER TABLE`, `DO`, `COMMENT`, `CREATE TABLE`, `CREATE INDEX`, `CREATE INDEX`, `ALTER TABLE`, `COMMENT`, `COMMIT`; then `jsonb | 3 | t | <n> | 0 | 0` (no existing search has facts logged; nothing verified yet).

- [ ] **Step 3: Restart every running brain process**

Run:
```bash
pgrep -fl "src/mcp/(stdio|http-main)\.ts|src/cli\.ts" || echo "no brain processes running"
```
For each listed process: an MCP HTTP server (`npm run mcp:http`) is restarted; an MCP stdio server belongs to a Claude Code session and is restarted by restarting that session (or by `/mcp` reconnect). A long-running CLI command (`project-obsidian --watch`, `backfill`) is stopped and started again. Re-run the `pgrep` and confirm every remaining process started after Step 2 (`ps -o lstart= -p <pid>`).

- [ ] **Step 4: One real search**

Run:
```bash
npm run brain -- search "what am I working on" -k 3
```
Expected: the first line is `retrieval <uuid> · mode: hybrid · <n> passages`, provenance lines, and `brain explain <uuid> …` last. Note the id and copy the first sentence of P1's one-line excerpt (the line under `[P1] …`). If the mode is not `hybrid`, read the degraded note and show the owner before going on. Then:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select jsonb_typeof(facts) as facts, jsonb_array_length(facts) as n_facts from brain.retrieval_log where id = '<uuid>'"
```
Expected: `array | <number of [F#] lines the search printed>`.

- [ ] **Step 5: `brain verify` on it: one supported claim, one unsupported**

Write the claims file, with the sentence from Step 4 as the first claim (verbatim, without its label):
```bash
cat > /tmp/brain-verify-real.json <<'EOF'
[{"text": "<the first sentence of P1, as printed>", "cites": ["P1"]},
 {"text": "The owner runs a vineyard in Tuscany and exports olive oil to Japan.", "cites": ["P1"]}]
EOF
npm run brain -- verify <uuid> --claims /tmp/brain-verify-real.json
```
Expected: `verification <vid> · retrieval <uuid> · 2 claims`, `✓ supported 1.00 — "<sentence>" [P1]` (support 1.00 for a verbatim sentence; if the excerpt was cut mid-sentence, at least 0.60), `✗ unsupported 0.00 — "The owner runs a vineyard in Tuscany and exports olive oil to Japan." [P1]` with `    missing terms: owner, runs, vineyard, Tuscany, exports, olive, oil, Japan` (a word may be missing from that list only if P1 happens to contain it), `Summary: 1 supported, 1 unsupported`, and the `Checked: …` line.

- [ ] **Step 6: The audit row**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select id, retrieval_id, client, jsonb_array_length(claims) as claims, summary->>'text' as summary,
       results->0->>'verdict' as first, results->1->>'verdict' as second
from brain.verification_log order by created_at desc limit 1"
```
Expected: `<vid> | <uuid> | cli | 2 | 1 supported, 1 unsupported | supported | unsupported`.

- [ ] **Step 7: The MCP tool from a restarted session**

From a Claude Code session restarted in Step 3:
1. List the brain tools. Expected: eleven, including `brain_verify`; with an HTTP server under `BRAIN_MCP_READONLY=1`, eight.
2. Ask a question about the owner. Expected: the client calls `brain_orient`, `brain_search`, then `brain_verify` with the retrieval id and its claims (server instructions step 5), and presents anything not supported as its own addition or as weakly supported. No output-schema error appears.

Check the log of those calls:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select created_at, client, tool, ok, args from brain.tool_calls order by created_at desc limit 5"
```
Expected: a `brain_verify` row with `ok = t` and `args` `{"claims_n": <n>, "retrieval_id": "<id>"}`, after the `brain_search` row with the same id in the client's text.

- [ ] **Step 8: PR description**

Paste into the PR: the backup file name, the Step 2 counts, the Step 4 search header and facts check, the Step 5 verification output, the Step 6 audit row, and the tool calls from Step 7.

---

## Self-review notes

- Spec §7.1 (tool): Task 5 (`brain_verify` with `retrieval_id` and `claims: [{text, cites}]`), Task 4 (P and F labels through the log; chunk ids and fact ids accepted directly).
- Spec §7.2 (method): Task 1 (stems from `to_tsvector('english')`, numbers and dates normalised, `1,000` → `1000`, `~11%` → `11%`), Task 2 (support over the union of cited stems, heading path counted for passages and predicate plus object for facts, the four verdict rules plus `bad_citation`, the per-claim evidence and the one-line summary), Task 4 (labels resolved, audit row), Task 5 (the response lists each claim with its verdict, support, missing terms and numbers, and the summary; the server instructions gain the step).
- Spec §7.3 (limits): stated in the `brain_verify` description (Task 5), under every rendered verification (`VERIFY_LIMITS`), in the README (Task 8), and measured as counted errors in the eval set (Task 7). `ask` runs the verifier on its own answer (Task 6).
- Roadmap Phase 5 tasks 1–6: Tasks 1, 2+4, 5, 5, 6, 7. "Done when": `brain_verify` live (Task 9), the unit cases green (27 in `verify.test.ts`), `eval` reports verifier precision and recall (Task 7; precision 0.92 and recall 0.97 on the shipped set), README documents the verdicts and their limits (Task 8).
- The brief's decisions 1–8: terms (Task 1), method (Task 2), audit log and migration 012 (Task 3, written by Task 4), MCP tool, read-only, instructions, search description and CLI (Task 5), `ask` (Task 6), golden set and metric with the 0.9 precision gate (Task 7), README (Task 8), controller task (Task 9).

How this plan was validated: every task was built in a scratch clone of the repository (`git clone` of `citation-check` at `ba335d3` into the session scratchpad) against private scratch databases, `brain_p5s_test` and `brain_p5s_eval`, created and dropped through a connection to `template1` (never `postgres`, `brain_test` or `brain_eval`) and built from the migrations of each task's state. At every task boundary `npm run typecheck` reported no errors and the unit and integration suites passed, with one exception that is an artefact of the scratch database name: `test/integration/eval-db.test.ts` expects the refused name to be `brain_test` and sees `brain_p5s_test` (it fails the same way on the untouched `ba335d3`, and passes on the real `brain_test`). Every "verify it fails" expectation above was produced by running that task's new tests against the previous task's state. The CLI commands `verify` (claims file, single claim, unknown id, missing options), `eval verifier --gate`, and `eval run` with an empty golden file (to see the verifier line and gate without Voyage calls) were run against the scratch databases; the worked example in the README is real output of `brain verify`. Not run in scratch, because they need Voyage or the Claude Code backend: `npm run eval:run` over the golden set (Tasks 3 and 7), the CLI `search` and `ask` on `brain_eval` (Tasks 5 and 6), and Task 9. Finally, the plan text itself was checked mechanically: a script applied every "Create" block and every "replace … with …" block, in order, to a fresh checkout of `ba335d3`, and the resulting tree was identical to the validated scratch state.

Places where the real code forced a decision that differs from, or adds to, the brief:
- **`retrieval_log` had no facts**, so migration 012 adds `facts jsonb` (with an array check), `search()` writes it, and older rows report F labels as `bad_citation` with the reason "facts were not logged for this search (before migration 012)" and a note to cite fact ids. A row logged before migration 011 gets the same treatment for P labels.
- **Filler words.** Postgres keeps `yes`, `also`, `however`, `indeed` and similar as lexemes, so "Yes." would have a content term. `FILLER_WORDS` (16 listed words) are skipped before stemming so the decided rule for term-free claims applies.
- **Codes are numbers.** Postgres splits `ZX-9000`, `F-1`, `H-1B` into fragments (`zx`, `-9000`), so a wrong model number would match as words. Tokens with a letter and a digit are extracted and must appear as written (`ZX-8000` against `ZX-9000` is `partial` with `missingNumbers: ["ZX-8000"]`). They are also blanked from the claim, so `F-1 OPT` contributes the code `F-1` and the term `opt`.
- **Number words.** `two` to `ninety` (with units and hundred/thousand/million/billion) are numbers, so "four finalists" against "three finalists" is caught; `one` and `first` are not, because "one of", "no one" and "the first person" are not counts. Digit ordinals (`3rd`) are read.
- **Month-day dates.** `October 6` (no year) normalises to `--10-06`, and a full date in a source also states its `--MM-DD`, month and year, so "in September 2026" is supported by `2026-09-20`. A lower-case "may" next to a number is not a month ("the top 5 may help").
- **Negation words that are lexemes** (`never`, `without`, `none`, `neither`, `cannot`) are excluded from content terms; negation is checked by its own rule only.
- **Contractions.** Postgres turns `doesn’t` into `doesn` and `won't` into `won` (a different word). Negative contractions are stemmed as their base (`does`, `will`), which are stopwords, and still count as negation.
- **The negation window is the sentence.** "Near a matched term" became "in the same cited sentence as a matched term", because Postgres token positions do not align with a TypeScript tokenizer. The eval set records its cost (v10: a long list sentence with an unrelated "without").
- **Verdict precedence.** Below 0.3 is `unsupported` even with a missing number; a missing number or a negation mismatch only caps at `partial`. A term-free claim with numbers is `partial` (all present) or `unsupported` (one missing); without numbers it is `supported` unless its negation has nothing to agree with ("No [P1]." is `partial`). Justification for "Yes [P1]." being supported: it asserts nothing the source could contradict, its truth depends on the question (which the verifier does not see), and calling it unsupported would flag every short connective answer; the eval set includes it as a labelled item.
- **Mixed good and bad cites are not capped**: the claim is judged on the good cites and the bad ones are listed (`badLabels` with a reason), as decided.
- **Raw ids** may name any stored chunk or fact, not only those the search returned: the cited text is in the knowledge base either way.
- **Resolution in its own file** (`resolve.ts`), so `verify.ts` stays pure and unit tests import no database code; `verifyTexts` stays in `verify.ts` because the eval uses it without any log.
- **The eval set** carries cited texts inline with `retrieval: {documents}` (the fixtures they are quoted from), a `case` field (every case required by a unit test), and missing labels as `{label, missing: true}`. It has 63 items instead of 40, because precision of `supported` is only meaningful with enough items labelled `supported` (35), and the three known limits are included as counted errors. Its numbers depend on the mix of items; the gate guards against regressions on this mix, not against every possible answer.
- **The gate checks precision only** (0.9), as decided; the roadmap's "recall ≥ 0.9" is reported (0.97) but not gated, so a change that makes the verifier stricter is never blocked.
- **`brain_verify` logs claims as a count** in `brain.tool_calls`; the claims themselves are in `brain.verification_log`.
- **`verification_log` has no foreign key** to `retrieval_log`, so audit rows outlive any later cleanup of the search log, and `wipe`'s truncation order does not matter.
- **`test/integration/retrieval-log.test.ts` changes**: it counted every `retrieval_log_%_check` constraint (2); migration 012 adds a third, so it now counts migration 011's two by name.
- **Migration name** is `20261003000012_verification_log.sql`, as decided.

Types and names used across tasks: `StemMap`, `stemAll`, `stems`, `isContentLexeme`, `hasNegation`, `NEGATION_WORDS`, `FILLER_WORDS`, `ClaimWord`, `claimWords`, `extractNumbers`, `citedNumberSet`, `splitSentences` (T1) are used by `verify.ts` (T2), `answer.ts` (T6) and the tests. `SUPPORTED_MIN`, `PARTIAL_MIN`, `VERDICTS`, `VerdictSchema`, `Verdict`, `ResolvedCiteSchema`, `BadLabelSchema`, `ClaimResultSchema`, `ClaimResult`, `SummarySchema`, `Summary`, `CitedText`, `passageText`, `factText`, `LABEL_GROUP_RE`, `stripLabels`, `stemInputs`, `ClaimCheck`, `checkClaim`, `verdictOf`, `ClaimToJudge`, `judge`, `verifyTexts`, `summarizeVerdicts` (T2) are used by `resolve.ts` (T4), `render.ts` (T5), `answer.ts` (T6) and `eval/verifier.ts` (T7). `MAX_CLAIMS`, `MAX_CLAIM_CHARS`, `MAX_CITES`, `ClaimInputSchema`, `ClaimInput`, `ClaimsSchema`, `VerificationSchema`, `Verification`, `ParsedCite`, `parseCite`, `NOTE_NO_RESULTS`, `NOTE_NO_FACTS`, `verifyClaims` (T4) are used by `server.ts`, `cli.ts`, `render.ts` (T5), `ask.ts` and `answer.ts` (T6). `verdictLine`, `verdictDetail`, `VERIFY_LIMITS`, `renderVerification` (T5) and `renderAnswerCheck` (T6) by `server.ts` and `cli.ts`. `labelsIn`, `claimsFromAnswer`, `AskResult` (T6). `VERIFIER_CASES`, `VerifierItemSchema`, `VerifierItem`, `parseVerifierSet`, `toClaim`, `VerifierReport`, `verifierReport`, `VERIFIER_PRECISION_MIN`, `verifierGate`, `verifierLine`, `VerifierItemResult`, `VerifierRun`, `runVerifierSet`, `runVerifierFile`, `renderVerifierRun` (T7) by `eval/run.ts` and `cli.ts`. Reused from Phase 4: `explainNotFound` (the unknown-id message), `UUID`, `LoggedPassageSchema`, `FactRowSchema`, `normalizeWhitespace` and `splitFrontMatter` (the fixture test).

Known limits, not addressed here (all stated to the owner in the README):
- It checks vocabulary, not meaning: a correct paraphrase in other words is `partial` or `unsupported` (v55–v58), and certainty, sarcasm, reasoning and relations between quantities are not checked, so "fell from $157,000 to $41,000" passes against "rose from $41,000 to $157,000" (v62), "required" passes against "suggested" (v61), and one added detail among five matching words passes (v63).
- The negation rule is sentence-level: an unrelated negation in a cited sentence that shares a word with the claim caps a true claim at `partial` (v10); a claim that negates one part and affirms another ("H-1B, not O-1") is `partial` against a source that only affirms.
- A cited heading path can lift support (in the worked example, "visas" matched the heading "Compensation and visa"); that is intended, since the client saw the heading, but it means a heading word counts as evidence.
- Slash dates (`9/29/2026`) are read as three numbers; a bare `5m` is read as 5 million, not 5 metres; a hyphenated `4-year` is a code, so it does not match "4 years".
- The splitter joins a sentence ending in an abbreviation from its never-ends list to the next one; `brain ask` checks at most 50 sentences and cuts a sentence at 2,000 characters.
- A raw chunk id is resolved to the passage as it is stored now; a P label to a passage re-chunked since the search is a bad citation (its text is gone), and an F label resolves to the fact as the search returned it even if it has since been superseded.
- The eval labels were written by an agent; the owner has not reviewed them yet.
- `verification_log` has no retention policy; the `created_at` index makes a later cleanup by date cheap.
