import postgres from "postgres";

export type Db = ReturnType<typeof postgres>;

export function connect(url: string): Db {
  return postgres(url, { max: 5, onnotice: () => {} });
}

export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
