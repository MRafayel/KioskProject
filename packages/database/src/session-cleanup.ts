import {
  cleanupDueAt,
  DEFAULT_RETENTION_POLICY,
  type RetentionPolicy,
  type TerminalSessionState
} from "@printing-kiosk/domain";

import type { Prisma } from "./generated/prisma/client.js";

/**
 * Worker artifact uploads have a hard 30-second storage-operation deadline.
 * Once a processing claim is revoked, keep its ledger discoverable for one
 * additional safety window before deleting keys or rows. This lets an in-flight
 * PUT finish or abort and makes a late object visible to the durable janitor.
 */
export const PROCESSING_ARTIFACT_SETTLE_MILLISECONDS = 35_000;

export function processingArtifactCleanupDueAt(now: Date): Date {
  return new Date(now.getTime() + PROCESSING_ARTIFACT_SETTLE_MILLISECONDS);
}

export interface SessionCleanupSchedule {
  /** The terminal state that ended the session; it decides the grace period. */
  terminalState: TerminalSessionState;
  policy?: RetentionPolicy;
}

/**
 * Mark every document of a finished session for deletion.
 *
 * Cancellation, expiry and the end of a print all reach this same moment, and
 * they must not disagree about what happens to the customer's documents. A
 * repeated terminal transition preserves an existing future barrier rather than
 * pulling it forward onto an artifact that may still be uploading.
 *
 * The session is scheduled for its own cleanup run in the same transaction as
 * the transition that ended it. That schedule is the durable record retention
 * works from: a process that dies immediately afterwards loses nothing, because
 * nothing here depends on the ending process surviving to enqueue anything.
 */
export async function scheduleSessionFilesForCleanup(
  transaction: Prisma.TransactionClient,
  sessionId: string,
  now: Date,
  schedule?: SessionCleanupSchedule
): Promise<void> {
  const common = {
    status: "DELETE_PENDING",
    processingGeneration: { increment: 1 },
    processingClaimToken: null,
    processingLeaseExpiresAt: null,
    processingEnqueuedAt: null,
    deleteRequestedAt: now,
    cleanupErrorCode: null,
    updatedAt: now
  } as const;

  await transaction.uploadedFile.updateMany({
    where: { sessionId, status: { in: ["DELETE_PENDING", "DELETING"] } },
    data: common
  });
  await transaction.uploadedFile.updateMany({
    where: { sessionId, status: { in: ["QUARANTINED", "READY"] } },
    data: { ...common, cleanupDueAt: now }
  });
  await transaction.uploadedFile.updateMany({
    where: { sessionId, status: "VALIDATING" },
    data: { ...common, cleanupDueAt: processingArtifactCleanupDueAt(now) }
  });

  if (!schedule) return;
  // Only an unscheduled session is given a due time. A session that ended twice
  // — a cancellation racing an expiry — keeps the first schedule rather than
  // pushing an already-claimed run back into the future.
  await transaction.printSession.updateMany({
    where: { id: sessionId, cleanupStatus: "NOT_DUE" },
    data: {
      cleanupStatus: "PENDING",
      cleanupDueAt: cleanupDueAt(
        schedule.terminalState,
        now,
        schedule.policy ?? DEFAULT_RETENTION_POLICY
      ),
      updatedAt: now
    }
  });
}

/** Revoke every credential that could still reach a finished session. */
export async function revokeSessionAccess(
  transaction: Prisma.TransactionClient,
  sessionId: string,
  now: Date
): Promise<void> {
  await transaction.sessionUploadGrant.updateMany({
    where: { sessionId, status: { in: ["ACTIVE", "CLAIMED"] } },
    data: { status: "REVOKED", revokedAt: now }
  });
  await transaction.mobileClient.updateMany({
    where: { sessionId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAt: now }
  });
}
