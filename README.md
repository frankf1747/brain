# brain

A personal knowledge base. Anything you feed it stays retrievable (raw text, hybrid search, raw-scan fallback), and an entity graph plus a facts store grow on top of it.

Design: `docs/superpowers/specs/2026-09-27-knowledge-base-core-design.md`.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in `VOYAGE_API_KEY`.
   - Model calls go through your local Claude Code CLI (`claude`) on your Claude subscription by default (`BRAIN_LLM=claude-code`). Make sure `claude -p hi` works.
   - `BRAIN_LLM=api` with `ANTHROPIC_API_KEY` is optional, for per-token API billing.
   - The `backfill` command (Message Batches API) always needs `ANTHROPIC_API_KEY`.
3. `npm run db:start` (Docker) then `npm run db:reset` to apply migrations locally.

Local Supabase uses ports 55320-55329 (set in `supabase/config.toml`) because the default ports may be taken by another local Supabase project. The local connection string is `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres`.

To use a hosted Supabase project instead: create the project, run `supabase link --project-ref <ref>` and `supabase db push`, then set `DATABASE_URL` in `.env` to the project's direct connection string.

### Voyage spending cap

Every Voyage request (passage and summary embeddings, entity-name embeddings during resolve, query embeddings, reranking) is recorded in `brain.provider_usage` and counted against a hard daily cap: `BRAIN_VOYAGE_DAILY_TOKEN_CAP` tokens per UTC day, default 5,000,000. Before each request the client reserves its estimated tokens (characters / 4) under a database lock and refuses the request without sending it when today's total plus the estimate would pass the cap; after the response it records Voyage's own `usage.total_tokens`. A request Voyage answers with an error status is recorded at 0 tokens; a request that times out or whose connection drops counts at its estimate, since Voyage may have processed and billed it. A retry is a request of its own. `0` blocks every call. **There is no setting that turns the cap off**, and a value that is not a whole number stops the program at startup, so a typo can never lift it.

When the cap is reached:
- Ingestion stores, chunks and summarizes as usual and stops before embedding (or before resolving); `brain status` shows `spend_cap: …` on those jobs, and no retry attempt is used up. After the first refusal the rest of a batch stops before its Voyage stages without asking again. `brain retry` (or the next `brain_ingest`, which resumes stalled jobs) finishes them after 00:00 UTC, or at once after raising the cap.
- Search returns keyword-only results and says "Voyage daily cap reached; keyword-only results" (or "…; results in fused order" when only the rerank was refused).

`npm run brain -- usage [--days 30]` prints requests, tokens, refused calls and errors per UTC day and operation, today's tokens against the cap, and an estimated cost once `BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED` and `BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK` are set from Voyage's pricing page (default 0: tokens only). `brain_orient` shows today's tokens against the cap (or "Voyage ledger unavailable" on a database without migration 010).

How far past the cap a day can go: settled calls count their real tokens, so the only overshoot comes from calls in flight when the cap is reached, which were admitted at their characters / 4 estimate. On measured data that estimate was within about 4% for English; for non-English or code-heavy text it can undercount 2–4×. The worst case is roughly (number of concurrent callers) × (largest batch estimate) × (estimate error): tens of thousands of tokens for English, more for other text. The overshoot never grows over the day, because every later reservation sees the settled totals.

The ledger lives in each database: the real knowledge base and `brain_eval` each count and cap their own calls. The eval database has its own cap, `BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP` (default 1,000,000, read the same way); any database whose name ends in `_eval` is held to it, whichever command opens it. Voyage bills the account, so **the account-wide daily ceiling is `BRAIN_VOYAGE_DAILY_TOKEN_CAP` plus `BRAIN_EVAL_VOYAGE_DAILY_TOKEN_CAP`** (6,000,000 tokens with the defaults), plus the in-flight overshoot, and the cap of any other database using the same key. Running processes read the caps when they start: restart the MCP server after changing them. A request in flight when its process dies stays counted at its estimate for the rest of the day.

Each Voyage request times out after 8 seconds for search and 120 seconds for ingestion. Search sends at most 3 HTTP requests per Voyage call (rate limits, server errors and timeouts share that count) and waits at most 10 seconds in total between them, then falls back; ingestion waits out rate limits (up to 6 attempts, at most 60 s per wait).

## Commands

