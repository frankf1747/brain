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
  it("strips leading question words from a capitalized run", () => {
    expect(candidateNames("Does Acme sponsor work visas?")).toEqual(["Acme"]);
    expect(candidateNames("Is Acme hiring?")).toEqual(["Acme"]);
    expect(candidateNames("Did Priya say anything?")).toEqual(["Priya"]);
  });
  it("splits runs at possessives and keeps the stem", () => {
    expect(new Set(candidateNames("Who led Acme's Series B?"))).toEqual(new Set(["Acme", "Series B"]));
    expect(candidateNames("What is Priya’s role?")).toEqual(["Priya"]);
    expect(candidateNames("Tell me about the Jones' house")).toEqual(["Jones"]);
  });
  it("keeps a leading connector that is part of the name", () => {
    expect(candidateNames("Does The Home Depot hire?")).toEqual(["The Home Depot"]);
  });
});
