import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { ask, ASK_SYSTEM } from "../../src/retrieve/ask.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("ask", () => {
  it("passes numbered passages and facts to the model and returns its answer", async () => {
    const ctx = fakeCtx(sql, ({ system }) => {
      if (system === SUMMARY_SYSTEM) return { title: "T", summary_line: "L", summary: "S", occurred_at: null };
      if (system === ASK_SYSTEM) return "The answer [P1].";
      return { entities: [], relations: [], facts_about_self: [{ predicate: "visa_status", object_text: "F-1 OPT", object_key: null, confidence: 1, valid_from: null, valid_to: null, quote: "F-1 OPT" }] };
    });
    await ingest(ctx, { text: "Zorblax released the ZX-9000. I am on F-1 OPT." });
    const { answer, result } = await ask(ctx, "What did Zorblax release, and what is my visa?");
    expect(answer).toBe("The answer [P1].");
    const call = ctx.llm.calls.find((c) => c.kind === "text")!;
    expect(call.user).toContain("[P1]");
    expect(call.user).toContain("[F1] visa_status: F-1 OPT");
    expect(result.passages.length).toBeGreaterThan(0);
  });
});
