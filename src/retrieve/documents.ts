import type { Db } from "../db.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DocumentSlice {
  id: string;
  title: string | null;
  sourceKind: string;
  /** owner, other or unknown. */
  author: string;
  origin: string | null;
  occurredAt: Date | null;
  ingestedAt: Date;
  summary: string | null;
  totalLength: number;
  offset: number;
  text: string;
}

export async function getDocument(sql: Db, id: string, offset = 0, length = 4000): Promise<DocumentSlice | null> {
  if (!UUID.test(id)) return null;
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLength = Math.min(20000, Math.max(1, Math.floor(length)));
  const [row] = await sql<{
    id: string; title: string | null; source_kind: string; author: string; origin: string | null; occurred_at: Date | null;
    ingested_at: Date; summary: string | null; total_length: number; text: string;
  }[]>`
    select id, title, source_kind, author, origin, occurred_at, ingested_at, summary,
           length(raw_content) as total_length, substr(raw_content, ${safeOffset + 1}, ${safeLength}) as text
    from brain.documents where id = ${id}`;
  if (!row) return null;
  return {
    id: row.id, title: row.title, sourceKind: row.source_kind, author: row.author, origin: row.origin, occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at, summary: row.summary, totalLength: Number(row.total_length), offset: safeOffset, text: row.text,
  };
}
