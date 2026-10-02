# Phase 2: Authorship and Facts About the Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fact about the owner exists only because the owner said it, and the base records who wrote every document. Every document gets an `author` (`owner`, `other`, `unknown`); the extractor is told who wrote the text; resolve refuses to write facts about the owner or relations from the owner for anything the owner did not write; resolution can be undone and re-applied per document (`brain set-author`); single-valued facts such as `lives_in` supersede the older value; and the saved Databricks post stops producing facts about the owner.

**Architecture:** One migration (`20261001000009_author.sql`, idempotent, built up over Tasks 1, 7 and 8) adds `documents.author`, `brain.default_author`, `brain.fact_events`, `brain.fact_effective_from` and `brain.place_short_alias`. `src/ingest/author.ts` holds the author values and defaults; `storeDocument`, the CLI and `brain_ingest` accept an author. The extraction header and pronoun rule depend on the author (`extract.ts`, which the Batches backfill also uses). `resolve.ts` gains a hard gate, `undoResolution`, place short aliases and extractor supersession (through the new `src/graph/supersede.ts`, which `supersedeFact` now shares). `src/ingest/set-author.ts` backs `brain set-author` and the suppressed counts in `brain status` / `brain_status`. The eval reads front matter from fixtures and reports an attribution count.

**Tech Stack:** Postgres 17.6, pgvector 0.8.2 (local Supabase, port 55322), plpgsql, TypeScript ESM run with tsx, vitest, zod 4, postgres.js, commander, @modelcontextprotocol/sdk.

**Spec:** `docs/superpowers/specs/2026-09-30-retrieval-hardening-design.md` §4 (with §8.4 for the attribution metric and §8.6 for the fixtures). Task breakdown: the Phase 2 table in `docs/superpowers/plans/2026-09-30-retrieval-hardening-roadmap.md`. Numbering here: Tasks 1–7 are roadmap tasks 1–7; **Task 8 is roadmap 8b** (place aliases), **Task 9 is roadmap 8** (eval fixtures), **Task 10 is roadmap 9** (real-base cleanup). 8b runs before 8 so the eval corpus is re-ingested once, with every resolve change in place.
**Prerequisite:** Phase 1 complete and merged into `main` (`5ddd458`); `eval/baseline.json` is the Phase 1 baseline. Work on branch `authorship`.
**Working directory:** `/Users/frankfu/Documents/GitHub/brain`

Rules for every task:
- Integration tests run on `brain_test` only: `npm run test:int` recreates it from all migrations. Run one integration file with `bash scripts/prepare-test-db.sh && npx vitest run <file>`. Unit tests: `npx vitest run <file>` or `npm run test:unit`.
- Migrations are applied to `brain_eval` with `psql`. **Never touch the `postgres` database (the real knowledge base) except in Task 10, which the controller runs, not a subagent.** Never use `supabase migration up`: the real database's migration table is out of sync.
- Migration 009 is idempotent and later tasks insert blocks into it **before its final `commit;`**. Re-applying the whole file to `brain_eval` is always safe.
- Each task ends with `npm run eval:run` where retrieval or the eval corpus can change (Tasks 2, 8, 9). Tasks 1 and 3–7 change only ingestion and fact handling, which the already-ingested eval corpus does not exercise; they end with `npm run typecheck` and the test suites instead, and say so.
- Commit per task. The last line of every commit message is `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File structure

```
supabase/migrations/
  20261001000009_author.sql           NEW (Tasks 1, 7, 8): default_author, documents.author + backfill, fact_events,
                                      chunk indexes on facts/edges, fact_effective_from, place_short_alias + backfill
src/
  config.ts                           MODIFY: authorDefaults (T1), singleValuedPredicates (T7)
  ingest/author.ts                    NEW (T1): AUTHORS, Author, isAuthor, parseAuthor, defaultAuthor
  ingest/store.ts                     MODIFY (T1): StoreInput.author, default by kind
  ingest/stages/extract.ts            MODIFY (T3): extractionHeader (Author:, Origin:), extractionSystem(reg, author)
  ingest/stages/resolve.ts            MODIFY: author gate + ResolveReport (T4); undoResolution, runResolve undoes first (T5);
                                      extractor supersession (T7); placeShortAlias (T8)
  ingest/stages/chunk.ts              MODIFY (T5): undo resolution before replacing chunks
  ingest/set-author.ts                NEW (T6): setAuthor, suppressedDocuments
  graph/supersede.ts                  NEW (T7): linkSupersession, supersedeByExtraction
  graph/facts.ts                      MODIFY (T7): supersedeFact uses linkSupersession and logs fact_events
  retrieve/documents.ts               MODIFY (T2): DocumentSlice.author
  retrieve/search.ts                  MODIFY (T2): Passage.author
  mcp/server.ts                       MODIFY: brain_ingest author + instructions (T2); brain_status suppressed (T6)
  mcp/render.ts                       MODIFY: author on passages and documents (T2); suppressed in status (T6)
  obsidian/load.ts                    MODIFY (T2): GDocument.author
  obsidian/project.ts                 MODIFY (T2): DocView.author
  obsidian/render.ts                  MODIFY (T2): brain_author front matter and Author line
  cli.ts                              MODIFY: ingest --author (T2); status suppressed, set-author (T6); eval attribution (T9)
  eval/run.ts                         MODIFY (T9): splitFrontMatter, ingestCorpus passes author, attributionLeaks, attributionGate
eval/
  corpus/note--databricks-cost-governance.md   NEW (T9, author: other)
  corpus/email--recruiter-intro.md             NEW (T9, author: other, names Frank Fu)
  corpus/note--moved-to-denver.md              NEW (T9, owner)
  golden.jsonl                        MODIFY (T9): a01–a03 attribution, q15 semantic, n01 negative
  baseline.json                       MODIFY (T9): accepted after review
README.md                             MODIFY (T6, T7)
test/
  unit/author.test.ts                 NEW (T1)
  integration/author.test.ts          NEW (T1)
  unit/render.test.ts                 MODIFY (T2, T6)
  unit/obsidian-render.test.ts        MODIFY (T2)
  unit/eval.test.ts                   MODIFY (T2: Passage literal gains author)
  integration/mcp-server.test.ts      MODIFY (T2, T6)
  integration/search.test.ts          MODIFY (T2 new test; T4 seed document is owner-written)
  integration/obsidian-load.test.ts   MODIFY (T2)
  unit/extract-prompt.test.ts         NEW (T3)
  integration/stages-extract.test.ts  MODIFY (T3)
  integration/backfill.test.ts        MODIFY (T3)
  integration/stages-resolve.test.ts  MODIFY (T4 gate, T8 place aliases)
  integration/undo-resolution.test.ts NEW (T5)
  integration/set-author.test.ts      NEW (T6)
  integration/supersession.test.ts    NEW (T7)
  integration/facts.test.ts           MODIFY (T7)
  unit/eval-attribution.test.ts       NEW (T9)
  unit/golden-fixtures.test.ts        NEW (T9)
  integration/eval-attribution.test.ts NEW (T9)
```

---

### Task 1: `documents.author`, its defaults, and `fact_events`

**Files:**
- Create: `supabase/migrations/20261001000009_author.sql`
- Create: `src/ingest/author.ts`
- Modify: `src/config.ts`
- Modify: `src/ingest/store.ts`
- Create: `test/unit/author.test.ts`
- Create: `test/integration/author.test.ts`

- [ ] **Step 1: Write the failing unit test**

`test/unit/author.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { AUTHORS, isAuthor, parseAuthor, defaultAuthor } from "../../src/ingest/author.js";

describe("author values", () => {
  it("are owner, other and unknown", () => {
    expect(AUTHORS).toEqual(["owner", "other", "unknown"]);
    expect(isAuthor("other")).toBe(true);
    expect(isAuthor("me")).toBe(false);
    expect(isAuthor(undefined)).toBe(false);
  });
  it("parse user input case-insensitively and reject anything else", () => {
    expect(parseAuthor(" Other ")).toBe("other");
    expect(() => parseAuthor("me")).toThrow('author must be one of owner, other, unknown; got "me"');
  });
});

describe("defaultAuthor", () => {
  it("maps source kinds through config.authorDefaults and everything else to unknown", () => {
    expect(defaultAuthor("note")).toBe("owner");
    expect(defaultAuthor("paste")).toBe("owner");
    expect(defaultAuthor("email")).toBe("other");
    expect(defaultAuthor("podcast")).toBe("unknown");
    expect(defaultAuthor("constructor")).toBe("unknown"); // not fooled by Object.prototype
  });
});
```

- [ ] **Step 2: Write the failing integration test**

`test/integration/author.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe } from "./helpers.js";
import { storeDocument } from "../../src/ingest/store.js";
import { defaultAuthor } from "../../src/ingest/author.js";
import { config } from "../../src/config.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const authorOf = async (id: string) => (await sql<{ author: string }[]>`select author from brain.documents where id = ${id}`)[0].author;

describe("documents.author", () => {
  it("defaults by source kind when the input names no author", async () => {
    const cases: [string, string][] = [
      ["resume", "owner"], ["note", "owner"], ["conversation", "owner"], ["paste", "owner"],
      ["news", "other"], ["paper", "other"], ["job_description", "other"], ["email", "other"],
      ["podcast", "unknown"],
    ];
    for (const [kind, expected] of cases) {
      const { id } = await storeDocument(sql, { text: `A ${kind} document.`, sourceKind: kind });
      expect([kind, await authorOf(id)]).toEqual([kind, expected]);
    }
  });

  it("treats a document stored without a kind as a paste written by the owner", async () => {
    const { id } = await storeDocument(sql, { text: "Pasted without a kind." });
    expect(await authorOf(id)).toBe("owner");
  });

  it("stores an explicit author instead of the default", async () => {
    const { id } = await storeDocument(sql, { text: "Someone else's post saved as a note.", sourceKind: "note", author: "other" });
    expect(await authorOf(id)).toBe("other");
  });

  it("keeps the author of an existing document when the same text is stored again", async () => {
    const a = await storeDocument(sql, { text: "same text", sourceKind: "note", author: "other" });
    const b = await storeDocument(sql, { text: "same text", sourceKind: "note" });
    expect(b.id).toBe(a.id);
    expect(await authorOf(a.id)).toBe("other");
  });

  it("refuses an author outside owner, other and unknown", async () => {
    await expect(storeDocument(sql, { text: "x", author: "someone" as never })).rejects.toThrow(/author must be one of owner, other, unknown/);
    await expect(sql`insert into brain.documents (content_hash, raw_content, author) values ('bad-author', 'x', 'someone')`).rejects.toThrow(/documents_author_check/);
  });

  it("has a SQL default_author that agrees with config.authorDefaults (the migration backfill uses it)", async () => {
    for (const kind of [...Object.keys(config.authorDefaults), "podcast", "", "Note"]) {
      const [row] = await sql<{ a: string }[]>`select brain.default_author(${kind}) as a`;
      expect([kind, row.a]).toEqual([kind, defaultAuthor(kind)]);
    }
  });

  it("backfills a row that predates the column by its source kind", async () => {
    // A row inserted without an author gets the column default, as every existing row did when 009 added the column.
    const [doc] = await sql<{ id: string }[]>`
      insert into brain.documents (content_hash, source_kind, raw_content) values ('pre-009', 'note', 'An old note.') returning id`;
    expect(await authorOf(doc.id)).toBe("unknown");
    await sql`update brain.documents set author = brain.default_author(source_kind) where id = ${doc.id}`;
    expect(await authorOf(doc.id)).toBe("owner");
  });
});

describe("fact_events", () => {
  it("exists with the columns supersession and undo write", async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'brain' and table_name = 'fact_events' order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual(["id", "fact_id", "event", "by", "document_id", "detail", "created_at"]);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run test/unit/author.test.ts`
Expected: FAIL: `Failed to load url ../../src/ingest/author.js` (module does not exist).

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/author.test.ts`
Expected: FAIL for the same missing module.

- [ ] **Step 4: Write the migration**

`supabase/migrations/20261001000009_author.sql`:
```sql
-- Phase 2: authorship and facts about the owner (spec §4).
-- Every statement is idempotent: later Phase 2 tasks insert blocks into this file (before the final commit)
-- and it is applied to brain_eval more than once. The documents backfill runs only when the author column is
-- first added, so re-applying the file never undoes a later `brain set-author`.

begin;

-- Default author by source kind.
-- KEEP IN SYNC with config.authorDefaults in src/config.ts; test/integration/author.test.ts fails when they differ.
create or replace function brain.default_author(kind text) returns text
language sql immutable parallel safe as $$
  select case kind
    when 'resume' then 'owner'
    when 'note' then 'owner'
    when 'conversation' then 'owner'
    when 'paste' then 'owner'
    when 'news' then 'other'
    when 'paper' then 'other'
    when 'job_description' then 'other'
    when 'email' then 'other'
    else 'unknown'
  end;
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'brain' and table_name = 'documents' and column_name = 'author'
  ) then
    alter table brain.documents
      add column author text not null default 'unknown'
      constraint documents_author_check check (author in ('owner', 'other', 'unknown'));
    update brain.documents set author = brain.default_author(source_kind);
  end if;
end $$;

-- Every supersession, restoration and removal of a fact. No foreign key on fact_id: the log outlives facts
-- that undoResolution deletes. detail carries what undo needs to restore a fact exactly
-- ({"superseded_by": id, "previous_valid_to": date|null} on 'superseded').
create table if not exists brain.fact_events (
  id bigint generated always as identity primary key,
  fact_id uuid not null,
  event text not null check (event in ('superseded', 'restored', 'removed')),
  by text not null,
  document_id uuid references brain.documents(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists fact_events_fact_idx on brain.fact_events (fact_id, created_at);
alter table brain.fact_events enable row level security;

-- undoResolution finds what a document produced by chunk.
create index if not exists facts_source_chunk_idx on brain.facts (source_chunk_id);
create index if not exists edges_evidence_chunk_idx on brain.edges (evidence_chunk_id);

commit;
```

- [ ] **Step 5: Add the defaults to config**

In `src/config.ts`, add after the `graph:` line (inside the object, before `} as const;`):
```ts
  /**
   * Author of a document saved without one, by source kind; any other kind is "unknown".
   * KEEP IN SYNC with brain.default_author in supabase/migrations/20261001000009_author.sql.
   */
  authorDefaults: {
    resume: "owner",
    note: "owner",
    conversation: "owner",
    paste: "owner",
    news: "other",
    paper: "other",
    job_description: "other",
    email: "other",
  },
```

- [ ] **Step 6: Write `src/ingest/author.ts`**

```ts
import { config } from "../config.js";

/**
 * Who wrote a document. Only a document the owner wrote can produce facts about the owner or relations
 * from the owner (src/ingest/stages/resolve.ts).
 */
export const AUTHORS = ["owner", "other", "unknown"] as const;
export type Author = (typeof AUTHORS)[number];

export function isAuthor(value: unknown): value is Author {
  return typeof value === "string" && (AUTHORS as readonly string[]).includes(value);
}

/** Parses user input (a CLI argument, fixture front matter). Case and surrounding space are ignored. */
export function parseAuthor(value: string): Author {
  const v = value.trim().toLowerCase();
  if (!isAuthor(v)) throw new Error(`author must be one of ${AUTHORS.join(", ")}; got "${value}"`);
  return v;
}

/**
 * The author a document gets when none is given: config.authorDefaults by source kind, "unknown" for any
 * kind not listed. brain.default_author (migration 009) is the same mapping in SQL.
 */
export function defaultAuthor(sourceKind: string): Author {
  const map: Readonly<Record<string, Author>> = config.authorDefaults;
  return Object.hasOwn(map, sourceKind) ? map[sourceKind] : "unknown";
}
```

- [ ] **Step 7: Store the author**

Replace `src/ingest/store.ts` with:
```ts
import type postgres from "postgres";
import type { Db } from "../db.js";
import { sha256Hex } from "../text/hash.js";
import { AUTHORS, defaultAuthor, isAuthor, type Author } from "./author.js";

export interface StoreInput {
  text: string;
  title?: string | null;
  sourceKind?: string;
  /**
   * Who wrote the text. When absent, config.authorDefaults by source kind. Ignored when the same text is
   * already stored (storing is idempotent on content); `brain set-author` changes it.
   */
  author?: Author;
  origin?: string | null;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date | null;
}

/** Stage 1. Idempotent on content: the same bytes always map to the same document id. */
export async function storeDocument(sql: Db, input: StoreInput): Promise<{ id: string; created: boolean }> {
  if (!input.text.trim()) throw new Error("Refusing to store an empty document");
  if (input.author !== undefined && !isAuthor(input.author)) {
    throw new Error(`author must be one of ${AUTHORS.join(", ")}; got "${String(input.author)}"`);
  }
  const hash = sha256Hex(input.text);
  const sourceKind = input.sourceKind ?? "paste";
  const author: Author = input.author ?? defaultAuthor(sourceKind);

  const healJob = (id: string) => sql`insert into brain.ingest_jobs (document_id, stage) values (${id}, 'stored') on conflict do nothing`;

  const [existing] = await sql<{ id: string }[]>`select id from brain.documents where content_hash = ${hash}`;
  if (existing) {
    // A document without a job (e.g. stored before stores were atomic) would strand runPipeline; heal it.
    await healJob(existing.id);
    return { id: existing.id, created: false };
  }

  // Document and job are written together so a crash can never leave one without the other.
  const row = await sql.begin(async (tx) => {
    const [inserted] = await tx<{ id: string }[]>`
      insert into brain.documents (content_hash, source_kind, author, title, origin, raw_content, mime_type, metadata, occurred_at)
      values (${hash}, ${sourceKind}, ${author}, ${input.title ?? null}, ${input.origin ?? null},
              ${input.text}, ${input.mimeType ?? "text/plain"}, ${sql.json((input.metadata ?? {}) as postgres.JSONValue)}, ${input.occurredAt ?? null})
      on conflict (content_hash) do nothing
      returning id`;
    if (inserted) await tx`insert into brain.ingest_jobs (document_id, stage) values (${inserted.id}, 'stored') on conflict do nothing`;
    return inserted as { id: string } | undefined;
  });
  if (!row) {
    const [raced] = await sql<{ id: string }[]>`select id from brain.documents where content_hash = ${hash}`;
    await healJob(raced.id);
    return { id: raced.id, created: false };
  }
  return { id: row.id, created: true };
}
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/unit/author.test.ts`
Expected: PASS (3 tests).

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/author.test.ts test/integration/store.test.ts`
Expected: PASS. `store.test.ts` is unchanged and still passes: its documents have kinds `note`, `paste` and `news`, and it never reads the author.

- [ ] **Step 9: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green.

- [ ] **Step 10: Apply to the eval database**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20261001000009_author.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "select source_kind, author, count(*) from brain.documents group by 1, 2 order by 1"
```
Expected: `BEGIN`, `CREATE FUNCTION`, `DO`, `CREATE TABLE`, three `CREATE INDEX`, `ALTER TABLE`, `COMMIT`; then `conversation | owner`, `email | other`, `job_description | other`, `news | other`, `note | owner`, `paper | other`.

No eval run: nothing reads the column yet.

- [ ] **Step 11: Commit**

```bash
git add supabase/migrations/20261001000009_author.sql src/config.ts src/ingest/author.ts src/ingest/store.ts test/unit/author.test.ts test/integration/author.test.ts
git commit -m "documents.author with defaults by source kind; fact_events log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Author on the inputs and in every view

**Files:**
- Modify: `src/cli.ts` (`ingest --author`)
- Modify: `src/mcp/server.ts` (`brain_ingest` `author`, description, server instructions)
- Modify: `src/mcp/render.ts` (`renderSearch` passage line, `renderDocument`)
- Modify: `src/retrieve/documents.ts`
- Modify: `src/retrieve/search.ts` (`Passage.author`)
- Modify: `src/obsidian/load.ts`, `src/obsidian/project.ts`, `src/obsidian/render.ts`
- Modify: `test/unit/render.test.ts`, `test/unit/obsidian-render.test.ts`, `test/unit/eval.test.ts`
- Modify: `test/integration/mcp-server.test.ts`, `test/integration/search.test.ts`, `test/integration/obsidian-load.test.ts`

- [ ] **Step 1: Write the failing unit tests**

In `test/unit/render.test.ts`, replace the two passage literals in the first `renderSearch` test with:
```ts
        { chunkId: "c1", documentId: "d1", documentTitle: "Doc", sourceKind: "news", author: "other", content: "Body text", parentContent: null, headingPath: ["H"], charStart: 0, charEnd: 9, score: 0.8, group: "hybrid" },
        { chunkId: null, documentId: "d2", documentTitle: null, sourceKind: "note", author: "owner", content: "raw hit", parentContent: null, headingPath: [], charStart: 0, charEnd: 7, score: 0, group: "fallback" },
```
and replace its first two expectations with:
```ts
    expect(text).toContain("[P1] hybrid · news · author: other · Doc (document d1, chunk c1)");
    expect(text).toContain("[P2] fallback · note · author: owner (document d2)");
```
Replace the test `renderDocument shows the slice window` with:
```ts
  it("renderDocument shows the author and the slice window", () => {
    const t = renderDocument({ id: "d1", title: "T", sourceKind: "news", author: "other", origin: null, occurredAt: null, ingestedAt: new Date(0), summary: null, totalLength: 100, offset: 10, text: "abc" });
    expect(t).toContain("origin: n/a · author: other · about: unknown");
    expect(t).toContain("characters 10–13 of 100");
    expect(t).toContain("abc");
  });
```

In `test/unit/obsidian-render.test.ts`, inside `describe("renderDocument", ...)`, replace the `doc` constant with:
```ts
  const doc: DocView = {
    id: "3f2a0000-0000-0000-0000-000000000000", noteName: "Acme raises Series B", title: "Acme raises Series B", kind: "news", author: "other", origin: "https://x.test/a",
    occurredAt: new Date("2026-03-12T00:00:00Z"), ingestedAt: new Date("2026-09-27T00:00:00Z"), summary: "Acme raised $40M.", entityNoteNames: ["Acme Corp", "Beta Ventures"], raw: "Full text here.",
  };
```
and add, after `expect(t).toContain('brain_kind: "news"');` in the first test:
```ts
    expect(t).toContain('brain_author: "other"');
    expect(t).toContain("**Author.** someone else, not the owner");
```

In `test/unit/eval.test.ts`, replace the `passages:` line inside `searchResult` with:
```ts
    passages: passages.map((p, i) => ({ chunkId: p.chunkId === undefined ? `c${i}` : p.chunkId, documentId: p.documentId, documentTitle: null, sourceKind: "note", author: "owner", content: p.content, parentContent: null, headingPath: [], charStart: 0, charEnd: 0, score: p.score, group: p.group })),
```

- [ ] **Step 2: Write the failing integration tests**

Add to `test/integration/mcp-server.test.ts` inside `describe("brain MCP server", ...)`:
```ts
  it("tells clients to pass author other for text the owner did not write", async () => {
    const s = await connect();
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain('author: "other"');
    const tools = (await s.client.listTools()).tools;
    const ingestTool = tools.find((t) => t.name === "brain_ingest")!;
    expect(ingestTool.description).toContain('author: "other"');
    await s.close();
    const ro = await connect(true);
    expect(ro.client.getInstructions() ?? "").not.toContain("brain_ingest");
    await ro.close();
  });

  it("records who wrote a saved document and shows it when reading it", async () => {
    const s = await connect();
    const other = await s.call("brain_ingest", { text: "I think Databricks costs too much.", source_kind: "note", author: "other" });
    const mine = await s.call("brain_ingest", { text: "I moved to Denver last week.", source_kind: "note" });
    await s.jobs.drain();
    const otherId = /document ([0-9a-f-]{36})/.exec(other.text)![1];
    const mineId = /document ([0-9a-f-]{36})/.exec(mine.text)![1];
    expect((await s.call("brain_get_document", { document_id: otherId })).text).toContain("author: other");
    expect((await s.call("brain_get_document", { document_id: mineId })).text).toContain("author: owner");
    const bad = await s.call("brain_ingest", { text: "x", author: "someone" });
    expect(bad.isError).toBe(true);
    await s.close();
  });
```

Add to `test/integration/search.test.ts` inside `describe("search", ...)`:
```ts
  it("reports each passage's document author", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "Lonestar Capital closed a new fund for robotics startups.", sourceKind: "news", title: "Fund news" });
    await ingest(ctx, { text: "My tomatoes finally ripened this week.", sourceKind: "note", title: "Tomatoes" });
    const news = (await search(ctx, "Lonestar Capital robotics fund", { includeFacts: false })).passages.find((p) => p.documentTitle === "Fund news")!;
    expect(news.author).toBe("other");
    const note = (await search(ctx, "tomatoes ripened", { includeFacts: false })).passages.find((p) => p.documentTitle === "Tomatoes")!;
    expect(note.author).toBe("owner");
  });
