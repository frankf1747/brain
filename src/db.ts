import postgres from "postgres";

export type Db = ReturnType<typeof postgres>;

export function connect(url: string): Db {
  // Sized for MAX_CONCURRENT_PIPELINES (src/ingest/pipeline.ts): each running pipeline pins one
  // reserved connection for its lock and uses pooled connections for its stages.
  return postgres(url, { max: 10, onnotice: () => {} });
}

/**
 * A connection that cannot write: every transaction it opens is read-only (default_transaction_read_only), so code that
 * only reads another database, such as `brain eval capture` reading the real base's search log, cannot change it.
 */
export function connectReadOnly(url: string): Db {
  return postgres(url, { max: 2, onnotice: () => {}, connection: { default_transaction_read_only: true } });
}

export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
