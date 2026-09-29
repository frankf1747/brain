import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { projectionRoot } from "../../src/obsidian/project.js";

describe("projectionRoot", () => {
  const vault = "/tmp/some-vault";

  it("accepts one plain path segment inside the vault", () => {
    expect(projectionRoot(vault, "Brain")).toBe(join(resolve(vault), "Brain"));
    expect(projectionRoot(vault, "My Brain.v2")).toBe(join(resolve(vault), "My Brain.v2"));
  });

  it("treats an empty folder as unset and uses Brain", () => {
    expect(projectionRoot(vault, "")).toBe(join(resolve(vault), "Brain"));
    expect(projectionRoot(vault, undefined)).toBe(join(resolve(vault), "Brain"));
  });

  it("refuses folders that are not one segment or would escape the vault", () => {
    for (const bad of [".", "..", "a/b", "a\\b", "/abs", "../x", "   "]) {
      expect(() => projectionRoot(vault, bad), bad).toThrow(/folder/i);
    }
  });
});
