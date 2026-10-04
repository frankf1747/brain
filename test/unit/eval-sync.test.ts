import { describe, it, expect } from "vitest";
import { syncPlan } from "../../src/eval/sync.js";

const url = (db: string, host = "127.0.0.1", port = "55322") => `postgresql://postgres:postgres@${host}:${port}/${db}`;

describe("syncPlan", () => {
  it("copies from the knowledge base into a *_eval database on the same local server", () => {
    expect(syncPlan(url("postgres"), url("brain_real_eval"))).toEqual({ sourceDb: "postgres", targetDb: "brain_real_eval", port: "55322" });
    expect(syncPlan(url("postgres", "localhost"), url("brain_real_eval"))).toMatchObject({ port: "55322" });
  });
  it("refuses a target whose name does not end in _eval, or that carries a redirecting parameter", () => {
    expect(() => syncPlan(url("postgres"), url("brain_real"))).toThrow(/must end in _eval/);
    expect(() => syncPlan(url("postgres"), url("brain_real_eval") + "?database=postgres")).toThrow(/parameter "database"/);
  });
  it("refuses an eval database as the source, and the same database on both sides", () => {
    expect(() => syncPlan(url("brain_eval"), url("brain_real_eval"))).toThrow(/the source "brain_eval" is an eval database/);
    expect(() => syncPlan(url("brain_real_eval"), url("brain_real_eval"))).toThrow(/is an eval database/);
  });
  it("refuses a remote server or two different ports, since the copy runs inside the local container", () => {
    expect(() => syncPlan(url("postgres", "db.example.com"), url("brain_real_eval"))).toThrow(/DATABASE_URL must name the local Supabase server/);
    expect(() => syncPlan(url("postgres", "127.0.0.1", "5432"), url("brain_real_eval"))).toThrow(/must name the same server/);
  });
  it("refuses names that are not plain identifiers", () => {
    expect(() => syncPlan(url("Post-gres"), url("brain_real_eval"))).toThrow(/source database name must be a lower-case identifier/);
  });
});
