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

/** Stage 6. Turns stored extractions into nodes, edges, mentions and facts. Safe to re-run. */
export async function runResolve(ctx: Ctx, documentId: string): Promise<void> {
  const { sql, embedder } = ctx;
  const extractions = await sql<{ section_chunk_id: string; payload: unknown }[]>`
    select section_chunk_id, payload from brain.extractions where document_id = ${documentId}`;
  if (extractions.length === 0) return; // extraction skipped; the document is still searchable

  const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
  const knownTypes = new Set((await sql<{ name: string }[]>`select name from brain.node_types`).map((r) => r.name));
  const knownEdges = new Set((await sql<{ name: string }[]>`select name from brain.edge_types`).map((r) => r.name));

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
      const loc = evidenceFor(r.quote);
      await sql`
        insert into brain.edges (from_node, to_node, type, confidence, properties, evidence_chunk_id, valid_from, valid_to)
        values (${from}, ${to}, ${type}, ${r.confidence}, ${sql.json(props as postgres.JSONValue)}, ${loc?.chunkId ?? ex.section_chunk_id},
                ${dateOrNull(r.valid_from)}, ${dateOrNull(r.valid_to)})
        on conflict do nothing`;
    }

    for (const f of payload.facts_about_self) {
      const loc = evidenceFor(f.quote);
      const objectNode = f.object_key ? keyToNode.get(f.object_key) ?? null : null;
      await sql`
        insert into brain.facts (subject_id, predicate, object_text, object_node_id, confidence, source_chunk_id, verified_by, valid_from, valid_to)
        values (${self.id}, ${normalizePredicate(f.predicate)}, ${f.object_text}, ${objectNode}, ${f.confidence},
                ${loc?.chunkId ?? ex.section_chunk_id}, ${"extractor:" + ctx.llm.model}, ${dateOrNull(f.valid_from)}, ${dateOrNull(f.valid_to)})
        on conflict do nothing`;
    }
  }
}
