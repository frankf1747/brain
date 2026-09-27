# Obsidian Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a read-only markdown mirror of the knowledge graph inside an Obsidian vault so graph view draws nodes, documents and their links.

**Architecture:** `projectObsidian(ctx, { vault, folder })` loads canonical nodes, edges with evidence, mentions, facts and documents; assigns unique note names; renders one note per node and per document plus a README; and syncs the result into `<vault>/<folder>` writing only changed files and deleting only files that carry the `brain_managed: true` marker.

**Tech Stack:** Node `fs/promises`, the existing core (`postgres`, `Ctx`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-obsidian-projection-design.md`
**Prerequisite:** sub-project 1 complete.
**Working directory:** `/Users/frankfu/Documents/GitHub/brain`

---

## File structure

```
src/
  config.ts                MODIFY: obsidianVaultPath, obsidianFolder
  obsidian/vaults.ts       listVaults(): reads Obsidian's vault registry
  obsidian/names.ts        sanitizeName, uniqueNames
  obsidian/load.ts         loadGraph(sql): everything the renderer needs
  obsidian/render.ts       frontmatter, renderNode, renderDocument, renderReadme
  obsidian/write.ts        syncFolder(root, files)
  obsidian/project.ts      projectObsidian(ctx, opts)
  cli.ts                   MODIFY: project-obsidian command
test/unit/{obsidian-names,obsidian-render,obsidian-write,obsidian-vaults}.test.ts
test/integration/obsidian-project.test.ts
test/fixtures/obsidian.json
```

---

### Task 1: Config and vault discovery

**Files:**
- Modify: `src/config.ts`
- Create: `src/obsidian/vaults.ts`, `test/fixtures/obsidian.json`, `test/unit/obsidian-vaults.test.ts`

- [ ] **Step 1: Write the fixture and failing test**

`test/fixtures/obsidian.json`:
```json
{"vaults":{"257e6c459b52dc55":{"path":"/Users/frankfu/Documents/obsidian/MSBA410","ts":1},"cda95dd5fd0856af":{"path":"/Users/frankfu/Documents/Obsidian/General","ts":2,"open":true}}}
```

`test/unit/obsidian-vaults.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listVaults } from "../../src/obsidian/vaults.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("listVaults", () => {
  it("reads the registry and marks the open vault", async () => {
    const vaults = await listVaults(join(here, "..", "fixtures", "obsidian.json"));
    expect(vaults).toEqual([
      { id: "257e6c459b52dc55", path: "/Users/frankfu/Documents/obsidian/MSBA410", name: "MSBA410", open: false },
      { id: "cda95dd5fd0856af", path: "/Users/frankfu/Documents/Obsidian/General", name: "General", open: true },
    ]);
  });
  it("returns an empty list when the registry is missing", async () => {
    expect(await listVaults("/nonexistent/obsidian.json")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- obsidian-vaults`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Add to the `config` object in `src/config.ts`:
```ts
  obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH ?? "/Users/frankfu/Documents/Obsidian/General",
  obsidianFolder: process.env.OBSIDIAN_FOLDER ?? "Brain",
```
and to `.env.example`:
```
OBSIDIAN_VAULT_PATH=/Users/frankfu/Documents/Obsidian/General
OBSIDIAN_FOLDER=Brain
```

`src/obsidian/vaults.ts`:
```ts
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface VaultInfo {
  id: string;
  path: string;
  name: string;
  open: boolean;
}

export const DEFAULT_REGISTRY = join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");

export async function listVaults(registryPath = DEFAULT_REGISTRY): Promise<VaultInfo[]> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw) as { vaults?: Record<string, { path: string; open?: boolean }> };
  return Object.entries(parsed.vaults ?? {}).map(([id, v]) => ({ id, path: v.path, name: basename(v.path), open: Boolean(v.open) }));
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npm run test:unit -- obsidian-vaults && npm run typecheck
git add -A
git commit -m "Obsidian vault registry reader and projection config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Note names

**Files:**
- Create: `src/obsidian/names.ts`, `test/unit/obsidian-names.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/obsidian-names.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { sanitizeName, uniqueNames } from "../../src/obsidian/names.js";

describe("sanitizeName", () => {
  it("removes characters that break file names or wikilinks", () => {
    expect(sanitizeName('Acme: "Q3" [draft] #1 | a/b\\c')).toBe("Acme Q3 draft 1 a b c");
    expect(sanitizeName("   ")).toBe("untitled");
    expect(sanitizeName("ends with dots...")).toBe("ends with dots");
    expect(sanitizeName("x".repeat(200)).length).toBe(120);
  });
});

describe("uniqueNames", () => {
  it("keeps the oldest name plain and suffixes later collisions", () => {
    const m = uniqueNames([
      { id: "bbbbbbbb-1", name: "Acme Corp", createdAt: new Date("2026-02-01") },
      { id: "aaaaaaaa-1", name: "acme corp", createdAt: new Date("2026-01-01") },
      { id: "cccccccc-1", name: "Other", createdAt: new Date("2026-03-01") },
    ]);
    expect(m.get("aaaaaaaa-1")).toBe("acme corp");
    expect(m.get("bbbbbbbb-1")).toBe("Acme Corp (bbbbbbbb)");
    expect(m.get("cccccccc-1")).toBe("Other");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- obsidian-names`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/obsidian/names.ts`:
```ts
/** Safe for macOS, Windows, Obsidian file names and inside [[wikilinks]]. */
export function sanitizeName(s: string): string {
  let out = s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
  if (out.length > 120) out = out.slice(0, 120).trim();
  out = out.replace(/\.+$/, "").trim();
  return out || "untitled";
}

/** Note name per id. Names are compared case-insensitively because macOS file systems usually are. */
export function uniqueNames(items: { id: string; name: string; createdAt: Date }[]): Map<string, string> {
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const key = sanitizeName(it.name).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    sorted.forEach((it, i) => {
      const base = sanitizeName(it.name);
      out.set(it.id, i === 0 ? base : `${base} (${it.id.slice(0, 8)})`);
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npm run test:unit -- obsidian-names
git add -A
git commit -m "Obsidian note naming with collision suffixes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Load the graph

**Files:**
- Create: `src/obsidian/load.ts`, `test/integration/obsidian-load.test.ts`

- [ ] **Step 1: Write the failing test**

`test/integration/obsidian-load.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { loadGraph } from "../../src/obsidian/load.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: "2026-09-01" } : fakeExtraction;

describe("loadGraph", () => {
  it("returns canonical nodes, resolved edges with evidence, mentions, facts and documents", async () => {
    const ctx = fakeCtx(sql, handler);
    const { id } = await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT.", sourceKind: "note" });
    const g = await loadGraph(sql);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["Acme Corp", "Frank Fu"]);
    expect(g.self?.name).toBe("Frank Fu");
    expect(g.edges).toEqual([expect.objectContaining({ type: "applied_to", evidenceDocumentId: id })]);
    expect(g.edges[0].evidence).toContain("Acme Corp");
    expect(g.mentions.some((m) => m.documentId === id)).toBe(true);
    expect(g.facts).toEqual([expect.objectContaining({ predicate: "visa_status", documentId: id, verifiedBy: "extractor:fake" })]);
    expect(g.documents[0]).toEqual(expect.objectContaining({ id, title: "Acme note", sourceKind: "note" }));
    expect(g.documents[0].raw).toContain("F-1 OPT");
  });

  it("excludes merged duplicates and points their edges at the canonical node", async () => {
    const [a] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name) values ('organization','Beta','beta') returning id`;
    const [dup] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name, merged_into) values ('organization','Beta Co','beta co', ${a.id}) returning id`;
    const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
    await sql`insert into brain.edges (from_node, to_node, type) values (${self.id}, ${dup.id}, 'works_at')`;
    const g = await loadGraph(sql);
    expect(g.nodes.find((n) => n.id === dup.id)).toBeUndefined();
    expect(g.edges[0].toNode).toBe(a.id);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:int -- obsidian-load`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/obsidian/load.ts`:
```ts
import type { Db } from "../db.js";

export interface GNode {
  id: string;
  type: string;
  name: string;
  aliases: string[];
  properties: Record<string, unknown>;
  verified: boolean;
  isSelf: boolean;
  createdAt: Date;
}

export interface GEdge {
  id: string;
  fromNode: string;
  toNode: string;
  type: string;
  evidence: string | null;
  evidenceDocumentId: string | null;
}

export interface GMention {
  nodeId: string;
  documentId: string;
}

export interface GFact {
  id: string;
  subjectId: string;
  predicate: string;
  objectText: string;
  objectNodeId: string | null;
  verified: boolean;
  verifiedBy: string | null;
  documentId: string | null;
}

export interface GDocument {
  id: string;
  title: string | null;
  sourceKind: string;
  origin: string | null;
  occurredAt: Date | null;
  ingestedAt: Date;
  summary: string | null;
  raw: string;
}

export interface Graph {
  nodes: GNode[];
  self: GNode | null;
  edges: GEdge[];
  mentions: GMention[];
  facts: GFact[];
  documents: GDocument[];
}

export async function loadGraph(sql: Db): Promise<Graph> {
  const [nodes, edges, mentions, facts, documents] = await Promise.all([
    sql<GNode[]>`
      select id, type, name, aliases, properties, verified, is_self as "isSelf", created_at as "createdAt"
      from brain.nodes where merged_into is null order by type, name`,
    sql<GEdge[]>`
      select e.id, brain.canonical_node(e.from_node) as "fromNode", brain.canonical_node(e.to_node) as "toNode", e.type,
             left(c.content, 200) as evidence, c.document_id as "evidenceDocumentId"
      from brain.edges e left join brain.chunks c on c.id = e.evidence_chunk_id
      where e.valid_to is null or e.valid_to >= current_date
      order by e.type`,
    sql<GMention[]>`
      select distinct brain.canonical_node(m.node_id) as "nodeId", c.document_id as "documentId"
      from brain.mentions m join brain.chunks c on c.id = m.chunk_id`,
    sql<GFact[]>`
      select f.id, f.subject_id as "subjectId", f.predicate, f.object_text as "objectText", f.object_node_id as "objectNodeId",
             f.verified, f.verified_by as "verifiedBy", c.document_id as "documentId"
      from brain.facts f left join brain.chunks c on c.id = f.source_chunk_id
      where f.superseded_by is null and (f.valid_to is null or f.valid_to >= current_date)
      order by f.predicate, f.created_at`,
    sql<GDocument[]>`
      select id, title, source_kind as "sourceKind", origin, occurred_at as "occurredAt", ingested_at as "ingestedAt", summary, raw_content as raw
      from brain.documents order by ingested_at`,
  ]);
  return { nodes, self: nodes.find((n) => n.isSelf) ?? null, edges, mentions, facts, documents };
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npm run test:int -- obsidian-load && npm run typecheck
git add -A
git commit -m "Load the graph for projection with merged nodes resolved

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Render notes

**Files:**
- Create: `src/obsidian/render.ts`, `test/unit/obsidian-render.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/obsidian-render.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { frontmatter, renderNode, renderDocument, renderReadme, type NodeView, type DocView } from "../../src/obsidian/render.js";

describe("frontmatter", () => {
  it("quotes strings, renders lists and dates, skips undefined", () => {
    const fm = frontmatter({ brain_id: "x", aliases: ['a"b', "c: d"], verified: false, when: new Date("2026-09-01T10:00:00Z"), nothing: undefined, tags: ["brain/node/person"] });
    expect(fm).toBe(`---\nbrain_id: "x"\naliases: ["a\\"b", "c: d"]\nverified: false\nwhen: 2026-09-01\ntags: ["brain/node/person"]\n---\n`);
  });
});

const node: NodeView = {
  id: "7b1e0000-0000-0000-0000-000000000000", type: "organization", name: "Acme Corp", noteName: "Acme Corp", aliases: ["acme"],
  properties: { possible_duplicate_of: "ACME Corporation" }, verified: false, isSelf: false,
  edges: [
    { direction: "out", type: "located_in", otherNoteName: "Austin", evidence: "Acme Corp announced … Austin", evidenceDocNoteName: "Acme raises Series B" },
    { direction: "in", type: "applied_to", otherNoteName: "Frank Fu", evidence: null, evidenceDocNoteName: null },
  ],
  mentionedIn: [{ docNoteName: "Acme raises Series B", kind: "news", date: "2026-03-12" }],
  facts: [],
};

describe("renderNode", () => {
  it("writes frontmatter, read-only notice, relationships as wikilinks, mentions and properties", () => {
    const t = renderNode(node);
    expect(t.startsWith("---\n")).toBe(true);
    expect(t).toContain('brain_type: "organization"');
    expect(t).toContain("brain_managed: true");
    expect(t).toContain('tags: ["brain/node/organization", "brain/unverified"]');
    expect(t).toContain("# Acme Corp");
    expect(t).toContain("Read-only");
    expect(t).toContain('- located_in → [[Austin]] · "Acme Corp announced … Austin" ([[Acme raises Series B]])');
    expect(t).toContain("- applied_to ← [[Frank Fu]]");
    expect(t).toContain("- [[Acme raises Series B]] (news, 2026-03-12)");
    expect(t).toContain("- possible_duplicate_of: ACME Corporation");
  });
  it("adds a Facts section for the self node", () => {
    const t = renderNode({ ...node, isSelf: true, name: "Frank Fu", noteName: "Frank Fu", facts: [{ predicate: "visa_status", objectText: "F-1 OPT", verified: false, by: "extractor:opus", docNoteName: "Prep call" }] });
    expect(t).toContain("## Facts");
    expect(t).toContain("- visa_status: F-1 OPT (unverified, extractor:opus, from [[Prep call]])");
  });
});

describe("renderDocument", () => {
  const doc: DocView = {
    id: "3f2a0000-0000-0000-0000-000000000000", noteName: "Acme raises Series B", title: "Acme raises Series B", kind: "news", origin: "https://x.test/a",
    occurredAt: new Date("2026-03-12T00:00:00Z"), ingestedAt: new Date("2026-09-27T00:00:00Z"), summary: "Acme raised $40M.", entityNoteNames: ["Acme Corp", "Beta Ventures"], raw: "Full text here.",
  };
  it("renders metadata, summary, entity links and the raw text", () => {
    const t = renderDocument(doc);
    expect(t).toContain('brain_kind: "news"');
    expect(t).toContain("occurred_at: 2026-03-12");
    expect(t).toContain("**Entities.** [[Acme Corp]] · [[Beta Ventures]]");
    expect(t.trim().endsWith("Full text here.")).toBe(true);
  });
  it("truncates very long raw text with a pointer to the id", () => {
    const t = renderDocument({ ...doc, raw: "y".repeat(250_000) }, 1000);
    expect(t).toContain("truncated");
    expect(t).toContain(doc.id);
    expect(t.length).toBeLessThan(3000);
  });
});

describe("renderReadme", () => {
  it("lists counts and the timestamp", () => {
    const t = renderReadme({ nodes: 5, documents: 2 }, new Date("2026-09-27T12:00:00Z"));
    expect(t).toContain("5 entity notes");
    expect(t).toContain("2026-09-27T12:00:00.000Z");
    expect(t).toContain("path:Brain/nodes/person");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- obsidian-render`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/obsidian/render.ts`:
```ts
type Scalar = string | number | boolean | Date | null | undefined;

function yamlScalar(v: Scalar): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

export function frontmatter(fields: Record<string, Scalar | Scalar[]>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.map(yamlScalar).join(", ")}]` : `${k}: ${yamlScalar(v)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

const NOTICE = "> Read-only. Generated from the knowledge base; edits here are overwritten on the next projection.\n";
const link = (name: string) => `[[${name}]]`;

export interface NodeView {
  id: string;
  type: string;
  name: string;
  noteName: string;
  aliases: string[];
  properties: Record<string, unknown>;
  verified: boolean;
  isSelf: boolean;
  edges: { direction: "out" | "in"; type: string; otherNoteName: string; evidence: string | null; evidenceDocNoteName: string | null }[];
  mentionedIn: { docNoteName: string; kind: string; date: string | null }[];
  facts: { predicate: string; objectText: string; verified: boolean; by: string | null; docNoteName: string | null }[];
}

export function renderNode(n: NodeView): string {
  const tags = [`brain/node/${n.type}`, ...(n.verified ? [] : ["brain/unverified"])];
  const out = [
    frontmatter({ brain_id: n.id, brain_type: n.type, brain_managed: true, aliases: n.aliases, verified: n.verified, tags }),
    `# ${n.name}`,
    "",
    NOTICE,
  ];
  if (n.isSelf) {
    out.push("## Facts");
    out.push(n.facts.length ? n.facts.map((f) => `- ${f.predicate}: ${f.objectText} (${f.verified ? "verified" : `unverified, ${f.by ?? "unknown"}`}${f.docNoteName ? `, from ${link(f.docNoteName)}` : ""})`).join("\n") : "- none yet");
    out.push("");
  }
  out.push("## Relationships");
  out.push(
    n.edges.length
      ? n.edges
          .map((e) => {
            const arrow = e.direction === "out" ? "→" : "←";
            const ev = e.evidence ? ` · "${e.evidence.replace(/\s+/g, " ").trim()}"${e.evidenceDocNoteName ? ` (${link(e.evidenceDocNoteName)})` : ""}` : "";
            return `- ${e.type} ${arrow} ${link(e.otherNoteName)}${ev}`;
          })
          .join("\n")
      : "- none",
  );
  out.push("", "## Mentioned in");
  out.push(n.mentionedIn.length ? n.mentionedIn.map((m) => `- ${link(m.docNoteName)} (${m.kind}${m.date ? `, ${m.date}` : ""})`).join("\n") : "- none");
  const props = Object.entries(n.properties);
  if (props.length) {
    out.push("", "## Properties");
    out.push(props.map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n"));
  }
  return out.join("\n") + "\n";
}

export interface DocView {
  id: string;
  noteName: string;
  title: string | null;
  kind: string;
  origin: string | null;
  occurredAt: Date | null;
  ingestedAt: Date;
  summary: string | null;
  entityNoteNames: string[];
  raw: string;
}

export function renderDocument(d: DocView, maxChars = 200_000): string {
  const body = d.raw.length > maxChars
    ? d.raw.slice(0, maxChars) + `\n\n> (truncated at ${maxChars} characters; the full ${d.raw.length}-character text is in the knowledge base as document ${d.id})\n`
    : d.raw;
  return [
    frontmatter({ brain_id: d.id, brain_kind: d.kind, brain_managed: true, origin: d.origin ?? undefined, occurred_at: d.occurredAt ?? undefined, ingested_at: d.ingestedAt, tags: [`brain/document/${d.kind}`] }),
    `# ${d.title ?? "(untitled)"}`,
    "",
    NOTICE,
    d.summary ? `**Summary.** ${d.summary}\n` : "",
    d.entityNoteNames.length ? `**Entities.** ${d.entityNoteNames.map(link).join(" · ")}\n` : "",
    "---",
    "",
    body,
  ].filter((s) => s !== "").join("\n") + "\n";
}

export function renderReadme(counts: { nodes: number; documents: number }, generatedAt: Date): string {
  return [
    frontmatter({ brain_managed: true, generated_at: generatedAt.toISOString() }),
    "# Brain",
    "",
    `This folder mirrors the knowledge base: ${counts.nodes} entity notes under \`nodes/\` and ${counts.documents} document notes under \`documents/\`. It is regenerated by \`brain project-obsidian\`; edits here are overwritten. Generated ${generatedAt.toISOString()}.`,
    "",
    "Graph view tips: filter with `path:Brain`; add color groups such as `path:Brain/nodes/person`, `path:Brain/nodes/organization`, `path:Brain/documents`, or `tag:#brain/unverified`.",
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npm run test:unit -- obsidian-render && npm run typecheck
git add -A
git commit -m "Render node, document and README notes for Obsidian

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Folder sync

**Files:**
- Create: `src/obsidian/write.ts`, `test/unit/obsidian-write.test.ts`

- [ ] **Step 1: Write the failing test**

`test/unit/obsidian-write.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncFolder } from "../../src/obsidian/write.js";

const managed = (body: string) => `---\nbrain_managed: true\n---\n${body}\n`;

describe("syncFolder", () => {
  it("writes, then reports unchanged, then deletes managed leftovers and keeps unmanaged files", async () => {
    const root = await mkdtemp(join(tmpdir(), "brain-obsidian-"));
    const files = new Map([["README.md", managed("readme")], ["nodes/person/Ann.md", managed("ann")]]);

    const first = await syncFolder(root, files);
    expect(first).toEqual({ written: 2, unchanged: 0, deleted: 0, skipped: [] });
    expect(await readFile(join(root, "nodes/person/Ann.md"), "utf8")).toBe(managed("ann"));

    const second = await syncFolder(root, files);
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(2);

    await mkdir(join(root, "nodes/place"), { recursive: true });
    await writeFile(join(root, "nodes/place/Mine.md"), "my own note\n");
    files.delete("nodes/person/Ann.md");
    const third = await syncFolder(root, files);
    expect(third.deleted).toBe(1);
    expect(third.skipped).toEqual(["nodes/place/Mine.md"]);
    await expect(stat(join(root, "nodes/person/Ann.md"))).rejects.toThrow();
    expect(await readFile(join(root, "nodes/place/Mine.md"), "utf8")).toBe("my own note\n");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- obsidian-write`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/obsidian/write.ts`:
```ts
import { mkdir, readdir, readFile, rm, writeFile, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export interface SyncResult {
  written: number;
  unchanged: number;
  deleted: number;
  skipped: string[];
}

const MANAGED = /^---\n(?:[^\n]*\n)*?brain_managed: true\n(?:[^\n]*\n)*?---\n/;

async function walk(dir: string, root = dir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, root)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(relative(root, full));
  }
  return out;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Makes `root` contain exactly `files` among managed notes. Unmanaged files are reported, never touched. */
export async function syncFolder(root: string, files: Map<string, string>): Promise<SyncResult> {
  await mkdir(root, { recursive: true });
  const result: SyncResult = { written: 0, unchanged: 0, deleted: 0, skipped: [] };
  const existing = new Set(await walk(root));

  for (const [rel, content] of files) {
    const full = join(root, rel);
    if ((await readIfExists(full)) === content) {
      result.unchanged++;
    } else {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      result.written++;
    }
    existing.delete(rel);
  }

  for (const rel of existing) {
    const full = join(root, rel);
    const content = (await readIfExists(full)) ?? "";
    if (MANAGED.test(content)) {
      await rm(full);
      result.deleted++;
      let dir = dirname(full);
      while (dir !== root) {
        try {
          await rmdir(dir);
        } catch {
          break;
        }
        dir = dirname(dir);
      }
    } else {
      result.skipped.push(rel);
    }
  }
  result.skipped.sort();
  return result;
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npm run test:unit -- obsidian-write
git add -A
git commit -m "Folder sync that writes only changes and deletes only managed notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Projection command

**Files:**
- Create: `src/obsidian/project.ts`, `test/integration/obsidian-project.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write the failing test**

`test/integration/obsidian-project.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { projectObsidian } from "../../src/obsidian/project.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "Applying to Acme.", occurred_at: "2026-09-01" } : fakeExtraction;

describe("projectObsidian", () => {
  it("writes linked notes, is idempotent, and removes notes for deleted nodes", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT.", sourceKind: "note" });
    const vault = await mkdtemp(join(tmpdir(), "vault-"));

    const first = await projectObsidian(ctx, { vault, folder: "Brain" });
    expect(first.written).toBe(4); // README, Frank Fu, Acme Corp, the document
    const acme = await readFile(join(vault, "Brain/nodes/organization/Acme Corp.md"), "utf8");
    expect(acme).toContain("applied_to ← [[Frank Fu]]");
    expect(acme).toContain("[[Acme note]]");
    const self = await readFile(join(vault, "Brain/Frank Fu.md"), "utf8");
    expect(self).toContain("visa_status: F-1 OPT");
    expect(self).toContain("applied_to → [[Acme Corp]]");
    const doc = await readFile(join(vault, "Brain/documents/2026/Acme note.md"), "utf8");
    expect(doc).toContain("[[Acme Corp]]");
    expect(doc).toContain("I applied to Acme Corp");

    const second = await projectObsidian(ctx, { vault, folder: "Brain" });
    expect(second.written).toBe(0);

    await sql`delete from brain.nodes where canonical_name = 'acme corp'`;
    const third = await projectObsidian(ctx, { vault, folder: "Brain" });
    expect(third.deleted).toBe(1);
    await expect(readdir(join(vault, "Brain/nodes/organization"))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:int -- obsidian-project`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/obsidian/project.ts`:
```ts
import { join } from "node:path";
import type { Ctx } from "../ctx.js";
import { config } from "../config.js";
import { loadGraph } from "./load.js";
import { uniqueNames } from "./names.js";
import { renderNode, renderDocument, renderReadme, type NodeView, type DocView } from "./render.js";
import { syncFolder, type SyncResult } from "./write.js";

export interface ProjectOptions {
  vault?: string;
  folder?: string;
  now?: Date;
}

export async function projectObsidian(ctx: Ctx, opts: ProjectOptions = {}): Promise<SyncResult> {
  const vault = opts.vault ?? config.obsidianVaultPath;
  const folder = opts.folder ?? config.obsidianFolder;
  const now = opts.now ?? new Date();
  const g = await loadGraph(ctx.sql);

  const nodeNames = uniqueNames(g.nodes.map((n) => ({ id: n.id, name: n.name, createdAt: n.createdAt })));
  const docNames = uniqueNames(g.documents.map((d) => ({ id: d.id, name: d.title ?? `Untitled ${d.id.slice(0, 8)}`, createdAt: d.ingestedAt })));
  const docById = new Map(g.documents.map((d) => [d.id, d]));
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  const files = new Map<string, string>();

  for (const n of g.nodes) {
    const edges = g.edges
      .filter((e) => (e.fromNode === n.id || e.toNode === n.id) && e.fromNode !== e.toNode)
      .map((e) => {
        const otherId = e.fromNode === n.id ? e.toNode : e.fromNode;
        if (!nodeIds.has(otherId)) return null;
        return {
          direction: (e.fromNode === n.id ? "out" : "in") as "out" | "in",
          type: e.type,
          otherNoteName: nodeNames.get(otherId)!,
          evidence: e.evidence,
          evidenceDocNoteName: e.evidenceDocumentId ? docNames.get(e.evidenceDocumentId) ?? null : null,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    const mentionedIn = g.mentions
      .filter((m) => m.nodeId === n.id && docById.has(m.documentId))
      .map((m) => {
        const d = docById.get(m.documentId)!;
        return { docNoteName: docNames.get(d.id)!, kind: d.sourceKind, date: day(d.occurredAt ?? d.ingestedAt) };
      })
      .sort((a, b) => a.docNoteName.localeCompare(b.docNoteName));
    const facts = g.facts
      .filter((f) => f.subjectId === n.id)
      .map((f) => ({ predicate: f.predicate, objectText: f.objectText, verified: f.verified, by: f.verifiedBy, docNoteName: f.documentId ? docNames.get(f.documentId) ?? null : null }));
    const properties: Record<string, unknown> = { ...n.properties };
    if (typeof properties.possible_duplicate_of === "string" && nodeNames.has(properties.possible_duplicate_of)) {
      properties.possible_duplicate_of = `[[${nodeNames.get(properties.possible_duplicate_of)}]]`;
    }
    const view: NodeView = { id: n.id, type: n.type, name: n.name, noteName: nodeNames.get(n.id)!, aliases: n.aliases, properties, verified: n.verified, isSelf: n.isSelf, edges, mentionedIn, facts };
    const rel = n.isSelf ? `${view.noteName}.md` : join("nodes", n.type, `${view.noteName}.md`);
    files.set(rel, renderNode(view));
  }

  for (const d of g.documents) {
    const entityNoteNames = [...new Set(g.mentions.filter((m) => m.documentId === d.id && nodeIds.has(m.nodeId)).map((m) => nodeNames.get(m.nodeId)!))].sort();
    const view: DocView = { id: d.id, noteName: docNames.get(d.id)!, title: d.title, kind: d.sourceKind, origin: d.origin, occurredAt: d.occurredAt, ingestedAt: d.ingestedAt, summary: d.summary, entityNoteNames, raw: d.raw };
    const year = (d.occurredAt ?? d.ingestedAt).getUTCFullYear();
    files.set(join("documents", String(year), `${view.noteName}.md`), renderDocument(view));
  }

  files.set("README.md", renderReadme({ nodes: g.nodes.length, documents: g.documents.length }, now));
  return syncFolder(join(vault, folder), files);
}
```

- [ ] **Step 4: Add the CLI command**

Add to `src/cli.ts` before `program.parseAsync`:
```ts
program
  .command("project-obsidian")
  .description("Write a read-only mirror of the graph into an Obsidian vault folder")
  .option("--vault <path>", "vault path (default from OBSIDIAN_VAULT_PATH)")
  .option("--folder <name>", "folder inside the vault (default Brain)")
  .option("--watch <minutes>", "re-run every N minutes")
  .option("--list-vaults", "print vaults Obsidian knows about and exit")
  .action(async (opts) => {
    const { projectObsidian } = await import("./obsidian/project.js");
    if (opts.listVaults) {
      const { listVaults } = await import("./obsidian/vaults.js");
      for (const v of await listVaults()) console.log(`${v.open ? "*" : " "} ${v.name.padEnd(16)} ${v.path}`);
      return;
    }
    await withCtx(async (ctx) => {
      const run = async () => {
        const r = await projectObsidian(ctx, { vault: opts.vault, folder: opts.folder });
        console.log(`${new Date().toISOString()} written ${r.written}, unchanged ${r.unchanged}, deleted ${r.deleted}${r.skipped.length ? `, left alone: ${r.skipped.join(", ")}` : ""}`);
      };
      await run();
      if (opts.watch) {
        const ms = Number(opts.watch) * 60_000;
        await new Promise<never>(() => setInterval(() => void run().catch((e) => console.error(e instanceof Error ? e.message : e)), ms));
      }
    });
  });
```

- [ ] **Step 5: Run tests, then project into the real vault**

```bash
npm run test:int -- obsidian-project && npm run typecheck
npm run brain -- project-obsidian --list-vaults
npm run brain -- project-obsidian
```
Expected: tests pass; the vault list shows General and MSBA410; the projection reports written counts. Open Obsidian, open the General vault, open graph view, type `path:Brain` in the filter: nodes and documents appear connected. Click a link on a node note and confirm it opens the neighbor.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Obsidian projection command

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: README

- [ ] **Step 1: Append to README.md**

```markdown
## Obsidian

`npm run brain -- project-obsidian` writes a read-only mirror of the graph to `<vault>/Brain` (defaults from `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_FOLDER`). Re-run after ingesting, or keep it fresh with `--watch 30`. In graph view, filter `path:Brain` and add color groups by `path:Brain/nodes/<type>` or `tag:#brain/unverified`. Everything in the folder with `brain_managed: true` is regenerated; your own notes placed there are left alone and listed.
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "README: Obsidian projection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec section 3 (note formats) is Task 4; section 4 (algorithm) is Tasks 2, 3, 5 and 6; section 5 (testing) is covered per task with the manual graph-view check in Task 6.
- Wikilinks use note names, which are unique per run by construction, so a renamed collision can move a link target between runs; that is acceptable for a regenerated mirror and is why the folder is read-only.
- Edges whose other endpoint was merged resolve through `canonical_node` in `loadGraph`, so a note never links to a merged duplicate.
