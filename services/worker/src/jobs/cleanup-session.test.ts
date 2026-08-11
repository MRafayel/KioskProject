import { describe, expect, it, vi, type Mock } from "vitest";

import type { PrismaClient } from "@printing-kiosk/database";

import type { RetentionStore } from "../storage/document-store.js";
import { SessionCleanupRunner, type CleanupLogger } from "./cleanup-session.js";

const sessionId = "01900000-0000-7000-8000-000000000d01";
const runId = "01900000-0000-7000-8000-000000000d02";
const fileId = "01900000-0000-7000-8000-000000000d03";
const printJobId = "01900000-0000-7000-8000-000000000d04";
const settingsId = "01900000-0000-7000-8000-000000000d05";
const now = new Date("2030-01-01T00:10:00.000Z");

const silentLogger: CleanupLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

interface StubOptions {
  checkpoint?: string;
  attempts?: number;
  /** A file whose validation barrier has not passed yet. */
  barrierAt?: Date | null;
  claimable?: boolean;
  cleanupRunUpdateCount?: number;
  sessionAlreadyCleaned?: boolean;
  outOfScopeArtifact?: boolean;
  /** A person has asked for this dead-lettered run to be tried again. */
  retryRequested?: boolean;
  /** Somebody has recorded what happened to this session's print. */
  recoveryResolved?: boolean;
}

function stubDatabase(options: StubOptions = {}) {
  const cleanupRunUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: options.cleanupRunUpdateCount ?? 1 });
  const sessionUpdate = vi.fn().mockResolvedValue({});
  const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const auditCreate = vi.fn().mockResolvedValue({});
  const outboxCreate = vi.fn().mockResolvedValue({});
  const fileUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const grantDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const commandDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const printJobUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const settingsUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const pageDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const derivativeDeleteMany = vi.fn().mockResolvedValue({ count: 2 });

  const client = {
    printSession: {
      updateMany: sessionUpdateMany,
      update: sessionUpdate,
      findUnique: vi.fn().mockResolvedValue({
        id: sessionId,
        kioskId: "kiosk_dev_001",
        eventSequence: 7,
        filesDeletedAt: options.sessionAlreadyCleaned ? now : null
      })
    },
    cleanupRun: { updateMany: cleanupRunUpdateMany },
    uploadedFile: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi
        .fn()
        .mockResolvedValue(options.barrierAt ? { cleanupDueAt: options.barrierAt } : null),
      findMany: vi.fn().mockResolvedValue([
        {
          id: fileId,
          quarantineObjectKey: options.outOfScopeArtifact
            ? "quarantine/v1/01900000-0000-7000-8000-000000000999/f/k"
            : `quarantine/v1/${sessionId}/f/k`
        }
      ]),
      updateMany: fileUpdateMany
    },
    fileDerivative: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ objectKey: `previews/v1/${sessionId}/f/r1/g1/page-1.webp` }]),
      deleteMany: derivativeDeleteMany
    },
    filePage: { deleteMany: pageDeleteMany },
    sessionUploadGrant: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: grantDeleteMany
    },
    mobileClient: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    agentCommand: { deleteMany: commandDeleteMany },
    printJob: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: printJobId, jobManifest: { documents: [{ documentId: fileId, sha256: "a" }] } }
        ]),
      updateMany: printJobUpdateMany
    },
    printSettingRevision: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: settingsId,
          selections: [
            {
              fileId,
              position: 0,
              pageCount: 1,
              contentSha256: "b".repeat(64),
              pageRanges: [[1, 1]],
              selectedPages: 1
            }
          ]
        }
      ]),
      updateMany: settingsUpdateMany
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join(" ") : "";

      // A pass now issues three statements against `cleanup_runs`, so this
      // matches on what each one is *for* rather than on the table it names.
      // Answering "here is a claimed run" to all three is how a stub quietly
      // makes a runner look like it did work nobody asked it to do.
      if (sql.includes("cleanup_retry_requests")) {
        return Promise.resolve(
          options.retryRequested ? [{ id: runId, session_id: sessionId }] : []
        );
      }
      if (sql.includes("print_job_recovery_resolutions")) {
        return Promise.resolve(options.recoveryResolved ? [{ id: sessionId }] : []);
      }
      if (sql.includes("cleanup_runs")) {
        return Promise.resolve(
          options.claimable === false
            ? []
            : [
                {
                  id: runId,
                  session_id: sessionId,
                  checkpoint: options.checkpoint ?? "SCHEDULED",
                  attempts: options.attempts ?? 0
                }
              ]
        );
      }
      return Promise.resolve([{ id: sessionId }]);
    }),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(client))
  };

  return {
    client: client as unknown as PrismaClient,
    cleanupRunUpdateMany,
    sessionUpdate,
    sessionUpdateMany,
    auditCreate,
    outboxCreate,
    fileUpdateMany,
    grantDeleteMany,
    commandDeleteMany,
    printJobUpdateMany,
    settingsUpdateMany,
    pageDeleteMany,
    derivativeDeleteMany
  };
}

