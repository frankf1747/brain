import { z } from "zod";
import type postgres from "postgres";
import type { Ctx } from "../../ctx.js";
import type { Db } from "../../db.js";
import { isRefusal, isSchemaFailure } from "../../llm/errors.js";
import type { Author } from "../author.js";
import { config } from "../../config.js";

export const EntitySchema = z.object({
  key: z.string().describe("Short key unique within this output, such as e1, e2."),
  type: z.string().describe("Exactly one of the node type names listed in the instructions."),
  name: z.string().describe("The entity's full name as the text gives it."),
  aliases: z.array(z.string()).describe("Other names or abbreviations the text uses for it."),
  untyped_hint: z.string().nullable().describe("When no listed type fits and you used concept, say what kind of thing it is. Otherwise null."),
  quote: z.string().describe("A short verbatim quote from the text where this entity appears."),
});

export const RelationSchema = z.object({
  from_key: z.string(),
  to_key: z.string(),
  type: z.string().describe("Exactly one of the edge type names listed in the instructions."),
  confidence: z.number().describe("0 to 1."),
  valid_from: z.string().nullable().describe("ISO 8601 date or null."),
  valid_to: z.string().nullable().describe("ISO 8601 date or null."),
  quote: z.string().describe("A short verbatim quote supporting the relation."),
});

export const FactSchema = z.object({
  predicate: z.string().describe("lowercase snake_case, such as visa_status, prefers, graduated_from, salary_expectation."),
  object_text: z.string().describe("The value, as a short human-readable string."),
  object_key: z.string().nullable().describe("Key of an extracted entity when the value is one, else null."),
  confidence: z.number(),
  valid_from: z.string().nullable(),
  valid_to: z.string().nullable(),
  quote: z.string().describe("A short verbatim quote supporting the fact."),
});

