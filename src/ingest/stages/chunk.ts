import type { Ctx } from "../../ctx.js";
import { chunkDocument } from "../chunk.js";

/** Stage 2. Replaces all chunks of the document. */
export async function runChunk(ctx: Ctx, documentId: string): Promise<void> {
  const { sql } = ctx;
  const [doc] = await sql<{ raw_content: string }[]>`select raw_content from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  const drafts = chunkDocument(doc.raw_content);

  await sql.begin(async (tx) => {
    await tx`delete from brain.chunks where document_id = ${documentId}`;
    const sectionIds = new Map<number, string>();
    for (const d of drafts.filter((d) => d.level === 0)) {
      const [row] = await tx<{ id: string }[]>`
        insert into brain.chunks (document_id, level, ordinal, heading_path, content, token_count, char_start, char_end)
        values (${documentId}, 0, ${d.ordinal}, ${d.headingPath}::text[], ${d.content}, ${d.tokenCount}, ${d.charStart}, ${d.charEnd})
        returning id`;
      sectionIds.set(d.ordinal, row.id);
    }
    for (const d of drafts.filter((d) => d.level === 1)) {
      const parent = sectionIds.get(d.parentOrdinal!);
      if (!parent) throw new Error(`Passage ${d.ordinal} has no section ${d.parentOrdinal}`);
      await tx`
        insert into brain.chunks (document_id, parent_id, level, ordinal, heading_path, content, token_count, char_start, char_end)
        values (${documentId}, ${parent}, 1, ${d.ordinal}, ${d.headingPath}::text[], ${d.content}, ${d.tokenCount}, ${d.charStart}, ${d.charEnd})`;
    }
  });
}
