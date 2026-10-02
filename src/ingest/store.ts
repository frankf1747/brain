import type postgres from "postgres";
import type { Db } from "../db.js";
import { sha256Hex } from "../text/hash.js";
import { AUTHORS, defaultAuthor, isAuthor, type Author } from "./author.js";

export interface StoreInput {
  text: string;
  title?: string | null;
  sourceKind?: string;
  /**
   * Who wrote the text. When absent, config.authorDefaults by source kind. Ignored when the same text is
   * already stored (storing is idempotent on content): the result then carries the stored author, and
   * `brain set-author` changes it.
   */
  author?: Author;
  origin?: string | null;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date | null;
}

/**
 * Stage 1. Idempotent on content: the same bytes always map to the same document id. `author` is the author
 * stored on the document, which for existing text may differ from input.author.
 */
export async function storeDocument(sql: Db, input: StoreInput): Promise<{ id: string; created: boolean; author: Author }> {
  if (!input.text.trim()) throw new Error("Refusing to store an empty document");
  if (input.author !== undefined && !isAuthor(input.author)) {
    throw new Error(`author must be one of ${AUTHORS.join(", ")}; got "${String(input.author)}"`);
  }
  const hash = sha256Hex(input.text);
  const sourceKind = input.sourceKind ?? "paste";
  const author: Author = input.author ?? defaultAuthor(sourceKind);

  const healJob = (id: string) => sql`insert into brain.ingest_jobs (document_id, stage) values (${id}, 'stored') on conflict do nothing`;

  const [existing] = await sql<{ id: string; author: Author }[]>`select id, author from brain.documents where content_hash = ${hash}`;
  if (existing) {
    // A document without a job (e.g. stored before stores were atomic) would strand runPipeline; heal it.
    await healJob(existing.id);
    return { id: existing.id, created: false, author: existing.author };
  }

  // Document and job are written together so a crash can never leave one without the other.
  const row = await sql.begin(async (tx) => {
    const [inserted] = await tx<{ id: string }[]>`
      insert into brain.documents (content_hash, source_kind, author, title, origin, raw_content, mime_type, metadata, occurred_at)
      values (${hash}, ${sourceKind}, ${author}, ${input.title ?? null}, ${input.origin ?? null},
              ${input.text}, ${input.mimeType ?? "text/plain"}, ${sql.json((input.metadata ?? {}) as postgres.JSONValue)}, ${input.occurredAt ?? null})
      on conflict (content_hash) do nothing
      returning id`;
    if (inserted) await tx`insert into brain.ingest_jobs (document_id, stage) values (${inserted.id}, 'stored') on conflict do nothing`;
    return inserted as { id: string } | undefined;
  });
  if (!row) {
    const [raced] = await sql<{ id: string; author: Author }[]>`select id, author from brain.documents where content_hash = ${hash}`;
    await healJob(raced.id);
    return { id: raced.id, created: false, author: raced.author };
  }
  return { id: row.id, created: true, author };
}
