import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupOrphanedProcessorScratch } from "./scratch-cleanup.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("processor response scratch recovery", () => {
  it("deletes only stale generated directories and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-scratch-test-"));
    const outside = await mkdtemp(join(tmpdir(), "worker-scratch-outside-"));
    temporaryDirectories.push(root, outside);
    const stale = join(root, "processor-response-AbC123");
    const fresh = join(root, "processor-response-Fresh9");
    const unrelated = join(root, "customer-files");
    const matchingFile = join(root, "processor-response-File99");
    const matchingLink = join(root, "processor-response-Link99");
    const now = Date.parse("2026-07-24T12:00:00.000Z");
    const old = new Date(now - 10 * 60_000);

    await Promise.all([
      mkdir(stale),
      mkdir(fresh),
      mkdir(unrelated),
      writeFile(matchingFile, "keep", "utf8")
    ]);
    await writeFile(join(stale, "private-artifact"), "delete", "utf8");
    await writeFile(join(unrelated, "private-artifact"), "keep", "utf8");
    await writeFile(join(outside, "private-artifact"), "keep", "utf8");
    await symlink(outside, matchingLink);
    await Promise.all([
      utimes(stale, old, old),
      utimes(unrelated, old, old),
      utimes(fresh, new Date(now), new Date(now))
    ]);

    await expect(
      cleanupOrphanedProcessorScratch({
        directory: root,
        staleAfterMilliseconds: 5 * 60_000,
        now: () => now
      })
    ).resolves.toBe(1);

    await expect(access(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(fresh)).resolves.toBeUndefined();
    await expect(readFile(join(unrelated, "private-artifact"), "utf8")).resolves.toBe("keep");
    await expect(readFile(join(outside, "private-artifact"), "utf8")).resolves.toBe("keep");
    await expect(readFile(matchingFile, "utf8")).resolves.toBe("keep");
    expect((await lstat(matchingLink)).isSymbolicLink()).toBe(true);
    expect((await stat(root)).mode & 0o777).toBe(0o700);

    await expect(
      cleanupOrphanedProcessorScratch({
        directory: root,
        staleAfterMilliseconds: 5 * 60_000,
        now: () => now
      })
    ).resolves.toBe(0);
  });

  it("rejects a symlink configured as the scratch root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "worker-scratch-outside-"));
    const parent = await mkdtemp(join(tmpdir(), "worker-scratch-parent-"));
    temporaryDirectories.push(outside, parent);
    const link = join(parent, "scratch");
    await symlink(outside, link);

    await expect(
      cleanupOrphanedProcessorScratch({
        directory: link,
        staleAfterMilliseconds: 60_000
      })
    ).rejects.toThrow("PROCESSOR_SCRATCH_ROOT_INVALID");
  });

  it("rejects an existing scratch root visible to other local users", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "worker-scratch-insecure-"));
    temporaryDirectories.push(root);
    await chmod(root, 0o755);

    await expect(
      cleanupOrphanedProcessorScratch({
        directory: root,
        staleAfterMilliseconds: 60_000
      })
    ).rejects.toThrow("PROCESSOR_SCRATCH_ROOT_PERMISSIONS_INVALID");
  });
});
