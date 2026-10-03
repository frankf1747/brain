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
    expect(call.user).toContain("Search mode: hybrid");
    expect(call.user).toMatch(/\[P1\] \d\.\d\d rerank · [^\n]*· author: owner · /);
    expect(result.retrievalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.passages.length).toBeGreaterThan(0);
  });

  it("checks its own answer sentence by sentence against the labels each sentence cites, on its own retrieval id", async () => {
    const ctx = fakeCtx(sql, ({ system }) => {
      if (system === SUMMARY_SYSTEM) return { title: "T", summary_line: "L", summary: "S", occurred_at: null };
      if (system === ASK_SYSTEM) return "Zorblax released the ZX-9000 [P1]. Your visa status is F-1 OPT [F1]. It is the best drill on the market.";
      return { entities: [], relations: [], facts_about_self: [{ predicate: "visa_status", object_text: "F-1 OPT", object_key: null, confidence: 1, valid_from: null, valid_to: null, quote: "F-1 OPT" }] };
    });
    await ingest(ctx, { text: "Zorblax released the ZX-9000. I am on F-1 OPT." });
    const { result, verification, verificationError, droppedClaims } = await ask(ctx, "What did Zorblax release, and what is my visa status?");
    expect(verificationError).toBeNull();
    expect(droppedClaims).toBe(0);
    expect(verification!.retrievalId).toBe(result.retrievalId);
    expect(verification!.claims.map((c) => [c.claim, c.labels, c.verdict])).toEqual([
      ["Zorblax released the ZX-9000.", ["P1"], "supported"],
      ["Your visa status is F-1 OPT.", ["F1"], "supported"],
      ["It is the best drill on the market.", [], "uncited"],
    ]);
    expect(verification!.summary.text).toBe("2 supported, 1 uncited");
    const [row] = await sql<{ client: string; retrieval_id: string }[]>`select client, retrieval_id from brain.verification_log`;
    expect(row).toEqual({ client: "ask", retrieval_id: result.retrievalId });
  });

  it("still returns the answer when the check fails", async () => {
    const ctx = fakeCtx(sql, ({ system }) => (system === ASK_SYSTEM ? "Nothing is stored [P1]." : { title: "T", summary_line: "L", summary: "S", occurred_at: null }));
    await sql`alter table brain.verification_log rename to verification_log_hidden`;
    try {
      const { answer, verification, verificationError } = await ask(ctx, "Anything?");
      expect(answer).toBe("Nothing is stored [P1].");
      expect(verification).toBeNull();
      expect(verificationError).toContain('relation "brain.verification_log" does not exist');
    } finally {
      await sql`alter table brain.verification_log_hidden rename to verification_log`;
    }
  });
});
