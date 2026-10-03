import { describe, it, expect } from "vitest";
import { claimsFromAnswer, labelsIn } from "../../src/verify/answer.js";

describe("labelsIn", () => {
  it("finds every label form once, in order, normalised", () => {
    expect(labelsIn("Acme [P1] pays [p2, F1] well [P1][F03].")).toEqual(["P1", "P2", "F1", "F3"]);
    expect(labelsIn("No labels here.")).toEqual([]);
  });
});

describe("claimsFromAnswer", () => {
  it("makes one claim per sentence, citing the labels inside it, with the labels stripped", () => {
    const answer = "Acme sponsors H-1B visas [P1]. The salary is $115k to $140k, e.g. base pay [P2][F1]. I would apply.\n- Hybrid, three days a week [P3]";
    expect(claimsFromAnswer(answer)).toEqual({
      claims: [
        { text: "Acme sponsors H-1B visas.", cites: ["P1"] },
        { text: "The salary is $115k to $140k, e.g. base pay.", cites: ["P2", "F1"] },
        { text: "I would apply.", cites: [] },
        { text: "Hybrid, three days a week", cites: ["P3"] },
      ],
      dropped: 0,
    });
  });

  it("keeps a label written after the full stop with its sentence, and skips a line that is only labels", () => {
    expect(claimsFromAnswer("Acme is in Austin. [P2] It raised $40M.\n[P3]").claims).toEqual([
      { text: "Acme is in Austin.", cites: ["P2"] },
      { text: "It raised $40M.", cites: [] },
    ]);
  });

  it("returns at most 50 claims and counts the rest, and cuts a sentence to 2,000 characters", () => {
    const many = Array.from({ length: 53 }, (_, i) => `Claim number ${i + 1} [P1].`).join(" ");
    const r = claimsFromAnswer(many);
    expect(r.claims).toHaveLength(50);
    expect(r.dropped).toBe(3);
    expect(claimsFromAnswer("a".repeat(2500)).claims[0].text).toHaveLength(2000);
    expect(claimsFromAnswer("")).toEqual({ claims: [], dropped: 0 });
  });
});
