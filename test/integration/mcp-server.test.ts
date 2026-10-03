import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { buildServer } from "../../src/mcp/server.js";
import { JobManager } from "../../src/mcp/jobs.js";
import { storeDocument } from "../../src/ingest/store.js";
import type { ObsidianAutoProjector } from "../../src/obsidian/auto.js";
import { SearchResultSchema } from "../../src/retrieve/contract.js";
import { renderSearch, renderVerification } from "../../src/mcp/render.js";
import { VerificationSchema } from "../../src/verify/resolve.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: null } : fakeExtraction;

async function connect(readOnly = false, llmHandler: (args: { system: string; user: string }) => unknown = handler) {
  const ctx = fakeCtx(sql, llmHandler);
  const jobs = new JobManager(ctx, () => {});
  const server = buildServer(ctx, { client: "test", jobs, readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const content = res.content as { type: string; text: string }[];
    return { text: content.map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
  };
  return { ctx, jobs, client, call, close: () => Promise.all([client.close(), server.close()]) };
}

describe("brain MCP server", () => {
  it("tells clients to pass author other for text the owner did not write", async () => {
    const s = await connect();
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain('author: "other"');
    const tools = (await s.client.listTools()).tools;
    const ingestTool = tools.find((t) => t.name === "brain_ingest")!;
    expect(ingestTool.description).toContain('author: "other"');
    await s.close();
    const ro = await connect(true);
    expect(ro.client.getInstructions() ?? "").not.toContain("brain_ingest");
    await ro.close();
  });

  it("brain_orient reports today's Voyage tokens against the cap", async () => {
    await sql`
      insert into brain.provider_usage (provider, operation, model, requests, estimated_tokens, tokens, status, client)
      values ('voyage', 'embed_query', 'voyage-test', 1, 1000, 1234, 'ok', 'test')`;
    const s = await connect();
    const orient = await s.call("brain_orient");
    expect(orient.text).toMatch(/Voyage today: 1,234 of [\d,]+ tokens/);
    await s.close();
  });

  it("records who wrote a saved document and shows it when reading it", async () => {
    const s = await connect();
    const other = await s.call("brain_ingest", { text: "I think Databricks costs too much.", source_kind: "note", author: "other" });
    const mine = await s.call("brain_ingest", { text: "I moved to Denver last week.", source_kind: "note" });
    await s.jobs.drain();
    const otherId = /document ([0-9a-f-]{36})/.exec(other.text)![1];
    const mineId = /document ([0-9a-f-]{36})/.exec(mine.text)![1];
    expect((await s.call("brain_get_document", { document_id: otherId })).text).toContain("author: other");
    expect((await s.call("brain_get_document", { document_id: mineId })).text).toContain("author: owner");
    const bad = await s.call("brain_ingest", { text: "x", author: "someone" });
    expect(bad.isError).toBe(true);
    await s.close();
  });

  it("lists eleven tools, or eight when read-only (brain_explain and brain_verify are read-only)", async () => {
    const a = await connect();
    expect((await a.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "brain_add_fact", "brain_explain", "brain_get_document", "brain_get_facts", "brain_get_node", "brain_ingest", "brain_orient", "brain_search", "brain_status", "brain_supersede_fact", "brain_verify",
    ]);
    await a.close();
    const b = await connect(true);
    expect((await b.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "brain_explain", "brain_get_document", "brain_get_facts", "brain_get_node", "brain_orient", "brain_search", "brain_status", "brain_verify",
    ]);
    await b.close();
  });

  it("brain_explain replays a brain_search from its retrieval id, also read-only, and says when the id is unknown", async () => {
    const s = await connect();
    await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    await s.jobs.drain();
    const found = await s.call("brain_search", { query: "Acme Corp visa", k: 5 });
    const id = /^retrieval ([0-9a-f-]{36}) · mode: hybrid/.exec(found.text)![1];
    await s.close();
    const ro = await connect(true);
    const ex = await ro.call("brain_explain", { retrieval_id: id });
    expect(ex.isError).toBe(false);
    expect(ex.text.split("\n")[0]).toMatch(new RegExp(`^retrieval ${id} · logged \\S+ · client test$`));
    expect(ex.text).toContain('query: "Acme Corp visa"');
    expect(ex.text).toContain("mode: hybrid · k 5");
    expect(ex.text).toMatch(/#1 \[P1\] score \d\.\d\d \(rerank\) · layers /);
    const missing = await ro.call("brain_explain", { retrieval_id: "00000000-0000-0000-0000-000000000000" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('No logged search has retrieval id "00000000-0000-0000-0000-000000000000"');
    expect((await sql`select id from brain.retrieval_log`).length).toBe(1);
    await ro.close();
  });

  it("brain_verify checks an answer's claims against a brain_search result, read-only, and logs one audit row", async () => {
    const s = await connect();
    await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    await s.jobs.drain();
    const found = await s.call("brain_search", { query: "Acme Corp visa", k: 5 });
    const id = /^retrieval ([0-9a-f-]{36}) · mode: hybrid/.exec(found.text)![1];
    await s.close();
    const ro = await connect(true);
    await ro.client.listTools(); // the client validates structuredContent against the advertised outputSchema
    const res = await ro.client.callTool({
      name: "brain_verify",
      arguments: {
        retrieval_id: id,
        claims: [
          { text: "I applied to Acme Corp in September.", cites: ["P1"] },
          { text: "Northwind builds rockets in Ohio.", cites: ["P1"] },
        ],
      },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    const v = VerificationSchema.parse(res.structuredContent);
    expect(v.claims.map((c) => c.verdict)).toEqual(["supported", "unsupported"]);
    expect(renderVerification(v)).toBe(text);
    expect(text).toContain('✓ supported 1.00 — "I applied to Acme Corp in September." [P1]');
    expect(text).toContain('✗ unsupported 0.00 — "Northwind builds rockets in Ohio." [P1]\n    missing terms: Northwind, builds, rockets, Ohio');
    expect(text).toContain("Summary: 1 supported, 1 unsupported");
    const [row] = await sql<{ retrieval_id: string; client: string }[]>`select retrieval_id, client from brain.verification_log where id = ${v.verificationId}`;
    expect(row).toEqual({ retrieval_id: id, client: "test" });
    const [call] = await sql<{ args: Record<string, unknown> }[]>`select args from brain.tool_calls where tool = 'brain_verify'`;
    expect(call.args).toEqual({ retrieval_id: id, claims_n: 2 });

    const missing = await ro.call("brain_verify", { retrieval_id: "00000000-0000-0000-0000-000000000000", claims: [{ text: "x", cites: [] }] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('No logged search has retrieval id "00000000-0000-0000-0000-000000000000"');
    const tooMany = await ro.call("brain_verify", { retrieval_id: id, claims: Array.from({ length: 51 }, () => ({ text: "x", cites: [] })) });
    expect(tooMany.isError).toBe(true);
    const tooLong = await ro.call("brain_verify", { retrieval_id: id, claims: [{ text: "x".repeat(2001), cites: [] }] });
    expect(tooLong.isError).toBe(true);
    expect((await sql`select id from brain.verification_log`).length).toBe(1);
    await ro.close();
  });

  it("tells clients to route questions about the owner through orient then search", async () => {
    const s = await connect();
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain("source of truth");
    expect(instructions.indexOf("brain_orient")).toBeLessThan(instructions.indexOf("brain_search"));
    await s.close();
  });

  it("tells clients how to read modes and scores, and to keep their own words apart from the knowledge base", async () => {
    const s = await connect(true);
    const instructions = s.client.getInstructions() ?? "";
    expect(instructions).toContain("Every brain_search result starts with `retrieval <id> · mode: <mode>`");
    expect(instructions).toContain("so you can tell strong evidence from weak");
    expect(instructions).toContain("Make clear which parts of the answer come from the knowledge base and which are your own");
    const searchTool = (await s.client.listTools()).tools.find((t) => t.name === "brain_search")!;
    expect(searchTool.description).toContain("score kind rerank is 0 to 1");
    expect(searchTool.description).toContain("structuredContent");
    expect(searchTool.description).toContain("brain_explain");
    expect(instructions).toContain("brain_explain with the retrieval id replays how that search ranked its passages");
    expect(instructions).toContain("After composing an answer from brain_search results, call brain_verify with the retrieval id and the answer's claims");
    expect(instructions).toContain("mark every claim whose verdict is not supported as your own addition or as weakly supported");
    expect(instructions.indexOf("brain_search")).toBeLessThan(instructions.indexOf("brain_verify"));
    expect(searchTool.description).toContain("brain_verify");
    const verifyTool = (await s.client.listTools()).tools.find((t) => t.name === "brain_verify")!;
    expect(verifyTool.description).toContain("it checks vocabulary overlap, not logic");
    expect(verifyTool.description).toContain("At most 50 claims of at most 2,000 characters each");
    expect(verifyTool.description).toContain("and 20 cites each");
    expect(verifyTool.outputSchema).toBeDefined();
    expect(searchTool.outputSchema).toBeDefined();
    await s.close();
  });

  it("brain_search starts with the retrieval id and mode, shows each passage's provenance, and returns the contract as structuredContent", async () => {
    const s = await connect();
    const ing = await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    const id = /document ([0-9a-f-]{36})/.exec(ing.text)![1];
    await s.jobs.drain();
    await s.client.listTools(); // the client validates structuredContent against the advertised outputSchema
    const res = await s.client.callTool({ name: "brain_search", arguments: { query: "Acme Corp visa", k: 5 } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    const sc = SearchResultSchema.parse(res.structuredContent);
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(text.split("\n")[0]).toBe(`retrieval ${sc.retrievalId} · mode: hybrid · ${sc.passages.length} passage${sc.passages.length === 1 ? "" : "s"}`);
    expect(text).toContain(`[P1] ${(sc.passages[0].score as number).toFixed(2)} rerank · `);
    expect(text).toContain(`(doc ${id}, chunk ${sc.passages[0].chunkId})`);
    expect(text).toContain("author: owner");
    expect(text).toContain(`[F1] visa_status: F-1 OPT (unverified · from note ${id})`);
    // The text is generated from the structure alone, and the structure carries every passage's text.
    expect(renderSearch(sc)).toBe(text);
    expect(sc.passages.every((p) => text.includes(p.content.trim()))).toBe(true);
    const [log] = await sql<{ client: string; mode: string }[]>`select client, mode from brain.retrieval_log where id = ${sc.retrievalId}`;
    expect(log).toEqual({ client: "test", mode: "hybrid" });
    await s.close();
  });

  it("logs every tool call in order, with the client, outcome, and no saved text", async () => {
    const s = await connect();
    await s.call("brain_orient");
    await s.call("brain_search", { query: "Acme", k: 3 });
    await s.call("brain_get_node", { name_or_id: "nobody by this name" });
    await s.call("brain_ingest", { text: "A private note.", source_kind: "note" });
    await s.jobs.drain();
    const rows = await sql<{ tool: string; client: string; ok: boolean; error: string | null; args: Record<string, unknown> }[]>`
      select tool, client, ok, error, args from brain.tool_calls order by created_at, id`;
    expect(rows.map((r) => r.tool)).toEqual(["brain_orient", "brain_search", "brain_get_node", "brain_ingest"]);
    expect(rows.every((r) => r.client === "test")).toBe(true);
    expect(rows[1].args).toEqual({ query: "Acme", k: 3 });
    expect(rows[2]).toMatchObject({ ok: false, error: expect.stringContaining("No entity matches") });
    expect(rows[3].args).toEqual({ source_kind: "note", text_chars: 15 });
    await s.close();
  });

  it("ingests quickly, finishes in the background, then searches and reads", async () => {
    const s = await connect();
    const ing = await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note" });
    expect(ing.isError).toBe(false);
    expect(ing.text).toMatch(/document [0-9a-f-]{36}/);
    expect(ing.text).toContain("chunked");
    const id = /document ([0-9a-f-]{36})/.exec(ing.text)![1];
    expect(s.jobs.pending).toContain(id);
    await s.jobs.drain();
    const [job] = await sql<{ stage: string }[]>`select stage from brain.ingest_jobs where document_id = ${id}`;
    expect(job.stage).toBe("done");

    const search = await s.call("brain_search", { query: "Acme Corp visa", k: 5 });
    expect(search.text).toContain("[P1]");
    expect(search.text).toContain(`doc ${id}`);
    expect(search.text).toContain("Entity organization: Acme Corp");
    expect(search.text).toContain("visa_status: F-1 OPT"); // facts come back only when they share a term with the query

    const doc = await s.call("brain_get_document", { document_id: id, offset: 0, length: 20 });
    expect(doc.text).toContain("I applied to Acme Co");
    const node = await s.call("brain_get_node", { name_or_id: "acme" });
    expect(node.text).toContain("← applied_to Frank Fu");
    const orient = await s.call("brain_orient");
    expect(orient.text).toContain("1 documents");
    const status = await s.call("brain_status");
    expect(status.text).toContain("done: 1");
    await s.close();
  });

  it("shows suppressed items about the owner in brain_status", async () => {
    const s = await connect();
    const ing = await s.call("brain_ingest", { text: "I applied to Acme Corp in September. I am on F-1 OPT.", source_kind: "note", author: "other" });
    const id = /document ([0-9a-f-]{36})/.exec(ing.text)![1];
    await s.jobs.drain();
    const status = await s.call("brain_status");
    expect(status.text).toContain(`- ${id} Acme note [author other]: 2`);
    await s.close();
  });

  it("says when brain_ingest keeps the stored author of text that is already present", async () => {
    const s = await connect();
    const text = "I think Databricks costs too much.";
    const first = await s.call("brain_ingest", { text, source_kind: "note", author: "other" });
    const id = /document ([0-9a-f-]{36})/.exec(first.text)![1];
    expect(first.text).not.toContain("author stays");
    await s.jobs.drain();
    const again = await s.call("brain_ingest", { text, source_kind: "note", author: "owner" });
    expect(again.isError).toBe(false);
    expect(again.text).toContain("Already present");
    expect(again.text).toContain(`author stays other; use \`brain set-author ${id} owner\` to change it`);
    const same = await s.call("brain_ingest", { text, source_kind: "note", author: "other" });
    expect(same.text).not.toContain("author stays");
    const omitted = await s.call("brain_ingest", { text, source_kind: "note" });
    expect(omitted.text).not.toContain("author stays");
    const [doc] = await sql<{ author: string }[]>`select author from brain.documents where id = ${id}`;
    expect(doc.author).toBe("other");
    await s.jobs.drain();
    await s.close();
  });

  it("adds and supersedes facts labeled with the client", async () => {
    const s = await connect();
    const a = await s.call("brain_add_fact", { predicate: "Lives In", object_text: "Austin" });
    expect(a.text).toContain("lives_in = Austin");
    const idA = /fact ([0-9a-f-]{36})/.exec(a.text)![1];
    const b = await s.call("brain_supersede_fact", { fact_id: idA, object_text: "Los Angeles" });
    const idB = /with fact ([0-9a-f-]{36})/.exec(b.text)![1];
    const current = await s.call("brain_get_facts");
    expect(current.text).toContain(`lives_in: Los Angeles (unverified, agent:test) id ${idB}`);
    expect(current.text).not.toContain(idA);
    const all = await s.call("brain_get_facts", { all: true });
    expect(all.text).toContain("superseded");
    await s.close();
  });

  it("returns errors as isError instead of crashing", async () => {
    const s = await connect();
    const r = await s.call("brain_supersede_fact", { fact_id: "00000000-0000-0000-0000-000000000000", object_text: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not found");
    const d = await s.call("brain_get_document", { document_id: "nope" });
    expect(d.isError).toBe(true);
    await s.close();
  });

  it("keeps a pipeline slot free so brain_ingest returns while background jobs run", async () => {
    const slow = async (args: { system: string; user: string }) => {
      await new Promise((r) => setTimeout(r, 500));
      return handler(args);
    };
    const s = await connect(false, slow);
    for (let i = 0; i < 5; i++) {
      const { id } = await storeDocument(sql, { text: `Background note ${i} about Acme Corp.`, sourceKind: "note" });
      s.jobs.start(id);
    }
    expect(s.jobs.pending.length).toBe(5);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    const ing = await s.call("brain_ingest", { text: "A quick save while the queue is busy.", source_kind: "note" });
    const elapsed = Date.now() - t0;
    expect(ing.isError).toBe(false);
    expect(elapsed).toBeLessThan(400);
    expect(s.jobs.pending.length).toBe(6);
    await s.jobs.drain();
    expect(s.jobs.pending).toEqual([]);
    const rows = await sql<{ stage: string }[]>`select stage from brain.ingest_jobs`;
    expect(rows.map((r) => r.stage)).toEqual(Array(6).fill("done"));
    await s.close();
  }, 30000);

  it("validates inputs: dates, empty predicates and values", async () => {
    const s = await connect();
    const r = await s.call("brain_search", { query: "Acme", since: "last week" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ISO date");
    const blank = await s.call("brain_add_fact", { predicate: "lives_in", object_text: "   " });
    expect(blank.isError).toBe(true);
    const sym = await s.call("brain_add_fact", { predicate: "!!!", object_text: "x" });
    expect(sym.isError).toBe(true);
    expect(sym.text).toContain("predicate must contain letters or digits");
    const vf = await s.call("brain_add_fact", { predicate: "lives_in", object_text: "Austin", valid_from: "someday" });
    expect(vf.isError).toBe(true);
    expect(vf.text).toContain("ISO date");
    expect((await sql`select id from brain.facts`).length).toBe(0);
    await s.close();
  });

  it("supersede with the same value is an error", async () => {
    const s = await connect();
    const a = await s.call("brain_add_fact", { predicate: "lives_in", object_text: "Austin" });
    const idA = /fact ([0-9a-f-]{36})/.exec(a.text)![1];
    const r = await s.call("brain_supersede_fact", { fact_id: idA, object_text: "Austin" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("New value equals the current value");
    await s.close();
  });

  it("refreshes the Obsidian mirror after each successful fact write, and not after a failed one", async () => {
    const s = await connect();
    let notified = 0;
    s.ctx.obsidian = { notify: () => void notified++ } as unknown as ObsidianAutoProjector;
    const a = await s.call("brain_add_fact", { predicate: "lives_in", object_text: "Austin" });
    expect(a.isError).toBe(false);
    expect(notified).toBe(1);
    const idA = /fact ([0-9a-f-]{36})/.exec(a.text)![1];
    const b = await s.call("brain_supersede_fact", { fact_id: idA, object_text: "Los Angeles" });
    expect(b.isError).toBe(false);
    expect(notified).toBe(2);
    const bad = await s.call("brain_supersede_fact", { fact_id: "00000000-0000-0000-0000-000000000000", object_text: "x" });
    expect(bad.isError).toBe(true);
    expect(notified).toBe(2);

    // A broken refresher never fails the tool.
    s.ctx.obsidian = { notify: () => { throw new Error("mirror broke"); } } as unknown as ObsidianAutoProjector;
    const c = await s.call("brain_add_fact", { predicate: "prefers", object_text: "tea" });
    expect(c.isError).toBe(false);
    await s.close();
  });
});
