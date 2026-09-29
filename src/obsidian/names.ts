/** Safe for macOS, Windows, Obsidian file names and inside [[wikilinks]]. Returns NFC. */
export function sanitizeName(s: string): string {
  let out = s.normalize("NFC").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
  if (out.length > 120) out = out.slice(0, 120).trim();
  out = out.replace(/\.+$/, "").replace(/^\.+/, "").trim();
  // Obsidian treats "Resume.pdf" or "notes.md" as an attachment link; keep the words, drop the extension dot.
  out = out.replace(/\.([A-Za-z]{1,5})$/, " $1");
  return out || "untitled";
}

/** Collision key: how the file system and Obsidian compare note names. */
export function nameKey(name: string): string {
  // macOS (APFS/HFS+) compares names case-insensitively and normalization-insensitively; upper-then-lower
  // also folds ß with SS.
  return sanitizeName(name).normalize("NFC").toUpperCase().toLowerCase();
}

/**
 * Note name per id, unique by nameKey. The oldest item in each group keeps the plain name and later ones
 * get an id suffix. Anything whose key equals a reserved name (e.g. README) is always suffixed.
 */
export function uniqueNames(items: { id: string; name: string; createdAt: Date }[], reserved: string[] = []): Map<string, string> {
  const reservedKeys = new Set(reserved.map(nameKey));
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const key = nameKey(it.name);
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  const out = new Map<string, string>();
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const plain = !reservedKeys.has(key);
    sorted.forEach((it, i) => {
      const base = sanitizeName(it.name);
      out.set(it.id, i === 0 && plain ? base : `${base} (${it.id.slice(0, 8)})`);
    });
  }
  return out;
}
