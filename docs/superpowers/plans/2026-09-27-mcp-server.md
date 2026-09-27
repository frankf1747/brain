# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the knowledge base to Claude Code (stdio) and to any MCP client over HTTP with bearer tokens, using the core library's existing functions.

**Architecture:** `buildServer(ctx, { client })` registers nine `brain_*` tools on an `McpServer`; each tool calls a core function and renders text with embedded ids. A `JobManager` runs post-chunk ingestion stages in the background. Two entry points share the server: `stdio.ts` for Claude Code and an express app with a stateless Streamable HTTP transport and token auth for remote clients.

**Tech Stack:** `@modelcontextprotocol/sdk` 1.30+, Zod 4, express 5, the existing core (`postgres`, `Ctx`, `search`, `runPipeline`).

**Spec:** `docs/superpowers/specs/2026-09-27-mcp-server-design.md`
**Prerequisite:** sub-project 1 complete (`docs/superpowers/plans/2026-09-27-knowledge-base-core.md`), all its tests green.
**Working directory:** `/Users/frankfu/Documents/GitHub/brain`

---

## File structure

```
src/
  config.ts                  MODIFY: load .env from the repo root, not cwd
  llm/claude-code.ts         MODIFY: strip Claude session env vars from the child process
  retrieve/documents.ts      getDocument(sql, id, offset, length)
  retrieve/orient.ts         orient(ctx): counts, recent documents, facts, pipeline state
  graph/inspect.ts           findNode, describeNode (CLI `node` switches to it)
  graph/facts.ts             addFact, supersedeFact, verifyFact, listFacts
  mcp/render.ts              text renderers for every tool result
  mcp/jobs.ts                JobManager: background pipeline runs, stalled-job resume
  mcp/server.ts              buildServer(ctx, { client, readOnly })
  mcp/stdio.ts               entry for Claude Code
  mcp/http.ts                buildApp(ctx, tokens): express + auth + stateless transport
  mcp/http-main.ts           entry: listen on PORT
  cli.ts                     MODIFY: node command uses describeNode; add verify-fact; facts shows ids
Dockerfile
test/unit/{claude-code-env,render,facts-tokens}.test.ts
test/integration/{inspect,facts,mcp-server,mcp-http}.test.ts
```

---

### Task 1: Core compatibility for running under Claude Code

**Files:**
- Modify: `src/llm/claude-code.ts`, `src/config.ts`
- Create: `test/unit/claude-code-env.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/claude-code-env.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { childEnv, spawnExec } from "../../src/llm/claude-code.js";

describe("childEnv", () => {
  it("drops Claude Code session markers and keeps everything else", () => {
    const env = childEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/bin", HOME: "/h" });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});

describe("spawnExec", () => {
  it("runs a child without the session markers even when the parent has them", async () => {
    const prev = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const { stdout } = await spawnExec(process.execPath, ["-e", "process.stdout.write(process.env.CLAUDECODE ?? 'unset')"], "");
      expect(stdout).toBe("unset");
    } finally {
      if (prev === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prev;
    }
  });
  it("rejects with stderr on a non-zero exit", async () => {
    await expect(spawnExec(process.execPath, ["-e", "console.error('bad'); process.exit(3)"], "")).rejects.toThrow(/exited with 3: bad/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- claude-code-env`
Expected: FAIL, `childEnv` is not exported.

- [ ] **Step 3: Implement**

In `src/llm/claude-code.ts`, add above `spawnExec` and change `spawn` to use it:
```ts
const SESSION_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

/** The child `claude` process must not think it is nested inside the parent session. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of SESSION_MARKERS) delete out[k];
  return out;
}
```
and in `spawnExec` replace `spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] })` with `spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv() })`.

In `src/config.ts`, replace `import "dotenv/config";` with:
```ts
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

// Resolve .env from the repository root so the MCP server works from any cwd.
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
```

- [ ] **Step 4: Run tests and check the cwd-independent .env**

```bash
npm run test:unit && npm run typecheck
cd /tmp && /Users/frankfu/Documents/GitHub/brain/node_modules/.bin/tsx -e 'import("/Users/frankfu/Documents/GitHub/brain/src/config.ts").then(m => console.log(m.config.databaseUrl))'
cd /Users/frankfu/Documents/GitHub/brain
```
Expected: tests pass; the printed URL matches the one in `.env`, not the default.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Run the Claude Code backend cleanly from inside a Claude Code session; load .env from the repo root

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Document slices, node inspection, orientation

**Files:**
- Create: `src/retrieve/documents.ts`, `src/graph/inspect.ts`, `src/retrieve/orient.ts`
- Create: `test/integration/inspect.test.ts`
- Modify: `src/cli.ts` (node command)

- [ ] **Step 1: Write the failing test**

`test/integration/inspect.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { getDocument } from "../../src/retrieve/documents.js";
import { describeNode, findNode } from "../../src/graph/inspect.js";
import { orient } from "../../src/retrieve/orient.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: "2026-09-01" } : fakeExtraction;

describe("getDocument", () => {
  it("returns metadata and a raw slice, or null for unknown ids", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: "0123456789".repeat(5), sourceKind: "note" });
    const d = (await getDocument(sql, id, 10, 5))!;
    expect(d.text).toBe("01234");
    expect(d.totalLength).toBe(50);
    expect(d.sourceKind).toBe("note");
    expect(await getDocument(sql, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await getDocument(sql, "not-a-uuid")).toBeNull();
  });
});

describe("describeNode", () => {
  it("finds by name, alias or id and reports edges with evidence, facts and mentions", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT." });
    const byAlias = (await findNode(sql, "acme"))!;
    const report = (await describeNode(sql, byAlias.id))!;
    expect(report.name).toBe("Acme Corp");
    expect(report.edges).toEqual([expect.objectContaining({ direction: "in", type: "applied_to", otherName: "Frank Fu" })]);
    expect(report.edges[0].evidence).toContain("Acme Corp");
    expect(report.mentionedIn.length).toBe(1);
    const self = (await describeNode(sql, "Frank Fu"))!;
    expect(self.facts.map((f) => f.predicate)).toEqual(["visa_status"]);
    expect(await describeNode(sql, "nobody here")).toBeNull();
  });
});

describe("orient", () => {
  it("summarizes what the base holds", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "I applied to Acme Corp.", sourceKind: "note" });
    await ingest(ctx, { text: "Acme raised money.", sourceKind: "news" });
    const o = await orient(ctx);
    expect(o.totalDocuments).toBe(2);
    expect(o.documentsByKind).toEqual(expect.arrayContaining([{ kind: "news", count: 1 }, { kind: "note", count: 1 }]));
    expect(o.nodesByType.find((n) => n.type === "organization")?.count).toBe(1);
    expect(o.recent[0].title).toBe("Acme note");
    expect(o.facts.length).toBe(2); // same fact, two evidence chunks; the ops agent later merges these
    expect(o.pipeline.find((p) => p.stage === "done")?.count).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:int -- inspect`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement documents.ts**

