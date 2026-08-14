import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeviceOperationJournal, deviceJobName, parseDeviceJobName } from "./operation-journal.js";
import { PrinterAdapterError } from "./types.js";

const operationId = "01900000-0000-7000-8000-0000000000a1";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "device-journal-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function record() {
  return {
    operationId,
    queueName: "Kiosk A4",
    submittedAt: "2026-08-10T10:00:00.000Z",
    documentCount: 2,
    documents: [
      { position: 0, jobId: null, jobName: deviceJobName(operationId, 0, 2) },
      { position: 1, jobId: null, jobName: deviceJobName(operationId, 1, 2) }
    ]
  };
}

describe("DeviceOperationJournal", () => {
  it("has nothing to say about an operation that was never opened", async () => {
    const journal = new DeviceOperationJournal(directory);

    expect(await journal.read(operationId)).toBeNull();
  });

  it("keeps the queue's own job identifiers as they arrive", async () => {
    const journal = new DeviceOperationJournal(directory);
    await journal.open(record());
    await journal.recordJobId(operationId, 1, "412");

    const stored = await journal.read(operationId);
    expect(stored?.documents).toEqual([
      { position: 0, jobId: null, jobName: deviceJobName(operationId, 0, 2) },
      { position: 1, jobId: "412", jobName: deviceJobName(operationId, 1, 2) }
    ]);
  });

  /**
   * A record truncated by a power cut still proves that a submission started.
   * Reading it as absent is the one interpretation that would let the operation
   * be handed to a printer a second time.
   */
  it("treats an unreadable record as evidence that something was submitted", async () => {
    const journal = new DeviceOperationJournal(directory);
    await journal.open(record());
    await writeFile(join(directory, `${operationId}.json`), '{"operationId"', "utf8");

    const stored = await journal.read(operationId);
    expect(stored).not.toBeNull();
    expect(stored?.documents).toEqual([]);
  });

  it("drops only entries older than the cutoff", async () => {
    const journal = new DeviceOperationJournal(directory);
    const oldOperation = "01900000-0000-7000-8000-0000000000b2";
    await journal.open(record());
    await journal.open({ ...record(), operationId: oldOperation });

    const past = new Date("2026-08-10T09:00:00.000Z");
    await utimes(join(directory, `${oldOperation}.json`), past, past);

    expect(await journal.discardBefore(new Date("2026-08-10T09:30:00.000Z"))).toBe(1);
    expect(await journal.read(oldOperation)).toBeNull();
    expect(await journal.read(operationId)).not.toBeNull();
  });

  it("leaves files it did not write alone", async () => {
    const journal = new DeviceOperationJournal(directory);
    await journal.open(record());
    const past = new Date("2020-01-01T00:00:00.000Z");
    await writeFile(join(directory, "operator-note.json"), "{}", "utf8");
    await utimes(join(directory, "operator-note.json"), past, past);

    expect(await journal.discardBefore(new Date("2026-08-10T09:30:00.000Z"))).toBe(0);
    expect(await readdir(directory)).toContain("operator-note.json");
  });

  it("answers nothing for a directory that has never been written to", async () => {
    const journal = new DeviceOperationJournal(join(directory, "absent"));

    expect(await journal.discardBefore(new Date())).toBe(0);
  });

  it("refuses an operation identifier that is not one", async () => {
    const journal = new DeviceOperationJournal(directory);

    await expect(journal.read("../escape")).rejects.toBeInstanceOf(PrinterAdapterError);
  });
});

describe("deviceJobName", () => {
  /**
   * The name is the only durable link between an operation and the queue's own
   * jobs after both sides restart, and carrying the document count is what lets
   * a bare listing tell a complete operation from a partial one.
   */
  it("round-trips the operation, the position and the document count", () => {
    const name = deviceJobName(operationId, 2, 10);

    expect(name).toBe(`${operationId}#002of010`);
    expect(parseDeviceJobName(name)).toEqual({ operationId, position: 2, documentCount: 10 });
  });

  it("refuses a name it did not write", () => {
    expect(parseDeviceJobName("Quarterly report.pdf")).toBeNull();
    expect(parseDeviceJobName(`${operationId}#010of010`)).toBeNull();
    expect(parseDeviceJobName("not-a-uuid#000of001")).toBeNull();
  });
});
