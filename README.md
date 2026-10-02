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
npm run brain -- node "<name or id>"
npm run brain -- facts [--all]
npm run brain -- set-author <document-id> <owner|other|unknown>
npm run brain -- eval ingest [dir]
npm run brain -- eval run [--golden eval/golden.jsonl] [--baseline eval/baseline.json] [--compare] [--gate] [--accept] [--json]
npm run brain -- backfill [--limit 500] [--poll 30]
```

## Tests

- `npm run test:unit` needs nothing.
- `npm run test:int` needs `npm run db:start`. It recreates a separate `brain_test` database from the migrations and runs there with fakes for Claude and Voyage, so your real knowledge base is never touched. The test helper refuses any database whose name does not end in `_test`.
- The retrieval eval runs only against `brain_eval` and checks the live connection before any write (`npm run eval:prepare` creates it from the migrations; `--reset` recreates it). `npm run brain -- eval ingest` loads `eval/corpus`; `npm run eval:run` scores `eval/golden.jsonl` and compares with `eval/baseline.json`; `npm run eval:gate` exits 1 on a regression (recall@10 or MRR down more than 0.02, abstention down, any degraded search, a changed golden set, or no baseline). Each run also prints `voyage tokens=… requests=… refused=…`: the Voyage tokens that run used, from `brain_eval`'s own ledger and cap (not part of the baseline). After a deliberate change, `npm run brain -- eval run --accept` records the new baseline. `eval:prepare` only creates `brain_eval`; to bring an existing one up to date after a new migration, apply that migration file to it with `psql .../brain_eval -v ON_ERROR_STOP=1 -f <file>`. Metrics: set recall@1/5/10 over the top-k passages, MRR over distinct documents, nDCG@10 against all quote-bearing passages, paraphrase consistency, abstention and false-answer rate on negatives, degraded fraction, nearest-rank latency from each search's own `timings.totalMs`, and p50/p95 per stage (embed, sql, rerank, graph; recorded in baselines from Phase 4 on). Baseline on 2026-09-30 (commit `2b3426d`, before any retrieval change): recall@1 0.79, recall@10 1.00, MRR 1.00, p50 236 ms, 0% degraded, 14 questions over 6 documents. The set is small and has no negatives yet, so treat it as a regression check until Phase 6 of `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` grows it.

## Layout

See the file structure section of `docs/superpowers/plans/2026-09-27-knowledge-base-core.md`.

## MCP

The server exposes the knowledge base as ten tools:

- `brain_orient`: what the base holds (counts, recent documents, facts about you) and which tool to use; call first.
- `brain_search`: hybrid keyword, vector and graph search.
  Search runs five layers. Hybrid: vector search plus keyword search that ORs the query's stems over passage content, headings and title, ranked by how many distinct query terms a passage matches; the two lists are fused with RRF and reranked. Document summaries, fused the same way. Graph expansion from entities named in the query (any case, names up to six words, at most 5 entities; up to 20 neighbours and 5 passages each, including mentions on merged nodes). Facts that share a term with the query or point at a named entity (at most 10, entity-linked first). A literal scan for exact-string terms such as `X-90` or `$115k` when the best hit is weak or the search ran degraded. Vector and keyword search use the HNSW and GIN indexes; `test/integration/search-plan.test.ts` fails if a query plan stops using them. `verified_only` filters facts and neighbours only.
- `brain_get_document`: fetch one document.
- `brain_get_node`: fetch an entity and its neighbours.
- `brain_get_facts`: list current facts.
- `brain_status`: pipeline progress for documents.
- `brain_explain`: replay a logged search from its retrieval id: mode, candidate counts, timings, and each passage's ranks and score.
- `brain_ingest`: save text such as a note, pasted article or conversation (a URL can be recorded as its origin, not fetched). Pass `author: "other"` for anything you did not write.
- `brain_add_fact`: record a fact.
- `brain_supersede_fact`: replace a fact with a corrected one.

With `BRAIN_MCP_READONLY=1` only the seven read tools (the first seven) are exposed.

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
- Knowledge base or model: passages and facts come from the base, with ids you can open. In an answer, anything without a `[P…]` or `[F…]` citation is the model's own; the server instructions ask clients to make that split clear. `brain ask` gives its model the same mode, scores and authors, and prints its sources under the answer.

`brain.retrieval_log` keeps, per search, the query, filters, client, time, `mode`, `degraded` (`embedding`, `rerank`, `capReached`), `candidates` (`vector`, `keyword`, `fused`), `timings` (`embedMs`, `sqlMs`, `rerankMs`, `graphMs`, `totalMs`), `k`, and `results`: every returned passage in rank order with everything above except its text. Rows logged before migration 011 have only chunk ids, layers and a top score (which may be an RRF value); explain says "logged before evidence v2".

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
