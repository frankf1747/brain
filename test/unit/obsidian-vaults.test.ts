import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listVaults } from "../../src/obsidian/vaults.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("listVaults", () => {
  it("reads the registry and marks the open vault", async () => {
    const vaults = await listVaults(join(here, "..", "fixtures", "obsidian.json"));
    expect(vaults).toEqual([
      { id: "257e6c459b52dc55", path: "/Users/frankfu/Documents/obsidian/MSBA410", name: "MSBA410", open: false },
      { id: "cda95dd5fd0856af", path: "/Users/frankfu/Documents/Obsidian/General", name: "General", open: true },
    ]);
  });
  it("returns an empty list when the registry is missing", async () => {
    expect(await listVaults("/nonexistent/obsidian.json")).toEqual([]);
  });
});
