import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingestAll } from "../../src/ingest/batch.js";
import type { ReadResult } from "../../src/ingest/readers.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM
    ? { title: "T", summary_line: "A note.", summary: "A note.", occurred_at: null }
    : { entities: [], relations: [], facts_about_self: [] };

const read = (origin: string, text: string): ReadResult => ({ text, title: null, mimeType: "text/plain", origin, metadata: {} });

describe("ingestAll", () => {
  it("skips an unreadable item and keeps going", async () => {
    const ctx = fakeCtx(sql, handler);
    const lines: string[] = [];
    const skips: string[] = [];
    const res = await ingestAll(
      ctx,
      [read("/a.md", "First good note about apples."), read("/scan.pdf", "   "), read("/c.md", "Second good note about cherries.")],
      { toInput: (r) => ({ text: r.text, origin: r.origin, sourceKind: "note" }) },
      { done: (r, out) => lines.push(`${out.stage} ${r.origin}`), skip: (r, message) => skips.push(`${r.origin}: ${message}`) },
    );
    expect(res.ok.map((o) => o.origin)).toEqual(["/a.md", "/c.md"]);
    expect(res.ok.every((o) => o.result.stage === "done")).toBe(true);
    expect(res.failed).toEqual([{ origin: "/scan.pdf", error: "Refusing to store an empty document" }]);
    expect(lines).toEqual(["done /a.md", "done /c.md"]);
    expect(skips).toEqual(["/scan.pdf: Refusing to store an empty document"]);
    const [{ n }] = await sql<{ n: string }[]>`select count(*)::text as n from brain.documents`;
    expect(Number(n)).toBe(2);
  });
});
