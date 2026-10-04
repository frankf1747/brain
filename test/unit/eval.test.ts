import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  kindFromFilename, toQuestionResult, firstExpectedRank, normalizeWhitespace, missingQuoteWarning, evalVoyageLine, stageLatencyLine, breakdownLines,
  goldenForRun, noItemsMessage, acceptRefusal, abstentionLines,
} from "../../src/eval/run.js";
import { summarize } from "../../src/eval/metrics.js";
import type { GoldenItem } from "../../src/eval/golden.js";
import type { Layer, SearchResult } from "../../src/retrieve/contract.js";
import { passage, searchResult as baseResult } from "./search-fixture.js";

const item: GoldenItem = {
  id: "q05", question: "Why?", kind: "semantic", negative: false, source: "fixture", corpus: "fixtures", approved_by: "agent", approved_at: "2026-09-30",
  expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot satisfy all three" }],
};

type P = { documentId: string; layers: Layer[]; content: string; score: number; chunkId?: string | null };

function searchResult(passages: P[], degraded = false, totalMs = 7): SearchResult {
  return baseResult({
    timings: { embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0.5, totalMs },
    query: "Why?",
    passages: passages.map((p, i) => passage({ chunkId: p.chunkId === undefined ? `c${i}` : p.chunkId, documentId: p.documentId, content: p.content, score: p.score, layers: p.layers })),
    topScore: passages[0]?.score ?? null,
    mode: degraded ? "keyword-only" : "hybrid",
    degraded: { embedding: degraded, rerank: degraded, capReached: false },
  });
}

describe("toQuestionResult", () => {
  it("records ranked documents with origins, quote hits and top score", () => {
    const res = searchResult([
      { documentId: "d1", layers: ["vector"], content: "Demographic parity asks that positive rates match.", score: 0.4 },
      { documentId: "d2", layers: ["vector"], content: "shows you cannot satisfy all three when base rates differ", score: 0.3 },
      { documentId: "d3", layers: ["graph"], content: "x", score: 0 },
    ], false, 42);
    const origins = new Map([["d1", "/c/other.md"], ["d2", "/c/note--fairness-in-ml.md"], ["d3", null]]);
    const q = toQuestionResult(item, res, origins, [], 2, [true]);
    expect(q.ranked.map((d) => d.documentId)).toEqual(["d1", "d2", "d3"]);
    expect(q.ranked.map((d) => d.containsQuote)).toEqual([false, true, false]);
    expect(q.topScore).toBe(0.4);
    expect(q.totalMs).toBe(42);
    expect(q.timings).toEqual(res.timings);
    expect(q.totalRelevant).toBe(2);
    expect(q.paraphraseDegraded).toEqual([true]);
    expect(firstExpectedRank(q)).toBe(2);
  });
  it("a passage counts as containing the quote only when it belongs to an expected document", () => {
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "you cannot satisfy all three", score: 0.4 }]);
    const q = toQuestionResult(item, res, new Map([["d1", "/c/other.md"]]), [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(false);
  });
  it("matches quotes with whitespace runs collapsed on both sides", () => {
    const spaced: GoldenItem = { ...item, expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot  satisfy\nall three" }] };
    const res = searchResult([{ documentId: "d2", layers: ["vector"], content: "you cannot\n\tsatisfy all   three here", score: 0.4 }]);
    const q = toQuestionResult(spaced, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(true);
  });
  it("a fallback window (no chunk) is never a relevant passage, since totalRelevant counts chunks", () => {
    const res = searchResult([{ documentId: "d2", layers: ["fallback"], content: "you cannot satisfy all three", score: 0, chunkId: null }]);
    const q = toQuestionResult(item, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), [], 1, []);
    expect(q.ranked[0].containsQuote).toBe(false);
  });
  it("takes the latency from the search's own timings, not wall-clock around the call", () => {
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "x", score: 0.9 }], false, 123.4);
    const q = toQuestionResult(item, res, new Map([["d1", "/c/z.md"]]), [], 0, []);
    expect(q.totalMs).toBe(123.4);
    expect(q.timings).toEqual({ embedMs: 1, sqlMs: 2, rerankMs: 3, graphMs: 0.5, totalMs: 123.4 });
  });
  it("records degraded from the structured flags", () => {
    const q = toQuestionResult(item, searchResult([], true), new Map(), [], 0, []);
    expect(q.degraded).toBe(true);
    expect(q.topScore).toBeNull();
  });
  it("rank is null on a miss", () => {
    const q = toQuestionResult(item, searchResult([{ documentId: "d9", layers: ["vector"], content: "x", score: 0.9 }]), new Map([["d9", "/c/z.md"]]), [], 0, []);
    expect(firstExpectedRank(q)).toBeNull();
  });
  it("reads the source kind from the file name prefix", () => {
    expect(kindFromFilename("news--acme-series-b.md")).toBe("news");
    expect(kindFromFilename("plain.md")).toBe("note");
  });
});

