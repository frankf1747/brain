import { NOT_DEGRADED, degradedNote, factSource, searchMode, type Evidence, type FactRow, type LoggedPassage, type SearchResult } from "../retrieve/contract.js";
import type { Explanation } from "../retrieve/explain.js";
import type { Orientation } from "../retrieve/orient.js";
import type { NodeReport } from "../graph/inspect.js";
import type { DocumentSlice } from "../retrieve/documents.js";
import type { FactDetail } from "../graph/facts.js";
import type { SuppressedDocument } from "../ingest/set-author.js";
import { voyageTodayLine } from "../llm/usage.js";
import type { ClaimResult, Verdict } from "../verify/verify.js";
import type { Verification } from "../verify/resolve.js";

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** "0.76 rerank", "0.0328 rrf" (reranking skipped), or "-" for a passage with no score (graph and fallback). */
export function scoreText(p: Pick<LoggedPassage, "score" | "scoreKind">): string {
  if (p.score === null || p.scoreKind === "none") return "-";
  return `${p.score.toFixed(p.scoreKind === "rrf" ? 4 : 2)} ${p.scoreKind}`;
}

/** How a passage was found: its rank in each branch, the entity it came through, or the literal term it contains. */
export function foundBy(p: Pick<LoggedPassage, "layers" | "vectorRank" | "keywordRank" | "viaEntity" | "fallbackTerm">): string {
  const parts = [
    p.vectorRank !== null ? `vector#${p.vectorRank}` : null,
    p.keywordRank !== null ? `keyword#${p.keywordRank}` : null,
    p.layers.includes("graph") ? `graph via ${p.viaEntity?.name ?? "an entity"}` : null,
    p.layers.includes("fallback") ? `fallback "${p.fallbackTerm ?? ""}"` : null,
  ];
  return parts.filter((x): x is string => x !== null).join(" ");
}

/**
 * A title in double quotes for a provenance line. Double quotes inside it (straight or curly) become single quotes, so a
 * title such as `"I thought…" — a post` reads `"'I thought…' — a post"` instead of `""I thought…" — a post"`.
 */
export function quotedTitle(title: string | null): string {
  return title ? `"${title.replace(/["\u201c\u201d]/g, "'")}"` : "(untitled)";
}

/**
 * One passage's provenance line: label, score and score kind, how it was found, source kind, author, title, date,
 * and the ids to read it with (a fallback passage has no chunk, so its character window instead).
 */
export function passageLine(p: LoggedPassage, index: number): string {
  const title = quotedTitle(p.title);
  const date = p.occurredAt ? p.occurredAt.slice(0, 10) : "undated";
  const where = p.chunkId ? `(doc ${p.documentId}, chunk ${p.chunkId})` : `(doc ${p.documentId}, chars ${p.charStart}–${p.charEnd})`;
  return `[P${index + 1}] ${scoreText(p)} · ${foundBy(p)} · ${p.sourceKind} · author: ${p.author} · ${title} · ${date} ${where}`;
}

/** One fact: verification state, and where it came from (a document, the owner's word, the owner's confirmation, or a passage now gone). */
export function factLine(f: FactRow, index: number): string {
  const src = factSource(f);
  const from =
    src.kind === "document" ? `from ${src.sourceKind} ${src.documentId}`
    : src.kind === "owner" ? "stated by owner"
    : src.kind === "confirmed" ? "confirmed by owner"
    : "extracted; source passage no longer stored";
  return `[F${index + 1}] ${f.predicate}: ${f.objectText} (${f.verified ? "verified" : "unverified"} · ${from})`;
}

/** First line of every search: the id brain_explain takes, the exact mode, and the passage count. */
export function searchHeader(r: Pick<SearchResult, "retrievalId" | "mode" | "passages">): string {
  const n = r.passages.length;
  return `retrieval ${r.retrievalId} · mode: ${r.mode} · ${n} passage${n === 1 ? "" : "s"}`;
}

/**
 * Why the passages may not hold the answer, or null for strong evidence and for unknown evidence (no rerank ran, which
 * the degraded note already says).
 */
export function evidenceNote(e: Evidence, topScore: number | null): string | null {
  if (e.level !== "weak") return null;
  const why = topScore === null ? "nothing was reranked" : `the top rerank score ${topScore.toFixed(2)} is below ${e.threshold.toFixed(2)}`;
  return `${why}: these passages may not hold the answer; if none of them states it, say the knowledge base does not have it`;
}

/**
 * The brain_search text, generated from the evidence contract alone. brief (the CLI's `brain search`) prints each
 * passage as one line of at most 240 characters instead of its heading path and full text.
 */
