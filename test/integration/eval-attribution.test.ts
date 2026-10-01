import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { attributionLeaks } from "../../src/eval/run.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

describe("attributionLeaks", () => {
  it("counts facts about the owner and edges from the owner whose evidence is in a document the owner did not write", async () => {
    const ctx = fakeCtx(sql);
    const other = await ingest(ctx, { text: "Someone else's post.", sourceKind: "note", author: "other" }, { until: "chunked" });
    const mine = await ingest(ctx, { text: "My own note.", sourceKind: "note" }, { until: "chunked" });
    const chunk = async (documentId: string) =>
      (await sql<{ id: string }[]>`select id from brain.chunks where document_id = ${documentId} and level = 1 limit 1`)[0].id;
    const [self] = await sql<{ id: string }[]>`select id from brain.nodes where is_self`;
    const [acme] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name) values ('organization', 'Acme', 'acme') returning id`;
    // Written directly, as resolve without the author gate would have written them.
    await sql`insert into brain.facts (subject_id, predicate, object_text, source_chunk_id) values (${self.id}, 'view_on', 'x', ${await chunk(other.id)})`;
    await sql`insert into brain.facts (subject_id, predicate, object_text, source_chunk_id) values (${self.id}, 'lives_in', 'Denver', ${await chunk(mine.id)})`;
    await sql`insert into brain.edges (from_node, to_node, type, evidence_chunk_id) values (${self.id}, ${acme.id}, 'applied_to', ${await chunk(other.id)})`;
    await sql`insert into brain.edges (from_node, to_node, type, evidence_chunk_id) values (${acme.id}, ${self.id}, 'related_to', ${await chunk(other.id)})`;
    expect(await attributionLeaks(sql)).toEqual({ selfFacts: 1, selfEdges: 1 });
  });
});
