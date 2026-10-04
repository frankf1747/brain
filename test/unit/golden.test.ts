import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGolden, validateGoldenItem, goldenLine, appendGolden, loadGolden, loadGoldenAll, forCorpus, approvalCounts, GOLDEN_FILES, goldenFileFor,
  goldenFileCorpus, type GoldenItem,
} from "../../src/eval/golden.js";

const base = {
  id: "q01", question: "What is the salary range?", kind: "keyword",
  expected: [{ origin: "job_description--acme-senior-data-analyst.md" }],
  source: "fixture", approved_by: "agent", approved_at: "2026-09-30",
};
const ok = JSON.stringify(base);
const line = (over: Record<string, unknown>) => JSON.stringify({ ...base, ...over });

describe("parseGolden", () => {
  it("parses one item per non-empty line, with negative false and corpus fixtures by default", () => {
    const items = parseGolden(`${ok}\n\n${ok.replace("q01", "q02")}\n`);
    expect(items.map((i) => i.id)).toEqual(["q01", "q02"]);
    expect(items[0].expected[0].origin).toBe("job_description--acme-senior-data-analyst.md");
    expect(items[0]).toMatchObject({ negative: false, corpus: "fixtures", approved_by: "agent" });
  });
  it("rejects duplicate ids", () => {
    expect(() => parseGolden(`${ok}\n${ok}`)).toThrow(/duplicate id q01/);
  });
  it("requires expected documents unless the item is negative", () => {
    expect(() => parseGolden(line({ id: "q03", kind: "semantic", expected: [] }))).toThrow(/q03.*expected/);
    expect(parseGolden(line({ id: "q04", kind: "negative", expected: [], negative: true }))[0].negative).toBe(true);
  });
  it("rejects a negative item that lists expected documents", () => {
    expect(() => parseGolden(line({ id: "q05", kind: "negative", expected: [{ origin: "a.md" }], negative: true }))).toThrow(/q05.*negative/);
  });
  it("includes the line number in the negative and expected errors", () => {
    expect(() => parseGolden(`${ok}\n${line({ id: "q03", kind: "semantic", expected: [] })}`)).toThrow(/line 2.*q03.*expected/);
    expect(() => parseGolden(`${ok}\n\n${line({ id: "q05", kind: "negative", expected: [{ origin: "a.md" }], negative: true })}`)).toThrow(/line 3.*q05.*negative/);
  });
  it("requires kind negative exactly when negative is true", () => {
    expect(() => parseGolden(line({ id: "q06", kind: "negative", expected: [{ origin: "a.md" }] }))).toThrow(/line 1.*q06.*kind/);
    expect(() => parseGolden(line({ id: "q07", kind: "semantic", expected: [], negative: true }))).toThrow(/line 1.*q07.*kind/);
  });
  it("rejects unknown keys on the item and on expected entries", () => {
    expect(() => parseGolden(line({ expect: [] }))).toThrow(/line 1.*expect/);
    expect(() => parseGolden(line({ expected: [{ origin: "a.md", qoute: "x" }] }))).toThrow(/line 1: expected\.0: .*qoute/);
  });
  it("names the field path in schema errors", () => {
    expect(() => parseGolden(line({ kind: "bogus" }))).toThrow(/line 1: kind: /);
  });
  it("reports the line number of invalid JSON", () => {
    expect(() => parseGolden(`${ok}\n{not json`)).toThrow(/line 2/);
  });
  it("requires approved_by, owner or agent", () => {
    const { approved_by: _drop, ...noApprover } = base;
    expect(() => parseGolden(JSON.stringify(noApprover))).toThrow(/line 1: approved_by: /);
    expect(() => parseGolden(line({ approved_by: "claude" }))).toThrow(/line 1: approved_by: /);
  });
  it("lets only the owner approve generated and captured items", () => {
    expect(() => parseGolden(line({ source: "generated" }))).toThrow(/a generated item must be approved by the owner/);
    expect(parseGolden(line({ source: "generated", approved_by: "owner", edited: true }))[0].edited).toBe(true);
  });
  it("keeps edited for generated items and retrieval_id for captured items", () => {
    expect(() => parseGolden(line({ edited: false }))).toThrow(/edited is only for generated items/);
    expect(() => parseGolden(line({ source: "captured", approved_by: "owner" }))).toThrow(/retrieval_id is required on captured items/);
    const rid = "6f1c2a0e-1111-4222-8333-444455556666";
    expect(parseGolden(line({ source: "captured", approved_by: "owner", retrieval_id: rid }))[0].retrieval_id).toBe(rid);
  });
  it("names fixture documents by origin, since brain_eval's document ids change when it is rebuilt", () => {
    const docId = "0b9c6a38-1111-4222-8333-444455556666";
    expect(() => parseGolden(line({ expected: [{ document_id: docId }] }))).toThrow(/a fixtures item names each expected document by origin/);
    expect(parseGolden(line({ id: "d-0123456789", corpus: "real", expected: [{ document_id: docId }] }))[0].corpus).toBe("real");
  });
  it("gives real items only opaque ids, so the committed baseline-real.json carries no text from the owner's documents", () => {
    const docId = "0b9c6a38-1111-4222-8333-444455556666";
    const real = (id: string) => line({ id, corpus: "real", expected: [{ document_id: docId }] });
    expect(parseGolden(real("d-0123456789"))[0].id).toBe("d-0123456789");
    expect(parseGolden(real("c-6f1c2a0e"))[0].id).toBe("c-6f1c2a0e");
    for (const id of ["q01", "where-do-i-live", "d-01234", "c-6F1C2A0E", "d-0123456789-acme", "x-0123456789"]) {
      expect(() => parseGolden(real(id))).toThrow(
        `golden line 1 (${id}): a real item's id must be opaque: d- and 10 hex digits (drafted) or c- and 8 (captured)`,
      );
    }
    // Fixture ids stay free text: the fixture corpus is fictional and committed.
    expect(parseGolden(line({ id: "q-acme-salary" }))[0].id).toBe("q-acme-salary");
  });
  it("requires source kinds on a filter item", () => {
    expect(() => parseGolden(line({ kind: "filter" }))).toThrow(/a filter item needs filters.sourceKinds/);
    expect(parseGolden(line({ kind: "filter", filters: { sourceKinds: ["news"] } }))[0].kind).toBe("filter");
  });
});

