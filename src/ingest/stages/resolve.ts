import { config } from "../../config.js";
import type postgres from "postgres";
import type { Ctx } from "../../ctx.js";
import { toVector, type Db } from "../../db.js";
import { canonicalName } from "../../text/normalize.js";
import { ExtractionSchema, type Extraction } from "./extract.js";

export type Decision = { action: "match"; nodeId: string } | { action: "create"; possibleDuplicateOf: string | null };

export function decide(
  candidates: { id: string; similarity: number }[],
  thresholds: { matchThreshold: number; flagThreshold: number } = config.resolution,
): Decision {
  let best: { id: string; similarity: number } | null = null;
  for (const c of candidates) if (!best || c.similarity > best.similarity) best = c;
  if (!best) return { action: "create", possibleDuplicateOf: null };
  if (best.similarity >= thresholds.matchThreshold) return { action: "match", nodeId: best.id };
  if (best.similarity >= thresholds.flagThreshold) return { action: "create", possibleDuplicateOf: best.id };
  return { action: "create", possibleDuplicateOf: null };
}

/** Lowercase and squash whitespace, keeping a map from squashed index to original index. */
function squashWithMap(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      map.push(i - 1);
      pendingSpace = false;
    }
    text += ch.toLowerCase();
    map.push(i);
  }
  return { text, map };
}

export interface QuoteLocation {
  chunkId: string;
  start: number;
  end: number;
}

const MIN_PREFIX = 12;

/**
 * Finds where a model-supplied quote sits in the passages. A full-quote match is accepted in the
 * first passage that has it. Failing that, word-boundary prefixes of the quote's first 40 characters
 * are tried, longest first, down to max(12, half of those 40 characters); a prefix only counts when
 * exactly one passage contains it, so a generic opening cannot pin the evidence to the wrong passage.
 */
export function locateQuote(chunks: { id: string; content: string }[], quote: string): QuoteLocation | null {
  const full = squashWithMap(quote).text;
  if (!full) return null;
  const squashed = chunks.map((c) => ({ id: c.id, ...squashWithMap(c.content) }));
  const at = (c: (typeof squashed)[number], idx: number, len: number): QuoteLocation => ({
    chunkId: c.id,
    start: c.map[idx],
    end: c.map[idx + len - 1] + 1,
  });

  for (const c of squashed) {
    const idx = c.text.indexOf(full);
    if (idx >= 0) return at(c, idx, full.length);
  }

  const head = full.slice(0, 40).trimEnd();
  const minLength = Math.max(MIN_PREFIX, Math.ceil(0.5 * head.length));
  let prefix = head;
  while (prefix.length >= minLength) {
    if (prefix !== full) {
      const hits = squashed.filter((c) => c.text.includes(prefix));
      if (hits.length === 1) return at(hits[0], hits[0].text.indexOf(prefix), prefix.length);
    }
    const cut = prefix.lastIndexOf(" ");
    if (cut < 0) break;
    prefix = prefix.slice(0, cut);
  }
  return null;
}

