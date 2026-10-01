import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseGolden } from "../../src/eval/golden.js";
import { splitFrontMatter, normalizeWhitespace } from "../../src/eval/run.js";

const golden = async () => parseGolden(await readFile("eval/golden.jsonl", "utf8"));
const fixture = async (origin: string) => splitFrontMatter(await readFile(`eval/corpus/${origin}`, "utf8"));

describe("eval/golden.jsonl against eval/corpus", () => {
  it("every quote appears verbatim in its fixture once front matter is stripped", async () => {
    for (const item of await golden()) {
      for (const e of item.expected) {
        if (!e.origin || !e.quote) continue;
        const { body } = await fixture(e.origin);
        expect([item.id, normalizeWhitespace(body).includes(normalizeWhitespace(e.quote))]).toEqual([item.id, true]);
      }
    }
  });
  it("has at least three attribution items, each naming a fixture marked author: other, and a negative item", async () => {
    const items = await golden();
    const attribution = items.filter((i) => i.kind === "attribution");
    expect(attribution.length).toBeGreaterThanOrEqual(3);
    for (const a of attribution) {
      for (const e of a.expected) expect([a.id, (await fixture(e.origin!)).author]).toEqual([a.id, "other"]);
    }
    expect(items.some((i) => i.negative)).toBe(true);
  });
});
