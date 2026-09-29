import { describe, it, expect } from "vitest";
import { childEnv, spawnExec } from "../../src/llm/claude-code.js";

describe("childEnv", () => {
  it("drops Claude Code session markers and keeps everything else", () => {
    const env = childEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/bin", HOME: "/h" });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});

describe("spawnExec", () => {
  it("runs a child without the session markers even when the parent has them", async () => {
    const prev = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const { stdout } = await spawnExec(process.execPath, ["-e", "process.stdout.write(process.env.CLAUDECODE ?? 'unset')"], "");
      expect(stdout).toBe("unset");
    } finally {
      if (prev === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prev;
    }
  });
  it("rejects with stderr on a non-zero exit", async () => {
    await expect(spawnExec(process.execPath, ["-e", "console.error('bad'); process.exit(3)"], "")).rejects.toThrow(/exited with 3: bad/);
  });
});