describe("normalizeWhitespace", () => {
  it("collapses ASCII whitespace runs only, matching the SQL class, so an NBSP is kept", () => {
    expect(normalizeWhitespace("a \t\r\n\f\vb")).toBe("a b");
    expect(normalizeWhitespace("a\u00a0b")).toBe("a\u00a0b");
    expect(normalizeWhitespace("a \u00a0 b")).toBe("a \u00a0 b");
  });
  it("an NBSP in a quote does not match a plain space in a passage", () => {
    const nbsp: GoldenItem = { ...item, expected: [{ origin: "note--fairness-in-ml.md", quote: "cannot\u00a0satisfy" }] };
    const res = searchResult([{ documentId: "d2", layers: ["vector"], content: "you cannot satisfy all three", score: 0.4 }]);
    expect(toQuestionResult(nbsp, res, new Map([["d2", "/c/note--fairness-in-ml.md"]]), [], 1, []).ranked[0].containsQuote).toBe(false);
  });
});

describe("missingQuoteWarning", () => {
  it("warns when an item has quotes but no passage of its expected documents contains one", () => {
    expect(missingQuoteWarning(item, 0)).toBe("eval: q05 quote not found in any passage of its expected documents");
    expect(missingQuoteWarning(item, 2)).toBeNull();
    expect(missingQuoteWarning({ ...item, expected: [{ origin: "a.md" }] }, 0)).toBeNull();
  });
});

describe("stageLatencyLine", () => {
  it("prints p50 and p95 per stage, and nothing for a report from before Phase 4", () => {
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "x", score: 0.9 }]);
    const report = summarize([toQuestionResult(item, res, new Map(), [], 0, [])]);
    expect(stageLatencyLine(report)).toBe("stages  embed p50=1ms p95=1ms  sql p50=2ms p95=2ms  rerank p50=3ms p95=3ms  graph p50=0.5ms p95=0.5ms");
    const { stageLatencyMs: _drop, ...old } = report;
    expect(stageLatencyLine(old)).toBeNull();
  });
});

describe("source and approver", () => {
  it("carries the item's source and approver into the result", () => {
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "x", score: 0.9 }]);
    const q = toQuestionResult({ ...item, source: "generated", approved_by: "owner", edited: false }, res, new Map(), [], 0, []);
    expect(q).toMatchObject({ source: "generated", approvedBy: "owner" });
  });
  it("carries the search's evidence level and the item's split", () => {
    const res = { ...searchResult([{ documentId: "d1", layers: ["vector"], content: "x", score: 0.4 }]), evidence: { level: "weak" as const, basis: "rerank" as const, threshold: 0.56 } };
    expect(toQuestionResult(item, res, new Map(), [], 0, [])).toMatchObject({ evidence: "weak", split: "calibration" });
    expect(toQuestionResult({ ...item, split: "heldout" }, res, new Map(), [], 0, [])).toMatchObject({ split: "heldout" });
  });
  it("prints one line per source in the order fixture, generated, captured, then the approval counts", () => {
    const res = searchResult([{ documentId: "d2", layers: ["vector"], content: "x", score: 0.9 }]);
    const origins = new Map([["d2", "/c/note--fairness-in-ml.md"]]);
    const report = summarize([
      toQuestionResult({ ...item, id: "g", source: "generated", approved_by: "owner" }, res, origins, [], 0, []),
      toQuestionResult(item, res, origins, [], 0, []),
    ]);
    expect(breakdownLines(report)).toEqual([
      "source fixture    n=1  recall@10=1.00  mrr=1.00",
      "source generated  n=1  recall@10=1.00  mrr=1.00",
      "approved  owner=1  agent=1",
    ]);
    const { bySource: _b, approvals: _a, ...older } = report;
    expect(breakdownLines(older)).toEqual([]);
  });
});

