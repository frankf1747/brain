import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, stat, symlink, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncFolder, isManaged } from "../../src/obsidian/write.js";

const managed = (body: string) => `---\nbrain_managed: true\n---\n${body}\n`;
const tmp = (label: string) => mkdtemp(join(tmpdir(), `brain-obsidian-${label}-`));
const exists = async (p: string) => {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
};

describe("syncFolder", () => {
  it("writes, then reports unchanged, then deletes managed leftovers and keeps unmanaged files", async () => {
    const root = await tmp("basic");
    const files = new Map([["README.md", managed("readme")], ["nodes/person/Ann.md", managed("ann")]]);

    const first = await syncFolder(root, files);
    expect(first).toEqual({ written: 2, unchanged: 0, deleted: 0, skipped: [] });
    expect(await readFile(join(root, "nodes/person/Ann.md"), "utf8")).toBe(managed("ann"));

    const second = await syncFolder(root, files);
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(2);

    await mkdir(join(root, "nodes/place"), { recursive: true });
    await writeFile(join(root, "nodes/place/Mine.md"), "my own note\n");
    files.delete("nodes/person/Ann.md");
    const third = await syncFolder(root, files);
    expect(third.deleted).toBe(1);
    expect(third.skipped).toEqual(["nodes/place/Mine.md"]);
    await expect(stat(join(root, "nodes/person/Ann.md"))).rejects.toThrow();
    expect(await readFile(join(root, "nodes/place/Mine.md"), "utf8")).toBe("my own note\n");
  });
});

describe("isManaged", () => {
  it("accepts brain_managed: true only inside the leading frontmatter block", () => {
    expect(isManaged(managed("x"))).toBe(true);
    expect(isManaged(`---\nbrain_id: "a"\nbrain_managed: true\ntags: []\n---\nbody\n`)).toBe(true);
    expect(isManaged(`---\r\nbrain_managed: true\r\n---\r\nbody\r\n`)).toBe(true);
  });

  it("rejects the marker in the body, in a later --- block, or when the first line is not ---", () => {
    expect(isManaged("my note\nbrain_managed: true\n")).toBe(false);
    expect(isManaged(`---\ntitle: mine\n---\nbody\nbrain_managed: true\n`)).toBe(false);
    expect(isManaged(`---\ntitle: mine\n---\nbody\n---\nbrain_managed: true\n---\n`)).toBe(false);
    expect(isManaged(`\n---\nbrain_managed: true\n---\n`)).toBe(false);
    expect(isManaged(`# heading\n---\nbrain_managed: true\n---\n`)).toBe(false);
    expect(isManaged(`---\nbrain_managed: true\n`)).toBe(false); // never closed
    expect(isManaged(`---\nbrain_managed: truely\n---\n`)).toBe(false);
    expect(isManaged(`---\nnot_brain_managed: true\n---\n`)).toBe(false);
    expect(isManaged("")).toBe(false);
  });

  it("does not delete files whose marker is outside the leading frontmatter", async () => {
    const root = await tmp("marker");
    const body = "my note\nbrain_managed: true\n";
    const later = `---\ntitle: mine\n---\nbody\n---\nbrain_managed: true\n---\n`;
    await writeFile(join(root, "body.md"), body);
    await writeFile(join(root, "later.md"), later);
    const r = await syncFolder(root, new Map());
    expect(r.deleted).toBe(0);
    expect(r.skipped).toEqual(["body.md", "later.md"]);
    expect(await readFile(join(root, "body.md"), "utf8")).toBe(body);
    expect(await readFile(join(root, "later.md"), "utf8")).toBe(later);
  });
});

