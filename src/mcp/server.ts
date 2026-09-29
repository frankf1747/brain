import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { storeDocument } from "../ingest/store.js";
import { runPipeline, stageCounts } from "../ingest/pipeline.js";
import { search } from "../retrieve/search.js";
import { orient } from "../retrieve/orient.js";
import { getDocument } from "../retrieve/documents.js";
import { describeNode } from "../graph/inspect.js";
import { addFact, supersedeFact, listFacts } from "../graph/facts.js";
import { JobManager } from "./jobs.js";
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus } from "./render.js";

export interface ServerOptions {
  client: string;
  jobs?: JobManager;
  readOnly?: boolean;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (err: unknown): ToolResult => ({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
const dateOrUndefined = (s?: string) => (s ? new Date(s) : undefined);
/** Dates are validated up front, so an unparseable one is an error rather than a silently dropped filter. */
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "ISO date such as 2026-09-01");
const log = (m: string) => process.stderr.write(m + "\n");

export function buildServer(ctx: Ctx, opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" });
  const jobs = opts.jobs ?? new JobManager(ctx);
  const by = `agent:${opts.client}`;

  server.registerTool(
    "brain_orient",
    { title: "What the knowledge base holds", description: "Call first in a session. Returns counts by kind and type, recent documents, current facts about the owner, and guidance on which tool to use.", inputSchema: {} },
    async () => {
      try { return text(renderOrient(await orient(ctx))); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_search",
    {
      title: "Search the knowledge base",
      description: "Hybrid keyword and semantic search over everything the owner has saved, with entity expansion and the owner's facts. Returns numbered passages with document and chunk ids.",
      inputSchema: {
        query: z.string().min(1),
        k: z.number().int().min(1).max(30).optional().describe("Number of passages, default 10"),
        source_kinds: z.array(z.string()).optional().describe("Only these kinds (kinds listed by brain_orient), e.g. [\"news\",\"conversation\"]"),
        since: isoDate.optional().describe("ISO date lower bound, e.g. 2026-09-01"),
        until: isoDate.optional().describe("ISO date upper bound, e.g. 2026-09-30"),
        verified_only: z.boolean().optional(),
      },
    },
    async (a) => {
      try {
        const r = await search(ctx, a.query, { k: a.k, sourceKinds: a.source_kinds, since: dateOrUndefined(a.since), until: dateOrUndefined(a.until), verifiedOnly: a.verified_only, client: opts.client });
        return text(renderSearch(r));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_get_document",
    { title: "Read a document", description: "Metadata and a slice of the raw text of one document by id. Use offset to page.", inputSchema: { document_id: z.string().describe("UUID shown as 'document <id>' in brain_search results"), offset: z.number().int().min(0).optional(), length: z.number().int().min(1).max(20000).optional() } },
    async (a) => {
      try {
        const d = await getDocument(ctx.sql, a.document_id, a.offset ?? 0, a.length ?? 4000);
        return d ? text(renderDocument(d)) : fail(new Error(`Document ${a.document_id} not found`));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_get_node",
    { title: "Inspect an entity", description: "A person, organization, place, project, concept, event or artifact by name, alias or id: relationships with evidence, facts, and where it is mentioned.", inputSchema: { name_or_id: z.string().min(1) } },
    async (a) => {
      try {
        const n = await describeNode(ctx.sql, a.name_or_id);
        return n ? text(renderNode(n)) : fail(new Error(`No entity matches "${a.name_or_id}"`));
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_get_facts",
    { title: "Facts about the owner", description: "Current facts about the owner with ids and verification state. all=true includes superseded and expired facts.", inputSchema: { all: z.boolean().optional() } },
    async (a) => {
      try { return text(renderFacts(await listFacts(ctx.sql, Boolean(a.all)))); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_status",
    { title: "Ingestion status", description: "Pipeline stage counts, failures, and documents still processing in this server.", inputSchema: {} },
    async () => {
      try {
        const failures = await ctx.sql<{ document_id: string; stage: string; error: string }[]>`
          select document_id, stage, error from brain.ingest_jobs where error is not null order by updated_at desc limit 10`;
        return text(renderStatus(await stageCounts(ctx), jobs.pending, failures));
      } catch (e) { return fail(e); }
    },
  );

  if (opts.readOnly) return server;

  server.registerTool(
    "brain_ingest",
    {
      title: "Save to the knowledge base",
      description: "Store any text: a note, a pasted article, a conversation, a job description. Returns immediately after storing and chunking; summary, embeddings and entity extraction continue in the background.",
      inputSchema: {
        text: z.string().min(1),
        title: z.string().optional(),
        source_kind: z.string().optional().describe("Free label: note, conversation, news, job_description, email, paper, paste"),
        origin: z.string().optional().describe("URL, file path or other provenance"),
        occurred_at: isoDate.optional().describe("ISO date the content is about, e.g. 2026-09-01"),
        metadata: z.record(z.string(), z.string()).optional(),
      },
    },
    async (a) => {
      try {
        const { id, created } = await storeDocument(ctx.sql, {
          text: a.text, title: a.title ?? null, sourceKind: a.source_kind ?? "paste", origin: a.origin ?? `mcp:${opts.client}`,
          metadata: { ...(a.metadata ?? {}), saved_by: opts.client }, occurredAt: dateOrUndefined(a.occurred_at) ?? null,
        });
        const first = await runPipeline(ctx, id, { until: "chunked" });
        const saved = created ? "Saved" : "Already present";
        if (first.skipped) {
          return text(`${saved}: document ${id} (stage ${first.stage}). Processing is already under way in another runner; brain_status shows progress.`);
        }
        if (first.error) return fail(new Error(`Stored as document ${id} but chunking failed: ${first.error}`));
        jobs.start(id);
        let resumed: string[] = [];
        try {
          resumed = await jobs.resumeStalled();
        } catch (e) {
          // The document is stored and queued; failing to resume others must not turn this into an error.
          log(`brain: resuming stalled jobs failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return text(`${saved}: document ${id} (stage ${first.stage}). Summary, embeddings and extraction continue in the background; brain_status shows progress.${resumed.length ? ` Also resumed ${resumed.length} stalled job(s).` : ""}`);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_add_fact",
    { title: "Record a fact about the owner", description: "Only for things the owner states about themselves. Stored unverified until the owner verifies it.", inputSchema: { predicate: z.string().trim().min(1).describe("snake_case, e.g. lives_in, prefers, visa_status"), object_text: z.string().trim().min(1), valid_from: isoDate.optional().describe("ISO date the fact holds from, e.g. 2026-09-01") } },
    async (a) => {
      try {
        const { id, predicate } = await addFact(ctx.sql, { predicate: a.predicate, objectText: a.object_text, by, validFrom: dateOrUndefined(a.valid_from) ?? null });
        return text(`Recorded fact ${id}: ${predicate} = ${a.object_text} (unverified, ${by}).`);
      } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "brain_supersede_fact",
    { title: "Correct a fact", description: "Replace a fact's value. The old fact is kept as history and marked superseded.", inputSchema: { fact_id: z.string().describe("id from brain_get_facts"), object_text: z.string().trim().min(1), valid_from: isoDate.optional().describe("ISO date the new value holds from, e.g. 2026-09-01") } },
    async (a) => {
      try {
        const id = await supersedeFact(ctx.sql, a.fact_id, { objectText: a.object_text, by, validFrom: dateOrUndefined(a.valid_from) ?? null });
        return text(`Superseded fact ${a.fact_id} with fact ${id}: ${a.object_text} (unverified, ${by}).`);
      } catch (e) { return fail(e); }
    },
  );

  return server;
}