describe("abstentionLines", () => {
  it("prints calibration then heldout, and nothing for a report from before Phase 7", () => {
    const a = { negatives: 2, abstentionRate: 0.5, falseAnswerRate: 0.5, positives: 4, falseAbstentionRate: 0.25 };
    const res = searchResult([{ documentId: "d1", layers: ["vector"], content: "x", score: 0.9 }]);
    const report = { ...summarize([toQuestionResult(item, res, new Map(), [], 0, [])]), abstention: { heldout: a, calibration: a } };
    expect(abstentionLines(report)).toEqual([
      "abstain calibration negatives n=2 abstention=0.50 false-answer=0.50  positives n=4 judged-weak=0.25",
      "abstain heldout     negatives n=2 abstention=0.50 false-answer=0.50  positives n=4 judged-weak=0.25",
    ]);
    const { abstention: _a, ...old } = report;
    expect(abstentionLines(old)).toEqual([]);
  });
});

describe("goldenForRun: each corpus reads its own file", () => {
  const fixtureLine = JSON.stringify({ ...item, expected: [{ origin: "note--fairness-in-ml.md" }] });
  const realLine = JSON.stringify({ ...item, id: "d-0000000001", corpus: "real", expected: [{ document_id: "0b9c6a38-1111-4222-8333-444455556666" }] });

  it("reads fixtures items from golden.jsonl and real items from golden-real.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-golden-"));
    await writeFile(join(dir, "golden.jsonl"), `${fixtureLine}\n`);
    await writeFile(join(dir, "golden-real.jsonl"), `${realLine}\n`);
    expect((await goldenForRun(join(dir, "golden.jsonl"), "fixtures")).map((i) => i.id)).toEqual(["q05"]);
    expect((await goldenForRun(join(dir, "golden-real.jsonl"), "real")).map((i) => i.id)).toEqual(["d-0000000001"]);
  });
  it("treats a missing real file as no items, but a missing fixtures file as an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-golden-"));
    expect(await goldenForRun(join(dir, "golden-real.jsonl"), "real")).toEqual([]);
    await expect(goldenForRun(join(dir, "golden.jsonl"), "fixtures")).rejects.toThrow(/ENOENT/);
  });
  it("refuses a file whose name says it holds the other corpus", async () => {
    await expect(goldenForRun("eval/golden.jsonl", "real")).rejects.toThrow(
      "eval/golden.jsonl holds fixtures items (only files named *-real.jsonl hold real items); --corpus real reads eval/golden-real.jsonl by default",
    );
    await expect(goldenForRun("eval/golden-real.jsonl", "fixtures")).rejects.toThrow(/holds real items/);
  });
  it("rejects a real item found in the fixtures file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "run-golden-"));
    await writeFile(join(dir, "golden.jsonl"), `${fixtureLine}\n${realLine}\n`);
    await expect(goldenForRun(join(dir, "golden.jsonl"), "fixtures")).rejects.toThrow(/belongs in golden-real\.jsonl/);
  });
  it("says why there are no items", () => {
    expect(noItemsMessage("eval/golden-real.jsonl", "real", false)).toBe(
      "eval: eval/golden-real.jsonl does not exist, so there are no real items to run (real-corpus items stay on the owner's machine: the file is gitignored)",
    );
    expect(noItemsMessage("/x/golden.jsonl", "fixtures", true)).toBe("eval: no fixtures items in /x/golden.jsonl");
  });
});

describe("acceptRefusal", () => {
  it("refuses to record a baseline from a run with no items, so --corpus real --accept cannot write an empty baseline", () => {
    expect(acceptRefusal("real", 0, "eval/baseline-real.json")).toBe(
      "eval: refusing --accept: the run had no real items, so eval/baseline-real.json would record an empty baseline",
    );
    expect(acceptRefusal("fixtures", 0, "eval/baseline.json")).toMatch(/no fixtures items/);
    expect(acceptRefusal("real", 3, "eval/baseline-real.json")).toBeNull();
  });
});

describe("evalVoyageLine", () => {
  it("prints the run's Voyage spend, and warns when the cap refused calls", () => {
    expect(evalVoyageLine({ requests: 30, tokens: 41_200, refused: 0 })).toBe("voyage  tokens=41200 requests=30 refused=0");
    expect(evalVoyageLine({ requests: 3, tokens: 90, refused: 2 })).toBe(
      "voyage  tokens=90 requests=3 refused=2  (brain_eval's daily cap refused calls; those searches ran degraded)",
    );
  });
});
