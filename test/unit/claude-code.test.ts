import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ClaudeCodeLlm, spawnExec, type Exec } from "../../src/llm/claude-code.js";
import { SchemaFailure, isSchemaFailure } from "../../src/llm/errors.js";

function fakeExec(envelope: unknown) {
  const calls: { bin: string; args: string[]; input: string }[] = [];
  const exec: Exec = async (bin, args, input) => {
    calls.push({ bin, args, input });
    return { stdout: JSON.stringify(envelope) };
  };
  return { exec, calls };
}

describe("ClaudeCodeLlm", () => {
  it("runs the claude binary headless with a schema, no tools, and a custom system prompt", async () => {
    const { exec, calls } = fakeExec({ type: "result", is_error: false, result: '{"n":1}', structured_output: { n: 1 } });
    const llm = new ClaudeCodeLlm({ exec, bin: "claude", model: "opus" });
    const out = await llm.structured({ schema: z.object({ n: z.number() }), system: "SYS", user: "USER TEXT" });
    expect(out).toEqual({ n: 1 });
    const { bin, args, input } = calls[0];
    expect(bin).toBe("claude");
    expect(input).toBe("USER TEXT");
    expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--system-prompt", "SYS", "--model", "opus", "--json-schema"]));
    const schemaArg = args[args.indexOf("--json-schema") + 1];
    expect(JSON.parse(schemaArg).properties.n.type).toBe("number");
    expect(JSON.parse(schemaArg)).not.toHaveProperty("$schema");
  });

  it("falls back to parsing the result text when structured_output is absent, and validates it", async () => {
    const good = new ClaudeCodeLlm({ exec: fakeExec({ is_error: false, result: '{"n": 2}' }).exec });
    expect(await good.structured({ schema: z.object({ n: z.number() }), system: "s", user: "u" })).toEqual({ n: 2 });
    const bad = new ClaudeCodeLlm({ exec: fakeExec({ is_error: false, result: '{"n": "x"}' }).exec });
    await expect(bad.structured({ schema: z.object({ n: z.number() }), system: "s", user: "u" })).rejects.toBeInstanceOf(SchemaFailure);
  });

  it("reports a non-JSON result as a SchemaFailure", async () => {
    const llm = new ClaudeCodeLlm({ exec: fakeExec({ is_error: false, result: "Sorry, here is prose." }).exec });
    await expect(llm.structured({ schema: z.object({ n: z.number() }), system: "s", user: "u" })).rejects.toBeInstanceOf(SchemaFailure);
  });

  it("reports CLI-side structured-output failures as SchemaFailure, other CLI errors as plain errors", async () => {
    const schema = z.object({ n: z.number() });
    const retries = new ClaudeCodeLlm({ exec: fakeExec({ is_error: true, subtype: "error_max_structured_output_retries" }).exec });
    await expect(retries.structured({ schema, system: "s", user: "u" })).rejects.toBeInstanceOf(SchemaFailure);
    const turns = new ClaudeCodeLlm({ exec: fakeExec({ is_error: true, subtype: "error_max_turns" }).exec });
    const turnsErr = await turns.structured({ schema, system: "s", user: "u" }).catch((e) => e);
    expect(turnsErr).toBeInstanceOf(Error);
    expect(turnsErr).not.toBeInstanceOf(SchemaFailure);
    expect(isSchemaFailure(turnsErr)).toBe(false);
    // A system-wide CLI problem that merely mentions the schema must stay a retryable error.
    const flag = new ClaudeCodeLlm({ exec: fakeExec({ is_error: true, subtype: "error_during_execution", result: "error: unknown option '--json-schema'" }).exec });
    const flagErr = await flag.structured({ schema, system: "s", user: "u" }).catch((e) => e);
    expect(flagErr).toBeInstanceOf(Error);
    expect(flagErr).not.toBeInstanceOf(SchemaFailure);
    expect(isSchemaFailure(flagErr)).toBe(false);
    const auth = new ClaudeCodeLlm({ exec: fakeExec({ is_error: true, result: "OAuth access token has expired." }).exec });
    const err = await auth.structured({ schema, system: "s", user: "u" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(SchemaFailure);
    expect(err.message).toMatch(/expired/);
  });

  it("surfaces CLI errors such as an expired login", async () => {
    const llm = new ClaudeCodeLlm({ exec: fakeExec({ is_error: true, result: "Failed to authenticate. OAuth access token has expired." }).exec });
    await expect(llm.text({ system: "s", user: "u" })).rejects.toThrow(/expired/);
  });

  it("returns plain text for text calls without a schema flag", async () => {
    const { exec, calls } = fakeExec({ is_error: false, result: "hello" });
    expect(await new ClaudeCodeLlm({ exec }).text({ system: "s", user: "u" })).toBe("hello");
    expect(calls[0].args).not.toContain("--json-schema");
  });

  it("starts none of the user's MCP servers (each would launch before every call), without --bare, which drops subscription login", async () => {
    const { exec, calls } = fakeExec({ is_error: false, result: "hello" });
    await new ClaudeCodeLlm({ exec }).text({ system: "s", user: "u" });
    expect(calls[0].args).toContain("--strict-mcp-config");
    expect(calls[0].args).not.toContain("--bare");
  });
});

describe("spawnExec", () => {
  it("rejects with the exit code when the child exits before reading a large stdin", async () => {
    await expect(spawnExec("sh", ["-c", "exit 2"], "x".repeat(2_000_000))).rejects.toThrow(/exited with 2/);
  });

  it("kills a hung child and rejects after the timeout", async () => {
    const start = Date.now();
    await expect(spawnExec(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], "", 200)).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