describe("syncFolder safety", () => {
  it("never follows symlinks to files or directories during the walk", async () => {
    const root = await tmp("root");
    const outside = await tmp("outside");
    await mkdir(join(outside, "notes"), { recursive: true });
    await writeFile(join(outside, "real.md"), managed("real"));
    await writeFile(join(outside, "notes/deep.md"), managed("deep"));
    await symlink(join(outside, "real.md"), join(root, "link.md"));
    await symlink(join(outside, "notes"), join(root, "linkdir"));

    const r = await syncFolder(root, new Map());
    expect(r).toEqual({ written: 0, unchanged: 0, deleted: 0, skipped: [] });
    expect((await lstat(join(root, "link.md"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, "linkdir"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(outside, "real.md"), "utf8")).toBe(managed("real"));
    expect(await readFile(join(outside, "notes/deep.md"), "utf8")).toBe(managed("deep"));
  });

  it("does not write through a rendered path that is a symlink, or whose parent directory is one", async () => {
    const root = await tmp("root");
    const outside = await tmp("outside");
    await writeFile(join(outside, "real.md"), "user content\n");
    await symlink(join(outside, "real.md"), join(root, "Ann.md"));
    await mkdir(join(root, "nodes"));
    await symlink(outside, join(root, "nodes/person"));

    const r = await syncFolder(root, new Map([["Ann.md", managed("ann")], ["nodes/person/Bob.md", managed("bob")], ["ok.md", managed("ok")]]));
    expect(r.written).toBe(1);
    expect(r.skipped).toEqual(["Ann.md", "nodes/person/Bob.md"]);
    expect(await readFile(join(outside, "real.md"), "utf8")).toBe("user content\n");
    expect(await exists(join(outside, "Bob.md"))).toBe(false);
    expect((await lstat(join(root, "Ann.md"))).isSymbolicLink()).toBe(true);
  });

  it("refuses to write outside root", async () => {
    const parent = await tmp("parent");
    const root = join(parent, "Brain");
    await expect(syncFolder(root, new Map([["../escape.md", managed("x")]]))).rejects.toThrow(/outside/);
    await expect(syncFolder(root, new Map([["nodes/../../escape.md", managed("x")]]))).rejects.toThrow(/outside/);
    await expect(syncFolder(root, new Map([["/etc/escape.md", managed("x")]]))).rejects.toThrow(/outside/);
    await expect(syncFolder(root, new Map([["", managed("x")]]))).rejects.toThrow(/outside/);
    expect(await exists(join(parent, "escape.md"))).toBe(false);
  });

  it("ignores non-.md files and dot-directories", async () => {
    const root = await tmp("root");
    await writeFile(join(root, "data.txt"), managed("txt"));
    await writeFile(join(root, "note.markdown"), managed("md-ish"));
    await mkdir(join(root, ".obsidian"));
    await writeFile(join(root, ".obsidian/workspace.md"), managed("ws"));
    await mkdir(join(root, ".trash/sub"), { recursive: true });
    await writeFile(join(root, ".trash/sub/old.md"), managed("old"));

    const r = await syncFolder(root, new Map());
    expect(r).toEqual({ written: 0, unchanged: 0, deleted: 0, skipped: [] });
    expect(await exists(join(root, "data.txt"))).toBe(true);
    expect(await exists(join(root, "note.markdown"))).toBe(true);
    expect(await exists(join(root, ".obsidian/workspace.md"))).toBe(true);
    expect(await exists(join(root, ".trash/sub/old.md"))).toBe(true);
  });

  it("removes only directories emptied by a managed deletion and never removes root", async () => {
    const root = await tmp("root");
    await mkdir(join(root, "nodes/person"), { recursive: true });
    await writeFile(join(root, "nodes/person/Ann.md"), managed("ann"));
    await mkdir(join(root, "keep/empty"), { recursive: true });
    await writeFile(join(root, "Top.md"), managed("top"));

    const r = await syncFolder(root, new Map());
    expect(r.deleted).toBe(2);
    expect(await exists(join(root, "nodes"))).toBe(false);
    expect(await exists(join(root, "keep/empty"))).toBe(true);
    expect(await exists(root)).toBe(true);

    const root2 = await tmp("root2");
    await writeFile(join(root2, "Only.md"), managed("only"));
    await syncFolder(root2, new Map());
    expect(await exists(root2)).toBe(true);
    expect(await readdir(root2)).toEqual([]);
  });

  it("keeps a directory that still holds unmanaged files after a managed deletion", async () => {
    const root = await tmp("root");
    await mkdir(join(root, "nodes/person"), { recursive: true });
    await writeFile(join(root, "nodes/person/Ann.md"), managed("ann"));
    await writeFile(join(root, "nodes/person/picture.png"), "png");
    const r = await syncFolder(root, new Map());
    expect(r.deleted).toBe(1);
    expect(await exists(join(root, "nodes/person/picture.png"))).toBe(true);
  });
});
