import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { storeDocument } from "../../src/ingest/store.js";
import { runChunk } from "../../src/ingest/stages/chunk.js";
import { runExtract } from "../../src/ingest/stages/extract.js";
import { runResolve } from "../../src/ingest/stages/resolve.js";
import { fakeExtraction } from "./fixtures.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const text = "I applied to Acme Corp in September. I am on F-1 OPT so sponsorship matters.";

async function ingestWith(payload: unknown, body = text) {
  const ctx = fakeCtx(sql, () => payload);
  const { id } = await storeDocument(sql, { text: body });
  await runChunk(ctx, id);
  await runExtract(ctx, id);
  await runResolve(ctx, id);
  return { ctx, id };
}

describe("runResolve", () => {
  it("maps the owner to the self node, creates the organization, and writes edge, mentions and fact", async () => {
    const { id } = await ingestWith(fakeExtraction);
    const people = await sql<{ is_self: boolean }[]>`select is_self from brain.nodes where type = 'person'`;
    expect(people.length).toBe(1);
    expect(people[0].is_self).toBe(true);

    const [acme] = await sql<{ id: string; aliases: string[]; verified_by: string }[]>`
      select id, aliases, verified_by from brain.nodes where type = 'organization' and canonical_name = 'acme corp'`;
    expect(acme.aliases).toEqual(["acme"]);
    expect(acme.verified_by).toBe("extractor:fake");

    const edges = await sql<{ type: string; evidence_chunk_id: string | null; valid_from: Date }[]>`
      select type, evidence_chunk_id, valid_from from brain.edges`;
    expect(edges.length).toBe(1);
    expect(edges[0].type).toBe("applied_to");
    expect(edges[0].evidence_chunk_id).not.toBeNull();

    const mentions = await sql<{ span_start: number | null; span_end: number | null; content: string }[]>`
      select m.span_start, m.span_end, c.content from brain.mentions m join brain.chunks c on c.id = m.chunk_id
      join brain.nodes n on n.id = m.node_id where n.id = ${acme.id}`;
    expect(mentions.length).toBe(1);
    expect(mentions[0].content.slice(mentions[0].span_start!, mentions[0].span_end!)).toBe("Acme Corp");

    const facts = await sql<{ predicate: string; object_text: string; source_chunk_id: string | null; verified_by: string }[]>`
      select predicate, object_text, source_chunk_id, verified_by from brain.facts`;
    expect(facts).toEqual([expect.objectContaining({ predicate: "visa_status", object_text: "F-1 OPT", verified_by: "extractor:fake" })]);
    expect(facts[0].source_chunk_id).not.toBeNull();
    expect((await sql`select id from brain.documents where id = ${id}`).length).toBe(1);
  });

  it("reuses a node on exact canonical match and on alias match", async () => {
    await ingestWith(fakeExtraction);
    const variant = {
      ...fakeExtraction,
      entities: [{ key: "e2", type: "organization", name: "ACME Corp.", aliases: [], untyped_hint: null, quote: "Acme" }],
      relations: [],
      facts_about_self: [],
    };
    await ingestWith(variant, "A second note mentioning Acme again.");
    const byAlias = { ...variant, entities: [{ ...variant.entities[0], name: "Acme" }] };
    await ingestWith(byAlias, "Third note, just Acme.");
    const orgs = await sql`select id from brain.nodes where type = 'organization'`;
    expect(orgs.length).toBe(1);
  });

  it("maps unknown node types to concept with a hint and unknown edge types to related_to", async () => {
    const odd = {
      entities: [
        { key: "a", type: "startup", name: "Zorblax", aliases: [], untyped_hint: "a company", quote: "Zorblax" },
        { key: "b", type: "person", name: "Ann Lee", aliases: [], untyped_hint: null, quote: "Ann Lee" },
      ],
      relations: [{ from_key: "b", to_key: "a", type: "funded_by", confidence: 0.5, valid_from: null, valid_to: null, quote: "Ann Lee funded Zorblax" }],
      facts_about_self: [],
    };
    await ingestWith(odd, "Ann Lee funded Zorblax last year.");
    const [z] = await sql<{ type: string; properties: { untyped_hint: string } }[]>`select type, properties from brain.nodes where canonical_name = 'zorblax'`;
    expect(z.type).toBe("concept");
    expect(z.properties.untyped_hint).toBe("a company");
    const [e] = await sql<{ type: string; properties: { original_type: string } }[]>`select type, properties from brain.edges`;
    expect(e.type).toBe("related_to");
    expect(e.properties.original_type).toBe("funded_by");
  });

  it("is idempotent", async () => {
    const { ctx, id } = await ingestWith(fakeExtraction);
    await runResolve(ctx, id);
    const [{ n }] = await sql<{ n: string }[]>`select count(*)::text as n from brain.edges`;
    expect(Number(n)).toBe(1);
    const [{ f }] = await sql<{ f: string }[]>`select count(*)::text as f from brain.facts`;
    expect(Number(f)).toBe(1);
  });
});
