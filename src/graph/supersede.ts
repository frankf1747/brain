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
 * After resolve inserts `factId` (a single-valued predicate from an owner document): every current fact with
 * the same subject and predicate, a different value (case-insensitive) and an effective date not later than
 * the new fact's is superseded by it. If a current fact is newer, the new fact is itself superseded by the
 * newest one, so the predicate keeps exactly one current value whatever order documents are resolved in.
 */
export async function supersedeByExtraction(
  sql: Db,
  input: { factId: string; subjectId: string; predicate: string; objectText: string; by: string; documentId: string },
): Promise<{ superseded: string[]; supersededBy: string | null }> {
  return sql.begin(async (tx) => {
    const [mine] = await tx<{ eff: string }[]>`select brain.fact_effective_from(${input.factId})::text as eff`;
    const others = await tx<{ id: string; eff: string; not_newer: boolean }[]>`
      select f.id,
             brain.fact_effective_from(f.id)::text as eff,
             brain.fact_effective_from(f.id) <= brain.fact_effective_from(${input.factId}) as not_newer
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
    for (const o of others.filter((x) => x.not_newer)) {
      await linkSupersession(tx, { oldId: o.id, newId: input.factId, by: input.by, documentId: input.documentId, endsOn: mine.eff });
      superseded.push(o.id);
    }
    const newest = others.find((x) => !x.not_newer) ?? null;
    if (newest) {
      await linkSupersession(tx, { oldId: input.factId, newId: newest.id, by: input.by, documentId: input.documentId, endsOn: newest.eff });
    }
    return { superseded, supersededBy: newest?.id ?? null };
  });
}