```
npm run brain -- ingest <file|dir|url|-> [--kind note] [--author owner|other|unknown] [--title T] [--occurred-at 2026-01-01] [--meta k=v] [--until chunked]
npm run brain -- status
npm run brain -- retry [--stage embedded]
npm run brain -- usage [--days 30]
npm run brain -- search "<query>" [--kind news note] [--since 2026-01-01] [--until 2026-12-31] [--verified] [-k 10] [--json]
npm run brain -- explain <retrieval-id>
npm run brain -- ask "<question>"
npm run brain -- verify <retrieval-id> --claims <claims.json>
npm run brain -- verify <retrieval-id> --claim "<text>" [--cite P1 --cite F2]
npm run brain -- node "<name or id>"
npm run brain -- facts [--all]
npm run brain -- set-author <document-id> <owner|other|unknown>
npm run brain -- eval ingest [dir]
npm run brain -- eval run [--golden eval/golden.jsonl] [--baseline eval/baseline.json] [--verifier eval/verifier.jsonl] [--compare] [--gate] [--accept] [--json]
npm run brain -- eval verifier [--file eval/verifier.jsonl] [--gate] [--json]
npm run brain -- backfill [--limit 500] [--poll 30]
```

## Tests

- `npm run test:unit` needs nothing.
- `npm run test:int` needs `npm run db:start`. It recreates a separate `brain_test` database from the migrations and runs there with fakes for Claude and Voyage, so your real knowledge base is never touched. The test helper refuses any database whose name does not end in `_test`.
- The retrieval eval runs only against `brain_eval` and checks the live connection before any write (`npm run eval:prepare` creates it from the migrations; `--reset` recreates it). `npm run brain -- eval ingest` loads `eval/corpus`; `npm run eval:run` scores `eval/golden.jsonl` and compares with `eval/baseline.json`; `npm run eval:gate` exits 1 on a regression (recall@10 or MRR down more than 0.02, abstention down, any degraded search, a changed golden set, no baseline, or precision of the citation verifier's `supported` below 0.9 on `eval/verifier.jsonl`; see "Checking an answer against its sources"). Each run also prints `voyage tokens=… requests=… refused=…`: the Voyage tokens that run used, from `brain_eval`'s own ledger and cap (not part of the baseline). After a deliberate change, `npm run brain -- eval run --accept` records the new baseline. `eval:prepare` only creates `brain_eval`; to bring an existing one up to date after a new migration, apply that migration file to it with `psql .../brain_eval -v ON_ERROR_STOP=1 -f <file>`. Metrics: set recall@1/5/10 over the top-k passages, MRR over distinct documents, nDCG@10 against all quote-bearing passages, paraphrase consistency, abstention and false-answer rate on negatives, degraded fraction, nearest-rank latency from each search's own `timings.totalMs`, and p50/p95 per stage (embed, sql, rerank, graph; recorded in baselines from Phase 4 on). Baseline on 2026-09-30 (commit `2b3426d`, before any retrieval change): recall@1 0.79, recall@10 1.00, MRR 1.00, p50 236 ms, 0% degraded, 14 questions over 6 documents. The set is small and has no negatives yet, so treat it as a regression check until Phase 6 of `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` grows it.

## Layout

See the file structure section of `docs/superpowers/plans/2026-09-27-knowledge-base-core.md`.

## MCP

The server exposes the knowledge base as eleven tools:

- `brain_orient`: what the base holds (counts, recent documents, facts about you) and which tool to use; call first.
- `brain_search`: hybrid keyword, vector and graph search.
  Search runs five layers. Hybrid: vector search plus keyword search that ORs the query's stems over passage content, headings and title, ranked by how many distinct query terms a passage matches; the two lists are fused with RRF and reranked. Document summaries, fused the same way. Graph expansion from entities named in the query (any case, names up to six words, at most 5 entities; up to 20 neighbours and 5 passages each, including mentions on merged nodes). Facts that share a term with the query or point at a named entity (at most 10, entity-linked first). A literal scan for exact-string terms such as `X-90` or `$115k` when the best hit is weak or the search ran degraded. Vector and keyword search use the HNSW and GIN indexes; `test/integration/search-plan.test.ts` fails if a query plan stops using them. `verified_only` filters facts and neighbours only.
- `brain_get_document`: fetch one document.
- `brain_get_node`: fetch an entity and its neighbours.
- `brain_get_facts`: list current facts.
- `brain_status`: pipeline progress for documents.
- `brain_explain`: replay a logged search from its retrieval id: mode, candidate counts, timings, and each passage's ranks and score.
- `brain_verify`: check each claim of an answer against the passages and facts it cites in a logged search, with no model call (see "Checking an answer against its sources").
- `brain_ingest`: save text such as a note, pasted article or conversation (a URL can be recorded as its origin, not fetched). Pass `author: "other"` for anything you did not write.
- `brain_add_fact`: record a fact.
- `brain_supersede_fact`: replace a fact with a corrected one.

With `BRAIN_MCP_READONLY=1` only the eight read tools (the first eight) are exposed. `brain_verify` counts as a read tool: it changes nothing in the knowledge base and only writes its audit row, as `brain_search` writes `brain.retrieval_log`.

`brain_ingest` returns once the document is stored and chunked. Summary, embeddings and extraction continue in the background, at most 2 pipelines at once so a slot stays free for new saves. `brain_status` shows progress; unfinished work resumes on later saves or with `npm run brain -- retry`.

Facts written by an agent are unverified until you run `npm run brain -- verify-fact <id>`. Corrections supersede the old fact; nothing is deleted.

Every document records who wrote it: `owner`, `other` or `unknown`. Only documents you wrote produce facts about you or relationships from you; for any other document the extractor's statements about you are kept in its stored extraction but not written, and `brain status` / `brain_status` show how many per document. Without `--author` (CLI) or `author` (MCP), resume, note, conversation and paste default to `owner`; news, paper, job_description and email to `other`; anything else to `unknown`. Saving text that is already stored keeps its author (the CLI and `brain_ingest` say so when you asked for a different one). If someone else's post was saved as yours, run `npm run brain -- set-author <document-id> other`: it removes the facts and relationships that document produced (facts you verified are kept and listed), applies the rule again and refreshes the Obsidian mirror. While the document is being processed it refuses (try again in a moment); for a document not yet resolved it only records the author, which the resolve stage then applies. Single-valued facts (`lives_in`, `visa_status`, `targeting_role`, `pursuing_degree`, `employment_status`, `current_employer`, `phone`, `email`) keep one current value: when a document of yours states a different value dated no earlier than the current one, the old fact is superseded; an older statement resolved later is recorded as already superseded. Values you set by hand (`brain_add_fact`, `brain_supersede_fact`) or verified always win over extraction: a document stating a different value, whatever its date, is recorded as already superseded by yours. Facts you corrected are kept as history (`set-author` lists them), and a value you corrected away from is not stated again by any document. Every supersession, restoration and removal is logged in `brain.fact_events`.

On connect, the server sends instructions that the client places in the model's system prompt: questions about you go to `brain_orient` once, then `brain_search`, and answers cite the returned passages. Every tool call is logged to `brain.tool_calls` with its client, arguments (saved text as its length only), outcome and duration, so you can check whether a session followed that order:

```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select created_at, client, tool, ok, args from brain.tool_calls order by created_at desc limit 20;"
```

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
- How found: `vector#n` and `keyword#n` are the passage's rank among each branch's candidates (up to 60 per branch). `graph via <entity>`: the passage mentions an entity named in the query; a ranked passage that also mentions one shows both, e.g. `vector#2 keyword#5 graph via Acme Corp`, and keeps its score. `fallback "<term>"`: the document contains an exact-string term from the query (a code, figure or version); the passage is a window of the raw document, not a stored chunk, so it has a character range instead of a chunk id.
- `author`: who wrote the document (`owner`, `other`, `unknown`). A passage by someone else says what they wrote, not what is true of you.
- Facts: `verified` once you confirmed it with `verify-fact`. `from <kind> <doc id>` means the extractor read it from that document; `stated by owner` means it was recorded on your word (`brain_add_fact`, or by hand) with no source passage. `confirmed by owner` means you verified it and it has no stored source passage (verifying replaces who recorded it with your name). `extracted; source passage no longer stored` means the extractor wrote it but its passage was re-chunked or deleted.
- Knowledge base or model: passages and facts come from the base, with ids you can open. In an answer, anything without a `[P…]` or `[F…]` citation is the model's own; the server instructions ask clients to make that split clear. `brain ask` gives its model the same mode, scores and authors, prints its sources under the answer, and checks each sentence against what it cites. `brain_verify` does the same check for any MCP client.

`brain.retrieval_log` keeps, per search, the query, filters, client, time, `mode`, `degraded` (`embedding`, `rerank`, `capReached`), `candidates` (`vector`, `keyword`, `fused`), `timings` (`embedMs`, `sqlMs`, `rerankMs`, `graphMs`, `totalMs`), `k`, and `results`: every returned passage in rank order with everything above except its text. Rows logged before migration 011 have only chunk ids, layers and a top score (which may be an RRF value); explain says "logged before evidence v2". From migration 012 each row also keeps `facts`, the facts the search returned in order (index 0 is F1), which `brain_verify` resolves F labels from.

### Checking an answer against its sources

`brain_verify` (MCP), `npm run brain -- verify` and `brain ask` check an answer claim by claim against the passages and facts each claim cites, so you can see what came from the knowledge base and what the model added. The check is deterministic: no model is called, so it costs nothing per query and gives the same verdict every time. The code is `src/verify/` (`terms.ts` for the extraction, `verify.ts` for the method, `resolve.ts` for looking up cites); every verification is logged to `brain.verification_log`.

How a claim is checked:

1. Cites are resolved through the search the answer came from: `P3` is the third passage of that retrieval (its text is read from `brain.chunks`; a fallback passage is cut from the document's raw text by its character window), `F1` is the first fact that search returned, as it was then. A chunk id or fact id also works. A passage's cited text is its heading path plus its content; a fact's is its predicate (underscores as spaces) plus its value.
2. Numbers, dates and codes are read from the claim and normalised: `1,000` is `1000`; `~11%`, `11 %` and `11 percent` are `11%`; `$115k`, `$115K`, `$115,000` and `115,000 dollars` are `$115000` (k, m, b, thousand, million and billion scale the number); `Sep 29, 2026`, `29 September 2026` and `2026-09-29` are `2026-09-29`; `September 2026` is `2026-09`; `October 6` is `--10-06`; `3rd` is `3rd`; `two` to `ninety` and `two hundred` are numbers (`one` and `first` are not, since they are usually not counts); a token with a letter and a digit (`H-1B`, `F-1`, `ZX-9000`, `v2.5`) is a code, compared as written. A leading minus stays with its number (`-5%` is not `5%`). Numeric dates (`3/4/2026`), dotted versions (`3.12.1`), digit groups (`555-1234`) and percent ranges (`20-30%`) are compared exactly as written, never as loose numbers; a range of two years (`2019-2023`) is two years. Every one of them must appear in the cited texts. A full date in a source also states its month, year and month-day; a sum of money also states the bare amount.
3. Content terms are the rest of the claim's words, stemmed by Postgres (`to_tsvector('english', …)`, the same stemming as the keyword index), without stopwords, without negation words, and without answer words such as "yes", "also" and "however". Support is the share of the claim's distinct content terms that appear among the cited texts' stems.
4. Negation: the words not, no, never, without, none, neither, nor, cannot and anything ending in n't are read from the raw text. There is a negation mismatch when the claim has one and no sentence of the cited texts has one together with a matched term, or the other way round.
5. Polarity words: up, down, before, after, over, under, above, below, more, most, less, fewer, few, all, some, only, against, will, would, might, must, can, could and should are Postgres stopwords, so stemming alone would let "went up 11%" match "went down 11%". They are read from the raw text (`won't` counts as will, `cannot` as can), and every one in the claim must appear as a whole word in the cited texts.
6. Counting words: when a content term of the claim that the cited texts lack is a number or ordinal word (`one`, `first`, `dozen`, `tenth`), the claim states a count or rank the source does not.

Verdicts, from the first rule that applies:

| Verdict | Rule |
|---|---|
| `bad_citation` | Every cite names nothing in that search (`P9` when it returned 5 passages; `F1` on a search logged before facts were recorded; a passage since re-chunked). Bad cites next to a good one are listed but do not change the verdict. |
| `uncited` | No cites: the model's own statement. |
| `supported` | Support at least 0.6, every number and polarity word present, no negation mismatch, and no missing term that is a number or ordinal word. A claim with no content terms ("Yes [P1].") is supported when it has no numbers, no negation mismatch and no missing polarity word, since it states nothing the source could contradict; with numbers it is at most partial, because nothing says what the figure measures. |
| `partial` | Support at least 0.3, or support at least 0.6 with a missing number, a missing polarity word, a missing number or ordinal word, or a negation mismatch. |
| `unsupported` | Support below 0.3. A failed check never raises a verdict. |

What it does not check. Read `supported` as "the cited text contains this claim's words and numbers", not as proof:

- It checks word overlap, not who did what to whom: reversed relations ("Acme led Beta Ventures' round") and swapped entities pass.
- A number only has to appear somewhere in the cited text, not attached to the same thing ("Acme employs 40 people" passes against "grow its teams by 40 people").
- All cited texts are pooled, so citing unrelated passages together can support a claim that neither supports alone.
- Negation is checked per sentence, not per clause.
- Antonyms ("halved" for "quadrupled") and words like "former" are not detected.
- Up to 40% of a claim's content words can be absent at `supported`, so one added detail in a short claim can pass.
- A bare amount ignores its unit (20 minutes matches 20 hours), though `%` and percentage points are told apart.
- A claim made only of stopwords ("Yes.", "They did.") is vacuously supported.
- A correct paraphrase in other words scores partial or unsupported (the safe direction).
- A raw fact id is checked against the fact as stored now; when that fact has been superseded the verification notes it.

Polarity words (up/down, before/after, more/less, all/some, only, will/might and the rest above) are now checked; reasoning, sarcasm and certainty words outside that list ("may", "probably") are not.

Reading the output. Worked example: a search returned the compensation section of `eval/corpus/job_description--acme-senior-data-analyst.md` as P1 ("Base salary range $115,000 to $140,000. Acme sponsors H-1B for this role. Hybrid, three days a week in the Austin office. …", under the heading "Compensation and visa"), and the answer was "Acme sponsors H-1B visas for this role [P1]. The base salary is $115k to $150k [P1]. The role is not hybrid [P1]. The company will pay for relocation to Austin [P1]. It looks like a strong fit."

```
verification 12bf8876-… · retrieval a4cf4454-… · 5 claims
✓ supported 1.00 — "Acme sponsors H-1B visas for this role." [P1]
~ partial 1.00 — "The base salary is $115k to $150k." [P1]
    missing numbers: $150000
~ partial 1.00 — "The role is not hybrid." [P1]
    negation differs from the cited text
✗ unsupported 0.25 — "The company will pay for relocation to Austin." [P1]
    missing terms: company, pay, relocation · missing polarity words: will
○ uncited - — "It looks like a strong fit."
    no citation: nothing from the knowledge base backs this
Summary: 1 supported, 2 partial, 1 unsupported, 1 uncited
```

Each line is the verdict, the support (`-` when there is none), the claim and its cites. The line under a claim says what its cited text lacks: terms in the claim's own words, numbers in their normalised form. "visas" in the first claim matched the heading. `$115k` matched `$115,000`; `$150k` did not. Present anything not `supported` as the model's own or as weakly supported; the server instructions ask MCP clients to do exactly that after calling `brain_verify`.

`brain_verify` takes at most 50 claims of at most 2,000 characters, with at most 20 cites each. `brain ask` splits its own answer into sentences (a line break, or `.` `!` `?` followed by a word that does not start in lower case, never after `e.g.`, `Dr.`, `U.S.` or an initial, never at a decimal point), cites the `[P#]`/`[F#]` labels inside each sentence, and prints the check under its sources.

How well it works is measured on `eval/verifier.jsonl`: 101 claims quoted against the eval corpus (and, for the number and polarity forms the corpus lacks, written out as facts), covering restatements, paraphrases, wrong numbers, signs, versions, numeric dates, digit groups, negation flips, polarity words, number and ordinal words, unrelated claims, claims spanning two passages, claims without content words, facts, number and date forms, hedging and added details, plus 21 known limits: reversed relations, swapped entities, numbers attached to another thing, pooling across cites, negation on the wrong clause, antonyms and "former", bare amounts with another unit, stopword-only claims, certainty and one added detail. The known limits are labelled with their true verdict (not supported), so each one the verifier passes counts as an error. `npm run brain -- eval verifier` prints each item, the confusion matrix, precision and recall of `supported`, and accuracy; `eval run` prints the one-line summary, and `eval run --gate` fails when precision of `supported` is below 0.9 (a claim wrongly marked supported is worse than one wrongly flagged). On 2026-10-03: precision 0.66, recall 0.97, accuracy 0.79 (37 of 56 claims marked supported were labelled supported; all 19 errors are known limits), so the gate currently fails on this set: the limits above are real and frequent enough to matter. A paraphrase that is true but the method cannot recognise is labelled with the verdict the method is designed to give; a claim labelled `supported` is always one its cited text really supports. These labels were written by an agent (`labelled_by: "agent:claude"`), not by the owner: review them, and add your own with `labelled_by: "owner"`.

### Claude Code (this Mac)

Register once at user scope so every chat gets the `brain_*` tools:

```bash
claude mcp add --scope user --transport stdio brain -- /Users/frankfu/Documents/GitHub/brain/node_modules/.bin/tsx /Users/frankfu/Documents/GitHub/brain/src/mcp/stdio.ts
```

Say "save this to my brain" in any chat to ingest; ask anything and the model calls `brain_search` when it needs your material. The stdio server stops when Claude Code closes it.

### Other clients (HTTP)

The hosted server needs `DATABASE_URL` pointing at the Supabase project (run `supabase db push` first so the schema exists there), `VOYAGE_API_KEY`, and `BRAIN_TOKENS` as `name:token` pairs. Each token must be at least 32 characters (`openssl rand -hex 32`) and is sent as `Authorization: Bearer <token>`. The server refuses to start with no tokens or with short ones. The image runs as the non-root `node` user with `BRAIN_LLM=api`, so ingestion over HTTP also needs `ANTHROPIC_API_KEY`; set `BRAIN_MCP_READONLY=1` to expose only the read tools and skip that key.

Fly.io example (adapt names and region):

```bash
fly launch --no-deploy --name brain-mcp --region sjc
fly secrets set DATABASE_URL='postgresql://...' VOYAGE_API_KEY='...' BRAIN_MCP_READONLY=1 \
  BRAIN_TOKENS="claude-desktop:$(openssl rand -hex 32),chatgpt:$(openssl rand -hex 32)"
fly deploy
curl https://brain-mcp.fly.dev/healthz
```

Then register the remote server in Claude Code as a second entry (example):

```bash
claude mcp add --transport http brain-remote https://brain-mcp.fly.dev/mcp --header "Authorization: Bearer <token>"
```

Claude Desktop and ChatGPT take the same URL and header in their connector settings. Alternative with no hosting: run `npm run mcp:http` on the Mac and expose the port through Tailscale or a Cloudflare Tunnel.

## Obsidian

Every save writes twice: to the database, which is the retrieval layer, and to a read-only markdown mirror in your Obsidian vault, which is there for reading and for Obsidian's graph view. The vault and folder come from `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_FOLDER`.

Saves from a Claude chat (MCP) or the CLI refresh the mirror automatically. A document's note appears with its raw text as soon as the document is stored and chunked; its summary, entities, relationships and facts follow when enrichment finishes, usually a minute or two later. Refreshes are debounced (one run a few seconds after the last save in a burst) and never overlap. A failed refresh never fails the save; it is logged to stderr as `brain: obsidian refresh failed: ...`. CLI commands write the mirror before they exit, and the stdio MCP server does so when it shuts down.

The automatic refresh is on whenever `OBSIDIAN_VAULT_PATH` names an existing directory. Turn it off with `OBSIDIAN_AUTO=0`. If the path does not exist, the server logs that once to stderr and leaves the refresh off.

`npm run brain -- project-obsidian` still rebuilds the whole mirror on demand, for example after changing the folder or editing the database by hand. Override the vault and folder with `--vault <path>` and `--folder <name>`, keep it fresh on a timer with `--watch <minutes>` (runs never overlap, a tick is skipped while the previous run is still going), or print the vaults Obsidian knows about with `--list-vaults`.

Layout inside the folder (`Brain` by default):

- `Brain/<your name>.md`: the self node
- `Brain/nodes/<type>/`: one note per entity, grouped by type
- `Brain/documents/<year>/`: one note per document
- `Brain/README.md`: counts and graph view tips

Only files whose frontmatter starts with `---` and contains `brain_managed: true` are ever rewritten or deleted. Symlinks are never followed. Your own notes placed in the folder are left alone and listed in the run output.

Graph view: filter `path:Brain`, then add color groups by `path:Brain/nodes/person`, `path:Brain/nodes/organization`, `path:Brain/documents`, or `tag:#brain/unverified`.
