import { degradedNote, factSource, type FactRow, type LoggedPassage, type SearchResult } from "../retrieve/contract.js";
import type { Orientation } from "../retrieve/orient.js";
import type { NodeReport } from "../graph/inspect.js";
import type { DocumentSlice } from "../retrieve/documents.js";
import type { FactDetail } from "../graph/facts.js";
import type { SuppressedDocument } from "../ingest/set-author.js";
import { voyageTodayLine } from "../llm/usage.js";

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** "0.76 rerank", "0.0328 rrf" (reranking skipped), or "-" for a passage with no score (graph and fallback). */
export function scoreText(p: Pick<LoggedPassage, "score" | "scoreKind">): string {
  if (p.score === null || p.scoreKind === "none") return "-";
  return `${p.score.toFixed(p.scoreKind === "rrf" ? 4 : 2)} ${p.scoreKind}`;
}

/** How a passage was found: its rank in each branch, the entity it came through, or the literal term it contains. */
export function foundBy(p: Pick<LoggedPassage, "layers" | "vectorRank" | "keywordRank" | "viaEntity" | "fallbackTerm">): string {
  if (p.layers.includes("graph")) return `graph via ${p.viaEntity?.name ?? "an entity"}`;
  if (p.layers.includes("fallback")) return `fallback "${p.fallbackTerm ?? ""}"`;
  const ranks = [p.vectorRank !== null ? `vector#${p.vectorRank}` : null, p.keywordRank !== null ? `keyword#${p.keywordRank}` : null];
  return ranks.filter((x): x is string => x !== null).join(" ");
}

/**
 * One passage's provenance line: label, score and score kind, how it was found, source kind, author, title, date,
 * and the ids to read it with (a fallback passage has no chunk, so its character window instead).
 */
export function passageLine(p: LoggedPassage, index: number): string {
  const title = p.title ? `"${p.title}"` : "(untitled)";
  const date = p.occurredAt ? p.occurredAt.slice(0, 10) : "undated";
  const where = p.chunkId ? `(doc ${p.documentId}, chunk ${p.chunkId})` : `(doc ${p.documentId}, chars ${p.charStart}–${p.charEnd})`;
  return `[P${index + 1}] ${scoreText(p)} · ${foundBy(p)} · ${p.sourceKind} · author: ${p.author} · ${title} · ${date} ${where}`;
}

/** One fact: verification state, and whether the extractor read it from a document or the owner stated it. */
export function factLine(f: FactRow, index: number): string {
  const src = factSource(f);
  const from =
    src.kind === "document" ? `from ${src.sourceKind} ${src.documentId}`
    : src.kind === "owner" ? "stated by owner"
    : "extracted; source passage no longer stored";
  return `[F${index + 1}] ${f.predicate}: ${f.objectText} (${f.verified ? "verified" : "unverified"} · ${from})`;
}

/** First line of every search: the id brain_explain takes, the exact mode, and the passage count. */
export function searchHeader(r: Pick<SearchResult, "retrievalId" | "mode" | "passages">): string {
  const n = r.passages.length;
  return `retrieval ${r.retrievalId} · mode: ${r.mode} · ${n} passage${n === 1 ? "" : "s"}`;
}

/**
 * The brain_search text, generated from the evidence contract alone. brief (the CLI's `brain search`) prints each
 * passage as one line of at most 240 characters instead of its heading path and full text.
 */
export function renderSearch(r: SearchResult, opts: { brief?: boolean } = {}): string {
  const out = [searchHeader(r)];
  const note = degradedNote(r.degraded);
  if (note) out.push(`(${note})`);
  if (r.fallbackUsed) out.push("(weak match: results include raw substring hits)");
  out.push("");
  if (r.passages.length === 0) out.push("No passages matched.");
  r.passages.forEach((p, i) => {
    const body = opts.brief
      ? `     ${p.content.replace(/\s+/g, " ").trim().slice(0, 240)}`
      : `${p.headingPath.length ? `  ${p.headingPath.join(" > ")}\n` : ""}${p.content.trim()}`;
    out.push(`${passageLine(p, i)}\n${body}\n`);
  });
  if (r.documents.length) out.push("Documents by summary: " + r.documents.map((d) => `${d.title ?? "(untitled)"} [${d.sourceKind}] (doc ${d.documentId})`).join("; "));
  for (const e of r.entities) {
    const n = e.neighbors.map((x) => `${x.name} (${x.type})`).join(", ") || "no neighbors";
    out.push(`Entity ${e.type}: ${e.name} (node ${e.id}, matched "${e.matchedSpan}") — ${n}`);
  }
  if (r.facts.length) out.push("Facts about the owner:\n" + r.facts.map(factLine).join("\n"));
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
