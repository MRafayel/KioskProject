import type { RetentionPolicy } from "@printing-kiosk/domain";

import type { Prisma } from "./generated/prisma/client.js";
import { revokeSessionAccess, scheduleSessionFilesForCleanup } from "./session-cleanup.js";

/** Print job states that may still change. */
export const OPEN_PRINT_JOB_STATUSES = ["QUEUED", "DISPATCHED", "PRINTING"] as const;

export type PrintJobLedgerType =
  | "CREATED"
  | "DISPATCHED"
  | "CLAIMED"
  | "SUBMITTED"
  | "PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCEL_REQUESTED"
  | "CANCELED"
  | "RECOVERY_REQUIRED"
  | "LEASE_EXPIRED"
  | "DEADLINE_EXCEEDED";

/**
 * Ledger entries are numbered per job and never rewritten, so the next number
 * is read inside the same transaction that writes it.
 */
export async function nextPrintJobEventSequence(
  transaction: Prisma.TransactionClient,
  printJobId: string
): Promise<number> {
  const latest = await transaction.printJobEvent.findFirst({
    where: { printJobId },
    orderBy: { sequence: "desc" },
    select: { sequence: true }
  });
  return (latest?.sequence ?? 0) + 1;
}

/**
 * Append one entry to a job's operation ledger.
 *
 * The ledger is what makes an interrupted print readable afterwards: it records
 * that work was handed over before it records what came back, so a crash
 * between the two leaves evidence rather than silence.
 */
export async function recordPrintJobEvent(
  transaction: Prisma.TransactionClient,
  input: {
    id: string;
    printJobId: string;
    type: PrintJobLedgerType;
    status: string;
    now: Date;
    operationId?: string | null;
    confidence?: string | null;
    failureCode?: string | null;
    warningCode?: string | null;
    detail?: Prisma.InputJsonValue;
    /** The device's own account, in the bounded shape the agent contract validates. */
    deviceDetail?: Prisma.InputJsonValue;
  }
): Promise<number> {
  const sequence = await nextPrintJobEventSequence(transaction, input.printJobId);
  await transaction.printJobEvent.create({
    data: {
      id: input.id,
      printJobId: input.printJobId,
      sequence,
      type: input.type,
      status: input.status,
      operationId: input.operationId ?? null,
      confidence: input.confidence ?? null,
      failureCode: input.failureCode ?? null,
      warningCode: input.warningCode ?? null,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      ...(input.deviceDetail === undefined ? {} : { deviceDetail: input.deviceDetail }),
      createdAt: input.now
    }
  });
  return sequence;
}

/**
 * Record that a capture bought a print that never arrived.
 *
 * This is only ever called for a definite failure — a device that proved
 * nothing came out. An ambiguous result deliberately writes nothing here: the
 * customer may be holding their pages, and inventing a refund obligation would
 * be as wrong as ignoring a real one. One obligation per payment and reason, so
 * a repeated settlement cannot create a second refund.
 */
export async function recordPrintFailureCompensation(
  transaction: Prisma.TransactionClient,
  input: { paymentId: string; sessionId: string; newId: () => string; now: Date }
): Promise<string | null> {
  const payment = await transaction.payment.findFirst({
    where: {
      id: input.paymentId,
      sessionId: input.sessionId,
      status: "CAPTURED",
      appliedToSession: true
    },
    select: {
      id: true,
      provider: true,
      amountMinor: true,
      currency: true,
      currencyExponent: true
    }
  });
  // Nothing was captured, so nothing is owed. The refunds table represents
  // monetary obligations only.
  if (!payment || payment.amountMinor === 0) return null;

  const refund = await transaction.refund.upsert({
    where: { paymentId_reason: { paymentId: payment.id, reason: "PRINT_FAILED" } },
    create: {
      id: input.newId(),
      paymentId: payment.id,
      sessionId: input.sessionId,
      provider: payment.provider,
      reason: "PRINT_FAILED",
      amountMinor: payment.amountMinor,
      currency: payment.currency.trim(),
      currencyExponent: payment.currencyExponent,
      status: "PENDING",
      createdAt: input.now,
      updatedAt: input.now
    },
    update: {},
    select: { id: true }
  });
  return refund.id;
}