`src/retrieve/documents.ts`:
```ts
import type { Db } from "../db.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DocumentSlice {
  id: string;
  title: string | null;
  sourceKind: string;
  origin: string | null;
  occurredAt: Date | null;
  ingestedAt: Date;
  summary: string | null;
  totalLength: number;
  offset: number;
  text: string;
}

export async function getDocument(sql: Db, id: string, offset = 0, length = 4000): Promise<DocumentSlice | null> {
  if (!UUID.test(id)) return null;
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLength = Math.min(20000, Math.max(1, Math.floor(length)));
  const [row] = await sql<{
    id: string; title: string | null; source_kind: string; origin: string | null; occurred_at: Date | null;
    ingested_at: Date; summary: string | null; total_length: number; text: string;
  }[]>`
    select id, title, source_kind, origin, occurred_at, ingested_at, summary,
           length(raw_content) as total_length, substr(raw_content, ${safeOffset + 1}, ${safeLength}) as text
    from brain.documents where id = ${id}`;
  if (!row) return null;
  return {
    id: row.id, title: row.title, sourceKind: row.source_kind, origin: row.origin, occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at, summary: row.summary, totalLength: Number(row.total_length), offset: safeOffset, text: row.text,
  };
}
```

- [ ] **Step 4: Implement inspect.ts**

`src/graph/inspect.ts`:
```ts
import type { Db } from "../db.js";
import { canonicalName } from "../text/normalize.js";
import { UUID } from "../retrieve/documents.js";

export interface NodeRef {
  id: string;
  type: string;
  name: string;
}

export interface NodeEdge {
  direction: "out" | "in";
  type: string;
  otherId: string;
  otherName: string;
  otherType: string;
  evidence: string | null;
  evidenceDocumentId: string | null;
  evidenceDocumentTitle: string | null;
}

export interface NodeReport extends NodeRef {
  aliases: string[];
  properties: Record<string, unknown>;
  verified: boolean;
  isSelf: boolean;
  edges: NodeEdge[];
  facts: { id: string; predicate: string; objectText: string; verified: boolean }[];
  mentionCount: number;
  mentionedIn: { documentId: string; title: string | null; sourceKind: string }[];
}

/** Resolves a name, alias or id to the canonical node. */
export async function findNode(sql: Db, nameOrId: string): Promise<NodeRef | null> {
  const key = canonicalName(nameOrId);
  const rows = UUID.test(nameOrId)
    ? await sql<NodeRef[]>`
        select x.id, x.type, x.name from brain.nodes n join brain.nodes x on x.id = brain.canonical_node(n.id) where n.id = ${nameOrId}`
    : await sql<NodeRef[]>`
        select x.id, x.type, x.name from brain.nodes n join brain.nodes x on x.id = brain.canonical_node(n.id)
        where n.canonical_name = ${key} or ${key} = any(n.aliases) order by n.created_at limit 1`;
  return rows[0] ?? null;
}

export async function describeNode(sql: Db, nameOrId: string): Promise<NodeReport | null> {
  const ref = await findNode(sql, nameOrId);
  if (!ref) return null;
  const [node] = await sql<{ aliases: string[]; properties: Record<string, unknown>; verified: boolean; is_self: boolean }[]>`
    select aliases, properties, verified, is_self from brain.nodes where id = ${ref.id}`;
  const edges = await sql<NodeEdge[]>`
    select case when brain.canonical_node(e.from_node) = ${ref.id} then 'out' else 'in' end as direction,
           e.type, o.id as "otherId", o.name as "otherName", o.type as "otherType",
           left(c.content, 200) as evidence, c.document_id as "evidenceDocumentId", d.title as "evidenceDocumentTitle"
    from brain.edges e
    join brain.nodes o on o.id = brain.canonical_node(case when brain.canonical_node(e.from_node) = ${ref.id} then e.to_node else e.from_node end)
    left join brain.chunks c on c.id = e.evidence_chunk_id
    left join brain.documents d on d.id = c.document_id
    where brain.canonical_node(e.from_node) = ${ref.id} or brain.canonical_node(e.to_node) = ${ref.id}
    order by e.type, o.name`;
  const facts = await sql<{ id: string; predicate: string; object_text: string; verified: boolean }[]>`
    select id, predicate, object_text, verified from brain.current_facts(${ref.id})`;
  const mentionedIn = await sql<{ documentId: string; title: string | null; sourceKind: string }[]>`
    select distinct d.id as "documentId", d.title, d.source_kind as "sourceKind"
    from brain.mentions m join brain.chunks c on c.id = m.chunk_id join brain.documents d on d.id = c.document_id
    where m.node_id = ${ref.id} order by d.title`;
  const [{ n }] = await sql<{ n: string }[]>`select count(*)::text as n from brain.mentions where node_id = ${ref.id}`;
  return {
    ...ref,
    aliases: node.aliases,
    properties: node.properties,
    verified: node.verified,
    isSelf: node.is_self,
    edges,
    facts: facts.map((f) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text, verified: f.verified })),
    mentionCount: Number(n),
    mentionedIn,
  };
}
```

- [ ] **Step 5: Implement orient.ts**

`src/retrieve/orient.ts`:
```ts
import type { Ctx } from "../ctx.js";
import { stageCounts } from "../ingest/pipeline.js";

export interface Orientation {
  totalDocuments: number;
  documentsByKind: { kind: string; count: number }[];
  nodesByType: { type: string; count: number }[];
  recent: { id: string; title: string | null; sourceKind: string; occurredAt: Date | null; ingestedAt: Date }[];
  facts: { id: string; predicate: string; objectText: string; verified: boolean }[];
  pipeline: { stage: string; count: number; failed: number }[];
}

export async function orient(ctx: Ctx): Promise<Orientation> {
  const { sql } = ctx;
  const [kinds, types, recent, facts, pipeline] = await Promise.all([
    sql<{ kind: string; count: string }[]>`select source_kind as kind, count(*)::text as count from brain.documents group by source_kind order by count desc`,
    sql<{ type: string; count: string }[]>`select type, count(*)::text as count from brain.nodes where merged_into is null group by type order by count desc`,
    sql<Orientation["recent"]>`
      select id, title, source_kind as "sourceKind", occurred_at as "occurredAt", ingested_at as "ingestedAt"
      from brain.documents order by ingested_at desc limit 10`,
    sql<{ id: string; predicate: string; object_text: string; verified: boolean }[]>`
      select id, predicate, object_text, verified from brain.current_facts(null) order by verified desc, predicate limit 50`,
    stageCounts(ctx),
  ]);
  return {
    totalDocuments: kinds.reduce((s, k) => s + Number(k.count), 0),
    documentsByKind: kinds.map((k) => ({ kind: k.kind, count: Number(k.count) })),
    nodesByType: types.map((t) => ({ type: t.type, count: Number(t.count) })),
    recent,
    facts: facts.map((f) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text, verified: f.verified })),
    pipeline,
  };
}
```

