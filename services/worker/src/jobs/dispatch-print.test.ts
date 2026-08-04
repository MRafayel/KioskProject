import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@printing-kiosk/database";

import { PrintDispatcher, type PrintDispatcherOptions } from "./dispatch-print.js";

const printJobId = "01900000-0000-7000-8000-000000000cc1";
const sessionId = "01900000-0000-7000-8000-000000000cc2";
const paymentId = "01900000-0000-7000-8000-000000000cc3";
const commandId = "01900000-0000-7000-8000-000000000cc4";
const operationId = "01900000-0000-7000-8000-000000000cc5";
const claimToken = "01900000-0000-7000-8000-000000000cc6";
const now = new Date("2030-01-01T00:05:00.000Z");
const past = new Date("2030-01-01T00:00:00.000Z");

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface StubOptions {
  jobStatus?: string;
  deadlineAt?: Date;
  command?: Record<string, unknown> | null;
  existingCommand?: boolean;
  commandAttempts?: number;
  leaseExpiresAt?: Date | null;
  commandStatus?: string;
  settleCount?: number;
}

function stubDatabase(options: StubOptions = {}) {
  const printJob = {
    id: printJobId,
    sessionId,
    kioskId: "kiosk_dev_001",
    paymentId,
    status: options.jobStatus ?? "QUEUED",
    jobManifest: { manifestVersion: 1 },
    jobManifestHash: "a".repeat(64),
    simulatedOutcome: null,
    deadlineAt: options.deadlineAt ?? new Date("2030-01-01T00:10:00.000Z"),
    dispatchAttempts: 0
  };
  const command =
    options.command === null
      ? null
      : {
          id: commandId,
          printJobId,
          sessionId,
          operationId,
          claimToken,
          status: options.commandStatus ?? "CLAIMED",
          attempts: options.commandAttempts ?? 1,
          leaseExpiresAt: options.leaseExpiresAt ?? past,
          expiresAt: new Date("2030-01-01T00:10:00.000Z"),
          ...options.command
        };

  const printJobFindUnique = vi.fn().mockResolvedValue(printJob);
  const printJobUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const commandCreate = vi.fn().mockResolvedValue({});
  const commandUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const ledgerCreate = vi.fn().mockResolvedValue({});
  const refundUpsert = vi.fn().mockResolvedValue({ id: "refund" });
  const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const outboxCreate = vi.fn().mockResolvedValue({});

  const client = {
    printJob: {
      findMany: vi.fn().mockResolvedValue([{ id: printJobId, dispatchAttempts: 0 }]),
      findUnique: printJobFindUnique,
      updateMany: printJobUpdateMany
    },
    printJobEvent: { findFirst: vi.fn().mockResolvedValue(null), create: ledgerCreate },
    agentCommand: {
      findMany: vi.fn().mockResolvedValue(command ? [{ id: commandId }] : []),
      // The dispatcher looks a command up by print job when issuing one or
      // settling a deadline, and by id when releasing a lease.
      findUnique: vi.fn((query: { where: { printJobId?: string } }) =>
        Promise.resolve(
          query.where.printJobId !== undefined && !options.existingCommand ? null : command
        )
      ),
      create: commandCreate,
      updateMany: commandUpdateMany
    },
    payment: {
      findFirst: vi.fn().mockResolvedValue({
        id: paymentId,
        provider: "MOCK",
        amountMinor: 18_000,
        currency: "AMD",
        currencyExponent: 2
      })
    },
    refund: { upsert: refundUpsert },
    printSession: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: sessionId, state: "PRINTING", stateVersion: 6, eventSequence: 9 }),
      updateMany: sessionUpdateMany
    },
    sessionUploadGrant: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    mobileClient: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    uploadedFile: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    outboxEvent: { create: outboxCreate },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: sessionId }])
  };

  const database = {
    ...client,
    $transaction: (run: (transaction: unknown) => unknown) => Promise.resolve(run(client))
  } as unknown as PrismaClient;

  return {
    database,
    printJob,
    printJobFindUnique,
    printJobUpdateMany,
    commandCreate,
    commandUpdateMany,
    ledgerCreate,
    refundUpsert,
    sessionUpdateMany,
    outboxCreate
  };
}

