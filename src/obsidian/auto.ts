import type { Ctx } from "../ctx.js";
import type { SyncResult } from "./write.js";
import { projectObsidian } from "./project.js";

export interface AutoProjectorOptions {
  /** Quiet period after the last notify before a projection runs. Default 3000 ms. */
  debounceMs?: number;
  /** The projection to run. Default: projectObsidian(ctx) with the configured vault and folder. */
  project?: (ctx: Ctx) => Promise<SyncResult>;
  /** Where failures are reported. Default: stderr (never stdout, which the MCP stdio server owns). */
  log?: (message: string) => void;
}

/**
 * Keeps the Obsidian mirror current after saves. notify() schedules a projection a debounce period after
 * the last change; projections never overlap, and a notify that arrives while one runs schedules exactly
 * one more after it. A failed projection is logged and never thrown to the caller.
 */
export class ObsidianAutoProjector {
  private readonly debounceMs: number;
  private readonly project: (ctx: Ctx) => Promise<SyncResult>;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** A notify arrived while a projection was running. */
  private again = false;
  private closed = false;

  constructor(
    private readonly ctx: Ctx,
    opts: AutoProjectorOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 3000;
    this.project = opts.project ?? ((c) => projectObsidian(c));
    this.log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
  }

  notify(): void {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule();
  }

  /** Runs any pending or queued projection now and resolves once none is running. */
  async flush(): Promise<void> {
    for (;;) {
      if (this.running) {
        await this.running;
        continue;
      }
      if (this.timer || this.again) {
        this.clearTimer();
        await this.run();
        continue;
      }
      return;
    }
  }

  /** Flushes, then ignores every later notify. */
  async close(): Promise<void> {
    for (;;) {
      await this.flush();
      // Checked synchronously after the flush, so no notify can slip in between the check and closing.
      if (!this.running && !this.timer && !this.again) {
        this.closed = true;
        return;
      }
    }
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private run(): Promise<void> {
    this.again = false;
    const run = (async () => {
      try {
        await this.project(this.ctx);
      } catch (err) {
        this.log(`brain: obsidian refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })().finally(() => {
      this.running = null;
      if (this.again && !this.closed) this.schedule();
    });
    this.running = run;
    return run;
  }
}

/**
 * Whether saves should refresh the Obsidian mirror: on when OBSIDIAN_VAULT_PATH names an existing
 * directory, unless OBSIDIAN_AUTO is "0".
 */
export function autoProjectionEnabled(env: Record<string, string | undefined>, fsExists: (path: string) => boolean): boolean {
  const vault = env.OBSIDIAN_VAULT_PATH;
  if (!vault || env.OBSIDIAN_AUTO === "0") return false;
  return fsExists(vault);
}
