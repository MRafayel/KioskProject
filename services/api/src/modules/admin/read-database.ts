import type { PrismaClient } from "@printing-kiosk/database";

/**
 * The database as the control plane is allowed to see it.
 *
 * Phase 2's acceptance gate is "no mutations exist". That is easy to assert
 * today by reading the code and hard to keep true a year from now, so it is
 * expressed as a type: this interface exposes only the read methods of only the
 * models the dashboard needs, and `observability.ts` accepts nothing else.
 * `database.printSession.update(...)` in an admin read path is a compile error,
 * not a review comment.
 *
 * It is the third statement of the same rule, and each one catches what the
 * others cannot. The reader role's grants stop a query at the database. The
 * read-only connection stops a write at the protocol. This stops one from being
 * written at all — including in a future phase, where the temptation to reach
 * for the pool that is already in scope will be strongest.
 *
 * Models absent from this list are absent on purpose: kiosk credentials, upload
 * grants, mobile clients, file derivatives, idempotency records and every
 * `admin_*` table except the two below. The reader role holds no grant on them
 * either.
 */

type ReadOnly<TDelegate> = Pick<
  TDelegate,
  Extract<keyof TDelegate, "findMany" | "findFirst" | "findUnique" | "count" | "groupBy">
>;

export interface AdminReadDatabase {
  kiosk: ReadOnly<PrismaClient["kiosk"]>;
  printSession: ReadOnly<PrismaClient["printSession"]>;
  sessionEvent: ReadOnly<PrismaClient["sessionEvent"]>;
  uploadedFile: ReadOnly<PrismaClient["uploadedFile"]>;
  cleanupRun: ReadOnly<PrismaClient["cleanupRun"]>;
  printSettingRevision: ReadOnly<PrismaClient["printSettingRevision"]>;
  priceQuote: ReadOnly<PrismaClient["priceQuote"]>;
  payment: ReadOnly<PrismaClient["payment"]>;
  refund: ReadOnly<PrismaClient["refund"]>;
  printJob: ReadOnly<PrismaClient["printJob"]>;
  printJobEvent: ReadOnly<PrismaClient["printJobEvent"]>;
  /** One operator's account of a print the system would not settle. */
  printJobRecoveryResolution: ReadOnly<PrismaClient["printJobRecoveryResolution"]>;
  /** The later accounts that supersede one, and who wrote them. */
  printJobRecoveryCorrection: ReadOnly<PrismaClient["printJobRecoveryCorrection"]>;
  /** Why a refund exists, when a named person is the reason it exists. */
  refundAuthorization: ReadOnly<PrismaClient["refundAuthorization"]>;
  /** Who asked retention to try again, and about which failure. */
  cleanupRetryRequest: ReadOnly<PrismaClient["cleanupRetryRequest"]>;
  agentCommand: ReadOnly<PrismaClient["agentCommand"]>;
  outboxEvent: ReadOnly<PrismaClient["outboxEvent"]>;
  auditEvent: ReadOnly<PrismaClient["auditEvent"]>;
  /** A colleague's name on an audit row, and the people section's roster. */
  adminUser: ReadOnly<PrismaClient["adminUser"]>;
  /**
   * Phase 4B. The people section has to answer "can this person work, and
   * should they", which needs key counts, live session counts, kiosk
   * assignments and outstanding tickets.
   *
   * None of that is a credential, and the reader role's column allow-list is
   * what makes that statement true rather than intended: `credential_id`,
   * `public_key`, `token_digest`, `csrf_digest` and the ticket's own
   * `secret_digest` are all denied at the grant, so a query here that asked for
   * one would be refused by PostgreSQL.
   */
  adminAuthenticator: ReadOnly<PrismaClient["adminAuthenticator"]>;
  adminSession: ReadOnly<PrismaClient["adminSession"]>;
  adminKioskScope: ReadOnly<PrismaClient["adminKioskScope"]>;
  adminEnrollmentTicket: ReadOnly<PrismaClient["adminEnrollmentTicket"]>;
}

/**
 * Narrow the full client to the read surface.
 *
 * The cast is the one place the wider client is discarded, and it is why the
 * admin read pool must be constructed with `createAdminReadClient`: this
 * function removes methods from the *type*, not from the connection.
 */
export function asAdminReadDatabase(client: PrismaClient): AdminReadDatabase {
  return client;
}
