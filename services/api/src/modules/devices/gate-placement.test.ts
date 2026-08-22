import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@printing-kiosk/database";

import { PaymentService } from "../payments/service.js";
import { ApiError } from "../sessions/errors.js";
import type { PrinterReadinessGate } from "./readiness.js";

/**
 * Where the gate is allowed to be, and where it must never be.
 *
 * A gate in the wrong place is worse than no gate. Too early and a customer
 * retrying a request they already made gets refused for a printer that broke in
 * between; too late and it refuses a job somebody has already paid for, which
 * strands their money in a state only an operator can resolve.
 *
 * So the rule has two halves, and both are tested here: it runs on genuinely
 * new work, and it never runs on a replay or after a payment exists.
 */

const NOW = new Date("2026-08-22T10:00:00.000Z");
const KIOSK_ID = "kiosk_dev_001";
const SESSION_ID = "01900000-0000-7000-8000-000000000001";
const QUOTE_ID = "01900000-0000-7000-8000-000000000002";

describe("the gate runs on new work", () => {
  it("refuses a payment when the printer has gone down since the session started", async () => {
    // The race the gate exists to close. A customer passes the welcome screen
    // on a healthy printer, spends four minutes uploading and choosing, and by
    // checkout the tray is empty. This is the last moment refusing is free.
    const gate = blockingGate();
    const payments = buildPaymentService(freshDatabase(), gate);

    const error = await payments
      .create(paymentInput())
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "PRINTER_UNAVAILABLE" });
    expect(gate.assertReady).toHaveBeenCalledOnce();
  });

  it("checks the printer only after confirming the session may be paid at all", async () => {
    // A session in the wrong state is refused for that reason, not for the
    // printer — otherwise an expired session on a broken printer would send
    // staff to look at the paper tray.
    const gate = blockingGate();
    const database = freshDatabase({ session: { state: "COMPLETED" } });
    const payments = buildPaymentService(database, gate);

    const error = await payments
      .create(paymentInput())
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect((error as ApiError).code).not.toBe("PRINTER_UNAVAILABLE");
    expect(gate.assertReady).not.toHaveBeenCalled();
  });
});

describe("the gate never runs on work that already exists", () => {
  it("returns an existing payment rather than refusing it", async () => {
    // The customer's card is already committed against this payment. Refusing
    // the retry would leave them holding a charge with no print and no path
    // forward, which is strictly worse than letting the print fail into
    // recovery — where a refund is owed and an operator is told.
    const gate = blockingGate();
    const payments = buildPaymentService(replayDatabase(), gate);

    const response = await payments.create(paymentInput());

    expect(response.payment.id).toBe("01900000-0000-7000-8000-00000000000f");
    expect(gate.assertReady).not.toHaveBeenCalled();
  });
});

/**
 * The print path takes no gate at all, and that is the point.
 *
 * By the time a print job is created the customer has paid. A printer that
 * fails between payment and submission must settle through the existing
 * confirmation rules — `UNCONFIRMED`, then `RECOVERY_REQUIRED` with a refund
 * owed — and never through a refusal here. Refusing would drop a paid job on
 * the floor with no record that anything was owed.
 */
describe("nothing gates a job that has been paid for", () => {
  it("offers no way to wire a readiness gate into print job creation", async () => {
    const { PrintJobService } = await import("../print-jobs/service.js");
    const accepted = Object.keys(
      buildOptions(PrintJobService as unknown as new (options: object) => unknown)
    );
    expect(accepted).not.toContain("printerReadiness");
  });
});

function blockingGate() {
  return {
    assertReady: vi.fn().mockRejectedValue(
      new ApiError(409, "PRINTER_UNAVAILABLE", "unavailable", { reason: "PRINTER_OUT_OF_PAPER" })
    ),
    read: vi.fn()
  } as unknown as PrinterReadinessGate & { assertReady: ReturnType<typeof vi.fn> };
}

function buildPaymentService(database: PrismaClient, printerReadiness: PrinterReadinessGate) {
  return new PaymentService({
    database,
    clock: { now: () => NOW },
    random: { uuid: () => SESSION_ID, token: () => "token", integer: () => 0 },
    provider: {
      name: "mock",
      createPayment: () =>
        Promise.resolve({
          providerReference: "ref",
          status: "REQUIRES_ACTION" as const,
          clientSecret: null
        })
    } as unknown as ConstructorParameters<typeof PaymentService>[0]["provider"],
    idempotencyPepper: "pepper",
    idempotencyTtlHours: 24,
    paymentTimeoutSeconds: 180,
    printerReadiness
  });
}

