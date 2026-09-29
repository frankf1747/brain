import type { Db } from "../db.js";
import { canonicalName } from "../text/normalize.js";
import { UUID } from "../retrieve/documents.js";

export interface NodeRef {
  id: string;
  type: string;
  name: string;
}

export interface NodeEdge {
  direction: "out" | "in";
  type: string;
  otherId: string;
  otherName: string;
  otherType: string;
  evidence: string | null;
  evidenceDocumentId: string | null;
  evidenceDocumentTitle: string | null;
}

export interface NodeReport extends NodeRef {
  aliases: string[];
  properties: Record<string, unknown>;
  verified: boolean;
  isSelf: boolean;
  edges: NodeEdge[];
  facts: { id: string; predicate: string; objectText: string; verified: boolean }[];
  mentionCount: number;
  mentionedIn: { documentId: string; title: string | null; sourceKind: string }[];
}

/** Resolves a name, alias or id to the canonical node. */
export async function findNode(sql: Db, nameOrId: string): Promise<NodeRef | null> {
  const key = canonicalName(nameOrId);
  const rows = UUID.test(nameOrId)
    ? await sql<NodeRef[]>`
        select x.id, x.type, x.name from brain.nodes n join brain.nodes x on x.id = brain.canonical_node(n.id) where n.id = ${nameOrId}`
    : await sql<NodeRef[]>`
        select x.id, x.type, x.name from brain.nodes n join brain.nodes x on x.id = brain.canonical_node(n.id)
        where n.canonical_name = ${key} or ${key} = any(n.aliases) order by n.created_at limit 1`;
  return rows[0] ?? null;
}

export async function describeNode(sql: Db, nameOrId: string): Promise<NodeReport | null> {
  const ref = await findNode(sql, nameOrId);
  if (!ref) return null;
  const [node] = await sql<{ aliases: string[]; properties: Record<string, unknown>; verified: boolean; is_self: boolean }[]>`
    select aliases, properties, verified, is_self from brain.nodes where id = ${ref.id}`;
  const edges = await sql<NodeEdge[]>`
    select case when brain.canonical_node(e.from_node) = ${ref.id} then 'out' else 'in' end as direction,
           e.type, o.id as "otherId", o.name as "otherName", o.type as "otherType",
           left(c.content, 200) as evidence, c.document_id as "evidenceDocumentId", d.title as "evidenceDocumentTitle"
    from brain.edges e
    join brain.nodes o on o.id = brain.canonical_node(case when brain.canonical_node(e.from_node) = ${ref.id} then e.to_node else e.from_node end)
    left join brain.chunks c on c.id = e.evidence_chunk_id
    left join brain.documents d on d.id = c.document_id
    where brain.canonical_node(e.from_node) = ${ref.id} or brain.canonical_node(e.to_node) = ${ref.id}
    order by e.type, o.name`;
  const facts = await sql<{ id: string; predicate: string; object_text: string; verified: boolean }[]>`
    select id, predicate, object_text, verified from brain.current_facts(${ref.id})`;
  const mentionedIn = await sql<{ documentId: string; title: string | null; sourceKind: string }[]>`
    select distinct d.id as "documentId", d.title, d.source_kind as "sourceKind"
    from brain.mentions m join brain.chunks c on c.id = m.chunk_id join brain.documents d on d.id = c.document_id
    where m.node_id = ${ref.id} order by d.title`;
  const [{ n }] = await sql<{ n: string }[]>`select count(*)::text as n from brain.mentions where node_id = ${ref.id}`;
  return {
    ...ref,
    aliases: node.aliases,
    properties: node.properties,
    verified: node.verified,
    isSelf: node.is_self,
    edges,
    facts: facts.map((f) => ({ id: f.id, predicate: f.predicate, objectText: f.object_text, verified: f.verified })),
    mentionCount: Number(n),
    mentionedIn,
  };
}