describe("validateGoldenItem", () => {
  it("returns the item, or every schema error and rule broken", () => {
    expect(validateGoldenItem(base)).toMatchObject({ ok: true, item: { id: "q01" } });
    expect(validateGoldenItem({ ...base, kind: "bogus" })).toMatchObject({ ok: false, errors: expect.stringMatching(/^kind: /) });
    expect(validateGoldenItem({ ...base, kind: "negative" })).toEqual({
      ok: false,
      errors: 'kind "negative" and negative: true must go together',
    });
  });
});

describe("goldenLine, appendGolden, loadGolden", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "golden-"));
  });

  it("writes keys in a fixed order, negative only when true, and round-trips", () => {
    const [item] = parseGolden(line({ source: "generated", approved_by: "owner", edited: false, paraphrases: ["p1", "p2"] }));
    expect(goldenLine(item)).toBe(
      '{"id":"q01","question":"What is the salary range?","kind":"keyword","expected":[{"origin":"job_description--acme-senior-data-analyst.md"}],"paraphrases":["p1","p2"],"source":"generated","corpus":"fixtures","approved_by":"owner","approved_at":"2026-09-30","edited":false}',
    );
    expect(parseGolden(goldenLine(item))[0]).toEqual(item);
  });

  it("appends after the existing lines unchanged, and writes nothing when the result would not parse", async () => {
    const path = join(dir, "golden.jsonl");
    await writeFile(path, ok); // no trailing newline
    const [second] = parseGolden(ok.replace("q01", "q02"));
    await appendGolden(path, [second]);
    expect(await readFile(path, "utf8")).toBe(`${ok}\n${goldenLine(second)}\n`);
    await expect(appendGolden(path, [second])).rejects.toThrow(/duplicate id q02/);
    expect((await loadGolden(path)).map((i) => i.id)).toEqual(["q01", "q02"]);
  });

  it("treats a missing file as an empty set", async () => {
    expect(await loadGolden(join(dir, "none.jsonl"))).toEqual([]);
    const path = join(dir, "new.jsonl");
    await appendGolden(path, parseGolden(ok));
    expect(await readFile(path, "utf8")).toBe(`${goldenLine(parseGolden(ok)[0])}\n`);
  });
});

