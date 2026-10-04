import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDb, wipe, fakeCtx, TEST_DATABASE_URL } from "./helpers.js";
import { connectReadOnly } from "../../src/db.js";
import { ingest } from "../../src/ingest/pipeline.js";
import { search } from "../../src/retrieve/search.js";
import { capturedSearches, renderCaptured, labelCaptured } from "../../src/eval/capture.js";
import { loadGolden, loadGoldenAll } from "../../src/eval/golden.js";

const sql = testDb();
// The retrieval log is read through a read-only connection, as `brain eval capture` reads the real base.
const log = connectReadOnly(TEST_DATABASE_URL);
afterAll(() => Promise.all([sql.end(), log.end()]));

const run = promisify(execFile);

/** Runs `brain eval …` with every database URL on brain_test; the commands that need an eval database refuse it. */
async function brainEval(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("node_modules/.bin/tsx", ["src/cli.ts", "eval", ...args], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, EVAL_DATABASE_URL: TEST_DATABASE_URL, EVAL_REAL_DATABASE_URL: TEST_DATABASE_URL, OBSIDIAN_AUTO: "0" },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

let goldenPath: string;
/** Real items quote the owner's private documents, so label writes them to the gitignored golden-real.jsonl next to golden.jsonl. */
let realGoldenPath: string;
let docId: string;
let retrievalId: string;

beforeEach(async () => {
  await wipe(sql);
  const ctx = fakeCtx(sql);
  const doc = await ingest(ctx, { text: "# Moved to Denver\n\nI signed a lease in the Highland neighborhood, so I now live in Denver for good.", title: "Moved to Denver", sourceKind: "note", origin: "eval/corpus/note--moved-to-denver.md" }, { until: "chunked" });
  docId = doc.id;
  retrievalId = (await search(ctx, "where do I live now", { client: "mcp-stdio", k: 3 })).retrievalId;
  await search(ctx, "denver lease", { client: "cli", sourceKinds: ["note"] });
  const dir = await mkdtemp(join(tmpdir(), "capture-"));
  goldenPath = join(dir, "golden.jsonl");
  realGoldenPath = join(dir, "golden-real.jsonl");
  await writeFile(goldenPath, "");
});

describe("capturedSearches", () => {
  it("lists recent searches newest first with their top passages, filtered by client", async () => {
    const all = await capturedSearches(log);
    expect(all.map((s) => s.query)).toEqual(["denver lease", "where do I live now"]);
    expect(all[0].sourceKinds).toEqual(["note"]);
    const mcp = await capturedSearches(log, { client: "mcp-stdio" });
    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toMatchObject({ id: retrievalId, client: "mcp-stdio", mode: "hybrid", query: "where do I live now" });
    expect(mcp[0].passages![0]).toMatchObject({ label: "P1", title: "Moved to Denver", documentId: docId, sourceKind: "note" });
    const text = renderCaptured(mcp, "real");
    expect(text).toContain(`${retrievalId}  `);
    expect(text).toContain('  "where do I live now"');
    expect(text).toMatch(/ {4}P1 \d\.\d\d rerank · note · "Moved to Denver" \(doc [0-9a-f-]{36}\)/);
    expect(text).toContain("npm run brain -- eval label <retrieval id> --expect <document id> [--quote");
    expect(await capturedSearches(log, { since: new Date(Date.now() + 60_000) })).toEqual([]);
  });

  it("shows a row logged before evidence v2 without passages", async () => {
    await sql`insert into brain.retrieval_log (query, client) values ('old question', 'mcp-stdio')`;
    const [old] = await capturedSearches(log, { limit: 1 });
    expect(old.passages).toBeNull();
    expect(renderCaptured([old], "real")).toContain("(logged before evidence v2: no passages recorded)");
  });

  it("cannot write through the read-only connection", async () => {
    await expect(log`insert into brain.tool_calls (client, tool, args, ok) values ('x', 'y', '{}'::jsonb, true)`).rejects.toThrow(/read-only transaction/);
  });
});

describe("labelCaptured", () => {
  it("writes a captured item approved by the owner: the logged query, the expected document by id, the quote, the retrieval id", async () => {
    const item = await labelCaptured(log, sql, { retrievalId, expect: docId, quote: "I now live in Denver for good", corpus: "real", goldenPath, today: "2026-10-04" });
    expect(item).toEqual({
      id: `c-${retrievalId.slice(0, 8)}`, question: "where do I live now", kind: "semantic",
      expected: [{ document_id: docId, quote: "I now live in Denver for good" }], source: "captured", negative: false, corpus: "real",
      approved_by: "owner", approved_at: "2026-10-04", retrieval_id: retrievalId,
    });
    expect(await loadGolden(realGoldenPath)).toEqual([item]);
    // The committed fixtures file never receives a real item.
    expect(await readFile(goldenPath, "utf8")).toBe("");
  });

  it("names a fixture by file name, and takes a negative or a filter item from the logged search", async () => {
    const fixture = await labelCaptured(log, sql, { retrievalId, expect: "note--moved-to-denver.md", corpus: "fixtures", goldenPath, today: "2026-10-04" });
    expect(fixture.expected).toEqual([{ origin: "note--moved-to-denver.md" }]);
    expect(await loadGolden(goldenPath)).toEqual([fixture]);
    const [lease] = await capturedSearches(log, { client: "cli" });
    const filter = await labelCaptured(log, sql, { retrievalId: lease.id, expect: docId, kind: "filter", corpus: "real", goldenPath });
    expect(filter.filters).toEqual({ sourceKinds: ["note"] });
  });

  it("refuses a document missing from the eval database, with how to fix it, and a quote that is not verbatim", async () => {
    await expect(labelCaptured(log, sql, { retrievalId, expect: "00000000-0000-4000-8000-000000000000", corpus: "real", goldenPath })).rejects.toThrow(
      "document 00000000-0000-4000-8000-000000000000 is not in brain_real_eval; run npm run brain -- eval sync first",
    );
    await expect(labelCaptured(log, sql, { retrievalId, expect: "nowhere.md", corpus: "fixtures", goldenPath })).rejects.toThrow(/is not in brain_eval; ingest it with npm run brain -- eval ingest/);
    await expect(labelCaptured(log, sql, { retrievalId, expect: docId, quote: "I now live in Boulder", corpus: "real", goldenPath })).rejects.toThrow(/the quote is not in document .* verbatim/);
    expect(await loadGoldenAll(goldenPath)).toEqual([]);
  });

  it("refuses an unknown retrieval id, the same search twice, and a duplicate question", async () => {
    await expect(labelCaptured(log, sql, { retrievalId: "00000000-0000-4000-8000-000000000000", negative: true, corpus: "real", goldenPath })).rejects.toThrow(/No logged search has retrieval id/);
    await labelCaptured(log, sql, { retrievalId, negative: true, corpus: "real", goldenPath });
    await expect(labelCaptured(log, sql, { retrievalId, negative: true, corpus: "real", goldenPath })).rejects.toThrow(`retrieval ${retrievalId} is already golden item c-${retrievalId.slice(0, 8)}`);
    const again = (await search(fakeCtx(sql), "Where do I live now?", { client: "mcp-stdio" })).retrievalId;
    await expect(labelCaptured(log, sql, { retrievalId: again, expect: docId, corpus: "real", goldenPath })).rejects.toThrow(`the question duplicates golden item c-${retrievalId.slice(0, 8)}`);
  });

  it("checks the flags: --negative takes no document, a positive item needs one", async () => {
    await expect(labelCaptured(log, sql, { retrievalId, negative: true, expect: docId, corpus: "real", goldenPath })).rejects.toThrow(/--negative takes no --expect/);
    await expect(labelCaptured(log, sql, { retrievalId, corpus: "real", goldenPath })).rejects.toThrow(/--expect <document> is required/);
    await expect(labelCaptured(log, sql, { retrievalId, expect: docId, kind: "filter", corpus: "real", goldenPath })).rejects.toThrow(/no source kind filter/);
  });
});

describe("brain eval capture and label (CLI)", () => {
  it("capture lists the knowledge base's recent searches through a read-only connection", async () => {
    const r = await brainEval(["capture", "--client", "mcp-stdio"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${retrievalId}  `);
    expect(r.stdout).toContain('  "where do I live now"');
  });

  it("label refuses an eval database whose name does not end in _eval", async () => {
    const r = await brainEval(["label", retrievalId, "--negative", "--golden", goldenPath]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Refusing to run the eval against ".*": the database name must end in _eval/);
  });
});

describe("labelCaptured and passage boundaries", () => {
  it("refuses a quote that straddles two level-1 passages, as eval run would never match it", async () => {
    const first = "# Boiler service\n\nThe technician replaced the pressure valve on the boiler and";
    const second = "said the heat exchanger should last another five winters.";
    const [doc] = await sql<{ id: string }[]>`
      insert into brain.documents (content_hash, source_kind, title, origin, raw_content)
      values ('split-boiler', 'note', 'Boiler service', 'eval/corpus/note--boiler-service.md', ${first + " " + second}) returning id`;
    const [section] = await sql<{ id: string }[]>`
      insert into brain.chunks (document_id, level, ordinal, heading_path, content, token_count, char_start, char_end)
      values (${doc.id}, 0, 0, '{}'::text[], ${first + " " + second}, 30, 0, 100) returning id`;
    let ordinal = 0;
    for (const content of [first, second]) {
      await sql`
        insert into brain.chunks (document_id, parent_id, level, ordinal, heading_path, content, token_count, char_start, char_end)
        values (${doc.id}, ${section.id}, 1, ${ordinal++}, '{}'::text[], ${content}, 15, 0, 50)`;
    }
    const [row] = await sql<{ id: string }[]>`insert into brain.retrieval_log (query, client) values ('how long will the boiler last', 'mcp-stdio') returning id`;
    await expect(labelCaptured(log, sql, { retrievalId: row.id, expect: doc.id, quote: "on the boiler and said the heat exchanger", corpus: "real", goldenPath })).rejects.toThrow(
      "quote spans a passage boundary; pick a quote inside one passage",
    );
    expect(await loadGoldenAll(goldenPath)).toEqual([]);
    const ok = await labelCaptured(log, sql, { retrievalId: row.id, expect: doc.id, quote: "the heat exchanger should last another five winters", corpus: "real", goldenPath });
    expect(ok.expected).toEqual([{ document_id: doc.id, quote: "the heat exchanger should last another five winters" }]);
  });
});
