import { config } from "../../config.js";
import type postgres from "postgres";
import type { Ctx } from "../../ctx.js";
import { toVector, type Db } from "../../db.js";
import { canonicalName } from "../../text/normalize.js";
import { ExtractionSchema, type Extraction } from "./extract.js";
import { extractorBy, insertSingleValued, lockPredicate } from "../../graph/supersede.js";

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

/** Lowercase snake_case, with a known synonym mapped onto its listed predicate (config.predicateAliases). */
export function normalizePredicate(p: string): string {
  const snake = p.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return config.predicateAliases[snake] ?? snake;
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
/** Predicates that hold one current value (config.singleValuedPredicates). */
const SINGLE_VALUED = new Set<string>(config.singleValuedPredicates);

const LEXICALLY_CHECKED_TYPES = new Set(["person", "organization"]);

/**
 * "Toronto, Canada" -> "toronto": a place named "City, Region" is also found by the city alone. Canonical, like
 * every stored alias. Null when the name has no comma after its first character or the part before it adds
 * nothing (empty, or canonically the whole name: no self-alias). Mirrored by brain.place_short_alias
 * (migration 009), which backfills place nodes created before this existed.
 */
export function placeShortAlias(name: string): string | null {
  const comma = name.indexOf(",");
  if (comma <= 0) return null;
  const head = canonicalName(name.slice(0, comma));
  return head && head !== canonicalName(name) ? head : null;
}

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
  const shortAlias = type === "place" ? placeShortAlias(entity.name) : null;
  // New aliases may match an existing canonical name only when the new name is a single token
  // ("Acme" with alias "Acme Corp"); a multi-token name's aliases are too ambiguous ("Priya").
  const aliasCanonicals =
    canonical.split(" ").length === 1 ? entity.aliases.map(canonicalName).filter((a) => a && a !== canonical) : [];

  const [exact] = await sql<{ id: string }[]>`select id from brain.nodes where type = ${type} and canonical_name = ${canonical}`;
  if (exact) {
    const id = await canonicalId(sql, exact.id);
    if (shortAlias) {
      // On the node the name now resolves to (a merge target), never as its own canonical name.
      await sql`
        update brain.nodes set aliases = array_append(aliases, ${shortAlias}::text), updated_at = now()
        where id = ${id} and type = 'place' and canonical_name <> ${shortAlias}
          and not (${shortAlias}::text = any (aliases))`;
    }
    return id;
  }

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
  const storedAliases = [...new Set([...entity.aliases.map(canonicalName), ...(shortAlias ? [shortAlias] : [])])].filter(
    (a) => a && a !== canonical,
  );
  const [created] = await sql<{ id: string }[]>`
    insert into brain.nodes (type, name, canonical_name, aliases, properties, name_embedding, verified_by)
    values (${type}, ${entity.name}, ${canonical}, ${storedAliases}::text[], ${sql.json(props as postgres.JSONValue)}, ${vec}::vector, ${extractorBy(model)})
    on conflict (type, canonical_name) do update set updated_at = now()
    returning id`;
  // A concurrent or earlier insert may own this canonical name, and it may since have been merged.
  return canonicalId(sql, created.id);
}

export interface UndoReport {
  /** Facts deleted (unverified facts whose source chunk is in the document). */
  facts: { id: string; predicate: string; objectText: string }[];
  /** Facts from the document the owner holds (brain.fact_owner_held; in practice, verified); never deleted. */
  keptVerified: { id: string; predicate: string; objectText: string }[];
  /**
   * Unverified facts from the document that the owner replaced (their supersession chain ends at a fact the
   * owner verified or wrote, such as a supersedeFact correction, through a link the owner made rather than
   * one extraction made by parking the fact behind the owner's value). Kept as the history of that
   * correction, so re-resolving does not bring the old value back as current.
   */
  keptCorrected: { id: string; predicate: string; objectText: string }[];
  edges: { id: string; type: string; fromName: string; toName: string }[];
  mentions: number;
  /** Facts that a deleted fact had superseded and that are current again. */
  restored: string[];
}

/**
 * Follows superseded_by from `from` (which points at `start`) through the facts in `through`. Returns the first
 * fact outside it as `end` (null when the chain ends or cycles inside it) and the fact whose superseded_by
 * points at that end as `last`.
 */
