import { z } from "zod";
import type postgres from "postgres";
import type { Db } from "../db.js";
import { UUID } from "../retrieve/documents.js";
import { FactRowSchema, LoggedPassageSchema, type FactRow, type LoggedPassage } from "../retrieve/contract.js";
import {
  ClaimResultSchema, SummarySchema, factText, passageText, summarizeVerdicts, verifyTexts,
  type BadLabel, type CitedText, type ClaimToJudge, type ResolvedCite,
} from "./verify.js";

/**
 * brain_verify end to end (spec §7.1): resolve each claim's cites through the logged search, load the cited texts,
 * judge every claim (verify.ts), write one audit row to brain.verification_log, and return the verification.
 * Round trips: the retrieval_log row, the cited chunks (with any raw ids), fallback documents, facts named by raw id,
 * one stem query for everything, and the audit insert; each lookup is skipped when nothing needs it.
 */

export const MAX_CLAIMS = 50;
export const MAX_CLAIM_CHARS = 2000;
export const MAX_CITES = 20;

export const ClaimInputSchema = z.object({
  text: z.string().trim().min(1).max(MAX_CLAIM_CHARS).describe("One claim of the answer, as written (labels inside it are ignored)"),
  cites: z
    .array(z.string().trim().min(1).max(100))
    .max(MAX_CITES)
    .describe("What the claim cites: P1, F2 (labels from that brain_search result), or a chunk or fact id; [] for a claim of your own"),
});
export type ClaimInput = z.infer<typeof ClaimInputSchema>;

export const ClaimsSchema = z.array(ClaimInputSchema).min(1).max(MAX_CLAIMS);

export const VerificationSchema = z.object({
  /** brain.verification_log id. */
  verificationId: z.string(),
  retrievalId: z.string(),
  claims: z.array(ClaimResultSchema),
  summary: SummarySchema,
  /** Notes about the search as a whole, e.g. that it was logged before facts were recorded. */
  notes: z.array(z.string()),
});
export type Verification = z.infer<typeof VerificationSchema>;

export type ParsedCite =
  | { kind: "P" | "F"; index: number; label: string }
  | { kind: "id"; id: string; label: string }
  | { kind: "invalid"; label: string };

/** P3, p3 and [P3] are P3 (index 2); F1 likewise; a UUID is a chunk or fact id; anything else is invalid. */
export function parseCite(raw: string): ParsedCite {
  const s = raw.trim().replace(/^\[\s*/, "").replace(/\s*\]$/, "");
  const m = /^([PF])(\d+)$/i.exec(s);
  if (m) {
    const kind = m[1].toUpperCase() as "P" | "F";
    return { kind, index: Number(m[2]) - 1, label: `${kind}${Number(m[2])}` };
  }
  if (UUID.test(s)) return { kind: "id", id: s.toLowerCase(), label: s.toLowerCase() };
  return { kind: "invalid", label: s };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const NOTE_NO_RESULTS =
  "This search was logged before evidence v2 (migration 011), so its P labels cannot be resolved; cite chunk ids instead.";
export const NOTE_NO_FACTS =
  "This search was logged before migration 012, which records the facts a search returned, so its F labels cannot be resolved; cite fact ids instead.";

interface LoggedRetrieval {
  id: string;
  /** Null for a row logged before migration 011. */
  results: LoggedPassage[] | null;
  /** Null for a row logged before migration 012. */
  facts: FactRow[] | null;
}

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);
const LogRowSchema = z.object({ id: z.string(), results: nullable(z.array(LoggedPassageSchema)), facts: nullable(z.array(FactRowSchema)) });

/** One retrieval_log row; to_jsonb reads whichever columns exist, so this works before migrations 011 and 012 too. */
async function loadRetrieval(sql: Db, retrievalId: string): Promise<LoggedRetrieval | null> {
  if (!UUID.test(retrievalId)) return null;
  const [row] = await sql<{ r: unknown }[]>`select to_jsonb(l) as r from brain.retrieval_log l where l.id = ${retrievalId}`;
  return row ? LogRowSchema.parse(row.r) : null;
}

interface ChunkText { id: string; document_id: string; heading_path: string[]; content: string; title: string | null }
interface FactText { id: string; predicate: string; object_text: string; document_id: string | null; superseded_by: string | null }

