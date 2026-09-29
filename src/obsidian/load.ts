import type { Db } from "../db.js";

export interface GNode {
  id: string;
  type: string;
  name: string;
  aliases: string[];
  properties: Record<string, unknown>;
  verified: boolean;
  isSelf: boolean;
  createdAt: Date;
}

export interface GEdge {
  id: string;
  fromNode: string;
  toNode: string;
  type: string;
  evidence: string | null;
  evidenceDocumentId: string | null;
}

export interface GMention {
  nodeId: string;
  documentId: string;
}

export interface GFact {
  id: string;
  subjectId: string;
  predicate: string;
  objectText: string;
  objectNodeId: string | null;
  verified: boolean;
  verifiedBy: string | null;
  documentId: string | null;
}

export interface GDocument {
  id: string;
  title: string | null;
  sourceKind: string;
  origin: string | null;
  occurredAt: Date | null;
  ingestedAt: Date;
  summary: string | null;
  raw: string;
}

export interface Graph {
  nodes: GNode[];
  self: GNode | null;
  edges: GEdge[];
  mentions: GMention[];
  facts: GFact[];
  documents: GDocument[];
}

export async function loadGraph(sql: Db): Promise<Graph> {
  const [nodes, edges, mentions, facts, documents] = await Promise.all([
    sql<GNode[]>`
      select id, type, name, aliases, properties, verified, is_self as "isSelf", created_at as "createdAt"
      from brain.nodes where merged_into is null order by type, name`,
    sql<GEdge[]>`
      select e.id, brain.canonical_node(e.from_node) as "fromNode", brain.canonical_node(e.to_node) as "toNode", e.type,
             left(c.content, 200) as evidence, c.document_id as "evidenceDocumentId"
      from brain.edges e left join brain.chunks c on c.id = e.evidence_chunk_id
      where e.valid_to is null or e.valid_to >= current_date
      order by e.type`,
    sql<GMention[]>`
      select distinct brain.canonical_node(m.node_id) as "nodeId", c.document_id as "documentId"
      from brain.mentions m join brain.chunks c on c.id = m.chunk_id`,
    // Same collapsing as listFacts: one row per (subject, predicate, lower(value)), verified first, then earliest.
    sql<(GFact & { createdAt: Date })[]>`
      select * from (
        select distinct on (f.subject_id, f.predicate, lower(f.object_text))
               f.id, f.subject_id as "subjectId", f.predicate, f.object_text as "objectText", f.object_node_id as "objectNodeId",
               f.verified, f.verified_by as "verifiedBy", c.document_id as "documentId", f.created_at as "createdAt"
        from brain.facts f left join brain.chunks c on c.id = f.source_chunk_id
        where f.superseded_by is null and (f.valid_to is null or f.valid_to >= current_date)
        order by f.subject_id, f.predicate, lower(f.object_text), f.verified desc, f.created_at
      ) d order by predicate, "createdAt"`,
    sql<GDocument[]>`
      select id, title, source_kind as "sourceKind", origin, occurred_at as "occurredAt", ingested_at as "ingestedAt", summary, raw_content as raw
      from brain.documents order by ingested_at`,
  ]);
  return { nodes, self: nodes.find((n) => n.isSelf) ?? null, edges, mentions, facts: facts.map(({ createdAt: _c, ...f }) => f), documents };
}
