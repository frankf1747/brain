import { describe, it, expect } from "vitest";
import { config, parseTokenCap, parsePrice, DEFAULT_VOYAGE_DAILY_TOKEN_CAP } from "../../src/config.js";

describe("config", () => {
  it("pins the embedding dimension the schema was created with", () => {
    expect(config.embeddingDimensions).toBe(1024);
  });
  it("falls back to the local Supabase connection string", () => {
    expect(config.databaseUrl).toMatch(/^postgresql:\/\//);
  });
});

describe("parseTokenCap", () => {
  it("defaults to 5,000,000 when unset or empty", () => {
    expect(DEFAULT_VOYAGE_DAILY_TOKEN_CAP).toBe(5_000_000);
    expect(parseTokenCap(undefined)).toBe(5_000_000);
    expect(parseTokenCap("")).toBe(5_000_000);
    expect(parseTokenCap("   ")).toBe(5_000_000);
  });

  it("reads whole numbers, with optional underscores, and 0 (which blocks every call)", () => {
    expect(parseTokenCap("0")).toBe(0);
    expect(parseTokenCap("250000")).toBe(250_000);
    expect(parseTokenCap(" 1_000_000 ")).toBe(1_000_000);
  });

  it("refuses anything else instead of lifting the cap", () => {
    for (const bad of ["-1", "1e6", "5,000,000", "off", "none", "false", "1.5", "Infinity", "99999999999999999999"]) {
      expect(() => parseTokenCap(bad), bad).toThrow(/BRAIN_VOYAGE_DAILY_TOKEN_CAP must be a whole number of tokens/);
    }
  });

  it("is what config uses", () => {
    expect(config.voyageDailyTokenCap).toBe(parseTokenCap(process.env.BRAIN_VOYAGE_DAILY_TOKEN_CAP));
  });
});

describe("parsePrice", () => {
  it("defaults to 0 (tokens only) and reads non-negative decimals", () => {
    expect(parsePrice("X", undefined)).toBe(0);
    expect(parsePrice("X", "")).toBe(0);
    expect(parsePrice("X", "0.12")).toBe(0.12);
    expect(parsePrice("X", " 2 ")).toBe(2);
  });
  it("refuses anything else, naming the variable", () => {
    for (const bad of ["-0.1", "$0.12", "1e-3", "abc"]) {
      expect(() => parsePrice("BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED", bad), bad).toThrow(/BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED must be/);
    }
  });
  it("is what config uses", () => {
    expect(config.voyagePricePerMTokEmbed).toBe(parsePrice("BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED", process.env.BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED));
    expect(config.voyagePricePerMTokRerank).toBe(parsePrice("BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK", process.env.BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK));
  });
});