/** Resolves every claim's cites to cited texts (good) or reasons (bad), with as few lookups as the cites need. */
async function resolveClaims(sql: Db, retrieval: LoggedRetrieval, claims: ClaimInput[]): Promise<{ toJudge: ClaimToJudge[]; notes: string[] }> {
  const parsed = claims.map((c) => {
    const seen = new Set<string>();
    return c.cites.map(parseCite).filter((p) => (seen.has(p.label) ? false : (seen.add(p.label), true)));
  });
  const passageAt = (p: ParsedCite) => (p.kind === "P" && retrieval.results ? retrieval.results[p.index] : undefined);

  const chunkIds = new Set<string>();
  const fallbackDocIds = new Set<string>();
  const rawIds = new Set<string>();
  for (const p of parsed.flat()) {
    const logged = passageAt(p);
    if (logged) logged.chunkId ? chunkIds.add(logged.chunkId) : fallbackDocIds.add(logged.documentId);
    if (p.kind === "id") rawIds.add(p.id);
  }

  const lookupChunks = [...new Set([...chunkIds, ...rawIds])];
  const chunks = new Map<string, ChunkText>();
  if (lookupChunks.length) {
    for (const c of await sql<ChunkText[]>`
      select c.id, c.document_id, c.heading_path, c.content, d.title
      from brain.chunks c join brain.documents d on d.id = c.document_id
      where c.id = any(${lookupChunks}::uuid[])`) chunks.set(c.id, c);
  }
  const raws = new Map<string, string>();
  if (fallbackDocIds.size) {
    for (const d of await sql<{ id: string; raw_content: string }[]>`
      select id, raw_content from brain.documents where id = any(${[...fallbackDocIds]}::uuid[])`) raws.set(d.id, d.raw_content);
  }
  const factIds = [...rawIds].filter((id) => !chunks.has(id));
  const facts = new Map<string, FactText>();
  if (factIds.length) {
    for (const f of await sql<FactText[]>`
      select f.id, f.predicate, f.object_text, c.document_id, f.superseded_by
      from brain.facts f left join brain.chunks c on c.id = f.source_chunk_id
      where f.id = any(${factIds}::uuid[])`) facts.set(f.id, f);
  }

  const notes = new Set<string>();
  const toJudge = claims.map((claim, i): ClaimToJudge => {
    const cited: CitedText[] = [];
    const cites: ResolvedCite[] = [];
    const badLabels: BadLabel[] = [];
    const bad = (label: string, reason: string) => badLabels.push({ label, reason });
    const passage = (label: string, documentId: string, chunkId: string | null, title: string | null, text: string) => {
      cited.push({ label, kind: "passage", text });
      cites.push({ label, kind: "passage", documentId, chunkId, factId: null, title });
    };
    const fact = (label: string, id: string, predicate: string, objectText: string, documentId: string | null) => {
      cited.push({ label, kind: "fact", text: factText(predicate, objectText) });
      cites.push({ label, kind: "fact", documentId, chunkId: null, factId: id, title: `${predicate}: ${objectText}` });
    };
    for (const p of parsed[i]) {
      if (p.kind === "P") {
        if (!retrieval.results) { notes.add(NOTE_NO_RESULTS); bad(p.label, "passages were not logged for this search (before migration 011)"); continue; }
        const logged = retrieval.results[p.index];
        if (!logged) { bad(p.label, `no ${p.label} in this search (it returned ${plural(retrieval.results.length, "passage")})`); continue; }
        if (logged.chunkId) {
          const c = chunks.get(logged.chunkId);
          if (!c) { bad(p.label, `${p.label}'s passage is no longer stored (its document was re-chunked or deleted)`); continue; }
          passage(p.label, logged.documentId, logged.chunkId, logged.title, passageText(c.heading_path, c.content));
        } else {
          // A fallback passage is a window of the raw document; JS slices UTF-16 units exactly as search() cut it.
          const raw = raws.get(logged.documentId);
          if (raw === undefined) { bad(p.label, `${p.label}'s document is no longer stored`); continue; }
          passage(p.label, logged.documentId, null, logged.title, raw.slice(logged.charStart, logged.charEnd));
        }
      } else if (p.kind === "F") {
        if (!retrieval.facts) { notes.add(NOTE_NO_FACTS); bad(p.label, "facts were not logged for this search (before migration 012)"); continue; }
        const f = retrieval.facts[p.index];
        if (!f) { bad(p.label, `no ${p.label} in this search (it returned ${plural(retrieval.facts.length, "fact")})`); continue; }
        // The fact as the search showed it, even if it has been superseded since.
        fact(p.label, f.id, f.predicate, f.objectText, f.sourceDocumentId);
      } else if (p.kind === "id") {
        const c = chunks.get(p.id);
        const f = facts.get(p.id);
        if (c) passage(p.label, c.document_id, c.id, c.title, passageText(c.heading_path, c.content));
        else if (f) {
          // A raw id is checked against the fact as stored now, which may have been superseded since.
          if (f.superseded_by) notes.add(`fact ${f.id} was superseded; checked against the stored text`);
          fact(p.label, f.id, f.predicate, f.object_text, f.document_id);
        }
        else bad(p.label, "no passage or fact has this id");
      } else {
        bad(p.label, "not a label (P1, F1) or a passage or fact id");
      }
    }
    return { text: claim.text, labels: parsed[i].map((p) => p.label), cited, cites, badLabels };
  });
  return { toJudge, notes: [...notes] };
}

/**
 * Checks claims against what they cite in one logged search, writes one brain.verification_log row, and returns the
 * verification. Null when the retrieval id is not a UUID or names no logged search. Throws on invalid claims (empty,
 * more than MAX_CLAIMS, a claim over MAX_CLAIM_CHARS characters, more than MAX_CITES cites).
 */
export async function verifyClaims(sql: Db, retrievalId: string, claims: ClaimInput[], opts: { client: string }): Promise<Verification | null> {
  const parsed = ClaimsSchema.safeParse(claims);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((x) => (x.path.length ? `claims.${x.path.join(".")}: ${x.message}` : `claims: ${x.message}`));
    throw new Error(`Invalid claims (at most ${MAX_CLAIMS} claims of at most ${MAX_CLAIM_CHARS} characters, ${MAX_CITES} cites each): ${issues.join("; ")}`);
  }
  const retrieval = await loadRetrieval(sql, retrievalId);
  if (!retrieval) return null;
  const { toJudge, notes } = await resolveClaims(sql, retrieval, parsed.data);
  const results = await verifyTexts(sql, toJudge);
  const summary = summarizeVerdicts(results);
  const json = (v: unknown) => sql.json(v as postgres.JSONValue);
  const [row] = await sql<{ id: string }[]>`
    insert into brain.verification_log (retrieval_id, client, claims, results, summary)
    values (${retrieval.id}, ${opts.client}, ${json(parsed.data)}, ${json(results)}, ${json(summary)})
    returning id`;
  return { verificationId: row.id, retrievalId: retrieval.id, claims: results, summary, notes };
}