export interface ApplyPrintJobSettlementInput {
  printJobId: string;
  status: "COMPLETED" | "FAILED" | "CANCELED" | "RECOVERY_REQUIRED";
  resultConfidence: "CONFIRMED" | "UNCONFIRMED";
  failureCode: string | null;
  warningCode: string | null;
  sheetsProduced: number | null;
  sessionState: "COMPLETED" | "FAILED" | "RECOVERY_REQUIRED";
  refundObligation: boolean;
  operationId: string | null;
  ledgerType: PrintJobLedgerType;
  actorType: string;
  actorId: string;
  requestId?: string | undefined;
  now: Date;
  newId: () => string;
  /** Retention grace for the documents this outcome finishes with. */
  retentionPolicy: RetentionPolicy;
  /**
   * What the device reported seeing. Recorded on the ledger entry, never read
   * to decide anything: the settlement above is already final by the time this
   * is written, and a device that lied about its own diagnostics must not be
   * able to change an outcome or a refund by doing so.
   */
  deviceDiagnostics?: Prisma.InputJsonValue | undefined;
}

export interface PrintJobSettlementOutcome {
  applied: boolean;
  refundId: string | null;
  sessionState: string | null;
  sessionVersion: number | null;
}

/**
 * Write one settled print outcome: the job, the session, the events the kiosk
 * will see, the compensation if money bought nothing, and the ledger entry that
 * explains all of it.
 *
 * The caller must already hold the session row lock. Every write is guarded on
 * the state it read, so a device result and a deadline sweep that race each
 * other produce one settlement and one no-op rather than two.
 */
