import type { Db } from "../db.js";
import { normalizePredicate } from "../ingest/stages/resolve.js";
import { UUID } from "../retrieve/documents.js";

export interface FactDetail {
  id: string;
  predicate: string;
  objectText: string;
  confidence: number | null;
  verified: boolean;
  verifiedBy: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  supersededBy: string | null;
  sourceChunkId: string | null;
  createdAt: Date;
}

async function selfId(sql: Db): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
  return row.id;
}

function cleanPredicate(predicate: string): string {
  const p = normalizePredicate(predicate);
  if (!p) throw new Error(`predicate must contain letters or digits (a-z, 0-9); got "${predicate}"`);
  return p;
}

function cleanValue(value: string): string {
  const v = value.trim();
  if (!v) throw new Error("value must not be empty");
  return v;
}

/**
 * Inserts an unverified fact about the owner. Same predicate and value returns the existing id.
 * Returns the id and the predicate as stored (normalized to snake_case).
 */
export async function addFact(
  sql: Db,
  input: { predicate: string; objectText: string; by: string; validFrom?: Date | null; subjectId?: string },
): Promise<{ id: string; predicate: string }> {
  const predicate = cleanPredicate(input.predicate);
  const objectText = cleanValue(input.objectText);
  const subject = input.subjectId ?? (await selfId(sql));
  const [row] = await sql<{ id: string }[]>`
    insert into brain.facts (subject_id, predicate, object_text, confidence, verified, verified_by, valid_from)
    values (${subject}, ${predicate}, ${objectText}, 1, false, ${input.by}, ${input.validFrom ?? null})
    on conflict (subject_id, predicate, object_text, coalesce(source_chunk_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set created_at = brain.facts.created_at
    returning id`;
  return { id: row.id, predicate };
}

/** Replaces a fact's value. The old fact is kept and points at the new one. */
export async function supersedeFact(sql: Db, factId: string, input: { objectText: string; by: string; validFrom?: Date | null }): Promise<string> {
  const objectText = cleanValue(input.objectText);
  if (!UUID.test(factId)) throw new Error(`Fact ${factId} not found`);
  const [old] = await sql<{ subject_id: string; predicate: string; superseded_by: string | null }[]>`
    select subject_id, predicate, superseded_by from brain.facts where id = ${factId}`;
  if (!old) throw new Error(`Fact ${factId} not found`);
  if (old.superseded_by) throw new Error(`Fact ${factId} is already superseded by ${old.superseded_by}`);
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; superseded_by: string | null }[]>`
      insert into brain.facts (subject_id, predicate, object_text, confidence, verified, verified_by, valid_from)
      values (${old.subject_id}, ${old.predicate}, ${objectText}, 1, false, ${input.by}, ${input.validFrom ?? null})
      on conflict (subject_id, predicate, object_text, coalesce(source_chunk_id, '00000000-0000-0000-0000-000000000000'::uuid))
      do update set created_at = brain.facts.created_at
      returning id, superseded_by`;
    // The conflict clause hands back an existing row with the same value.
    if (row.id === factId) throw new Error("New value equals the current value");
    if (row.superseded_by) {
      // Returning to an earlier value: revive that row rather than pointing the chain back at it (a cycle).
      await tx`
        update brain.facts
        set superseded_by = null, valid_to = null, verified_by = ${input.by},
            valid_from = coalesce(${input.validFrom ?? null}::date, valid_from)
        where id = ${row.id}`;
    }
    await tx`update brain.facts set superseded_by = ${row.id}, valid_to = coalesce(valid_to, current_date) where id = ${factId}`;
    return row.id;
  });
}

export async function verifyFact(sql: Db, factId: string, by = "frank"): Promise<boolean> {
  if (!UUID.test(factId)) return false;
  const rows = await sql`update brain.facts set verified = true, verified_by = ${by} where id = ${factId} returning id`;
  return rows.length === 1;
}

type FactRow = {
  id: string; predicate: string; object_text: string; confidence: number | null; verified: boolean; verified_by: string | null;
  valid_from: Date | null; valid_to: Date | null; superseded_by: string | null; source_chunk_id: string | null; created_at: Date;
};

/**
 * With `all` false: current facts only, and the same (predicate, value) extracted from several passages
 * collapses to one row (the verified one if any, otherwise the earliest). With `all` true: every row.
 */
export async function listFacts(sql: Db, all: boolean, subjectId?: string): Promise<FactDetail[]> {
  const subject = subjectId ?? (await selfId(sql));
  const rows = all
    ? await sql<FactRow[]>`
        select id, predicate, object_text, confidence, verified, verified_by, valid_from, valid_to, superseded_by, source_chunk_id, created_at
        from brain.facts where subject_id = ${subject}
        order by predicate, created_at`
    : await sql<FactRow[]>`
        select * from (
          select distinct on (predicate, lower(object_text))
            id, predicate, object_text, confidence, verified, verified_by, valid_from, valid_to, superseded_by, source_chunk_id, created_at
          from brain.facts
          where subject_id = ${subject}
            and superseded_by is null and (valid_to is null or valid_to >= current_date)
          order by predicate, lower(object_text), verified desc, created_at
        ) d order by predicate, created_at`;
  return rows.map((r) => ({
    id: r.id, predicate: r.predicate, objectText: r.object_text, confidence: r.confidence, verified: r.verified, verifiedBy: r.verified_by,
    validFrom: r.valid_from, validTo: r.valid_to, supersededBy: r.superseded_by, sourceChunkId: r.source_chunk_id, createdAt: r.created_at,
  }));
}
