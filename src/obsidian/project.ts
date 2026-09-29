import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx } from "../ctx.js";
import { config } from "../config.js";
import { loadGraph } from "./load.js";
import { uniqueNames } from "./names.js";
import { renderNode, renderDocument, renderReadme, type NodeView, type DocView } from "./render.js";
import { isManaged, syncFolder, type SyncResult } from "./write.js";

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

  // Obsidian resolves [[Name]] by file name across the whole vault, so nodes, documents and the README
  // share one namespace. The self node is created by the migration, so it is the oldest and keeps its name.
  const noteNames = uniqueNames(
    [
      ...g.nodes.map((n) => ({ id: n.id, name: n.name, createdAt: n.createdAt })),
      ...g.documents.map((d) => ({ id: d.id, name: d.title ?? `Untitled ${d.id.slice(0, 8)}`, createdAt: d.ingestedAt })),
    ],
    ["README"],
  );
  const nodeNames = new Map(g.nodes.map((n) => [n.id, noteNames.get(n.id)!]));
  const docNames = new Map(g.documents.map((d) => [d.id, noteNames.get(d.id)!]));
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

  // The README carries a timestamp. Keep the previous one unless another note changed, so a run over an
  // unchanged graph writes nothing.
  const root = join(vault, folder);
  const counts = { nodes: g.nodes.length, documents: g.documents.length };
  const oldReadme = await readManagedFile(join(root, "README.md"));
  const prev = previousGeneratedAt(oldReadme);
  const first = renderReadme(counts, prev ?? now);
  files.set("README.md", first);
  const r = await syncFolder(root, files);
  const readmeWritten = oldReadme !== first && !r.skipped.includes("README.md");
  if (!prev || r.written - (readmeWritten ? 1 : 0) + r.deleted === 0) return r;
  files.set("README.md", renderReadme(counts, now));
  const again = await syncFolder(root, files);
  // The second pass only rewrote the README; count it once.
  return { ...r, written: r.written + again.written - (readmeWritten ? 1 : 0), unchanged: r.unchanged - (readmeWritten ? 0 : again.written) };
}

async function readManagedFile(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    const text = await readFile(path, "utf8");
    return isManaged(text) ? text : null;
  } catch {
    return null;
  }
}

function previousGeneratedAt(readme: string | null): Date | null {
  const m = readme?.match(/^generated_at: "([^"]+)"$/m);
  if (!m) return null;
  const d = new Date(m[1]!);
  return Number.isNaN(d.getTime()) ? null : d;
}
