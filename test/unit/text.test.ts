import { describe, it, expect } from "vitest";
import { sha256Hex } from "../../src/text/hash.js";
import { canonicalName, estimateTokens, squashWhitespace } from "../../src/text/normalize.js";

describe("sha256Hex", () => {
  it("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("canonicalName", () => {
  it("lowercases, strips punctuation and squashes spaces", () => {
    expect(canonicalName("  Acme, Inc. ")).toBe("acme inc");
    expect(canonicalName("O'Brien-Smith")).toBe("obrien smith");
    expect(canonicalName("UCLA  Anderson")).toBe("ucla anderson");
  });
});

describe("estimateTokens", () => {
  it("approximates four characters per token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("squashWhitespace", () => {
  it("collapses runs of whitespace to one space", () => {
    expect(squashWhitespace("a \n\t b")).toBe("a b");
  });
});
