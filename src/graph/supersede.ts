import type postgres from "postgres";
import type { Db } from "../db.js";

/** facts.verified_by / nodes.verified_by of what the extractor wrote; brain.fact_owner_held tests the same prefix. */
export const EXTRACTOR_BY_PREFIX = "extractor:";

export function extractorBy(model: string): string {
  return EXTRACTOR_BY_PREFIX + model;
}

/**
 * Serializes, until the transaction ends, everything that changes which fact is current for one subject and
 * predicate: the extractor's insert and supersession, supersedeFact, and undoResolution. Without it two
 * pipelines resolving notes on the same single-valued predicate can each supersede the other's fact.
 */
export async function lockPredicate(tx: postgres.TransactionSql, subjectId: string, predicate: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${subjectId}::text || ':' || ${predicate}::text, 0))`;
}

/**
 * Marks `oldId` superseded by `newId` and logs it to brain.fact_events with the valid_to the old fact had
 * ({superseded_by, previous_valid_to}, the format undoResolution reads), so undo can make it current again
 * exactly as it was. The old fact's valid_to becomes `endsOn` (an ISO date) when it had none, or today when
 * `endsOn` is null. Shared by supersedeFact (brain_supersede_fact) and the extractor.
 */
export async function linkSupersession(
  tx: postgres.TransactionSql,
  input: { oldId: string; newId: string; by: string; documentId: string | null; endsOn: string | null },
): Promise<void> {
  const [old] = await tx<{ valid_to: string | null }[]>`select valid_to::text as valid_to from brain.facts where id = ${input.oldId}`;
  await tx`
    update brain.facts
    set superseded_by = ${input.newId}, valid_to = coalesce(valid_to, ${input.endsOn}::date, current_date)
    where id = ${input.oldId}`;
  await tx`
    insert into brain.fact_events (fact_id, event, by, document_id, detail)
    values (${input.oldId}, 'superseded', ${input.by}, ${input.documentId},
            ${tx.json({ superseded_by: input.newId, previous_valid_to: old?.valid_to ?? null } as postgres.JSONValue)})`;
}

/**
 * Inserts an extracted fact for a single-valued predicate and settles which fact is current, in one
 * transaction under lockPredicate. `insert` runs inside it and returns the new fact's id, or null when it
 * inserted nothing (a duplicate, or a value the guard refuses).
 *
 * Among the current facts with the same subject and predicate and a different value (case-insensitive):
 * - an owner-held one (brain.fact_owner_held: verified, or set by hand) is never superseded by extraction,
 *   whatever the dates: the new fact is linked behind it in the same transaction that inserts it;
 * - extractor-written ones that are not newer than the new fact are superseded by it;
 * - otherwise, if an extractor-written one is newer, the new fact is linked behind the newest one.
 * "Newer" compares brain.fact_recency: effective_at, then tie_at, then fact id. So the predicate keeps
 * exactly one current value whatever order documents are resolved in, and an owner action always wins.
 * Every link goes through linkSupersession, so undo can reverse it.
 */
export async function insertSingleValued(
  sql: Db,
  input: { subjectId: string; predicate: string; objectText: string; by: string; documentId: string },
  insert: (tx: postgres.TransactionSql) => Promise<string | null>,
): Promise<void> {
  await sql.begin(async (tx) => {
    await lockPredicate(tx, input.subjectId, input.predicate);
    const factId = await insert(tx);
    if (!factId) return;
    const [mine] = await tx<{ eff: string }[]>`select brain.fact_effective_from(${factId})::text as eff`;
    // Read after taking the lock, so a fact another pipeline committed meanwhile is seen.
    const others = await tx<{ id: string; eff: string; not_newer: boolean; owner_held: boolean }[]>`
      select f.id,
             brain.fact_effective_from(f.id)::text as eff,
             (r.effective_at, r.tie_at, f.id) <= (m.effective_at, m.tie_at, ${factId}::uuid) as not_newer,
             brain.fact_owner_held(f.verified, f.verified_by) as owner_held
      from brain.facts f
      cross join lateral brain.fact_recency(f.id) r
      cross join brain.fact_recency(${factId}) m
      where f.subject_id = ${input.subjectId}
        and f.predicate = ${input.predicate}
        and f.superseded_by is null
        and (f.valid_to is null or f.valid_to >= current_date)
        and f.id <> ${factId}
        and lower(f.object_text) <> lower(${input.objectText})
      order by r.effective_at desc, r.tie_at desc, f.id desc
      for update of f`;
    for (const o of others.filter((x) => x.not_newer && !x.owner_held)) {
      await linkSupersession(tx, { oldId: o.id, newId: factId, by: input.by, documentId: input.documentId, endsOn: mine.eff });
    }
    // `others` is newest first, so this is the newest owner-held fact, else the newest newer extracted one.
    const newest = others.find((x) => x.owner_held) ?? others.find((x) => !x.not_newer) ?? null;
    if (newest) {
      await linkSupersession(tx, { oldId: factId, newId: newest.id, by: input.by, documentId: input.documentId, endsOn: newest.eff });
    }
  });
}
