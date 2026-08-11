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

/**
 * Startup options pinned onto the connection the control plane writes through.
 *
 * Not read-only — this is the pool that appends an operator's observation and
 * the audit event beside it. Everything else is tighter than the read pool
 * rather than looser: an admin action is one short transaction over a handful
 * of rows, so a statement running longer than two seconds is a fault, and a
 * lock held against the print path is the fault that matters most.
 *
 * `scripts/admin-writer.mjs` pins the same settings onto the writer role.
 */
const ADMIN_WRITE_CONNECTION_OPTIONS = [
  "-c statement_timeout=2000",
  "-c idle_in_transaction_session_timeout=5000",
  "-c lock_timeout=1000"
].join(" ");

/**
 * The pool the admin control plane's few operator actions write through.
 *
 * A third pool, deliberately. It is not the read pool, which cannot write at
 * all, and it is not the application pool, which can write everything: an admin
 * action must not inherit the print path's authority just because it happens to
 * run in the same process.
 *
 * In production this points at `printing_kiosk_admin_writer`, which holds
 * INSERT on two tables and no UPDATE or DELETE anywhere. That is what makes
 * "an Operator cannot move money" and "nobody can rewrite what a device
 * reported" properties of the database rather than of this repository.
 */
export function createAdminWriteClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    options: ADMIN_WRITE_CONNECTION_OPTIONS,
    // Admin actions are rare and deliberate. Two connections is generous.
    max: 2
  });
  return new PrismaClient({ adapter });
}

/**
 * The privileges the admin write pool must not hold, checked at boot.
 *
 * Each entry is a way the control plane could cause harm that no capability in
 * the model authorises: paying money out, rewriting what a printer reported,
 * reopening a settled session, issuing work to a device, or erasing the log of
 * having done any of it.
 */
const FORBIDDEN_ADMIN_WRITE_PRIVILEGES: readonly (readonly [string, string])[] = [
  ["public.refunds", "INSERT"],
  ["public.refunds", "UPDATE"],
  ["public.refunds", "DELETE"],
  ["public.payments", "INSERT"],
  ["public.payments", "UPDATE"],
  ["public.print_jobs", "UPDATE"],
  ["public.print_jobs", "DELETE"],
  ["public.print_sessions", "UPDATE"],
  ["public.agent_commands", "INSERT"],
  ["public.uploaded_files", "UPDATE"],
  ["public.audit_events", "UPDATE"],
  ["public.audit_events", "DELETE"],
  ["public.print_job_recovery_resolutions", "UPDATE"],
  ["public.print_job_recovery_resolutions", "DELETE"]
];

/** The two grants without which no admin action can complete. */
const REQUIRED_ADMIN_WRITE_PRIVILEGES: readonly (readonly [string, string])[] = [
  ["public.print_job_recovery_resolutions", "INSERT"],
  ["public.audit_events", "INSERT"]
];

/**
 * Prove the admin write pool is as small as it claims before serving anything.
 *
 * `pnpm db:admin-writer verify` checks the same thing far more thoroughly, but
 * it checks a database an operator ran it against. This checks the connection
 * this process actually opened, which is the one that matters: a deployment
 * pointed at the wrong URL passes every offline check and fails here.
 *
 * Only called when a dedicated write role is configured. A development
 * environment sharing the application role would fail every assertion below,
 * and refusing to start over that would be an outage in exchange for nothing.
 */
export async function assertAdminWriteClientIsAppendOnly(client: PrismaClient): Promise<void> {
  const held = async (table: string, privilege: string): Promise<boolean> => {
    const rows = await client.$queryRaw<
      { held: boolean }[]
    >`SELECT has_table_privilege(${table}, ${privilege}) AS held`;
    return rows[0]?.held === true;
  };

  const violations: string[] = [];
  for (const [table, privilege] of FORBIDDEN_ADMIN_WRITE_PRIVILEGES) {
    if (await held(table, privilege)) violations.push(`holds ${privilege} on ${table}`);
  }
  for (const [table, privilege] of REQUIRED_ADMIN_WRITE_PRIVILEGES) {
    if (!(await held(table, privilege))) violations.push(`lacks ${privilege} on ${table}`);
  }

  if (violations.length > 0) {
    throw new Error(
      "The admin write connection does not match the control plane's privilege policy. " +
        `Refusing to start: ${violations.join("; ")}. ` +
        "Check ADMIN_WRITE_DATABASE_URL and rerun `pnpm db:admin-writer verify`."
    );
  }
}