export function renderSearch(r: SearchResult, opts: { brief?: boolean } = {}): string {
  const out = [searchHeader(r)];
  const note = degradedNote(r.degraded);
  if (note) out.push(`(${note})`);
  const weak = evidenceNote(r.evidence, r.topScore);
  if (weak) out.push(`(evidence: weak — ${weak})`);
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

/** Printed under a `brain ask` answer: what it could cite, with the same provenance lines as brain_search. */
export function renderSources(r: SearchResult): string {
  const note = degradedNote(r.degraded);
  return [
    "Sources from the knowledge base (the answer above is the model's, written from these):",
    searchHeader(r),
    ...(note ? [`(${note})`] : []),
    ...r.passages.map((p, i) => passageLine(p, i)),
    ...r.facts.map((f, i) => factLine(f, i)),
    `brain explain ${r.retrievalId} replays how these passages were ranked.`,
  ].join("\n");
}

const VERDICT_MARK: Record<Verdict, string> = { supported: "✓", partial: "~", unsupported: "✗", uncited: "○", bad_citation: "!" };

/** One checked claim: mark, verdict, support with two decimals (- when there is none), the claim, and its cites. */
export function verdictLine(c: ClaimResult): string {
  const support = c.support === null ? "-" : c.support.toFixed(2);
  return `${VERDICT_MARK[c.verdict]} ${c.verdict.replace("_", " ")} ${support} — "${c.claim}"${c.labels.length ? ` [${c.labels.join(", ")}]` : ""}`;
}

/**
 * The line under a claim that is not supported: what its cited texts lack (terms as the claim wrote them, numbers in
 * canonical form), whether negation differs, and why any cite is bad. Under a supported claim only its bad cites are
 * listed, and nothing when it has none.
 */
export function verdictDetail(c: ClaimResult): string | null {
  if (c.verdict === "uncited") return "    no citation: nothing from the knowledge base backs this";
  const bad = c.badLabels.map((b) => `bad citation ${b.label}: ${b.reason}`);
  if (c.verdict === "supported") return bad.length ? `    ${bad.join(" · ")}` : null;
  const parts = [
    c.support === null && c.verdict !== "bad_citation" ? "no content words to compare" : null,
    c.missingTerms.length ? `missing terms: ${c.missingTerms.join(", ")}` : null,
    c.missingNumbers.length ? `missing numbers: ${c.missingNumbers.join(", ")}` : null,
    c.negationMismatch ? "negation differs from the cited text" : null,
    c.missingPolarity.length ? `missing polarity words: ${c.missingPolarity.join(", ")}` : null,
    ...bad,
  ].filter((x): x is string => x !== null);
  return parts.length ? `    ${parts.join(" · ")}` : null;
}

/** What the check does not catch, in plain words: shown in brain_verify's description and under every verification. */
export const VERIFY_NOT_CHECKED = [
  "it checks word overlap, not who did what to whom, so reversed relations and swapped entities pass",
  "a number only has to appear somewhere in the cited text, not attached to the same thing",
  "all cited texts are pooled, so citing unrelated passages together can support a claim neither supports alone",
  "negation is compared only with the cited sentences that best match the claim (those holding at least half its matched words, or else the ones holding the most), per sentence, not per clause",
  "antonyms and words like \"former\" are not detected",
  "up to 40% of a claim's content words can be absent at supported, so one added detail in a short claim can pass",
  "a bare amount ignores its unit (20 minutes matches 20 hours), though % and percentage points are told apart",
  "a claim made only of stopwords (\"Yes.\", \"They did.\") is vacuously supported",
  "a correct paraphrase in other words scores partial or unsupported",
  "a raw fact id is checked against the fact as stored now, which may have been superseded since",
] as const;

/** What was checked and what was not; printed under every verification. */
export const VERIFY_LIMITS =
  "Checked: content words (stemmed), numbers, dates and codes, negation, and polarity words (up/down, before/after, more/less, all/some, only, will/might). " +
  `Not checked: ${VERIFY_NOT_CHECKED.join("; ")}.`;

/** brain_verify, `brain verify` and the check under `brain ask`: one line per claim, details for the rest, the summary. */
export function renderVerification(v: Verification): string {
  const n = v.claims.length;
  const out = [`verification ${v.verificationId} · retrieval ${v.retrievalId} · ${n} claim${n === 1 ? "" : "s"}`];
  for (const c of v.claims) {
    out.push(verdictLine(c));
    const detail = verdictDetail(c);
    if (detail) out.push(detail);
  }
  out.push(`Summary: ${v.summary.text}`);
  for (const note of v.notes) out.push(`Note: ${note}`);
  out.push(VERIFY_LIMITS);
  return out.join("\n");
}

/** Printed under a `brain ask` answer and its sources: the answer checked sentence by sentence, or why it was not. */
export function renderAnswerCheck(v: Verification | null, error: string | null, dropped: number): string {
  if (error) return `Could not check the answer against its sources: ${error}`;
  if (!v) return "The answer has no sentences to check.";
  return [
    "Each sentence of the answer, checked against what it cites (no model call):",
    renderVerification(v),
    ...(dropped ? [`Only the first ${v.claims.length} sentences were checked; ${dropped} more were not.`] : []),
  ].join("\n");
}

const yesNo = (b: boolean) => (b ? "yes" : "no");
const msText = (n: number) => `${n.toFixed(1)} ms`;

function filtersText(f: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(f.sourceKinds) && f.sourceKinds.length) parts.push(`source_kinds ${f.sourceKinds.join(", ")}`);
  if (typeof f.since === "string") parts.push(`since ${f.since}`);
  if (typeof f.until === "string") parts.push(`until ${f.until}`);
  if (f.verifiedOnly === true) parts.push("verified_only");
  return parts.length ? parts.join(" · ") : "none";
}

