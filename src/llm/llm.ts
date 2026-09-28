import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "../config.js";

export interface StructuredArgs<T> {
  schema: z.ZodType<T>;
  system: string;
  user: string;
  maxTokens?: number;
}

export interface TextArgs {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface Llm {
  readonly model: string;
  structured<T>(args: StructuredArgs<T>): Promise<T>;
  text(args: TextArgs): Promise<string>;
}

export class AnthropicLlm implements Llm {
  constructor(
    private readonly client: Anthropic = new Anthropic(),
    readonly model: string = config.anthropicModel,
  ) {}

  async structured<T>({ schema, system, user, maxTokens = 16000 }: StructuredArgs<T>): Promise<T> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      output_config: { format: zodOutputFormat(schema as any) },
    });
    if (res.stop_reason === "refusal") {
      throw new Error(`Model refused: ${res.stop_details?.explanation ?? "no explanation"}`);
    }
    if (res.stop_reason === "max_tokens") throw new Error("Model output truncated at max_tokens");
    if (res.parsed_output == null) throw new Error("Model output did not match the schema");
    return res.parsed_output as T;
  }

  async text({ system, user, maxTokens = 16000 }: TextArgs): Promise<string> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    if (res.stop_reason === "refusal") {
      throw new Error(`Model refused: ${res.stop_details?.explanation ?? "no explanation"}`);
    }
    let out = "";
    for (const block of res.content) if (block.type === "text") out += block.text;
    return out;
  }
}

/** Test double. The handler decides the output; structured output is still validated by the schema. */
export class FakeLlm implements Llm {
  readonly model = "fake";
  calls: { kind: "structured" | "text"; system: string; user: string }[] = [];
  constructor(private readonly handler: (args: { system: string; user: string }) => unknown) {}

  async structured<T>({ schema, system, user }: StructuredArgs<T>): Promise<T> {
    this.calls.push({ kind: "structured", system, user });
    return schema.parse(await this.handler({ system, user }));
  }

  async text({ system, user }: TextArgs): Promise<string> {
    this.calls.push({ kind: "text", system, user });
    return String(await this.handler({ system, user }));
  }
}