- [ ] **Step 6: Point the CLI `node` command at describeNode**

In `src/cli.ts`, replace the whole `program.command("node <nameOrId>")` block with:
```ts
program
  .command("node <nameOrId>")
  .description("Show a node with its facts, edges and evidence")
  .action(async (nameOrId: string) => {
    const { describeNode } = await import("./graph/inspect.js");
    await withCtx(async (ctx) => {
      const r = await describeNode(ctx.sql, nameOrId);
      if (!r) return void console.log("No such node");
      console.log(`${r.type}: ${r.name}${r.verified ? " (verified)" : ""}  ${r.id}`);
      if (r.aliases.length) console.log(`aliases: ${r.aliases.join(", ")}`);
      console.log(`properties: ${JSON.stringify(r.properties)}`);
      for (const e of r.edges) {
        console.log(`  ${e.direction === "out" ? "->" : "<-"} ${e.type} ${e.otherName} (${e.otherType})`);
        if (e.evidence) console.log(`       "${e.evidence.replace(/\s+/g, " ")}"${e.evidenceDocumentTitle ? ` — ${e.evidenceDocumentTitle}` : ""}`);
      }
      for (const f of r.facts) console.log(`  fact ${f.predicate}: ${f.objectText}${f.verified ? "" : " (unverified)"}`);
      console.log(`mentioned in ${r.mentionCount} passages across ${r.mentionedIn.length} documents`);
    });
  });
```
Remove the now-unused `canonicalName` import from `src/cli.ts` if nothing else uses it.

- [ ] **Step 7: Run tests and typecheck**

