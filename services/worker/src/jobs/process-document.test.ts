import { describe, expect, it, vi } from "vitest";

import type { Prisma, PrismaClient } from "@printing-kiosk/database";

import { ProcessorRequestError } from "../processing/processor-client.js";
import type { DocumentStore } from "../storage/document-store.js";
import { DocumentProcessingCoordinator } from "./process-document.js";

vi.mock("bullmq", () => ({
  Queue: class {
    public add = vi.fn();
    public close = vi.fn().mockResolvedValue(undefined);
  },
  Worker: class {
    public on = vi.fn().mockReturnThis();
    public run = vi.fn().mockResolvedValue(undefined);
    public close = vi.fn().mockResolvedValue(undefined);
  }
}));

const fileId = "01900000-0000-7000-8000-000000000101";
const sessionId = "01900000-0000-7000-8000-000000000102";
const claimToken = "01900000-0000-7000-8000-000000000103";
const originalId = "01900000-0000-7000-8000-000000000104";
const oldPreviewId = "01900000-0000-7000-8000-000000000105";
const replacementPreviewId = "01900000-0000-7000-8000-000000000106";

const claimed = {
  id: fileId,
  sessionId,
  kioskId: "test-kiosk",
  generation: 4,
  processingRevision: 1,
  processingAttempts: 1,
  claimToken,
  kind: "PDF" as const,
  sizeBytes: 10,
  contentSha256: "a".repeat(64),
  quarantineObjectKey: `quarantine/v1/${sessionId}/${fileId}/original-token-value`
};

describe("DocumentProcessingCoordinator cleanup ownership", () => {
  it("deletes only derivative IDs captured by the current owner", async () => {
    const filePageDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const derivativeDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const transaction = transactionClient({
      filePageDeleteMany,
      derivativeDeleteMany,
      liveClaim: true
    });
    const database = databaseClient(transaction, [
      {
        id: originalId,
        objectKey: claimed.quarantineObjectKey,
        type: "ORIGINAL"
      },
      {
        id: oldPreviewId,
        objectKey: `previews/v1/${sessionId}/${fileId}/r1/g4/page-1.webp`,
        type: "PAGE_PREVIEW"
      }
    ]);
    const store = documentStore();
    const coordinator = coordinatorFor(database, store);

    await expect(cleanup(coordinator, claimed)).resolves.toBe(true);
    expect(filePageDeleteMany).toHaveBeenCalledWith({
      where: { previewDerivativeId: { in: [originalId, oldPreviewId] } }
    });
    expect(derivativeDeleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: [originalId, oldPreviewId] },
        fileId
      }
    });
    expect(JSON.stringify(derivativeDeleteMany.mock.calls)).not.toContain(replacementPreviewId);
  });

  it("does not remove ledger rows after ownership is lost during object cleanup", async () => {
    const filePageDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const derivativeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const transaction = transactionClient({
      filePageDeleteMany,
      derivativeDeleteMany,
      liveClaim: false
    });
    const database = databaseClient(transaction, [
      {
        id: oldPreviewId,
        objectKey: `previews/v1/${sessionId}/${fileId}/r1/g4/page-1.webp`,
        type: "PAGE_PREVIEW"
      }
    ]);
    const coordinator = coordinatorFor(database, documentStore());

    await expect(cleanup(coordinator, claimed)).rejects.toThrow("PROCESSING_LEASE_LOST");
    expect(filePageDeleteMany).not.toHaveBeenCalled();
    expect(derivativeDeleteMany).not.toHaveBeenCalled();
  });

  it("persists a cleanup marker when a lost-owner compensating delete fails", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const database = {
      fileDerivative: { updateMany }
    } as unknown as PrismaClient;
    const deleteObject = vi.fn().mockRejectedValueOnce(new Error("OBJECT_DELETE_FAILED"));
    const store = documentStore(deleteObject);
    const coordinator = coordinatorFor(database, store);
    const artifact = {
      id: oldPreviewId,
      objectKey: `previews/v1/${sessionId}/${fileId}/r1/g4/page-1.webp`,
      type: "PAGE_PREVIEW" as const,
      pageNumber: 1,
      mimeType: "image/webp" as const,
      sizeBytes: 10,
      sha256: "b".repeat(64),
      widthPixels: 100,
      heightPixels: 100
    };

    await expect(compensate(coordinator, claimed, artifact)).rejects.toEqual(
      expect.objectContaining<Partial<ProcessorRequestError>>({
        code: "DERIVATIVE_CLEANUP_FAILED",
        retryable: true
      })
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: oldPreviewId,
        fileId,
        objectKey: artifact.objectKey
      },
      data: {
        status: "DELETE_PENDING",
        deletedAt: null
      }
    });
  });
});

