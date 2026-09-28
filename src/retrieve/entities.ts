import type { Db } from "../db.js";
import { canonicalName } from "../text/normalize.js";

const CONNECTORS = new Set(["of", "and", "the", "for", "de", "&"]);
const QUESTION_WORDS = new Set(["who", "what", "where", "when", "why", "how", "which", "does", "did", "is", "are", "was", "were", "tell", "show", "list", "find", "give", "do", "can", "i"]);

/** Quoted strings plus runs of capitalized tokens (allowing small connectors between them). */
export function candidateNames(query: string): string[] {
  const names = new Set<string>();
  for (const m of query.matchAll(/["“]([^"”]+)["”]/g)) names.add(m[1].trim());
  const tokens = query.replace(/["“”?,!;:()]/g, " ").split(/\s+/).filter(Boolean);
  let run: string[] = [];
  const flush = () => {
    while (run.length && CONNECTORS.has(run[run.length - 1].toLowerCase())) run.pop();
    if (run.length === 1 && QUESTION_WORDS.has(run[0].toLowerCase())) run = [];
    if (run.length) names.add(run.join(" "));
    run = [];
  };
  for (const t of tokens) {
    if (/^[A-Z]/.test(t)) run.push(t.replace(/\.$/, ""));
    else if (run.length && CONNECTORS.has(t.toLowerCase())) run.push(t);
    else flush();
  }
  flush();
  return [...names].filter((n) => n.length > 1);
}

export interface EntityRef {
  id: string;
  type: string;
  name: string;
}

export async function detectEntities(sql: Db, query: string): Promise<EntityRef[]> {
  const keys = candidateNames(query).map(canonicalName).filter(Boolean);
  if (keys.length === 0) return [];
  return sql<EntityRef[]>`
    select distinct x.id, x.type, x.name
    from brain.nodes n
    join brain.nodes x on x.id = brain.canonical_node(n.id)
    where n.canonical_name = any(${keys}::text[]) or n.aliases && ${keys}::text[]
    order by x.name`;
}
