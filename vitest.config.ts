import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration test files share one Postgres instance and some truncate
    // tables in beforeEach; running files in parallel lets one file's wipe
    // race another file's insert. Run test files sequentially to avoid that.
    fileParallelism: false,
  },
});
