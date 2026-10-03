import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { search } from "../../src/retrieve/search.js";
import { verifyClaims, parseCite, NOTE_NO_FACTS, NOTE_NO_RESULTS } from "../../src/verify/resolve.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const visaFact = { predicate: "visa_status", object_text: "F-1 OPT", object_key: null, confidence: 1, valid_from: null, valid_to: null, quote: "I am on F-1 OPT" };
const handler = ({ system, user }: { system: string; user: string }) =>
  system === SUMMARY_SYSTEM
    ? { title: "Untitled", summary_line: "A note.", summary: "A note.", occurred_at: null }
    : { entities: [], relations: [], facts_about_self: user.includes("F-1 OPT") ? [visaFact] : [] };

async function seed() {
  const ctx = fakeCtx(sql, handler);
  await ingest(ctx, { text: "Acme Corp sponsors H-1B visas for analysts. Base salary is $115,000 to $140,000. I am on F-1 OPT.", sourceKind: "note", title: "Acme visa note" });
  await ingest(ctx, { text: "Gardening notes: tomatoes need full sun and deep watering.", sourceKind: "note", title: "Garden" });
  return ctx;
}

describe("parseCite", () => {
  it("normalises labels and ids and rejects anything else", () => {
    expect(parseCite(" [p3] ")).toEqual({ kind: "P", index: 2, label: "P3" });
    expect(parseCite("F01")).toEqual({ kind: "F", index: 0, label: "F1" });
    expect(parseCite("0E2F1C3A-0000-4000-8000-000000000001")).toEqual({ kind: "id", id: "0e2f1c3a-0000-4000-8000-000000000001", label: "0e2f1c3a-0000-4000-8000-000000000001" });
    expect(parseCite("doc 7")).toEqual({ kind: "invalid", label: "doc 7" });
  });
});

