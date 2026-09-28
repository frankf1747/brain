import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "../../src/retrieve/fuse.js";

describe("reciprocalRankFusion", () => {
  it("ranks an item found by both indexes above one found by a single index", () => {
    const out = reciprocalRankFusion([
      { id: "vec-only", vectorRank: 1, keywordRank: null },
      { id: "both", vectorRank: 3, keywordRank: 2 },
      { id: "kw-only", vectorRank: null, keywordRank: 1 },
    ]);
    expect(out[0].id).toBe("both");
    expect(out.every((o) => o.fused > 0)).toBe(true);
  });
  it("returns an empty list for no candidates", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});
