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
npm run brain -- eval [--golden eval/golden.jsonl] [--ingest eval/corpus] [--json]
npm run brain -- backfill [--limit 500] [--poll 30]
```

## Tests

- `npm run test:unit` needs nothing.
- `npm run test:int` needs `npm run db:start`. It uses fakes for Claude and Voyage and wipes the brain tables, so do not run it against a database whose contents you want to keep.
- `npm run brain -- eval --ingest eval/corpus` is the retrieval gate; run it after changing chunking, embedding or fusion. Latest result: recall@10 1.00 and MRR 1.00 on 14 questions over 6 documents. The set is small, so treat it as a regression check, not a quality estimate.

## Layout

See the file structure section of `docs/superpowers/plans/2026-09-27-knowledge-base-core.md`.
