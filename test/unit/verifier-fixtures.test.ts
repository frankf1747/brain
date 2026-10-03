import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { parseVerifierSet, VERIFIER_CASES } from "../../src/eval/verifier.js";
import { splitFrontMatter, normalizeWhitespace } from "../../src/eval/run.js";

const set = async () => parseVerifierSet(await readFile("eval/verifier.jsonl", "utf8"));

describe("eval/verifier.jsonl", () => {
  it("has at least 40 items covering every case, at least 20 labelled supported, all labelled by an agent until the owner adds their own", async () => {
    const items = await set();
    expect(items.length).toBeGreaterThanOrEqual(40);
    for (const c of VERIFIER_CASES) expect([c, items.some((i) => i.case === c)]).toEqual([c, true]);
    expect(items.filter((i) => i.expected_verdict === "supported").length).toBeGreaterThanOrEqual(20);
    expect(items.every((i) => i.labelled_by === "agent:claude" || i.labelled_by === "owner")).toBe(true);
  });

  it("quotes every passage verbatim from a fixture the item names, once front matter is stripped", async () => {
    for (const item of await set()) {
      for (const c of item.cites) {
        if (!("text" in c)) continue;
        const bodies = await Promise.all(item.retrieval.documents.map(async (d) => normalizeWhitespace(splitFrontMatter(await readFile(`eval/corpus/${d}`, "utf8")).body)));
        expect([item.id, bodies.some((b) => b.includes(normalizeWhitespace(c.text)))]).toEqual([item.id, true]);
      }
    }
  });

  it("labels uncited items uncited and items whose only cites are missing bad_citation", async () => {
    for (const item of await set()) {
      if (item.cites.length === 0) expect([item.id, item.expected_verdict]).toEqual([item.id, "uncited"]);
      if (item.cites.length > 0 && item.cites.every((c) => "missing" in c)) expect([item.id, item.expected_verdict]).toEqual([item.id, "bad_citation"]);
    }
  });
});