function buildDispatcher(
  database: PrismaClient,
  overrides: Partial<PrintDispatcherOptions> = {}
): PrintDispatcher {
  let counter = 0;
  const dispatcher = new PrintDispatcher({
    database,
    redisUrl: "redis://localhost:6379",
    logger: silentLogger,
    leaseMilliseconds: 120_000,
    maxCommandAttempts: 2,
    maxDispatchAttempts: 5,
    now: () => now,
    newId: () => `01900000-0000-7000-8000-${String(counter++).padStart(12, "0")}`,
    ...overrides
  });
  return dispatcher;
}

/** Reach the queue handler without a live Redis connection. */
function issue(dispatcher: PrintDispatcher, attempt = 1): Promise<void> {
  const handler = Reflect.get(dispatcher, "issueCommand") as (job: {
    data: { printJobId: string; attempt: number };
  }) => Promise<void>;
  return handler.call(dispatcher, { data: { printJobId, attempt } });
}

interface WriteCall {
  data: Record<string, unknown>;
}

/** The `data` of every write a stub recorded, so assertions stay typed. */
function writes(mock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return mock.mock.calls.map((call) => (call[0] as WriteCall | undefined)?.data ?? {});
}

function wrote(mock: { mock: { calls: unknown[][] } }, expected: Record<string, unknown>): boolean {
  return writes(mock).some((data) =>
    Object.entries(expected).every(([key, value]) => data[key] === value)
  );
}

