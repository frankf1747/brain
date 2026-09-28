export function squashWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Lowercase, drop apostrophes, turn other punctuation into spaces, squash. */
export function canonicalName(name: string): string {
  return squashWhitespace(
    name
      .toLowerCase()
      .replace(/['']/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " "),
  );
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
