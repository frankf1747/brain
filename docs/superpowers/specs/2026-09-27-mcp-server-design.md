# Brain: MCP server, design

Date: 2026-09-27
Status: approved in conversation, awaiting written review
Depends on: sub-project 1 (`2026-09-27-knowledge-base-core-design.md`), specifically `search()`, `ingest()`, `runPipeline()`, `current_facts`, and the `Ctx` object.
Scope: sub-project 2. Phase A is a local stdio server registered with Claude Code so every chat in the Mac app can read from and write to the base. Phase B exposes the same server over HTTP with bearer tokens for other clients and machines.

## 1. Purpose

The workflow this enables: one Claude Code chat is the intake, where Frank pastes, drops files or talks and says "save this"; any other chat has the base available as tools and pulls from it when a question touches something Frank might already know. Later, Claude Desktop, ChatGPT or any MCP client on any machine connects to the same server over HTTP.

The server is a thin adapter. Every tool calls a function that already exists in the core library, and the CLI keeps calling the same functions, so the two surfaces cannot drift.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| SDK | `@modelcontextprotocol/sdk` 1.30+, `McpServer` with `registerTool` | Official SDK; supports Zod 4, which the core already uses |
| Phase A transport | stdio, launched by Claude Code from the repo via `tsx` | No hosting, no auth; registered once at user scope |
| Phase B transport | Streamable HTTP, stateless mode, one server instance per request | The SDK's documented simple pattern; no session bookkeeping |
| Phase B auth | Static bearer tokens from `BRAIN_TOKENS`, `name:token` pairs | One user, a handful of clients; the token name becomes the client label in logs and on facts |
| Tool output | Human-readable text with stable ids embedded, not raw JSON | The consumer is a language model; text with `[P1]`, document ids and node ids reads better and still allows follow-up calls |
| Ingestion latency | `ingest` returns after store and chunk; later stages run in the background inside the server process | Summaries and extraction take 30 to 120 seconds; tool calls must not block that long. Retrievability is already guaranteed after store |
| Writes | `ingest`, `add_fact`, `supersede_fact` only. Facts written by agents are unverified and labeled `agent:<client>` | Frank is in the chat approving what the agent saves; verification stays a deliberate CLI step |
| Model backend inside the server | Same `makeLlm()` as the CLI, so Claude Code headless by default | The server may be launched by Claude Code; the child `claude` process must not inherit the parent's session markers (see 6) |

## 3. Tool surface

All tool names are prefixed `brain_` so they read unambiguously in a chat that has other servers.

| Tool | Input | Returns | Backing function |
|---|---|---|---|
| `brain_orient` | none | What the base holds: document counts by kind, node counts by type, the 10 most recent documents, current facts (verified first, capped at 50), and one paragraph on when to use which tool | new `orient(ctx)` in `src/retrieve/orient.ts` |
| `brain_search` | `query`, optional `k` (1 to 30), `source_kinds[]`, `since`, `until`, `verified_only` | Passages as `[P1]…` with document title, kind, id and chunk id; document summary hits; entities with neighbors; facts; a fallback notice when used | `search()` |
| `brain_get_document` | `document_id`, optional `offset`, `length` (default 4000, max 20000) | Title, kind, origin, dates, summary, then the requested slice of raw text with the total length | new `getDocument(sql, id, offset, length)` in `src/retrieve/documents.ts` |
| `brain_get_node` | `name_or_id` | Type, name, aliases, properties, relationships with evidence quotes, facts, mention count | new `describeNode(sql, nameOrId)` in `src/graph/inspect.ts`; the CLI `node` command switches to it |
| `brain_get_facts` | optional `all` | Current facts about Frank with ids, verification state and validity; `all` includes superseded and expired | `current_facts` / `facts` table |
| `brain_status` | none | Pipeline stage counts, failures, and documents this server instance is still processing | `stageCounts()` plus the server's in-flight map |
| `brain_ingest` | `text`, optional `title`, `source_kind` (default `paste`), `origin`, `occurred_at`, `metadata` | Document id, whether it was new, and a note that processing continues | `storeDocument()` then `runPipeline(until: "chunked")`, then background `runPipeline()` |
| `brain_add_fact` | `predicate`, `object_text`, optional `valid_from`, `note` | The new fact id, marked unverified | insert into `facts` with `verified_by = 'agent:<client>'`, `confidence = 1`, `properties`-free; `note` goes to `object_text` suffix only if given |
| `brain_supersede_fact` | `fact_id`, `object_text`, optional `valid_from` | The new fact id | insert new fact, set old `superseded_by` |

