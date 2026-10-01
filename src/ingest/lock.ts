import type { Db } from "../db.js";

/**
 * Runs `fn` while holding the document's session advisory lock, the one every pipeline run, skipped-work reset
 * and `brain set-author` takes, on a reserved connection. Returns { locked: false } without calling `fn` when
 * another runner holds it. `fn` may use any connection; the lock only serializes these callers.
 */
export async function withDocumentLock<T>(
  sql: Db,
  documentId: string,
  fn: () => Promise<T>,
): Promise<{ locked: true; value: T } | { locked: false }> {
  const reserved = await sql.reserve();
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtextextended(${documentId}::text, 0)) as locked`;
    if (!locked) return { locked: false };
    try {
      return { locked: true, value: await fn() };
    } finally {
      await reserved`select pg_advisory_unlock(hashtextextended(${documentId}::text, 0))`;
    }
  } finally {
    reserved.release();
  }
}