type StoreMocks = { [K in keyof RetentionStore]: Mock<RetentionStore[K]> };

function stubStore(overrides: Partial<StoreMocks> = {}): StoreMocks {
  return {
    deleteObjects: vi.fn<RetentionStore["deleteObjects"]>().mockResolvedValue(2),
    purgePrefix: vi.fn<RetentionStore["purgePrefix"]>().mockResolvedValue(0),
    abortMultipartUploads: vi.fn<RetentionStore["abortMultipartUploads"]>().mockResolvedValue(0),
    listObjectsOlderThan: vi
      .fn<RetentionStore["listObjectsOlderThan"]>()
      .mockResolvedValue({ objects: [], acknowledge: vi.fn() }),
    ...overrides
  };
}

function createRunner(
  database: PrismaClient,
  store: StoreMocks,
  logger: CleanupLogger = silentLogger,
  maximumAttempts = 5
) {
  return new SessionCleanupRunner({
    database,
    store,
    logger,
    leaseMilliseconds: 120_000,
    maximumAttempts,
    now: () => now,
    newId: () => "01900000-0000-7000-8000-0000000000ff",
    jitter: () => 0.5,
    batchSize: 1
  });
}

function stubTransactionClient(database: ReturnType<typeof stubDatabase>) {
  const client = database.client as unknown as Record<string, Record<string, unknown>>;
  client.auditEvent = { create: database.auditCreate };
  client.outboxEvent = { create: database.outboxCreate };
}

