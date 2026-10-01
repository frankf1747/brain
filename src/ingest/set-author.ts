import type { Ctx } from "../ctx.js";
import type { Db } from "../db.js";
import { UUID } from "../retrieve/documents.js";
import { refreshMirror } from "../obsidian/auto.js";
import { runResolve, type ResolveReport } from "./stages/resolve.js";
import { withDocumentLock } from "./lock.js";
import { AUTHORS, isAuthor, type Author } from "./author.js";

export interface SetAuthorResult {
  documentId: string;
  previous: Author;
  author: Author;
  /** True when the document already had this author; nothing was changed. */
  unchanged: boolean;
  /**
   * False when nothing was re-resolved: the author was unchanged, or the document has not reached the resolve
   * stage and the new author applies when it does.
   */
  reresolved: boolean;
  /** Facts the document produced before and no longer produces. */
  removedFacts: { id: string; predicate: string; objectText: string }[];
  removedEdges: { type: string; fromName: string; toName: string }[];
  /** Facts the document produces now and did not before (for example after `other -> owner`). */
  addedFacts: { predicate: string; objectText: string }[];
  addedEdges: { type: string; fromName: string; toName: string }[];
  /** Facts from this document the owner verified; undo never deletes them. */
  keptVerified: { id: string; predicate: string; objectText: string }[];
  /** Facts a removed fact had superseded that are current again. */
  restoredFacts: string[];
  suppressedSelfItems: number;
}

const RESOLVED_STAGES = new Set(["resolved", "done"]);

/**
 * Changes who wrote a document and, if it has been resolved, re-runs resolution so facts about the owner and
 * edges from the owner follow the new author (spec §4.1). A document that has not reached the resolve stage
 * only gets the new author; the pipeline's resolve stage applies the gate when it gets there. Holds the same
 * per-document advisory lock as runPipeline, so it never interleaves with a run on the same document.
 * Notifies the Obsidian mirror; the CLI flushes it on exit.
 */
export async function setAuthor(ctx: Ctx, documentId: string, author: Author): Promise<SetAuthorResult> {
  if (!isAuthor(author)) throw new Error(`author must be one of ${AUTHORS.join(", ")}; got "${String(author)}"`);
  if (!UUID.test(documentId)) throw new Error(`Document ${documentId} not found`);
  const r = await withDocumentLock(ctx.sql, documentId, () => setAuthorLocked(ctx, documentId, author));
  if (!r.locked) throw new Error(`document ${documentId} is being processed; try again in a moment`);
  if (!r.value.unchanged) refreshMirror(ctx);
  return r.value;
}

async function setAuthorLocked(ctx: Ctx, documentId: string, author: Author): Promise<SetAuthorResult> {
  const [doc] = await ctx.sql<{ author: Author; stage: string | null }[]>`
    select d.author, j.stage from brain.documents d left join brain.ingest_jobs j on j.document_id = d.id
    where d.id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  const result: SetAuthorResult = {
    documentId, previous: doc.author, author, unchanged: doc.author === author, reresolved: false,
    removedFacts: [], removedEdges: [], addedFacts: [], addedEdges: [], keptVerified: [], restoredFacts: [], suppressedSelfItems: 0,
  };
  if (result.unchanged) return result;
  await ctx.sql`update brain.documents set author = ${author} where id = ${documentId}`;
  if (!doc.stage || !RESOLVED_STAGES.has(doc.stage)) return result;

  let report: ResolveReport;
  try {
    report = await runResolve(ctx, documentId, { by: "set-author" });
  } catch (err) {
    // The undo has committed and only part of the document may be re-applied. Put the job back before the
    // resolve stage with the error, so `brain retry` re-runs resolve (which undoes and re-applies in full).
    const message = err instanceof Error ? err.message : String(err);
    await ctx.sql`
      update brain.ingest_jobs set stage = 'extracted', error = ${message}, attempts = attempts + 1, updated_at = now()
      where document_id = ${documentId}`;
    throw new Error(`author changed to ${author} but re-resolving failed: ${message}; run \`brain retry\` to finish`, { cause: err });
  }
  const now = await producedBy(ctx.sql, documentId);
  const sameFact = (a: { predicate: string; objectText: string }, b: { predicate: string; objectText: string }) =>
    a.predicate === b.predicate && a.objectText === b.objectText;
  const sameEdge = (a: { type: string; fromName: string; toName: string }, b: { type: string; fromName: string; toName: string }) =>
    a.type === b.type && a.fromName === b.fromName && a.toName === b.toName;
  result.reresolved = true;
  result.removedFacts = report.undone.facts.filter((f) => !now.facts.some((g) => sameFact(f, g)));
  result.removedEdges = report.undone.edges
    .filter((e) => !now.edges.some((g) => sameEdge(e, g)))
    .map(({ type, fromName, toName }) => ({ type, fromName, toName }));
  // Verified facts survive the undo, so they are neither removed nor added.
  const before = [...report.undone.facts, ...report.undone.keptVerified];
  result.addedFacts = now.facts.filter((f) => !before.some((g) => sameFact(f, g)));
  result.addedEdges = now.edges.filter((e) => !report.undone.edges.some((g) => sameEdge(e, g)));
  result.keptVerified = report.undone.keptVerified;
  result.restoredFacts = report.undone.restored.length
    ? (await ctx.sql<{ id: string }[]>`
        select id from brain.facts where id = any(${report.undone.restored}::uuid[]) and superseded_by is null`).map((r) => r.id)
    : [];
  result.suppressedSelfItems = report.suppressedSelfItems;
  return result;
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