describe("DocumentProcessingCoordinator failure classification", () => {
  it.each([
    "INVALID_AUTHENTICATION",
    "INVALID_PROTOCOL_VERSION",
    "PROCESSOR_REQUEST_INVALID",
    "NATIVE_TOOL_UNAVAILABLE",
    "PROCESSING_TIMEOUT",
    "CONTENT_HASH_MISMATCH",
    "SOURCE_INTEGRITY_FAILED"
  ])(
    "retries the operational %s failure even when the processor marks it non-retryable",
    async (code) => {
      const { database, updateMany } = failureDatabase();
      const coordinator = coordinatorFor(database, documentStore());

      await handleFailure(
        coordinator,
        { ...claimed, processingAttempts: 1 },
        new ProcessorRequestError(code, false)
      );

      expect(updateMany).toHaveBeenCalledTimes(1);
      const data = updateMany.mock.calls[0]?.[0].data;
      expect(data).toMatchObject({
        status: "QUARANTINED",
        processingErrorCode: code
      });
      expect(data).not.toHaveProperty("rejectionCode");
    }
  );

  it("retries a processor capacity failure instead of rejecting valid content", async () => {
    const { database, updateMany } = failureDatabase();
    const coordinator = coordinatorFor(database, documentStore());

    await handleFailure(
      coordinator,
      { ...claimed, processingAttempts: 1 },
      new ProcessorRequestError("PROCESSOR_CAPACITY_EXHAUSTED", true)
    );

    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      status: "QUARANTINED",
      processingErrorCode: "PROCESSOR_CAPACITY_EXHAUSTED"
    });
  });

  it("fails safely after the bounded operational retry budget is exhausted", async () => {
    const { database, updateMany } = failureDatabase();
    const coordinator = coordinatorFor(database, documentStore());

    await handleFailure(
      coordinator,
      { ...claimed, processingAttempts: 3 },
      new ProcessorRequestError("INVALID_AUTHENTICATION", false)
    );

    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      status: "DELETE_PENDING",
      rejectionCode: "PROCESSING_FAILED",
      processingErrorCode: "INVALID_AUTHENTICATION"
    });
  });

  it.each([
    ["PROCESSING_TIMEOUT", "PROCESSING_TIMEOUT"],
    ["PROCESSOR_TIMEOUT", "PROCESSING_TIMEOUT"],
    ["MALWARE_SCANNER_UNAVAILABLE", "MALWARE_SCAN_UNAVAILABLE"],
    ["MALWARE_SCANNER_STALE", "MALWARE_SCAN_UNAVAILABLE"]
  ])(
    "reports %s as %s once the retry budget is exhausted",
    async (processorCode, expectedRejection) => {
      const { database, updateMany } = failureDatabase();
      const coordinator = coordinatorFor(database, documentStore());

      await handleFailure(
        coordinator,
        { ...claimed, processingAttempts: 3 },
        new ProcessorRequestError(processorCode, true)
      );

      expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
        status: "DELETE_PENDING",
        rejectionCode: expectedRejection,
        processingErrorCode: processorCode
      });
    }
  );

  it("still retries a processing timeout while the retry budget remains", async () => {
    const { database, updateMany } = failureDatabase();
    const coordinator = coordinatorFor(database, documentStore());

    await handleFailure(
      coordinator,
      { ...claimed, processingAttempts: 1 },
      new ProcessorRequestError("PROCESSING_TIMEOUT", true)
    );

    const data = updateMany.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ status: "QUARANTINED" });
    expect(data).not.toHaveProperty("rejectionCode");
  });

  it("terminally rejects an explicit non-retryable content-validation failure", async () => {
    const { database, updateMany } = failureDatabase();
    const coordinator = coordinatorFor(database, documentStore());

    await handleFailure(
      coordinator,
      claimed,
      new ProcessorRequestError("MALFORMED_DOCUMENT", false)
    );

    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      status: "DELETE_PENDING",
      rejectionCode: "DOCUMENT_MALFORMED",
      processingErrorCode: "MALFORMED_DOCUMENT"
    });
  });
});

