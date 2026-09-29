import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SyncResult {
  written: number;
  unchanged: number;
  deleted: number;
  skipped: string[];
}

/**
 * True only when the file opens with a frontmatter block (first line exactly `---`, closed by the next
 * line that is exactly `---`) and that block contains the line `brain_managed: true`. The marker in the
 * body or in any later `---` block does not count.
 */
export function isManaged(content: string): boolean {
  const lines = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines[0] !== "---") return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return false; // closed without the marker
    if (lines[i] === "brain_managed: true") {
      // Marker found; the block must still be closed for this to be frontmatter.
      for (let j = i + 1; j < lines.length; j++) if (lines[j] === "---") return true;
      return false;
    }
  }
  return false;
}

/** True when `target` is strictly inside `root` (never root itself). */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function resolveInside(root: string, rel: string): string {
  const full = resolve(root, rel);
  if (!isInside(root, full)) throw new Error(`refusing to touch a path outside the projection root: ${JSON.stringify(rel)}`);
  return full;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** Regular .md files under `dir`, skipping symlinks (to files or directories) and dot-directories. */
async function walk(dir: string, root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith(".")) out.push(...(await walk(full, root)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(relative(root, full));
    }
  }
  return out;
}

/** True when the target or any existing directory between root and it is a symlink or not writable as a file. */
async function unsafeTarget(root: string, full: string): Promise<boolean> {
  const parts = relative(root, full).split(sep);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    const st = await lstatOrNull(cur);
    if (!st) return false; // the rest does not exist yet; mkdir/writeFile create real entries
    if (st.isSymbolicLink()) return true;
    const last = i === parts.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) return true;
  }
  return false;
}

/** Makes `root` contain exactly `files` among managed notes. Unmanaged files are reported, never touched. */
export async function syncFolder(root: string, files: Map<string, string>): Promise<SyncResult> {
  root = resolve(root);
  // Validate every target before touching the disk.
  const targets = [...files].map(([rel, content]) => ({ rel, content, full: resolveInside(root, rel) }));

  await mkdir(root, { recursive: true });
  const result: SyncResult = { written: 0, unchanged: 0, deleted: 0, skipped: [] };
  const existing = new Set(await walk(root, root));

  for (const { rel, content, full } of targets) {
    existing.delete(relative(root, full));
    if (await unsafeTarget(root, full)) {
      result.skipped.push(rel);
      continue;
    }
    const current = (await lstatOrNull(full)) ? await readFile(full, "utf8") : null;
    if (current !== null && !isManaged(current)) {
      // A note the projection did not write; never overwrite it.
      result.skipped.push(rel);
      continue;
    }
    if (current === content) {
      result.unchanged++;
    } else {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      result.written++;
    }
  }

  for (const rel of existing) {
    const full = resolveInside(root, rel);
    const st = await lstatOrNull(full);
    if (!st || !st.isFile()) continue;
    if (!isManaged(await readFile(full, "utf8"))) {
      result.skipped.push(rel);
      continue;
    }
    await rm(full);
    result.deleted++;
    // Remove directories this deletion left empty, stopping at root (never removed) or at the first non-empty one.
    let dir = dirname(full);
    while (isInside(root, dir)) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
  result.skipped.sort();
  return result;
}
