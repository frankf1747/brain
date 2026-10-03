import { describe, it, expect, afterAll } from "vitest";
import { testDb } from "./helpers.js";
import { stems, stemAll } from "../../src/verify/terms.js";

const sql = testDb();
afterAll(() => sql.end());

describe("stems from Postgres", () => {
  it("are the english configuration's lexemes, as the keyword index stores them", async () => {
    expect(await stems(sql, "Databricks saves money")).toEqual(["databrick", "money", "save"]);
    expect(await stems(sql, "The cluster was not shut down")).toEqual(["cluster", "shut"]);
    expect(await stems(sql, "")).toEqual([]);
  });

  it("stems many texts in one query and maps each distinct text to its lexemes", async () => {
    const texts = ["Acme sponsors visas", "sponsorship", "Acme sponsors visas", "the of and"];
    let queries = 0;
    const counting = new Proxy(sql, { apply: (target, self, args) => (queries++, Reflect.apply(target as never, self, args)) });
    const map = await stemAll(counting, texts);
    expect(queries).toBe(1);
    expect([...map.entries()]).toEqual([
      ["Acme sponsors visas", ["acm", "sponsor", "visa"]],
      ["sponsorship", ["sponsorship"]],
      ["the of and", []],
    ]);
    expect((await stemAll(counting, [])).size).toBe(0);
    expect(queries).toBe(1);
  });
});
