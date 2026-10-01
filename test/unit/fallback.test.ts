import { describe, it, expect } from "vitest";
import { triggerTerms } from "../../src/retrieve/fallback.js";

describe("triggerTerms", () => {
  it("picks quoted strings and tokens containing digits or symbols", () => {
    expect(triggerTerms('what is the "ZX-9000" and X-90 at $115k on rerank-2.5?')).toEqual(["ZX-9000", "X-90", "$115k", "rerank-2.5"]);
  });
  it("returns nothing for a plain natural-language question", () => {
    expect(triggerTerms("What did Zorblax Industries release?")).toEqual([]);
  });
  it("ignores LIKE metacharacters on their own", () => {
    expect(triggerTerms("%")).toEqual([]);
    expect(triggerTerms("_")).toEqual([]);
  });
  it("keeps LIKE metacharacters inside a term that has a digit", () => {
    expect(triggerTerms("100% a_b-1")).toEqual(["100%", "a_b-1"]);
  });
  it("deduplicates", () => {
    expect(triggerTerms("F-1 or F-1")).toEqual(["F-1"]);
  });
});
