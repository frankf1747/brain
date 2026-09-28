import { describe, it, expect } from "vitest";
import { scoreQuestion, summarize, kindFromFilename } from "../../src/eval/run.js";

describe("eval scoring", () => {
  it("finds the first passage whose document origin matches an expected file", () => {
    const rank = scoreQuestion(
      ["/x/eval/corpus/a.md", "/x/eval/corpus/b.md", "/x/eval/corpus/c.md"],
      ["c.md", "b.md"],
    );
    expect(rank).toBe(2);
    expect(scoreQuestion(["/x/a.md"], ["z.md"])).toBeNull();
  });
  it("summarizes recall@10 and MRR", () => {
    const s = summarize([{ needs: "keyword", rank: 1 }, { needs: "keyword", rank: null }, { needs: "graph", rank: 12 }]);
    expect(s.overall.recallAt10).toBeCloseTo(1 / 3);
    expect(s.overall.mrr).toBeCloseTo((1 + 1 / 12) / 3);
    expect(s.byNeeds.keyword.recallAt10).toBeCloseTo(0.5);
    expect(s.byNeeds.graph.recallAt10).toBe(0);
  });
  it("reads the source kind from the file name prefix", () => {
    expect(kindFromFilename("news--acme-series-b.md")).toBe("news");
    expect(kindFromFilename("plain.md")).toBe("note");
  });
});
