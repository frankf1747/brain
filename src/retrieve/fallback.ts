/**
 * Terms worth a literal substring scan: quoted strings, and tokens that contain a digit or a symbol
 * (product codes, dollar figures, version numbers, visa classes). The tokenizer mangles these, so
 * keyword search can miss them; natural-language words are left to the keyword and vector layers.
 */
export function triggerTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const m of query.matchAll(/["“]([^"”]+)["”]/g)) terms.add(m[1].trim());
  const rest = query.replace(/["“][^"”]+["”]/g, " ");
  for (const raw of rest.split(/\s+/)) {
    const t = raw.replace(/^[?,!;:()]+|[?,!;:()]+$/g, "");
    if (t.length < 2) continue;
    if (!/[\p{L}\p{N}]/u.test(t)) continue; // "%" or "_" alone
    if (/\p{N}/u.test(t) || /[^\p{L}\p{N}\s]/u.test(t)) terms.add(t);
  }
  terms.delete("");
  return [...terms];
}
