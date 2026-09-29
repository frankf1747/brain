import { describe, it, expect, afterAll, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { buildApp, parseTokens } from "../../src/mcp/http.js";
import { JobManager } from "../../src/mcp/jobs.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("MCP over HTTP", () => {
  it("rejects missing or wrong tokens and serves tools for a valid one", async () => {
    const ctx = fakeCtx(sql);
    const app = buildApp(ctx, parseTokens("tester:secret123"), new JobManager(ctx, () => {}));
    const httpServer = app.listen(0);
    await new Promise<void>((r) => httpServer.once("listening", () => r()));
    const port = (httpServer.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const client = new Client({ name: "http-test", version: "0" });
    try {
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const noAuth = await fetch(url, { method: "POST", headers, body: "{}" });
      expect(noAuth.status).toBe(401);
      const wrong = await fetch(url, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: "{}" });
      expect(wrong.status).toBe(401);
      const nearMiss = await fetch(url, { method: "POST", headers: { ...headers, authorization: "Bearer secret124" }, body: "{}" });
      expect(nearMiss.status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer secret123" } } });
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("brain_search");
      const res = await client.callTool({ name: "brain_add_fact", arguments: { predicate: "lives_in", object_text: "Austin" } });
      expect((res.content as { text: string }[])[0].text).toContain("agent:tester");
    } finally {
      await client.close().catch(() => {});
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  });
});
