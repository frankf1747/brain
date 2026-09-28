import { z } from "zod";
import type { Ctx } from "../../ctx.js";
import type { Db } from "../../db.js";

export const SummarySchema = z.object({
  title: z.string().describe("A short title for the document. Keep the given title if there is one."),
  summary_line: z.string().describe("One sentence under 30 words saying what this document is and what it is about."),
  summary: z.string().describe("Three to six sentences covering the main points. Keep names, organizations, numbers and dates."),
  occurred_at: z.string().nullable().describe("ISO 8601 date the content is about, if the text implies one. Otherwise null."),
});
export type Summary = z.infer<typeof SummarySchema>;

export const SUMMARY_SYSTEM =
  "You summarize documents for a personal knowledge base. Be concrete: keep names, organizations, numbers and dates exactly as written. Never add details that are not in the text. If the document has an explicit title, keep it.";

/** Documents longer than this are summarized section by section, then combined. About 60k tokens. */
export const MAX_SINGLE_CALL_CHARS = 240_000;

export interface SummaryRequest {
  documentId: string;
  system: string;
  user: string;
}

function userPrompt(title: string | null, kind: string, text: string): string {
  return `Source kind: ${kind}\nGiven title: ${title ?? "(none)"}\n\n<document>\n${text}\n</document>`;
}

export async function buildSummaryRequests(sql: Db, documentId: string): Promise<SummaryRequest[]> {
  const [doc] = await sql<{ title: string | null; source_kind: string; raw_content: string }[]>`
    select title, source_kind, raw_content from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  if (doc.raw_content.length <= MAX_SINGLE_CALL_CHARS) {
    return [{ documentId, system: SUMMARY_SYSTEM, user: userPrompt(doc.title, doc.source_kind, doc.raw_content) }];
  }
  const sections = await sql<{ content: string }[]>`
    select content from brain.chunks where document_id = ${documentId} and level = 0 order by ordinal`;
  if (sections.length === 0) throw new Error(`Document ${documentId} is long but has no sections; run the chunk stage first`);
  return sections.map((s) => ({ documentId, system: SUMMARY_SYSTEM, user: userPrompt(doc.title, doc.source_kind, s.content) }));
}

export function combinePrompt(parts: Summary[]): string {
  return (
    "These are summaries of consecutive sections of one document. Combine them into one summary of the whole document.\n\n" +
    parts.map((p, i) => `Section ${i + 1}: ${p.summary}`).join("\n\n")
  );
}

export async function applySummary(sql: Db, documentId: string, summary: Summary): Promise<void> {
  const parsed = summary.occurred_at ? Date.parse(summary.occurred_at) : NaN;
  const occurred = Number.isNaN(parsed) ? null : new Date(parsed);
  await sql`
    update brain.documents
    set summary = ${summary.summary},
        summary_line = ${summary.summary_line},
        title = coalesce(title, ${summary.title}),
        occurred_at = coalesce(occurred_at, ${occurred})
    where id = ${documentId}`;
}

/** Stage 3. */
export async function runSummarize(ctx: Ctx, documentId: string): Promise<void> {
  const requests = await buildSummaryRequests(ctx.sql, documentId);
  const parts: Summary[] = [];
  for (const r of requests) parts.push(await ctx.llm.structured({ schema: SummarySchema, system: r.system, user: r.user }));
  const final =
    parts.length === 1
      ? parts[0]
      : await ctx.llm.structured({ schema: SummarySchema, system: SUMMARY_SYSTEM, user: combinePrompt(parts) });
  await applySummary(ctx.sql, documentId, final);
}
