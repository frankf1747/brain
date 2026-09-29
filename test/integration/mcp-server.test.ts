import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { buildServer } from "../../src/mcp/server.js";
import { JobManager } from "../../src/mcp/jobs.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "S", occurred_at: null } : fakeExtraction;

async function connect(readOnly = false) {
  const ctx = fakeCtx(sql, handler);
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
  it("lists nine tools, or six when read-only", async () => {
    const a = await connect();
    expect((await a.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "brain_add_fact", "brain_get_document", "brain_get_facts", "brain_get_node", "brain_ingest", "brain_orient", "brain_search", "brain_status", "brain_supersede_fact",
    ]);
    await a.close();
    const b = await connect(true);
    expect((await b.client.listTools()).tools.length).toBe(6);
    await b.close();
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

    const search = await s.call("brain_search", { query: "Acme Corp", k: 5 });
    expect(search.text).toContain("[P1]");
    expect(search.text).toContain(`document ${id}`);
    expect(search.text).toContain("Entity organization: Acme Corp");
    expect(search.text).toContain("visa_status: F-1 OPT");

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

  it("adds and supersedes facts labeled with the client", async () => {
    const s = await connect();
    const a = await s.call("brain_add_fact", { predicate: "lives_in", object_text: "Austin" });
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
});
