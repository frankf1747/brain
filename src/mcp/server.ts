import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { storeDocument } from "../ingest/store.js";
import { AUTHORS, keptAuthorNote } from "../ingest/author.js";
import { suppressedDocuments } from "../ingest/set-author.js";
import { runPipeline, stageCounts } from "../ingest/pipeline.js";
import { search } from "../retrieve/search.js";
import { SearchResultSchema } from "../retrieve/contract.js";
import { orient } from "../retrieve/orient.js";
import { getDocument } from "../retrieve/documents.js";
import { explain, explainNotFound } from "../retrieve/explain.js";
import { verifyClaims, VerificationSchema, ClaimInputSchema, MAX_CLAIMS } from "../verify/resolve.js";
import { describeNode } from "../graph/inspect.js";
import { addFact, supersedeFact, listFacts } from "../graph/facts.js";
import { refreshMirror } from "../obsidian/auto.js";
import { JobManager } from "./jobs.js";
import { renderSearch, renderOrient, renderNode, renderDocument, renderFacts, renderStatus, renderExplain, renderVerification, VERIFY_NOT_CHECKED } from "./render.js";

export interface ServerOptions {
  client: string;
  jobs?: JobManager;
  readOnly?: boolean;
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (err: unknown): ToolResult => ({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
const dateOrUndefined = (s?: string) => (s ? new Date(s) : undefined);
/** Dates are validated up front, so an unparseable one is an error rather than a silently dropped filter. */
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "ISO date such as 2026-09-01");
const log = (m: string) => process.stderr.write(m + "\n");

/**
 * Sent to every client at connect time and placed in the model's system prompt. Tool descriptions
 * are only seen once a tool is chosen, so the routing rule has to live here. Written as steps so
 * small models follow it.
 */
function instructions(readOnly: boolean): string {
  const lines = [
    "This server is the owner's personal knowledge base and the source of truth for anything about the owner (Frank Fu): experience, education, skills, projects, job applications, people, organizations, and anything they saved.",
    "When a question is about the owner or something they saved, use this server before answering, even if a skill, memory file, or your own knowledge seems to cover it:",
    "1. Call brain_orient once per session to see what is stored and which source_kinds exist.",
    "2. Call brain_search with the user's question in plain words. Do not add names or terms the user did not mention. Narrow with source_kinds or dates when orient shows it helps.",
    "3. For a named person, organization, or project, call brain_get_node. For the full text of a result, call brain_get_document with its document id.",
    "4. Answer from the returned passages and cite them as [P1], [F1]. Make clear which parts of the answer come from the knowledge base and which are your own. If nothing relevant comes back, say so rather than answering from elsewhere, and name any other source you use.",
    "5. After composing an answer from brain_search results, call brain_verify with the retrieval id and the answer's claims, each with the labels it cites. When presenting the answer, mark every claim whose verdict is not supported as your own addition or as weakly supported.",
    "Every brain_search result starts with `retrieval <id> · mode: <mode>`. Mode hybrid is a full search; keyword-only and fused-order mean part of it fell back, so treat its ranking as weaker. Each passage shows its score and score kind (rerank: 0 to 1, higher is stronger; rrf: reranking was skipped; -: found through a named entity or a literal match, unscored), the search branches that found it with their ranks, and who wrote it, so you can tell strong evidence from weak. brain_explain with the retrieval id replays how that search ranked its passages.",
  ];
  if (!readOnly) {
    lines.push(
      "To save something, call brain_ingest. Pass author: \"other\" when saving anything the owner did not write (articles, posts, screenshots of other people's posts, emails from others): notes, pastes and conversations default to author owner, and first-person statements in an owner document are recorded as facts about the owner.",
      "Record a fact only when the owner states it about themselves, with brain_add_fact.",
    );
  }
  return lines.join("\n");
}

export function buildServer(ctx: Ctx, opts: ServerOptions): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" }, { instructions: instructions(Boolean(opts.readOnly)) });
  const jobs = opts.jobs ?? new JobManager(ctx);
  const by = `agent:${opts.client}`;

  /**
   * Records each call in brain.tool_calls. Saved text is logged as its length only, and brain_verify's claims as their
   * count (brain.verification_log keeps them); a failed log write never fails the tool.
   */
  const record = async (tool: string, args: Record<string, unknown>, started: number, res: ToolResult) => {
    const { text: body, claims, ...rest } = args;
    const logged: Record<string, unknown> = { ...rest };
    if (typeof body === "string") logged.text_chars = body.length;
    if (Array.isArray(claims)) logged.claims_n = claims.length;
    try {
      await ctx.sql`
        insert into brain.tool_calls (client, tool, args, ok, error, duration_ms)
        values (${opts.client}, ${tool}, ${ctx.sql.json(logged as never)}, ${!res.isError},
                ${res.isError ? res.content.map((c) => c.text).join("\n") : null}, ${Date.now() - started})`;
    } catch (e) {
      log(`brain: logging ${tool} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return res;
  };
  // Same signature as server.registerTool, so every registration below keeps its argument typing.
  const register = ((name: string, config: unknown, cb: (a: Record<string, unknown>, extra: unknown) => Promise<ToolResult>) =>
    server.registerTool(name, config as never, (async (a: Record<string, unknown>, extra: unknown) => {
      const started = Date.now();
      return record(name, a ?? {}, started, await cb(a, extra));
    }) as never)) as typeof server.registerTool;

  register(
    "brain_orient",
    { title: "What the knowledge base holds", description: "Call first in a session. Returns counts by kind and type, recent documents, current facts about the owner, and guidance on which tool to use.", inputSchema: {} },
    async () => {
      try { return text(renderOrient(await orient(ctx))); } catch (e) { return fail(e); }
    },
  );

  register(
    "brain_search",
    {
      title: "Search the knowledge base",
      description:
        "Hybrid keyword and semantic search over everything the owner has saved. Expands entities named in the query (neighbours and up to 5 passages that mention each), and returns up to 10 of the owner's facts that share a term with the query or point at a named entity; use brain_get_facts or brain_orient for the full fact list. " +
        "The first line is `retrieval <id> · mode: hybrid | keyword-only | fused-order · <n> passages`. Each passage line reads `[P1] <score> <score kind> · <how found> · <source kind> · author: <owner|other|unknown> · \"<title>\" · <date> (doc <id>, chunk <id>)`: score kind rerank is 0 to 1 (higher is stronger), rrf means reranking was skipped, and - marks a passage found through a named entity (graph via <entity>) or a literal match (fallback \"<term>\"); how found lists vector#<rank> and keyword#<rank>, plus graph via <entity> when the graph also reached a ranked passage. Each fact says verified or unverified and where it came from: read from a document (from <kind> <doc id>), stated by owner, confirmed by owner (verified, no stored source passage), or extracted from a passage no longer stored. " +
        "Pass the retrieval id to brain_explain to see how the passages were ranked. The same result is returned as structuredContent. " +
        "After answering, pass the retrieval id and your answer's claims to brain_verify, which checks each claim against the passages and facts it cites.",
      inputSchema: {
        query: z.string().min(1),
        k: z.number().int().min(1).max(30).optional().describe("Number of passages, default 10"),
        source_kinds: z.array(z.string()).optional().describe("Only these kinds (kinds listed by brain_orient), e.g. [\"news\",\"conversation\"]"),
        since: isoDate.optional().describe("ISO date lower bound, e.g. 2026-09-01"),
        until: isoDate.optional().describe("ISO date upper bound, e.g. 2026-09-30"),
        verified_only: z.boolean().optional().describe("Only return facts and neighbour nodes marked verified. Passages are never filtered: documents have no verification state."),
      },
      outputSchema: SearchResultSchema,
    },
    async (a) => {
      try {
        const r = await search(ctx, a.query, { k: a.k, sourceKinds: a.source_kinds, since: dateOrUndefined(a.since), until: dateOrUndefined(a.until), verifiedOnly: a.verified_only, client: opts.client });
        return { content: [{ type: "text", text: renderSearch(r) }], structuredContent: r };
      } catch (e) { return fail(e); }
    },
  );

  register(
    "brain_get_document",
    { title: "Read a document", description: "Metadata and a slice of the raw text of one document by id. Use offset to page.", inputSchema: { document_id: z.string().describe("UUID shown as 'doc <id>' in brain_search results"), offset: z.number().int().min(0).optional(), length: z.number().int().min(1).max(20000).optional() } },
    async (a) => {
      try {
        const d = await getDocument(ctx.sql, a.document_id, a.offset ?? 0, a.length ?? 4000);
        return d ? text(renderDocument(d)) : fail(new Error(`Document ${a.document_id} not found`));
      } catch (e) { return fail(e); }
    },
  );

  register(
    "brain_get_node",
    { title: "Inspect an entity", description: "A person, organization, place, project, concept, event or artifact by name, alias or id: relationships with evidence, facts, and where it is mentioned.", inputSchema: { name_or_id: z.string().min(1) } },
    async (a) => {
      try {
        const n = await describeNode(ctx.sql, a.name_or_id);
        return n ? text(renderNode(n)) : fail(new Error(`No entity matches "${a.name_or_id}"`));
      } catch (e) { return fail(e); }
    },
  );

  register(
    "brain_get_facts",
    { title: "Facts about the owner", description: "Current facts about the owner with ids and verification state. all=true includes superseded and expired facts.", inputSchema: { all: z.boolean().optional() } },
    async (a) => {
      try { return text(renderFacts(await listFacts(ctx.sql, Boolean(a.all)))); } catch (e) { return fail(e); }
    },
  );

  register(
    "brain_status",
    { title: "Ingestion status", description: "Pipeline stage counts, failures, documents still processing in this server, and documents whose facts about the owner were suppressed because someone else wrote them.", inputSchema: {} },
    async () => {
      try {
        const failures = await ctx.sql<{ document_id: string; stage: string; error: string }[]>`
          select document_id, stage, error from brain.ingest_jobs where error is not null order by updated_at desc limit 10`;
        return text(renderStatus(await stageCounts(ctx), jobs.pending, failures, await suppressedDocuments(ctx.sql)));
      } catch (e) { return fail(e); }
    },
  );

  register(
    "brain_explain",
    {
      title: "Explain a search",
      description:
        "Replays a logged brain_search from its retrieval id (the id on the result's first line) without searching again: the query, filters, client and time, the mode and which parts fell back, how many candidates each branch produced, stage timings, and for every returned passage its rank and label, score and score kind, layers, vector, keyword and rerank ranks, title and author. Reads the log only.",
      inputSchema: { retrieval_id: z.string().min(1).describe("The id after 'retrieval' on the first line of a brain_search result") },
    },
    async (a) => {
      try {
        const e = await explain(ctx.sql, a.retrieval_id);
        return e ? text(renderExplain(e)) : fail(new Error(explainNotFound(a.retrieval_id)));
      } catch (e) { return fail(e); }
    },
  );

  register(
    "brain_verify",
    {
      title: "Check an answer against its sources",
      description:
        "Checks each claim of an answer you wrote from a brain_search result against the passages and facts it cites, with no model call. Pass the retrieval id from the result's first line and each claim with the labels it cites (P1, F2; passage chunk ids and fact ids also work; [] for a claim of your own). " +
        "For each claim it compares the claim's content words (Postgres English stemming, stopwords removed) with the cited texts, requires every number, date and code in the claim to appear in them (1,000 = 1000, ~11% = 11 percent, $115k = $115,000, Sep 29, 2026 = 2026-09-29; -5% is not 5%, v2.5 is not v2.7, 3/4/2026 and 555-1234 are compared as written), checks that negation agrees, and requires every polarity word of the claim (up, down, before, after, over, under, more, less, all, some, only, will, might, can, should, …) to appear in the cited text. " +
        "Verdicts: supported (at least 60% of the claim's content words are in the cited text, every number and polarity word appears, negation agrees, and no missing word is a number or ordinal word such as one, first or dozen); partial (at least 30%, or one of those checks fails); unsupported (under 30%); uncited (no cites); bad_citation (no cite exists in that search). " +
        `Limits: it checks vocabulary overlap, not logic. Not checked: ${VERIFY_NOT_CHECKED.join("; ")}. Treat supported as "the cited text contains this claim's words and numbers", not as proof. ` +
        `At most ${MAX_CLAIMS} claims of at most 2,000 characters each. Writes one audit row to brain.verification_log and changes nothing in the knowledge base. The same result is returned as structuredContent.`,
      inputSchema: {
        retrieval_id: z.string().min(1).describe("The id after 'retrieval' on the first line of the brain_search result the answer was written from"),
        claims: z.array(ClaimInputSchema).min(1).max(MAX_CLAIMS).describe("The answer split into claims (one sentence each is usual), each with the labels it cites"),
      },
      outputSchema: VerificationSchema,
    },
    async (a) => {
      try {
        const v = await verifyClaims(ctx.sql, a.retrieval_id, a.claims, { client: opts.client });
        return v ? { content: [{ type: "text", text: renderVerification(v) }], structuredContent: v } : fail(new Error(explainNotFound(a.retrieval_id)));
      } catch (e) { return fail(e); }
    },
  );

  if (opts.readOnly) return server;

  register(
    "brain_ingest",
    {
      title: "Save to the knowledge base",
      description:
        "Store any text: a note, a pasted article, a conversation, a job description. Set author to who wrote the text: \"owner\" for the owner's own writing, \"other\" for anything someone else wrote (articles, posts, screenshots of other people's posts, emails from others), \"unknown\" if unsure. Pass author: \"other\" for someone else's writing even when you save it as a note: when author is omitted it defaults by source_kind, and note, paste and conversation default to owner, which would record the writer's first-person statements as facts about the owner. Returns immediately after storing and chunking; summary, embeddings and entity extraction continue in the background.",
      inputSchema: {
        text: z.string().min(1),
        title: z.string().optional(),
        source_kind: z.string().optional().describe("Free label: note, conversation, news, job_description, email, paper, paste"),
        author: z.enum(AUTHORS).optional().describe("owner (the owner wrote it), other (someone else did), or unknown. Default by source_kind: note, paste, conversation, resume → owner; news, paper, job_description, email → other; anything else → unknown."),
        origin: z.string().optional().describe("URL, file path or other provenance"),
        occurred_at: isoDate.optional().describe("ISO date the content is about, e.g. 2026-09-01"),
        metadata: z.record(z.string(), z.string()).optional(),
      },
    },
    async (a) => {
      try {
        const { id, created, author } = await storeDocument(ctx.sql, {
          text: a.text, title: a.title ?? null, sourceKind: a.source_kind ?? "paste", author: a.author, origin: a.origin ?? `mcp:${opts.client}`,
          metadata: { ...(a.metadata ?? {}), saved_by: opts.client }, occurredAt: dateOrUndefined(a.occurred_at) ?? null,
        });
        const first = await runPipeline(ctx, id, { until: "chunked" });
        const saved = created ? "Saved" : "Already present";
        const kept = created ? null : keptAuthorNote(id, author, a.author);
        const note = kept ? ` Note: ${kept}.` : "";
        if (first.skipped) {
          return text(`${saved}: document ${id} (stage ${first.stage}). Processing is already under way in another runner; brain_status shows progress.${note}`);
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
        return text(`${saved}: document ${id} (stage ${first.stage}). Summary, embeddings and extraction continue in the background; brain_status shows progress.${resumed.length ? ` Also resumed ${resumed.length} stalled job(s).` : ""}${note}`);
      } catch (e) { return fail(e); }
    },
  );

  register(
    "brain_add_fact",
    { title: "Record a fact about the owner", description: "Only for things the owner states about themselves. Stored unverified until the owner verifies it.", inputSchema: { predicate: z.string().trim().min(1).describe("snake_case, e.g. lives_in, prefers, visa_status"), object_text: z.string().trim().min(1), valid_from: isoDate.optional().describe("ISO date the fact holds from, e.g. 2026-09-01") } },
    async (a) => {
      try {
        const { id, predicate } = await addFact(ctx.sql, { predicate: a.predicate, objectText: a.object_text, by, validFrom: dateOrUndefined(a.valid_from) ?? null });
        refreshMirror(ctx); // facts appear on the self note
        return text(`Recorded fact ${id}: ${predicate} = ${a.object_text} (unverified, ${by}).`);
      } catch (e) { return fail(e); }
    },
  );

  register(
    "brain_supersede_fact",
    { title: "Correct a fact", description: "Replace a fact's value. The old fact is kept as history and marked superseded.", inputSchema: { fact_id: z.string().describe("id from brain_get_facts"), object_text: z.string().trim().min(1), valid_from: isoDate.optional().describe("ISO date the new value holds from, e.g. 2026-09-01") } },
    async (a) => {
      try {
        const id = await supersedeFact(ctx.sql, a.fact_id, { objectText: a.object_text, by, validFrom: dateOrUndefined(a.valid_from) ?? null });
        refreshMirror(ctx);
        return text(`Superseded fact ${a.fact_id} with fact ${id}: ${a.object_text} (unverified, ${by}).`);
      } catch (e) { return fail(e); }
    },
  );

  return server;
}
