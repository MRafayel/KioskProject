import { randomUUID } from "node:crypto";

import {
  Prisma,
  revokeSessionAccess,
  scheduleSessionFilesForCleanup,
  type PrismaClient
} from "@printing-kiosk/database";
import {
  advanceCheckpoint,
  isCleanupDeadLettered,
  nextCleanupAttemptAt,
  sessionObjectPrefixes,
  type CleanupCheckpoint
} from "@printing-kiosk/domain";

import type { RetentionStore } from "../storage/document-store.js";

/** File states that still own bytes or are still on their way to owning none. */
const UNCLEANED_FILE_STATUSES = [
  "UPLOADING",
  "QUARANTINED",
  "VALIDATING",
  "READY",
  "DELETE_PENDING",
  "DELETING"
] as const;

const LIVE_FILE_STATUSES = ["UPLOADING", "QUARANTINED", "VALIDATING", "READY"] as const;

const TERMINAL_SESSION_STATES = [
  "COMPLETED",
  "CANCELED",
  "EXPIRED",
  "FAILED",
  "RECOVERY_REQUIRED"
] as const;

/**
 * How long a terminal session may sit without a retention schedule before the
 * scheduler adopts it anyway. Every path that ends a session writes the
 * schedule in the same transaction, so this only catches rows written before
 * Phase 9 or by a future path that forgets.
 */
const UNSCHEDULED_ADOPTION_MILLISECONDS = 60_000;

const DEFAULT_INTERVAL_MILLISECONDS = 30_000;
const DEFAULT_BATCH_SIZE = 10;

export interface CleanupLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface SessionCleanupRunnerOptions {
  database: PrismaClient;
  store: RetentionStore;
  logger: CleanupLogger;
  leaseMilliseconds: number;
  maximumAttempts: number;
  intervalMilliseconds?: number;
  batchSize?: number;
  now?: () => Date;
  newId?: () => string;
  /** Injected so retry spread is deterministic under test. */
  jitter?: () => number;
}

interface ClaimedRun {
  id: string;
  sessionId: string;
  checkpoint: CleanupCheckpoint;
  attempts: number;
  leaseToken: string;
}

/** A checkpoint either advanced, or asked to be tried again later. */
type CheckpointResult = { advanced: true } | { advanced: false; retryAt: Date };

/**
 * Removes every copy of a finished session's documents, and proves it.
 *
 * Deletion here is a workflow rather than a statement. A run holds a lease,
 * records the last checkpoint that succeeded, and repeats from there after any
 * interruption — a crashed worker, a storage outage, a redeployment mid-sweep.
 * Running it three times does what running it once does.
 *
 * The order matters more than the speed. Access is revoked before anything is
 * deleted, so nothing new can be written behind the run. Bytes go before rows:
 * a scrubbed row can no longer name the object it was pointing at, and an
 * object nothing points at is one nobody can delete. The storage prefix is then
 * swept by position rather than by ledger, because the artifacts a ledger never
 * heard about — a partial upload, an artifact written by a revoked claim — are
 * exactly the ones a ledger cannot find.
 *
 * A run that cannot finish is never quietly closed. It is dead-lettered and
 * logged as an alert, because the documents are still there and the only thing
 * still holding the line is a storage lifecycle rule that is meant to be a
 * backstop, not the mechanism.
 */
