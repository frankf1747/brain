import { spawn } from "node:child_process";
import { z } from "zod";
import { config } from "../config.js";
import type { Llm, StructuredArgs, TextArgs } from "./llm.js";

export type Exec = (bin: string, args: string[], input: string) => Promise<{ stdout: string }>;

/** Runs a binary, feeds `input` on stdin, resolves with stdout on exit 0. */
export const spawnExec: Exec = (bin, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${bin} exited with ${code}: ${(stderr || stdout).slice(0, 500)}`));
    });
    child.stdin.end(input);
  });

interface Envelope {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
}

const PROMPT = "Apply your instructions to the user message provided with this request. Reply with the answer only.";

/**
 * Model backend that shells out to the official Claude Code CLI in print mode, so calls are covered by
 * the user's Claude subscription instead of per-token API billing. Tools are disabled and the default
 * coding-agent system prompt is replaced, so this is a plain model call.
 */
export class ClaudeCodeLlm implements Llm {
  readonly model: string;
  private readonly bin: string;
  private readonly exec: Exec;

  constructor(opts: { bin?: string; model?: string; exec?: Exec } = {}) {
    this.bin = opts.bin ?? config.claudeCodeBin;
    this.model = opts.model ?? config.claudeCodeModel;
    this.exec = opts.exec ?? spawnExec;
  }

  private args(system: string, schema?: z.ZodType<unknown>): string[] {
    const args = ["-p", PROMPT, "--output-format", "json", "--tools", "", "--no-session-persistence", "--system-prompt", system, "--model", this.model];
    if (schema) {
      // The CLI silently ignores a schema that carries a "$schema" key (verified on 2.1.145), so drop it.
      const { $schema: _, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
      args.push("--json-schema", JSON.stringify(json));
    }
    return args;
  }

  private async run(system: string, user: string, schema?: z.ZodType<unknown>): Promise<Envelope> {
    const { stdout } = await this.exec(this.bin, this.args(system, schema), user);
    let envelope: Envelope;
    try {
      envelope = JSON.parse(stdout) as Envelope;
    } catch {
      throw new Error(`Claude Code returned non-JSON output: ${stdout.slice(0, 300)}`);
    }
    if (envelope.is_error) throw new Error(`Claude Code error: ${envelope.result ?? envelope.subtype ?? "unknown"}`);
    return envelope;
  }

  async structured<T>({ schema, system, user }: StructuredArgs<T>): Promise<T> {
    const envelope = await this.run(system, user, schema as z.ZodType<unknown>);
    let raw: unknown = envelope.structured_output;
    if (raw === undefined) {
      try {
        raw = JSON.parse(envelope.result ?? "");
      } catch {
        throw new Error("Model output did not match the schema: not JSON");
      }
    }
    return schema.parse(raw);
  }

  async text({ system, user }: TextArgs): Promise<string> {
    const envelope = await this.run(system, user);
    return envelope.result ?? "";
  }
}