Run: `npm run test:int -- inspect && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Document slices, node inspection and orientation as library functions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Fact writes and verification

**Files:**
- Create: `src/graph/facts.ts`, `test/integration/facts.test.ts`
- Modify: `src/cli.ts` (facts shows ids; new verify-fact command)

- [ ] **Step 1: Write the failing test**

`test/integration/facts.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { addFact, supersedeFact, verifyFact, listFacts } from "../../src/graph/facts.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("facts", () => {
  it("adds an unverified fact labeled with the writer, and dedupes", async () => {
    const a = await addFact(sql, { predicate: "Lives In", objectText: "Los Angeles", by: "agent:test" });
    const b = await addFact(sql, { predicate: "lives_in", objectText: "Los Angeles", by: "agent:test" });
    expect(b).toBe(a);
    const [f] = await listFacts(sql, false);
    expect(f).toEqual(expect.objectContaining({ id: a, predicate: "lives_in", objectText: "Los Angeles", verified: false, verifiedBy: "agent:test" }));
  });

  it("supersedes: the old fact leaves the current view, history remains", async () => {
    const a = await addFact(sql, { predicate: "lives_in", objectText: "Austin", by: "frank" });
    const b = await supersedeFact(sql, a, { objectText: "Los Angeles", by: "agent:test", validFrom: new Date("2026-09-01") });
    const current = await listFacts(sql, false);
    expect(current.map((f) => f.id)).toEqual([b]);
    const all = await listFacts(sql, true);
    expect(all.find((f) => f.id === a)?.supersededBy).toBe(b);
    await expect(supersedeFact(sql, "00000000-0000-0000-0000-000000000000", { objectText: "x", by: "t" })).rejects.toThrow(/not found/);
  });

  it("verifies", async () => {
    const a = await addFact(sql, { predicate: "prefers", objectText: "hybrid work", by: "agent:test" });
    expect(await verifyFact(sql, a, "frank")).toBe(true);
    expect(await verifyFact(sql, "00000000-0000-0000-0000-000000000000", "frank")).toBe(false);
    const [f] = await listFacts(sql, false);
    expect(f.verified).toBe(true);
    expect(f.verifiedBy).toBe("frank");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:int -- facts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/graph/facts.ts`:
```ts
import type { Db } from "../db.js";
import { normalizePredicate } from "../ingest/stages/resolve.js";
import { UUID } from "../retrieve/documents.js";

export interface FactDetail {
  id: string;
  predicate: string;
  objectText: string;
  confidence: number | null;
  verified: boolean;
  verifiedBy: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  supersededBy: string | null;
  sourceChunkId: string | null;
  createdAt: Date;
}

async function selfId(sql: Db): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
  return row.id;
}

/** Inserts an unverified fact about the owner. Same predicate and value returns the existing id. */
export async function addFact(sql: Db, input: { predicate: string; objectText: string; by: string; validFrom?: Date | null; subjectId?: string }): Promise<string> {
  const subject = input.subjectId ?? (await selfId(sql));
  const [row] = await sql<{ id: string }[]>`
    insert into brain.facts (subject_id, predicate, object_text, confidence, verified, verified_by, valid_from)
    values (${subject}, ${normalizePredicate(input.predicate)}, ${input.objectText.trim()}, 1, false, ${input.by}, ${input.validFrom ?? null})
    on conflict (subject_id, predicate, object_text, coalesce(source_chunk_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set created_at = brain.facts.created_at
    returning id`;
  return row.id;
}

/** Replaces a fact's value. The old fact is kept and points at the new one. */
export async function supersedeFact(sql: Db, factId: string, input: { objectText: string; by: string; validFrom?: Date | null }): Promise<string> {
  if (!UUID.test(factId)) throw new Error(`Fact ${factId} not found`);
  const [old] = await sql<{ subject_id: string; predicate: string; superseded_by: string | null }[]>`
    select subject_id, predicate, superseded_by from brain.facts where id = ${factId}`;
  if (!old) throw new Error(`Fact ${factId} not found`);
  if (old.superseded_by) throw new Error(`Fact ${factId} is already superseded by ${old.superseded_by}`);
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into brain.facts (subject_id, predicate, object_text, confidence, verified, verified_by, valid_from)
      values (${old.subject_id}, ${old.predicate}, ${input.objectText.trim()}, 1, false, ${input.by}, ${input.validFrom ?? null})
      on conflict (subject_id, predicate, object_text, coalesce(source_chunk_id, '00000000-0000-0000-0000-000000000000'::uuid))
      do update set created_at = brain.facts.created_at
      returning id`;
    await tx`update brain.facts set superseded_by = ${row.id}, valid_to = coalesce(valid_to, current_date) where id = ${factId}`;
    return row.id;
  });
}

export async function verifyFact(sql: Db, factId: string, by = "frank"): Promise<boolean> {
  if (!UUID.test(factId)) return false;
  const rows = await sql`update brain.facts set verified = true, verified_by = ${by} where id = ${factId} returning id`;
  return rows.length === 1;
}

export async function listFacts(sql: Db, all: boolean, subjectId?: string): Promise<FactDetail[]> {
  const subject = subjectId ?? (await selfId(sql));
  const rows = await sql<{
    id: string; predicate: string; object_text: string; confidence: number | null; verified: boolean; verified_by: string | null;
    valid_from: Date | null; valid_to: Date | null; superseded_by: string | null; source_chunk_id: string | null; created_at: Date;
  }[]>`
    select id, predicate, object_text, confidence, verified, verified_by, valid_from, valid_to, superseded_by, source_chunk_id, created_at
    from brain.facts
    where subject_id = ${subject}
      and (${all} or (superseded_by is null and (valid_to is null or valid_to >= current_date)))
    order by predicate, created_at`;
  return rows.map((r) => ({
    id: r.id, predicate: r.predicate, objectText: r.object_text, confidence: r.confidence, verified: r.verified, verifiedBy: r.verified_by,
    validFrom: r.valid_from, validTo: r.valid_to, supersededBy: r.superseded_by, sourceChunkId: r.source_chunk_id, createdAt: r.created_at,
  }));
}
```

- [ ] **Step 4: Update the CLI**

In `src/cli.ts`, replace the `program.command("facts")` block with:
```ts
program
  .command("facts")
  .description("Current facts about the owner, with ids")
  .option("--all", "include superseded and expired facts")
  .action(async (opts) => {
    const { listFacts } = await import("./graph/facts.js");
    await withCtx(async (ctx) => {
      for (const f of await listFacts(ctx.sql, Boolean(opts.all))) {
        const flags = [
          f.verified ? `verified by ${f.verifiedBy}` : `unverified, ${f.verifiedBy ?? "unknown"}`,
          f.supersededBy ? "superseded" : null,
          f.validTo ? `until ${f.validTo.toISOString().slice(0, 10)}` : null,
        ].filter(Boolean).join("; ");
        console.log(`${f.id}  ${f.predicate.padEnd(24)} ${f.objectText}  (${flags})`);
      }
    });
  });

program
  .command("verify-fact <id>")
  .description("Mark a fact as verified by you")
  .action(async (id: string) => {
    const { verifyFact } = await import("./graph/facts.js");
    await withCtx(async (ctx) => console.log((await verifyFact(ctx.sql, id, "frank")) ? "verified" : "no such fact"));
  });
```

- [ ] **Step 5: Run tests**

Run: `npm run test:int -- facts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Fact writes: add, supersede, verify, list; CLI shows fact ids

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Text renderers

**Files:**
- Create: `src/mcp/render.ts`, `test/unit/render.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/render.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts } from "../../src/mcp/render.js";

describe("renderSearch", () => {
  it("numbers passages with ids, lists entities, facts and the fallback notice", () => {
    const text = renderSearch({
      query: "q",
      passages: [
        { chunkId: "c1", documentId: "d1", documentTitle: "Doc", sourceKind: "news", content: "Body text", parentContent: null, headingPath: ["H"], charStart: 0, charEnd: 9, score: 0.8, group: "hybrid" },
        { chunkId: null, documentId: "d2", documentTitle: null, sourceKind: "note", content: "raw hit", parentContent: null, headingPath: [], charStart: 0, charEnd: 7, score: 0, group: "fallback" },
      ],
      documents: [{ documentId: "d1", title: "Doc", sourceKind: "news", summary: "S", score: 0.1 }],
      entities: [{ id: "n1", type: "organization", name: "Acme", neighbors: [{ id: "n2", type: "place", name: "Austin", depth: 1 }] }],
      facts: [{ id: "f1", predicate: "visa_status", objectText: "F-1", confidence: 1, verified: true, sourceChunkId: null }],
      usedFallback: true,
      topScore: 0.8,
    });
    expect(text).toContain("[P1] hybrid · news · Doc (document d1, chunk c1)");
    expect(text).toContain("[P2] fallback · note (document d2)");
    expect(text).toContain("organization: Acme (node n1) — Austin (place)");
    expect(text).toContain("[F1] visa_status: F-1 (verified)");
    expect(text).toContain("weak match");
  });
  it("says so when nothing was found", () => {
    expect(renderSearch({ query: "q", passages: [], documents: [], entities: [], facts: [], usedFallback: true, topScore: null })).toContain("No passages matched");
  });
});

describe("other renderers", () => {
  it("renderOrient lists counts and usage guidance", () => {
    const t = renderOrient({
      totalDocuments: 2, documentsByKind: [{ kind: "news", count: 2 }], nodesByType: [{ type: "person", count: 3 }],
      recent: [{ id: "d1", title: "T", sourceKind: "news", occurredAt: null, ingestedAt: new Date("2026-09-27T00:00:00Z") }],
      facts: [{ id: "f", predicate: "p", objectText: "o", verified: false }], pipeline: [{ stage: "done", count: 2, failed: 0 }],
    });
    expect(t).toContain("2 documents");
    expect(t).toContain("news: 2");
    expect(t).toContain("person: 3");
    expect(t).toContain("brain_search");
  });
  it("renderNode shows edges with direction and evidence", () => {
    const t = renderNode({
      id: "n1", type: "organization", name: "Acme", aliases: ["acme"], properties: {}, verified: false, isSelf: false,
      edges: [{ direction: "in", type: "applied_to", otherId: "n0", otherName: "Frank Fu", otherType: "person", evidence: "I applied", evidenceDocumentId: "d1", evidenceDocumentTitle: "Note" }],
      facts: [], mentionCount: 1, mentionedIn: [{ documentId: "d1", title: "Note", sourceKind: "note" }],
    });
    expect(t).toContain("← applied_to Frank Fu (person, node n0)");
    expect(t).toContain('"I applied"');
  });
  it("renderDocument shows the slice window", () => {
    const t = renderDocument({ id: "d1", title: "T", sourceKind: "news", origin: null, occurredAt: null, ingestedAt: new Date(0), summary: null, totalLength: 100, offset: 10, text: "abc" });
    expect(t).toContain("characters 10–13 of 100");
    expect(t).toContain("abc");
  });
  it("renderFacts marks unverified and superseded", () => {
    const t = renderFacts([{ id: "f1", predicate: "p", objectText: "o", confidence: null, verified: false, verifiedBy: "agent:x", validFrom: null, validTo: null, supersededBy: "f2", sourceChunkId: null, createdAt: new Date(0) }]);
    expect(t).toContain("[F1] p: o (unverified, agent:x; superseded) id f1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- render`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/mcp/render.ts`:
```ts
import type { SearchResult } from "../retrieve/search.js";
import type { Orientation } from "../retrieve/orient.js";
import type { NodeReport } from "../graph/inspect.js";
import type { DocumentSlice } from "../retrieve/documents.js";
import type { FactDetail } from "../graph/facts.js";

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export function renderSearch(r: SearchResult): string {
  const out: string[] = [];
  if (r.usedFallback) out.push("(weak match: results include raw substring hits)\n");
  if (r.passages.length === 0) out.push("No passages matched.");
  r.passages.forEach((p, i) => {
    const where = p.chunkId ? `(document ${p.documentId}, chunk ${p.chunkId})` : `(document ${p.documentId})`;
    const title = p.documentTitle ? ` · ${p.documentTitle}` : "";
    out.push(`[P${i + 1}] ${p.group} · ${p.sourceKind}${title} ${where}${p.headingPath.length ? `\n  ${p.headingPath.join(" > ")}` : ""}\n${p.content.trim()}\n`);
  });
  if (r.documents.length) out.push("Documents by summary: " + r.documents.map((d) => `${d.title ?? "(untitled)"} [${d.sourceKind}] (document ${d.documentId})`).join("; "));
  for (const e of r.entities) {
    const n = e.neighbors.map((x) => `${x.name} (${x.type})`).join(", ") || "no neighbors";
    out.push(`Entity ${e.type}: ${e.name} (node ${e.id}) — ${n}`);
  }
  if (r.facts.length) out.push("Facts about the owner:\n" + r.facts.map((f, i) => `[F${i + 1}] ${f.predicate}: ${f.objectText} (${f.verified ? "verified" : "unverified"})`).join("\n"));
  return out.join("\n");
}

export function renderOrient(o: Orientation): string {
  return [
    `The knowledge base holds ${o.totalDocuments} documents and ${o.nodesByType.reduce((s, t) => s + t.count, 0)} entities.`,
    `Documents by kind: ${o.documentsByKind.map((k) => `${k.kind}: ${k.count}`).join(", ") || "none"}.`,
    `Entities by type: ${o.nodesByType.map((t) => `${t.type}: ${t.count}`).join(", ") || "none"}.`,
    `Pipeline: ${o.pipeline.filter((p) => p.count).map((p) => `${p.stage} ${p.count}${p.failed ? ` (${p.failed} failed)` : ""}`).join(", ") || "idle"}.`,
    "",
    "Most recent documents:",
    ...o.recent.map((d) => `- ${d.title ?? "(untitled)"} [${d.sourceKind}] ${day(d.occurredAt) ?? day(d.ingestedAt)} (document ${d.id})`),
    "",
    "Current facts about the owner:",
    ...(o.facts.length ? o.facts.map((f) => `- ${f.predicate}: ${f.objectText}${f.verified ? "" : " (unverified)"}`) : ["- none yet"]),
    "",
    "How to use: brain_search for anything the owner may have read, written or discussed; brain_get_node for a person, company or topic; brain_get_document to read more of a hit; brain_ingest to save new material; brain_add_fact to record something the owner states about themselves.",
  ].join("\n");
}

export function renderNode(n: NodeReport): string {
  const out = [`${n.type}: ${n.name}${n.verified ? " (verified)" : ""} (node ${n.id})`];
  if (n.aliases.length) out.push(`Aliases: ${n.aliases.join(", ")}`);
  if (Object.keys(n.properties).length) out.push(`Properties: ${JSON.stringify(n.properties)}`);
  if (n.edges.length) {
    out.push("Relationships:");
    for (const e of n.edges) {
      out.push(`- ${e.direction === "out" ? "→" : "←"} ${e.type} ${e.otherName} (${e.otherType}, node ${e.otherId})`);
      if (e.evidence) out.push(`    "${e.evidence.replace(/\s+/g, " ").trim()}"${e.evidenceDocumentTitle ? ` — ${e.evidenceDocumentTitle} (document ${e.evidenceDocumentId})` : ""}`);
    }
  }
  if (n.facts.length) out.push("Facts:\n" + n.facts.map((f) => `- ${f.predicate}: ${f.objectText}${f.verified ? "" : " (unverified)"} (fact ${f.id})`).join("\n"));
  out.push(`Mentioned in ${n.mentionCount} passages across ${n.mentionedIn.length} documents:` + (n.mentionedIn.length ? "\n" + n.mentionedIn.map((d) => `- ${d.title ?? "(untitled)"} [${d.sourceKind}] (document ${d.documentId})`).join("\n") : ""));
  return out.join("\n");
}

export function renderDocument(d: DocumentSlice): string {
  const end = d.offset + d.text.length;
  return [
    `${d.title ?? "(untitled)"} [${d.sourceKind}] (document ${d.id})`,
    `origin: ${d.origin ?? "n/a"} · about: ${day(d.occurredAt) ?? "unknown"} · ingested: ${day(d.ingestedAt)}`,
    d.summary ? `summary: ${d.summary}` : "",
    `--- characters ${d.offset}–${end} of ${d.totalLength}${end < d.totalLength ? ` (call again with offset ${end} for more)` : ""} ---`,
    d.text,
  ].filter((l) => l !== "").join("\n");
}

export function renderFacts(facts: FactDetail[]): string {
  if (facts.length === 0) return "No facts recorded.";
  return facts
    .map((f, i) => {
      const state = f.verified ? `verified by ${f.verifiedBy}` : `unverified, ${f.verifiedBy ?? "unknown"}`;
      const extra = [f.supersededBy ? "superseded" : null, f.validTo ? `until ${day(f.validTo)}` : null].filter(Boolean).join("; ");
      return `[F${i + 1}] ${f.predicate}: ${f.objectText} (${state}${extra ? "; " + extra : ""}) id ${f.id}`;
    })
    .join("\n");
}

export function renderStatus(pipeline: { stage: string; count: number; failed: number }[], inflight: string[], failures: { document_id: string; stage: string; error: string }[]): string {
  const out = [pipeline.map((p) => `${p.stage}: ${p.count}${p.failed ? ` (${p.failed} failed)` : ""}`).join(", ")];
  out.push(inflight.length ? `Processing in this server: ${inflight.join(", ")}` : "Nothing processing in this server.");
  for (const f of failures) out.push(`- ${f.document_id} stuck after ${f.stage}: ${f.error}`);
  return out.join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- render && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Text renderers for MCP tool results with embedded ids

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Job manager and the MCP server

**Files:**
- Create: `src/mcp/jobs.ts`, `src/mcp/server.ts`, `test/integration/mcp-server.test.ts`

- [ ] **Step 1: Install the SDK**

```bash
npm install @modelcontextprotocol/sdk
npm ls zod @modelcontextprotocol/sdk
```
Expected: SDK 1.30 or newer, zod 4.x, no peer warnings.

- [ ] **Step 2: Write the failing test**

`test/integration/mcp-server.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { buildServer } from "../../src/mcp/server.js";
import { JobManager } from "../../src/mcp/jobs.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: null } : fakeExtraction;

async function connect(readOnly = false) {
  const ctx = fakeCtx(sql, handler);
  const jobs = new JobManager(ctx, () => {});
  const server = buildServer(ctx, { client: "test", jobs, readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as { type: string; text: string }[];
    return { text: content.map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
  };
  return { ctx, jobs, client, call, close: () => Promise.all([client.close(), server.close()]) };
}

describe("brain MCP server", () => {
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

  it("ingests quickly, finishes in the background, then searches and reads", async () => {
    const s = await connect();
    const ing = await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    expect(ing.isError).toBe(false);
    expect(ing.text).toMatch(/document [0-9a-f-]{36}/);
    expect(ing.text).toContain("chunked");
    const id = /document ([0-9a-f-]{36})/.exec(ing.text)![1];
    expect(s.jobs.pending).toContain(id);
    await s.jobs.drain();
    const [job] = await sql<{ stage: string }[]>`select stage from brain.ingest_jobs where document_id = ${id}`;
    expect(job.stage).toBe("done");

    const search = await s.call("brain_search", { query: "Acme Corp", k: 5 });
    expect(search.text).toContain("[P1]");
    expect(search.text).toContain(`document ${id}`);
    expect(search.text).toContain("Entity organization: Acme Corp");
    expect(search.text).toContain("visa_status: F-1 OPT");

    const doc = await s.call("brain_get_document", { document_id: id, offset: 0, length: 20 });
    expect(doc.text).toContain("I applied to Acme Cor");
    const node = await s.call("brain_get_node", { name_or_id: "acme" });
    expect(node.text).toContain("← applied_to Frank Fu");
    const orient = await s.call("brain_orient");
    expect(orient.text).toContain("1 documents");
    const status = await s.call("brain_status");
    expect(status.text).toContain("done: 1");
    await s.close();
  });

  it("adds and supersedes facts labeled with the client", async () => {
    const s = await connect();
    const a = await s.call("brain_add_fact", { predicate: "lives_in", object_text: "Austin" });
    const idA = /fact ([0-9a-f-]{36})/.exec(a.text)![1];
    const b = await s.call("brain_supersede_fact", { fact_id: idA, object_text: "Los Angeles" });
    const idB = /fact ([0-9a-f-]{36})/.exec(b.text)![1];
    const current = await s.call("brain_get_facts");
    expect(current.text).toContain(`lives_in: Los Angeles (unverified, agent:test) id ${idB}`);
    expect(current.text).not.toContain(idA);
    const all = await s.call("brain_get_facts", { all: true });
    expect(all.text).toContain("superseded");
    await s.close();
  });

  it("returns errors as isError instead of crashing", async () => {
    const s = await connect();
    const r = await s.call("brain_supersede_fact", { fact_id: "00000000-0000-0000-0000-000000000000", object_text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not found");
    const d = await s.call("brain_get_document", { document_id: "nope" });
    expect(d.isError).toBe(true);
    await s.close();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test:int -- mcp-server`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement jobs.ts**

`src/mcp/jobs.ts`:
```ts
import type { Ctx } from "../ctx.js";
import { runPipeline, type PipelineResult } from "../ingest/pipeline.js";

/** Runs post-chunk pipeline stages in the background inside the server process. */
export class JobManager {
  private readonly inflight = new Map<string, Promise<PipelineResult>>();

  constructor(
    private readonly ctx: Ctx,
    private readonly log: (message: string) => void = (m) => process.stderr.write(m + "\n"),
  ) {}

  get pending(): string[] {
    return [...this.inflight.keys()];
  }

  start(documentId: string): void {
    if (this.inflight.has(documentId)) return;
    const run = runPipeline(this.ctx, documentId)
      .then((r) => {
        if (r.error) this.log(`brain: document ${documentId} stopped after ${r.stage}: ${r.error}`);
        return r;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`brain: document ${documentId} failed: ${message}`);
        return { documentId, stage: "stored" as const, error: message };
      })
      .finally(() => this.inflight.delete(documentId));
    this.inflight.set(documentId, run);
  }

  /** Picks up jobs another process left unfinished. */
  async resumeStalled(limit = 5, olderThanMinutes = 10): Promise<string[]> {
    const rows = await this.ctx.sql<{ document_id: string }[]>`
      select document_id from brain.ingest_jobs
      where stage <> 'done' and updated_at < now() - make_interval(mins => ${olderThanMinutes})
      order by updated_at limit ${limit}`;
    const started: string[] = [];
    for (const r of rows) {
      if (this.inflight.has(r.document_id)) continue;
      this.start(r.document_id);
      started.push(r.document_id);
    }
    return started;
  }

  async drain(): Promise<void> {
    await Promise.all(this.inflight.values());
  }
}
```

- [ ] **Step 5: Implement server.ts**

`src/mcp/server.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { storeDocument } from "../ingest/store.js";
import { runPipeline, stageCounts } from "../ingest/pipeline.js";
import { search } from "../retrieve/search.js";
import { orient } from "../retrieve/orient.js";
import { getDocument } from "../retrieve/documents.js";
import { describeNode } from "../graph/inspect.js";
import { addFact, supersedeFact, listFacts } from "../graph/facts.js";
import { JobManager } from "./jobs.js";
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus } from "./render.js";

export interface ServerOptions {
  client: string;
  jobs?: JobManager;
  readOnly?: boolean;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (err: unknown): ToolResult => ({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
const dateOrUndefined = (s?: string) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : undefined);

export function buildServer(ctx: Ctx, opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" });
  const jobs = opts.jobs ?? new JobManager(ctx);
  const by = `agent:${opts.client}`;

  server.registerTool(
    "brain_orient",
    { title: "What the knowledge base holds", description: "Call first in a session. Returns counts by kind and type, recent documents, current facts about the owner, and guidance on which tool to use.", inputSchema: {} },
    async () => {
      try { return text(renderOrient(await orient(ctx))); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_search",
    {
      title: "Search the knowledge base",
      description: "Hybrid keyword and semantic search over everything the owner has saved, with entity expansion and the owner's facts. Returns numbered passages with document and chunk ids.",
      inputSchema: {
        query: z.string().min(1),
        k: z.number().int().min(1).max(30).optional().describe("Number of passages, default 10"),
        source_kinds: z.array(z.string()).optional().describe("Only these kinds, e.g. [\"news\",\"conversation\"]"),
        since: z.string().optional().describe("ISO date lower bound"),
        until: z.string().optional().describe("ISO date upper bound"),
        verified_only: z.boolean().optional(),
      },
    },
    async (a) => {
      try {
        const r = await search(ctx, a.query, { k: a.k, sourceKinds: a.source_kinds, since: dateOrUndefined(a.since), until: dateOrUndefined(a.until), verifiedOnly: a.verified_only, client: opts.client });
        return text(renderSearch(r));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_get_document",
    { title: "Read a document", description: "Metadata and a slice of the raw text of one document by id. Use offset to page.", inputSchema: { document_id: z.string(), offset: z.number().int().min(0).optional(), length: z.number().int().min(1).max(20000).optional() } },
    async (a) => {
      try {
        const d = await getDocument(ctx.sql, a.document_id, a.offset ?? 0, a.length ?? 4000);
        return d ? text(renderDocument(d)) : fail(new Error(`Document ${a.document_id} not found`));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_get_node",
    { title: "Inspect an entity", description: "A person, organization, place, project, concept, event or artifact by name, alias or id: relationships with evidence, facts, and where it is mentioned.", inputSchema: { name_or_id: z.string().min(1) } },
    async (a) => {
      try {
        const n = await describeNode(ctx.sql, a.name_or_id);
        return n ? text(renderNode(n)) : fail(new Error(`No entity matches "${a.name_or_id}"`));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_get_facts",
    { title: "Facts about the owner", description: "Current facts about the owner with ids and verification state. all=true includes superseded and expired facts.", inputSchema: { all: z.boolean().optional() } },
    async (a) => {
      try { return text(renderFacts(await listFacts(ctx.sql, Boolean(a.all)))); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_status",
    { title: "Ingestion status", description: "Pipeline stage counts, failures, and documents still processing in this server.", inputSchema: {} },
    async () => {
      try {
        const failures = await ctx.sql<{ document_id: string; stage: string; error: string }[]>`
          select document_id, stage, error from brain.ingest_jobs where error is not null order by updated_at desc limit 10`;
        return text(renderStatus(await stageCounts(ctx), jobs.pending, failures));
      } catch (e) { return fail(e); }
    },
  );

  if (opts.readOnly) return server;

  server.registerTool(
    "brain_ingest",
    {
      title: "Save to the knowledge base",
      description: "Store any text: a note, a pasted article, a conversation, a job description. Returns immediately after storing and chunking; summary, embeddings and entity extraction continue in the background.",
      inputSchema: {
        text: z.string().min(1),
        title: z.string().optional(),
        source_kind: z.string().optional().describe("Free label: note, conversation, news, job_description, email, paper, paste"),
        origin: z.string().optional().describe("URL, file path or other provenance"),
        occurred_at: z.string().optional().describe("ISO date the content is about"),
        metadata: z.record(z.string(), z.string()).optional(),
      },
    },
    async (a) => {
      try {
        const { id, created } = await storeDocument(ctx.sql, {
          text: a.text, title: a.title ?? null, sourceKind: a.source_kind ?? "paste", origin: a.origin ?? `mcp:${opts.client}`,
          metadata: { ...(a.metadata ?? {}), saved_by: opts.client }, occurredAt: dateOrUndefined(a.occurred_at) ?? null,
        });
        const first = await runPipeline(ctx, id, { until: "chunked" });
        if (first.error) return fail(new Error(`Stored as document ${id} but chunking failed: ${first.error}`));
        jobs.start(id);
        const resumed = await jobs.resumeStalled();
        return text(`${created ? "Saved" : "Already present"}: document ${id} (stage ${first.stage}). Summary, embeddings and extraction continue in the background; brain_status shows progress.${resumed.length ? ` Also resumed ${resumed.length} stalled job(s).` : ""}`);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_add_fact",
    { title: "Record a fact about the owner", description: "Only for things the owner states about themselves. Stored unverified until the owner verifies it.", inputSchema: { predicate: z.string().min(1).describe("snake_case, e.g. lives_in, prefers, visa_status"), object_text: z.string().min(1), valid_from: z.string().optional() } },
    async (a) => {
      try {
        const id = await addFact(ctx.sql, { predicate: a.predicate, objectText: a.object_text, by, validFrom: dateOrUndefined(a.valid_from) ?? null });
        return text(`Recorded fact ${id}: ${a.predicate} = ${a.object_text} (unverified, ${by}).`);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_supersede_fact",
    { title: "Correct a fact", description: "Replace a fact's value. The old fact is kept as history and marked superseded.", inputSchema: { fact_id: z.string(), object_text: z.string().min(1), valid_from: z.string().optional() } },
    async (a) => {
      try {
        const id = await supersedeFact(ctx.sql, a.fact_id, { objectText: a.object_text, by, validFrom: dateOrUndefined(a.valid_from) ?? null });
        return text(`Superseded fact ${a.fact_id} with fact ${id}: ${a.object_text} (unverified, ${by}).`);
      } catch (e) { return fail(e); }
    },
  );

  return server;
}
```

- [ ] **Step 6: Run tests**

Run: `npm run test:int -- mcp-server && npm run typecheck`
Expected: PASS. If `registerTool` complains about the handler's return type, annotate the handler return as `Promise<ToolResult>`; if `inputSchema: {}` is rejected, pass `inputSchema: z.object({})`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "MCP server with nine brain_* tools and background ingestion

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: stdio entry and Claude Code registration

**Files:**
- Create: `src/mcp/stdio.ts`
- Modify: `package.json` (script)

- [ ] **Step 1: Write the entry**

`src/mcp/stdio.ts`:
```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeCtx } from "../ctx.js";
import { buildServer } from "./server.js";

const ctx = makeCtx();
const server = buildServer(ctx, { client: "claude-code", readOnly: process.env.BRAIN_MCP_READONLY === "1" });
await server.connect(new StdioServerTransport());
process.stderr.write("brain: MCP server connected over stdio\n");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => ctx.sql.end()).finally(() => process.exit(0));
  });
}
```

```bash
npm pkg set scripts.mcp:stdio="tsx src/mcp/stdio.ts"
```

- [ ] **Step 2: Protocol smoke test without Claude Code**

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | npm run -s mcp:stdio 2>/dev/null | head -c 3000
```
Expected: two JSON-RPC responses; the second contains `"name":"brain_search"` and eight other tools. Nothing but JSON on stdout.

- [ ] **Step 3: Register with Claude Code at user scope**

```bash
claude mcp add --scope user --transport stdio brain -- /Users/frankfu/Documents/GitHub/brain/node_modules/.bin/tsx /Users/frankfu/Documents/GitHub/brain/src/mcp/stdio.ts
claude mcp list
```
Expected: `brain` listed as connected. Open a new Claude Code chat in the Mac app, run `/mcp`, confirm `brain` shows nine tools, then ask "what's in my brain?" and confirm `brain_orient` is called.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "stdio entry for the MCP server

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: HTTP transport with bearer tokens

**Files:**
- Create: `src/mcp/http.ts`, `src/mcp/http-main.ts`, `test/unit/tokens.test.ts`, `test/integration/mcp-http.test.ts`, `Dockerfile`, `.dockerignore`

- [ ] **Step 1: Install express types**

```bash
npm install express
npm install -D @types/express
```

- [ ] **Step 2: Write the failing tests**

`test/unit/tokens.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseTokens } from "../../src/mcp/http.js";

describe("parseTokens", () => {
  it("maps token to client name and ignores malformed entries", () => {
    const m = parseTokens("claude-desktop:abc, chatgpt:def ,broken,:noname,nokey:");
    expect(m.get("abc")).toBe("claude-desktop");
    expect(m.get("def")).toBe("chatgpt");
    expect(m.size).toBe(2);
    expect(parseTokens(undefined).size).toBe(0);
  });
});
```

`test/integration/mcp-http.test.ts`:
```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { buildApp, parseTokens } from "../../src/mcp/http.js";
import { JobManager } from "../../src/mcp/jobs.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("MCP over HTTP", () => {
  it("rejects missing or wrong tokens and serves tools for a valid one", async () => {
    const ctx = fakeCtx(sql);
    const app = buildApp(ctx, parseTokens("tester:secret123"), new JobManager(ctx, () => {}));
    const httpServer = app.listen(0);
    const port = (httpServer.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    try {
      const noAuth = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
      expect(noAuth.status).toBe(401);
      const wrong = await fetch(url, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
      expect(wrong.status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer secret123" } } });
      const client = new Client({ name: "http-test", version: "0" });
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("brain_search");
      const res = await client.callTool({ name: "brain_add_fact", arguments: { predicate: "lives_in", object_text: "Austin" } });
      expect((res.content as { text: string }[])[0].text).toContain("agent:tester");
      await client.close();
    } finally {
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test:unit -- tokens`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement http.ts**

`src/mcp/http.ts`:
```ts
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Ctx } from "../ctx.js";
import { buildServer } from "./server.js";
import { JobManager } from "./jobs.js";

/** "name:token,name2:token2" -> Map<token, name>. */
export function parseTokens(spec: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (spec ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const token = part.slice(i + 1).trim();
    if (name && token) out.set(token, name);
  }
  return out;
}

export function buildApp(ctx: Ctx, tokens: Map<string, string>, jobs = new JobManager(ctx), readOnly = false) {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.get("/healthz", (_req, res) => void res.status(200).send("ok"));

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const client = tokens.get(token);
    if (!client) return void res.status(401).json({ error: "unauthorized" });
    res.locals.client = client;
    next();
  };

  app.post("/mcp", auth, async (req, res) => {
    const server = buildServer(ctx, { client: String(res.locals.client), jobs, readOnly });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      process.stderr.write(`brain: request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });
  app.get("/mcp", (_req, res) => void res.status(405).end());
  app.delete("/mcp", (_req, res) => void res.status(405).end());
  return app;
}
```

`src/mcp/http-main.ts`:
```ts
import { makeCtx } from "../ctx.js";
import { buildApp, parseTokens } from "./http.js";

const tokens = parseTokens(process.env.BRAIN_TOKENS);
if (tokens.size === 0) {
  process.stderr.write("brain: BRAIN_TOKENS is empty; refusing to start an unauthenticated server\n");
  process.exit(1);
}
const ctx = makeCtx();
const port = Number(process.env.PORT ?? 8080);
buildApp(ctx, tokens, undefined, process.env.BRAIN_MCP_READONLY === "1").listen(port, () => {
  process.stderr.write(`brain: MCP server listening on :${port}/mcp for ${tokens.size} client(s)\n`);
});
```

```bash
npm pkg set scripts.mcp:http="tsx src/mcp/http-main.ts"
```

- [ ] **Step 5: Dockerfile**

`Dockerfile`:
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production PORT=8080 BRAIN_LLM=api
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "src/mcp/http-main.ts"]
```

`.dockerignore`:
```
node_modules
.env
supabase/.temp
docs
test
eval
```

- [ ] **Step 6: Run tests**

Run: `npm run test:unit -- tokens && npm run test:int -- mcp-http && npm run typecheck`
Expected: PASS. If the client hangs on connect, check that the 405 on GET is returned quickly (the client probes GET for a server stream and must get a non-2xx to continue).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "MCP over Streamable HTTP with bearer tokens, plus Dockerfile

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Deployment notes and README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add an MCP section to README.md**

Append:
```markdown
## MCP

### Claude Code (this Mac)

Registered once at user scope; every chat gets the `brain_*` tools:

```bash
claude mcp add --scope user --transport stdio brain -- /Users/frankfu/Documents/GitHub/brain/node_modules/.bin/tsx /Users/frankfu/Documents/GitHub/brain/src/mcp/stdio.ts
```

Say "save this to my brain" in any chat to ingest; ask anything and the model calls `brain_search` when it needs your material.

### Other clients (HTTP)

The hosted server needs `DATABASE_URL` pointing at the Supabase project (after `supabase db push`), `VOYAGE_API_KEY`, and `BRAIN_TOKENS` as `name:token` pairs. It runs with `BRAIN_LLM=api`, so ingestion over HTTP also needs `ANTHROPIC_API_KEY`; set `BRAIN_MCP_READONLY=1` to expose only the read tools and skip that key.

Fly.io example:

```bash
fly launch --no-deploy --name brain-mcp --region sjc
fly secrets set DATABASE_URL='postgresql://...' VOYAGE_API_KEY='...' BRAIN_MCP_READONLY=1 \
  BRAIN_TOKENS="claude-desktop:$(openssl rand -hex 32),chatgpt:$(openssl rand -hex 32)"
fly deploy
curl https://brain-mcp.fly.dev/healthz
```

Then register the remote server in Claude Code as a second entry:

```bash
claude mcp add --transport http brain-remote https://brain-mcp.fly.dev/mcp --header "Authorization: Bearer <token>"
```

Claude Desktop and ChatGPT take the same URL and header in their connector settings. Alternative with no hosting: run `npm run mcp:http` on the Mac and expose the port through Tailscale or a Cloudflare Tunnel.
```

- [ ] **Step 2: Full verification and commit**

```bash
npm run typecheck && npm run test:unit && npm run test:int
git add -A
git commit -m "README: MCP registration and hosting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec section 3 (nine tools) is Task 5; section 4 (client label, background jobs, stderr logging, error shape, text rendering) is Tasks 4 and 5; section 5 (HTTP) is Task 7; section 6 (env stripping and .env path) is Task 1; section 7 (tests) is spread across Tasks 2 to 7.
- `readOnly` hides the three write tools; Task 5's test asserts nine versus six.
- `supersedeFact` also sets `valid_to` on the old fact so the `current_facts` SQL view and `listFacts` agree.
