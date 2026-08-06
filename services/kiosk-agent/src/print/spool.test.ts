import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrintSpool } from "./spool.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("PrintSpool retention", () => {
  it("answers zero when no operation directory exists yet", async () => {
    const root = await temporaryDirectory();
    const spool = createSpool(join(root, "never-created"));

    await expect(spool.discardStale(new Date())).resolves.toBe(0);
  });

  it("surfaces directory failures so the runner can warn about retained bytes", async () => {
    const root = await temporaryDirectory();
    const notDirectory = join(root, "not-a-directory");
    await writeFile(notDirectory, "invalid spool path", "utf8");
    const spool = createSpool(notDirectory);

    await expect(spool.discardStale(new Date())).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

function createSpool(directory: string): PrintSpool {
  return new PrintSpool({
    directory,
    apiOrigin: "http://127.0.0.1:3100",
    authorization: "Bearer test",
    maxDocumentBytes: 1_024
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "print-spool-retention-"));
  temporaryDirectories.push(directory);
  return directory;
}
