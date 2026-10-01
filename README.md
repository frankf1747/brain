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

### Voyage rate limit

The Voyage free tier without a payment method allows 3 requests per minute. The client waits out 429 responses (messages are printed on stderr), so ingestion and search are slow until a payment method is added to the Voyage account.

## Commands

```
npm run brain -- ingest <file|dir|url|-> [--kind note] [--title T] [--occurred-at 2026-01-01] [--meta k=v] [--until chunked]
npm run brain -- status
npm run brain -- retry [--stage embedded]
npm run brain -- search "<query>" [--kind news note] [--since 2026-01-01] [--until 2026-12-31] [--verified] [-k 10] [--json]
npm run brain -- ask "<question>"
npm run brain -- node "<name or id>"
npm run brain -- facts [--all]
npm run brain -- eval ingest [dir]
npm run brain -- eval run [--golden eval/golden.jsonl] [--baseline eval/baseline.json] [--compare] [--gate] [--accept] [--json]
npm run brain -- backfill [--limit 500] [--poll 30]
```

## Tests

- `npm run test:unit` needs nothing.
- `npm run test:int` needs `npm run db:start`. It recreates a separate `brain_test` database from the migrations and runs there with fakes for Claude and Voyage, so your real knowledge base is never touched. The test helper refuses any database whose name does not end in `_test`.
- The retrieval eval runs only against `brain_eval` and checks the live connection before any write (`npm run eval:prepare` creates it from the migrations; `--reset` recreates it). `npm run brain -- eval ingest` loads `eval/corpus`; `npm run eval:run` scores `eval/golden.jsonl` and compares with `eval/baseline.json`; `npm run eval:gate` exits 1 on a regression (recall@10 or MRR down more than 0.02, abstention down, any degraded search, a changed golden set, or no baseline). After a deliberate change, `npm run brain -- eval run --accept` records the new baseline. `eval:prepare` only creates `brain_eval`; to bring an existing one up to date after a new migration, apply that migration file to it with `psql .../brain_eval -v ON_ERROR_STOP=1 -f <file>`. Metrics: set recall@1/5/10 over the top-k passages, MRR over distinct documents, nDCG@10 against all quote-bearing passages, paraphrase consistency, abstention and false-answer rate on negatives, degraded fraction, nearest-rank latency. Baseline on 2026-09-30 (commit `2b3426d`, before any retrieval change): recall@1 0.79, recall@10 1.00, MRR 1.00, p50 236 ms, 0% degraded, 14 questions over 6 documents. The set is small and has no negatives yet, so treat it as a regression check until Phase 6 of `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` grows it.

## Layout

See the file structure section of `docs/superpowers/plans/2026-09-27-knowledge-base-core.md`.

## MCP

The server exposes the knowledge base as nine tools:

- `brain_orient`: what the base holds (counts, recent documents, facts about you) and which tool to use; call first.
- `brain_search`: hybrid keyword, vector and graph search.
  Search runs five layers. Hybrid: vector search plus keyword search that ORs the query's stems over passage content, headings and title, ranked by how many distinct query terms a passage matches; the two lists are fused with RRF and reranked. Document summaries, fused the same way. Graph expansion from entities named in the query (any case, names up to six words, at most 5 entities; up to 20 neighbours and 5 passages each, including mentions on merged nodes). Facts that share a term with the query or point at a named entity (at most 10, entity-linked first). A literal scan for exact-string terms such as `X-90` or `$115k` when the best hit is weak or the search ran degraded. Vector and keyword search use the HNSW and GIN indexes; `test/integration/search-plan.test.ts` fails if a query plan stops using them. `verified_only` filters facts and neighbours only.
- `brain_get_document`: fetch one document.
- `brain_get_node`: fetch an entity and its neighbours.
- `brain_get_facts`: list current facts.
- `brain_status`: pipeline progress for documents.
- `brain_ingest`: save text such as a note, pasted article or conversation (a URL can be recorded as its origin, not fetched).
- `brain_add_fact`: record a fact.
- `brain_supersede_fact`: replace a fact with a corrected one.

With `BRAIN_MCP_READONLY=1` only the six read tools (the first six) are exposed.

`brain_ingest` returns once the document is stored and chunked. Summary, embeddings and extraction continue in the background, at most 2 pipelines at once so a slot stays free for new saves. `brain_status` shows progress; unfinished work resumes on later saves or with `npm run brain -- retry`.

Facts written by an agent are unverified until you run `npm run brain -- verify-fact <id>`. Corrections supersede the old fact; nothing is deleted.

On connect, the server sends instructions that the client places in the model's system prompt: questions about you go to `brain_orient` once, then `brain_search`, and answers cite the returned passages. Every tool call is logged to `brain.tool_calls` with its client, arguments (saved text as its length only), outcome and duration, so you can check whether a session followed that order:

```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select created_at, client, tool, ok, args from brain.tool_calls order by created_at desc limit 20;"
```

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
