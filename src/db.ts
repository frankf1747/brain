import postgres from "postgres";

export type Db = ReturnType<typeof postgres>;

export function connect(url: string): Db {
  // Sized for MAX_CONCURRENT_PIPELINES (src/ingest/pipeline.ts): each running pipeline pins one
  // reserved connection for its lock and uses pooled connections for its stages.
  return postgres(url, { max: 10, onnotice: () => {} });
}

export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
