import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
