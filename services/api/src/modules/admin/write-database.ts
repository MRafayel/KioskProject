import type { PrismaClient } from "@printing-kiosk/database";

/**
 * The database as the control plane is allowed to change it.
 *
 * Its sibling, `read-database.ts`, expresses "the panel cannot write" as a
 * type. This one expresses something narrower and more useful: the panel can
 * *append* to a short allow-list of tables, and can read only what it needs to decide whether
 * the append is allowed.
 *
 * Every model below exposes either `create` or nothing but reads. There is no
 * `update`, no `delete`, no `upsert` and no `createMany` anywhere in this
 * interface, so `database.printJob.update(...)` in an admin action is a compile
 * error rather than a review comment — and `database.refund.create(...)` does
 * not typecheck at all, because `refund` is absent. Money has its own pool with
 * its own role and its own narrowing: see `refund-database.ts`.
 *
 * This is the third statement of the Phase 3 gate. The writer role's grants
 * refuse the statement at the database. The table triggers refuse the row. This
 * refuses the code, which is the layer that catches the mistake before it ships
 * rather than after somebody tries it in production.
 */

/**
 * Reads used to revalidate eligibility inside the writing transaction.
 *
 * `findMany` is here for one reason: a correction has to walk the chain of
 * records already superseding an observation before it may add another. Reading
 * more rows is not writing any, and the alternative — a recursive query on a
 * wider client — would have widened the surface this type exists to narrow.
 */
type ReadOnly<TDelegate> = Pick<
  TDelegate,
  Extract<keyof TDelegate, "findFirst" | "findUnique" | "findMany" | "count" | "aggregate">
>;

/** A table an admin action may add a row to, and nothing else. */
type Appendable<TDelegate> = ReadOnly<TDelegate> &
  Pick<TDelegate, Extract<keyof TDelegate, "create">>;

export interface AdminWriteDatabase {
  /** The observation itself. Append-only by trigger as well as by type. */
  printJobRecoveryResolution: Appendable<PrismaClient["printJobRecoveryResolution"]>;
  /**
   * A later account superseding one of those. Appendable, never updatable: a
   * correction that could edit the record it corrects would be an edit.
   */
  printJobRecoveryCorrection: Appendable<PrismaClient["printJobRecoveryCorrection"]>;
  /**
   * A person asking retention to try a dead-lettered run again. Note what is
   * absent beside it: `cleanupRun` is read-only, so re-arming is something the
   * worker does after reading this, and not something an admin action does.
   */
  cleanupRetryRequest: Appendable<PrismaClient["cleanupRetryRequest"]>;
  /** Refills and corrections. Automatic deductions use the print path. */
  kioskPaperEvent: Appendable<PrismaClient["kioskPaperEvent"]>;
  /** Every admin action records itself, including the ones that were refused. */
  auditEvent: Appendable<PrismaClient["auditEvent"]>;

  /**
   * Read-only, and deliberately so. An admin action decides whether it may run
   * by re-reading these inside its own transaction; it never changes them.
   * A recovery observation does not move a job, a session, or a payment.
   */
  printJob: ReadOnly<PrismaClient["printJob"]>;
  printSession: ReadOnly<PrismaClient["printSession"]>;
  payment: ReadOnly<PrismaClient["payment"]>;
  cleanupRun: ReadOnly<PrismaClient["cleanupRun"]>;
  kiosk: ReadOnly<PrismaClient["kiosk"]>;
  adminUser: ReadOnly<PrismaClient["adminUser"]>;
  adminKioskScope: ReadOnly<PrismaClient["adminKioskScope"]>;

  $transaction<TResult>(
    handler: (transaction: AdminWriteTransaction) => Promise<TResult>,
    options?: { timeout?: number; maxWait?: number }
  ): Promise<TResult>;
}

/**
 * The same surface inside a transaction.
 *
 * Written out rather than derived from `Prisma.TransactionClient` so that the
 * narrowing survives: a transaction handle typed as the full client would hand
 * back every model and every method the moment an action opened one, which is
 * exactly when the narrowing matters most.
 */
export interface AdminWriteTransaction {
  printJobRecoveryResolution: Appendable<PrismaClient["printJobRecoveryResolution"]>;
  printJobRecoveryCorrection: Appendable<PrismaClient["printJobRecoveryCorrection"]>;
  cleanupRetryRequest: Appendable<PrismaClient["cleanupRetryRequest"]>;
  kioskPaperEvent: Appendable<PrismaClient["kioskPaperEvent"]>;
  auditEvent: Appendable<PrismaClient["auditEvent"]>;
  printJob: ReadOnly<PrismaClient["printJob"]>;
  printSession: ReadOnly<PrismaClient["printSession"]>;
  payment: ReadOnly<PrismaClient["payment"]>;
  cleanupRun: ReadOnly<PrismaClient["cleanupRun"]>;
  kiosk: ReadOnly<PrismaClient["kiosk"]>;
  adminUser: ReadOnly<PrismaClient["adminUser"]>;
  adminKioskScope: ReadOnly<PrismaClient["adminKioskScope"]>;
}

/**
 * Narrow the full client to the append surface.
 *
 * The cast is the one place the wider client is discarded, and it is why the
 * admin write pool must be constructed with `createAdminWriteClient` and
 * pointed at the writer role: this function removes methods from the *type*,
 * not privileges from the connection.
 */
export function asAdminWriteDatabase(client: PrismaClient): AdminWriteDatabase {
  return client;
}