export class SessionCleanupRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private running = false;

  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly jitter: () => number;
  private readonly intervalMilliseconds: number;
  private readonly batchSize: number;

  public constructor(private readonly options: SessionCleanupRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
    this.jitter = options.jitter ?? (() => Math.random());
    this.intervalMilliseconds = options.intervalMilliseconds ?? DEFAULT_INTERVAL_MILLISECONDS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  public close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return Promise.resolve();
  }

  /** One pass: adopt everything due, then drive as many runs as the batch allows. */
  public async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      await this.scheduleDueSessions();

      let processed = 0;
      for (let index = 0; index < this.batchSize; index += 1) {
        const run = await this.claimNext();
        if (!run) break;
        await this.execute(run);
        processed += 1;
      }
      return processed;
    } finally {
      this.running = false;
    }
  }

  /**
   * Create the run record for every session whose grace has passed.
   *
   * The unique index on `session_id` is what makes this safe to race: a second
   * scheduler inserts nothing rather than creating a rival lease over the same
   * documents.
   */
  private async scheduleDueSessions(): Promise<void> {
    const now = this.now();

    // A terminal session that was never scheduled is adopted rather than left
    // holding documents forever. Nothing normally reaches this.
    const adoptBefore = new Date(now.getTime() - UNSCHEDULED_ADOPTION_MILLISECONDS);
    await this.options.database.printSession.updateMany({
      where: {
        cleanupStatus: "NOT_DUE",
        state: { in: [...TERMINAL_SESSION_STATES] },
        updatedAt: { lte: adoptBefore }
      },
      data: { cleanupStatus: "PENDING", cleanupDueAt: now, updatedAt: now }
    });

    await this.options.database.$executeRaw`
      INSERT INTO "cleanup_runs" (
        "id", "session_id", "reason", "status", "checkpoint",
        "available_at", "created_at", "updated_at"
      )
      SELECT gen_random_uuid(), "s"."id", "s"."state", 'PENDING', 'SCHEDULED',
             "s"."cleanup_due_at", ${now}, ${now}
        FROM "print_sessions" AS "s"
        WHERE "s"."cleanup_status" = 'PENDING'
          AND "s"."cleanup_due_at" <= ${now}
          AND NOT EXISTS (
            SELECT 1 FROM "cleanup_runs" AS "r" WHERE "r"."session_id" = "s"."id"
          )
        ORDER BY "s"."cleanup_due_at" ASC
        LIMIT ${this.batchSize}
      ON CONFLICT ("session_id") DO NOTHING
    `;
  }

  /**
   * Take the oldest due run under a lease. `FOR UPDATE SKIP LOCKED` is what
   * lets more than one worker share the queue without two of them deleting the
   * same session's objects at once.
   */
  private async claimNext(): Promise<ClaimedRun | null> {
    const now = this.now();
    const leaseToken = this.newId();
    const leaseExpiresAt = new Date(now.getTime() + this.options.leaseMilliseconds);

    const claimed = await this.options.database.$queryRaw<
      Array<{ id: string; session_id: string; checkpoint: string; attempts: number }>
    >`
      UPDATE "cleanup_runs" AS "r"
        SET "status" = 'IN_PROGRESS',
            "lease_token" = ${leaseToken}::uuid,
            "lease_expires_at" = ${leaseExpiresAt},
            "started_at" = COALESCE("r"."started_at", ${now}),
            "updated_at" = ${now}
        WHERE "r"."id" = (
          SELECT "c"."id" FROM "cleanup_runs" AS "c"
            WHERE "c"."status" IN ('PENDING', 'IN_PROGRESS')
              AND "c"."available_at" <= ${now}
              AND ("c"."lease_expires_at" IS NULL OR "c"."lease_expires_at" <= ${now})
            ORDER BY "c"."available_at" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING "r"."id", "r"."session_id", "r"."checkpoint", "r"."attempts"
    `;

    const row = claimed[0];
    if (!row) return null;

    await this.options.database.printSession.updateMany({
      where: { id: row.session_id, cleanupStatus: "PENDING" },
      data: { cleanupStatus: "IN_PROGRESS", updatedAt: now }
    });

    return {
      id: row.id,
      sessionId: row.session_id,
      checkpoint: row.checkpoint as CleanupCheckpoint,
      attempts: row.attempts,
      leaseToken
    };
  }

  private async execute(run: ClaimedRun): Promise<void> {
    let checkpoint = run.checkpoint;
    try {
      while (checkpoint !== "COMPLETED") {
        const result = await this.advance(run, checkpoint);
        if (!result.advanced) {
          await this.deferRun(run, result.retryAt);
          return;
        }
        checkpoint = advanceCheckpoint(checkpoint, nextOf(checkpoint));
        if (checkpoint === "COMPLETED") break;
        await this.recordCheckpoint(run, checkpoint);
      }
      await this.finish(run);
    } catch (error) {
      await this.failRun(run, error);
    }
  }

  private async advance(run: ClaimedRun, checkpoint: CleanupCheckpoint): Promise<CheckpointResult> {
    switch (checkpoint) {
      case "SCHEDULED":
        return this.revokeAccess(run);
      case "ACCESS_REVOKED":
        return this.deleteKnownArtifacts(run);
      case "ARTIFACTS_DELETED":
        return this.reconcileStorage(run);
      case "STORAGE_RECONCILED":
        return this.scrubMetadata(run);
      case "METADATA_SCRUBBED":
      case "COMPLETED":
        return { advanced: true };
    }
  }

  /**
   * Nothing may be added to the session while it is being emptied. Every
   * terminal path already revokes access; this re-asserts it because a run that
   * repeats must not depend on the transition that started it.
   */
  private async revokeAccess(run: ClaimedRun): Promise<CheckpointResult> {
    const now = this.now();
    await this.options.database.$transaction(async (transaction) => {
      await revokeSessionAccess(transaction, run.sessionId, now);
      const live = await transaction.uploadedFile.count({
        where: { sessionId: run.sessionId, status: { in: [...LIVE_FILE_STATUSES] } }
      });
      // Only re-stamp when something is actually still live: the call bumps a
      // processing generation, and doing that on every retry is noise.
      if (live > 0) await scheduleSessionFilesForCleanup(transaction, run.sessionId, now);
    });
    return { advanced: true };
  }

  /**
   * Delete every object the artifact ledger names, then retire the ledger rows.
   *
   * The bytes go first. If this dies between the two, the run repeats and
   * deletes objects that are already gone — which the store treats as success.
   * Retiring the rows first would strand any object whose delete had not landed.
   */
  private async deleteKnownArtifacts(run: ClaimedRun): Promise<CheckpointResult> {
    const now = this.now();

    // A file that was mid-validation keeps a short barrier so an in-flight
    // artifact upload can finish or abort. Deleting underneath it would leave
    // an object written after the sweep had already looked.
    const barrier = await this.options.database.uploadedFile.findFirst({
      where: { sessionId: run.sessionId, cleanupDueAt: { gt: now } },
      orderBy: { cleanupDueAt: "desc" },
      select: { cleanupDueAt: true }
    });
    if (barrier?.cleanupDueAt) return { advanced: false, retryAt: barrier.cleanupDueAt };

    const files = await this.options.database.uploadedFile.findMany({
      where: { sessionId: run.sessionId },
      select: { id: true, quarantineObjectKey: true }
    });
    const derivatives = await this.options.database.fileDerivative.findMany({
      where: { file: { sessionId: run.sessionId } },
      select: { objectKey: true }
    });

    const keys = [
      ...files.flatMap((file) => (file.quarantineObjectKey ? [file.quarantineObjectKey] : [])),
      ...derivatives.map((derivative) => derivative.objectKey)
    ];
    const deleted = await this.options.store.deleteObjects(keys);

    const fileIds = files.map((file) => file.id);
    await this.options.database.$transaction(async (transaction) => {
      if (fileIds.length > 0) {
        await transaction.filePage.deleteMany({ where: { fileId: { in: fileIds } } });
        await transaction.fileDerivative.deleteMany({ where: { fileId: { in: fileIds } } });
      }
      // A customer-visible document becomes a deletion; one that never got past
      // validation stays a rejection. Both keep their ordinal and their size so
      // the session tombstone still says how much was handled.
      await transaction.uploadedFile.updateMany({
        where: {
          sessionId: run.sessionId,
          status: { in: [...UNCLEANED_FILE_STATUSES] },
          deleteRequestedAt: { not: null }
        },
        data: { ...scrubbedFileFields(), status: "DELETED", deletedAt: now, updatedAt: now }
      });
      // A file that never became the customer's — an interrupted upload, a
      // processing failure — keeps the rejection it already carries. Only a row
      // with nothing recorded gets the same fallback the janitor uses.
      await transaction.uploadedFile.updateMany({
        where: {
          sessionId: run.sessionId,
          status: { in: [...UNCLEANED_FILE_STATUSES] },
          deleteRequestedAt: null,
          rejectionCode: { not: null }
        },
        data: { ...scrubbedFileFields(), status: "REJECTED", updatedAt: now }
      });
      await transaction.uploadedFile.updateMany({
        where: {
          sessionId: run.sessionId,
          status: { in: [...UNCLEANED_FILE_STATUSES] },
          deleteRequestedAt: null,
          rejectionCode: null
        },
        data: {
          ...scrubbedFileFields(),
          status: "REJECTED",
          rejectionCode: "PROCESSING_FAILED",
          updatedAt: now
        }
      });
    });

    if (deleted > 0) {
      await this.options.database.cleanupRun.updateMany({
        where: { id: run.id, leaseToken: run.leaseToken },
        data: { objectsDeleted: { increment: deleted }, updatedAt: now }
      });
    }
    return { advanced: true };
  }

  /**
   * Sweep the session's storage prefixes for anything the ledger never knew
   * about, and abort the multipart uploads no listing would have shown.
   *
   * The prefix is derived from the session identifier alone, so an object whose
   * row was lost is still found by where it sits. The purge verifies the prefix
   * is empty before it returns; if something is being recreated as fast as it
   * is deleted, the run fails rather than claiming success.
   */
  private async reconcileStorage(run: ClaimedRun): Promise<CheckpointResult> {
    const prefixes = sessionObjectPrefixes(run.sessionId);
    // Aborting first stops parts from becoming an object behind the purge.
    const aborted = await this.options.store.abortMultipartUploads(prefixes);
    let orphans = 0;
    for (const prefix of prefixes) {
      orphans += await this.options.store.purgePrefix(prefix);
    }

    await this.options.database.cleanupRun.updateMany({
      where: { id: run.id, leaseToken: run.leaseToken },
      data: {
        orphanObjectsDeleted: { increment: orphans },
        multipartUploadsAborted: { increment: aborted },
        updatedAt: this.now()
      }
    });
    return { advanced: true };
  }

  /**
   * Remove what is left of the customer from the relational record, and keep
   * the rest.
   *
   * What goes: the upload grant digests, the parser's opinion of the file, and
   * the per-document digests inside the print manifest and the command that
   * carried it. What stays: the money, the price it was for, the settings it
   * paid for, and the audit trail — a redacted tombstone rather than an absence.
   */
  private async scrubMetadata(run: ClaimedRun): Promise<CheckpointResult> {
    const now = this.now();
    await this.options.database.$transaction(async (transaction) => {
      await transaction.uploadedFile.updateMany({
        where: { sessionId: run.sessionId },
        data: { ...scrubbedFileFields(), updatedAt: now }
      });

      // The grant rows exist to be checked against a presented secret. Once
      // nothing may be presented, their digests are the only thing left in them.
      await transaction.sessionUploadGrant.deleteMany({ where: { sessionId: run.sessionId } });

      // A settled command is finished work, not evidence: the operation ledger
      // is what records what the device did. Its payload names every document
      // digest, so it goes with the documents.
      await transaction.agentCommand.deleteMany({
        where: { sessionId: run.sessionId, status: { in: ["COMPLETED", "FAILED", "EXPIRED"] } }
      });

      await this.redactPrintManifests(transaction, run.sessionId, now);
    });
    return { advanced: true };
  }

  /**
   * Replace a print job's document manifest with a count.
   *
   * The manifest names each document by digest. The hash over it stays, so the
   * job still proves what was paid for and printed; the digests that could
   * confirm possession of a particular file do not.
   */
  private async redactPrintManifests(
    transaction: Prisma.TransactionClient,
    sessionId: string,
    now: Date
  ): Promise<void> {
    const jobs = await transaction.printJob.findMany({
      where: { sessionId, manifestRedactedAt: null },
      select: { id: true, jobManifest: true }
    });
    for (const job of jobs) {
      const manifest = job.jobManifest as { documents?: unknown[] } | null;
      const documentCount = Array.isArray(manifest?.documents) ? manifest.documents.length : 0;
      await transaction.printJob.updateMany({
        where: { id: job.id, manifestRedactedAt: null },
        data: {
          jobManifest: { redacted: true, documentCount },
          manifestRedactedAt: now,
          updatedAt: now
        }
      });
    }
  }

  /**
   * Close the run: the session records that its documents are gone, and says so
   * once, durably, to whoever is listening.
   *
   * The tombstone is written under a trigger that re-reads the artifact ledger,
   * so a run that skipped a step cannot record that it did not.
   */
  private async finish(run: ClaimedRun): Promise<void> {
    const now = this.now();
    await this.options.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "print_sessions" WHERE "id" = ${run.sessionId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) return;

      const session = await transaction.printSession.findUnique({
        where: { id: run.sessionId },
        select: { id: true, kioskId: true, eventSequence: true, filesDeletedAt: true }
      });
      if (!session) return;

      const closed = await transaction.cleanupRun.updateMany({
        where: { id: run.id, leaseToken: run.leaseToken },
        data: {
          status: "DONE",
          checkpoint: "COMPLETED",
          lastErrorCode: null,
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now
        }
      });
      // The lease was lost to another worker, which is now finishing the same
      // run. Writing the tombstone twice is what the trigger refuses, so stop.
      if (closed.count !== 1) return;

      if (session.filesDeletedAt) return;

      const nextSequence = session.eventSequence + 1;
      await transaction.printSession.update({
        where: { id: session.id },
        data: {
          cleanupStatus: "DONE",
          filesDeletedAt: now,
          eventSequence: nextSequence,
          updatedAt: now
        }
      });
      await transaction.auditEvent.create({
        data: {
          id: this.newId(),
          occurredAt: now,
          actorType: "SYSTEM",
          actorId: "session-cleanup",
          kioskId: session.kioskId,
          sessionId: session.id,
          action: "session.cleanup.completed",
          outcome: "SUCCESS",
          metadata: { cleanupRunId: run.id, attempts: run.attempts }
        }
      });
      await transaction.outboxEvent.create({
        data: {
          id: this.newId(),
          aggregateType: "PRINT_SESSION",
          aggregateId: session.id,
          sequence: nextSequence,
          type: "cleanup.completed",
          payload: { sessionId: session.id, filesDeletedAt: now.toISOString() }
        }
      });
    });

    this.options.logger.info(
      { cleanupRunId: run.id, sessionId: run.sessionId, attempts: run.attempts },
      "session documents deleted"
    );
  }

  /** Record a checkpoint that succeeded, so a later attempt resumes from it. */
  private async recordCheckpoint(run: ClaimedRun, checkpoint: CleanupCheckpoint): Promise<void> {
    const now = this.now();
    const updated = await this.options.database.cleanupRun.updateMany({
      where: { id: run.id, leaseToken: run.leaseToken },
      data: { checkpoint, lastErrorCode: null, updatedAt: now }
    });
    if (updated.count !== 1) throw new LeaseLostError();
  }

  /** Hand the run back to wait for something outside its control. */
  private async deferRun(run: ClaimedRun, retryAt: Date): Promise<void> {
    const now = this.now();
    await this.options.database.cleanupRun.updateMany({
      where: { id: run.id, leaseToken: run.leaseToken },
      data: {
        status: "PENDING",
        availableAt: retryAt > now ? retryAt : now,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: now
      }
    });
    await this.options.database.printSession.updateMany({
      where: { id: run.sessionId, cleanupStatus: "IN_PROGRESS" },
      data: { cleanupStatus: "PENDING", updatedAt: now }
    });
  }

  /**
   * A failed attempt backs off and is tried again. When the budget is spent the
   * run is dead-lettered and logged as an alert: the documents are still there,
   * so this must be visible rather than silent.
   */
  private async failRun(run: ClaimedRun, error: unknown): Promise<void> {
    const now = this.now();
    const attempts = run.attempts + 1;
    const errorCode = safeErrorCode(error);
    const deadLettered = isCleanupDeadLettered(attempts, this.options.maximumAttempts);

    try {
      await this.options.database.cleanupRun.updateMany({
        where: { id: run.id, leaseToken: run.leaseToken },
        data: {
          status: deadLettered ? "DEAD_LETTER" : "PENDING",
          attempts,
          lastErrorCode: errorCode,
          availableAt: deadLettered ? now : nextCleanupAttemptAt(now, attempts, this.jitter()),
          leaseToken: null,
          leaseExpiresAt: null,
          ...(deadLettered ? { deadLetteredAt: now } : {}),
          updatedAt: now
        }
      });
      await this.options.database.printSession.updateMany({
        where: { id: run.sessionId, cleanupStatus: "IN_PROGRESS" },
        data: { cleanupStatus: deadLettered ? "DEAD_LETTER" : "PENDING", updatedAt: now }
      });
    } catch (releaseError) {
      // The lease will expire on its own and the run will be claimed again.
      this.options.logger.error(
        { cleanupRunId: run.id, errorCode: safeErrorCode(releaseError) },
        "cleanup run release failed"
      );
      return;
    }

    const fields = {
      cleanupRunId: run.id,
      sessionId: run.sessionId,
      checkpoint: run.checkpoint,
      attempts,
      errorCode
    };
    if (deadLettered) {
      this.options.logger.error(fields, "session cleanup dead-lettered with documents remaining");
      return;
    }
    this.options.logger.warn(fields, "session cleanup attempt failed");
  }

  private schedule(delayMilliseconds: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMilliseconds);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const processed = await this.runOnce();
      this.schedule(processed >= this.batchSize ? 0 : this.intervalMilliseconds);
    } catch (error) {
      this.options.logger.error({ errorCode: safeErrorCode(error) }, "session cleanup pass failed");
      this.schedule(this.intervalMilliseconds);
    }
  }
}