describe("SessionCleanupRunner", () => {
  it("deletes the bytes before it retires the rows that name them", async () => {
    const database = stubDatabase();
    stubTransactionClient(database);
    const store = stubStore();
    const order: string[] = [];
    store.deleteObjects.mockImplementation(() => {
      order.push("objects");
      return Promise.resolve(2);
    });
    database.derivativeDeleteMany.mockImplementation(() => {
      order.push("rows");
      return Promise.resolve({ count: 2 });
    });

    await createRunner(database.client, store).runOnce();

    expect(order).toEqual(["objects", "rows"]);
    expect(store.deleteObjects).toHaveBeenCalledWith([
      `quarantine/v1/${sessionId}/f/k`,
      `previews/v1/${sessionId}/f/r1/g1/page-1.webp`
    ]);
  });

  it("sweeps every storage root and aborts multipart uploads before purging", async () => {
    const database = stubDatabase();
    stubTransactionClient(database);
    const store = stubStore();

    await createRunner(database.client, store).runOnce();

    // One scan matched against every prefix of the session, not one scan each.
    expect(store.abortMultipartUploads).toHaveBeenCalledTimes(1);
    expect(store.abortMultipartUploads.mock.calls[0]?.[0]).toEqual([
      `quarantine/v1/${sessionId}/`,
      `normalized/v1/${sessionId}/`,
      `previews/v1/${sessionId}/`
    ]);
    expect(store.purgePrefix.mock.calls.map((call) => call[0])).toEqual([
      `quarantine/v1/${sessionId}/`,
      `normalized/v1/${sessionId}/`,
      `previews/v1/${sessionId}/`
    ]);
  });

  it("records the tombstone and says so once, durably", async () => {
    const database = stubDatabase();
    stubTransactionClient(database);

    await createRunner(database.client, stubStore()).runOnce();

    const tombstone = database.sessionUpdate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(tombstone.data).toMatchObject({ cleanupStatus: "DONE", filesDeletedAt: now });
    const event = database.outboxCreate.mock.calls[0]?.[0] as {
      data: { type: string; payload: Record<string, unknown> };
    };
    expect(event.data.type).toBe("cleanup.completed");
    expect(Object.keys(event.data.payload).sort()).toEqual(["filesDeletedAt", "sessionId"]);
  });

  it("redacts the print manifest to a count and keeps the job", async () => {
    const database = stubDatabase();
    stubTransactionClient(database);

    await createRunner(database.client, stubStore()).runOnce();

    const redaction = database.printJobUpdateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(redaction.data).toMatchObject({
      jobManifest: { redacted: true, documentCount: 1 },
      manifestRedactedAt: now
    });
    const settingsRedaction = database.settingsUpdateMany.mock.calls[0]?.[0] as {
      data: { selections: Array<Record<string, unknown>>; selectionsRedactedAt: Date };
    };
    expect(settingsRedaction.data.selectionsRedactedAt).toEqual(now);
    expect(settingsRedaction.data.selections[0]).toMatchObject({
      fileId,
      position: 0,
      pageCount: 1,
      pageRanges: [[1, 1]],
      selectedPages: 1
    });
    expect(settingsRedaction.data.selections[0]).not.toHaveProperty("contentSha256");
    expect(database.commandDeleteMany).toHaveBeenCalled();
    expect(database.grantDeleteMany).toHaveBeenCalled();
  });

  it("waits for a validation barrier instead of deleting underneath a worker", async () => {
    const barrierAt = new Date(now.getTime() + 35_000);
    const database = stubDatabase({ barrierAt });
    stubTransactionClient(database);
    const store = stubStore();

    await createRunner(database.client, store).runOnce();

    expect(store.deleteObjects).not.toHaveBeenCalled();
    const deferral = database.cleanupRunUpdateMany.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(deferral.data).toMatchObject({ status: "PENDING", availableAt: barrierAt });
    expect(database.sessionUpdate).toHaveBeenCalledWith({
      where: { id: sessionId },
      data: { cleanupStatus: "PENDING", updatedAt: now }
    });
    expect(
      database.sessionUpdate.mock.calls.some(
        ([call]) => "filesDeletedAt" in (call as { data: Record<string, unknown> }).data
      )
    ).toBe(false);
  });

  it("resumes from the checkpoint it reached rather than starting over", async () => {
    const database = stubDatabase({ checkpoint: "STORAGE_RECONCILED" });
    stubTransactionClient(database);
    const store = stubStore();

    await createRunner(database.client, store).runOnce();

    expect(store.deleteObjects).not.toHaveBeenCalled();
    expect(store.purgePrefix).not.toHaveBeenCalled();
    expect(database.grantDeleteMany).toHaveBeenCalled();
    expect(database.sessionUpdate).toHaveBeenCalled();
  });

  it("repeats safely: three identical passes end in one tombstone each time", async () => {
    const database = stubDatabase();
    stubTransactionClient(database);
    const store = stubStore();
    const runner = createRunner(database.client, store);

    await runner.runOnce();
    await runner.runOnce();
    await runner.runOnce();

    expect(database.sessionUpdate).toHaveBeenCalledTimes(3);
    expect(store.deleteObjects).toHaveBeenCalledTimes(3);
    expect(database.outboxCreate).toHaveBeenCalledTimes(3);
  });

  it("backs off after a failed attempt and keeps the documents scheduled", async () => {
    const database = stubDatabase();
    stubTransactionClient(database);
    const warnings: string[] = [];
    const logger: CleanupLogger = {
      info: () => undefined,
      warn: (_fields, message) => {
        warnings.push(message);
      },
      error: () => undefined
    };
    const store = stubStore({
      purgePrefix: vi.fn().mockRejectedValue(new Error("OBJECT_PREFIX_PURGE_EXHAUSTED"))
    });

    await createRunner(database.client, store, logger).runOnce();

    const release = database.cleanupRunUpdateMany.mock.calls.at(-1)?.[0] as {
      data: { status: string; attempts: number; lastErrorCode: string; availableAt: Date };
    };
    expect(release.data.status).toBe("PENDING");
    expect(release.data.attempts).toBe(1);
    expect(release.data.lastErrorCode).toBe("OBJECT_PREFIX_PURGE_EXHAUSTED");
    expect(release.data.availableAt.getTime()).toBeGreaterThan(now.getTime());
    expect(database.sessionUpdate).toHaveBeenCalledWith({
      where: { id: sessionId },
      data: { cleanupStatus: "PENDING", updatedAt: now }
    });
    expect(
      database.sessionUpdate.mock.calls.some(
        ([call]) => "filesDeletedAt" in (call as { data: Record<string, unknown> }).data
      )
    ).toBe(false);
    expect(warnings).toContain("session cleanup attempt failed");
  });

  it("does not let a stale lease owner change the session mirror while deferring", async () => {
    const barrierAt = new Date(now.getTime() + 35_000);
    const database = stubDatabase({ barrierAt });
    stubTransactionClient(database);
    // The first checkpoint lands, then the lease belongs to somebody else
    // before this owner tries to hand the run back.
    database.cleanupRunUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await createRunner(database.client, stubStore()).runOnce();

    expect(database.sessionUpdate).not.toHaveBeenCalled();
  });

  it("dead-letters loudly once the attempt budget is spent", async () => {
    const database = stubDatabase({ attempts: 4 });
    stubTransactionClient(database);
    const errors: string[] = [];
    const logger: CleanupLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: (_fields, message) => {
        errors.push(message);
      }
    };
    const store = stubStore({
      deleteObjects: vi.fn().mockRejectedValue(new Error("OBJECT_BATCH_DELETE_FAILED"))
    });

    await createRunner(database.client, store, logger, 5).runOnce();

    const release = database.cleanupRunUpdateMany.mock.calls.at(-1)?.[0] as {
      data: { status: string; deadLetteredAt?: Date };
    };
    expect(release.data.status).toBe("DEAD_LETTER");
    expect(release.data.deadLetteredAt).toEqual(now);
    expect(errors).toContain("session cleanup dead-lettered with documents remaining");
  });

  it("never puts an object key or a message into a log line", async () => {
    const database = stubDatabase();
    stubTransactionClient(database);
    const fields: Record<string, unknown>[] = [];
    const logger: CleanupLogger = {
      info: () => undefined,
      warn: (entry) => {
        fields.push(entry);
      },
      error: () => undefined
    };
    const store = stubStore({
      purgePrefix: vi
        .fn()
        .mockRejectedValue(new Error(`failed deleting quarantine/v1/${sessionId}/f/k`))
    });

    await createRunner(database.client, store, logger).runOnce();

    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("quarantine/v1/");
    expect(serialized).toContain("UNKNOWN_ERROR");
  });

  it("refuses a ledger key that belongs to another session", async () => {
    const database = stubDatabase({ outOfScopeArtifact: true });
    stubTransactionClient(database);
    const store = stubStore();

    await createRunner(database.client, store).runOnce();

    expect(store.deleteObjects).not.toHaveBeenCalled();
    const release = database.cleanupRunUpdateMany.mock.calls.at(-1)?.[0] as {
      data: { lastErrorCode: string; status: string };
    };
    expect(release.data).toMatchObject({
      lastErrorCode: "CLEANUP_OBJECT_KEY_OUT_OF_SCOPE",
      status: "PENDING"
    });
  });

  it("stops when it loses its lease rather than writing a second tombstone", async () => {
    const database = stubDatabase({ cleanupRunUpdateCount: 0 });
    stubTransactionClient(database);
    const info = vi.fn<CleanupLogger["info"]>();

    await createRunner(database.client, stubStore(), { ...silentLogger, info }).runOnce();

    expect(database.sessionUpdate).not.toHaveBeenCalled();
    expect(database.outboxCreate).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("re-arms a dead-lettered run a person asked to retry, and says so", async () => {
    const database = stubDatabase({ retryRequested: true, claimable: false });
    stubTransactionClient(database);
    const info = vi.fn<CleanupLogger["info"]>();

    await createRunner(database.client, stubStore(), { ...silentLogger, info }).runOnce();

    // The request came from a connection holding no privilege on `cleanup_runs`
    // at all. This is the other half of that: the worker re-arms its own run.
    const rearm = (database.client.$queryRaw as Mock).mock.calls
      .map((call) => (call[0] as TemplateStringsArray).join(" "))
      .find((sql: string) => sql.includes("cleanup_retry_requests"));
    expect(rearm).toContain(`"status" = 'PENDING'`);
    expect(rearm).toContain(`"attempts" = 0`);
    expect(rearm).toContain(`"c"."status" = 'DEAD_LETTER'`);

    // The operator-facing mirror moves with the run, or the dashboard keeps
    // telling somebody to act on something already in hand.
    expect(database.sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: sessionId, cleanupStatus: "DEAD_LETTER" },
      data: { cleanupStatus: "PENDING", updatedAt: now }
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupRunId: runId }),
      "cleanup run re-armed at an operator's request"
    );
  });

  it("leaves a dead-lettered run alone when nobody has asked for it", async () => {
    const database = stubDatabase({ claimable: false });
    stubTransactionClient(database);

    await createRunner(database.client, stubStore()).runOnce();

    const mirrored = database.sessionUpdateMany.mock.calls.map(
      ([call]) => (call as { where: { cleanupStatus?: string } }).where.cleanupStatus
    );
    expect(mirrored).not.toContain("DEAD_LETTER");
  });

  it("lets a session out of its recovery grace once somebody has answered it", async () => {
    const database = stubDatabase({ recoveryResolved: true, claimable: false });
    stubTransactionClient(database);

    await createRunner(database.client, stubStore()).runOnce();

    const shorten = (database.client.$queryRaw as Mock).mock.calls
      .map((call) => (call[0] as TemplateStringsArray).join(" "))
      .find((sql: string) => sql.includes("print_job_recovery_resolutions"));

    // Retention learns from the observation itself. No signal table, no grant,
    // and nothing the control plane writes to make this happen.
    expect(shorten).toContain(`"s"."state" = 'RECOVERY_REQUIRED'`);
    // Only ever shorter. A resolution must never push a deletion deadline out.
    expect(shorten).toContain(`"s"."cleanup_due_at" > "answered"."due_at"`);

    const followUps = (database.client.$executeRaw as Mock).mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(" ")
    );
    const files = followUps.find((sql: string) => sql.includes("uploaded_files"));

    // A file still being written keeps its own barrier: that one protects a PUT
    // this system has already authorized, and pulling it forward could let a
    // sweep run underneath one.
    expect(files).toContain("'QUARANTINED', 'READY', 'DELETE_PENDING', 'DELETING'");
    expect(files).not.toContain("UPLOADING");
    expect(files).not.toContain("VALIDATING");
  });

  it("does not touch a session's deadline when nobody has recorded anything", async () => {
    const database = stubDatabase({ claimable: false });
    stubTransactionClient(database);

    await createRunner(database.client, stubStore()).runOnce();

    const followUps = (database.client.$executeRaw as Mock).mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(" ")
    );
    expect(followUps.some((sql: string) => sql.includes("uploaded_files"))).toBe(false);
  });

  it("does nothing when no run is due", async () => {
    const database = stubDatabase({ claimable: false });
    stubTransactionClient(database);
    const store = stubStore();

    await expect(createRunner(database.client, store).runOnce()).resolves.toBe(0);
    expect(store.deleteObjects).not.toHaveBeenCalled();
  });
});
