import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@printing-kiosk/database";
import type { PaymentIntentStatus, PaymentProvider } from "@printing-kiosk/payment-adapters";

import { PaymentReconciler } from "./reconcile-payments.js";

const sessionId = "01900000-0000-7000-8000-000000000010";
const paymentId = "01900000-0000-7000-8000-0000000000bb";
const providerIntentId = `mock_pi_${paymentId}`;
const past = new Date("2030-01-01T00:00:00.000Z");
const now = new Date("2030-01-01T00:05:00.000Z");

interface StubOptions {
  paymentStatus?: string;
  sessionState?: string;
  settleCount?: number;
  reconcileAttemptExists?: boolean;
}

function stubDatabase(options: StubOptions = {}) {
  const payment = {
    id: paymentId,
    sessionId,
    providerIntentId,
    status: options.paymentStatus ?? "PENDING",
    expiresAt: past
  };
  const session = {
    id: sessionId,
    state: options.sessionState ?? "AWAITING_PAYMENT",
    stateVersion: 4,
    eventSequence: 7
  };

  const paymentUpdateMany = vi.fn().mockResolvedValue({ count: options.settleCount ?? 1 });
  const sessionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const attemptCreate = vi.fn().mockResolvedValue({});
  const outboxCreate = vi.fn().mockResolvedValue({});
  const auditCreate = vi.fn().mockResolvedValue({});

  const client = {
    payment: {
      findMany: vi.fn().mockResolvedValue([{ id: paymentId, providerIntentId }]),
      findUnique: vi.fn().mockResolvedValue(payment),
      updateMany: paymentUpdateMany
    },
    paymentAttempt: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.reconcileAttemptExists ? { id: "existing" } : null),
      create: attemptCreate
    },
    printSession: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(session),
      updateMany: sessionUpdateMany
    },
    outboxEvent: { create: outboxCreate },
    auditEvent: { create: auditCreate },
    $queryRaw: vi.fn().mockResolvedValue([{ id: sessionId }])
  };
  const database = {
    ...client,
    $transaction: (run: (transaction: unknown) => unknown) => Promise.resolve(run(client))
  } as unknown as PrismaClient;

  return {
    database,
    paymentUpdateMany,
    sessionUpdateMany,
    attemptCreate,
    outboxCreate,
    auditCreate
  };
}

function stubProvider(status: PaymentIntentStatus | "UNKNOWN"): PaymentProvider {
  return {
    name: "MOCK",
    createIntent: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    refund: vi.fn(),
    getIntentStatus: vi.fn().mockResolvedValue(status),
    verifyAndParseWebhook: vi.fn()
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn() };

/** The arguments a Prisma stub was last called with, as plain data. */
function lastCall(mock: ReturnType<typeof vi.fn>): unknown {
  return mock.mock.lastCall?.[0];
}

function createReconciler(database: PrismaClient, provider: PaymentProvider) {
  return new PaymentReconciler({
    database,
    provider,
    logger: silentLogger,
    now: () => now,
    newId: () => "01900000-0000-7000-8000-0000000000c1"
  });
}

describe("PaymentReconciler", () => {
  it("times out an overdue payment and releases the session back to configuring", async () => {
    const stub = stubDatabase();
    const settled = await createReconciler(stub.database, stubProvider("UNKNOWN")).runOnce();

    expect(settled).toBe(1);
    expect(lastCall(stub.paymentUpdateMany)).toMatchObject({
      where: { id: paymentId, status: "PENDING" },
      data: { status: "TIMED_OUT", failureCode: "PROVIDER_TIMEOUT" }
    });
    expect(lastCall(stub.sessionUpdateMany)).toMatchObject({
      where: { id: sessionId, stateVersion: 4 },
      data: { state: "CONFIGURING", stateVersion: 5, eventSequence: 8 }
    });
    expect(lastCall(stub.outboxCreate)).toMatchObject({
      data: {
        type: "payment.failed",
        sequence: 8,
        payload: {
          sessionId,
          paymentId,
          state: "CONFIGURING",
          version: 5,
          status: "TIMED_OUT",
          failureCode: "PROVIDER_TIMEOUT"
        }
      }
    });
  });

  it("never invents a settlement for an intent the provider still reports as live", async () => {
    const stub = stubDatabase();
    const settled = await createReconciler(stub.database, stubProvider("AUTHORIZED")).runOnce();

    expect(settled).toBe(0);
    expect(stub.paymentUpdateMany).not.toHaveBeenCalled();
    expect(stub.sessionUpdateMany).not.toHaveBeenCalled();
    // The state is recorded once so an operator can see it, not on every pass.
    expect(stub.attemptCreate).toHaveBeenCalledTimes(1);
  });

  it("records a live intent only once, however many passes it survives", async () => {
    const stub = stubDatabase({ reconcileAttemptExists: true });
    await createReconciler(stub.database, stubProvider("CAPTURED")).runOnce();

    expect(stub.attemptCreate).not.toHaveBeenCalled();
  });

  it("stands down when a capture won the row between the read and the write", async () => {
    const stub = stubDatabase({ settleCount: 0 });
    const settled = await createReconciler(stub.database, stubProvider("UNKNOWN")).runOnce();

    expect(settled).toBe(0);
    // The capture is authoritative, so nothing about the session is rewritten.
    expect(stub.sessionUpdateMany).not.toHaveBeenCalled();
    expect(stub.outboxCreate).not.toHaveBeenCalled();
  });

  it("leaves a session that already moved on untouched", async () => {
    const stub = stubDatabase({ sessionState: "CANCELED" });
    const settled = await createReconciler(stub.database, stubProvider("UNKNOWN")).runOnce();

    expect(settled).toBe(1);
    expect(stub.paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(stub.sessionUpdateMany).not.toHaveBeenCalled();
    expect(stub.outboxCreate).not.toHaveBeenCalled();
  });
});
