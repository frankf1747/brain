import { connect, type Db } from "../../src/db.js";

export function testDb(): Db {
  return connect(
    process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:55322/postgres",
  );
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
