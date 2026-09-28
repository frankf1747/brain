import { describe, it, expect } from "vitest";
import { candidateNames } from "../../src/retrieve/entities.js";

describe("candidateNames", () => {
  it("picks quoted strings and capitalized runs, dropping question words", () => {
    expect(candidateNames('Who works at Acme Corp and "beta ventures"?')).toEqual(["beta ventures", "Acme Corp"]);
  });
  it("keeps connectors inside a run and trims trailing ones", () => {
    expect(candidateNames("Tell me about the University of Texas and")).toEqual(["University of Texas"]);
  });
  it("returns nothing for lowercase questions", () => {
    expect(candidateNames("what did i say about fairness")).toEqual([]);
  });
});