export async function applyPrintJobSettlement(
  transaction: Prisma.TransactionClient,
  input: ApplyPrintJobSettlementInput
): Promise<PrintJobSettlementOutcome> {
  const job = await transaction.printJob.findUnique({ where: { id: input.printJobId } });
  if (!job || !isOpenPrintJobStatus(job.status)) {
    return { applied: false, refundId: null, sessionState: null, sessionVersion: null };
  }

  const settled = await transaction.printJob.updateMany({
    where: { id: job.id, status: job.status },
    data: {
      status: input.status,
      resultConfidence: input.resultConfidence,
      failureCode: input.failureCode,
      warningCode: input.warningCode,
      sheetsProduced: input.sheetsProduced,
      updatedAt: input.now,
      ...(input.status === "COMPLETED" ? { completedAt: input.now } : { failedAt: input.now })
    }
  });
  // Another writer settled this job between the read and the write. Its
  // outcome stands; this pass does nothing rather than overwriting it.
  if (settled.count !== 1) {
    return { applied: false, refundId: null, sessionState: null, sessionVersion: null };
  }

  // Any command still outstanding is closed with the job. A device that reports
  // afterwards is answered by the API without a second settlement.
  await transaction.agentCommand.updateMany({
    where: { printJobId: job.id, status: { in: ["PENDING", "CLAIMED"] } },
    data: {
      status: input.status === "COMPLETED" ? "COMPLETED" : "FAILED",
      claimToken: null,
      leaseExpiresAt: null,
      resultCode: input.failureCode ?? input.status,
      completedAt: input.now,
      updatedAt: input.now
    }
  });

  const refundId = input.refundObligation
    ? await recordPrintFailureCompensation(transaction, {
        paymentId: job.paymentId,
        sessionId: job.sessionId,
        newId: input.newId,
        now: input.now
      })
    : null;

  await recordPrintJobEvent(transaction, {
    id: input.newId(),
    printJobId: job.id,
    type: input.ledgerType,
    status: input.status,
    operationId: input.operationId,
    confidence: input.resultConfidence,
    failureCode: input.failureCode,
    warningCode: input.warningCode,
    now: input.now,
    detail: {
      sheetsProduced: input.sheetsProduced,
      ...(refundId ? { refundRecorded: true } : {})
    },
    ...(input.deviceDiagnostics === undefined ? {} : { deviceDetail: input.deviceDiagnostics })
  });

  const session = await transaction.printSession.findUnique({ where: { id: job.sessionId } });
  await transaction.auditEvent.create({
    data: {
      id: input.newId(),
      occurredAt: input.now,
      actorType: input.actorType,
      actorId: input.actorId,
      kioskId: job.kioskId,
      sessionId: job.sessionId,
      action: `print.${input.status.toLowerCase()}`,
      outcome: printAuditOutcome(input.status),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      metadata: {
        printJobId: job.id,
        resultConfidence: input.resultConfidence,
        ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        ...(refundId ? { refundId } : {})
      }
    }
  });

  // A job can outlive the PRINTING state only if something else already ended
  // the session. The job settlement still stands; the session is left alone.
  if (!session || session.state !== "PRINTING") {
    return { applied: true, refundId, sessionState: session?.state ?? null, sessionVersion: null };
  }

  const nextVersion = session.stateVersion + 1;
  const nextSequence = session.eventSequence + 1;
  const moved = await transaction.printSession.updateMany({
    where: { id: session.id, stateVersion: session.stateVersion },
    data: {
      state: input.sessionState,
      stateVersion: nextVersion,
      eventSequence: nextSequence,
      terminalReason: terminalReasonFor(input),
      updatedAt: input.now,
      ...(input.sessionState === "COMPLETED" ? { completedAt: input.now } : {})
    }
  });
  if (moved.count !== 1) {
    return { applied: true, refundId, sessionState: session.state, sessionVersion: null };
  }

  await transaction.outboxEvent.create({
    data: {
      id: input.newId(),
      aggregateType: "PRINT_SESSION",
      aggregateId: session.id,
      sequence: nextSequence,
      type: sessionEventTypeFor(input.sessionState),
      payload:
        input.sessionState === "COMPLETED"
          ? { sessionId: session.id, state: input.sessionState, version: nextVersion }
          : {
              sessionId: session.id,
              state: input.sessionState,
              version: nextVersion,
              printJobId: job.id,
              failureCode: input.failureCode ?? "DEVICE_ERROR",
              resultConfidence: input.resultConfidence
            }
    }
  });

  // The session is over however it ended: nobody may upload to it again, and
  // its documents are scheduled for deletion.
  await revokeSessionAccess(transaction, session.id, input.now);
  await scheduleSessionFilesForCleanup(transaction, session.id, input.now, {
    terminalState: input.sessionState,
    policy: input.retentionPolicy
  });

  return { applied: true, refundId, sessionState: input.sessionState, sessionVersion: nextVersion };
}

function isOpenPrintJobStatus(status: string): boolean {
  return (OPEN_PRINT_JOB_STATUSES as readonly string[]).includes(status);
}

function printAuditOutcome(status: ApplyPrintJobSettlementInput["status"]): string {
  if (status === "COMPLETED") return "SUCCESS";
  if (status === "RECOVERY_REQUIRED") return "RECOVERY_REQUIRED";
  return "FAILURE";
}

function sessionEventTypeFor(state: ApplyPrintJobSettlementInput["sessionState"]): string {
  if (state === "COMPLETED") return "session.completed";
  return state === "FAILED" ? "print.failed" : "print.recovery_required";
}

function terminalReasonFor(input: ApplyPrintJobSettlementInput): string {
  if (input.sessionState === "COMPLETED") return "PRINT_COMPLETED";
  return (input.failureCode ?? "DEVICE_ERROR").slice(0, 80);
}
