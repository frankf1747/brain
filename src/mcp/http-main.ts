import { makeCtx } from "../ctx.js";
import { buildApp, parseTokens } from "./http.js";

const tokens = parseTokens(process.env.BRAIN_TOKENS);
if (tokens.size === 0) {
  process.stderr.write("brain: BRAIN_TOKENS is empty; refusing to start an unauthenticated server\n");
  process.exit(1);
}
const ctx = makeCtx();
const port = Number(process.env.PORT ?? 8080);
buildApp(ctx, tokens, undefined, process.env.BRAIN_MCP_READONLY === "1").listen(port, () => {
  process.stderr.write(`brain: MCP server listening on :${port}/mcp for ${tokens.size} client(s)\n`);
});
