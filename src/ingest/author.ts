import { config } from "../config.js";

/**
 * Who wrote a document. Only a document the owner wrote can produce facts about the owner or relations
 * from the owner (src/ingest/stages/resolve.ts).
 */
export const AUTHORS = ["owner", "other", "unknown"] as const;
export type Author = (typeof AUTHORS)[number];

export function isAuthor(value: unknown): value is Author {
  return typeof value === "string" && (AUTHORS as readonly string[]).includes(value);
}

/** Parses user input (a CLI argument, fixture front matter). Case and surrounding space are ignored. */
export function parseAuthor(value: string): Author {
  const v = value.trim().toLowerCase();
  if (!isAuthor(v)) throw new Error(`author must be one of ${AUTHORS.join(", ")}; got "${value}"`);
  return v;
}

/**
 * The author a document gets when none is given: config.authorDefaults by source kind, "unknown" for any
 * kind not listed. brain.default_author (migration 009) is the same mapping in SQL.
 */
export function defaultAuthor(sourceKind: string): Author {
  const map: Readonly<Record<string, Author>> = config.authorDefaults;
  return Object.hasOwn(map, sourceKind) ? map[sourceKind] : "unknown";
}