export const ExtractionSchema = z.object({
  entities: z.array(EntitySchema),
  relations: z.array(RelationSchema),
  facts_about_self: z.array(FactSchema),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface Registries {
  nodeTypes: { name: string; description: string }[];
  edgeTypes: { name: string; description: string }[];
  selfName: string;
}

export async function loadRegistries(sql: Db): Promise<Registries> {
  const [nodeTypes, edgeTypes, [self]] = await Promise.all([
    sql<{ name: string; description: string }[]>`select name, description from brain.node_types order by name`,
    sql<{ name: string; description: string }[]>`select name, description from brain.edge_types order by name`,
    sql<{ name: string }[]>`select name from brain.nodes where is_self`,
  ]);
  return { nodeTypes, edgeTypes, selfName: self?.name ?? "the owner" };
}

export function extractionSystem(reg: Registries, author: Author = "owner"): string {
  const nodeList = reg.nodeTypes.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const edgeList = reg.edgeTypes.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const predicateList = Object.entries(config.factPredicates).map(([name, means]) => `- ${name}: ${means}`).join("\n");
  const owner = reg.selfName;
  // Who "I" is decides whether a statement is about the owner. Only the owner's own documents map
  // first-person pronouns to the owner; resolve.ts enforces the same rule whatever the model returns.
  const whoRules =
    author === "owner"
      ? `- The owner, ${owner}, may appear as "I", "me", "my" or by name. When the text states a relationship between the owner and another entity (applied to, works at, studied at, knows, created), include the owner as a person entity named exactly "${owner}" and add the relation.`
      : `- ${author === "other" ? `This document was written by someone other than the owner, ${owner}.` : `Who wrote this document is unknown; treat its author as someone other than the owner, ${owner}.`} First-person pronouns ("I", "me", "my", "we", "our") refer to the document's author, who is not the owner. Never map them to the owner.
- Include the owner as a person entity named exactly "${owner}" only where the text names the owner. Relations from the owner are allowed only when the text names the owner and states that relationship.`;
  const factsRule =
    author === "owner"
      ? "- facts_about_self: durable statements about the owner that stay true until something changes them: identity, status (visa, employment, education), skills, preferences, goals, locations the owner lives in or accepts, commitments. Do not record one-off events, advice received, or next steps as facts; those belong in the graph as events and relations. Never put facts about other people here. Leave it empty when the document says nothing durable about the owner."
      : `- facts_about_self must be empty unless the text names the owner, ${owner}, and states something about them; then record only that. The author's own experience, opinions, recommendations and plans are never facts about the owner. Never put facts about other people here.`;
  return `You extract a knowledge graph from one document for the personal knowledge base of ${owner}.

Node types (use exactly these names):
${nodeList}

Edge types (use exactly these names):
${edgeList}

Rules:
- Extract every named person, organization, place, project, event and artifact. Extract a concept only when it is a clear topic of the text, not every noun.
- Use the listed types. If nothing fits, use "concept" and fill untyped_hint with what kind of thing it is.
- One entity per real-world thing. If the text refers to the same thing in several ways, emit it once and put the other forms in aliases.
${whoRules}
- Every entity, relation and fact carries a short verbatim quote copied from the text.
- Relations: only those the text states or clearly implies. confidence is 0 to 1. Direction matters: from_key and to_key must follow the direction in the edge type's description (for example created goes from the maker to the thing made).
${factsRule}
- A fact's predicate names the relation, never the thing it points at: working_on "Microsoft Capstone", not capstone_project or capstone_partner. Write values in full and the same way each time: "Fall 2026", not "F26".
- valid_from and valid_to mean the period during which a fact or relation holds. Leave valid_to null unless the text says it stopped being true. Do not put an event's date in valid_to.
- Dates are ISO 8601 or null. Never invent names, dates or numbers.

Fact predicates (reuse one when it fits; coin a new lowercase snake_case one only when none does):
${predicateList}
`;
}

/** The lines above the text in every extraction request, online and batch (backfill.ts builds its requests here too). */
export function extractionHeader(doc: { title: string | null; source_kind: string; author: Author; origin: string | null; summary_line: string | null }): string {
  return [
    `Document title: ${doc.title ?? "(none)"}`,
    `Source kind: ${doc.source_kind}`,
    `Author: ${doc.author}`,
    `Origin: ${doc.origin ?? "(none)"}`,
    `Document summary: ${doc.summary_line ?? "(none)"}`,
  ].join("\n");
}

export interface ExtractionRequest {
  documentId: string;
  sectionChunkId: string;
  system: string;
  user: string;
}

export async function buildExtractionRequests(sql: Db, documentId: string): Promise<ExtractionRequest[]> {
  const reg = await loadRegistries(sql);
  const [doc] = await sql<{ title: string | null; source_kind: string; author: Author; origin: string | null; raw_content: string; summary_line: string | null }[]>`
    select title, source_kind, author, origin, raw_content, summary_line from brain.documents where id = ${documentId}`;
  if (!doc) throw new Error(`Document ${documentId} not found`);
  const sections = await sql<{ id: string; content: string; ordinal: number }[]>`
    select id, content, ordinal from brain.chunks where document_id = ${documentId} and level = 0 order by ordinal`;
  if (sections.length === 0) return []; // nothing to extract from; the document proceeds
  const system = extractionSystem(reg, doc.author);
  const header = extractionHeader(doc);
  if (sections.length === 1) {
    return [{ documentId, sectionChunkId: sections[0].id, system, user: `${header}\n\n<text>\n${doc.raw_content}\n</text>` }];
  }
  return sections.map((s) => ({
    documentId,
    sectionChunkId: s.id,
    system,
    user: `${header}\nSection ${s.ordinal + 1} of ${sections.length}\n\n<text>\n${s.content}\n</text>`,
  }));
}

export async function applyExtraction(sql: Db, req: ExtractionRequest, payload: Extraction, model: string): Promise<void> {
  await sql`
    insert into brain.extractions (document_id, section_chunk_id, model, payload)
    values (${req.documentId}, ${req.sectionChunkId}, ${model}, ${sql.json(payload as unknown as postgres.JSONValue)})
    on conflict (document_id, section_chunk_id)
    do update set payload = excluded.payload, model = excluded.model, created_at = now()`;
}

/** Records that extraction was skipped for (part of) a document, so it can still advance. */
export async function markExtractionSkipped(sql: Db, documentId: string): Promise<void> {
  await sql`update brain.documents set metadata = metadata || '{"extraction":"skipped"}'::jsonb where id = ${documentId}`;
}

/** One call with one retry on a schema failure. Returns null on a refusal or a second schema failure; other errors throw. */
async function extractWithRetry(ctx: Ctx, req: ExtractionRequest): Promise<Extraction | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await ctx.llm.structured({ schema: ExtractionSchema, system: req.system, user: req.user });
    } catch (err) {
      if (isRefusal(err)) return null;
      if (!isSchemaFailure(err)) throw err;
    }
  }
  return null;
}

/** Stage 5. Refusals and repeated schema failures skip extraction for the section; other errors propagate so the pipeline records them. */
export async function runExtract(ctx: Ctx, documentId: string): Promise<void> {
  const requests = await buildExtractionRequests(ctx.sql, documentId);
  for (const req of requests) {
    const payload = await extractWithRetry(ctx, req);
    if (payload) {
      await applyExtraction(ctx.sql, req, payload, ctx.llm.model);
    } else {
      await markExtractionSkipped(ctx.sql, documentId);
    }
  }
}
