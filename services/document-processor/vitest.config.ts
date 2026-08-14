import { defineConfig } from "vitest/config";

/**
 * These suites rasterize with sharp, which is native, CPU-bound work rather than
 * the pure-JS unit tests Vitest's five-second default is calibrated for. On its
 * own the whole file finishes in under two seconds, but `pnpm test` runs every
 * workspace package concurrently and each one spawns its own worker pool, so a
 * single test can be starved past that default on a machine with fewer cores
 * than the run has tasks.
 *
 * The assertions here are about what the processor does — which files exist at
 * each step, what it refuses, what it cleans up — never about how fast it does
 * it, so a deadline that fails on a busy laptop is measuring the laptop. The
 * ceiling stays low enough to catch a genuine hang.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
