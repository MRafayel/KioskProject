import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "./generated/prisma/client.js";
import {
  MAX_UPLOAD_ARTIFACT_SETTLE_MILLISECONDS,
  PROCESSING_ARTIFACT_SETTLE_MILLISECONDS,
  scheduleSessionFilesForCleanup,
  uploadArtifactCleanupDueAt
} from "./session-cleanup.js";

const sessionId = "01900000-0000-7000-8000-000000000901";
const now = new Date("2030-01-01T00:00:00.000Z");

function stubTransaction() {
  const fileUpdateMany = vi
    .fn<(input: unknown) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 1 });
  const sessionUpdateMany = vi
    .fn<(input: unknown) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 1 });
  const transaction = {
    uploadedFile: { updateMany: fileUpdateMany },
    printSession: { updateMany: sessionUpdateMany }
  } as unknown as Prisma.TransactionClient;
  return { transaction, fileUpdateMany, sessionUpdateMany };
}

describe("session cleanup scheduling", () => {
  it("keeps settled files behind the configured session retention deadline", async () => {
    const { transaction, fileUpdateMany, sessionUpdateMany } = stubTransaction();
    const dueAt = new Date(now.getTime() + 300_000);

    await scheduleSessionFilesForCleanup(transaction, sessionId, now, {
      terminalState: "COMPLETED",
      policy: { settledGraceMilliseconds: 300_000, recoveryGraceMilliseconds: 900_000 }
    });

    const settledFileUpdate = fileUpdateMany.mock.calls[2]?.[0] as {
      where: unknown;
      data: { cleanupDueAt: Date };
    };
    expect(settledFileUpdate.where).toEqual({
      sessionId,
      status: { in: ["QUARANTINED", "READY"] }
    });
    expect(settledFileUpdate.data.cleanupDueAt).toEqual(dueAt);

    const validatingFileUpdate = fileUpdateMany.mock.calls[3]?.[0] as {
      where: unknown;
      data: { cleanupDueAt: Date };
    };
    expect(validatingFileUpdate.where).toEqual({ sessionId, status: "VALIDATING" });
    expect(validatingFileUpdate.data.cleanupDueAt).toEqual(dueAt);

    const sessionUpdate = sessionUpdateMany.mock.calls[0]?.[0] as {
      data: { cleanupDueAt: Date };
    };
    expect(sessionUpdate.data.cleanupDueAt).toEqual(dueAt);
  });

  it("does not let a short policy cut through the processing settle barrier", async () => {
    const { transaction, fileUpdateMany } = stubTransaction();

    await scheduleSessionFilesForCleanup(transaction, sessionId, now, {
      terminalState: "CANCELED",
      policy: { settledGraceMilliseconds: 0, recoveryGraceMilliseconds: 0 }
    });

    const validatingFileUpdate = fileUpdateMany.mock.calls[3]?.[0] as {
      data: { cleanupDueAt: Date };
    };
    expect(validatingFileUpdate.data.cleanupDueAt).toEqual(
      new Date(now.getTime() + PROCESSING_ARTIFACT_SETTLE_MILLISECONDS)
    );
  });

  it("protects legacy in-flight uploads that have no persisted deadline", async () => {
    const { transaction, fileUpdateMany } = stubTransaction();

    await scheduleSessionFilesForCleanup(transaction, sessionId, now);

    expect(fileUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { sessionId, status: "UPLOADING", cleanupDueAt: null },
      data: {
        cleanupDueAt: new Date(now.getTime() + MAX_UPLOAD_ARTIFACT_SETTLE_MILLISECONDS),
        cleanupErrorCode: null,
        updatedAt: now
      }
    });
  });

  it("derives an upload barrier from the configured request timeout", () => {
    expect(uploadArtifactCleanupDueAt(now, 120_000)).toEqual(new Date(now.getTime() + 150_000));
    expect(() => uploadArtifactCleanupDueAt(now, 0)).toThrow("UPLOAD_CLEANUP_BARRIER_INVALID");
  });
});
