import type { SearchResult } from "../retrieve/search.js";
import { degradedNote } from "../retrieve/contract.js";
import type { Orientation } from "../retrieve/orient.js";
import type { NodeReport } from "../graph/inspect.js";
import type { DocumentSlice } from "../retrieve/documents.js";
import type { FactDetail } from "../graph/facts.js";
import type { SuppressedDocument } from "../ingest/set-author.js";
import { voyageTodayLine } from "../llm/usage.js";

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export function renderSearch(r: SearchResult): string {
  const out: string[] = [];
  const note = degradedNote(r.degraded);
  if (note) out.push(`(${note})`);
  if (r.fallbackUsed) out.push("(weak match: results include raw substring hits)\n");
  if (r.passages.length === 0) out.push("No passages matched.");
  r.passages.forEach((p, i) => {
    const where = p.chunkId ? `(document ${p.documentId}, chunk ${p.chunkId})` : `(document ${p.documentId})`;
    const title = p.title ? ` · ${p.title}` : "";
    out.push(`[P${i + 1}] ${p.layers.join("+")} · ${p.sourceKind} · author: ${p.author}${title} ${where}${p.headingPath.length ? `\n  ${p.headingPath.join(" > ")}` : ""}\n${p.content.trim()}\n`);
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
    o.voyage ? voyageTodayLine(o.voyage.tokensToday, o.voyage.cap) : "Voyage ledger unavailable (migration 010 missing?)",
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
    `origin: ${d.origin ?? "n/a"} · author: ${d.author} · about: ${day(d.occurredAt) ?? "unknown"} · ingested: ${day(d.ingestedAt)}`,
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
