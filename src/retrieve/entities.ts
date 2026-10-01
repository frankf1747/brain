import type { Db } from "../db.js";
import { canonicalName } from "../text/normalize.js";
import { config } from "../config.js";

const STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "for", "to", "in", "on", "at", "with", "about", "from", "by", "as",
  "my", "me", "i", "you", "your", "we", "our", "it", "its", "this", "that", "these", "those",
  "do", "does", "did", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "what", "who", "where", "when", "why", "how", "which", "tell", "show", "list", "find", "give", "can", "know", "knows", "say", "said",
]);

const MAX_SPAN = 6;

function tokens(query: string): string[] {
  return query
    .replace(/["“”?,!;:()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^(.+?)(?:['’]s|['’])$/, "$1").replace(/\.$/, ""))
    .filter(Boolean);
}

/** Quoted strings plus every 1..6-token span whose first and last token are not stopwords (a leading "the" is allowed on 2+ tokens). Case is kept for display; matching is canonical. */
export function candidateSpans(query: string): string[] {
  const spans = new Set<string>();
  for (const m of query.matchAll(/["“]([^"”]+)["”]/g)) spans.add(m[1].trim());
  const toks = tokens(query);
  for (let n = MAX_SPAN; n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const span = toks.slice(i, i + n);
      const leadingThe = n >= 2 && span[0].toLowerCase() === "the";
      if ((!leadingThe && STOPWORDS.has(span[0].toLowerCase())) || STOPWORDS.has(span[n - 1].toLowerCase())) continue;
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

/** Longest matched span first, then name; at most `max` entities. */
export function rankEntities(refs: EntityRef[], max: number): EntityRef[] {
  return [...refs]
    .sort((a, b) => b.matchedSpan.length - a.matchedSpan.length || a.name.localeCompare(b.name))
    .slice(0, max);
}

export async function detectEntities(sql: Db, query: string): Promise<EntityRef[]> {
  const keys = [...new Set(candidateSpans(query).map(canonicalName).filter(Boolean))];
  if (keys.length === 0) return [];
  // Aliases are stored canonical (resolve.ts), so both sides are plain text comparisons the indexes can serve.
  const rows = await sql<EntityRef[]>`
    select distinct x.id, x.type, x.name, k.key as "matchedSpan"
    from brain.nodes n
    cross join lateral unnest(${keys}::text[]) k(key)
    join brain.nodes x on x.id = brain.canonical_node(n.id)
    where (n.canonical_name = any(${keys}::text[]) or n.aliases && ${keys}::text[])
      and (n.canonical_name = k.key or k.key = any(n.aliases))
    order by x.name`;
  return rankEntities(dropContainedSpans(rows), config.graph.maxEntities);
}
