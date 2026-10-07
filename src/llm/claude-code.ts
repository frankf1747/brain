import { spawn } from "node:child_process";
import { z } from "zod";
import { config } from "../config.js";
import type { Llm, StructuredArgs, TextArgs } from "./llm.js";
import { SchemaFailure } from "./errors.js";

export type Exec = (bin: string, args: string[], input: string) => Promise<{ stdout: string }>;

export const CLAUDE_CODE_TIMEOUT_MS = 600_000;

const SESSION_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

/** The child `claude` process must not think it is nested inside the parent session. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of SESSION_MARKERS) delete out[k];
  return out;
}

/** Runs a binary, feeds `input` on stdin, resolves with stdout on exit 0. Kills it after `timeoutMs`. */
export const spawnExec = (
  bin: string,
  args: string[],
  input: string,
  timeoutMs: number = CLAUDE_CODE_TIMEOUT_MS,
): Promise<{ stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      reject(new Error(`${bin} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${bin} exited with ${code}: ${(stderr || stdout).slice(0, 500)}`));
    });
    // A child that exits before reading all of stdin makes the write fail with EPIPE; the close handler reports it.
    child.stdin.on("error", () => {});
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
 * the user's Claude subscription instead of per-token API billing. Tools are disabled, none of the user's MCP servers
 * are started (--strict-mcp-config with no --mcp-config; otherwise every call launches all of them, this server
 * included), and the default coding-agent system prompt is replaced, so this is a plain model call.
 */
export class ClaudeCodeLlm implements Llm {
  readonly model: string;
  private readonly bin: string;
  private readonly exec: Exec;

  constructor(opts: { bin?: string; model?: string; exec?: Exec } = {}) {
    this.bin = opts.bin ?? config.claudeCodeBin;
    this.model = opts.model ?? config.claudeCodeModel;
    this.exec = opts.exec ?? ((bin, args, input) => spawnExec(bin, args, input, CLAUDE_CODE_TIMEOUT_MS));
  }

  private args(system: string, schema?: z.ZodType<unknown>): string[] {
    const args = ["-p", PROMPT, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", system, "--model", this.model];
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
    if (envelope.is_error) {
      const detail = envelope.result ?? envelope.subtype ?? "unknown";
      // Only the CLI's own structured-output retries running out is a schema failure. Anything else (running
      // out of turns, a CLI that rejects --json-schema) is a retryable error, not a reason to downgrade the document.
      if (schema && envelope.subtype === "error_max_structured_output_retries") {
        throw new SchemaFailure(`Model output did not match the schema: Claude Code ${detail}`);
      }
      throw new Error(`Claude Code error: ${detail}`);
    }
    return envelope;
  }

  async structured<T>({ schema, system, user }: StructuredArgs<T>): Promise<T> {
    const envelope = await this.run(system, user, schema as z.ZodType<unknown>);
    let raw: unknown = envelope.structured_output;
    if (raw === undefined) {
      try {
        raw = JSON.parse(envelope.result ?? "");
      } catch {
        throw new SchemaFailure("Model output did not match the schema: not JSON");
      }
    }
    const result = schema.safeParse(raw);
    if (!result.success) throw new SchemaFailure(`Model output did not match the schema: ${result.error.message.slice(0, 300)}`);
    return result.data;
  }

  async text({ system, user }: TextArgs): Promise<string> {
    const envelope = await this.run(system, user);
    return envelope.result ?? "";
  }
}
