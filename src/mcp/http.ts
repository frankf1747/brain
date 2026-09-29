import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Ctx } from "../ctx.js";
import { buildServer } from "./server.js";
import { JobManager } from "./jobs.js";

/** "name:token,name2:token2" -> Map<token, name>. */
export function parseTokens(spec: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (spec ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const token = part.slice(i + 1).trim();
    if (name && token) out.set(token, name);
  }
  return out;
}

/**
 * The client name for a presented token, or undefined. Compares in constant time per entry
 * (a length mismatch is a non-match) and checks every entry, so timing does not reveal which
 * characters of a token were right.
 */
export function matchToken(tokens: Map<string, string>, candidate: string): string | undefined {
  const presented = Buffer.from(candidate, "utf8");
  let found: string | undefined;
  for (const [token, name] of tokens) {
    const expected = Buffer.from(token, "utf8");
    if (expected.length === presented.length && timingSafeEqual(expected, presented) && found === undefined) found = name;
  }
  return found;
}

export function buildApp(ctx: Ctx, tokens: Map<string, string>, jobs = new JobManager(ctx), readOnly = false) {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.get("/healthz", (_req, res) => void res.status(200).send("ok"));

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const client = token ? matchToken(tokens, token) : undefined;
    if (!client) return void res.status(401).json({ error: "unauthorized" });
    res.locals.client = client;
    next();
  };

  // Stateless: a fresh server and transport per request, all sharing one JobManager so the
  // background-slot reservation holds across requests.
  app.post("/mcp", auth, async (req, res) => {
    const server = buildServer(ctx, { client: String(res.locals.client), jobs, readOnly });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      process.stderr.write(`brain: request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });
  app.get("/mcp", (_req, res) => void res.status(405).end());
  app.delete("/mcp", (_req, res) => void res.status(405).end());
  return app;
}