function chainEnd(
  from: string, start: string | null, through: Set<string>, next: Map<string, string | null>,
): { last: string; end: string | null } {
  let last = from;
  let target = start;
  for (let hops = 0; target !== null && through.has(target) && hops <= through.size; hops++) {
    last = target;
    target = next.get(target) ?? null;
  }
  return { last, end: target !== null && through.has(target) ? null : target };
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

    // Take the predicate locks (lockPredicate) before any row lock, in a fixed order, so this never deadlocks
    // with a resolve that holds one predicate lock and then locks that predicate's facts.
    const keys = await tx<{ subject_id: string; predicate: string }[]>`
      select distinct subject_id, predicate from brain.facts
      where source_chunk_id = any(${chunkIds}::uuid[])
      order by subject_id, predicate`;
    for (const k of keys) await lockPredicate(tx, k.subject_id, k.predicate);

    type Row = { id: string; predicate: string; object_text: string; owner_held: boolean; superseded_by: string | null };
    const produced = await tx<Row[]>`
      select id, predicate, object_text, brain.fact_owner_held(verified, verified_by) as owner_held, superseded_by from brain.facts
      where source_chunk_id = any(${chunkIds}::uuid[])
      order by created_at, id
      for update`;
    const view = (f: Row) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text });
    // A document's facts are written by the extractor, so for them owner-held means verified; the shared
    // definition is used anyway so the keep rule cannot drift from the guard's.
    report.keptVerified = produced.filter((f) => f.owner_held).map(view);

    // An unverified fact whose chain (through the document's other unverified facts) ends at a fact the owner
    // holds (brain.fact_owner_held), by a link the owner made (brain.fact_link_is_correction), is the record of
    // an owner correction: keep it. A fact extraction parked behind the owner's value is not. Unlike the
    // resolve guard (brain.fact_corrected_by_owner, which follows the whole chain), this asks only about the
    // first fact outside the document: when another document's extraction superseded this fact, it is that
    // document's history, and it goes with this document.
    const unverified = produced.filter((f) => !f.owner_held);
    const candidates = new Set(unverified.map((f) => f.id));
    const next = new Map(produced.map((f) => [f.id, f.superseded_by]));
    const links = new Map(unverified.map((f) => [f.id, chainEnd(f.id, f.superseded_by, candidates, next)]));
    const corrected = new Set<string>();
    for (const [id, link] of links) {
      if (link.end === null) continue;
      const [row] = await tx<{ ok: boolean }[]>`
        select brain.fact_owner_held(verified, verified_by) and brain.fact_link_is_correction(${link.last}, ${link.end}) as ok
        from brain.facts where id = ${link.end}`;
      if (row?.ok) corrected.add(id);
    }
    const isCorrected = (f: Row) => corrected.has(f.id);
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
        const { last, end: target } = chainEnd(r.id, r.superseded_by, doomedSet, next);
        const previous = await previousValidTo(tx, r.id, r.superseded_by);
        // A chain through removed facts that leads back to the referrer itself is restored, never self-linked.
        if (target !== null && target !== r.id) {
          // The new link inherits the author of the link it replaces (last -> target), so a fact extraction
          // parked behind the owner's value never turns into an owner correction by being re-pointed. An
          // unrecorded original link is written as such ('unrecorded', which counts as the owner's).
          const [inherited] = await tx<{ link_by: string | null }[]>`select brain.fact_link_by(${last}, ${target}) as link_by`;
          // Like a fresh link: the fact ends when its new superseder starts, unless it had its own end.
          await tx`
            update brain.facts set superseded_by = ${target}, valid_to = coalesce(${previous}::date, brain.fact_effective_from(${target}))
            where id = ${r.id}`;
          // A later undo that removes `target` restores this fact from this row.
          const detail = { superseded_by: target, previous_valid_to: previous, link_by: inherited?.link_by ?? "unrecorded" };
          await tx`
            insert into brain.fact_events (fact_id, event, by, document_id, detail)
            values (${r.id}, 'superseded', ${by}, ${documentId}, ${tx.json(detail as postgres.JSONValue)})`;
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

/** Entity-name vectors for resolving a document, keyed by the embedded text (entityText). */
export type EntityVectors = Map<string, number[]>;

interface LoadedExtractions {
  extractions: { section_chunk_id: string; payload: Extraction }[];
  knownTypes: Set<string>;
}

async function loadExtractions(sql: Db, documentId: string): Promise<LoadedExtractions> {
  const rows = await sql<{ section_chunk_id: string; payload: unknown }[]>`
    select section_chunk_id, payload from brain.extractions where document_id = ${documentId}`;
  const knownTypes = new Set((await sql<{ name: string }[]>`select name from brain.node_types`).map((r) => r.name));
  const extractions = rows.map((r) => ({ section_chunk_id: r.section_chunk_id, payload: ExtractionSchema.parse(r.payload) }));
  return { extractions, knownTypes };
}

/** The text an entity's name is embedded as: "type: name", unknown types as concept. */
function entityText(e: Extraction["entities"][number], knownTypes: Set<string>): string {
  return `${knownTypes.has(e.type) ? e.type : "concept"}: ${e.name}`;
}

/**
 * Embeds, in one embedder call (the client splits it into requests of its batch size), every entity name across
 * the document's extractions that `have` does not already hold. Throws whatever the embedder throws, such as
 * SpendCapError, before anything is written.
 */
async function embedNames(embedder: Ctx["embedder"], loaded: LoadedExtractions, have?: EntityVectors): Promise<EntityVectors> {
  const vectors: EntityVectors = new Map(have ?? []);
  const missing = [
    ...new Set(loaded.extractions.flatMap((ex) => ex.payload.entities.map((e) => entityText(e, loaded.knownTypes)))),
  ].filter((t) => !vectors.has(t));
  if (missing.length === 0) return vectors;
  const got = await embedder.embed(missing, "document");
  if (got.length !== missing.length) {
    throw new Error(`Embedder returned ${got.length} vectors for ${missing.length} entity names`);
  }
  missing.forEach((t, i) => vectors.set(t, got[i]));
  return vectors;
}

/**
 * Every Voyage call resolving this document needs (its entity-name embeddings), made without writing anything.
 * set-author calls it before changing the author, so a refusal by the daily cap changes nothing.
 */
export async function embedEntityNames(ctx: Ctx, documentId: string): Promise<EntityVectors> {
  return embedNames(ctx.embedder, await loadExtractions(ctx.sql, documentId));
}

/**
 * Stage 6. Turns stored extractions into nodes, edges, mentions and facts. Re-running it first undoes the
 * document's previous resolution (undoResolution), so a changed author or payload never leaves stale rows.
 * Every Voyage call (the entity-name embeddings) happens before the undo, so a call that fails, or that the daily
 * cap refuses, leaves the previous resolution in place. `vectors` (from embedEntityNames) saves embedding again.
 */
export async function runResolve(
  ctx: Ctx,
  documentId: string,
  opts: { by?: string; vectors?: EntityVectors } = {},
): Promise<ResolveReport> {
  const { sql, embedder } = ctx;
  const [doc] = await sql<{ author: string }[]>`select author from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  const loaded = await loadExtractions(sql, documentId);
  const { extractions, knownTypes } = loaded;
  const vectors = await embedNames(embedder, loaded, opts.vectors);

  const undone = await undoResolution(sql, documentId, { by: opts.by ?? "resolve" });
  // Hard gate (spec §4.3): whatever the model returned, only a document the owner wrote can state facts
  // about the owner or relations from the owner.
  const ownerWrote = doc.author === "owner";

  if (extractions.length === 0) {
    // Extraction skipped; the document is still searchable.
    await recordSuppressed(sql, documentId, 0);
    return { undone, suppressedSelfItems: 0 };
  }

  const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
  const knownEdges = new Set((await sql<{ name: string }[]>`select name from brain.edge_types`).map((r) => r.name));
  let suppressed = 0;

  for (const ex of extractions) {
    const payload = ex.payload;
    const passages = await sql<{ id: string; content: string }[]>`
      select id, content from brain.chunks where parent_id = ${ex.section_chunk_id} order by ordinal`;
    const evidenceFor = (quote: string) => locateQuote(passages, quote);

    const keyToNode = new Map<string, string>();
    for (const e of payload.entities) {
      const nodeId = await resolveEntity(sql, e, vectors.get(entityText(e, knownTypes))!, knownTypes, ctx.llm.model);
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
      // Not stated again: a value the owner holds as current (verified, or set by hand), and a value the owner
      // corrected away from, from whichever document (an extractor fact whose chain reaches an owner-held fact
      // through a correction link, brain.fact_corrected_by_owner). The dedupe index alone is not enough:
      // re-chunking sets source_chunk_id to null on what undo kept.
      const by = extractorBy(ctx.llm.model);
      const insert = async (tx: postgres.TransactionSql): Promise<string | null> => {
        const [row] = await tx<{ id: string }[]>`
          insert into brain.facts (subject_id, predicate, object_text, object_node_id, confidence, source_chunk_id, verified_by, valid_from, valid_to)
          select ${self.id}::uuid, ${predicate}::text, ${f.object_text}::text, ${objectNode}::uuid, ${f.confidence}::real,
                 ${loc?.chunkId ?? ex.section_chunk_id}::uuid, ${by}::text,
                 ${dateOrNull(f.valid_from)}::date, ${dateOrNull(f.valid_to)}::date
          where not exists (
            select 1 from brain.facts v
            where v.subject_id = ${self.id} and v.predicate = ${predicate} and v.object_text = ${f.object_text}
              and (
                (brain.fact_owner_held(v.verified, v.verified_by) and v.superseded_by is null)
                or (not brain.fact_owner_held(v.verified, v.verified_by) and brain.fact_corrected_by_owner(v.id))))
          on conflict do nothing
          returning id`;
        return row?.id ?? null;
      };
      // A single-valued predicate holds one current value: the insert and the supersession it causes share a
      // transaction under the predicate's lock (spec §4.4).
      if (SINGLE_VALUED.has(predicate)) {
        await insertSingleValued(sql, { subjectId: self.id, predicate, objectText: f.object_text, by, documentId }, insert);
      } else {
        await sql.begin(insert);
      }
    }
  }

  await recordSuppressed(sql, documentId, suppressed);
  return { undone, suppressedSelfItems: suppressed };
}