```

In `test/integration/obsidian-load.test.ts`, replace
```ts
    expect(g.documents[0]).toEqual(expect.objectContaining({ id, title: "Acme note", sourceKind: "note" }));
```
with
```ts
    expect(g.documents[0]).toEqual(expect.objectContaining({ id, title: "Acme note", sourceKind: "note", author: "owner" }));
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/render.test.ts test/unit/obsidian-render.test.ts`
Expected: FAIL: the passage line has no `author: other`; the document slice line has no `author:`; the note has no `brain_author`.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/mcp-server.test.ts test/integration/search.test.ts test/integration/obsidian-load.test.ts`
Expected: FAIL: the instructions lack `author: "other"`; `brain_ingest` with `author: "someone"` is accepted (unknown keys are stripped) and `brain_get_document` shows no author; `passage.author` is undefined; `g.documents[0].author` is undefined.

- [ ] **Step 4: Carry the author through search**

In `src/retrieve/search.ts`:

Replace the `Passage` interface with:
```ts
export interface Passage {
  chunkId: string | null;
  documentId: string;
  documentTitle: string | null;
  sourceKind: string;
  /** Who wrote the passage's document: owner, other or unknown. */
  author: string;
  content: string;
  parentContent: string | null;
  headingPath: string[];
  charStart: number;
  charEnd: number;
  score: number;
  group: PassageGroup;
}
```
Replace the `ChunkRow` interface and `loadChunks` with:
```ts
interface ChunkRow {
  id: string;
  document_id: string;
  content: string;
  heading_path: string[];
  context_prefix: string;
  char_start: number;
  char_end: number;
  parent_content: string | null;
  document_title: string | null;
  source_kind: string;
  author: string;
}

async function loadChunks(sql: Db, ids: string[]): Promise<Map<string, ChunkRow>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<ChunkRow[]>`
    select c.id, c.document_id, c.content, c.heading_path, c.context_prefix, c.char_start, c.char_end,
           p.content as parent_content, d.title as document_title, d.source_kind, d.author
    from brain.chunks c
    left join brain.chunks p on p.id = c.parent_id
    join brain.documents d on d.id = c.document_id
    where c.id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}
```
In `toPassage`, add `author: row.author,` after `sourceKind: row.source_kind,`.

In the fallback block, replace
```ts
    const hits = await sql<{ id: string; title: string | null; source_kind: string; raw_content: string; matched: string[]; n: number }[]>`
      select d.id, d.title, d.source_kind, d.raw_content,
```
with
```ts
    const hits = await sql<{ id: string; title: string | null; source_kind: string; author: string; raw_content: string; matched: string[]; n: number }[]>`
      select d.id, d.title, d.source_kind, d.author, d.raw_content,
```
and in the `passages.push({ ... })` of that block add `author: h.author,` after `sourceKind: h.source_kind,`.

- [ ] **Step 5: Carry the author through `getDocument`**

Replace `src/retrieve/documents.ts` with:
```ts
import type { Db } from "../db.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DocumentSlice {
  id: string;
  title: string | null;
  sourceKind: string;
  /** owner, other or unknown. */
  author: string;
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
    id: string; title: string | null; source_kind: string; author: string; origin: string | null; occurred_at: Date | null;
    ingested_at: Date; summary: string | null; total_length: number; text: string;
  }[]>`
    select id, title, source_kind, author, origin, occurred_at, ingested_at, summary,
           length(raw_content) as total_length, substr(raw_content, ${safeOffset + 1}, ${safeLength}) as text
    from brain.documents where id = ${id}`;
  if (!row) return null;
  return {
    id: row.id, title: row.title, sourceKind: row.source_kind, author: row.author, origin: row.origin, occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at, summary: row.summary, totalLength: Number(row.total_length), offset: safeOffset, text: row.text,
  };
}
```

- [ ] **Step 6: Render the author in MCP output**

In `src/mcp/render.ts`, in `renderSearch`, replace
```ts
    out.push(`[P${i + 1}] ${p.group} · ${p.sourceKind}${title} ${where}${p.headingPath.length ? `\n  ${p.headingPath.join(" > ")}` : ""}\n${p.content.trim()}\n`);
```
with
```ts
    out.push(`[P${i + 1}] ${p.group} · ${p.sourceKind} · author: ${p.author}${title} ${where}${p.headingPath.length ? `\n  ${p.headingPath.join(" > ")}` : ""}\n${p.content.trim()}\n`);
```
In `renderDocument`, replace
```ts
    `origin: ${d.origin ?? "n/a"} · about: ${day(d.occurredAt) ?? "unknown"} · ingested: ${day(d.ingestedAt)}`,
```
with
```ts
    `origin: ${d.origin ?? "n/a"} · author: ${d.author} · about: ${day(d.occurredAt) ?? "unknown"} · ingested: ${day(d.ingestedAt)}`,
```

- [ ] **Step 7: Accept the author in `brain_ingest` and tell the client when to pass it**

In `src/mcp/server.ts`, add `import { AUTHORS } from "../ingest/author.js";` after the `storeDocument` import, and replace the `if (!readOnly) lines.push(...)` line in `instructions` with:
```ts
  if (!readOnly) {
    lines.push(
      "To save something, call brain_ingest. Pass author: \"other\" when saving anything the owner did not write (articles, posts, screenshots of other people's posts, emails from others): notes, pastes and conversations default to author owner, and first-person statements in an owner document are recorded as facts about the owner.",
      "Record a fact only when the owner states it about themselves, with brain_add_fact.",
    );
  }
