/** Safe for macOS, Windows, Obsidian file names and inside [[wikilinks]]. */
export function sanitizeName(s: string): string {
  let out = s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
  if (out.length > 120) out = out.slice(0, 120).trim();
  out = out.replace(/\.+$/, "").trim();
  return out || "untitled";
}

/** Note name per id. Names are compared case-insensitively because macOS file systems usually are. */
export function uniqueNames(items: { id: string; name: string; createdAt: Date }[]): Map<string, string> {
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    const key = sanitizeName(it.name).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    sorted.forEach((it, i) => {
      const base = sanitizeName(it.name);
      out.set(it.id, i === 0 ? base : `${base} (${it.id.slice(0, 8)})`);
    });
  }
  return out;
}
