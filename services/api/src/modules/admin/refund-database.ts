import type { PrismaClient } from "@printing-kiosk/database";

/**
 * The database as the control plane is allowed to move money in it.
 *
 * Its siblings say "cannot write" (`read-database.ts`) and "can append operator
 * facts" (`write-database.ts`). This one says something narrower than either:
 * it can create a monetary obligation and the record of who decided it, and it
 * can read exactly enough to decide whether it may.
 *
 * `refund` exposes `create` and reads. It does not expose `update`, so
 * `database.refund.update(...)` — marking an obligation settled, attaching a
 * provider reference, closing one that was never honoured — is a compile error
 * in this module rather than a review comment. Settlement belongs to an
 * executor that holds a provider credential, and the control plane holds none.
 *
 * `payment` is read-only and there is no `paymentAttempt` at all, so nothing
 * here can invent the capture it is refunding against or rewrite the amount
 * that bounds it. And there is no `printJobRecoveryResolution.create`: the
 * connection that authorizes a payout cannot manufacture the evidence for its
 * own decision.
 *
 * This is the third statement of the Phase 4 gate. The role's grants refuse the
 * statement at the database. The triggers refuse the row — a `PRINT_RECOVERY`
 * refund without a recorded authorization does not survive COMMIT. This refuses
 * the code, which is the layer that catches the mistake before it ships.
 */

/** Reads used to revalidate an authorization inside the writing transaction. */
type ReadOnly<TDelegate> = Pick<
  TDelegate,
  Extract<keyof TDelegate, "findFirst" | "findUnique" | "count" | "aggregate" | "findMany">
>;

/** A table an authorization may add a row to, and nothing else. */
type Appendable<TDelegate> = ReadOnly<TDelegate> &
  Pick<TDelegate, Extract<keyof TDelegate, "create">>;

export interface AdminRefundDatabase {
  /** The obligation, at PENDING. Raising one is not paying it. */
  refund: Appendable<PrismaClient["refund"]>;
  /** Who decided it, on what evidence, and why. Required by a deferred trigger. */
  refundAuthorization: Appendable<PrismaClient["refundAuthorization"]>;
  /** Every authorization records itself, including the ones that were refused. */
  auditEvent: Appendable<PrismaClient["auditEvent"]>;

  /**
   * Read-only, and deliberately so. An authorization decides whether it may run
   * by re-reading these inside its own transaction; it changes none of them.
   * Paying a customer back does not move a print job, a session, or a payment.
   */
  payment: ReadOnly<PrismaClient["payment"]>;
  printJob: ReadOnly<PrismaClient["printJob"]>;
  printSession: ReadOnly<PrismaClient["printSession"]>;
  printJobRecoveryResolution: ReadOnly<PrismaClient["printJobRecoveryResolution"]>;
  printJobRecoveryCorrection: ReadOnly<PrismaClient["printJobRecoveryCorrection"]>;
  adminUser: ReadOnly<PrismaClient["adminUser"]>;

  $transaction<TResult>(
    handler: (transaction: AdminRefundTransaction) => Promise<TResult>,
    options?: { timeout?: number; maxWait?: number }
  ): Promise<TResult>;
}

/**
 * The same surface inside a transaction.
 *
 * Written out rather than derived from `Prisma.TransactionClient` for the same
 * reason as the write surface: a transaction handle typed as the full client
 * would hand back every model and every method the moment an authorization
 * opened one, which is exactly when the narrowing matters most.
 */
export interface AdminRefundTransaction {
  refund: Appendable<PrismaClient["refund"]>;
  refundAuthorization: Appendable<PrismaClient["refundAuthorization"]>;
  auditEvent: Appendable<PrismaClient["auditEvent"]>;
  payment: ReadOnly<PrismaClient["payment"]>;
  printJob: ReadOnly<PrismaClient["printJob"]>;
  printSession: ReadOnly<PrismaClient["printSession"]>;
  printJobRecoveryResolution: ReadOnly<PrismaClient["printJobRecoveryResolution"]>;
  printJobRecoveryCorrection: ReadOnly<PrismaClient["printJobRecoveryCorrection"]>;
  adminUser: ReadOnly<PrismaClient["adminUser"]>;
}

/**
 * Narrow the full client to the refund surface.
 *
 * The cast is the one place the wider client is discarded, and it is why the
 * refund pool must be constructed with `createAdminRefundClient` and pointed at
 * the refund role: this function removes methods from the *type*, not
 * privileges from the connection.
 */
export function asAdminRefundDatabase(client: PrismaClient): AdminRefundDatabase {
  return client;
}
