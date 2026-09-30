# Brain: Obsidian projection, design

Date: 2026-09-27
Status: approved in conversation, awaiting written review
Depends on: sub-project 1 (documents, chunks, nodes, edges, mentions, facts).
Scope: sub-project 3, first half. A read-only mirror of the knowledge graph as markdown notes in an Obsidian vault, so Obsidian's graph view draws it. The ops agent (duplicate and staleness audit) is the second half and gets its own spec later.

## 1. Purpose

Frank wants to see the nodes and how they connect. Obsidian already renders wikilinks as a graph, so the cheapest visualization is to generate one note per node and one per document, linked with wikilinks, into a folder the base owns. The database stays the source of truth; the folder is regenerated and never read back.

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Vault | `/Users/frankfu/Documents/Obsidian/General` by default, configurable with `OBSIDIAN_VAULT_PATH` | It is the general vault on this machine; the MSBA vaults are course-specific |
| Folder | `Brain/` inside the vault, configurable with `OBSIDIAN_FOLDER` | One managed folder that can be excluded from search or deleted without touching Frank's notes |
| Direction | One-way, database to files | Two-way sync is a conflict problem and out of scope |
| Write strategy | Write a file only when its content changed; delete managed files that are no longer produced | Keeps Obsidian Sync and iCloud quiet; keeps the folder exactly equal to the database view |
| Layout | `Brain/nodes/<type>/<Name>.md`, `Brain/documents/<yyyy>/<Title>.md`, `Brain/README.md`, `Brain/Frank Fu.md` for the self node | Graph view can color by folder path; the self node sits at the top for quick access |
| Links | Wikilinks by note name; names are made unique with a short id suffix when two nodes share a title | Obsidian resolves `[[Name]]` anywhere in the vault; uniqueness avoids wrong edges |
| Tags | `brain/node/<type>`, `brain/document/<kind>`, `brain/unverified` where applicable | Graph groups and Dataview queries by tag |
| Trigger | CLI `brain project-obsidian`, plus an optional `--watch` that re-runs every N minutes | No daemon in v1; a `launchd` entry is documented as an option |

## 3. Note formats

**Node note** (`Brain/nodes/organization/Acme Corp.md`):

```markdown
---
brain_id: 7b1e…
brain_type: organization
brain_managed: true
aliases: [acme]
verified: false
tags: [brain/node/organization]
---
# Acme Corp

> Read-only. Generated from the knowledge base; edits here are overwritten.

## Relationships
- located_in → [[Austin]]  · "Acme Corp announced … Austin manufacturing facility" ([[Acme Corp raises $40M Series B]])
- applied_to ← [[Frank Fu]]  · "I applied to Acme Corp in September" ([[Interview prep call with Priya Natarajan]])

## Mentioned in
- [[Acme Corp raises $40M Series B]] (news, 2026-03-12)
- [[Senior Data Analyst, Acme Corp]] (job_description)

## Properties
- possible_duplicate_of: [[ACME Corporation]]
```

Aliases go into frontmatter `aliases`, which Obsidian uses for link autocompletion and unlinked-mention detection.

**Self node note** (`Brain/Frank Fu.md`) adds a `## Facts` section: `- visa_status: F-1 OPT (verified)` or `(unverified, extractor:opus, from [[doc title]])`, current facts only, grouped by predicate.

**Document note** (`Brain/documents/2026/Acme Corp raises $40M Series B.md`):

```markdown
---
brain_id: 3f2a…
brain_kind: news
brain_managed: true
origin: https://…
occurred_at: 2026-03-12
ingested_at: 2026-09-27
tags: [brain/document/news]
---
# Acme Corp raises $40M Series B

> Read-only. Generated from the knowledge base.

**Summary.** Acme Corp, maker of the ZX-9000 …

**Entities.** [[Acme Corp]] · [[Beta Ventures]] · [[Austin]] · [[Marcus Hale]]

---

(full raw text of the document)
```

Raw text is included in full for text sources; for PDFs it is the extracted text. Documents above 200,000 characters are truncated with a note giving the document id, since Obsidian struggles with very large files.

**README** (`Brain/README.md`): what the folder is, that it is regenerated, the command that produced it, the timestamp, and graph-view tips (group by `path:Brain/nodes/person`, `path:Brain/documents`, or by tag).

## 4. Algorithm

1. Load canonical nodes (`merged_into is null`), their edges with evidence chunk text and the evidence chunk's document title, mentions joined to documents, current facts for the self node, and all documents with summaries.
2. Compute a unique note name per node and per document: the display name or title, sanitized for filenames (no `/ \ : * ? " < > |`, trimmed, max 120 chars). On collision within the same folder, append ` (id-prefix)` to all but the first by creation time.
3. Render every note to a string.
4. Read the existing `Brain/` tree. For each rendered path, write only if the file is missing or its content differs. Delete any file under `Brain/` that has `brain_managed: true` in its frontmatter and was not rendered this run. Files without that marker are left alone and reported, so a stray personal note in the folder is never deleted.
5. Print counts: written, unchanged, deleted, skipped-unmanaged.

## 5. Testing

- Unit: filename sanitization and collision suffixing; wikilink rendering; frontmatter escaping of quotes and colons in aliases; truncation of long documents.
- Integration: against the local database with fixtures from sub-project 1's tests, project into a temporary directory and assert the expected files exist, that a node note links to its neighbors and documents, that a second run writes zero files, that deleting a node from the database removes its note on the next run, and that an unmanaged file in the folder survives.
- Manual: open the vault, open graph view, filter `path:Brain`, confirm nodes and links appear and clicking a link opens the neighbor.

## 6. Out of scope

Two-way sync, Dataview or Bases dashboards inside the vault (the tags and frontmatter make them possible later), Obsidian graph color configuration (Obsidian stores it per vault in `.obsidian/graph.json` and rewriting it is fragile), and the ops agent.

## 7. Changes during implementation

- Trigger moved from on-demand to automatic after each save (2026-09-29). Frank expects a save to write two places together: the database for retrieval and Obsidian for readability and explainability. The pipeline now reports a document changed when it reaches `chunked` (the note appears with its raw text) and again at `done` (summary, entities, relationships, facts); `ObsidianAutoProjector` (`src/obsidian/auto.ts`) debounces those into one projection, never runs two at once, and logs failures to stderr without failing the save. It is on when `OBSIDIAN_VAULT_PATH` exists, off with `OBSIDIAN_AUTO=0`. CLI commands and the stdio MCP server flush it before exiting. `project-obsidian` remains for a full rebuild.
