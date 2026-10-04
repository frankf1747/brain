import { basename } from "node:path";
import type { Db } from "../db.js";
import { UUID } from "../retrieve/documents.js";
import { LoggedPassageSchema } from "../retrieve/contract.js";
import { stemAll } from "../verify/terms.js";
import { appendGolden, loadGoldenAll, validateGoldenItem, type Corpus, type GoldenItem, type GoldenKind } from "./golden.js";
import { duplicateOf, quoteInDocument, quoteInPassage, levelOnePassages, QUOTE_SPANS_PASSAGES } from "./draft.js";

/**
 * Golden items from real questions (spec §8.3). `brain eval capture` lists recent searches from a retrieval log;
 * `brain eval label` turns one into a golden item (source captured, approved by the owner, who runs it) after checking
 * the expected document is in the eval database the item will run against.
 */

/** How many passages of each search `capture` shows. */
export const CAPTURE_PASSAGES = 3;

export interface CapturedPassage {
  label: string;
  title: string | null;
  score: number | null;
  scoreKind: string;
  documentId: string;
  sourceKind: string;
}

export interface CapturedSearch {
  id: string;
  createdAt: string;
  client: string | null;
  query: string;
  mode: string | null;
  sourceKinds: string[];
  /** The first CAPTURE_PASSAGES passages; null for a row logged before evidence v2 (no passages recorded). */
  passages: CapturedPassage[] | null;
}

export interface CaptureOptions {
  since?: Date;
  client?: string;
  /** Default 20. */
  limit?: number;
}

/** Recent searches, newest first. Read-only. */
export async function capturedSearches(sql: Db, opts: CaptureOptions = {}): Promise<CapturedSearch[]> {
  const rows = await sql<{ id: string; created_at: Date; client: string | null; query: string; mode: string | null; filters: Record<string, unknown> | null; results: unknown }[]>`
    select id, created_at, client, query, mode, filters, results
    from brain.retrieval_log
    where (${opts.since ?? null}::timestamptz is null or created_at >= ${opts.since ?? null}::timestamptz)
      and (${opts.client ?? null}::text is null or client = ${opts.client ?? null}::text)
    order by created_at desc
    limit ${opts.limit ?? 20}`;
  return rows.map((r) => {
    const parsed = LoggedPassageSchema.array().safeParse(r.results);
    const sourceKinds = Array.isArray(r.filters?.sourceKinds) ? (r.filters!.sourceKinds as unknown[]).filter((x): x is string => typeof x === "string") : [];
    return {
      id: r.id,
      createdAt: r.created_at.toISOString(),
      client: r.client,
      query: r.query,
      mode: r.mode,
      sourceKinds,
      passages: r.results === null || !parsed.success
        ? null
        : parsed.data.slice(0, CAPTURE_PASSAGES).map((p, i) => ({ label: `P${i + 1}`, title: p.title, score: p.score, scoreKind: p.scoreKind, documentId: p.documentId, sourceKind: p.sourceKind })),
    };
  });
}

/** What `brain eval capture` prints: one block per search, then how to label one. */
export function renderCaptured(searches: CapturedSearch[], corpus: Corpus): string {
  if (searches.length === 0) return "No logged searches match.";
  const out: string[] = [];
  for (const s of searches) {
    const filters = s.sourceKinds.length ? ` · source_kinds ${s.sourceKinds.join(", ")}` : "";
    out.push(`${s.id}  ${s.createdAt.slice(0, 16).replace("T", " ")}  ${s.client ?? "unknown"}  ${s.mode ?? "pre-v2"}${filters}`, `  "${s.query}"`);
    if (s.passages === null) out.push("    (logged before evidence v2: no passages recorded)");
    else if (s.passages.length === 0) out.push("    (no passages)");
    for (const p of s.passages ?? []) {
      const score = p.score === null ? "-" : `${p.score.toFixed(p.scoreKind === "rrf" ? 4 : 2)} ${p.scoreKind}`;
      out.push(`    ${p.label} ${score} · ${p.sourceKind} · ${p.title ? `"${p.title}"` : "(untitled)"} (doc ${p.documentId})`);
    }
  }
  out.push(
    "",
    `Label one: npm run brain -- eval label <retrieval id> --expect <document id${corpus === "fixtures" ? " or file name" : ""}> [--quote "<verbatim span>"] [--kind semantic] [--corpus ${corpus}]`,
    "or, for a question the knowledge base cannot answer: npm run brain -- eval label <retrieval id> --negative",
  );
  return out.join("\n");
}

export interface LabelOptions {
  retrievalId: string;
  /** A document id, or (fixtures) a file name or origin suffix. Required unless negative. */
  expect?: string;
  quote?: string;
  negative?: boolean;
  /** Default semantic; negative with --negative. */
  kind?: GoldenKind;
  corpus: Corpus;
  /** The fixtures golden file; a real item goes to the gitignored golden-real.jsonl next to it (appendGolden routes it). */
  goldenPath: string;
  /** YYYY-MM-DD; defaults to today (UTC). */
  today?: string;
}

