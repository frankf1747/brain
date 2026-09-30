import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { projectObsidian } from "../../src/obsidian/project.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "Applying to Acme.", occurred_at: "2026-09-01" } : fakeExtraction;

describe("projectObsidian", () => {
  it("writes linked notes, is idempotent, and removes notes for deleted nodes", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT.", sourceKind: "note" });
    const vault = await mkdtemp(join(tmpdir(), "vault-"));

    const first = await projectObsidian(ctx, { vault, folder: "Brain" });
    expect(first.written).toBe(4); // README, Frank Fu, Acme Corp, the document
    const acme = await readFile(join(vault, "Brain/nodes/organization/Acme Corp.md"), "utf8");
    expect(acme).toContain("applied_to ← [[Frank Fu]]");
    expect(acme).toContain("[[Acme note]]");
    const self = await readFile(join(vault, "Brain/Frank Fu.md"), "utf8");
    expect(self).toContain("visa_status: F-1 OPT");
    expect(self).toContain("applied_to → [[Acme Corp]]");
    expect(self).toContain('applied_to → [[Acme Corp]] · "applied to Acme Corp" ([[Acme note]])');
    const doc = await readFile(join(vault, "Brain/documents/2026/Acme note.md"), "utf8");
    expect(doc).toContain("[[Acme Corp]]");
    expect(doc).toContain("I applied to Acme Corp");

    const second = await projectObsidian(ctx, { vault, folder: "Brain" });
    expect(second.written).toBe(0);

    await sql`delete from brain.nodes where canonical_name = 'acme corp'`;
    const third = await projectObsidian(ctx, { vault, folder: "Brain" });
    expect(third.deleted).toBe(1);
    await expect(readdir(join(vault, "Brain/nodes/organization"))).rejects.toThrow();
  });

  it("keeps the README timestamp when nothing else changed and refreshes it when something did", async () => {
    const ctx = fakeCtx(sql, handler);
    await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT.", sourceKind: "note" });
    const vault = await mkdtemp(join(tmpdir(), "vault-"));
    const readme = () => readFile(join(vault, "Brain/README.md"), "utf8");

    await projectObsidian(ctx, { vault, folder: "Brain", now: new Date("2026-09-01T00:00:00Z") });
    const noop = await projectObsidian(ctx, { vault, folder: "Brain", now: new Date("2026-09-02T00:00:00Z") });
    expect(noop).toEqual({ written: 0, unchanged: 4, deleted: 0, skipped: [] });
    expect(await readme()).toContain("2026-09-01T00:00:00.000Z");

    await sql`delete from brain.nodes where canonical_name = 'acme corp'`;
    const changed = await projectObsidian(ctx, { vault, folder: "Brain", now: new Date("2026-09-03T00:00:00Z") });
    expect(changed.deleted).toBe(1);
    expect(changed.written + changed.unchanged).toBe(3); // README, Frank Fu, the document
    expect(await readme()).toContain("2026-09-03T00:00:00.000Z");
  });

  it("gives every note a unique name across nodes, documents and the README", async () => {
    const ctx = fakeCtx(sql);
    const [self] = await sql<{ id: string; name: string }[]>`select id, name from brain.nodes where is_self`;
    let seq = 0;
    const node = async (type: string, name: string) => {
      seq++;
      const [r] = await sql<{ id: string }[]>`insert into brain.nodes (type, name, canonical_name, created_at)
        values (${type}, ${name}, ${`${name.toLowerCase()}#${seq}`}, now() + ${`${seq} seconds`}::interval) returning id`;
      return r!.id;
    };
    const doc = async (title: string) => {
      seq++;
      const [d] = await sql<{ id: string }[]>`insert into brain.documents (content_hash, title, raw_content, occurred_at, ingested_at)
        values (${`h${seq}`}, ${title}, 'body', '2026-01-01', now() + ${`${seq} seconds`}::interval) returning id`;
      const [c] = await sql<{ id: string }[]>`insert into brain.chunks (document_id, level, ordinal, content, token_count, char_start, char_end)
        values (${d!.id}, 0, 0, 'body', 1, 0, 4) returning id`;
      return { id: d!.id, chunk: c!.id };
    };
    const acme = await node("organization", "Acme");
    const readmeNode = await node("concept", "readme");
    const acmeDoc = await doc("Acme");
    const selfDoc = await doc(self!.name);
    const readmeDoc = await doc("README");
    for (const [chunk, id] of [[acmeDoc.chunk, acme], [selfDoc.chunk, self!.id], [readmeDoc.chunk, readmeNode]] as const) {
      await sql`insert into brain.mentions (chunk_id, node_id) values (${chunk}, ${id})`;
    }
    await sql`insert into brain.edges (from_node, to_node, type, evidence_chunk_id) values (${self!.id}, ${acme}, 'works_at', ${acmeDoc.chunk})`;

    const vault = await mkdtemp(join(tmpdir(), "vault-"));
    await projectObsidian(ctx, { vault, folder: "Brain" });
    const root = join(vault, "Brain");
    const walk = async (d: string): Promise<string[]> =>
      (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])))).flat();
    const files = (await walk(root)).map((f) => relative(root, f));
    const base = (f: string) => f.split("/").pop()!.slice(0, -3);

    expect(await readFile(join(root, `${self!.name}.md`), "utf8")).toContain(`brain_id: "${self!.id}"`);
    expect(await readFile(join(root, "README.md"), "utf8")).toContain("# Brain");
    expect(await readFile(join(root, "nodes/organization/Acme.md"), "utf8")).toContain(`brain_id: "${acme}"`);
    const bases = files.map((f) => base(f).toLowerCase());
    expect(new Set(bases).size).toBe(bases.length);
    expect(bases.filter((b) => b === "readme")).toEqual(["readme"]);

    const byName = new Map<string, number>();
    for (const b of bases) byName.set(b, (byName.get(b) ?? 0) + 1);
    const links: string[] = [];
    for (const f of files) {
      const text = await readFile(join(root, f), "utf8");
      for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) links.push(m[1]!);
    }
    expect(links.length).toBeGreaterThan(5);
    for (const l of links) expect([l, byName.get(l.toLowerCase())]).toEqual([l, 1]);
  });
});