class LeaseLostError extends Error {
  public constructor() {
    super("CLEANUP_LEASE_LOST");
    this.name = "LeaseLostError";
  }
}

function nextOf(checkpoint: CleanupCheckpoint): CleanupCheckpoint {
  switch (checkpoint) {
    case "SCHEDULED":
      return "ACCESS_REVOKED";
    case "ACCESS_REVOKED":
      return "ARTIFACTS_DELETED";
    case "ARTIFACTS_DELETED":
      return "STORAGE_RECONCILED";
    case "STORAGE_RECONCILED":
      return "METADATA_SCRUBBED";
    case "METADATA_SCRUBBED":
    case "COMPLETED":
      return "COMPLETED";
  }
}

/**
 * Everything about a file that describes its content rather than its existence.
 * The row survives as a tombstone: an ordinal, a size and a status, so the
 * session's history still reads, with nothing left that identifies a document.
 */
function scrubbedFileFields() {
  return {
    quarantineObjectKey: null,
    contentSha256: null,
    pageCount: null,
    declaredMime: null,
    detectedMime: null,
    extension: null,
    processingErrorCode: null,
    processingClaimToken: null,
    processingLeaseExpiresAt: null,
    cleanupDueAt: null,
    cleanupErrorCode: null
  } as const;
}

/**
 * Only a closed, non-identifying code ever reaches a log line. An error message
 * from a storage client can carry a key, and a key names a document.
 */
function safeErrorCode(error: unknown): string {
  if (error instanceof LeaseLostError) return "CLEANUP_LEASE_LOST";
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `DB_${error.code}`;
  // Only a message that is already a closed code is allowed through. A storage
  // client's prose can name the key it failed on, and a key names a document.
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.message)) return error.message;
  if (error instanceof Error && error.name && error.name !== "Error") {
    return error.name.slice(0, 80);
  }
  return "UNKNOWN_ERROR";
}
