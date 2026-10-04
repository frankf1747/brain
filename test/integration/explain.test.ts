import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";
import { explain, explainNotFound } from "../../src/retrieve/explain.js";
import { toLoggedPassages } from "../../src/retrieve/contract.js";
import { renderExplain } from "../../src/mcp/render.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM
    ? { title: "Untitled", summary_line: "A note.", summary: "A note.", occurred_at: null }
    : { entities: [], relations: [], facts_about_self: [] };

async function seed() {
  const ctx = fakeCtx(sql, handler);
  await ingest(ctx, { text: "Zorblax Industries in Austin released the ZX-9000 drill.", sourceKind: "news", title: "Zorblax news" });
  await ingest(ctx, { text: "Gardening notes: tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
  return ctx;
}

describe("explain", () => {
  it("replays a logged search from the log alone: mode, candidates, timings, and each passage's ranks and score", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Zorblax drill ZX-9000", { k: 5, sourceKinds: ["news", "note"] });
    const before = await sql`select id from brain.retrieval_log`;
    const embed = vi.spyOn(ctx.embedder, "embed");
    const e = (await explain(sql, res.retrievalId))!;
    expect(embed).not.toHaveBeenCalled();
    expect((await sql`select id from brain.retrieval_log`).length).toBe(before.length);
    expect(e).toMatchObject({
      retrievalId: res.retrievalId, query: "Zorblax drill ZX-9000", client: "cli", v2: true, k: 5, mode: res.mode,
      degraded: res.degraded, candidates: res.candidates, timings: res.timings, usedFallback: res.fallbackUsed,
    });
    expect(e.filters).toMatchObject({ sourceKinds: ["news", "note"], verifiedOnly: false });
    expect(e.results).toEqual(toLoggedPassages(res.passages));
    expect(e.topScore).toBeCloseTo(res.topScore as number, 5);
    expect(Number.isNaN(Date.parse(e.createdAt))).toBe(false);

    const text = renderExplain(e);
    expect(text.split("\n")[0]).toContain(`retrieval ${res.retrievalId} · logged `);
    expect(text).toContain(`mode: ${res.mode} · k 5`);
    expect(text).toContain(`candidates: vector ${res.candidates.vector} · keyword ${res.candidates.keyword} · fused ${res.candidates.fused}`);
    res.passages.forEach((p, i) => expect(text).toContain(`#${i + 1} [P${i + 1}] score `));
    const top = res.passages[0];
    expect(text).toContain(`#1 [P1] score ${(top.score as number).toFixed(2)} (rerank) · layers ${top.layers.join("+")} · vector ${top.vectorRank ?? "-"} · keyword ${top.keywordRank ?? "-"} · rerank 1`);
  });

  it("returns null for an unknown or malformed id, and the message says where the id comes from", async () => {
    expect(await explain(sql, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await explain(sql, "not-an-id")).toBeNull();
    expect(explainNotFound("abc")).toBe(
      'No logged search has retrieval id "abc". The id is on the first line of a brain_search result: retrieval <id> · mode: …',
    );
  });

  it("explains what is available for a row logged before evidence v2", async () => {
    const [row] = await sql<{ id: string }[]>`
      insert into brain.retrieval_log (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client)
      values ('old question', '{}'::jsonb, '{hybrid,summary,degraded}', '{}'::uuid[], '{}'::uuid[], 0.031, false, 'mcp-stdio')
      returning id`;
    const e = (await explain(sql, row.id))!;
    expect(e).toMatchObject({ v2: false, results: null, mode: null, k: null, degraded: null, client: "mcp-stdio", layers: ["hybrid", "summary", "degraded"] });
    expect(e.topScore).toBeCloseTo(0.031, 5);
    const text = renderExplain(e);
    expect(text).toContain("logged before evidence v2");
    expect(text).toContain("top score: 0.0310");
    expect(e.notes).toEqual([]);
  });

  it("explains a row whose logged passages no longer fit the contract from its v1 columns, with a note", async () => {
    const [row] = await sql<{ id: string }[]>`
      insert into brain.retrieval_log (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client, results, k, mode)
      values ('future row', '{}'::jsonb, '{hybrid,summary}', '{}'::uuid[], '{}'::uuid[], 0.5, false, 'mcp-stdio',
              '[{"chunkId": "c1"}]'::jsonb, 10, 'hybrid')
      returning id`;
    const e = (await explain(sql, row.id))!;
    expect(e).toMatchObject({ v2: false, results: null, k: 10, mode: "hybrid", layers: ["hybrid", "summary"] });
    expect(e.notes).toHaveLength(1);
    expect(e.notes[0]).toMatch(/^results could not be read with the current contract \(0\.\w+: .*\); shown as not recorded$/);
    const text = renderExplain(e);
    expect(text).toContain(`note: ${e.notes[0]}`);
    expect(text).toContain("logged before evidence v2");
  });
});