export function normalizePredicate(p: string): string {
  return p.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function dateOrNull(s: string | null): Date | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

async function canonicalId(sql: Db, id: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select brain.canonical_node(${id}) as id`;
  return row.id;
}

const ALL_BUT_PLACE = ["person", "organization", "project", "concept", "event", "artifact"];

/**
 * Directed edge types whose endpoint node types are unambiguous. runResolve keeps an edge that fits,
 * swaps one whose reversed endpoints fit, and flags the rest with properties.direction_unverified.
 */
export const EDGE_DIRECTIONS: Record<string, { from: readonly string[]; to: readonly string[] }> = {
  created: { from: ["person", "organization"], to: ["artifact", "project"] },
  works_at: { from: ["person"], to: ["organization"] },
  studied_at: { from: ["person"], to: ["organization"] },
  applied_to: { from: ["person"], to: ["organization", "artifact", "project"] },
  located_in: { from: ALL_BUT_PLACE, to: ["place"] },
};

export type DirectionCheck = "ok" | "swap" | "unverified";

export function checkDirection(edgeType: string, fromType: string, toType: string): DirectionCheck {
  const rule = EDGE_DIRECTIONS[edgeType];
  if (!rule) return "ok";
  const fits = (a: string, b: string) => rule.from.includes(a) && rule.to.includes(b);
  if (fits(fromType, toType)) return "ok";
  if (fits(toType, fromType)) return "swap";
  return "unverified";
}

/** Longest relation quote kept on an edge as properties.quote, the evidence shown for the relationship. */
const MAX_EDGE_QUOTE = 300;

const LEXICALLY_CHECKED_TYPES = new Set(["person", "organization"]);

async function resolveEntity(
  sql: Db,
  entity: Extraction["entities"][number],
  vector: number[],
  knownTypes: Set<string>,
  model: string,
): Promise<string> {
  const type = knownTypes.has(entity.type) ? entity.type : "concept";
  const baseProps: Record<string, unknown> = knownTypes.has(entity.type) ? {} : { untyped_hint: entity.untyped_hint ?? entity.type };
  const canonical = canonicalName(entity.name);
  // New aliases may match an existing canonical name only when the new name is a single token
  // ("Acme" with alias "Acme Corp"); a multi-token name's aliases are too ambiguous ("Priya").
  const aliasCanonicals =
    canonical.split(" ").length === 1 ? entity.aliases.map(canonicalName).filter((a) => a && a !== canonical) : [];

  const [exact] = await sql<{ id: string }[]>`select id from brain.nodes where type = ${type} and canonical_name = ${canonical}`;
  if (exact) return canonicalId(sql, exact.id);

  // Alias path: match on the new entity's own canonical name only. Never on alias-to-alias overlap.
  const aliasRows = await sql<{ id: string }[]>`
    select id from brain.nodes
    where type = ${type}
      and (${canonical} = any(aliases) or canonical_name = any(${aliasCanonicals}::text[]))
    order by created_at, id`;
  const aliasMatches: string[] = [];
  for (const row of aliasRows) {
    const id = await canonicalId(sql, row.id);
    if (!aliasMatches.includes(id)) aliasMatches.push(id);
  }
  if (aliasMatches.length === 1) return aliasMatches[0];

  const vec = toVector(vector);
  let decision: Decision;
  if (aliasMatches.length > 1) {
    // Ambiguous: several distinct nodes answer to this name. Create and flag against the oldest.
    decision = { action: "create", possibleDuplicateOf: aliasMatches[0] };
  } else {
    const candidates = await sql<{ id: string; similarity: number; lexical: number }[]>`
      select id, 1 - (name_embedding <=> ${vec}::vector) as similarity,
             extensions.similarity(canonical_name, ${canonical}) as lexical
      from brain.nodes where type = ${type} and name_embedding is not null
      order by name_embedding <=> ${vec}::vector limit 3`;
    const vectorDecision = decide(candidates.map((c) => ({ id: c.id, similarity: Number(c.similarity) })));
    decision = vectorDecision;
    if (vectorDecision.action === "match" && LEXICALLY_CHECKED_TYPES.has(type)) {
      const matched = candidates.find((c) => c.id === vectorDecision.nodeId)!;
      // People and organizations with close embeddings but different names are often different
      // entities; merge only with lexical support, otherwise create and flag.
      if (Number(matched.lexical) < config.resolution.lexicalThreshold) {
        decision = { action: "create", possibleDuplicateOf: matched.id };
      }
    }
    if (decision.action === "match") return canonicalId(sql, decision.nodeId);
  }

  const props = decision.possibleDuplicateOf ? { ...baseProps, possible_duplicate_of: decision.possibleDuplicateOf } : baseProps;
  const storedAliases = entity.aliases.map(canonicalName).filter((a) => a && a !== canonical);
  const [created] = await sql<{ id: string }[]>`
    insert into brain.nodes (type, name, canonical_name, aliases, properties, name_embedding, verified_by)
    values (${type}, ${entity.name}, ${canonical}, ${storedAliases}::text[], ${sql.json(props as postgres.JSONValue)}, ${vec}::vector, ${"extractor:" + model})
    on conflict (type, canonical_name) do update set updated_at = now()
    returning id`;
  // A concurrent or earlier insert may own this canonical name, and it may since have been merged.
  return canonicalId(sql, created.id);
}

export interface UndoReport {
  /** Facts deleted (unverified facts whose source chunk is in the document). */
  facts: { id: string; predicate: string; objectText: string }[];
  /** Facts from the document the owner verified; never deleted. */
  keptVerified: { id: string; predicate: string; objectText: string }[];
  /**
   * Unverified facts from the document that the owner replaced (their supersession chain ends at a fact the
   * owner verified or wrote, such as a supersedeFact correction). Kept as the history of that correction, so
   * re-resolving hits the dedupe index instead of bringing the old value back as current.
   */
  keptCorrected: { id: string; predicate: string; objectText: string }[];
  edges: { id: string; type: string; fromName: string; toName: string }[];
  mentions: number;
  /** Facts that a deleted fact had superseded and that are current again. */
  restored: string[];
}

/** A fact the owner stands behind: verified, or written by someone other than the extractor. */
function ownerHeld(f: { verified: boolean; verified_by: string | null }): boolean {
  return f.verified || !(f.verified_by ?? "").startsWith("extractor:");
}

/**
 * Follows superseded_by from `start` through the facts in `through` and returns the first fact outside it,
 * or null when the chain ends or cycles inside it.
 */
function chainEnd(start: string | null, through: Set<string>, next: Map<string, string | null>): string | null {
  let target = start;
  for (let hops = 0; target !== null && through.has(target) && hops <= through.size; hops++) target = next.get(target) ?? null;
  return target !== null && through.has(target) ? null : target;
}

/** previous_valid_to from the fact's latest 'superseded' event naming this superseder, or null. */
async function previousValidTo(tx: postgres.TransactionSql, factId: string, supersededBy: string): Promise<string | null> {
  const [last] = await tx<{ previous: string | null }[]>`
    select detail->>'previous_valid_to' as previous from brain.fact_events
    where fact_id = ${factId} and event = 'superseded' and detail->>'superseded_by' = ${supersededBy}
    order by created_at desc, id desc limit 1`;
  return last?.previous ?? null;
}

/**
 * Deletes what resolving this document produced so resolution can be applied again (spec §4.3): unverified
 * facts whose source chunk, edges whose evidence chunk, and mentions whose chunk belongs to the document.
 * Nodes are never deleted. Verified facts are kept, and so are facts the owner corrected (keptCorrected).
 * A fact that a deleted fact had superseded is re-pointed to the next surviving fact in the deleted fact's
 * chain (logged as a 'superseded' event carrying its previous_valid_to forward), or made current again with
 * the valid_to it had before it was superseded (from fact_events). Every removal, re-point and restoration
 * is logged to brain.fact_events under `by`.
 */
export async function undoResolution(sql: Db, documentId: string, opts: { by?: string } = {}): Promise<UndoReport> {
  const by = opts.by ?? "resolve";
  return sql.begin(async (tx) => {
    const report: UndoReport = { facts: [], keptVerified: [], keptCorrected: [], edges: [], mentions: 0, restored: [] };
    const chunkIds = (await tx<{ id: string }[]>`select id from brain.chunks where document_id = ${documentId}`).map((r) => r.id);
    if (chunkIds.length === 0) return report;

    type Row = { id: string; predicate: string; object_text: string; verified: boolean; superseded_by: string | null };
    const produced = await tx<Row[]>`
      select id, predicate, object_text, verified, superseded_by from brain.facts
      where source_chunk_id = any(${chunkIds}::uuid[])
      order by created_at, id
      for update`;
    const view = (f: Row) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text });
    report.keptVerified = produced.filter((f) => f.verified).map(view);

    // An unverified fact whose chain (through the document's other unverified facts) ends at a fact the owner
    // holds is the record of an owner correction: keep it.
    const unverified = produced.filter((f) => !f.verified);
    const candidates = new Set(unverified.map((f) => f.id));
    const next = new Map(produced.map((f) => [f.id, f.superseded_by]));
    const ends = new Map(unverified.map((f) => [f.id, chainEnd(f.superseded_by, candidates, next)]));
    const endIds = [...new Set([...ends.values()].filter((e): e is string => e !== null))];
    const held = new Set(
      (endIds.length
        ? await tx<{ id: string; verified: boolean; verified_by: string | null }[]>`
            select id, verified, verified_by from brain.facts where id = any(${endIds}::uuid[])`
        : []
      ).filter(ownerHeld).map((f) => f.id),
    );
    const isCorrected = (f: Row) => {
      const end = ends.get(f.id);
      return end != null && held.has(end);
    };
    report.keptCorrected = unverified.filter(isCorrected).map(view);
    const doomed = unverified.filter((f) => !isCorrected(f));
    report.facts = doomed.map(view);

    if (doomed.length > 0) {
      const doomedIds = doomed.map((f) => f.id);
      const doomedSet = new Set(doomedIds);
      // facts.superseded_by has no ON DELETE action: anything pointing at a doomed fact must move first.
      const referrers = await tx<{ id: string; superseded_by: string }[]>`
        select id, superseded_by from brain.facts
        where superseded_by = any(${doomedIds}::uuid[]) and not (id = any(${doomedIds}::uuid[]))
        order by created_at, id
        for update`;
      for (const r of referrers) {
        const target = chainEnd(r.superseded_by, doomedSet, next);
        const previous = await previousValidTo(tx, r.id, r.superseded_by);
        if (target !== null) {
          await tx`update brain.facts set superseded_by = ${target} where id = ${r.id}`;
          // A later undo that removes `target` restores this fact from this row.
          await tx`
            insert into brain.fact_events (fact_id, event, by, document_id, detail)
            values (${r.id}, 'superseded', ${by}, ${documentId},
                    ${tx.json({ superseded_by: target, previous_valid_to: previous } as postgres.JSONValue)})`;
          continue;
        }
        await tx`update brain.facts set superseded_by = null, valid_to = ${previous}::date where id = ${r.id}`;
        await tx`
          insert into brain.fact_events (fact_id, event, by, document_id, detail)
          values (${r.id}, 'restored', ${by}, ${documentId}, ${tx.json({ removed_superseder: r.superseded_by } as postgres.JSONValue)})`;
        report.restored.push(r.id);
      }
      await tx`
        insert into brain.fact_events (fact_id, event, by, document_id, detail)
        select f.id, 'removed', ${by}, ${documentId}, jsonb_build_object('predicate', f.predicate, 'object_text', f.object_text)
        from brain.facts f where f.id = any(${doomedIds}::uuid[])
        order by f.created_at, f.id`;
      await tx`delete from brain.facts where id = any(${doomedIds}::uuid[])`;
    }

    const edges = await tx<{ id: string; type: string; fromName: string; toName: string }[]>`
      delete from brain.edges e
      using brain.nodes fn, brain.nodes tn
      where e.evidence_chunk_id = any(${chunkIds}::uuid[]) and fn.id = e.from_node and tn.id = e.to_node
      returning e.id, e.type, fn.name as "fromName", tn.name as "toName"`;
    report.edges = [...edges];
    const mentions = await tx`delete from brain.mentions where chunk_id = any(${chunkIds}::uuid[])`;
    report.mentions = mentions.count;
    return report;
  });
}

export interface ResolveReport {
  /** What the previous resolution of this document produced and this run removed before re-applying. */
  undone: UndoReport;
  /**
   * Facts about the owner plus relations from the owner that the extractor returned for a document the
   * owner did not write. They stay in brain.extractions.payload and are not written.
   */
  suppressedSelfItems: number;
}

/** documents.metadata.suppressed_self_items: the count when there is one, absent otherwise. */
async function recordSuppressed(sql: Db, documentId: string, n: number): Promise<void> {
  if (n > 0) {
    await sql`update brain.documents set metadata = metadata || jsonb_build_object('suppressed_self_items', ${n}::int) where id = ${documentId}`;
  } else {
    await sql`update brain.documents set metadata = metadata - 'suppressed_self_items' where id = ${documentId}`;
  }
}

/**
 * Stage 6. Turns stored extractions into nodes, edges, mentions and facts. Re-running it first undoes the
 * document's previous resolution (undoResolution), so a changed author or payload never leaves stale rows.
 */
export async function runResolve(ctx: Ctx, documentId: string, opts: { by?: string } = {}): Promise<ResolveReport> {
  const { sql, embedder } = ctx;
  const [doc] = await sql<{ author: string }[]>`select author from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  const undone = await undoResolution(sql, documentId, { by: opts.by ?? "resolve" });
  // Hard gate (spec §4.3): whatever the model returned, only a document the owner wrote can state facts
  // about the owner or relations from the owner.
  const ownerWrote = doc.author === "owner";

  const extractions = await sql<{ section_chunk_id: string; payload: unknown }[]>`
    select section_chunk_id, payload from brain.extractions where document_id = ${documentId}`;
  if (extractions.length === 0) {
    // Extraction skipped; the document is still searchable.
    await recordSuppressed(sql, documentId, 0);
    return { undone, suppressedSelfItems: 0 };
  }

  const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
  const knownTypes = new Set((await sql<{ name: string }[]>`select name from brain.node_types`).map((r) => r.name));
  const knownEdges = new Set((await sql<{ name: string }[]>`select name from brain.edge_types`).map((r) => r.name));
  let suppressed = 0;

  for (const ex of extractions) {
    const payload = ExtractionSchema.parse(ex.payload);
    const passages = await sql<{ id: string; content: string }[]>`
      select id, content from brain.chunks where parent_id = ${ex.section_chunk_id} order by ordinal`;
    const evidenceFor = (quote: string) => locateQuote(passages, quote);

    const names = payload.entities.map((e) => `${knownTypes.has(e.type) ? e.type : "concept"}: ${e.name}`);
    const vectors = names.length ? await embedder.embed(names, "document") : [];
    if (vectors.length !== names.length) {
      throw new Error(`Embedder returned ${vectors.length} vectors for ${names.length} entity names`);
    }

    const keyToNode = new Map<string, string>();
    for (let i = 0; i < payload.entities.length; i++) {
      const e = payload.entities[i];
      const nodeId = await resolveEntity(sql, e, vectors[i], knownTypes, ctx.llm.model);
      keyToNode.set(e.key, nodeId);
      const loc = evidenceFor(e.quote);
      await sql`
        insert into brain.mentions (chunk_id, node_id, confidence, span_start, span_end)
        values (${loc?.chunkId ?? ex.section_chunk_id}, ${nodeId}, 1, ${loc?.start ?? null}, ${loc?.end ?? null})
        on conflict do nothing`;
    }

    const nodeIds = [...new Set(keyToNode.values())];
    const nodeType = new Map(
      (nodeIds.length
        ? await sql<{ id: string; type: string }[]>`select id, type from brain.nodes where id = any(${nodeIds}::uuid[])`
        : []
      ).map((n) => [n.id, n.type]),
    );

    for (const r of payload.relations) {
      let from = keyToNode.get(r.from_key);
      let to = keyToNode.get(r.to_key);
      if (!from || !to || from === to) continue;
      const type = knownEdges.has(r.type) ? r.type : "related_to";
      const props: Record<string, unknown> = knownEdges.has(r.type) ? {} : { original_type: r.type };
      const direction = checkDirection(type, nodeType.get(from)!, nodeType.get(to)!);
      if (direction === "swap") [from, to] = [to, from];
      else if (direction === "unverified") props.direction_unverified = true;
      // Checked after the direction fix, so an edge that only points from the owner once corrected is caught too.
      if (!ownerWrote && from === self.id) {
        suppressed++;
        continue;
      }
      const quote = r.quote.trim().slice(0, MAX_EDGE_QUOTE);
      if (quote) props.quote = quote;
      const loc = evidenceFor(r.quote);
      await sql`
        insert into brain.edges (from_node, to_node, type, confidence, properties, evidence_chunk_id, valid_from, valid_to)
        values (${from}, ${to}, ${type}, ${r.confidence}, ${sql.json(props as postgres.JSONValue)}, ${loc?.chunkId ?? ex.section_chunk_id},
                ${dateOrNull(r.valid_from)}, ${dateOrNull(r.valid_to)})
        on conflict do nothing`;
    }

    if (!ownerWrote) {
      suppressed += payload.facts_about_self.length;
      continue;
    }
    for (const f of payload.facts_about_self) {
      const loc = evidenceFor(f.quote);
      const objectNode = f.object_key ? keyToNode.get(f.object_key) ?? null : null;
      const predicate = normalizePredicate(f.predicate);
      // A value the owner already verified and holds as current is not stated again (re-chunking moves the
      // verified fact off this document's chunks, so the dedupe index alone would let a copy in).
      await sql`
        insert into brain.facts (subject_id, predicate, object_text, object_node_id, confidence, source_chunk_id, verified_by, valid_from, valid_to)
        select ${self.id}::uuid, ${predicate}::text, ${f.object_text}::text, ${objectNode}::uuid, ${f.confidence}::real,
               ${loc?.chunkId ?? ex.section_chunk_id}::uuid, ${"extractor:" + ctx.llm.model}::text,
               ${dateOrNull(f.valid_from)}::date, ${dateOrNull(f.valid_to)}::date
        where not exists (
          select 1 from brain.facts v
          where v.subject_id = ${self.id} and v.predicate = ${predicate} and v.object_text = ${f.object_text}
            and v.verified and v.superseded_by is null)
        on conflict do nothing`;
    }
  }

  await recordSuppressed(sql, documentId, suppressed);
  return { undone, suppressedSelfItems: suppressed };
}
