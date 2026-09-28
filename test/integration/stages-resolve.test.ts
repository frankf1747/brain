import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { storeDocument } from "../../src/ingest/store.js";
import { runChunk } from "../../src/ingest/stages/chunk.js";
import { runExtract } from "../../src/ingest/stages/extract.js";
import { runResolve } from "../../src/ingest/stages/resolve.js";
import { fakeExtraction } from "./fixtures.js";
import { fakeVector } from "./helpers.js";
import type { Embedder } from "../../src/llm/voyage.js";

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

function person(name: string, aliases: string[] = []) {
  return { key: "p", type: "person", name, aliases, untyped_hint: null, quote: name };
}
function org(name: string, aliases: string[] = []) {
  return { key: "o", type: "organization", name, aliases, untyped_hint: null, quote: name };
}
function only(entity: ReturnType<typeof person>) {
  return { entities: [entity], relations: [], facts_about_self: [] };
}

/** Every name gets the same vector, so vector similarity alone always says "match". */
const sameVectorEmbedder: Embedder = { embed: async (texts) => texts.map(() => fakeVector(7)) };

async function ingestSameVector(payload: unknown, body: string) {
  const ctx = { ...fakeCtx(sql, () => payload), embedder: sameVectorEmbedder };
  const { id } = await storeDocument(sql, { text: body });
  await runChunk(ctx, id);
  await runExtract(ctx, id);
  await runResolve(ctx, id);
}

describe("runResolve alias safety", () => {
  it("does not merge two people who share only a first-name alias", async () => {
    await ingestWith(only(person("Priya Natarajan", ["Priya"])), "Priya Natarajan runs the data team.");
    await ingestWith(only(person("Priya Raman", ["Priya"])), "Priya Raman is a recruiter.");
    const names = await sql<{ name: string }[]>`select name from brain.nodes where type = 'person' and not is_self order by name`;
    expect(names.map((n) => n.name)).toEqual(["Priya Natarajan", "Priya Raman"]);
  });

  it("does not merge two organizations that share an alias", async () => {
    await ingestWith(only(org("Acme Corp", ["Acme"])), "Acme Corp builds rockets.");
    await ingestWith(only(org("Acme Capital", ["Acme"])), "Acme Capital invests in rockets.");
    const orgs = await sql`select id from brain.nodes where type = 'organization'`;
    expect(orgs.length).toBe(2);
  });

  it("creates a flagged node when a name matches aliases of several distinct nodes", async () => {
    await ingestWith(only(person("Priya Natarajan", ["Priya"])), "Priya Natarajan runs the data team.");
    await ingestWith(only(person("Priya Raman", ["Priya"])), "Priya Raman is a recruiter.");
    await ingestWith(only(person("Priya")), "Priya called me.");
    const [oldest] = await sql<{ id: string }[]>`select id from brain.nodes where canonical_name = 'priya natarajan'`;
    const [p] = await sql<{ properties: { possible_duplicate_of?: string } }[]>`
      select properties from brain.nodes where type = 'person' and canonical_name = 'priya'`;
    expect(p.properties.possible_duplicate_of).toBe(oldest.id);
  });
});

describe("runResolve vector merges of people and organizations", () => {
  it("does not merge people on vector similarity alone", async () => {
    await ingestSameVector(only(person("Jane Smith")), "Jane Smith is an engineer.");
    await ingestSameVector(only(person("Robert Chen")), "Robert Chen is a designer.");
    const [jane] = await sql<{ id: string }[]>`select id from brain.nodes where canonical_name = 'jane smith'`;
    const [robert] = await sql<{ properties: { possible_duplicate_of?: string } }[]>`
      select properties from brain.nodes where canonical_name = 'robert chen'`;
    expect(robert).toBeDefined();
    expect(robert.properties.possible_duplicate_of).toBe(jane.id);
  });

  it("merges people when the vector match has lexical support", async () => {
    await ingestSameVector(only(person("Priya Natarajan")), "Priya Natarajan runs the data team.");
    await ingestSameVector(only(person("Priya Natarajan Rao")), "Priya Natarajan Rao said hi.");
    const people = await sql`select id from brain.nodes where type = 'person' and not is_self`;
    expect(people.length).toBe(1);
  });
});

function entity(key: string, type: string, name: string) {
  return { key, type, name, aliases: [], untyped_hint: null, quote: name };
}
function relation(from_key: string, to_key: string, type: string, quote: string) {
  return { from_key, to_key, type, confidence: 0.9, valid_from: null, valid_to: null, quote };
}
async function edgeEndpoints() {
  return sql<{ type: string; from_name: string; to_name: string; properties: Record<string, unknown> }[]>`
    select e.type, f.name as from_name, t.name as to_name, e.properties
    from brain.edges e join brain.nodes f on f.id = e.from_node join brain.nodes t on t.id = e.to_node`;
}

describe("runResolve edge direction", () => {
  it("swaps a created edge extracted as artifact -> organization", async () => {
    const body = "Acme Corp built the ZX-9000 printer.";
    await ingestWith(
      {
        entities: [entity("a", "artifact", "ZX-9000"), entity("o", "organization", "Acme Corp")],
        relations: [relation("a", "o", "created", body)],
        facts_about_self: [],
      },
      body,
    );
    const edges = await edgeEndpoints();
    expect(edges.length).toBe(1);
    expect(edges[0]).toMatchObject({ type: "created", from_name: "Acme Corp", to_name: "ZX-9000" });
    expect(edges[0].properties.direction_unverified).toBeUndefined();
  });

  it("swaps a located_in edge extracted as place -> organization", async () => {
    const body = "Acme Corp is based in Boston.";
    await ingestWith(
      {
        entities: [entity("p", "place", "Boston"), entity("o", "organization", "Acme Corp")],
        relations: [relation("p", "o", "located_in", body)],
        facts_about_self: [],
      },
      body,
    );
    const edges = await edgeEndpoints();
    expect(edges[0]).toMatchObject({ type: "located_in", from_name: "Acme Corp", to_name: "Boston" });
  });

  it("keeps a person -> person works_at edge as extracted and flags it", async () => {
    const body = "Jane Smith works at Robert Chen.";
    await ingestWith(
      {
        entities: [entity("j", "person", "Jane Smith"), entity("r", "person", "Robert Chen")],
        relations: [relation("j", "r", "works_at", body)],
        facts_about_self: [],
      },
      body,
    );
    const edges = await edgeEndpoints();
    expect(edges[0]).toMatchObject({ type: "works_at", from_name: "Jane Smith", to_name: "Robert Chen" });
    expect(edges[0].properties.direction_unverified).toBe(true);
  });

  it("leaves edge types outside the table untouched", async () => {
    const body = "Boston is part of Acme Corp somehow.";
    await ingestWith(
      {
        entities: [entity("p", "place", "Boston"), entity("o", "organization", "Acme Corp")],
        relations: [relation("p", "o", "part_of", body)],
        facts_about_self: [],
      },
      body,
    );
    const edges = await edgeEndpoints();
    expect(edges[0]).toMatchObject({ type: "part_of", from_name: "Boston", to_name: "Acme Corp" });
    expect(edges[0].properties).toEqual({});
  });
});