```
Replace the whole `brain_ingest` registration (from `register(\n    "brain_ingest",` through its closing `);`) with:
```ts
  register(
    "brain_ingest",
    {
      title: "Save to the knowledge base",
      description:
        "Store any text: a note, a pasted article, a conversation, a job description. Set author to who wrote the text: \"owner\" for the owner's own writing, \"other\" for anything someone else wrote (articles, posts, screenshots of other people's posts, emails from others), \"unknown\" if unsure. Pass author: \"other\" for someone else's writing even when you save it as a note: when author is omitted it defaults by source_kind, and note, paste and conversation default to owner, which would record the writer's first-person statements as facts about the owner. Returns immediately after storing and chunking; summary, embeddings and entity extraction continue in the background.",
      inputSchema: {
        text: z.string().min(1),
        title: z.string().optional(),
        source_kind: z.string().optional().describe("Free label: note, conversation, news, job_description, email, paper, paste"),
        author: z.enum(AUTHORS).optional().describe("owner (the owner wrote it), other (someone else did), or unknown. Default by source_kind: note, paste, conversation, resume → owner; news, paper, job_description, email → other; anything else → unknown."),
        origin: z.string().optional().describe("URL, file path or other provenance"),
        occurred_at: isoDate.optional().describe("ISO date the content is about, e.g. 2026-09-01"),
        metadata: z.record(z.string(), z.string()).optional(),
      },
    },
    async (a) => {
      try {
        const { id, created } = await storeDocument(ctx.sql, {
          text: a.text, title: a.title ?? null, sourceKind: a.source_kind ?? "paste", author: a.author, origin: a.origin ?? `mcp:${opts.client}`,
          metadata: { ...(a.metadata ?? {}), saved_by: opts.client }, occurredAt: dateOrUndefined(a.occurred_at) ?? null,
        });
        const first = await runPipeline(ctx, id, { until: "chunked" });
        const saved = created ? "Saved" : "Already present";
        if (first.skipped) {
          return text(`${saved}: document ${id} (stage ${first.stage}). Processing is already under way in another runner; brain_status shows progress.`);
        }
        if (first.error) return fail(new Error(`Stored as document ${id} but chunking failed: ${first.error}`));
        jobs.start(id);
        let resumed: string[] = [];
        try {
          resumed = await jobs.resumeStalled();
        } catch (e) {
          // The document is stored and queued; failing to resume others must not turn this into an error.
          log(`brain: resuming stalled jobs failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return text(`${saved}: document ${id} (stage ${first.stage}). Summary, embeddings and extraction continue in the background; brain_status shows progress.${resumed.length ? ` Also resumed ${resumed.length} stalled job(s).` : ""}`);
      } catch (e) { return fail(e); }
    },
  );
```
The read-only server never sees the ingest line, so `instructions(true)` keeps the four routing steps only (the new test checks this).

- [ ] **Step 8: `brain ingest --author`**

In `src/cli.ts`, add `import { parseAuthor } from "./ingest/author.js";` after the `ingestAll` import, and replace the whole `program.command("ingest <input>")` block with:
```ts
program
  .command("ingest <input>")
  .description("Ingest a file, directory, URL, or - for stdin")
  .option("--kind <kind>", "source kind label (note, conversation, news, job_description, ...)", "paste")
  .option("--author <author>", "who wrote it: owner, other or unknown (default by kind: note, paste, conversation, resume → owner; news, paper, job_description, email → other; else unknown)")
  .option("--title <title>", "override the detected title")
  .option("--occurred-at <date>", "date the content is about (ISO 8601)")
  .option("--meta <k=v...>", "extra metadata pairs")
  .option("--until <stage>", `stop after this stage (${STAGES.join(", ")})`)
  .action(async (input: string, opts) => {
    if (opts.until && !STAGES.includes(opts.until)) throw new Error(`Unknown stage ${opts.until}`);
    const author = opts.author === undefined ? undefined : parseAuthor(opts.author);
    await withCtx(async (ctx) => {
      const meta = parseMeta(opts.meta);
      const { failed } = await ingestAll(
        ctx,
        await readInput(input),
        {
          until: opts.until as Stage | undefined,
          toInput: (r) => ({
            text: r.text,
            title: opts.title ?? r.title,
            sourceKind: opts.kind,
            author,
            origin: r.origin,
            mimeType: r.mimeType,
            metadata: { ...r.metadata, ...meta },
            occurredAt: opts.occurredAt ? new Date(opts.occurredAt) : null,
          }),
        },
        {
          done: (r, res) => console.log(`${res.created ? "new " : "dup "} ${res.id} ${res.stage.padEnd(10)} ${res.error ? "ERROR " + res.error + " " : ""}${r.origin}`),
          skip: logSkip,
        },
      );
      if (failed.length) process.exitCode = 1;
    });
  });
```

- [ ] **Step 9: Author in the Obsidian document note**

In `src/obsidian/load.ts`, replace the `GDocument` interface with:
```ts
export interface GDocument {
  id: string;
  title: string | null;
  sourceKind: string;
  author: string;
  origin: string | null;
  occurredAt: Date | null;
  ingestedAt: Date;
  summary: string | null;
  raw: string;
}
```
and replace the documents query with:
```ts
    sql<GDocument[]>`
      select id, title, source_kind as "sourceKind", author, origin, occurred_at as "occurredAt", ingested_at as "ingestedAt", summary, raw_content as raw
      from brain.documents order by ingested_at`,
```

In `src/obsidian/project.ts`, replace the `const view: DocView = ...` line with:
```ts
    const view: DocView = { id: d.id, noteName: docNames.get(d.id)!, title: d.title, kind: d.sourceKind, author: d.author, origin: d.origin, occurredAt: d.occurredAt, ingestedAt: d.ingestedAt, summary: d.summary, entityNoteNames, raw: d.raw };
```

In `src/obsidian/render.ts`, replace the `DocView` interface and `renderDocument` with:
```ts
export interface DocView {
  id: string;
  noteName: string;
  title: string | null;
  kind: string;
  /** owner, other or unknown. */
  author: string;
  origin: string | null;
  occurredAt: Date | null;
  ingestedAt: Date;
  summary: string | null;
  entityNoteNames: string[];
  raw: string;
}

const AUTHOR_LABELS: Record<string, string> = { owner: "the owner", other: "someone else, not the owner", unknown: "unknown" };

export function renderDocument(d: DocView, maxChars = 200_000): string {
  const body = d.raw.length > maxChars
    ? d.raw.slice(0, maxChars) + `\n\n> (truncated at ${maxChars} characters; the full ${d.raw.length}-character text is in the knowledge base as document ${d.id})\n`
    : d.raw;
  return [
    frontmatter({ brain_id: d.id, brain_kind: d.kind, brain_author: d.author, brain_managed: true, origin: d.origin ?? undefined, occurred_at: d.occurredAt ?? undefined, ingested_at: d.ingestedAt, tags: [`brain/document/${d.kind}`] }),
    `# ${d.title ?? "(untitled)"}`,
    "",
    NOTICE,
    `**Author.** ${AUTHOR_LABELS[d.author] ?? d.author}\n`,
    d.summary ? `**Summary.** ${d.summary}\n` : "",
    d.entityNoteNames.length ? `**Entities.** ${d.entityNoteNames.map(link).join(" · ")}\n` : "",
    "---",
    "",
    body,
  ].filter((s) => s !== "").join("\n") + "\n";
}
```
Every document note is rewritten once on the next projection (new front matter line); that is expected.

- [ ] **Step 10: Run the tests**

Run: `npx vitest run test/unit/render.test.ts test/unit/obsidian-render.test.ts test/unit/eval.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/mcp-server.test.ts test/integration/search.test.ts test/integration/obsidian-load.test.ts test/integration/obsidian-project.test.ts`
Expected: PASS. The existing tool-call logging test still sees `{ source_kind: "note", text_chars: 15 }` because it passes no author.

- [ ] **Step 11: Full suites, typecheck, eval**

Run: `npm run typecheck && npm run test:unit && npm run test:int && npm run eval:run`
Expected: all green; eval deltas 0 (retrieval is unchanged; the search now also selects `d.author`, which needs migration 009 on `brain_eval`, applied in Task 1). No `GATE:` lines.

- [ ] **Step 12: Commit**

```bash
git add src/cli.ts src/mcp/server.ts src/mcp/render.ts src/retrieve/documents.ts src/retrieve/search.ts src/obsidian/load.ts src/obsidian/project.ts src/obsidian/render.ts test/unit/render.test.ts test/unit/obsidian-render.test.ts test/unit/eval.test.ts test/integration/mcp-server.test.ts test/integration/search.test.ts test/integration/obsidian-load.test.ts
git commit -m "Author on ingest (CLI --author, brain_ingest author) and in search passages, documents and Obsidian notes

The server instructions and brain_ingest description tell the client to pass author: \"other\"
for anything the owner did not write, since notes and pastes default to owner.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The extractor is told who wrote the document

**Files:**
- Modify: `src/ingest/stages/extract.ts` (`extractionHeader`, `extractionSystem`, `buildExtractionRequests`)
- Create: `test/unit/extract-prompt.test.ts`
- Modify: `test/integration/stages-extract.test.ts`
- Modify: `test/integration/backfill.test.ts`

`buildExtractionRequests` is shared by the online path (`runExtract`) and the Batches backfill (`backfill.ts` step 4), so one change covers both; the backfill test proves it.

- [ ] **Step 1: Write the failing unit test**

`test/unit/extract-prompt.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extractionSystem, extractionHeader, type Registries } from "../../src/ingest/stages/extract.js";

const reg: Registries = {
  nodeTypes: [{ name: "person", description: "A human being" }],
  edgeTypes: [{ name: "knows", description: "from person to person" }],
  selfName: "Frank Fu",
};

describe("extractionSystem", () => {
  it("owner: first-person pronouns are the owner (the rule as it was)", () => {
    const s = extractionSystem(reg, "owner");
    expect(s).toContain('The owner, Frank Fu, may appear as "I", "me", "my" or by name.');
    expect(s).toContain("facts_about_self: durable statements about the owner");
    expect(s).not.toContain("not the owner");
  });

  it("other: first-person pronouns are the author, who is not the owner; facts about the owner only when named", () => {
    const s = extractionSystem(reg, "other");
    expect(s).toContain("This document was written by someone other than the owner, Frank Fu.");
    expect(s).toContain('First-person pronouns ("I", "me", "my", "we", "our") refer to the document\'s author, who is not the owner.');
    expect(s).toContain("facts_about_self must be empty unless the text names the owner, Frank Fu, and states something about them");
    expect(s).toContain("Relations from the owner are allowed only when the text names the owner");
    expect(s).not.toContain('may appear as "I", "me", "my"');
  });

  it("unknown: treated as someone other than the owner", () => {
    const s = extractionSystem(reg, "unknown");
    expect(s).toContain("Who wrote this document is unknown; treat its author as someone other than the owner, Frank Fu.");
    expect(s).toContain("facts_about_self must be empty unless the text names the owner");
  });

  it("defaults to the owner rule", () => {
    expect(extractionSystem(reg)).toBe(extractionSystem(reg, "owner"));
  });
});

describe("extractionHeader", () => {
  it("lists title, kind, author, origin and summary line", () => {
    expect(extractionHeader({ title: "Post", source_kind: "note", author: "other", origin: "https://example.test/p", summary_line: "A post." })).toBe(
      "Document title: Post\nSource kind: note\nAuthor: other\nOrigin: https://example.test/p\nDocument summary: A post.",
    );
    expect(extractionHeader({ title: null, source_kind: "paste", author: "owner", origin: null, summary_line: null })).toBe(
      "Document title: (none)\nSource kind: paste\nAuthor: owner\nOrigin: (none)\nDocument summary: (none)",
    );
  });
});
```

- [ ] **Step 2: Write the failing integration tests**

Add to `test/integration/stages-extract.test.ts` inside `describe("runExtract", ...)`:
```ts
  it("tells the extractor who wrote the document and where it came from", async () => {
    const ctx = fakeCtx(sql, () => fakeExtraction);
    const { id } = await storeDocument(sql, { text, title: "Post", sourceKind: "note", author: "other", origin: "https://example.test/post" });
    await runChunk(ctx, id);
    await runExtract(ctx, id);
    expect(ctx.llm.calls[0].user).toContain("Author: other");
    expect(ctx.llm.calls[0].user).toContain("Origin: https://example.test/post");
    expect(ctx.llm.calls[0].system).toContain("who is not the owner");
  });

  it("keeps the owner pronoun rule for a document the owner wrote", async () => {
    const ctx = fakeCtx(sql, () => fakeExtraction);
    const { id } = await storeDocument(sql, { text, sourceKind: "note" });
    await runChunk(ctx, id);
    await runExtract(ctx, id);
    expect(ctx.llm.calls[0].user).toContain("Author: owner");
    expect(ctx.llm.calls[0].user).toContain("Origin: (none)");
    expect(ctx.llm.calls[0].system).toContain('may appear as "I", "me", "my" or by name');
  });
```

Add to `test/integration/backfill.test.ts` inside `describe("backfill", ...)`:
```ts
  it("builds batch extraction requests with the same author header and rule as the online path", async () => {
    const ctx = fakeCtx(sql);
    await storeDocument(sql, { text: "I cut our Databricks bill in half. Cost governance matters.", sourceKind: "note", author: "other", origin: "https://example.test/post" });
    const { client, submitted } = fakeClient(good);
    await backfill(ctx, { client, pollMs: 1 });
    const extraction = submitted.find((r) => r.params.system !== SUMMARY_SYSTEM)!;
    expect(extraction.params.messages[0].content).toContain("Author: other");
    expect(extraction.params.messages[0].content).toContain("Origin: https://example.test/post");
    expect(extraction.params.system).toContain("who is not the owner");
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/extract-prompt.test.ts`
Expected: FAIL: `extractionHeader` is not exported; the `other` system prompt lacks the new rule.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/stages-extract.test.ts test/integration/backfill.test.ts`
Expected: FAIL: the user prompt has no `Author:` line.

- [ ] **Step 4: Rewrite the prompt builders**

In `src/ingest/stages/extract.ts`, add `import type { Author } from "../author.js";` after the `errors.js` import, and replace `extractionSystem` and `buildExtractionRequests` with:
```ts
export function extractionSystem(reg: Registries, author: Author = "owner"): string {
  const nodeList = reg.nodeTypes.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const edgeList = reg.edgeTypes.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const owner = reg.selfName;
  // Who "I" is decides whether a statement is about the owner. Only the owner's own documents map
  // first-person pronouns to the owner; resolve.ts enforces the same rule whatever the model returns.
  const whoRules =
    author === "owner"
      ? `- The owner, ${owner}, may appear as "I", "me", "my" or by name. When the text states a relationship between the owner and another entity (applied to, works at, studied at, knows, created), include the owner as a person entity named exactly "${owner}" and add the relation.`
      : `- ${author === "other" ? `This document was written by someone other than the owner, ${owner}.` : `Who wrote this document is unknown; treat its author as someone other than the owner, ${owner}.`} First-person pronouns ("I", "me", "my", "we", "our") refer to the document's author, who is not the owner. Never map them to the owner.
- Include the owner as a person entity named exactly "${owner}" only where the text names the owner. Relations from the owner are allowed only when the text names the owner and states that relationship.`;
  const factsRule =
    author === "owner"
      ? "- facts_about_self: durable statements about the owner that stay true until something changes them: identity, status (visa, employment, education), skills, preferences, goals, locations the owner lives in or accepts, commitments. Do not record one-off events, advice received, or next steps as facts; those belong in the graph as events and relations. Never put facts about other people here. Leave it empty when the document says nothing durable about the owner."
      : `- facts_about_self must be empty unless the text names the owner, ${owner}, and states something about them; then record only that. The author's own experience, opinions, recommendations and plans are never facts about the owner. Never put facts about other people here.`;
  return `You extract a knowledge graph from one document for the personal knowledge base of ${owner}.

Node types (use exactly these names):
${nodeList}

Edge types (use exactly these names):
${edgeList}

Rules:
- Extract every named person, organization, place, project, event and artifact. Extract a concept only when it is a clear topic of the text, not every noun.
- Use the listed types. If nothing fits, use "concept" and fill untyped_hint with what kind of thing it is.
- One entity per real-world thing. If the text refers to the same thing in several ways, emit it once and put the other forms in aliases.
${whoRules}
- Every entity, relation and fact carries a short verbatim quote copied from the text.
- Relations: only those the text states or clearly implies. confidence is 0 to 1. Direction matters: from_key and to_key must follow the direction in the edge type's description (for example created goes from the maker to the thing made).
${factsRule}
- valid_from and valid_to mean the period during which a fact or relation holds. Leave valid_to null unless the text says it stopped being true. Do not put an event's date in valid_to.
- Dates are ISO 8601 or null. Never invent names, dates or numbers.`;
}

/** The lines above the text in every extraction request, online and batch (backfill.ts builds its requests here too). */
export function extractionHeader(doc: { title: string | null; source_kind: string; author: Author; origin: string | null; summary_line: string | null }): string {
  return [
    `Document title: ${doc.title ?? "(none)"}`,
    `Source kind: ${doc.source_kind}`,
    `Author: ${doc.author}`,
    `Origin: ${doc.origin ?? "(none)"}`,
    `Document summary: ${doc.summary_line ?? "(none)"}`,
  ].join("\n");
}

export interface ExtractionRequest {
  documentId: string;
  sectionChunkId: string;
  system: string;
  user: string;
}

export async function buildExtractionRequests(sql: Db, documentId: string): Promise<ExtractionRequest[]> {
  const reg = await loadRegistries(sql);
  const [doc] = await sql<{ title: string | null; source_kind: string; author: Author; origin: string | null; raw_content: string; summary_line: string | null }[]>`
    select title, source_kind, author, origin, raw_content, summary_line from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  const sections = await sql<{ id: string; content: string; ordinal: number }[]>`
    select id, content, ordinal from brain.chunks where document_id = ${documentId} and level = 0 order by ordinal`;
  if (sections.length === 0) return []; // nothing to extract from; the document proceeds
  const system = extractionSystem(reg, doc.author);
  const header = extractionHeader(doc);
  if (sections.length === 1) {
    return [{ documentId, sectionChunkId: sections[0].id, system, user: `${header}\n\n<text>\n${doc.raw_content}\n</text>` }];
  }
  return sections.map((s) => ({
    documentId,
    sectionChunkId: s.id,
    system,
    user: `${header}\nSection ${s.ordinal + 1} of ${sections.length}\n\n<text>\n${s.content}\n</text>`,
  }));
}
```
(The `ExtractionRequest` interface moves above `buildExtractionRequests` unchanged; delete its old declaration.)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/extract-prompt.test.ts`
Expected: PASS (5 tests).

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/stages-extract.test.ts test/integration/backfill.test.ts`
Expected: PASS. The existing "tells the model the registries" test still finds `organization`, `applied_to` and `Acme Corp`.

- [ ] **Step 6: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. No eval run: the eval corpus is not re-extracted until Task 9.

- [ ] **Step 7: Commit**

```bash
git add src/ingest/stages/extract.ts test/unit/extract-prompt.test.ts test/integration/stages-extract.test.ts test/integration/backfill.test.ts
git commit -m "Extraction header carries Author and Origin; first person is the owner only in the owner's documents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Hard gate in resolve

**Files:**
- Modify: `src/ingest/stages/resolve.ts` (`runResolve`, `ResolveReport`, `recordSuppressed`)
- Modify: `test/integration/stages-resolve.test.ts`
- Modify: `test/integration/search.test.ts` (the seeded news document is owner-written)

Decision on how suppressed items are kept: **the extraction payload is not modified; the count goes into `documents.metadata.suppressed_self_items`.** `brain.extractions.payload` is the raw model output that resolve re-reads every time it runs (migration 001: "so resolve can be re-run without re-calling the model"). Marking items `suppressed: "author_not_owner"` inside it would make the stored record depend on the author at the time of the last resolve, and `set-author owner` would then have to strip the marks again before re-applying. Keeping the payload raw means the suppressed items are exactly "every `facts_about_self` item, plus every relation whose `from` resolves to the self node" of a non-owner document's payload, recoverable at any time, and the count shows how many there were.

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/stages-resolve.test.ts` (after the existing `describe("runResolve", ...)` block):
```ts
async function ingestAs(author: "owner" | "other" | "unknown", payload: unknown, body = text) {
  const ctx = fakeCtx(sql, () => payload);
  const { id } = await storeDocument(sql, { text: body, sourceKind: "note", author });
  await runChunk(ctx, id);
  await runExtract(ctx, id);
  const report = await runResolve(ctx, id);
  return { ctx, id, report };
}

const selfEdges = () => sql<{ type: string }[]>`
  select e.type from brain.edges e join brain.nodes n on n.id = e.from_node where n.is_self`;
const suppressedOf = async (id: string) =>
  (await sql<{ n: number | null }[]>`select (metadata->>'suppressed_self_items')::int as n from brain.documents where id = ${id}`)[0].n;

describe("runResolve author gate", () => {
  it("writes no facts about the owner and no edges from the owner for a document someone else wrote", async () => {
    const { id, report } = await ingestAs("other", fakeExtraction);
    expect(report.suppressedSelfItems).toBe(2);
    expect(await sql`select id from brain.facts`).toHaveLength(0);
    expect(await selfEdges()).toHaveLength(0);
    expect(await suppressedOf(id)).toBe(2);
    // The model's output is kept as it was, so a later set-author owner can re-apply it.
    const [ex] = await sql<{ facts: unknown[]; relations: unknown[] }[]>`
      select payload->'facts_about_self' as facts, payload->'relations' as relations from brain.extractions where document_id = ${id}`;
    expect(ex.facts).toHaveLength(1);
    expect(ex.relations).toHaveLength(1);
    // Entities and mentions are still written: Acme Corp is in the graph.
    expect(await sql`select id from brain.nodes where canonical_name = 'acme corp'`).toHaveLength(1);
  });

  it("treats an unknown author the same way", async () => {
    const { report } = await ingestAs("unknown", fakeExtraction);
    expect(report.suppressedSelfItems).toBe(2);
    expect(await sql`select id from brain.facts`).toHaveLength(0);
  });

  it("writes both for a document the owner wrote", async () => {
    const { id, report } = await ingestAs("owner", fakeExtraction);
    expect(report.suppressedSelfItems).toBe(0);
    expect(await sql`select id from brain.facts`).toHaveLength(1);
    expect((await selfEdges()).map((e) => e.type)).toEqual(["applied_to"]);
    expect(await suppressedOf(id)).toBeNull();
  });

  it("still writes relations between other entities in someone else's document", async () => {
    const payload = {
      ...fakeExtraction,
      entities: [...fakeExtraction.entities, { key: "e3", type: "place", name: "Austin", aliases: [], untyped_hint: null, quote: "Austin" }],
      relations: [...fakeExtraction.relations, { from_key: "e2", to_key: "e3", type: "located_in", confidence: 0.9, valid_from: null, valid_to: null, quote: "Acme Corp in Austin" }],
    };
    const { report } = await ingestAs("other", payload, "I applied to Acme Corp in Austin. I am on F-1 OPT.");
    expect(report.suppressedSelfItems).toBe(2);
    expect((await sql<{ type: string }[]>`select type from brain.edges`).map((e) => e.type)).toEqual(["located_in"]);
  });

  it("suppresses a relation that points from the owner only after its direction is corrected", async () => {
    const payload = {
      entities: fakeExtraction.entities,
      relations: [{ from_key: "e2", to_key: "e1", type: "applied_to", confidence: 0.9, valid_from: null, valid_to: null, quote: "applied to Acme Corp" }],
      facts_about_self: [],
    };
    const { report } = await ingestAs("other", payload);
    expect(report.suppressedSelfItems).toBe(1);
    expect(await sql`select id from brain.edges`).toHaveLength(0);
  });
});
```

In `test/integration/search.test.ts`, replace the first line of `seed()`'s body after `const ctx = fakeCtx(sql, handler);`:
```ts
  await ingest(ctx, { text: "Zorblax Industries in Austin released the ZX-9000 drill. I am on F-1 OPT.", sourceKind: "news", title: "Zorblax news" });
```
with
```ts
  // Owner-written so its first-person visa fact is kept: resolve drops facts about the owner from documents
  // the owner did not write, and news defaults to author other.
  await ingest(ctx, { text: "Zorblax Industries in Austin released the ZX-9000 drill. I am on F-1 OPT.", sourceKind: "news", title: "Zorblax news", author: "owner" });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/stages-resolve.test.ts`
Expected: FAIL: `report` is undefined (`runResolve` returns nothing), and the `other` document has 1 fact and 1 self edge.

- [ ] **Step 3: Gate `runResolve`**

In `src/ingest/stages/resolve.ts`, replace `runResolve` with:
```ts
export interface ResolveReport {
  /**
   * Facts about the owner plus relations from the owner that the extractor returned for a document the
   * owner did not write. They stay in brain.extractions.payload and are not written.
   */
  suppressedSelfItems: number;
}

/** documents.metadata.suppressed_self_items: the count when there is one, absent otherwise. */
async function recordSuppressed(sql: Db, documentId: string, n: number): Promise<void> {
  if (n > 0) {
    await sql`update brain.documents set metadata = metadata || jsonb_build_object('suppressed_self_items', ${n}::int) where id = ${documentId}`;
  } else {
    await sql`update brain.documents set metadata = metadata - 'suppressed_self_items' where id = ${documentId}`;
  }
}

/** Stage 6. Turns stored extractions into nodes, edges, mentions and facts. Safe to re-run. */
export async function runResolve(ctx: Ctx, documentId: string): Promise<ResolveReport> {
  const { sql, embedder } = ctx;
  const [doc] = await sql<{ author: string }[]>`select author from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  // Hard gate (spec §4.3): whatever the model returned, only a document the owner wrote can state facts
  // about the owner or relations from the owner.
  const ownerWrote = doc.author === "owner";

  const extractions = await sql<{ section_chunk_id: string; payload: unknown }[]>`
    select section_chunk_id, payload from brain.extractions where document_id = ${documentId}`;
  if (extractions.length === 0) {
    // Extraction skipped; the document is still searchable.
    await recordSuppressed(sql, documentId, 0);
    return { suppressedSelfItems: 0 };
  }

  const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
  const knownTypes = new Set((await sql<{ name: string }[]>`select name from brain.node_types`).map((r) => r.name));
  const knownEdges = new Set((await sql<{ name: string }[]>`select name from brain.edge_types`).map((r) => r.name));
  let suppressed = 0;

  for (const ex of extractions) {
    const payload = ExtractionSchema.parse(ex.payload);
    const passages = await sql<{ id: string; content: string }[]>`
      select id, content from brain.chunks where parent_id = ${ex.section_chunk_id} order by ordinal`;
    const evidenceFor = (quote: string) => locateQuote(passages, quote);

    const names = payload.entities.map((e) => `${knownTypes.has(e.type) ? e.type : "concept"}: ${e.name}`);
    const vectors = names.length ? await embedder.embed(names, "document") : [];
    if (vectors.length !== names.length) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${names.length} entity names`);
    }

    const keyToNode = new Map<string, string>();
    for (let i = 0; i < payload.entities.length; i++) {
      const e = payload.entities[i];
      const nodeId = await resolveEntity(sql, e, vectors[i], knownTypes, ctx.llm.model);
      keyToNode.set(e.key, nodeId);
      const loc = evidenceFor(e.quote);
      await sql`
        insert into brain.mentions (chunk_id, node_id, confidence, span_start, span_end)
        values (${loc?.chunkId ?? ex.section_chunk_id}, ${nodeId}, 1, ${loc?.start ?? null}, ${loc?.end ?? null})
        on conflict do nothing`;
    }

    const nodeIds = [...new Set(keyToNode.values())];
    const nodeType = new Map(
      (nodeIds.length
        ? await sql<{ id: string; type: string }[]>`select id, type from brain.nodes where id = any(${nodeIds}::uuid[])`
        : []
      ).map((n) => [n.id, n.type]),
    );

    for (const r of payload.relations) {
      let from = keyToNode.get(r.from_key);
      let to = keyToNode.get(r.to_key);
      if (!from || !to || from === to) continue;
      const type = knownEdges.has(r.type) ? r.type : "related_to";
      const props: Record<string, unknown> = knownEdges.has(r.type) ? {} : { original_type: r.type };
      const direction = checkDirection(type, nodeType.get(from)!, nodeType.get(to)!);
      if (direction === "swap") [from, to] = [to, from];
      else if (direction === "unverified") props.direction_unverified = true;
      // Checked after the direction fix, so an edge that only points from the owner once corrected is caught too.
      if (!ownerWrote && from === self.id) {
        suppressed++;
        continue;
      }
      const quote = r.quote.trim().slice(0, MAX_EDGE_QUOTE);
      if (quote) props.quote = quote;
      const loc = evidenceFor(r.quote);
      await sql`
        insert into brain.edges (from_node, to_node, type, confidence, properties, evidence_chunk_id, valid_from, valid_to)
        values (${from}, ${to}, ${type}, ${r.confidence}, ${sql.json(props as postgres.JSONValue)}, ${loc?.chunkId ?? ex.section_chunk_id},
                ${dateOrNull(r.valid_from)}, ${dateOrNull(r.valid_to)})
        on conflict do nothing`;
    }

    if (!ownerWrote) {
      suppressed += payload.facts_about_self.length;
      continue;
    }
    for (const f of payload.facts_about_self) {
      const loc = evidenceFor(f.quote);
      const objectNode = f.object_key ? keyToNode.get(f.object_key) ?? null : null;
      await sql`
        insert into brain.facts (subject_id, predicate, object_text, object_node_id, confidence, source_chunk_id, verified_by, valid_from, valid_to)
        values (${self.id}, ${normalizePredicate(f.predicate)}, ${f.object_text}, ${objectNode}, ${f.confidence},
                ${loc?.chunkId ?? ex.section_chunk_id}, ${"extractor:" + ctx.llm.model}, ${dateOrNull(f.valid_from)}, ${dateOrNull(f.valid_to)})
        on conflict do nothing`;
    }
  }

  await recordSuppressed(sql, documentId, suppressed);
  return { suppressedSelfItems: suppressed };
}
```
`RUNNERS` in `pipeline.ts` types runners as returning `Promise<void>`; a function returning `Promise<ResolveReport>` is assignable, so `pipeline.ts` is unchanged.

- [ ] **Step 4: Run the tests**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/stages-resolve.test.ts test/integration/search.test.ts test/integration/inspect.test.ts`
Expected: PASS. `search.test.ts` "finds a keyword hit..." still finds `visa_status` because the seeded news is now owner-written. `inspect.test.ts` "orient summarizes" still sees one fact: the `note` keeps its fact, the `news` copy is suppressed (it used to be collapsed into the same row).

- [ ] **Step 5: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. No eval run: the eval corpus is not re-resolved until Task 9.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/stages/resolve.ts test/integration/stages-resolve.test.ts test/integration/search.test.ts
git commit -m "Resolve writes facts about the owner and edges from the owner only for owner-written documents

Suppressed items stay in the raw extraction payload; documents.metadata.suppressed_self_items counts them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Undo a document's resolution before re-applying it

**Files:**
- Modify: `src/ingest/stages/resolve.ts` (`undoResolution`, `UndoReport`; `runResolve` undoes first and reports it)
- Modify: `src/ingest/stages/chunk.ts` (undo before replacing chunks)
- Create: `test/integration/undo-resolution.test.ts`

What undo does with each foreign key:
- `facts.source_chunk_id`, `edges.evidence_chunk_id` are `on delete set null` and `mentions.chunk_id` cascades. Undo selects by those columns **before** anything deletes chunks, which is why `runChunk` now undoes first: re-chunking used to leave the document's facts and edges behind with a null source, unreachable by any later undo.
- `facts.superseded_by` references `facts(id)` with no action, so deleting a fact that another fact points at would fail. Before deleting, each such referrer is re-pointed to the next surviving fact in the deleted fact's own chain, or, when there is none, made current again (`superseded_by = null`) with the `valid_to` it had before it was superseded, read from its latest `superseded` row in `fact_events` (null when there is none). Every removal and restoration is logged.
- Facts the owner verified are kept: verification is a deliberate owner action (the same principle `supersedeFact` follows), so neither `brain retry` nor `set-author` may silently discard it. `set-author` prints them.
- Nodes are never deleted.

- [ ] **Step 1: Write the failing tests**

`test/integration/undo-resolution.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { runChunk } from "../../src/ingest/stages/chunk.js";
import { runResolve, undoResolution } from "../../src/ingest/stages/resolve.js";
import { addFact, verifyFact } from "../../src/graph/facts.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: null } : fakeExtraction;
const text = "I applied to Acme Corp in September. I am on F-1 OPT so sponsorship matters.";

async function counts(documentId: string) {
  const [r] = await sql<{ facts: number; edges: number; mentions: number; nodes: number }[]>`
    select (select count(*)::int from brain.facts) as facts,
           (select count(*)::int from brain.edges) as edges,
           (select count(*)::int from brain.mentions m join brain.chunks c on c.id = m.chunk_id where c.document_id = ${documentId}) as mentions,
           (select count(*)::int from brain.nodes) as nodes`;
  return r;
}

async function extractedFactId(): Promise<string> {
  return (await sql<{ id: string }[]>`select id from brain.facts where source_chunk_id is not null`)[0].id;
}

describe("undoResolution", () => {
  it("deletes the facts, edges and mentions a document produced and keeps the nodes", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    expect(await counts(id)).toEqual({ facts: 1, edges: 1, mentions: 2, nodes: 2 });
    const report = await undoResolution(sql, id);
    expect(report.facts).toEqual([expect.objectContaining({ predicate: "visa_status", objectText: "F-1 OPT" })]);
    expect(report.edges).toEqual([expect.objectContaining({ type: "applied_to", fromName: "Frank Fu", toName: "Acme Corp" })]);
    expect(report.mentions).toBe(2);
    expect(report.keptVerified).toEqual([]);
    expect(await counts(id)).toEqual({ facts: 0, edges: 0, mentions: 0, nodes: 2 });
    const events = await sql<{ event: string; document_id: string }[]>`select event, document_id from brain.fact_events`;
    expect(events).toEqual([{ event: "removed", document_id: id }]);
  });

  it("re-resolving after the author changes to other leaves nothing about the owner, and the nodes stay", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    await sql`update brain.documents set author = 'other' where id = ${id}`;
    const report = await runResolve(ctx, id);
    expect(report.undone.facts).toHaveLength(1);
    expect(report.suppressedSelfItems).toBe(2);
    expect(await counts(id)).toEqual({ facts: 0, edges: 0, mentions: 2, nodes: 2 });
  });

  it("re-running resolve on an unchanged document gives the same rows", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    await runResolve(ctx, id);
    await runResolve(ctx, id);
    expect(await counts(id)).toEqual({ facts: 1, edges: 1, mentions: 2, nodes: 2 });
  });

  it("keeps a fact the owner verified", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    const factId = await extractedFactId();
    expect(await verifyFact(sql, factId, "frank")).toBe(true);
    const report = await undoResolution(sql, id);
    expect(report.facts).toEqual([]);
    expect(report.keptVerified).toEqual([{ id: factId, predicate: "visa_status", objectText: "F-1 OPT" }]);
    expect((await counts(id)).facts).toBe(1);
  });

  it("makes a fact current again when the fact that superseded it is removed", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    const extracted = await extractedFactId();
    // What extractor supersession (Task 7) writes: an older fact points at the document's newer one.
    const { id: older } = await addFact(sql, { predicate: "visa_status", objectText: "J-1", by: "frank" });
    await sql`update brain.facts set superseded_by = ${extracted}, valid_to = current_date where id = ${older}`;
    const report = await undoResolution(sql, id);
    expect(report.restored).toEqual([older]);
    const [row] = await sql<{ superseded_by: string | null; valid_to: string | null }[]>`
      select superseded_by, valid_to::text as valid_to from brain.facts where id = ${older}`;
    expect(row).toEqual({ superseded_by: null, valid_to: null });
    const events = await sql<{ event: string; fact_id: string }[]>`select event, fact_id from brain.fact_events order by id`;
    expect(events).toEqual([{ event: "restored", fact_id: older }, { event: "removed", fact_id: extracted }]);
  });

  it("re-points a referrer past the removed fact to the next surviving one in its chain", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    const extracted = await extractedFactId();
    const { id: older } = await addFact(sql, { predicate: "visa_status", objectText: "J-1", by: "frank" });
    const { id: newest } = await addFact(sql, { predicate: "visa_status", objectText: "H-1B", by: "frank" });
    await sql`update brain.facts set superseded_by = ${extracted} where id = ${older}`;
    await sql`update brain.facts set superseded_by = ${newest} where id = ${extracted}`;
    const report = await undoResolution(sql, id);
    expect(report.restored).toEqual([]);
    const [row] = await sql<{ superseded_by: string | null }[]>`select superseded_by from brain.facts where id = ${older}`;
    expect(row.superseded_by).toBe(newest);
  });

  it("re-chunking a resolved document removes what it produced instead of orphaning it", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text, sourceKind: "note" });
    await runChunk(ctx, id);
    const [r] = await sql<{ facts: number; edges: number }[]>`
      select (select count(*)::int from brain.facts) as facts, (select count(*)::int from brain.edges) as edges`;
    expect(r).toEqual({ facts: 0, edges: 0 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/undo-resolution.test.ts`
Expected: FAIL: `undoResolution` is not exported; `report.undone` is undefined; re-chunking leaves 1 fact and 1 edge with null sources.

- [ ] **Step 3: Add `undoResolution` and make `runResolve` call it**

In `src/ingest/stages/resolve.ts`, add above `ResolveReport`:
```ts
export interface UndoReport {
  /** Facts deleted (unverified facts whose source chunk is in the document). */
  facts: { id: string; predicate: string; objectText: string }[];
  /** Facts from the document the owner verified; never deleted. */
  keptVerified: { id: string; predicate: string; objectText: string }[];
  edges: { id: string; type: string; fromName: string; toName: string }[];
  mentions: number;
  /** Facts that a deleted fact had superseded and that are current again. */
  restored: string[];
}

/**
 * Deletes what resolving this document produced so resolution can be applied again (spec §4.3): unverified
 * facts whose source chunk, edges whose evidence chunk, and mentions whose chunk belongs to the document.
 * Nodes are never deleted. A fact that a deleted fact had superseded is re-pointed to the next surviving fact
 * in the deleted fact's chain, or made current again with the valid_to it had before it was superseded
 * (from fact_events). Every removal and restoration is logged to brain.fact_events under `by`.
 */
export async function undoResolution(sql: Db, documentId: string, opts: { by?: string } = {}): Promise<UndoReport> {
  const by = opts.by ?? "resolve";
  return sql.begin(async (tx) => {
    const report: UndoReport = { facts: [], keptVerified: [], edges: [], mentions: 0, restored: [] };
    const chunkIds = (await tx<{ id: string }[]>`select id from brain.chunks where document_id = ${documentId}`).map((r) => r.id);
    if (chunkIds.length === 0) return report;

    const produced = await tx<{ id: string; predicate: string; object_text: string; verified: boolean; superseded_by: string | null }[]>`
      select id, predicate, object_text, verified, superseded_by from brain.facts
      where source_chunk_id = any(${chunkIds}::uuid[])
      order by created_at, id
      for update`;
    const doomed = produced.filter((f) => !f.verified);
    report.keptVerified = produced.filter((f) => f.verified).map((f) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text }));
    report.facts = doomed.map((f) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text }));

    if (doomed.length > 0) {
      const doomedIds = doomed.map((f) => f.id);
      const doomedSet = new Set(doomedIds);
      const next = new Map(doomed.map((f) => [f.id, f.superseded_by]));
      // facts.superseded_by has no ON DELETE action: anything pointing at a doomed fact must move first.
      const referrers = await tx<{ id: string; superseded_by: string }[]>`
        select id, superseded_by from brain.facts
        where superseded_by = any(${doomedIds}::uuid[]) and not (id = any(${doomedIds}::uuid[]))
        for update`;
      for (const r of referrers) {
        let target: string | null = r.superseded_by;
        for (let hops = 0; target !== null && doomedSet.has(target) && hops <= doomedIds.length; hops++) target = next.get(target) ?? null;
        if (target !== null && doomedSet.has(target)) target = null; // a cycle among doomed facts
        if (target !== null) {
          await tx`update brain.facts set superseded_by = ${target} where id = ${r.id}`;
          continue;
        }
        const [last] = await tx<{ previous: string | null }[]>`
          select detail->>'previous_valid_to' as previous from brain.fact_events
          where fact_id = ${r.id} and event = 'superseded' and detail->>'superseded_by' = ${r.superseded_by}
          order by created_at desc, id desc limit 1`;
        await tx`update brain.facts set superseded_by = null, valid_to = ${last?.previous ?? null}::date where id = ${r.id}`;
        await tx`
          insert into brain.fact_events (fact_id, event, by, document_id, detail)
          values (${r.id}, 'restored', ${by}, ${documentId}, ${tx.json({ removed_superseder: r.superseded_by } as postgres.JSONValue)})`;
        report.restored.push(r.id);
      }
      await tx`
        insert into brain.fact_events (fact_id, event, by, document_id, detail)
        select f.id, 'removed', ${by}, ${documentId}, jsonb_build_object('predicate', f.predicate, 'object_text', f.object_text)
        from brain.facts f where f.id = any(${doomedIds}::uuid[])
        order by f.created_at, f.id`;
      await tx`delete from brain.facts where id = any(${doomedIds}::uuid[])`;
    }

    const edges = await tx<{ id: string; type: string; fromName: string; toName: string }[]>`
      delete from brain.edges e
      using brain.nodes fn, brain.nodes tn
      where e.evidence_chunk_id = any(${chunkIds}::uuid[]) and fn.id = e.from_node and tn.id = e.to_node
      returning e.id, e.type, fn.name as "fromName", tn.name as "toName"`;
    report.edges = [...edges];
    const mentions = await tx`delete from brain.mentions where chunk_id = any(${chunkIds}::uuid[])`;
    report.mentions = mentions.count;
    return report;
  });
}
```

Replace the `ResolveReport` interface (from Task 4) with:
```ts
export interface ResolveReport {
  /** What the previous resolution of this document produced and this run removed before re-applying. */
  undone: UndoReport;
  /**
   * Facts about the owner plus relations from the owner that the extractor returned for a document the
   * owner did not write. They stay in brain.extractions.payload and are not written.
   */
  suppressedSelfItems: number;
}
```
Leave `recordSuppressed` as it is. Replace the opening of `runResolve`, from its doc comment through the closing brace of the `if (extractions.length === 0) { ... }` block, with:
```ts
/**
 * Stage 6. Turns stored extractions into nodes, edges, mentions and facts. Re-running it first undoes the
 * document's previous resolution (undoResolution), so a changed author or payload never leaves stale rows.
 */