/**
 * The pool the control plane authorizes refunds through.
 *
 * A fourth pool, and the reason it exists is worth stating rather than
 * inferring. The write pool is defined by holding no privilege on money at all;
 * that is the property Phase 3 was built around, and the way to keep it while
 * adding the ability to authorize a refund is a separate connection with a
 * separate role, not a widened grant on the old one.
 *
 * In production this points at `printing_kiosk_admin_refund_writer`, which
 * holds INSERT on `refunds`, on the authorization record beside it, and on the
 * audit log — and no UPDATE anywhere. So the panel can raise an obligation and
 * cannot settle one, cannot attach a provider reference to it, and cannot mark
 * one paid that never was. That last part is not a policy in this repository;
 * it is a grant this role does not have.
 */
export function createAdminRefundClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    options: ADMIN_WRITE_CONNECTION_OPTIONS,
    // Authorizing a refund is a rare, deliberate act by one of a handful of
    // people. Two connections is generous.
    max: 2
  });
  return new PrismaClient({ adapter });
}

/**
 * The privileges the refund pool must not hold, checked at boot.
 *
 * The list is about the difference between raising an obligation and settling
 * one. UPDATE on `refunds` would let the panel mark a payout complete without a
 * payout; anything on `payments` would let it invent or rewrite the capture it
 * is refunding against; INSERT on a recovery resolution would let the same
 * connection manufacture the evidence for its own decision.
 */
const FORBIDDEN_ADMIN_REFUND_PRIVILEGES: readonly (readonly [string, string])[] = [
  ["public.refunds", "UPDATE"],
  ["public.refunds", "DELETE"],
  ["public.payments", "INSERT"],
  ["public.payments", "UPDATE"],
  ["public.payment_attempts", "INSERT"],
  ["public.print_jobs", "UPDATE"],
  ["public.print_sessions", "UPDATE"],
  ["public.print_job_recovery_resolutions", "INSERT"],
  ["public.print_job_recovery_corrections", "INSERT"],
  ["public.refund_authorizations", "UPDATE"],
  ["public.refund_authorizations", "DELETE"],
  ["public.audit_events", "UPDATE"],
  ["public.audit_events", "DELETE"],
  ["public.agent_commands", "INSERT"]
];

/** The three grants without which no refund can be authorized. */
const REQUIRED_ADMIN_REFUND_PRIVILEGES: readonly (readonly [string, string])[] = [
  ["public.refunds", "INSERT"],
  ["public.refund_authorizations", "INSERT"],
  ["public.audit_events", "INSERT"]
];

/**
 * Prove the refund pool is as small as it claims before serving anything.
 *
 * Same argument as its sibling, with more at stake: `pnpm db:admin-refund-writer
 * verify` checks a database somebody ran it against, and this checks the
 * connection this process actually opened. A deployment pointed at the
 * application role by mistake passes every offline check and fails here.
 */
export async function assertAdminRefundClientIsAppendOnly(client: PrismaClient): Promise<void> {
  const held = async (table: string, privilege: string): Promise<boolean> => {
    const rows = await client.$queryRaw<
      { held: boolean }[]
    >`SELECT has_table_privilege(${table}, ${privilege}) AS held`;
    return rows[0]?.held === true;
  };

  const violations: string[] = [];
  for (const [table, privilege] of FORBIDDEN_ADMIN_REFUND_PRIVILEGES) {
    if (await held(table, privilege)) violations.push(`holds ${privilege} on ${table}`);
  }
  for (const [table, privilege] of REQUIRED_ADMIN_REFUND_PRIVILEGES) {
    if (!(await held(table, privilege))) violations.push(`lacks ${privilege} on ${table}`);
  }

  if (violations.length > 0) {
    throw new Error(
      "The admin refund connection does not match the control plane's privilege policy. " +
        `Refusing to start: ${violations.join("; ")}. ` +
        "Check ADMIN_REFUND_DATABASE_URL and rerun `pnpm db:admin-refund-writer verify`."
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