function paymentInput() {
  return {
    kioskId: KIOSK_ID,
    credentialId: "credential",
    sessionId: SESSION_ID,
    quoteId: QUOTE_ID,
    idempotencyKey: "idem-1",
    requestId: "request-1"
  };
}

/** A session that is payable and has no payment yet. */
function freshDatabase(overrides: { session?: { state: string } } = {}): PrismaClient {
  return database({
    idempotencyRecord: null,
    session: {
      id: SESSION_ID,
      kioskId: KIOSK_ID,
      state: overrides.session?.state ?? "CONFIGURING",
      stateVersion: 3,
      eventSequence: 3,
      activeQuoteId: QUOTE_ID,
      currentSettingsRevision: 2,
      idleExpiresAt: new Date(NOW.getTime() + 600_000),
      hardExpiresAt: new Date(NOW.getTime() + 3_600_000)
    }
  });
}

/** The same session, where this exact request has already been made once. */
function replayDatabase(): PrismaClient {
  const fresh = freshDatabase();
  return database({
    idempotencyRecord: {
      actorId: KIOSK_ID,
      action: `payments.create:${SESSION_ID}`,
      resourceId: "01900000-0000-7000-8000-00000000000f",
      // The service refuses a key reused for a *different* request, so the
      // stored hash has to be the one this request produces. Computed the same
      // way the service does rather than pasted in, so a change to either side
      // shows up here as a failure instead of a silently skipped test.
      requestHash: requestHash(),
      expiresAt: new Date(NOW.getTime() + 3_600_000)
    },
    session: (fresh as unknown as { __session: Record<string, unknown> }).__session
  });
}

function requestHash(): string {
  const canonical = Object.entries({ provider: "mock", quoteId: QUOTE_ID, sessionId: SESSION_ID })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function database(state: {
  idempotencyRecord: Record<string, unknown> | null;
  session: Record<string, unknown>;
}): PrismaClient {
  const payment = {
    id: "01900000-0000-7000-8000-00000000000f",
    sessionId: SESSION_ID,
    kioskId: KIOSK_ID,
    status: "PENDING",
    provider: "MOCK",
    providerReference: "ref",
    amountMinor: 500,
    currency: "AMD",
    currencyExponent: 2,
    failureCode: null,
    appliedToSession: false,
    capturedAt: null,
    quoteId: QUOTE_ID,
    expiresAt: new Date(NOW.getTime() + 180_000),
    createdAt: NOW,
    updatedAt: NOW
  };

  const client = {
    __session: state.session,
    $transaction: (run: (transaction: unknown) => Promise<unknown>) => run(client),
    $queryRaw: () => Promise.resolve([{ id: SESSION_ID }]),
    idempotencyRecord: {
      findUnique: () => Promise.resolve(state.idempotencyRecord),
      deleteMany: () => Promise.resolve({ count: 0 }),
      create: () => Promise.resolve({})
    },
    printSession: {
      findFirstOrThrow: () => Promise.resolve(state.session),
      findFirst: () => Promise.resolve(state.session),
      update: () => Promise.resolve(state.session),
      updateMany: () => Promise.resolve({ count: 1 })
    },
    payment: {
      findFirst: () => Promise.resolve(state.idempotencyRecord ? payment : null),
      findUnique: () => Promise.resolve(payment),
      findUniqueOrThrow: () => Promise.resolve(payment),
      create: () => Promise.resolve(payment),
      updateMany: () => Promise.resolve({ count: 1 })
    },
    priceQuote: {
      findFirst: () =>
        Promise.resolve({
          id: QUOTE_ID,
          sessionId: SESSION_ID,
          status: "ACTIVE",
          settingsRevision: 2,
          totalMinor: 500,
          currency: "AMD"
        })
    },
    uploadedFile: { count: () => Promise.resolve(0) },
    sessionEvent: { create: () => Promise.resolve({}) },
    outboxEvent: { create: () => Promise.resolve({}) }
  };
  return client as unknown as PrismaClient;
}

/** Reads the option names a service constructor actually destructures. */
function buildOptions(constructor: new (options: object) => unknown): Record<string, unknown> {
  const seen: Record<string, unknown> = {};
  const probe = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property === "string") seen[property] = true;
        return undefined;
      }
    }
  );
  try {
    new constructor(probe);
  } catch {
    // Construction may fail once it reaches a value it needs; the names it
    // asked for on the way are what this is after.
  }
  return seen;
}
