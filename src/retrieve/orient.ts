import type { Ctx } from "../ctx.js";
import { config, VOYAGE_CAP_NAME } from "../config.js";
import { stageCounts } from "../ingest/pipeline.js";
import { tokensToday } from "../llm/ledger.js";

export interface Orientation {
  totalDocuments: number;
  documentsByKind: { kind: string; count: number }[];
  nodesByType: { type: string; count: number }[];
  recent: { id: string; title: string | null; sourceKind: string; occurredAt: Date | null; ingestedAt: Date }[];
  facts: { id: string; predicate: string; objectText: string; verified: boolean }[];
  pipeline: { stage: string; count: number; failed: number }[];
  /** Tokens counted against today's (UTC) Voyage cap in this database, and the cap; null when the ledger is missing. */
  voyage: { tokensToday: number; cap: number } | null;
}

export async function orient(ctx: Ctx): Promise<Orientation> {
  const { sql } = ctx;
  const [kinds, types, recent, facts, pipeline, voyageTokens] = await Promise.all([
    sql<{ kind: string; count: string }[]>`select source_kind as kind, count(*)::text as count from brain.documents group by source_kind order by count desc`,
    sql<{ type: string; count: string }[]>`select type, count(*)::text as count from brain.nodes where merged_into is null group by type order by count desc`,
    sql<Orientation["recent"]>`
      select id, title, source_kind as "sourceKind", occurred_at as "occurredAt", ingested_at as "ingestedAt"
      from brain.documents order by ingested_at desc limit 10`,
    sql<{ id: string; predicate: string; object_text: string; verified: boolean }[]>`
      select * from (
        select distinct on (predicate, lower(object_text)) id, predicate, object_text, verified
        from brain.current_facts(null)
        order by predicate, lower(object_text), verified desc, created_at
      ) d order by verified desc, predicate limit 50`,
    stageCounts(ctx),
    // A database without migration 010 has no ledger; orient still answers and says so.
    tokensToday(sql).catch(() => null),
  ]);
  const cap = ctx.voyageCap ?? { tokens: config.voyageDailyTokenCap, name: VOYAGE_CAP_NAME };
  return {
    totalDocuments: kinds.reduce((s, k) => s + Number(k.count), 0),
    documentsByKind: kinds.map((k) => ({ kind: k.kind, count: Number(k.count) })),
    nodesByType: types.map((t) => ({ type: t.type, count: Number(t.count) })),
    recent,
    facts: facts.map((f) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text, verified: f.verified })),
    pipeline,
    voyage: voyageTokens === null ? null : { tokensToday: voyageTokens, cap: cap.tokens },
  };
}
