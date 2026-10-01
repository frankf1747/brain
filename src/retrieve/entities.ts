import type { Db } from "../db.js";
import { canonicalName } from "../text/normalize.js";

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "for", "to", "in", "on", "at", "with", "about", "from", "by", "as",
  "my", "me", "i", "you", "your", "we", "our", "it", "its", "this", "that", "these", "those",
  "do", "does", "did", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "what", "who", "where", "when", "why", "how", "which", "tell", "show", "list", "find", "give", "can", "know", "knows", "say", "said",
]);

const MAX_SPAN = 3;

function tokens(query: string): string[] {
  return query
    .replace(/["“”?,!;:()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^(.+?)(?:['’]s|['’])$/, "$1").replace(/\.$/, ""))
    .filter(Boolean);
}

/** Quoted strings plus every 1..3-token span whose first and last token are not stopwords. Case is kept for display; matching is canonical. */
export function candidateSpans(query: string): string[] {
  const spans = new Set<string>();
  for (const m of query.matchAll(/["“]([^"”]+)["”]/g)) spans.add(m[1].trim());
  const toks = tokens(query);
  for (let n = MAX_SPAN; n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const span = toks.slice(i, i + n);
      if (STOPWORDS.has(span[0].toLowerCase()) || STOPWORDS.has(span[n - 1].toLowerCase())) continue;
      spans.add(span.join(" "));
    }
  }
  return [...spans].filter(Boolean);
}

export interface EntityRef {
  id: string;
  type: string;
  name: string;
  /** The canonicalised query span that matched this node. */
  matchedSpan: string;
}

function containsSpan(longer: string, shorter: string): boolean {
  return longer !== shorter && (` ${longer} `).includes(` ${shorter} `);
}

/** Longest span wins: a match whose span is contained in another match's span is dropped; one row per node. */
export function dropContainedSpans(refs: EntityRef[]): EntityRef[] {
  const spans = new Set(refs.map((r) => r.matchedSpan));
  const kept = refs.filter((r) => ![...spans].some((s) => containsSpan(s, r.matchedSpan)));
  const byNode = new Map<string, EntityRef>();
  for (const r of kept) if (!byNode.has(r.id) || r.matchedSpan.length > byNode.get(r.id)!.matchedSpan.length) byNode.set(r.id, r);
  return [...byNode.values()];
}

export async function detectEntities(sql: Db, query: string): Promise<EntityRef[]> {
  const keys = [...new Set(candidateSpans(query).map(canonicalName).filter(Boolean))];
  if (keys.length === 0) return [];
  const rows = await sql<EntityRef[]>`
    select distinct x.id, x.type, x.name, k.key as "matchedSpan"
    from unnest(${keys}::text[]) as k(key)
    join brain.nodes n
      on n.canonical_name = k.key
      or exists (select 1 from unnest(n.aliases) a where brain.canonical_text(a) = k.key)
    join brain.nodes x on x.id = brain.canonical_node(n.id)
    order by x.name`;
  return dropContainedSpans(rows);
}
