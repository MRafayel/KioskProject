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

/**
 * Upload requests may run for at most five minutes (the configuration schema's
 * upper bound), and the API janitor gives a stopped request another thirty
 * seconds to observe its abort signal. This fallback only applies to an
 * UPLOADING row created by an older process that did not persist its own exact
 * deadline; new reservations store the configured deadline immediately.
 */
export const MAX_UPLOAD_ARTIFACT_SETTLE_MILLISECONDS = 330_000;
export const UPLOAD_ARTIFACT_SETTLE_PADDING_MILLISECONDS = 30_000;

export function processingArtifactCleanupDueAt(now: Date): Date {
  return new Date(now.getTime() + PROCESSING_ARTIFACT_SETTLE_MILLISECONDS);
}

/** The earliest safe deletion time for bytes an active upload may still write. */
export function uploadArtifactCleanupDueAt(now: Date, uploadTimeoutMilliseconds: number): Date {
  const milliseconds = now.getTime();
  if (
    !Number.isFinite(milliseconds) ||
    !Number.isSafeInteger(uploadTimeoutMilliseconds) ||
    uploadTimeoutMilliseconds < 1
  ) {
    throw new Error("UPLOAD_CLEANUP_BARRIER_INVALID");
  }
  return new Date(
    milliseconds + uploadTimeoutMilliseconds + UPLOAD_ARTIFACT_SETTLE_PADDING_MILLISECONDS
  );
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
  const scheduledDueAt = schedule
    ? cleanupDueAt(schedule.terminalState, now, schedule.policy ?? DEFAULT_RETENTION_POLICY)
    : now;
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

  // A PUT is intentionally outside the reservation transaction. Keep the row
  // discoverable until that already-authorized request must have finished or
  // aborted, otherwise a cleanup sweep can run first and the PUT can recreate
  // an object behind it. Current writers persist their exact barrier when they
  // reserve; this conservative fallback protects rows created by an older
  // process during a rolling deployment.
  await transaction.uploadedFile.updateMany({
    where: { sessionId, status: "UPLOADING", cleanupDueAt: null },
    data: {
      cleanupDueAt: new Date(now.getTime() + MAX_UPLOAD_ARTIFACT_SETTLE_MILLISECONDS),
      cleanupErrorCode: null,
      updatedAt: now
    }
  });

  await transaction.uploadedFile.updateMany({
    where: { sessionId, status: { in: ["DELETE_PENDING", "DELETING"] } },
    data: common
  });
  await transaction.uploadedFile.updateMany({
    where: { sessionId, status: { in: ["QUARANTINED", "READY"] } },
    // The API's per-file janitor and the Phase 9 runner share this field. Using
    // the session due time prevents the older janitor from bypassing settled or
    // recovery grace by deleting the same bytes on its next pass.
    data: { ...common, cleanupDueAt: scheduledDueAt }
  });
  await transaction.uploadedFile.updateMany({
    where: { sessionId, status: "VALIDATING" },
    data: {
      ...common,
      cleanupDueAt: new Date(
        Math.max(scheduledDueAt.getTime(), processingArtifactCleanupDueAt(now).getTime())
      )
    }
  });

  if (!schedule) return;
  // Only an unscheduled session is given a due time. A session that ended twice
  // — a cancellation racing an expiry — keeps the first schedule rather than
  // pushing an already-claimed run back into the future.
  await transaction.printSession.updateMany({
    where: { id: sessionId, cleanupStatus: "NOT_DUE" },
    data: {
      cleanupStatus: "PENDING",
      cleanupDueAt: scheduledDueAt,
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
