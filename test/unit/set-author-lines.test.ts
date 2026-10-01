import { describe, it, expect } from "vitest";
import { setAuthorLines, type SetAuthorResult } from "../../src/ingest/set-author.js";

const base: SetAuthorResult = {
  documentId: "d1", previous: "owner", author: "other", unchanged: false, reresolved: true,
  removedFacts: [], removedEdges: [], addedFacts: [], addedEdges: [], keptVerified: [], keptCorrected: [], restoredFacts: [], suppressedSelfItems: 0,
};

describe("setAuthorLines", () => {
  it("lists kept facts the owner verified and the ones the owner corrected", () => {
    const lines = setAuthorLines({
      ...base,
      removedFacts: [{ id: "f0", predicate: "skill", objectText: "SQL" }],
      keptVerified: [{ id: "f1", predicate: "lives_in", objectText: "Denver" }],
      keptCorrected: [{ id: "f2", predicate: "visa_status", objectText: "F-1 OPT" }],
      suppressedSelfItems: 2,
    });
    expect(lines).toEqual([
      "d1: author owner -> other",
      "  removed fact  skill: SQL",
      "  kept fact     lives_in: Denver (you verified it; id f1)",
      "  kept fact     visa_status: F-1 OPT (you corrected it; id f2)",
      "  1 facts and 0 edges removed, 0 facts and 0 edges added; 2 items about the owner suppressed",
    ]);
  });

  it("says when nothing changed or nothing was resolved yet", () => {
    expect(setAuthorLines({ ...base, unchanged: true, previous: "other" })).toEqual(["d1: author already other; nothing to do"]);
    expect(setAuthorLines({ ...base, reresolved: false })).toEqual([
      "d1: author owner -> other",
      "  not resolved yet; the new author applies when ingestion reaches the resolve stage",
    ]);
  });
});
