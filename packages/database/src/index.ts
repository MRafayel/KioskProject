import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export function createDatabaseClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

/**
 * Startup options pinned onto every connection the control plane opens.
 *
 * These are sent in the PostgreSQL startup packet, so they apply to every
 * statement on the connection — including one outside an explicit transaction,
 * and including one issued by code that has no idea this pool is special.
 *
 * `default_transaction_read_only` is the guarantee that the admin panel cannot
 * write. The timeouts are the guarantee that it cannot slow printing down: an
 * expensive dashboard query is cancelled by the database rather than left to
 * compete with the print path for connections and locks.
 *
 * `scripts/admin-reader.mjs` pins the same settings onto the reader role, so
 * they survive a connection opened without them. They are repeated here because
 * a development environment that has not provisioned the role must still get a
 * read-only admin pool.
 */
const ADMIN_READ_CONNECTION_OPTIONS = [
  "-c default_transaction_read_only=on",
  "-c statement_timeout=5000",
  "-c idle_in_transaction_session_timeout=10000",
  "-c lock_timeout=2000"
].join(" ");

/**
 * The pool the admin control plane reads through.
 *
 * Separate from the application pool by design: a dashboard must not be able to
 * exhaust the connections the print path needs, and "an admin endpoint cannot
 * write" should be a property of the connection rather than of code review.
 *
 * In production this is pointed at `printing_kiosk_admin_reader`, whose grants
 * also decide which columns exist as far as the control plane is concerned. In
 * development it may point at the application role; the read-only setting still
 * applies, so a write fails there too.
 */
export function createAdminReadClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    options: ADMIN_READ_CONNECTION_OPTIONS,
    // Five people clicking around do not need the application's pool. Keeping
    // it small bounds what the dashboard can ever take from the database.
    max: 4
  });
  return new PrismaClient({ adapter });
}

/**
 * Prove the admin read pool is actually read-only before serving anything.
 *
 * The connection option above is only effective if the driver forwards it. If a
 * future upgrade quietly stopped doing so, every admin read would keep working
 * and the guarantee would be gone with no visible symptom — exactly the kind of
 * silent security regression that is worth one query at boot to rule out.
 */
export async function assertAdminReadClientIsReadOnly(client: PrismaClient): Promise<void> {
  const rows = await client.$queryRaw<
    { transaction_read_only: string }[]
  >`SELECT current_setting('transaction_read_only') AS transaction_read_only`;

  if (rows[0]?.transaction_read_only !== "on") {
    throw new Error(
      "The admin read connection is not read-only. Refusing to expose the control plane: " +
        "check ADMIN_READ_DATABASE_URL and rerun `pnpm db:admin-reader verify`."
    );
  }
}

export { Prisma } from "./generated/prisma/client.js";
export type { PrismaClient };
export { invalidateSessionPricing } from "./session-pricing.js";
export type { QuoteInvalidationReason, SessionPricingInvalidation } from "./session-pricing.js";
export {
  nextAttemptNumber,
  releaseSessionPayments,
  OPEN_PAYMENT_STATUSES
} from "./session-payments.js";
export type { SessionPaymentRelease } from "./session-payments.js";
export {
  applyPrintJobSettlement,
  nextPrintJobEventSequence,
  recordPrintFailureCompensation,
  recordPrintJobEvent,
  OPEN_PRINT_JOB_STATUSES
} from "./print-jobs.js";
export type {
  ApplyPrintJobSettlementInput,
  PrintJobLedgerType,
  PrintJobSettlementOutcome
} from "./print-jobs.js";
export {
  MAX_UPLOAD_ARTIFACT_SETTLE_MILLISECONDS,
  processingArtifactCleanupDueAt,
  revokeSessionAccess,
  scheduleSessionFilesForCleanup,
  uploadArtifactCleanupDueAt,
  PROCESSING_ARTIFACT_SETTLE_MILLISECONDS,
  UPLOAD_ARTIFACT_SETTLE_PADDING_MILLISECONDS
} from "./session-cleanup.js";
