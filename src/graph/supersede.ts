import type postgres from "postgres";
import type { Db } from "../db.js";

/**
 * Marks `oldId` superseded by `newId` and logs it to brain.fact_events with the valid_to the old fact had
 * ({superseded_by, previous_valid_to}, the format undoResolution reads), so undo can make it current again
 * exactly as it was. The old fact's valid_to becomes `endsOn` (an ISO date) when it had none, or today when
 * `endsOn` is null. Shared by supersedeFact (brain_supersede_fact) and supersedeByExtraction.
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
 * After resolve inserts `factId` (a single-valued predicate from an owner document), among the current facts
 * with the same subject and predicate and a different value (case-insensitive):
 * - an owner-held one (brain.fact_owner_held: verified, or set by hand) is never superseded by extraction,
 *   whatever the dates: the new fact is inserted already superseded by it;
 * - extractor-written ones with an effective date not later than the new fact's are superseded by it;
 * - otherwise, if an extractor-written one is newer, the new fact is superseded by the newest one.
 * So the predicate keeps exactly one current value whatever order documents are resolved in, and an owner
 * action always wins. Every link goes through linkSupersession, so undo can reverse it.
 */
export async function supersedeByExtraction(
  sql: Db,
  input: { factId: string; subjectId: string; predicate: string; objectText: string; by: string; documentId: string },
): Promise<{ superseded: string[]; supersededBy: string | null }> {
  return sql.begin(async (tx) => {
    const [mine] = await tx<{ eff: string }[]>`select brain.fact_effective_from(${input.factId})::text as eff`;
    const others = await tx<{ id: string; eff: string; not_newer: boolean; owner_held: boolean }[]>`
      select f.id,
             brain.fact_effective_from(f.id)::text as eff,
             brain.fact_effective_from(f.id) <= brain.fact_effective_from(${input.factId}) as not_newer,
             brain.fact_owner_held(f.verified, f.verified_by) as owner_held
      from brain.facts f
      where f.subject_id = ${input.subjectId}
        and f.predicate = ${input.predicate}
        and f.superseded_by is null
        and (f.valid_to is null or f.valid_to >= current_date)
        and f.id <> ${input.factId}
        and lower(f.object_text) <> lower(${input.objectText})
      order by brain.fact_effective_from(f.id) desc, f.created_at desc
      for update`;
    const superseded: string[] = [];
    for (const o of others.filter((x) => x.not_newer && !x.owner_held)) {
      await linkSupersession(tx, { oldId: o.id, newId: input.factId, by: input.by, documentId: input.documentId, endsOn: mine.eff });
      superseded.push(o.id);
    }
    // `others` is newest first, so this is the newest owner-held fact, else the newest newer extracted one.
    const newest = others.find((x) => x.owner_held) ?? others.find((x) => !x.not_newer) ?? null;
    if (newest) {
      await linkSupersession(tx, { oldId: input.factId, newId: newest.id, by: input.by, documentId: input.documentId, endsOn: newest.eff });
    }
    return { superseded, supersededBy: newest?.id ?? null };
  });
}