describe("forCorpus and approvalCounts", () => {
  it("splits items by corpus and counts who approved them", () => {
    const items: GoldenItem[] = parseGolden([
      ok,
      line({ id: "g1", source: "generated", approved_by: "owner", edited: false }),
      line({ id: "d-0000000001", corpus: "real", source: "captured", approved_by: "owner", retrieval_id: "6f1c2a0e-1111-4222-8333-444455556666", expected: [{ document_id: "0b9c6a38-1111-4222-8333-444455556666" }] }),
    ].join("\n"));
    expect(forCorpus(items, "fixtures").map((i) => i.id)).toEqual(["q01", "g1"]);
    expect(forCorpus(items, "real").map((i) => i.id)).toEqual(["d-0000000001"]);
    expect(approvalCounts(items)).toEqual({ owner: 2, agent: 1 });
  });
});

describe("real-corpus items live in their own gitignored file", () => {
  const docId = "0b9c6a38-1111-4222-8333-444455556666";
  const real = line({ id: "d-0000000001", corpus: "real", expected: [{ document_id: docId }] });
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "golden-real-"));
  });

  it("names the real file next to the fixtures file", () => {
    expect(GOLDEN_FILES).toEqual({ fixtures: "eval/golden.jsonl", real: "eval/golden-real.jsonl" });
    expect(goldenFileFor("eval/golden.jsonl", "real")).toBe("eval/golden-real.jsonl");
    expect(goldenFileFor("eval/golden-real.jsonl", "fixtures")).toBe("eval/golden.jsonl");
    expect(goldenFileFor(join(dir, "golden.jsonl"), "real")).toBe(join(dir, "golden-real.jsonl"));
    expect(goldenFileCorpus("eval/golden-real.jsonl")).toBe("real");
    expect(goldenFileCorpus("/tmp/other.jsonl")).toBe("fixtures");
  });

  it("rejects a real item in the fixtures file, which is committed to a public repository", async () => {
    expect(() => parseGolden(`${ok}\n${real}`, "fixtures")).toThrow(
      /golden line 2 \(d-0000000001\): a corpus "real" item quotes the owner's private documents; it belongs in golden-real\.jsonl \(gitignored\), not in the fixtures file/,
    );
    const path = join(dir, "golden.jsonl");
    await writeFile(path, `${ok}\n${real}\n`);
    await expect(loadGolden(path)).rejects.toThrow(/belongs in golden-real\.jsonl/);
  });

  it("rejects a fixtures item in the real file", async () => {
    expect(() => parseGolden(`${real}\n${ok}`, "real")).toThrow(
      /golden line 2 \(q01\): a corpus "fixtures" item belongs in golden\.jsonl, not in the real file/,
    );
    const path = join(dir, "golden-real.jsonl");
    await writeFile(path, `${ok}\n`);
    await expect(loadGolden(path)).rejects.toThrow(/belongs in golden\.jsonl, not in the real file/);
  });

  it("appendGolden routes each item to its corpus's file and writes neither when one would not parse", async () => {
    const path = join(dir, "golden.jsonl");
    const [fixture, realItem] = parseGolden(`${ok}\n${real}`);
    await appendGolden(path, [fixture, realItem]);
    expect(await readFile(path, "utf8")).toBe(`${goldenLine(fixture)}\n`);
    expect(await readFile(join(dir, "golden-real.jsonl"), "utf8")).toBe(`${goldenLine(realItem)}\n`);
    expect((await loadGolden(join(dir, "golden-real.jsonl"))).map((i) => i.id)).toEqual(["d-0000000001"]);
    // Given the real file's path, items still go by corpus.
    const [second] = parseGolden(ok.replace("q01", "q02"));
    await appendGolden(join(dir, "golden-real.jsonl"), [second]);
    expect((await loadGolden(path)).map((i) => i.id)).toEqual(["q01", "q02"]);
    // A duplicate real id stops the fixtures write too.
    const [third] = parseGolden(ok.replace("q01", "q03"));
    await expect(appendGolden(path, [third, realItem])).rejects.toThrow(/duplicate id d-0000000001/);
    expect((await loadGolden(path)).map((i) => i.id)).toEqual(["q01", "q02"]);
    expect((await loadGoldenAll(path)).map((i) => i.id)).toEqual(["q01", "q02", "d-0000000001"]);
  });

  it("a missing real file is an empty set", async () => {
    expect(await loadGolden(join(dir, "golden-real.jsonl"))).toEqual([]);
  });
});
