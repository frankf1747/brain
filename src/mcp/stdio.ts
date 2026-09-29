import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeCtx } from "../ctx.js";
import { buildServer } from "./server.js";

const ctx = makeCtx();
const server = buildServer(ctx, { client: "claude-code", readOnly: process.env.BRAIN_MCP_READONLY === "1" });
await server.connect(new StdioServerTransport());
process.stderr.write("brain: MCP server connected over stdio\n");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => ctx.sql.end()).finally(() => process.exit(0));
  });
}