describe("DocumentProcessingCoordinator stale-claim recovery", () => {
  const expiredLease = new Date("2026-07-20T10:00:00.000Z");
  const staleCandidate = {
    id: fileId,
    sessionId,
    processingClaimToken: "01900000-0000-7000-8000-000000000107",
    processingLeaseExpiresAt: expiredLease,
    processingGeneration: claimed.generation,
    processingRevision: claimed.processingRevision,
    processingAttempts: 1,
    kind: claimed.kind,
    sizeBytes: claimed.sizeBytes,
    contentSha256: claimed.contentSha256,
    quarantineObjectKey: claimed.quarantineObjectKey
  };

  it("reclaims an expired lease with compare-and-set and returns the file to the retry queue", async () => {
    const updateMany = createUploadedFileUpdateManyMock();
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(staleCandidate)
      .mockResolvedValueOnce({ id: fileId });
    const transaction = transactionClient({
      filePageDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      derivativeDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      liveClaim: true
    });
    const database = {
      uploadedFile: { findFirst, updateMany },
      fileDerivative: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction)
      )
    } as unknown as PrismaClient;
    const coordinator = coordinatorFor(database, documentStore());

    await recoverStaleClaim(coordinator);

    expect(updateMany).toHaveBeenCalledTimes(2);
    const recoveryClaim = updateMany.mock.calls[0]?.[0];
    expect(recoveryClaim?.where).toEqual({
      id: fileId,
      status: "VALIDATING",
      processingClaimToken: staleCandidate.processingClaimToken,
      processingLeaseExpiresAt: expiredLease
    });
    const recoveredToken = recoveryClaim?.data.processingClaimToken;
    if (typeof recoveredToken !== "string") throw new Error("RECOVERY_TOKEN_MISSING");
    expect(recoveredToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
      where: {
        id: fileId,
        status: "VALIDATING",
        processingGeneration: claimed.generation,
        processingClaimToken: recoveredToken
      },
      data: {
        status: "QUARANTINED",
        processingEnqueuedAt: null,
        processingClaimToken: null,
        processingLeaseExpiresAt: null,
        processingStartedAt: null,
        processingErrorCode: "PROCESSING_WORKER_INTERRUPTED"
      }
    });
  });

  it("does nothing when another worker wins the stale-lease recovery race", async () => {
    const updateMany = createUploadedFileUpdateManyMock().mockResolvedValueOnce({ count: 0 });
    const findDerivatives = vi.fn();
    const database = {
      uploadedFile: {
        findFirst: vi.fn().mockResolvedValue(staleCandidate),
        updateMany
      },
      fileDerivative: { findMany: findDerivatives }
    } as unknown as PrismaClient;
    const coordinator = coordinatorFor(database, documentStore());

    await recoverStaleClaim(coordinator);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(findDerivatives).not.toHaveBeenCalled();
  });
});

