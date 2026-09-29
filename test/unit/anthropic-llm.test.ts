import { describe, it, expect } from "vitest";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicLlm } from "../../src/llm/llm.js";
import { ModelRefusal, SchemaFailure, isRefusal, isSchemaFailure } from "../../src/llm/errors.js";

const schema = z.object({ n: z.number() });

function fakeClient(response: { stop_reason: string; content: { type: string; text?: string }[]; stop_details?: unknown }) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        return { stop_details: null, ...response };
      },
      parse: async () => {
        throw new Error("structured() must not use messages.parse");
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const args = { schema, system: "s", user: "u" };

describe("AnthropicLlm.structured", () => {
  it("returns the parsed object and sends the schema as output_config", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: '{"n":' }, { type: "text", text: " 3}" }] });
    const llm = new AnthropicLlm(client, "m");
    expect(await llm.structured(args)).toEqual({ n: 3 });
    const format = (calls[0].output_config as { format: { type: string; schema: unknown } }).format;
    expect(format.type).toBe("json_schema");
    expect(format.schema).toBeTruthy();
  });

  it("throws ModelRefusal with the explanation on a refusal", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", content: [], stop_details: { category: "cyber", explanation: "not allowed" } });
    const err = await new AnthropicLlm(client, "m").structured(args).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRefusal);
    expect(err.message).toContain("not allowed");
    expect(isRefusal(err)).toBe(true);
    expect(isSchemaFailure(err)).toBe(false);
  });

  it("throws SchemaFailure when the output is truncated at max_tokens", async () => {
    const { client } = fakeClient({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"n":' }] });
    const err = await new AnthropicLlm(client, "m").structured(args).catch((e) => e);
    expect(err).toBeInstanceOf(SchemaFailure);
    expect(err.message).toMatch(/max_tokens/);
  });

  it("throws SchemaFailure on invalid JSON", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] });
    await expect(new AnthropicLlm(client, "m").structured(args)).rejects.toBeInstanceOf(SchemaFailure);
  });

  it("throws SchemaFailure on JSON that fails the schema", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: '{"n":"x"}' }] });
    await expect(new AnthropicLlm(client, "m").structured(args)).rejects.toBeInstanceOf(SchemaFailure);
  });
});

describe("AnthropicLlm.text", () => {
  it("throws ModelRefusal on a refusal", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", content: [], stop_details: { category: null, explanation: null } });
    await expect(new AnthropicLlm(client, "m").text({ system: "s", user: "u" })).rejects.toBeInstanceOf(ModelRefusal);
  });

  it("concatenates text blocks", async () => {
    const { client } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    expect(await new AnthropicLlm(client, "m").text({ system: "s", user: "u" })).toBe("ab");
  });
});
