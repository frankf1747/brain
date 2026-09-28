import type postgres from "postgres";
import type { Db } from "../db.js";
import { sha256Hex } from "../text/hash.js";

export interface StoreInput {
  text: string;
  title?: string | null;
  sourceKind?: string;
  origin?: string | null;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date | null;
}

/** Stage 1. Idempotent on content: the same bytes always map to the same document id. */
export async function storeDocument(sql: Db, input: StoreInput): Promise<{ id: string; created: boolean }> {
  if (!input.text.trim()) throw new Error("Refusing to store an empty document");
  const hash = sha256Hex(input.text);

  const [existing] = await sql<{ id: string }[]>`select id from brain.documents where content_hash = ${hash}`;
  if (existing) return { id: existing.id, created: false };

  const [row] = await sql<{ id: string }[]>`
    insert into brain.documents (content_hash, source_kind, title, origin, raw_content, mime_type, metadata, occurred_at)
    values (${hash}, ${input.sourceKind ?? "paste"}, ${input.title ?? null}, ${input.origin ?? null},
            ${input.text}, ${input.mimeType ?? "text/plain"}, ${sql.json((input.metadata ?? {}) as postgres.JSONValue)}, ${input.occurredAt ?? null})
    on conflict (content_hash) do nothing
    returning id`;
  if (!row) {
    const [raced] = await sql<{ id: string }[]>`select id from brain.documents where content_hash = ${hash}`;
    return { id: raced.id, created: false };
  }
  await sql`insert into brain.ingest_jobs (document_id, stage) values (${row.id}, 'stored') on conflict do nothing`;
  return { id: row.id, created: true };
}
