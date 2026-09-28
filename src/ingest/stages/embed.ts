import type { Ctx } from "../../ctx.js";
import { toVector } from "../../db.js";

export function contextPrefix(title: string | null, summaryLine: string | null, headingPath: string[]): string {
  return [title, summaryLine, headingPath.length ? headingPath.join(" > ") : null]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n");
}

/** Stage 4. Embeds every passage (with its context prefix) and the document summary. */
export async function runEmbed(ctx: Ctx, documentId: string): Promise<void> {
  const { sql, embedder } = ctx;
  const [doc] = await sql<{ title: string | null; summary_line: string | null; summary: string | null }[]>`
    select title, summary_line, summary from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  const chunks = await sql<{ id: string; content: string; heading_path: string[] }[]>`
    select id, content, heading_path from brain.chunks where document_id = ${documentId} and level = 1 order by ordinal`;

  const prefixes = chunks.map((c) => contextPrefix(doc.title, doc.summary_line, c.heading_path));
  const texts = chunks.map((c, i) => (prefixes[i] ? `${prefixes[i]}\n\n${c.content}` : c.content));
  const vectors = texts.length ? await embedder.embed(texts, "document") : [];

  const summaryText = [doc.title, doc.summary].filter(Boolean).join("\n");
  const summaryVector = summaryText ? (await embedder.embed([summaryText], "document"))[0] : null;

  await sql.begin(async (tx) => {
    for (let i = 0; i < chunks.length; i++) {
      await tx`update brain.chunks set context_prefix = ${prefixes[i]}, embedding = ${toVector(vectors[i])}::vector where id = ${chunks[i].id}`;
    }
    if (summaryVector) {
      await tx`update brain.documents set summary_embedding = ${toVector(summaryVector)}::vector where id = ${documentId}`;
    }
  });
}
