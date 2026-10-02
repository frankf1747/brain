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
}

/** The message for an id that names no logged search. */
export function explainNotFound(retrievalId: string): string {
  return `No logged search has retrieval id "${retrievalId}". The id is on the first line of a brain_search result: retrieval <id> · mode: …`;
}

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);

const LogRowSchema = z.object({
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
  // Evidence v2 (migration 011); absent on a database without it, null on rows logged before it.
  results: nullable(z.array(LoggedPassageSchema)),
  degraded: nullable(DegradedSchema),
  candidates: nullable(CandidatesSchema),
  timings: nullable(TimingsSchema),
  k: nullable(z.number().int()),
  mode: nullable(SearchModeSchema),
});

/**
 * Reads one retrieval_log row; null when the id is not a UUID or names no row. It never searches again.
 * to_jsonb reads whichever columns the table has, so a database without migration 011 still explains its rows.
 */
export async function explain(sql: Db, retrievalId: string): Promise<Explanation | null> {
  if (!UUID.test(retrievalId)) return null;
  const [row] = await sql<{ r: unknown }[]>`select to_jsonb(l) as r from brain.retrieval_log l where l.id = ${retrievalId}`;
  if (!row) return null;
  const r = LogRowSchema.parse(row.r);
  return {
    retrievalId: r.id,
    query: r.query,
    client: r.client ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    filters: r.filters ?? {},
    v2: r.results !== null,
    k: r.k,
    mode: r.mode,
    degraded: r.degraded,
    candidates: r.candidates,
    timings: r.timings,
    results: r.results,
    layers: r.layers ?? [],
    chunkIds: r.chunk_ids ?? [],
    nodeIds: r.node_ids ?? [],
    topScore: r.top_score ?? null,
    usedFallback: r.used_fallback ?? false,
  };
}