/** One passage in brain_explain: rank and label, score with its kind, layers, every branch rank, title, author, ids. */
export function explainLine(p: LoggedPassage, index: number): string {
  const rank = (r: number | null) => (r === null ? "-" : String(r));
  const score = p.score === null ? "-" : p.score.toFixed(p.scoreKind === "rrf" ? 4 : 2);
  const via = p.viaEntity ? ` via ${p.viaEntity.name}` : p.fallbackTerm !== null ? ` "${p.fallbackTerm}"` : "";
  const title = quotedTitle(p.title);
  const where = p.chunkId ? `(doc ${p.documentId}, chunk ${p.chunkId})` : `(doc ${p.documentId}, chars ${p.charStart}–${p.charEnd})`;
  return `#${index + 1} [P${index + 1}] score ${score} (${p.scoreKind}) · layers ${p.layers.join("+")}${via} · vector ${rank(p.vectorRank)} · keyword ${rank(p.keywordRank)} · rerank ${rank(p.rerankRank)} · ${title} · author: ${p.author} · ${p.sourceKind} ${where}`;
}

/**
 * A top score logged before evidence v2: an RRF value (about 0.008 to 0.033) when the search was degraded, else a rerank
 * score. Below 0.05 it gets four decimals, so 0.0164 is not shown as 0.02.
 */
export function legacyTopScoreText(score: number | null): string {
  if (score === null) return "none";
  return score.toFixed(score < 0.05 ? 4 : 2);
}

/** brain_explain and `brain explain`: a logged search replayed from brain.retrieval_log, with no new search. */
export function renderExplain(e: Explanation): string {
  const out = [
    `retrieval ${e.retrievalId} · logged ${e.createdAt} · client ${e.client ?? "unknown"}`,
    `query: "${e.query}"`,
    `filters: ${filtersText(e.filters)}`,
    ...e.notes.map((n) => `note: ${n}`),
  ];
  if (!e.v2 || e.results === null) {
    out.push(
      "logged before evidence v2: only the chunk ids, the top score, the layers and the fallback flag were recorded.",
      `layers: ${e.layers.join(", ") || "none"}`,
      `top score: ${legacyTopScoreText(e.topScore)} (before evidence v2 this is an RRF value when the search was degraded)`,
      `fallback scan: ${e.usedFallback ? "used" : "not used"}`,
      `chunks in rank order (fallback passages were not recorded): ${e.chunkIds.join(", ") || "none"}`,
      `entities: ${e.nodeIds.join(", ") || "none"}`,
    );
    return out.join("\n");
  }
  const d = e.degraded ?? NOT_DEGRADED;
  out.push(`mode: ${e.mode ?? searchMode(d)} · k ${e.k ?? "unknown"}`);
  out.push(`degraded: embedding ${yesNo(d.embedding)} · rerank ${yesNo(d.rerank)} · cap reached ${yesNo(d.capReached)}`);
  const note = degradedNote(d);
  if (note) out.push(`(${note})`);
  if (e.candidates) out.push(`candidates: vector ${e.candidates.vector} · keyword ${e.candidates.keyword} · fused ${e.candidates.fused}`);
  if (e.timings) {
    const t = e.timings;
    out.push(`timings: embed ${msText(t.embedMs)} · sql ${msText(t.sqlMs)} · rerank ${msText(t.rerankMs)} · graph ${msText(t.graphMs)} · total ${msText(t.totalMs)}`);
  }
  out.push(`top rerank score: ${e.topScore === null ? "none (no rerank ran, or it returned nothing)" : e.topScore.toFixed(2)}`);
  out.push(`evidence: ${e.evidence ? `${e.evidence.level} (${e.evidence.basis}, answer threshold ${e.evidence.threshold.toFixed(2)})` : "not recorded (logged before migration 013)"}`);
  out.push(`fallback scan: ${e.usedFallback ? "used" : "not used"}`);
  out.push("", `Passages in rank order (P labels as brain_search showed them): ${e.results.length}`);
  if (e.results.length === 0) out.push("none");
  e.results.forEach((p, i) => out.push(explainLine(p, i)));
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
    "How to use: brain_search for anything the owner may have read, written or discussed; brain_get_node for a person, company or topic; brain_get_document to read more of a hit; brain_explain to see how a search ranked its passages; brain_verify to check an answer's claims against the passages and facts they cite; brain_ingest to save new material; brain_add_fact to record something the owner states about themselves.",
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