const where = (corpus: Corpus) =>
  corpus === "real"
    ? "brain_real_eval; run npm run brain -- eval sync first (it copies the real knowledge base into brain_real_eval, document ids included)"
    : "brain_eval; ingest it with npm run brain -- eval ingest";

/**
 * Writes one golden item from a logged search: the search's query as the question, source captured, approved_by owner,
 * the retrieval id kept. logSql reads the retrieval log the search is in (the real base for corpus real, opened read-
 * only); evalSql is the eval database the item will run against, which must hold the expected document. Refuses an
 * unknown retrieval id, a document not in the eval database (or matching more than one), a quote that is not verbatim
 * in it, and a question that duplicates a golden item.
 */
export async function labelCaptured(logSql: Db, evalSql: Db, opts: LabelOptions): Promise<GoldenItem> {
  if (!UUID.test(opts.retrievalId)) throw new Error(`"${opts.retrievalId}" is not a retrieval id; brain eval capture lists them`);
  const [row] = await logSql<{ query: string; filters: Record<string, unknown> | null }[]>`
    select query, filters from brain.retrieval_log where id = ${opts.retrievalId}`;
  if (!row) throw new Error(`No logged search has retrieval id "${opts.retrievalId}"; brain eval capture lists them`);
  const kind: GoldenKind = opts.negative ? "negative" : opts.kind ?? "semantic";
  if (opts.negative && (opts.expect || opts.quote)) throw new Error("--negative takes no --expect or --quote: nothing in the knowledge base answers it");
  if (!opts.negative && kind === "negative") throw new Error("use --negative for a question the knowledge base cannot answer");
  if (!opts.negative && !opts.expect) throw new Error("--expect <document> is required unless --negative");

  const expected: GoldenItem["expected"] = [];
  if (!opts.negative) {
    const want = opts.expect!;
    const docs = await evalSql<{ id: string; origin: string | null; raw_content: string }[]>`
      select id, origin, raw_content from brain.documents
      where id::text = ${want} or origin = ${want} or right(origin, length(${want}) + 1) = '/' || ${want}`;
    if (docs.length === 0) throw new Error(`document ${want} is not in ${where(opts.corpus)}`);
    if (docs.length > 1) throw new Error(`${want} matches ${docs.length} documents in the eval database; pass a document id`);
    const doc = docs[0];
    if (opts.quote !== undefined && !quoteInDocument(opts.quote, doc.raw_content)) throw new Error(`the quote is not in document ${doc.id} verbatim (whitespace may differ, nothing else)`);
    // eval run matches quotes per level-1 passage, so a quote across a passage boundary would never count as found.
    if (opts.quote !== undefined && !quoteInPassage(opts.quote, await levelOnePassages(evalSql, doc.id))) throw new Error(`document ${doc.id}: ${QUOTE_SPANS_PASSAGES}`);
    const name = opts.corpus === "fixtures" && doc.origin ? { origin: basename(doc.origin) } : { document_id: doc.id };
    expected.push({ ...name, ...(opts.quote !== undefined ? { quote: opts.quote } : {}) });
  }

  const sourceKinds = Array.isArray(row.filters?.sourceKinds) ? (row.filters!.sourceKinds as string[]) : [];
  if (kind === "filter" && sourceKinds.length === 0) throw new Error("the logged search had no source kind filter, so it cannot be a filter item; pick another --kind");
  const v = validateGoldenItem({
    id: `c-${opts.retrievalId.slice(0, 8)}`,
    question: row.query,
    kind,
    expected,
    ...(kind === "filter" ? { filters: { sourceKinds } } : {}),
    source: "captured",
    negative: kind === "negative",
    corpus: opts.corpus,
    approved_by: "owner",
    approved_at: opts.today ?? new Date().toISOString().slice(0, 10),
    retrieval_id: opts.retrievalId,
  });
  if (!v.ok) throw new Error(`not a valid golden item: ${v.errors}`);
  // Both corpora's items: a search is labelled once, and a question may not repeat any golden item.
  const golden = await loadGoldenAll(opts.goldenPath);
  const same = golden.find((g) => g.retrieval_id === opts.retrievalId);
  if (same) throw new Error(`retrieval ${opts.retrievalId} is already golden item ${same.id}`);
  const stems = await stemAll(evalSql, [row.query, ...golden.map((g) => g.question)]);
  const dup = duplicateOf(row.query, golden.map((g) => ({ id: g.id, question: g.question })), stems);
  if (dup) throw new Error(`the question duplicates golden item ${dup}`);
  await appendGolden(opts.goldenPath, [v.item]);
  return v.item;
}
