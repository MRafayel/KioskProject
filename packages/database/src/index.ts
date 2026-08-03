import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export function createDatabaseClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
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
  processingArtifactCleanupDueAt,
  revokeSessionAccess,
  scheduleSessionFilesForCleanup,
  PROCESSING_ARTIFACT_SETTLE_MILLISECONDS
} from "./session-cleanup.js";