describe("PrintDispatcher", () => {
  it("issues exactly one command for a queued job", async () => {
    const stub = stubDatabase();
    const dispatcher = buildDispatcher(stub.database);

    await issue(dispatcher);

    expect(stub.commandCreate).toHaveBeenCalledTimes(1);
    expect(writes(stub.commandCreate)[0]).toMatchObject({
      type: "PRINT",
      status: "PENDING",
      printJobId,
      sessionId
    });
    expect(wrote(stub.printJobUpdateMany, { status: "DISPATCHED" })).toBe(true);
    await dispatcher.close().catch(() => undefined);
  });

  it("does nothing for a duplicate queue delivery", async () => {
    // The queue is a wake-up, not a guarantee. The job row has already moved.
    const stub = stubDatabase({ jobStatus: "DISPATCHED" });
    const dispatcher = buildDispatcher(stub.database);

    await issue(dispatcher, 2);

    expect(stub.commandCreate).not.toHaveBeenCalled();
    expect(stub.printJobUpdateMany).not.toHaveBeenCalled();
    await dispatcher.close().catch(() => undefined);
  });

  it("does not issue a command when cancellation wins while the handler waits for the lock", async () => {
    const stub = stubDatabase();
    stub.printJobFindUnique
      .mockResolvedValueOnce(stub.printJob)
      .mockResolvedValueOnce({ ...stub.printJob, status: "CANCELED" });
    const dispatcher = buildDispatcher(stub.database);

    await issue(dispatcher);

    expect(stub.commandCreate).not.toHaveBeenCalled();
    expect(stub.printJobUpdateMany).not.toHaveBeenCalled();
    await dispatcher.close().catch(() => undefined);
  });

  it("reuses the existing command rather than opening a second operation", async () => {
    const stub = stubDatabase({ existingCommand: true });
    const dispatcher = buildDispatcher(stub.database);

    await issue(dispatcher);

    expect(stub.commandCreate).not.toHaveBeenCalled();
    await dispatcher.close().catch(() => undefined);
  });

  it("offers an expired lease again while redeliveries remain", async () => {
    const stub = stubDatabase({ commandAttempts: 1 });
    const dispatcher = buildDispatcher(stub.database);

    const settled = await dispatcher.reconcileOnce();

    expect(settled).toBeGreaterThan(0);
    expect(wrote(stub.commandUpdateMany, { status: "PENDING", claimToken: null })).toBe(true);
    // The job is not settled: the operation may still be printed.
    expect(stub.refundUpsert).not.toHaveBeenCalled();
    await dispatcher.close().catch(() => undefined);
  });

  it("escalates an exhausted lease to operator recovery without a refund", async () => {
    // The agent held the work and never came back, and it may not be handed
    // out again. Whether paper emerged is now unknowable from here.
    const stub = stubDatabase({ commandAttempts: 2, jobStatus: "PRINTING" });
    const dispatcher = buildDispatcher(stub.database);

    await dispatcher.reconcileOnce();

    expect(
      wrote(stub.printJobUpdateMany, {
        status: "RECOVERY_REQUIRED",
        resultConfidence: "UNCONFIRMED"
      })
    ).toBe(true);
    expect(stub.refundUpsert).not.toHaveBeenCalled();
    expect(wrote(stub.outboxCreate, { type: "print.recovery_required" })).toBe(true);
    await dispatcher.close().catch(() => undefined);
  });

  it("refunds an exhausted lease when submission was never acknowledged", async () => {
    const stub = stubDatabase({ commandAttempts: 2, jobStatus: "DISPATCHED" });
    const dispatcher = buildDispatcher(stub.database);

    await dispatcher.reconcileOnce();

    expect(
      wrote(stub.printJobUpdateMany, { status: "FAILED", resultConfidence: "CONFIRMED" })
    ).toBe(true);
    expect(stub.refundUpsert).toHaveBeenCalledTimes(1);
    expect(wrote(stub.outboxCreate, { type: "print.failed" })).toBe(true);
    await dispatcher.close().catch(() => undefined);
  });

  it("fails a job whose command was never claimed and records the money owed back", async () => {
    const stub = stubDatabase({
      deadlineAt: past,
      existingCommand: true,
      commandAttempts: 0,
      commandStatus: "PENDING",
      leaseExpiresAt: null
    });
    const dispatcher = buildDispatcher(stub.database);

    await dispatcher.reconcileOnce();

    expect(
      wrote(stub.printJobUpdateMany, { status: "FAILED", resultConfidence: "CONFIRMED" })
    ).toBe(true);
    const refund = stub.refundUpsert.mock.calls[0]?.[0] as
      { create: Record<string, unknown> } | undefined;
    expect(refund?.create).toMatchObject({ reason: "PRINT_FAILED", amountMinor: 18_000 });
    await dispatcher.close().catch(() => undefined);
  });

  it("never calls an overdue job that reached a device a failure", async () => {
    const stub = stubDatabase({
      jobStatus: "PRINTING",
      deadlineAt: past,
      existingCommand: true,
      commandAttempts: 1,
      commandStatus: "CLAIMED",
      leaseExpiresAt: new Date("2030-01-01T00:09:00.000Z")
    });
    const dispatcher = buildDispatcher(stub.database);

    await dispatcher.reconcileOnce();

    expect(wrote(stub.printJobUpdateMany, { status: "RECOVERY_REQUIRED" })).toBe(true);
    expect(stub.refundUpsert).not.toHaveBeenCalled();
    await dispatcher.close().catch(() => undefined);
  });

  it("leaves a settled job alone when a second sweep reaches it", async () => {
    const stub = stubDatabase({ jobStatus: "COMPLETED", deadlineAt: past, command: null });
    const dispatcher = buildDispatcher(stub.database);

    const settled = await dispatcher.reconcileOnce();

    expect(settled).toBe(0);
    expect(stub.printJobUpdateMany).not.toHaveBeenCalled();
    await dispatcher.close().catch(() => undefined);
  });
});