function coordinatorFor(database: PrismaClient, store: DocumentStore) {
  return new DocumentProcessingCoordinator({
    database,
    redisUrl: "redis://127.0.0.1:6379",
    store,
    processor: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },
    concurrency: 1,
    leaseMilliseconds: 60_000,
    maximumAttempts: 3
  });
}

function databaseClient(
  transaction: ReturnType<typeof transactionClient>,
  derivatives: Array<{ id: string; objectKey: string; type: string }>
): PrismaClient {
  return {
    fileDerivative: {
      findMany: vi.fn().mockResolvedValue(derivatives)
    },
    $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
      operation(transaction)
    )
  } as unknown as PrismaClient;
}

function failureDatabase(): {
  database: PrismaClient;
  updateMany: ReturnType<typeof createUploadedFileUpdateManyMock>;
} {
  const updateMany = createUploadedFileUpdateManyMock();
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: sessionId }]),
    uploadedFile: {
      findFirst: vi.fn().mockResolvedValue({ id: fileId })
    },
    filePage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    fileDerivative: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) }
  };
  return {
    database: {
      uploadedFile: {
        findFirst: vi.fn().mockResolvedValue({ id: fileId }),
        updateMany
      },
      fileDerivative: {
        findMany: vi.fn().mockResolvedValue([])
      },
      $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction)
      )
    } as unknown as PrismaClient,
    updateMany
  };
}

function createUploadedFileUpdateManyMock() {
  return vi
    .fn<(input: Prisma.UploadedFileUpdateManyArgs) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 1 });
}

function transactionClient(input: {
  filePageDeleteMany: ReturnType<typeof vi.fn>;
  derivativeDeleteMany: ReturnType<typeof vi.fn>;
  liveClaim: boolean;
}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: sessionId }]),
    uploadedFile: {
      findFirst: vi.fn().mockResolvedValue(input.liveClaim ? { id: fileId } : null)
    },
    filePage: { deleteMany: input.filePageDeleteMany },
    fileDerivative: { deleteMany: input.derivativeDeleteMany }
  };
}

function documentStore(deleteObject = vi.fn().mockResolvedValue(undefined)): DocumentStore {
  return {
    getQuarantined: vi.fn(),
    putArtifact: vi.fn(),
    deleteObject,
    checkReady: vi.fn().mockResolvedValue(undefined)
  };
}

function cleanup(
  coordinator: DocumentProcessingCoordinator,
  owner: typeof claimed
): Promise<boolean> {
  return (
    coordinator as unknown as {
      cleanupArtifacts(input: typeof claimed): Promise<boolean>;
    }
  ).cleanupArtifacts(owner);
}

function compensate(
  coordinator: DocumentProcessingCoordinator,
  owner: typeof claimed,
  artifact: {
    id: string;
    objectKey: string;
    type: "PAGE_PREVIEW";
    pageNumber: number;
    mimeType: "image/webp";
    sizeBytes: number;
    sha256: string;
    widthPixels: number;
    heightPixels: number;
  }
): Promise<void> {
  return (
    coordinator as unknown as {
      compensateInvalidatedArtifact(
        input: typeof claimed,
        candidate: typeof artifact
      ): Promise<void>;
    }
  ).compensateInvalidatedArtifact(owner, artifact);
}

function handleFailure(
  coordinator: DocumentProcessingCoordinator,
  owner: typeof claimed,
  error: ProcessorRequestError
): Promise<void> {
  return (
    coordinator as unknown as {
      handleFailure(input: typeof claimed, failure: ProcessorRequestError): Promise<void>;
    }
  ).handleFailure(owner, error);
}

function recoverStaleClaim(coordinator: DocumentProcessingCoordinator): Promise<void> {
  return (
    coordinator as unknown as {
      recoverOneStaleClaim(): Promise<void>;
    }
  ).recoverOneStaleClaim();
}
