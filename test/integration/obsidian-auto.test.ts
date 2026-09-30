import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, wipe, fakeCtx } from "./helpers.js";
import { fakeExtraction } from "./fixtures.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { SUMMARY_SYSTEM } from "../../src/ingest/stages/summarize.js";
import { projectObsidian } from "../../src/obsidian/project.js";
import { ObsidianAutoProjector } from "../../src/obsidian/auto.js";
import type { Ctx } from "../../src/ctx.js";
import type { SyncResult } from "../../src/obsidian/write.js";

const sql = testDb();
afterAll(() => sql.end());
beforeEach(() => wipe(sql));

const handler = ({ system }: { system: string }) =>
  system === SUMMARY_SYSTEM ? { title: "Acme note", summary_line: "L", summary: "Applying to Acme.", occurred_at: "2026-09-01" } : fakeExtraction;

/** A test ctx whose saves refresh a temporary vault, the way makeCtx wires the real one. */
async function autoCtx(opts: { debounceMs?: number; project?: (ctx: Ctx) => Promise<SyncResult>; handler?: (args: { system: string; user: string }) => unknown } = {}) {
  const vault = await mkdtemp(join(tmpdir(), "vault-auto-"));
  const logs: string[] = [];
  const ctx: Ctx = fakeCtx(sql, opts.handler ?? handler);
  const projector = new ObsidianAutoProjector(ctx, {
    debounceMs: opts.debounceMs ?? 50,
    project: opts.project ?? ((c) => projectObsidian(c, { vault, folder: "Brain" })),
    log: (m) => logs.push(m),
  });
  const changed: string[] = [];
  ctx.onDocumentChanged = (id) => {
    changed.push(id);
    projector.notify();
  };
  ctx.obsidian = projector;
  return { ctx, projector, vault, logs, changed };
}

async function notesIn(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".md")).sort();
}

describe("automatic Obsidian refresh", () => {
  it("writes the document and entity notes after a full ingest", async () => {
    const { ctx, projector, vault, logs, changed } = await autoCtx();
    const res = await ingest(ctx, { text: "I applied to Acme Corp in September. I am on F-1 OPT.", sourceKind: "note" });
    expect(res.stage).toBe("done");
    expect(changed).toEqual([res.id, res.id]); // once at chunked, once at done
    await projector.flush();
    const root = join(vault, "Brain");
    expect(await notesIn(root)).toEqual(["Frank Fu.md", "README.md", "documents/2026/Acme note.md", "nodes/organization/Acme Corp.md"]);
    expect(await readFile(join(root, "documents/2026/Acme note.md"), "utf8")).toContain("[[Acme Corp]]");
    expect(logs).toEqual([]);
  });

  it("writes the document note with its raw text as soon as the document is chunked", async () => {
    const { ctx, projector, vault, changed } = await autoCtx();
    const res = await ingest(ctx, { text: "Raw words before enrichment.", title: "Early note", sourceKind: "note" }, { until: "chunked" });
    expect(res.stage).toBe("chunked");
    expect(changed).toEqual([res.id]);
    await projector.flush();
    const docs = (await notesIn(join(vault, "Brain"))).filter((f) => f.startsWith("documents/"));
    expect(docs).toEqual([`documents/${new Date().getUTCFullYear()}/Early note.md`]);
    expect(await readFile(join(vault, "Brain", docs[0]), "utf8")).toContain("Raw words before enrichment.");
  });

  it("does not report a document changed for a failed or no-op run", async () => {
    const failing = ({ system }: { system: string }) => {
      if (system === SUMMARY_SYSTEM) return { title: "T", summary_line: "L", summary: "S", occurred_at: null };
      throw new Error("boom");
    };
    const { ctx, changed } = await autoCtx({ handler: failing });
    const res = await ingest(ctx, { text: "Extraction will fail here." });
    expect(res.error).toBe("boom");
    expect(changed).toEqual([res.id]); // chunked only, never done
    await ingest(ctx, { text: "Extraction will fail here." }, { until: "chunked" }); // duplicate, already past chunked
    expect(changed).toEqual([res.id]);
  });

  it("a failing projection or change hook never changes the ingest result", async () => {
    const text = "I applied to Acme Corp in September. I am on F-1 OPT.";
    // A long debounce so only the flush runs the projection, making exactly one failure to log.
    const { ctx, projector, logs } = await autoCtx({
      debounceMs: 60_000,
      project: async () => {
        throw new Error("vault unwritable");
      },
    });
    const res = await ingest(ctx, { text, sourceKind: "note" });
    expect(res).toMatchObject({ stage: "done", error: null, created: true });
    await projector.flush();
    expect(logs).toEqual(["brain: obsidian refresh failed: vault unwritable"]);

    await wipe(sql);
    const throwing: Ctx = {
      ...fakeCtx(sql, handler),
      onDocumentChanged: () => {
        throw new Error("hook broke");
      },
    };
    expect(await ingest(throwing, { text, sourceKind: "note" })).toMatchObject({ stage: "done", error: null, created: true });
  });
});
