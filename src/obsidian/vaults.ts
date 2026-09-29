import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface VaultInfo {
  id: string;
  path: string;
  name: string;
  open: boolean;
}

export const DEFAULT_REGISTRY = join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");

export async function listVaults(registryPath = DEFAULT_REGISTRY): Promise<VaultInfo[]> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw) as { vaults?: Record<string, { path: string; open?: boolean }> };
  return Object.entries(parsed.vaults ?? {}).map(([id, v]) => ({ id, path: v.path, name: basename(v.path), open: Boolean(v.open) }));
}
