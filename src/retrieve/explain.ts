import { z } from "zod";
import type { Db } from "../db.js";
import { UUID } from "./documents.js";
import {
  CandidatesSchema, DegradedSchema, LoggedPassageSchema, SearchModeSchema, TimingsSchema,
  type Candidates, type Degraded, type LoggedPassage, type SearchMode, type Timings,
} from "./contract.js";

/** A logged search, replayed from brain.retrieval_log alone (spec §6.4). */
export interface Explanation {
  retrievalId: string;
  query: string;
  client: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** As logged: sourceKinds, since, until, verifiedOnly. */
  filters: Record<string, unknown>;
  /** False for a row logged before evidence v2 (migration 011): only the v1 fields below are known. */
  v2: boolean;
  k: number | null;
  mode: SearchMode | null;
  degraded: Degraded | null;
  candidates: Candidates | null;
  timings: Timings | null;
  /** The returned passages in rank order (index 0 is P1), without their text. */
  results: LoggedPassage[] | null;
  layers: string[];
  chunkIds: string[];
  nodeIds: string[];
  topScore: number | null;
  usedFallback: boolean;
  /** Evidence v2 fields that were logged but could not be read with today's contract (shown as not recorded). */
  notes: string[];
}

/** The message for an id that names no logged search. */
export function explainNotFound(retrievalId: string): string {
  return `No logged search has retrieval id "${retrievalId}". The id is on the first line of a brain_search result: retrieval <id> · mode: …`;
}

/** The columns every row has had since migration 001; a row that fails these is not a retrieval_log row. */
const V1RowSchema = z.object({
  id: z.string(),
  query: z.string(),
  client: z.string().nullish(),
  created_at: z.string(),
  filters: z.record(z.string(), z.unknown()).nullish(),
  layers: z.array(z.string()).nullish(),
  chunk_ids: z.array(z.string()).nullish(),
  node_ids: z.array(z.string()).nullish(),
  top_score: z.number().nullish(),
  used_fallback: z.boolean().nullish(),
});

/**
 * Evidence v2 (migration 011), read one column at a time with safeParse: absent on a database without it, null on rows
 * logged before it, and unreadable when the contract has since gained a required field. An unreadable column is shown
 * as not recorded, with a note, so a contract change never stops older rows from being explained.
 */
function v2Field<T>(raw: Record<string, unknown>, column: string, schema: z.ZodType<T>, notes: string[]): T | null {
  const value = raw[column];
  if (value === null || value === undefined) return null;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length ? `${issue.path.join(".")}: ` : "";
  notes.push(`${column} could not be read with the current contract (${where}${issue?.message ?? "invalid"}); shown as not recorded`);
  return null;
}

/**
 * Reads one retrieval_log row; null when the id is not a UUID or names no row. It never searches again.
 * to_jsonb reads whichever columns the table has, so a database without migration 011 still explains its rows, and each
 * evidence v2 column is read on its own (v2Field), so a later contract change cannot break explaining older rows.
 */
export async function explain(sql: Db, retrievalId: string): Promise<Explanation | null> {
  if (!UUID.test(retrievalId)) return null;
  const [row] = await sql<{ r: unknown }[]>`select to_jsonb(l) as r from brain.retrieval_log l where l.id = ${retrievalId}`;
  if (!row) return null;
  const raw = (row.r ?? {}) as Record<string, unknown>;
  const r = V1RowSchema.parse(raw);
  const notes: string[] = [];
  const results = v2Field(raw, "results", z.array(LoggedPassageSchema), notes);
  return {
    retrievalId: r.id,
    query: r.query,
    client: r.client ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    filters: r.filters ?? {},
    v2: results !== null,
    k: v2Field(raw, "k", z.number().int(), notes),
    mode: v2Field(raw, "mode", SearchModeSchema, notes),
    degraded: v2Field(raw, "degraded", DegradedSchema, notes),
    candidates: v2Field(raw, "candidates", CandidatesSchema, notes),
    timings: v2Field(raw, "timings", TimingsSchema, notes),
    results,
    layers: r.layers ?? [],
    chunkIds: r.chunk_ids ?? [],
    nodeIds: r.node_ids ?? [],
    topScore: r.top_score ?? null,
    usedFallback: r.used_fallback ?? false,
    notes,
  };
}