describe("verifyClaims", () => {
  it("resolves P and F labels through the logged search, judges each claim, and writes one audit row", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Acme visa sponsorship salary F-1 OPT", { k: 3, client: "test" });
    const p1 = res.passages[0];
    expect(p1.title).toBe("Acme visa note");
    expect(res.facts.map((f) => f.predicate)).toEqual(["visa_status"]);

    const v = (await verifyClaims(sql, res.retrievalId, [
      { text: "Acme Corp sponsors H-1B visas for analysts [P1].", cites: ["P1"] },
      { text: "Acme pays $150,000.", cites: ["p1"] },
      { text: "Acme was founded by astronauts on the moon.", cites: ["P1"] },
      { text: "My visa status is F-1 OPT.", cites: ["F1"] },
      { text: "Acme sponsors visas.", cites: ["P99"] },
      { text: "I think Acme is a good fit.", cites: [] },
      { text: "Acme sponsors H-1B visas.", cites: [p1.chunkId!, "P1", "nonsense"] },
      { text: "My visa status is F-1 OPT.", cites: [res.facts[0].id] },
    ], { client: "test" }))!;

    expect(v.retrievalId).toBe(res.retrievalId);
    expect(v.claims.map((c) => c.verdict)).toEqual(["supported", "partial", "unsupported", "supported", "bad_citation", "uncited", "supported", "supported"]);
    expect(v.claims[0]).toMatchObject({ claim: "Acme Corp sponsors H-1B visas for analysts.", labels: ["P1"], support: 1, missingNumbers: [] });
    expect(v.claims[0].cites).toEqual([{ label: "P1", kind: "passage", documentId: p1.documentId, chunkId: p1.chunkId, factId: null, title: "Acme visa note" }]);
    expect(v.claims[1]).toMatchObject({ labels: ["P1"], missingNumbers: ["$150000"] });
    expect(v.claims[2].missingTerms).toEqual(expect.arrayContaining(["founded", "astronauts", "moon"]));
    expect(v.claims[3].cites).toEqual([{ label: "F1", kind: "fact", documentId: p1.documentId, chunkId: null, factId: res.facts[0].id, title: "visa_status: F-1 OPT" }]);
    expect(v.claims[4].badLabels).toEqual([{ label: "P99", reason: `no P99 in this search (it returned ${res.passages.length} passage${res.passages.length === 1 ? "" : "s"})` }]);
    expect(v.claims[6]).toMatchObject({ labels: [p1.chunkId, "P1", "nonsense"], badLabels: [{ label: "nonsense", reason: "not a label (P1, F1) or a passage or fact id" }] });
    expect(v.claims[7].cites[0]).toMatchObject({ kind: "fact", factId: res.facts[0].id });
    expect(v.summary).toEqual({ supported: 4, partial: 1, unsupported: 1, uncited: 1, bad_citation: 1, text: "4 supported, 1 partial, 1 unsupported, 1 uncited, 1 bad citation" });
    expect(v.notes).toEqual([]);

    const rows = await sql<{ id: string; retrieval_id: string; client: string; claims: unknown; results: unknown; summary: unknown }[]>`
      select id, retrieval_id, client, claims, results, summary from brain.verification_log`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: v.verificationId, retrieval_id: res.retrievalId, client: "test", results: v.claims, summary: v.summary });
    expect((rows[0].claims as { text: string }[])[1]).toEqual({ text: "Acme pays $150,000.", cites: ["p1"] });
  });

  it("rebuilds a fallback passage from its document's raw text and character window", async () => {
    const ctx = await seed();
    ctx.reranker = { rerank: async (_q: string, docs: string[], k: number) => docs.slice(0, k).map((_d, index) => ({ index, score: 0.01 })) };
    const res = await search(ctx, "H-1B", { k: 3 });
    const i = res.passages.findIndex((p) => p.chunkId === null);
    expect(i).toBeGreaterThanOrEqual(0);
    const label = `P${i + 1}`;
    const v = (await verifyClaims(sql, res.retrievalId, [{ text: "Acme Corp sponsors H-1B visas.", cites: [label] }], { client: "test" }))!;
    expect(v.claims[0]).toMatchObject({ verdict: "supported", cites: [{ label, kind: "passage", chunkId: null, documentId: res.passages[i].documentId }] });
  });

  it("reports labels it cannot resolve: a passage no longer stored, and searches logged before facts or passages were recorded", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Acme visa F-1 OPT", { k: 3 });
    await sql`update brain.retrieval_log set facts = null where id = ${res.retrievalId}`;
    const noFacts = (await verifyClaims(sql, res.retrievalId, [{ text: "My visa status is F-1 OPT.", cites: ["F1"] }], { client: "test" }))!;
    expect(noFacts.claims[0]).toMatchObject({ verdict: "bad_citation", badLabels: [{ label: "F1", reason: "facts were not logged for this search (before migration 012)" }] });
    expect(noFacts.notes).toEqual([NOTE_NO_FACTS]);

    const [old] = await sql<{ id: string }[]>`
      insert into brain.retrieval_log (query, filters, layers, chunk_ids, node_ids, top_score, used_fallback, client)
      values ('old', '{}'::jsonb, '{hybrid}', '{}'::uuid[], '{}'::uuid[], 0.5, false, 'cli') returning id`;
    const v1 = (await verifyClaims(sql, old.id, [{ text: "Acme sponsors visas.", cites: ["P1", "F1", res.passages[0].chunkId!] }], { client: "test" }))!;
    expect(v1.claims[0].verdict).toBe("supported");
    expect(v1.claims[0].badLabels.map((b) => b.label)).toEqual(["P1", "F1"]);
    expect(v1.notes).toEqual([NOTE_NO_RESULTS, NOTE_NO_FACTS]);

    await sql`delete from brain.chunks where id = ${res.passages[0].chunkId}`;
    const gone = (await verifyClaims(sql, res.retrievalId, [{ text: "Acme sponsors visas.", cites: ["P1"] }], { client: "test" }))!;
    expect(gone.claims[0]).toMatchObject({ verdict: "bad_citation", badLabels: [{ label: "P1", reason: "P1's passage is no longer stored (its document was re-chunked or deleted)" }] });
  });

  it("notes when a raw fact id names a superseded fact, and checks the claim against the stored text", async () => {
    const ctx = await seed();
    const res = await search(ctx, "Acme visa F-1 OPT", { k: 3 });
    const old = res.facts[0].id;
    const [next] = await sql<{ id: string }[]>`
      insert into brain.facts (subject_id, predicate, object_text, confidence, source_chunk_id)
      select subject_id, predicate, 'H-1B', confidence, source_chunk_id from brain.facts where id = ${old} returning id`;
    await sql`update brain.facts set superseded_by = ${next.id} where id = ${old}`;
    const v = (await verifyClaims(sql, res.retrievalId, [{ text: "My visa status is F-1 OPT.", cites: [old] }], { client: "test" }))!;
    expect(v.claims[0]).toMatchObject({ verdict: "supported", cites: [{ kind: "fact", factId: old }] });
    expect(v.notes).toEqual([`fact ${old} was superseded; checked against the stored text`]);
  });

  it("returns null for an unknown or malformed retrieval id and writes nothing", async () => {
    expect(await verifyClaims(sql, "00000000-0000-0000-0000-000000000000", [{ text: "x", cites: [] }], { client: "test" })).toBeNull();
    expect(await verifyClaims(sql, "not-an-id", [{ text: "x", cites: [] }], { client: "test" })).toBeNull();
    expect((await sql`select id from brain.verification_log`).length).toBe(0);
  });

  it("refuses no claims, more than 50 claims, a claim over 2,000 characters, and more than 20 cites", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    await expect(verifyClaims(sql, id, [], { client: "test" })).rejects.toThrow("claims: Too small: expected array to have >=1 items");
    await expect(verifyClaims(sql, id, Array.from({ length: 51 }, () => ({ text: "x", cites: [] })), { client: "test" })).rejects.toThrow("claims: Too big: expected array to have <=50 items");
    await expect(verifyClaims(sql, id, [{ text: "x".repeat(2001), cites: [] }], { client: "test" })).rejects.toThrow("claims.0.text: Too big: expected string to have <=2000 characters");
    await expect(verifyClaims(sql, id, [{ text: "x", cites: Array.from({ length: 21 }, (_, i) => `P${i + 1}`) }], { client: "test" })).rejects.toThrow("claims.0.cites: Too big: expected array to have <=20 items");
  });
});
