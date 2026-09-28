import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ClaudeCodeLlm, type Exec } from "../../src/llm/claude-code.js";

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
  });

  it("falls back to parsing the result text when structured_output is absent, and validates it", async () => {
    const good = new ClaudeCodeLlm({ exec: fakeExec({ is_error: false, result: '{"n": 2}' }).exec });
    expect(await good.structured({ schema: z.object({ n: z.number() }), system: "s", user: "u" })).toEqual({ n: 2 });
    const bad = new ClaudeCodeLlm({ exec: fakeExec({ is_error: false, result: '{"n": "x"}' }).exec });
    await expect(bad.structured({ schema: z.object({ n: z.number() }), system: "s", user: "u" })).rejects.toThrow();
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
});
