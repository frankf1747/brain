import { connect, type Db } from "../../src/db.js";
import type { Ctx } from "../../src/ctx.js";
import { FakeLlm } from "../../src/llm/llm.js";
import { FakeEmbedder, FakeReranker } from "../../src/llm/voyage.js";

/**
 * Integration tests wipe brain tables, so they only ever run against a database whose name ends in
 * "_test" (created by scripts/prepare-test-db.sh). DATABASE_URL is deliberately ignored: it points at
 * the real knowledge base.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/brain_test";

export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to run integration tests against "${name}": the database name must end in _test`);
  }
}

export function testDb(): Db {
  assertTestDatabase(TEST_DATABASE_URL);
  return connect(TEST_DATABASE_URL);
}

/** Removes data but keeps registries and the self node. */
export async function wipe(sql: Db): Promise<void> {
  await sql`truncate brain.documents cascade`;
  await sql`delete from brain.nodes where is_self = false`;
  await sql`truncate brain.retrieval_log`;
}

export function fakeVector(seed: number, dims = 1024): number[] {
  const v: number[] = [];
  let x = seed * 9301 + 49297;
  for (let i = 0; i < dims; i++) {
    x = (x * 9301 + 49297) % 233280;
    v.push(x / 233280 - 0.5);
  }
  const norm = Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  return v.map((a) => a / norm);
}

export interface FakeCtx extends Ctx {
  llm: FakeLlm;
  embedder: FakeEmbedder;
}

export function fakeCtx(sql: Db, handler: (args: { system: string; user: string }) => unknown = () => ({})): FakeCtx {
  return { sql, llm: new FakeLlm(handler), embedder: new FakeEmbedder(), reranker: new FakeReranker() };
}
