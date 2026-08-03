import type { Prisma } from "./generated/prisma/client.js";

/** Payment states that may still become a capture. */
export const OPEN_PAYMENT_STATUSES = ["PENDING", "AUTHORIZED"] as const;

export interface SessionPaymentRelease {
  /** The event sequence the caller must persist on the session row. */
  nextSequence: number;
  /**
   * A capture that already happened. The caller must refuse to cancel the
   * session: money has moved, and the answer is fulfilment or a refund, never
   * a quiet cancellation.
   */
  capturedPaymentId: string | null;
  releasedPaymentId: string | null;
}

/**
 * Settle a session's in-flight payment inside the caller's transaction.
 *
 * Cancellation and expiry both end a session that may be holding an open
 * provider intent, and both must leave the ledger honest: the payment is
 * closed as CANCELED with a reason, and the kiosk is told. This is one shared
 * implementation because the API's cancel path, the create-conflict expiry
 * path and the janitor all reach the same moment, and they must not disagree
 * about what happens to a payment that was in progress.
 *
 * A late capture for the intent this closes is still possible — the provider
 * may already have taken the money. That case is handled where the callback
 * arrives: the payment becomes CAPTURED and a compensation record is written.
 */
export async function releaseSessionPayments(
  transaction: Prisma.TransactionClient,
  input: {
    sessionId: string;
    now: Date;
    startingSequence: number;
    newId: () => string;
    /** The session state and version this transaction is about to write. */
    nextState: string;
    nextVersion: number;
  }
): Promise<SessionPaymentRelease> {
  const captured = await transaction.payment.findFirst({
    where: { sessionId: input.sessionId, status: "CAPTURED" },
    select: { id: true }
  });
  if (captured) {
    return {
      nextSequence: input.startingSequence,
      capturedPaymentId: captured.id,
      releasedPaymentId: null
    };
  }

  const open = await transaction.payment.findFirst({
    where: { sessionId: input.sessionId, status: { in: [...OPEN_PAYMENT_STATUSES] } },
    select: { id: true, status: true }
  });
  if (!open) {
    return {
      nextSequence: input.startingSequence,
      capturedPaymentId: null,
      releasedPaymentId: null
    };
  }

  const released = await transaction.payment.updateMany({
    where: { id: open.id, status: open.status },
    data: {
      status: "CANCELED",
      failureCode: "SESSION_TERMINAL",
      failedAt: input.now,
      updatedAt: input.now
    }
  });
  if (released.count !== 1) {
    // A concurrent capture won the row. The caller's transaction is
    // serializable, so the safest answer is to report nothing released and let
    // the retry observe the capture.
    return {
      nextSequence: input.startingSequence,
      capturedPaymentId: null,
      releasedPaymentId: null
    };
  }

  const sequence = input.startingSequence + 1;
  await transaction.paymentAttempt.create({
    data: {
      id: input.newId(),
      paymentId: open.id,
      attempt: await nextAttemptNumber(transaction, open.id),
      action: "CANCEL",
      status: "CANCELED",
      failureCode: "SESSION_TERMINAL",
      createdAt: input.now
    }
  });
  await transaction.outboxEvent.create({
    data: {
      id: input.newId(),
      aggregateType: "PRINT_SESSION",
      aggregateId: input.sessionId,
      sequence,
      type: "payment.failed",
      payload: {
        sessionId: input.sessionId,
        paymentId: open.id,
        state: input.nextState,
        version: input.nextVersion,
        status: "CANCELED",
        failureCode: "SESSION_TERMINAL"
      }
    }
  });

  return { nextSequence: sequence, capturedPaymentId: null, releasedPaymentId: open.id };
}

/**
 * Attempts are numbered per payment and never rewritten, so the next number is
 * read inside the same transaction that writes it.
 */
export async function nextAttemptNumber(
  transaction: Prisma.TransactionClient,
  paymentId: string
): Promise<number> {
  const latest = await transaction.paymentAttempt.findFirst({
    where: { paymentId },
    orderBy: { attempt: "desc" },
    select: { attempt: true }
  });
  return (latest?.attempt ?? 0) + 1;
}