Not included on purpose: `ask`. The calling model composes the answer from `brain_search` output itself; a second model call would be redundant and, on the Max plan, wasteful. The CLI keeps `ask` for terminal use.

## 4. Behaviour details

**Client label.** Phase A: `"claude-code"`. Phase B: the name half of the matching `BRAIN_TOKENS` entry. The label goes into `retrieval_log.client` and into `verified_by` on agent-written facts.

**Background ingestion.** The server keeps a map of document id to promise for stages after chunk. `brain_status` lists them. If the server process exits mid-way, the job stays at its last completed stage and `brain retry` (CLI) or the next `brain_ingest` call's sweep finishes it: on every `brain_ingest`, the server also resumes up to five stalled jobs older than ten minutes.

**Logging.** A stdio server must never write to stdout except protocol frames. All server logging goes to stderr. The core library already avoids `console.log` outside the CLI.

**Errors.** Tool handlers catch errors and return `isError: true` with a one-line message. A missing `VOYAGE_API_KEY` or expired Claude Code login shows up here as a readable message rather than a crash.

**Text rendering.** Passages: `[P1] news · Acme raises Series B (doc 3f2a…, chunk 91c0…)` then the passage text. Entities: `organization: Acme Corp (node 7b1e…) → located_in Austin, works_at ← Priya Natarajan`. Facts: `[F1] visa_status: F-1 OPT (verified)` or `(unverified, from extractor:opus)`. Every id is the full uuid so follow-up calls can use it.

## 5. Phase B: HTTP

- Entry `src/mcp/http.ts`: express app, `POST /mcp` only (stateless mode rejects GET and DELETE with 405), `GET /healthz` returns 200.
- Auth middleware reads `Authorization: Bearer <token>`, matches against `BRAIN_TOKENS`, sets the client label, otherwise 401. Tokens are generated with `openssl rand -hex 32`.
- One `McpServer` and one `StreamableHTTPServerTransport` per request, closed when the response closes.
- Dockerfile for deployment; the plan gives Fly.io commands as the worked example, but any host that runs a container and reaches the Supabase project works. Alternative for zero hosting: run it on the Mac and expose it through Tailscale or a Cloudflare Tunnel.
- Registration examples: Claude Code `claude mcp add --transport http brain-remote https://<host>/mcp --header "Authorization: Bearer <token>"`; Claude Desktop through its connectors settings with the same URL and header.
- The `DATABASE_URL` used by the hosted server is the Supabase project's direct connection string; the local stdio server can keep pointing at the local Docker database until Frank promotes the schema with `supabase db push`.

## 6. Claude Code backend inside a Claude Code-launched process

The stdio server is a child of Claude Code, and it in turn runs `claude -p` for summaries and extraction. The child inherits environment variables that mark it as running inside a session (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`). `spawnExec` in `src/llm/claude-code.ts` strips those from the child environment. This also applies when the CLI is run from a Claude Code chat's Bash tool, so the change belongs in the core and is the first task of the plan.

Also in the core: `.env` is loaded relative to the repository root, not the working directory, because Claude Code launches the server with an arbitrary cwd.

## 7. Testing

- Integration tests connect a real `McpServer` to an in-memory transport with the SDK's `Client`, against the local database with the fake LLM and embedder. They assert: `brain_orient` reflects ingested data; `brain_search` renders passage ids that `brain_get_document` accepts; `brain_ingest` returns within the chunk stage and the background run reaches `done`; `brain_add_fact` then `brain_supersede_fact` leaves exactly one current fact with the old one superseded; a handler error comes back as `isError`.
- HTTP: a test starts the express app on an ephemeral port, calls `POST /mcp` without a token and gets 401, then with a token and completes an `initialize` handshake through the SDK's `StreamableHTTPClientTransport`.
- Manual: `claude mcp add`, then in a fresh Claude Code chat run `/mcp` to see the server connected, ask "what's in my brain?" and watch `brain_orient` fire.

## 8. Out of scope

OAuth flows, multi-user tenancy, per-tool permission policies, an `ask` tool, resources or prompts (MCP features other than tools), and rate limiting beyond what the host provides.
