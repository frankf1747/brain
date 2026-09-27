import { describe, it, expect } from "vitest";
import { config } from "../../src/config.js";

describe("config", () => {
  it("pins the embedding dimension the schema was created with", () => {
    expect(config.embeddingDimensions).toBe(1024);
  });
  it("falls back to the local Supabase connection string", () => {
    expect(config.databaseUrl).toMatch(/^postgresql:\/\//);
  });
});
