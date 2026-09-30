import { describe, it, expect, vi, afterEach } from "vitest";
import type { Ctx } from "../../src/ctx.js";
import type { SyncResult } from "../../src/obsidian/write.js";
import { ObsidianAutoProjector, autoProjectionEnabled } from "../../src/obsidian/auto.js";

const ctx = {} as Ctx;
const ok: SyncResult = { written: 0, unchanged: 0, deleted: 0, skipped: [] };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A project function that counts calls and can be held open until released. */
function fakeProject() {
  const state = { calls: 0, hold: false, releases: [] as (() => void)[] };
  const project = async () => {
    state.calls++;
    if (state.hold) await new Promise<void>((r) => state.releases.push(r));
    return ok;
  };
  return { state, project };
}

afterEach(() => vi.restoreAllMocks());

describe("ObsidianAutoProjector", () => {
  it("collapses a burst of notifies into one projection after the debounce", async () => {
    const { state, project } = fakeProject();
    const p = new ObsidianAutoProjector(ctx, { debounceMs: 30, project, log: () => {} });
    for (let i = 0; i < 5; i++) p.notify();
    expect(state.calls).toBe(0);
    await wait(80);
    expect(state.calls).toBe(1);
    await p.close();
    expect(state.calls).toBe(1);
  });

  it("runs exactly one more projection when notified during a running one", async () => {
    const { state, project } = fakeProject();
    const p = new ObsidianAutoProjector(ctx, { debounceMs: 10, project, log: () => {} });
    state.hold = true;
    p.notify();
    await wait(40);
    expect(state.calls).toBe(1);
    p.notify();
    p.notify();
    p.notify();
    await wait(40);
    expect(state.calls).toBe(1); // never overlaps
    state.hold = false;
    state.releases.shift()!();
    await wait(60);
    expect(state.calls).toBe(2);
    await p.flush();
    expect(state.calls).toBe(2);
  });

  it("flush runs a pending projection immediately and resolves after it", async () => {
    const { state, project } = fakeProject();
    const p = new ObsidianAutoProjector(ctx, { debounceMs: 60_000, project, log: () => {} });
    p.notify();
    await p.flush();
    expect(state.calls).toBe(1);
    await p.flush();
    expect(state.calls).toBe(1); // nothing pending, nothing run
  });

  it("flush waits for a running projection and the one queued behind it", async () => {
    const { state, project } = fakeProject();
    const p = new ObsidianAutoProjector(ctx, { debounceMs: 60_000, project, log: () => {} });
    state.hold = true;
    p.notify();
    const first = p.flush();
    await wait(10);
    p.notify(); // arrives while the first projection runs
    state.hold = false;
    let done = false;
    const second = p.flush().then(() => (done = true));
    await wait(10);
    expect(done).toBe(false);
    state.releases.shift()!();
    await Promise.all([first, second]);
    expect(state.calls).toBe(2);
  });

  it("logs a failed projection and does not reject flush", async () => {
    const logs: string[] = [];
    const p = new ObsidianAutoProjector(ctx, {
      debounceMs: 60_000,
      project: async () => {
        throw new Error("disk full");
      },
      log: (m) => logs.push(m),
    });
    p.notify();
    await expect(p.flush()).resolves.toBeUndefined();
    expect(logs).toEqual(["brain: obsidian refresh failed: disk full"]);
  });

  it("ignores notifies after close", async () => {
    const { state, project } = fakeProject();
    const p = new ObsidianAutoProjector(ctx, { debounceMs: 10, project, log: () => {} });
    p.notify();
    await p.close();
    expect(state.calls).toBe(1);
    p.notify();
    await wait(40);
    await p.flush();
    expect(state.calls).toBe(1);
  });

  it("unrefs its timer so it never keeps the process alive", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const { project } = fakeProject();
    const p = new ObsidianAutoProjector(ctx, { debounceMs: 60_000, project, log: () => {} });
    p.notify();
    const timer = spy.mock.results.at(-1)!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await p.close();
  });
});

describe("autoProjectionEnabled", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  it("is on when the vault path exists and OBSIDIAN_AUTO is not 0", () => {
    expect(autoProjectionEnabled({ OBSIDIAN_VAULT_PATH: "/v" }, exists(["/v"]))).toBe(true);
    expect(autoProjectionEnabled({ OBSIDIAN_VAULT_PATH: "/v", OBSIDIAN_AUTO: "1" }, exists(["/v"]))).toBe(true);
  });

  it("is off when turned off, unset, or pointing at a missing path", () => {
    expect(autoProjectionEnabled({ OBSIDIAN_VAULT_PATH: "/v", OBSIDIAN_AUTO: "0" }, exists(["/v"]))).toBe(false);
    expect(autoProjectionEnabled({}, exists(["/v"]))).toBe(false);
    expect(autoProjectionEnabled({ OBSIDIAN_VAULT_PATH: "" }, exists([""]))).toBe(false);
    expect(autoProjectionEnabled({ OBSIDIAN_VAULT_PATH: "/missing" }, exists(["/v"]))).toBe(false);
  });
});
