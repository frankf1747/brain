import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeCtx } from "../ctx.js";
import { buildServer } from "./server.js";

const ctx = makeCtx();
const server = buildServer(ctx, { client: "claude-code", readOnly: process.env.BRAIN_MCP_READONLY === "1" });
await server.connect(new StdioServerTransport());
process.stderr.write("brain: MCP server connected over stdio\n");

// Exit when the client goes away, whether it signals or just closes our stdin, so no orphaned
// server keeps database connections open. Unfinished background jobs resume later via resumeStalled.
let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  void server
    .close()
    .then(() => ctx.sql.end({ timeout: 5 }))
    .finally(() => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