export async function runResolve(ctx: Ctx, documentId: string, opts: { by?: string } = {}): Promise<ResolveReport> {
  const { sql, embedder } = ctx;
  const [doc] = await sql<{ author: string }[]>`select author from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  const undone = await undoResolution(sql, documentId, { by: opts.by ?? "resolve" });
  // Hard gate (spec §4.3): whatever the model returned, only a document the owner wrote can state facts
  // about the owner or relations from the owner.
  const ownerWrote = doc.author === "owner";

  const extractions = await sql<{ section_chunk_id: string; payload: unknown }[]>`
    select section_chunk_id, payload from brain.extractions where document_id = ${documentId}`;
  if (extractions.length === 0) {
    // Extraction skipped; the document is still searchable.
    await recordSuppressed(sql, documentId, 0);
    return { undone, suppressedSelfItems: 0 };
  }
```
and replace the last two lines of `runResolve` with:
```ts
  await recordSuppressed(sql, documentId, suppressed);
  return { undone, suppressedSelfItems: suppressed };
}
```
The body between (registries, the per-extraction loop with the gate) is unchanged from Task 4.

- [ ] **Step 4: Undo before re-chunking**

Replace `src/ingest/stages/chunk.ts` with:
```ts
import type { Ctx } from "../../ctx.js";
import { chunkDocument } from "../chunk.js";
import { undoResolution } from "./resolve.js";

/** Stage 2. Replaces all chunks of the document. */
export async function runChunk(ctx: Ctx, documentId: string): Promise<void> {
  const { sql } = ctx;
  const [doc] = await sql<{ raw_content: string }[]>`select raw_content from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  const drafts = chunkDocument(doc.raw_content);

  // Facts and edges cite chunks with ON DELETE SET NULL, so replacing the chunks would orphan what this
  // document's resolution produced. Remove it first; resolving again re-creates it. A no-op on first chunking.
  await undoResolution(sql, documentId, { by: "rechunk" });

  await sql.begin(async (tx) => {
    await tx`delete from brain.chunks where document_id = ${documentId}`;
    const sectionIds = new Map<number, string>();
    for (const d of drafts.filter((d) => d.level === 0)) {
      const [row] = await tx<{ id: string }[]>`
        insert into brain.chunks (document_id, level, ordinal, heading_path, content, token_count, char_start, char_end)
        values (${documentId}, 0, ${d.ordinal}, ${d.headingPath}::text[], ${d.content}, ${d.tokenCount}, ${d.charStart}, ${d.charEnd})
        returning id`;
      sectionIds.set(d.ordinal, row.id);
    }
    for (const d of drafts.filter((d) => d.level === 1)) {
      const parent = sectionIds.get(d.parentOrdinal!);
      if (!parent) throw new Error(`Passage ${d.ordinal} has no section ${d.parentOrdinal}`);
      await tx`
        insert into brain.chunks (document_id, parent_id, level, ordinal, heading_path, content, token_count, char_start, char_end)
        values (${documentId}, ${parent}, 1, ${d.ordinal}, ${d.headingPath}::text[], ${d.content}, ${d.tokenCount}, ${d.charStart}, ${d.charEnd})`;
    }
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/undo-resolution.test.ts test/integration/stages-resolve.test.ts test/integration/stages-chunk.test.ts test/integration/pipeline.test.ts`
Expected: PASS. "is idempotent" in `stages-resolve.test.ts` still sees 1 edge and 1 fact (now because the re-run deletes and re-inserts rather than because of `on conflict do nothing`).

- [ ] **Step 6: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. No eval run (ingestion only).

- [ ] **Step 7: Commit**

```bash
git add src/ingest/stages/resolve.ts src/ingest/stages/chunk.ts test/integration/undo-resolution.test.ts
git commit -m "undoResolution: re-resolving a document first removes the facts, edges and mentions it produced

Verified facts are kept; facts a removed fact had superseded become current again; re-chunking
undoes first so nothing is orphaned. Nodes are never deleted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `brain set-author`, and suppressed counts in `brain status` / `brain_status`

**Files:**
- Create: `src/ingest/set-author.ts`
- Modify: `src/cli.ts` (`status`, new `set-author`)
- Modify: `src/mcp/server.ts` (`brain_status`)
- Modify: `src/mcp/render.ts` (`renderStatus`)
- Modify: `README.md`
- Create: `test/integration/set-author.test.ts`
- Modify: `test/unit/render.test.ts`, `test/integration/mcp-server.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/integration/set-author.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest, runPipeline } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { setAuthor, suppressedDocuments } from "../../src/ingest/set-author.js";
import type { ObsidianAutoProjector } from "../../src/obsidian/auto.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

// Shaped like the saved Databricks post: a stranger's first-person opinions, stored as an owner note.
const body = "I thought Databricks would save us money. I have run data platforms for eight years. Put cluster policies in place first. Cost governance is not optional.";
const post = {
  entities: [
    { key: "me", type: "person", name: "Frank Fu", aliases: [], untyped_hint: null, quote: "I" },
    { key: "db", type: "organization", name: "Databricks", aliases: [], untyped_hint: null, quote: "Databricks" },
    { key: "cg", type: "concept", name: "Databricks cost governance", aliases: [], untyped_hint: null, quote: "Cost governance is not optional" },
  ],
  relations: [{ from_key: "me", to_key: "cg", type: "related_to", confidence: 0.8, valid_from: null, valid_to: null, quote: "Cost governance is not optional" }],
  facts_about_self: [
    { predicate: "view_on", object_text: "Databricks cost governance is not optional", object_key: "cg", confidence: 0.8, valid_from: null, valid_to: null, quote: "Cost governance is not optional" },
    { predicate: "recommends", object_text: "cluster policies before the first workload", object_key: null, confidence: 0.8, valid_from: null, valid_to: null, quote: "Put cluster policies in place first" },
    { predicate: "has_experience_with", object_text: "Databricks cost governance", object_key: "cg", confidence: 0.8, valid_from: null, valid_to: null, quote: "I have run data platforms for eight years" },
  ],
};
const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Databricks costs", summary_line: "A post about Databricks costs.", summary: "S", occurred_at: null } : post;

const selfFacts = async () =>
  (await sql<{ predicate: string }[]>`
    select f.predicate from brain.facts f join brain.nodes n on n.id = f.subject_id where n.is_self order by f.predicate`).map((r) => r.predicate);
const selfEdges = async () =>
  (await sql<{ toName: string }[]>`
    select t.name as "toName" from brain.edges e join brain.nodes n on n.id = e.from_node join brain.nodes t on t.id = e.to_node
    where n.is_self`).map((r) => r.toName);

describe("setAuthor", () => {
  it("removes the facts and edges a document produced when it turns out someone else wrote it", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note", title: "Databricks costs" });
    expect(await selfFacts()).toEqual(["has_experience_with", "recommends", "view_on"]);
    expect(await selfEdges()).toEqual(["Databricks cost governance"]);
    let notified = 0;
    ctx.obsidian = { notify: () => void notified++ } as unknown as ObsidianAutoProjector;

    const r = await setAuthor(ctx, id, "other");

    expect(r).toMatchObject({ documentId: id, previous: "owner", author: "other", reresolved: true, suppressedSelfItems: 4 });
    expect(r.removedFacts.map((f) => f.predicate).sort()).toEqual(["has_experience_with", "recommends", "view_on"]);
    expect(r.removedEdges).toEqual([{ type: "related_to", fromName: "Frank Fu", toName: "Databricks cost governance" }]);
    expect(await selfFacts()).toEqual([]);
    expect(await selfEdges()).toEqual([]);
    const nodes = await sql<{ name: string }[]>`select name from brain.nodes where not is_self order by name`;
    expect(nodes.map((n) => n.name)).toEqual(["Databricks", "Databricks cost governance"]);
    const [doc] = await sql<{ author: string; n: number }[]>`
      select author, (metadata->>'suppressed_self_items')::int as n from brain.documents where id = ${id}`;
    expect(doc).toEqual({ author: "other", n: 4 });
    expect(notified).toBe(1);
  });

  it("re-applies the facts when the author is set back to owner", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note" });
    await setAuthor(ctx, id, "other");
    const r = await setAuthor(ctx, id, "owner");
    expect(r).toMatchObject({ previous: "other", author: "owner", reresolved: true, suppressedSelfItems: 0, removedFacts: [], removedEdges: [] });
    expect(await selfFacts()).toEqual(["has_experience_with", "recommends", "view_on"]);
    const [doc] = await sql<{ n: string | null }[]>`select metadata->>'suppressed_self_items' as n from brain.documents where id = ${id}`;
    expect(doc.n).toBeNull();
  });

  it("only records the author for a document that has not been resolved yet; the pipeline applies it later", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note" }, { until: "chunked" });
    const r = await setAuthor(ctx, id, "other");
    expect(r).toMatchObject({ previous: "owner", author: "other", reresolved: false });
    await runPipeline(ctx, id);
    expect(await selfFacts()).toEqual([]);
  });

  it("refuses an unknown document and one another runner holds", async () => {
    const ctx = fakeCtx(sql, handler);
    await expect(setAuthor(ctx, "00000000-0000-0000-0000-000000000000", "other")).rejects.toThrow(/not found/);
    await expect(setAuthor(ctx, "nope", "other")).rejects.toThrow(/not found/);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note" });
    const reserved = await sql.reserve();
    await reserved`select pg_advisory_lock(hashtextextended(${id}::text, 0))`;
    try {
      await expect(setAuthor(ctx, id, "other")).rejects.toThrow(/another runner/);
    } finally {
      await reserved`select pg_advisory_unlock(hashtextextended(${id}::text, 0))`;
      reserved.release();
    }
  });
});

describe("suppressedDocuments", () => {
  it("lists documents whose items about the owner were suppressed, largest count first", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: body, sourceKind: "note", author: "other" });
    await ingest(ctx, { text: "An owner note about Databricks.", sourceKind: "note" });
    expect(await suppressedDocuments(sql)).toEqual([expect.objectContaining({ documentId: id, author: "other", count: 4 })]);
  });
});
```

In `test/unit/render.test.ts`, change the import line to
```ts
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus } from "../../src/mcp/render.js";
```
and add inside `describe("other renderers", ...)`:
```ts
  it("renderStatus lists documents whose items about the owner were suppressed", () => {
    const pipeline = [{ stage: "done", count: 1, failed: 0 }];
    const t = renderStatus(pipeline, [], [], [{ documentId: "d1", title: "Databricks costs", author: "other", count: 4 }]);
    expect(t).toContain("suppressed because the owner did not write the document");
    expect(t).toContain("- d1 Databricks costs [author other]: 4");
    expect(renderStatus(pipeline, [], [])).not.toContain("suppressed");
  });
```

Add to `test/integration/mcp-server.test.ts` inside `describe("brain MCP server", ...)`:
```ts
  it("shows suppressed items about the owner in brain_status", async () => {
    const s = await connect();
    const ing = await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note", author: "other" });
    const id = /document ([0-9a-f-]{36})/.exec(ing.text)![1];
    await s.jobs.drain();
    const status = await s.call("brain_status");
    expect(status.text).toContain(`- ${id} Acme note [author other]: 2`);
    await s.close();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/unit/render.test.ts`
Expected: FAIL: no suppressed section in `renderStatus`.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/set-author.test.ts test/integration/mcp-server.test.ts`
Expected: FAIL: `src/ingest/set-author.js` does not exist; `brain_status` has no suppressed line.

- [ ] **Step 3: Write `src/ingest/set-author.ts`**

```ts
import type { Ctx } from "../ctx.js";
import type { Db } from "../db.js";
import { UUID } from "../retrieve/documents.js";
import { refreshMirror } from "../obsidian/auto.js";
import { runResolve } from "./stages/resolve.js";
import type { Author } from "./author.js";

export interface SetAuthorResult {
  documentId: string;
  previous: Author;
  author: Author;
  /** False when the document has not reached the resolve stage; the new author then applies when it does. */
  reresolved: boolean;
  /** Facts the document produced before and no longer produces. */
  removedFacts: { id: string; predicate: string; objectText: string }[];
  removedEdges: { type: string; fromName: string; toName: string }[];
  /** Facts from this document the owner verified; undo never deletes them. */
  keptVerified: { id: string; predicate: string; objectText: string }[];
  /** Facts a removed fact had superseded that are current again. */
  restoredFacts: string[];
  suppressedSelfItems: number;
}

const RESOLVED_STAGES = new Set(["resolved", "done"]);

/**
 * Changes who wrote a document and, if it has been resolved, re-runs resolution so facts about the owner and
 * edges from the owner follow the new author (spec §4.1). Holds the same per-document advisory lock as
 * runPipeline. Notifies the Obsidian mirror; the CLI flushes it on exit.
 */
export async function setAuthor(ctx: Ctx, documentId: string, author: Author): Promise<SetAuthorResult> {
  if (!UUID.test(documentId)) throw new Error(`Document ${documentId} not found`);
  const reserved = await ctx.sql.reserve();
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtextextended(${documentId}::text, 0)) as locked`;
    if (!locked) throw new Error(`Document ${documentId} is being processed by another runner; try again once brain status shows it done`);
    try {
      const [doc] = await ctx.sql<{ author: Author; stage: string | null }[]>`
        select d.author, j.stage from brain.documents d left join brain.ingest_jobs j on j.document_id = d.id
        where d.id = ${documentId}`;
      if (!doc) throw new Error(`Document ${documentId} not found`);
      await ctx.sql`update brain.documents set author = ${author} where id = ${documentId}`;
      const result: SetAuthorResult = {
        documentId, previous: doc.author, author, reresolved: false,
        removedFacts: [], removedEdges: [], keptVerified: [], restoredFacts: [], suppressedSelfItems: 0,
      };
      if (doc.stage && RESOLVED_STAGES.has(doc.stage)) {
        const report = await runResolve(ctx, documentId, { by: "set-author" });
        const now = await producedBy(ctx.sql, documentId);
        result.reresolved = true;
        result.removedFacts = report.undone.facts.filter(
          (f) => !now.facts.some((g) => g.predicate === f.predicate && g.objectText === f.objectText),
        );
        result.removedEdges = report.undone.edges
          .filter((e) => !now.edges.some((g) => g.type === e.type && g.fromName === e.fromName && g.toName === e.toName))
          .map(({ type, fromName, toName }) => ({ type, fromName, toName }));
        result.keptVerified = report.undone.keptVerified;
        result.restoredFacts = report.undone.restored.length
          ? (await ctx.sql<{ id: string }[]>`
              select id from brain.facts where id = any(${report.undone.restored}::uuid[]) and superseded_by is null`).map((r) => r.id)
          : [];
        result.suppressedSelfItems = report.suppressedSelfItems;
      }
      refreshMirror(ctx);
      return result;
    } finally {
      await reserved`select pg_advisory_unlock(hashtextextended(${documentId}::text, 0))`;
    }
  } finally {
    reserved.release();
  }
}

async function producedBy(sql: Db, documentId: string) {
  const facts = await sql<{ predicate: string; objectText: string }[]>`
    select f.predicate, f.object_text as "objectText"
    from brain.facts f join brain.chunks c on c.id = f.source_chunk_id
    where c.document_id = ${documentId}`;
  const edges = await sql<{ type: string; fromName: string; toName: string }[]>`
    select e.type, fn.name as "fromName", tn.name as "toName"
    from brain.edges e join brain.chunks c on c.id = e.evidence_chunk_id
    join brain.nodes fn on fn.id = e.from_node join brain.nodes tn on tn.id = e.to_node
    where c.document_id = ${documentId}`;
  return { facts, edges };
}

export interface SuppressedDocument {
  documentId: string;
  title: string | null;
  author: string;
  count: number;
}

/** Documents whose facts about the owner or relations from the owner were suppressed, largest count first. */
export async function suppressedDocuments(sql: Db, limit = 20): Promise<SuppressedDocument[]> {
  const rows = await sql<SuppressedDocument[]>`
    select id as "documentId", title, author, (metadata->>'suppressed_self_items')::int as "count"
    from brain.documents
    where (metadata->>'suppressed_self_items')::int > 0
    order by "count" desc, ingested_at desc
    limit ${limit}`;
  return [...rows];
}
```

- [ ] **Step 4: Suppressed counts in `brain_status`**

In `src/mcp/render.ts`, add `import type { SuppressedDocument } from "../ingest/set-author.js";` with the other type imports, and replace `renderStatus` with:
```ts
export function renderStatus(
  pipeline: { stage: string; count: number; failed: number }[],
  inflight: string[],
  failures: { document_id: string; stage: string; error: string }[],
  suppressed: SuppressedDocument[] = [],
): string {
  const out = [pipeline.map((p) => `${p.stage}: ${p.count}${p.failed ? ` (${p.failed} failed)` : ""}`).join(", ")];
  out.push(inflight.length ? `Processing in this server: ${inflight.join(", ")}` : "Nothing processing in this server.");
  for (const f of failures) out.push(`- ${f.document_id} stuck after ${f.stage}: ${f.error}`);
  if (suppressed.length) {
    out.push("Facts and relations about the owner suppressed because the owner did not write the document:");
    for (const s of suppressed) out.push(`- ${s.documentId} ${s.title ?? "(untitled)"} [author ${s.author}]: ${s.count}`);
  }
  return out.join("\n");
}
```

In `src/mcp/server.ts`, add `import { suppressedDocuments } from "../ingest/set-author.js";` and replace the `brain_status` handler body's return line
```ts
        return text(renderStatus(await stageCounts(ctx), jobs.pending, failures));
```
with
```ts
        return text(renderStatus(await stageCounts(ctx), jobs.pending, failures, await suppressedDocuments(ctx.sql)));
```
and its description with `"Pipeline stage counts, failures, documents still processing in this server, and documents whose facts about the owner were suppressed because someone else wrote them."`.

- [ ] **Step 5: CLI `status` and `set-author`**

In `src/cli.ts`, replace the `status` command block with:
```ts
program
  .command("status")
  .description("Pipeline stage counts, failures, and documents whose items about the owner were suppressed")
  .action(async () => {
    const { suppressedDocuments } = await import("./ingest/set-author.js");
    await withCtx(async (ctx) => {
      for (const s of await stageCounts(ctx)) console.log(`${s.stage.padEnd(10)} ${String(s.count).padStart(6)} ${s.failed ? `(${s.failed} failed)` : ""}`);
      const failed = await ctx.sql<{ document_id: string; stage: string; error: string; attempts: number }[]>`
        select document_id, stage, error, attempts from brain.ingest_jobs where error is not null order by updated_at desc limit 20`;
      for (const f of failed) console.log(`  ${f.document_id} at ${f.stage} (${f.attempts} attempts): ${f.error}`);
      const suppressed = await suppressedDocuments(ctx.sql);
      if (suppressed.length) {
        console.log("suppressed facts/relations about the owner (the owner did not write the document):");
        for (const s of suppressed) console.log(`  ${s.documentId} ${String(s.count).padStart(3)}  ${s.title ?? "(untitled)"} [${s.author}]`);
      }
    });
  });
```
and add after the `verify-fact` command:
```ts
program
  .command("set-author <documentId> <author>")
  .description("Change who wrote a document (owner, other, unknown) and redo the facts and relationships it produced")
  .action(async (documentId: string, authorArg: string) => {
    const { setAuthor } = await import("./ingest/set-author.js");
    const author = parseAuthor(authorArg);
    await withCtx(async (ctx) => {
      const r = await setAuthor(ctx, documentId, author);
      console.log(`${r.documentId}: author ${r.previous} -> ${r.author}`);
      if (!r.reresolved) return void console.log("  not resolved yet; the new author applies when ingestion reaches the resolve stage");
      for (const f of r.removedFacts) console.log(`  removed fact  ${f.predicate}: ${f.objectText}`);
      for (const e of r.removedEdges) console.log(`  removed edge  ${e.fromName} -${e.type}-> ${e.toName}`);
      for (const f of r.keptVerified) console.log(`  kept fact     ${f.predicate}: ${f.objectText} (you verified it; id ${f.id})`);
      for (const id of r.restoredFacts) console.log(`  restored fact ${id} (it had been superseded by a removed fact)`);
      console.log(`  ${r.removedFacts.length} facts and ${r.removedEdges.length} edges removed; ${r.suppressedSelfItems} items about the owner suppressed`);
    });
  });
```
(`parseAuthor` is already imported from Task 2. `withCtx` closes `ctx.obsidian`, which flushes the mirror refresh that `setAuthor` scheduled.)

- [ ] **Step 6: README**

In `README.md`, in the `## Commands` code block, replace the `ingest` line with
```
npm run brain -- ingest <file|dir|url|-> [--kind note] [--author owner|other|unknown] [--title T] [--occurred-at 2026-01-01] [--meta k=v] [--until chunked]
```
and add after the `facts [--all]` line:
```
npm run brain -- set-author <document-id> <owner|other|unknown>
```
Replace the `brain_ingest` bullet under `## MCP` with:
```markdown
- `brain_ingest`: save text such as a note, pasted article or conversation (a URL can be recorded as its origin, not fetched). Pass `author: "other"` for anything you did not write.
```
After the paragraph that starts "Facts written by an agent are unverified", add:
```markdown
Every document records who wrote it: `owner`, `other` or `unknown`. Only documents you wrote produce facts about you or relationships from you; for any other document the extractor's statements about you are kept in its stored extraction but not written, and `brain status` / `brain_status` show how many per document. Without `--author` (CLI) or `author` (MCP), resume, note, conversation and paste default to `owner`; news, paper, job_description and email to `other`; anything else to `unknown`. If someone else's post was saved as yours, run `npm run brain -- set-author <document-id> other`: it removes the facts and relationships that document produced (facts you verified are kept and listed), applies the rule again and refreshes the Obsidian mirror.
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/render.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/set-author.test.ts test/integration/mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suites and typecheck**

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green. No eval run (no retrieval change).

- [ ] **Step 9: Commit**

```bash
git add src/ingest/set-author.ts src/cli.ts src/mcp/server.ts src/mcp/render.ts README.md test/integration/set-author.test.ts test/unit/render.test.ts test/integration/mcp-server.test.ts
git commit -m "brain set-author re-resolves a document under its new author; status shows suppressed counts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Supersession by the extractor for single-valued predicates

**Files:**
- Modify: `supabase/migrations/20261001000009_author.sql` (insert `brain.fact_effective_from` before `commit;`)
- Modify: `src/config.ts` (`singleValuedPredicates`)
- Create: `src/graph/supersede.ts` (`linkSupersession`, `supersedeByExtraction`)
- Modify: `src/graph/facts.ts` (`supersedeFact` uses `linkSupersession`)
- Modify: `src/ingest/stages/resolve.ts` (facts loop)
- Modify: `README.md`
- Create: `test/integration/supersession.test.ts`
- Modify: `test/integration/facts.test.ts`

How `brain_supersede_fact` does it today (`supersedeFact`): inserts the new value, revives an earlier row instead of making a cycle, then sets `superseded_by` and `valid_to = coalesce(valid_to, current_date)` on the old row. That last step becomes `linkSupersession`, shared by both paths, which also records the old `valid_to` in `fact_events` so `undoResolution` can restore it. It lives in a new `src/graph/supersede.ts` because `facts.ts` imports `normalizePredicate` from `resolve.ts`; putting the helper in `facts.ts` would make `resolve.ts` and `facts.ts` import each other.

Rule (spec §4.4, decision 7): for an owner document's fact whose predicate is in `config.singleValuedPredicates`, every current fact with the same predicate and a different value (case-insensitive) whose effective date is not later than the new fact's is superseded by it. Effective date = `valid_from`, else the source document's `occurred_at`, else its `ingested_at`, else (hand-added facts) the fact's `created_at` (`brain.fact_effective_from`). When a current fact is **newer** than the incoming one (an older note resolved later, e.g. after `set-author`), the incoming fact is inserted already superseded by the newest such fact, so the predicate never ends up with two current values; the spec's "otherwise it inserts without superseding" would leave two. Every supersession is logged.

- [ ] **Step 1: Write the failing tests**

`test/integration/supersession.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { setAuthor } from "../../src/ingest/set-author.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

function fact(predicate: string, object_text: string, quote: string) {
  return { predicate, object_text, object_key: null, confidence: 0.9, valid_from: null, valid_to: null, quote };
}
/** One fact per note, chosen by the note's text. */
const factsByText: Record<string, ReturnType<typeof fact>> = {
  "I live in Austin.": fact("lives_in", "Austin", "I live in Austin"),
  "I moved to Denver.": fact("lives_in", "Denver", "I moved to Denver"),
  "I know Python.": fact("skill", "Python", "I know Python"),
  "I know SQL.": fact("skill", "SQL", "I know SQL"),
};
const ctx = fakeCtx(sql, ({ system, user }) => {
  if (system === SUMMARY_SYSTEM) return { title: "Note", summary_line: "A note.", summary: "A note.", occurred_at: null };
  const key = Object.keys(factsByText).find((k) => user.includes(k));
  return { entities: [], relations: [], facts_about_self: key ? [factsByText[key]] : [] };
});

async function ownerNote(text: string, occurredAt: string): Promise<string> {
  return (await ingest(ctx, { text, sourceKind: "note", occurredAt: new Date(occurredAt) })).id;
}

async function factsFor(predicate: string) {
  return sql<{ id: string; object_text: string; superseded_by: string | null; valid_to: string | null }[]>`
    select id, object_text, superseded_by, valid_to::text as valid_to from brain.facts where predicate = ${predicate} order by created_at, id`;
}
const current = (rows: { object_text: string; superseded_by: string | null }[]) =>
  rows.filter((r) => r.superseded_by === null).map((r) => r.object_text).sort();
const events = () =>
  sql<{ fact_id: string; event: string; by: string; document_id: string | null; superseded_by: string | null }[]>`
    select fact_id, event, by, document_id, detail->>'superseded_by' as superseded_by from brain.fact_events order by id`;

describe("supersession by the extractor", () => {
  it("a newer owner note supersedes a single-valued fact and logs it", async () => {
    await ownerNote("I live in Austin.", "2026-06-01T12:00:00Z");
    const denverDoc = await ownerNote("I moved to Denver.", "2026-09-26T12:00:00Z");
    const rows = await factsFor("lives_in");
    expect(current(rows)).toEqual(["Denver"]);
    const austin = rows.find((r) => r.object_text === "Austin")!;
    const denver = rows.find((r) => r.object_text === "Denver")!;
    expect(austin.superseded_by).toBe(denver.id);
    expect(austin.valid_to).toBe("2026-09-26");
    expect(await events()).toEqual([{ fact_id: austin.id, event: "superseded", by: "extractor:fake", document_id: denverDoc, superseded_by: denver.id }]);
  });

  it("multi-valued predicates always add", async () => {
    await ownerNote("I know Python.", "2026-06-01T12:00:00Z");
    await ownerNote("I know SQL.", "2026-09-26T12:00:00Z");
    expect(current(await factsFor("skill"))).toEqual(["Python", "SQL"]);
    expect(await events()).toEqual([]);
  });

  it("an older note resolved later does not replace the newer value", async () => {
    await ownerNote("I moved to Denver.", "2026-09-26T12:00:00Z");
    await ownerNote("I live in Austin.", "2026-06-01T12:00:00Z");
    const rows = await factsFor("lives_in");
    expect(current(rows)).toEqual(["Denver"]);
    const austin = rows.find((r) => r.object_text === "Austin")!;
    const denver = rows.find((r) => r.object_text === "Denver")!;
    expect(austin.superseded_by).toBe(denver.id);
    expect((await events()).map((e) => [e.event, e.fact_id])).toEqual([["superseded", austin.id]]);
  });

  it("repeating the current value supersedes nothing", async () => {
    await ownerNote("I moved to Denver.", "2026-09-26T12:00:00Z");
    await ownerNote("I moved to Denver. Still here.", "2026-09-30T12:00:00Z");
    expect(current(await factsFor("lives_in"))).toEqual(["Denver", "Denver"]);
    expect(await events()).toEqual([]);
  });

  it("undoing the newer note makes the older value current again, as it was", async () => {
    await ownerNote("I live in Austin.", "2026-06-01T12:00:00Z");
    const denverDoc = await ownerNote("I moved to Denver.", "2026-09-26T12:00:00Z");
    const before = await factsFor("lives_in");
    const austin = before.find((r) => r.object_text === "Austin")!;
    const denver = before.find((r) => r.object_text === "Denver")!;
    const r = await setAuthor(ctx, denverDoc, "other");
    expect(r.restoredFacts).toEqual([austin.id]);
    expect(await factsFor("lives_in")).toEqual([{ id: austin.id, object_text: "Austin", superseded_by: null, valid_to: null }]);
    expect((await events()).map((e) => [e.event, e.fact_id])).toEqual([
      ["superseded", austin.id],
      ["restored", austin.id],
      ["removed", denver.id],
    ]);
  });
});
```

Add to `test/integration/facts.test.ts` inside `describe("facts", ...)`:
```ts
  it("logs a supersession by the owner to fact_events", async () => {
    const { id: a } = await addFact(sql, { predicate: "lives_in", objectText: "Austin", by: "frank" });
    const b = await supersedeFact(sql, a, { objectText: "Denver", by: "agent:test" });
    const rows = await sql<{ fact_id: string; event: string; by: string; document_id: string | null; superseded_by: string; previous: string | null }[]>`
      select fact_id, event, by, document_id, detail->>'superseded_by' as superseded_by, detail->>'previous_valid_to' as previous
      from brain.fact_events`;
    expect(rows).toEqual([{ fact_id: a, event: "superseded", by: "agent:test", document_id: null, superseded_by: b, previous: null }]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/supersession.test.ts test/integration/facts.test.ts`
Expected: FAIL: both `lives_in` facts stay current; no `fact_events` rows.

- [ ] **Step 3: Add the effective-date function to the migration**

In `supabase/migrations/20261001000009_author.sql`, insert before the final `commit;`:
```sql
-- (Task 7) The date a fact holds from, for deciding which of two single-valued facts is newer: its valid_from,
-- else its source document's occurred_at, else when that document was ingested, else (facts added by hand,
-- which have no source document) when the fact was recorded.
create or replace function brain.fact_effective_from(p_fact uuid) returns date
language sql stable as $$
  select coalesce(f.valid_from, d.occurred_at::date, d.ingested_at::date, f.created_at::date)
  from brain.facts f
  left join brain.chunks c on c.id = f.source_chunk_id
  left join brain.documents d on d.id = c.document_id
  where f.id = p_fact;
$$;
```

- [ ] **Step 4: Config**

In `src/config.ts`, add after `authorDefaults`:
```ts
  /** Predicates that hold one current value: a newer statement in an owner document supersedes the older (spec §4.4). */
  singleValuedPredicates: ["lives_in", "visa_status", "targeting_role", "pursuing_degree", "employment_status", "current_employer", "phone", "email"],
```

- [ ] **Step 5: Write `src/graph/supersede.ts`**

```ts
import type postgres from "postgres";
import type { Db } from "../db.js";

/**
 * Marks `oldId` superseded by `newId` and logs it to brain.fact_events with the valid_to the old fact had,
 * so undoResolution can make it current again exactly as it was. The old fact's valid_to becomes `endsOn`
 * (an ISO date) when it had none, or today when `endsOn` is null. Shared by supersedeFact (brain_supersede_fact)
 * and supersedeByExtraction.
 */
export async function linkSupersession(
  tx: postgres.TransactionSql,
  input: { oldId: string; newId: string; by: string; documentId: string | null; endsOn: string | null },
): Promise<void> {
  const [old] = await tx<{ valid_to: string | null }[]>`select valid_to::text as valid_to from brain.facts where id = ${input.oldId}`;
  await tx`
    update brain.facts
    set superseded_by = ${input.newId}, valid_to = coalesce(valid_to, ${input.endsOn}::date, current_date)
    where id = ${input.oldId}`;
  await tx`
    insert into brain.fact_events (fact_id, event, by, document_id, detail)
    values (${input.oldId}, 'superseded', ${input.by}, ${input.documentId},
            ${tx.json({ superseded_by: input.newId, previous_valid_to: old?.valid_to ?? null } as postgres.JSONValue)})`;
}

/**
 * After resolve inserts `factId` (a single-valued predicate from an owner document): every current fact with
 * the same subject and predicate, a different value (case-insensitive) and an effective date not later than
 * the new fact's is superseded by it. If a current fact is newer, the new fact is itself superseded by the
 * newest one, so the predicate keeps exactly one current value whatever order documents are resolved in.
 */
export async function supersedeByExtraction(
  sql: Db,
  input: { factId: string; subjectId: string; predicate: string; objectText: string; by: string; documentId: string },
): Promise<{ superseded: string[]; supersededBy: string | null }> {
  return sql.begin(async (tx) => {
    const [mine] = await tx<{ eff: string }[]>`select brain.fact_effective_from(${input.factId})::text as eff`;
    const others = await tx<{ id: string; eff: string; not_newer: boolean }[]>`
      select f.id,
             brain.fact_effective_from(f.id)::text as eff,
             brain.fact_effective_from(f.id) <= brain.fact_effective_from(${input.factId}) as not_newer
      from brain.facts f
      where f.subject_id = ${input.subjectId}
        and f.predicate = ${input.predicate}
        and f.superseded_by is null
        and (f.valid_to is null or f.valid_to >= current_date)
        and f.id <> ${input.factId}
        and lower(f.object_text) <> lower(${input.objectText})
      order by brain.fact_effective_from(f.id) desc, f.created_at desc
      for update`;
    const superseded: string[] = [];
    for (const o of others.filter((x) => x.not_newer)) {
      await linkSupersession(tx, { oldId: o.id, newId: input.factId, by: input.by, documentId: input.documentId, endsOn: mine.eff });
      superseded.push(o.id);
    }
    const newest = others.find((x) => !x.not_newer) ?? null;
    if (newest) {
      await linkSupersession(tx, { oldId: input.factId, newId: newest.id, by: input.by, documentId: input.documentId, endsOn: newest.eff });
    }
    return { superseded, supersededBy: newest?.id ?? null };
  });
}
```

- [ ] **Step 6: `supersedeFact` reuses `linkSupersession`**

In `src/graph/facts.ts`, add `import type postgres from "postgres";` and `import { linkSupersession } from "./supersede.js";`, and replace `supersedeFact` with:
```ts
/** Replaces a fact's value. The old fact is kept and points at the new one; the change is logged to fact_events. */
export async function supersedeFact(sql: Db, factId: string, input: { objectText: string; by: string; validFrom?: Date | null }): Promise<string> {
  const objectText = cleanValue(input.objectText);
  if (!UUID.test(factId)) throw new Error(`Fact ${factId} not found`);
  const [old] = await sql<{ subject_id: string; predicate: string; superseded_by: string | null }[]>`
    select subject_id, predicate, superseded_by from brain.facts where id = ${factId}`;
  if (!old) throw new Error(`Fact ${factId} not found`);
  if (old.superseded_by) throw new Error(`Fact ${factId} is already superseded by ${old.superseded_by}`);
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; superseded_by: string | null }[]>`
      insert into brain.facts (subject_id, predicate, object_text, confidence, verified, verified_by, valid_from)
      values (${old.subject_id}, ${old.predicate}, ${objectText}, 1, false, ${input.by}, ${input.validFrom ?? null})
      on conflict (subject_id, predicate, object_text, coalesce(source_chunk_id, '00000000-0000-0000-0000-000000000000'::uuid))
      do update set created_at = brain.facts.created_at
      returning id, superseded_by`;
    // The conflict clause hands back an existing row with the same value.
    if (row.id === factId) throw new Error("New value equals the current value");
    if (row.superseded_by) {
      // Returning to an earlier value: revive that row rather than pointing the chain back at it (a cycle).
      // It comes back unverified: verification is a deliberate owner action an agent's correction must not inherit.
      await tx`
        update brain.facts
        set superseded_by = null, valid_to = null, verified = false, verified_by = ${input.by},
            valid_from = coalesce(${input.validFrom ?? null}::date, valid_from)
        where id = ${row.id}`;
      await tx`
        insert into brain.fact_events (fact_id, event, by, document_id, detail)
        values (${row.id}, 'restored', ${input.by}, null, ${tx.json({ revived: true } as postgres.JSONValue)})`;
    }
    await linkSupersession(tx, { oldId: factId, newId: row.id, by: input.by, documentId: null, endsOn: null });
    return row.id;
  });
}
```

- [ ] **Step 7: Resolve supersedes**

In `src/ingest/stages/resolve.ts`, add `import { supersedeByExtraction } from "../../graph/supersede.js";`, add near the other module constants:
```ts
const SINGLE_VALUED = new Set<string>(config.singleValuedPredicates);
```
and replace the owner facts loop inside `runResolve` (the `for (const f of payload.facts_about_self) { ... }` after the `if (!ownerWrote) { ... continue; }` block) with:
```ts
    for (const f of payload.facts_about_self) {
      const loc = evidenceFor(f.quote);
      const objectNode = f.object_key ? keyToNode.get(f.object_key) ?? null : null;
      const predicate = normalizePredicate(f.predicate);
      const [inserted] = await sql<{ id: string }[]>`
        insert into brain.facts (subject_id, predicate, object_text, object_node_id, confidence, source_chunk_id, verified_by, valid_from, valid_to)
        values (${self.id}, ${predicate}, ${f.object_text}, ${objectNode}, ${f.confidence},
                ${loc?.chunkId ?? ex.section_chunk_id}, ${"extractor:" + ctx.llm.model}, ${dateOrNull(f.valid_from)}, ${dateOrNull(f.valid_to)})
        on conflict do nothing
        returning id`;
      // A single-valued predicate holds one current value: the newer statement supersedes the older (spec §4.4).
      if (inserted && SINGLE_VALUED.has(predicate)) {
        await supersedeByExtraction(sql, {
          factId: inserted.id, subjectId: self.id, predicate, objectText: f.object_text,
          by: "extractor:" + ctx.llm.model, documentId,
        });
      }
    }
```

- [ ] **Step 8: README**

In `README.md`, append to the paragraph added in Task 6:
```markdown
Single-valued facts (`lives_in`, `visa_status`, `targeting_role`, `pursuing_degree`, `employment_status`, `current_employer`, `phone`, `email`) keep one current value: when a document of yours states a different value dated no earlier than the current one, the old fact is superseded; an older statement resolved later is recorded as already superseded. Every supersession, restoration and removal is logged in `brain.fact_events`.
```

- [ ] **Step 9: Run the tests**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/supersession.test.ts test/integration/facts.test.ts test/integration/undo-resolution.test.ts test/integration/mcp-server.test.ts`
Expected: PASS. The existing `facts.test.ts` and MCP supersede tests are unchanged and still pass. `undo-resolution.test.ts` "makes a fact current again" still expects `valid_to: null`: its referrer was linked by a direct `update`, so it has no `superseded` event and the fallback is null.

- [ ] **Step 10: Full suites, typecheck, apply to eval**

Run:
```bash
npm run typecheck && npm run test:unit && npm run test:int
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20261001000009_author.sql
```
Expected: all green; the migration re-applies cleanly (`NOTICE ... already exists, skipping` for the table and indexes, `CREATE FUNCTION` for the new function). No eval run (no retrieval change).

- [ ] **Step 11: Commit**

```bash
git add supabase/migrations/20261001000009_author.sql src/config.ts src/graph/supersede.ts src/graph/facts.ts src/ingest/stages/resolve.ts README.md test/integration/supersession.test.ts test/integration/facts.test.ts
git commit -m "Extractor supersedes single-valued facts from owner documents; every supersession is logged

supersedeFact and the extractor share linkSupersession, which records the old valid_to so undo can
restore it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Place aliases (roadmap 8b)

**Files:**
- Modify: `supabase/migrations/20261001000009_author.sql` (insert `brain.place_short_alias` and the backfill before `commit;`)
- Modify: `src/ingest/stages/resolve.ts` (`placeShortAlias`, `resolveEntity`)
- Modify: `test/integration/stages-resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/integration/stages-resolve.test.ts`, change the resolve import to
```ts
import { runResolve, placeShortAlias } from "../../src/ingest/stages/resolve.js";
```
add `import { detectEntities } from "../../src/retrieve/entities.js";` and add at the end of the file:
```ts
describe("runResolve place aliases", () => {
  it("gives a place named 'City, Region' the city as an alias, so a query naming only the city finds it", async () => {
    await ingestWith({ entities: [entity("t", "place", "Toronto, Canada")], relations: [], facts_about_self: [] }, "I lived in Toronto, Canada for two years.");
    const [node] = await sql<{ aliases: string[] }[]>`select aliases from brain.nodes where canonical_name = 'toronto canada'`;
    expect(node.aliases).toEqual(["toronto"]);
    const found = await detectEntities(sql, "tell me about my time in toronto");
    expect(found.map((e) => e.name)).toContain("Toronto, Canada");
  });

  it("adds the alias once to an existing place matched by its full name", async () => {
    await sql`insert into brain.nodes (type, name, canonical_name) values ('place', 'Toronto, Canada', 'toronto canada')`;
    await ingestWith({ entities: [entity("t", "place", "Toronto, Canada")], relations: [], facts_about_self: [] }, "Toronto, Canada again.");
    await ingestWith({ entities: [entity("t", "place", "Toronto, Canada")], relations: [], facts_about_self: [] }, "And Toronto, Canada once more.");
    const [node] = await sql<{ aliases: string[] }[]>`select aliases from brain.nodes where canonical_name = 'toronto canada'`;
    expect(node.aliases).toEqual(["toronto"]);
  });

  it("does not add the alias to other node types", async () => {
    await ingestWith({ entities: [entity("o", "organization", "Acme, Inc.")], relations: [], facts_about_self: [] }, "Acme, Inc. is a company.");
    const [node] = await sql<{ aliases: string[] }[]>`select aliases from brain.nodes where canonical_name = 'acme inc'`;
    expect(node.aliases).toEqual([]);
  });

  it("agrees with brain.place_short_alias, which backfills existing place nodes", async () => {
    const names = ["Toronto, Canada", "Austin, TX", "Washington, D.C., USA", "St. John's, Newfoundland", "Paris", ", France", "Toronto,"];
    for (const name of names) {
      const [row] = await sql<{ a: string | null }[]>`select brain.place_short_alias(${name}) as a`;
      expect([name, row.a]).toEqual([name, placeShortAlias(name)]);
    }
    expect(placeShortAlias("Toronto, Canada")).toBe("toronto");
    expect(placeShortAlias("Paris")).toBeNull();
    expect(placeShortAlias("Toronto,")).toBeNull();
  });
});
```
(`entity` and `ingestWith` are the helpers already defined in this file.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/stages-resolve.test.ts`
Expected: FAIL: `placeShortAlias` is not exported; the node's aliases are `[]`; `brain.place_short_alias` does not exist.

- [ ] **Step 3: Migration**

In `supabase/migrations/20261001000009_author.sql`, insert before the final `commit;`:
```sql
-- (Task 8) A place named "City, Region" also answers to the city alone ("Toronto, Canada" -> "toronto"), so a
-- query that names only the city resolves it (entity detection matches canonical aliases).
-- KEEP IN SYNC with placeShortAlias in src/ingest/stages/resolve.ts; test/integration/stages-resolve.test.ts compares them.
create or replace function brain.place_short_alias(name text) returns text
language sql immutable parallel safe as $$
  select case
    when position(',' in name) > 1
     and brain.canonical_text(split_part(name, ',', 1)) <> ''
     and brain.canonical_text(split_part(name, ',', 1)) <> brain.canonical_text(name)
    then brain.canonical_text(split_part(name, ',', 1))
  end;
$$;

update brain.nodes
set aliases = array_append(aliases, brain.place_short_alias(name)), updated_at = now()
where type = 'place'
  and brain.place_short_alias(name) is not null
  and not (brain.place_short_alias(name) = any (aliases));
```

- [ ] **Step 4: Resolve**

In `src/ingest/stages/resolve.ts`, add above `resolveEntity`:
```ts
/**
 * "Toronto, Canada" -> "toronto": a place named "City, Region" is also found by the city alone. Null when the
 * name has no comma after its first character or the part before it adds nothing. Mirrored by
 * brain.place_short_alias (migration 009), which backfills place nodes created before this existed.
 */
export function placeShortAlias(name: string): string | null {
  const comma = name.indexOf(",");
  if (comma <= 0) return null;
  const head = canonicalName(name.slice(0, comma));
  return head && head !== canonicalName(name) ? head : null;
}
```
Replace `resolveEntity` with:
```ts
async function resolveEntity(
  sql: Db,
  entity: Extraction["entities"][number],
  vector: number[],
  knownTypes: Set<string>,
  model: string,
): Promise<string> {
  const type = knownTypes.has(entity.type) ? entity.type : "concept";
  const baseProps: Record<string, unknown> = knownTypes.has(entity.type) ? {} : { untyped_hint: entity.untyped_hint ?? entity.type };
  const canonical = canonicalName(entity.name);
  const shortAlias = type === "place" ? placeShortAlias(entity.name) : null;
  // New aliases may match an existing canonical name only when the new name is a single token
  // ("Acme" with alias "Acme Corp"); a multi-token name's aliases are too ambiguous ("Priya").
  const aliasCanonicals =
    canonical.split(" ").length === 1 ? entity.aliases.map(canonicalName).filter((a) => a && a !== canonical) : [];

  const [exact] = await sql<{ id: string }[]>`select id from brain.nodes where type = ${type} and canonical_name = ${canonical}`;
  if (exact) {
    if (shortAlias) {
      await sql`
        update brain.nodes set aliases = array_append(aliases, ${shortAlias}::text), updated_at = now()
        where id = ${exact.id} and not (${shortAlias}::text = any (aliases))`;
    }
    return canonicalId(sql, exact.id);
  }

  // Alias path: match on the new entity's own canonical name only. Never on alias-to-alias overlap.
  const aliasRows = await sql<{ id: string }[]>`
    select id from brain.nodes
    where type = ${type}
      and (${canonical} = any(aliases) or canonical_name = any(${aliasCanonicals}::text[]))
    order by created_at, id`;
  const aliasMatches: string[] = [];
  for (const row of aliasRows) {
    const id = await canonicalId(sql, row.id);
    if (!aliasMatches.includes(id)) aliasMatches.push(id);
  }
  if (aliasMatches.length === 1) return aliasMatches[0];

  const vec = toVector(vector);
  let decision: Decision;
  if (aliasMatches.length > 1) {
    // Ambiguous: several distinct nodes answer to this name. Create and flag against the oldest.
    decision = { action: "create", possibleDuplicateOf: aliasMatches[0] };
  } else {
    const candidates = await sql<{ id: string; similarity: number; lexical: number }[]>`
      select id, 1 - (name_embedding <=> ${vec}::vector) as similarity,
             extensions.similarity(canonical_name, ${canonical}) as lexical
      from brain.nodes where type = ${type} and name_embedding is not null
      order by name_embedding <=> ${vec}::vector limit 3`;
    const vectorDecision = decide(candidates.map((c) => ({ id: c.id, similarity: Number(c.similarity) })));
    decision = vectorDecision;
    if (vectorDecision.action === "match" && LEXICALLY_CHECKED_TYPES.has(type)) {
      const matched = candidates.find((c) => c.id === vectorDecision.nodeId)!;
      // People and organizations with close embeddings but different names are often different
      // entities; merge only with lexical support, otherwise create and flag.
      if (Number(matched.lexical) < config.resolution.lexicalThreshold) {
        decision = { action: "create", possibleDuplicateOf: matched.id };
      }
    }
    if (decision.action === "match") return canonicalId(sql, decision.nodeId);
  }

  const props = decision.possibleDuplicateOf ? { ...baseProps, possible_duplicate_of: decision.possibleDuplicateOf } : baseProps;
  const storedAliases = [...new Set([...entity.aliases.map(canonicalName), ...(shortAlias ? [shortAlias] : [])])].filter((a) => a && a !== canonical);
  const [created] = await sql<{ id: string }[]>`
    insert into brain.nodes (type, name, canonical_name, aliases, properties, name_embedding, verified_by)
    values (${type}, ${entity.name}, ${canonical}, ${storedAliases}::text[], ${sql.json(props as postgres.JSONValue)}, ${vec}::vector, ${"extractor:" + model})
    on conflict (type, canonical_name) do update set updated_at = now()
    returning id`;
  // A concurrent or earlier insert may own this canonical name, and it may since have been merged.
  return canonicalId(sql, created.id);
}
```

- [ ] **Step 5: Run the tests**

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/stages-resolve.test.ts test/integration/search.test.ts test/unit/entities.test.ts`
Expected: PASS. If the SQL and TS disagree on `St. John's, Newfoundland`, compare `brain.canonical_text` with `canonicalName` (both drop apostrophes, then squash every other non-alphanumeric run to one space).

- [ ] **Step 6: Full suites, typecheck, apply to eval, eval**

Run:
```bash
npm run typecheck && npm run test:unit && npm run test:int
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -v ON_ERROR_STOP=1 -f supabase/migrations/20261001000009_author.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "select name, aliases from brain.nodes where type = 'place' order by name"
npm run eval:run
```
Expected: all green; every place node whose name has a comma now lists the part before it in `aliases`; eval deltas at or above 0, no `GATE:` lines (graph questions can only gain entity matches).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261001000009_author.sql src/ingest/stages/resolve.ts test/integration/stages-resolve.test.ts
git commit -m "Place nodes named \"City, Region\" also answer to the city; backfill existing places

Eval vs baseline: recall@10 <delta>, mrr <delta>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Eval fixtures with authors, attribution items, and the attribution count (roadmap 8)

**Files:**
- Modify: `src/eval/run.ts` (`splitFrontMatter`, `ingestCorpus`, `attributionLeaks`, `attributionGate`, `EvalRun.attribution`)
- Modify: `src/cli.ts` (`eval run` prints and gates attribution)
- Create: `eval/corpus/note--databricks-cost-governance.md`, `eval/corpus/email--recruiter-intro.md`, `eval/corpus/note--moved-to-denver.md`
- Modify: `eval/golden.jsonl`, `eval/baseline.json`
- Create: `test/unit/eval-attribution.test.ts`, `test/unit/golden-fixtures.test.ts`, `test/integration/eval-attribution.test.ts`

The attribution metric is small enough for this phase: one SQL count over the whole eval database (facts about the owner whose source chunk, and edges from the owner whose evidence chunk, belong to a document with `author <> 'owner'`), printed by `eval run` and failing `--gate` when non-zero. It is kept out of `Report` so `eval/baseline.json`'s schema does not change. Phase 6 task 5 only has to break it down per attribution item.

The existing fixtures say nothing about where the owner lives: the interview-prep conversation has "Austin works for me" (a location the owner accepts), not `lives_in`. So `note--moved-to-denver.md` adds a `lives_in` value but supersedes nothing in the corpus; supersession is proven by `supersession.test.ts` (Task 7), and this fixture gives the eval an owner-written single-valued fact to retrieve.

- [ ] **Step 1: Write the failing unit tests**

`test/unit/eval-attribution.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { splitFrontMatter, attributionGate } from "../../src/eval/run.js";

describe("splitFrontMatter", () => {
  it("reads the author and strips the block", () => {
    expect(splitFrontMatter("---\nauthor: other\n---\n# Title\n\nBody.\n")).toEqual({ author: "other", body: "# Title\n\nBody.\n" });
  });
  it("leaves text without front matter unchanged", () => {
    expect(splitFrontMatter("# Title\n---\nnot front matter\n")).toEqual({ author: undefined, body: "# Title\n---\nnot front matter\n" });
  });
  it("accepts quoted values, CRLF line ends and other keys", () => {
    expect(splitFrontMatter('---\r\ntags: x\r\nauthor: "Owner"\r\n---\r\nText')).toEqual({ author: "owner", body: "Text" });
  });
  it("rejects an author outside owner, other and unknown", () => {
    expect(() => splitFrontMatter("---\nauthor: me\n---\nx")).toThrow(/author must be one of/);
  });
});

describe("attributionGate", () => {
  it("passes at zero and fails otherwise", () => {
    expect(attributionGate({ selfFacts: 0, selfEdges: 0 })).toEqual([]);
    expect(attributionGate({ selfFacts: 2, selfEdges: 1 })).toEqual([
      "attribution: 2 facts about the owner and 1 edges from the owner come from documents the owner did not write; must be 0",
    ]);
  });
});
```

`test/unit/golden-fixtures.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseGolden } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace } from "../../src/eval/run.js";

const golden = async () => parseGolden(await readFile("eval/golden.jsonl", "utf8"));
const fixture = async (origin: string) => splitFrontMatter(await readFile(`eval/corpus/${origin}`, "utf8"));

describe("eval/golden.jsonl against eval/corpus", () => {
  it("every quote appears verbatim in its fixture once front matter is stripped", async () => {
    for (const item of await golden()) {
      for (const e of item.expected) {
        if (!e.origin || !e.quote) continue;
        const { body } = await fixture(e.origin);
        expect([item.id, normalizeWhitespace(body).includes(normalizeWhitespace(e.quote))]).toEqual([item.id, true]);
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
});
```

- [ ] **Step 2: Write the failing integration test**

`test/integration/eval-attribution.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { attributionLeaks } from "../../src/eval/run.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("attributionLeaks", () => {
  it("counts facts about the owner and edges from the owner whose evidence is in a document the owner did not write", async () => {
    const ctx = fakeCtx(sql);
    const other = await ingest(ctx, { text: "Someone else's post.", sourceKind: "note", author: "other" }, { until: "chunked" });
    const mine = await ingest(ctx, { text: "My own note.", sourceKind: "note" }, { until: "chunked" });
    const chunk = async (documentId: string) =>
      (await sql<{ id: string }[]>`select id from brain.chunks where document_id = ${documentId} and level = 1 limit 1`)[0].id;
    const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
    const [acme] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name) values ('organization', 'Acme', 'acme') returning id`;
    // Written directly, as resolve without the author gate would have written them.
    await sql`insert into brain.facts (subject_id, predicate, object_text, source_chunk_id) values (${self.id}, 'view_on', 'x', ${await chunk(other.id)})`;
    await sql`insert into brain.facts (subject_id, predicate, object_text, source_chunk_id) values (${self.id}, 'lives_in', 'Denver', ${await chunk(mine.id)})`;
    await sql`insert into brain.edges (from_node, to_node, type, evidence_chunk_id) values (${self.id}, ${acme.id}, 'applied_to', ${await chunk(other.id)})`;
    await sql`insert into brain.edges (from_node, to_node, type, evidence_chunk_id) values (${acme.id}, ${self.id}, 'related_to', ${await chunk(other.id)})`;
    expect(await attributionLeaks(sql)).toEqual({ selfFacts: 1, selfEdges: 1 });
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run test/unit/eval-attribution.test.ts test/unit/golden-fixtures.test.ts`
Expected: FAIL: `splitFrontMatter` and `attributionGate` are not exported (the fixture test fails on the same import).

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-attribution.test.ts`
Expected: FAIL: `attributionLeaks` is not exported.

- [ ] **Step 4: Implement in `src/eval/run.ts`**

Add `import { parseAuthor, type Author } from "../ingest/author.js";` to the imports. Add after `kindFromFilename`:
```ts
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
      continue;
    }
    if (kv[1] === "author") author = parseAuthor(kv[2].replace(/^["']|["']$/g, ""));
  }
  return { author, body: text.slice(m[0].length) };
}

export interface AttributionLeaks {
  /** Facts about the owner whose source chunk is in a document the owner did not write. */
  selfFacts: number;
  /** Edges from the owner whose evidence chunk is in a document the owner did not write. */
  selfEdges: number;
}

/** Spec §8.4 attribution: must be 0. Read-only. */
export async function attributionLeaks(sql: Db): Promise<AttributionLeaks> {
  const [row] = await sql<{ facts: number; edges: number }[]>`
    with self as (select id from brain.nodes where is_self)
    select
      (select count(*)::int
         from brain.facts f
         join brain.chunks c on c.id = f.source_chunk_id
         join brain.documents d on d.id = c.document_id
        where f.subject_id = (select id from self) and d.author <> 'owner') as facts,
      (select count(*)::int
         from brain.edges e
         join brain.chunks c on c.id = e.evidence_chunk_id
         join brain.documents d on d.id = c.document_id
        where brain.canonical_node(e.from_node) = (select id from self) and d.author <> 'owner') as edges`;
  return { selfFacts: row.facts, selfEdges: row.edges };
}

export function attributionGate(a: AttributionLeaks): string[] {
  return a.selfFacts + a.selfEdges === 0
    ? []
    : [`attribution: ${a.selfFacts} facts about the owner and ${a.selfEdges} edges from the owner come from documents the owner did not write; must be 0`];
}
```
Replace the `EvalRun` interface with:
```ts
export interface EvalRun {
  results: QuestionResult[];
  report: Report;
  ranks: Record<string, number | null>;
  attribution: AttributionLeaks;
}
```
In `runEval`, replace the final `return` with:
```ts
  return { results, report: summarize(results, config.retrieval.fallbackThreshold), ranks, attribution: await attributionLeaks(ctx.sql) };
```
Replace `ingestCorpus` with:
```ts
/**
 * Ingests every file under dir into the eval database; a file that cannot be stored is logged and skipped.
 * Front matter (`author: other`) is read and stripped before storing. Returns how many failed.
 */
export async function ingestCorpus(ctx: Ctx, dir: string): Promise<number> {
  await assertEvalConnection(ctx.sql);
  const { failed } = await ingestAll(
    ctx,
    await readInput(dir),
    {
      toInput: (r) => {
        const { author, body } = splitFrontMatter(r.text);
        return { text: body, title: r.title, sourceKind: kindFromFilename(basename(r.origin)), author, origin: r.origin, mimeType: r.mimeType };
      },
    },
    {
      done: (r, res) => console.log(`${res.created ? "new" : "dup"} ${res.stage.padEnd(10)} ${r.origin}${res.error ? " ERROR " + res.error : ""}`),
      skip: logSkip,
    },
  );
  return failed.length;
}
```
(`r.title` comes from the first `# ` heading, which `markdownTitle` finds below the front matter.)

- [ ] **Step 5: Print and gate attribution in `eval run`**

In `src/cli.ts`, in the `eval run` action, add `attributionGate` to the dynamic import:
```ts
    const { runEval, attributionGate } = await import("./eval/run.js");
```
Directly after the line `const failures = gateFailures(comparison, { gate: !!opts.gate, accept: !!opts.accept, baselinePath: opts.baseline });`, add:
```ts
      if (opts.gate) failures.push(...attributionGate(run.attribution));
```
Directly after the line that prints `degraded=... latency p50=...`, add:
```ts
        console.log(`attribution  self-facts-from-others=${run.attribution.selfFacts}  self-edges-from-others=${run.attribution.selfEdges}`);
```
Nothing else changes: both existing branches below (with and without a baseline) already print every entry of `failures` as `GATE: ...`, and `--json` output includes `run.attribution` through the `...run` spread.

- [ ] **Step 6: Add the fixtures**

`eval/corpus/note--databricks-cost-governance.md` (written for this repo; a first-person post by someone else):
```markdown
---
author: other
---
# Our Databricks bill tripled and nobody noticed for a month

Posted by Morgan Reyes, data platform lead

I thought moving our pipelines to Databricks would save us money. Instead our monthly bill went from $38,000 to $112,000 in one quarter, and nobody noticed until finance asked.

What went wrong: every team spun up its own all-purpose cluster and left it running overnight. Autoscaling had no upper limit. Nobody tagged clusters, so I could not tell which team spent what.

What I recommend now: put cluster policies in place before the first workload lands, cap autoscaling, set auto-termination to 30 minutes, and require a cost-center tag on every cluster. Review the usage dashboard every Monday.

I have run data platforms for eight years and this was the most expensive lesson of my career. Cost governance is not optional.
```

`eval/corpus/email--recruiter-intro.md` (first-person, by a recruiter; names the owner and says something about him):
```markdown
---
author: other
---
# Intro: Frank Fu for the analytics lead role at Northwind Robotics

From: Sam Okafor, Recruiter, Northwind Robotics
Date: 2026-09-28

Hi Taylor,

I wanted to introduce Frank Fu. I spoke with him last week and I think he is a strong fit for the analytics lead role on your team. He is currently being considered for the role alongside two other finalists, and I have scheduled his panel interview for October 6.

I have placed eleven analysts at Northwind over the past three years, and I prefer to move quickly on candidates like this one.

Best,
Sam
```

`eval/corpus/note--moved-to-denver.md` (owner-written; no front matter, `note` defaults to owner):
```markdown
# Moved to Denver

Date: 2026-09-26

I moved from Austin to Denver this week. My new apartment is in the Highland neighborhood and I am now living in Denver full time. I am still open to hybrid roles, but Denver-based or remote positions are the priority now.
```

- [ ] **Step 7: Add the golden items**

Append to `eval/golden.jsonl`:
```
{"id":"a01","question":"Why did the Databricks bill in the saved post go up so much?","kind":"attribution","expected":[{"origin":"note--databricks-cost-governance.md","quote":"every team spun up its own all-purpose cluster"}],"source":"fixture","approved_at":"2026-10-01"}
{"id":"a02","question":"Who introduced Frank for the analytics lead role at Northwind Robotics?","kind":"attribution","expected":[{"origin":"email--recruiter-intro.md","quote":"He is currently being considered for the role"}],"source":"fixture","approved_at":"2026-10-01"}
{"id":"a03","question":"What does the post recommend for Databricks cost governance?","kind":"attribution","expected":[{"origin":"note--databricks-cost-governance.md","quote":"set auto-termination to 30 minutes"}],"source":"fixture","approved_at":"2026-10-01"}
{"id":"q15","question":"Where do I live now?","kind":"semantic","expected":[{"origin":"note--moved-to-denver.md","quote":"I am now living in Denver full time"}],"source":"fixture","approved_at":"2026-10-01"}
{"id":"n01","question":"How much did I pay for the sushi dinner in Kyoto?","kind":"negative","expected":[],"negative":true,"source":"fixture","approved_at":"2026-10-01"}
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/unit/eval-attribution.test.ts test/unit/golden-fixtures.test.ts test/unit/golden.test.ts test/unit/eval.test.ts`
Expected: PASS.

Run: `bash scripts/prepare-test-db.sh && npx vitest run test/integration/eval-attribution.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm run test:unit && npm run test:int`
Expected: all green.

- [ ] **Step 9: Re-ingest the eval corpus and run the eval**

The documents already in `brain_eval` were extracted with the old prompt and resolved without the gate (for example `email--recruiter-followup-beta-ventures.md`, now `other`, may hold facts about the owner from Jordan's "I"). Recreate the database so every fixture goes through the Phase 2 pipeline. This re-runs summary and extraction for 9 short documents through Claude Code and re-embeds them with Voyage.

Run:
```bash
npm run eval:prepare -- --reset
npm run brain -- eval ingest
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "select title, source_kind, author, metadata->>'suppressed_self_items' as suppressed from brain.documents order by title"
psql postgresql://postgres:postgres@127.0.0.1:55322/brain_eval -c "select predicate, object_text, superseded_by is not null as superseded from brain.facts order by predicate, object_text"
npm run eval:run
```
Expected:
- `eval ingest` prints `new done` for 9 files and exits 0.
- The documents query shows `author = other` for the Databricks note and both emails, `owner` for the conversation and the two other notes.
- The facts query shows no `view_on`, `recommends` or `has_experience_with` about Databricks, nothing from Morgan's or Sam's first person, and a `lives_in | Denver` row.
- `eval run` prints `attribution  self-facts-from-others=0  self-edges-from-others=0`, a line for kind `attribution` (n=3), `negatives n=1`, and "golden set changed since the baseline".
- Review every `worse` line. The corpus was re-extracted, so graph questions (`q07`–`q09`) can move because entities and edges changed, not because retrieval did; explain each in the commit message.

- [ ] **Step 10: Accept the new baseline and check the gate**

Run: `npm run brain -- eval run --accept && npm run eval:gate`
Expected: the baseline is written; the gate prints no `GATE:` lines and exits 0.

- [ ] **Step 11: Commit**

```bash
git add src/eval/run.ts src/cli.ts eval/corpus/note--databricks-cost-governance.md eval/corpus/email--recruiter-intro.md eval/corpus/note--moved-to-denver.md eval/golden.jsonl eval/baseline.json test/unit/eval-attribution.test.ts test/unit/golden-fixtures.test.ts test/integration/eval-attribution.test.ts
git commit -m "Eval: fixtures with author front matter, attribution and negative items, attribution count in eval run and the gate

Corpus re-ingested through the Phase 2 pipeline. Eval vs Phase 1 baseline: recall@10 <delta>, mrr <delta>;
<explain each worse line>. Attribution: 0 self facts, 0 self edges from author: other documents.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Real-base cleanup (roadmap 9; run by the controller, not a subagent)

**Files:** none changed in the repo. Output goes into the PR description.

This is the only step that touches the `postgres` database. Run each command yourself and read its output before the next. Never use `supabase migration up`. Stop and ask the owner if anything below does not match what is expected.

- [ ] **Step 1: Back up the brain schema**

Run:
```bash
ts=$(date +%Y%m%d-%H%M%S)
docker exec supabase_db_brain pg_dump -U postgres -d postgres -n brain -Fc > ~/brain-pre-009-$ts.dump
ls -l ~/brain-pre-009-$ts.dump
docker exec -i supabase_db_brain pg_restore --list < ~/brain-pre-009-$ts.dump | grep -c "TABLE DATA brain"
```
Expected: a dump file of non-trivial size; the table-data count equals the number of tables in `brain` (at least 10). Note the file name for the PR.

- [ ] **Step 2: Record what the Databricks post produced before the change**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select d.id, d.title, d.source_kind, d.ingested_at from brain.documents d
where d.title ilike '%databricks%' or d.raw_content ilike '%databricks%' order by d.ingested_at"
```
Expected: the saved post (a `note`) is listed. Pick its id (if several rows match, read their titles and first lines with `npm run brain -- search "Databricks cost" --kind note` and choose the post; ask the owner if it is not obvious). Then, with that id as `<doc>`:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select f.id, f.predicate, f.object_text, f.verified, f.verified_by from brain.facts f
join brain.chunks c on c.id = f.source_chunk_id where c.document_id = '<doc>' order by f.predicate"
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select e.id, e.type, t.name from brain.edges e join brain.chunks c on c.id = e.evidence_chunk_id
join brain.nodes t on t.id = brain.canonical_node(e.to_node)
where c.document_id = '<doc>' and brain.canonical_node(e.from_node) = (select id from brain.nodes where is_self)"
```
Expected: `view_on`, `recommends` and `has_experience_with` rows, all `verified = false`, and the edge from the owner to the cost-governance concept. **If any of those facts is verified, stop:** undo keeps verified facts by design; ask the owner whether to un-verify it first (`update brain.facts set verified = false where id = ...`) or keep it.

- [ ] **Step 3: Apply migration 009**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20261001000009_author.sql
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select source_kind, author, count(*) from brain.documents group by 1, 2 order by 1, 2"
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "select name, aliases from brain.nodes where type = 'place' and name like '%,%' order by name"
```
Expected: no errors; every `note`/`paste`/`conversation`/`resume` row is `owner`, `news`/`paper`/`job_description`/`email` rows are `other`, the rest `unknown` (the Databricks post is `owner` at this point, as spec §4.5 predicts); place nodes named "City, Region" now carry the city alias (e.g. `toronto` on "Toronto, Canada").

- [ ] **Step 4: Restart long-running servers**

If the MCP HTTP server (`npm run mcp:http`) or a stdio session is running from this checkout, restart it so it runs the Phase 2 code (author on ingest, the gate). Clients reconnect on their next session.

- [ ] **Step 5: Mark the post as someone else's**

Run: `npm run brain -- set-author <doc> other`
Expected output (ids and exact values vary):
```
<doc>: author owner -> other
  removed fact  has_experience_with: Databricks cost governance
  removed fact  recommends: ...
  removed fact  view_on: ...
  removed edge  Frank Fu -<type>-> <cost-governance concept>
  3 facts and 1 edges removed; <n> items about the owner suppressed
```
This calls Voyage once to embed the post's entity names (resolve re-embeds names on every run).

- [ ] **Step 6: Verify**

Run:
```bash
npm run brain -- facts
npm run brain -- facts | grep -iE "view_on|recommends|has_experience_with" || echo "none of the three predicates remain"
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select e.id, e.type, t.name from brain.edges e join brain.nodes t on t.id = brain.canonical_node(e.to_node)
where brain.canonical_node(e.from_node) = (select id from brain.nodes where is_self) and t.name ilike '%cost governance%'"
npm run brain -- status
```
Expected: `brain facts` no longer lists `view_on`, `recommends` or `has_experience_with: Databricks cost governance` (any remaining line for those predicates must come from another document; check its source before accepting); the edge query returns 0 rows; `brain status` lists the post under "suppressed facts/relations about the owner". The Obsidian mirror was refreshed when the command exited (if `OBSIDIAN_VAULT_PATH` is set).

- [ ] **Step 7: Look for other saved posts stored as the owner's**

Run:
```bash
psql postgresql://postgres:postgres@127.0.0.1:55322/postgres -c "
select id, title, source_kind, left(regexp_replace(raw_content, '\s+', ' ', 'g'), 100) as start
from brain.documents where author = 'owner' and source_kind in ('note', 'paste') order by ingested_at"
```
Expected: a list for the owner to review. Do not change any of them yourself; report the list and let the owner say which, if any, need `brain set-author <id> other`. If the experience fact was in fact true of the owner, the owner re-adds it with `brain add-fact` or `brain_add_fact`.

- [ ] **Step 8: PR description**

Paste into the PR: the backup file name, the before-facts from Step 2, the `set-author` output from Step 5, and the full `brain facts` output from Step 6.

---

## Self-review notes

- Spec §4.1 (author field): Task 1 (column, check constraint, `config.authorDefaults`, SQL `default_author` used by the backfill and compared with the config in a test), Task 2 (`--author`, `brain_ingest` `author`, shown in `brain_get_document`, each `brain_search` passage line and the Obsidian document note), Task 6 (`brain set-author`, CLI only).
- Spec §4.2 (prompt): Task 3. `Author:` and `Origin:` are in the header built by `buildExtractionRequests`, which the Batches backfill also uses; the backfill test checks a submitted batch request.
- Spec §4.3 (gate, count, re-resolution): Task 4 (gate after the direction fix; count in `documents.metadata.suppressed_self_items`), Task 5 (`undoResolution` runs at the start of every `runResolve`, so `brain retry` re-runs are clean too), Task 6 (status displays).
- Spec §4.4 (supersession, `fact_events`): Task 1 (table), Task 7 (rule, logging, shared `linkSupersession`).
- Spec §4.5 (cleanup): Task 10.
- Spec §8.4/§8.6 (attribution metric, fixtures): Task 9. Roadmap 8b: Task 8.

Decisions the code forced, relative to the brief:
- **Suppressed items are counted, not marked in the payload** (Task 4 explains): the payload is the raw model output resolve re-reads, and marking it would tie it to the author at the last resolve.
- **`fact_events` has a `detail jsonb` column** beyond `(id, fact_id, event, by, document_id, created_at)`: undo has to restore a superseded fact's previous `valid_to` (both `supersedeFact` and the extractor overwrite it) and match the event to the superseder; neither fits in the listed columns. `fact_id` has no foreign key so the log outlives deleted facts; events are `superseded`, `restored`, `removed`.
- **Verified facts survive undo.** Otherwise a routine `brain retry` or `set-author` would silently discard the owner's verification. `set-author` lists them; Task 10 Step 2 stops if any Databricks fact is verified.
- **An older single-valued fact resolved after a newer one is inserted already superseded by the newer one**, instead of the spec's "inserts without superseding", which would leave two current `lives_in` values after `set-author` re-resolves an older note.
- **Supersession helpers live in a new `src/graph/supersede.ts`**, not `facts.ts`, to avoid a `resolve.ts` ↔ `facts.ts` import cycle (`facts.ts` imports `normalizePredicate` from `resolve.ts`).
- **`runChunk` undoes resolution first.** Re-chunking (`brain retry --skipped` redoes stubbed summaries from `chunked`) deleted chunks under `on delete set null`, leaving facts and edges that no later undo could find. Not in the brief; it is one call and a test, and without it the "facts trace to documents" invariant breaks.
- **Migration file name** is `20261001000009_author.sql` as decided (the roadmap said `20260930000009`). It is idempotent and the documents backfill runs only when the column is first added, so re-applying it never reverts a `set-author`.
- **Attribution metric is in this phase**, as one SQL count reported next to `Report` (not inside it, so `baseline.json`'s schema is unchanged) and enforced by `--gate`. Phase 6 task 5 only needs the per-item breakdown.
- **The Denver fixture supersedes nothing in the corpus**: no existing fixture states `lives_in` ("Austin works for me" is a location the owner accepts). Supersession is proved by `supersession.test.ts`.
- **"Edges from the owner" means `from_node` is the self node after the direction fix.** A relation from someone else to the owner (for example `knows` from the recruiter) is still written; the spec and the brief both say "from". Undirected types such as `knows` can therefore still link the owner to a stranger's document; noted, not changed.

Types and names used across tasks: `Author`/`AUTHORS`/`parseAuthor`/`defaultAuthor` (T1) are used by T2, T3, T6 and T9. `ResolveReport.suppressedSelfItems` (T4) gains `undone: UndoReport` in T5; `setAuthor` (T6) reads both. `UndoReport.restored` and `keptVerified` (T5) are read by T6. `linkSupersession` (T7) writes `detail.previous_valid_to` and `detail.superseded_by`, which `undoResolution` (T5) already reads; until T7, there are no such events and undo falls back to `valid_to = null`. `brain.fact_effective_from` (T7) and `brain.place_short_alias` (T8) are inserted into migration 009 before its `commit;`. `Passage.author` (T2) is required, so `test/unit/eval.test.ts` and `test/unit/render.test.ts` literals are updated in T2 to keep `npm run typecheck` green.

Known limits, not addressed here:
- `set-author` re-applies the stored extraction; it does not re-run extraction under the new prompt. Facts are already gated, but entities extracted under the old pronoun rule (for example the owner as a person entity in a stranger's post) remain as mentions. `brain retry --skipped` style re-extraction per document is a possible follow-up.
- Storing the same text again with a different `author` keeps the stored author (storing is idempotent on content); `set-author` is the way to change it.
- A fact or edge whose chunk was deleted before this phase (null `source_chunk_id`) cannot be found by undo or by the attribution count.
- `current_facts` treats a fact with `valid_to = today` as current; superseded facts are excluded by `superseded_by` regardless, so this does not affect the one-current-value rule.
