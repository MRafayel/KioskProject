import { uploadedFileSnapshotSchema } from "@printing-kiosk/contracts";
import {
  invalidateSessionPricing,
  OPEN_PAYMENT_STATUSES,
  releaseSessionPayments,
  type Prisma,
  type PrismaClient
} from "@printing-kiosk/database";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { processingArtifactCleanupDueAt } from "./cleanup-policy.js";
import type { ObjectStore } from "./object-store.js";

const EXPIRABLE_STATES = [
  "CREATED",
  "WAITING_FOR_UPLOAD",
  "FILES_UPLOADED",
  "CONFIGURING",
  "AWAITING_PAYMENT"
] as const;

interface FileJanitorOptions {
  database: PrismaClient;
  objectStore: ObjectStore;
  clock: Clock;
  random: RandomSource;
  uploadTimeoutSeconds: number;
  intervalMilliseconds?: number;
  onError?: (error: unknown, operation: string) => void;
}

export class FileJanitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(private readonly options: FileJanitorOptions) {}

  public start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMilliseconds ?? 15_000;
    this.timer = setInterval(
      () => void this.runOnce().catch((error) => this.report(error, "janitor run")),
      interval
    );
    this.timer.unref();
    void this.runOnce().catch((error) => this.report(error, "janitor startup run"));
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.expireSessions();
      await this.expireQuotes();
      await this.expireMobileClients();
      await this.markInterruptedUploads();
      await this.cleanPendingFiles();
      await this.purgeExpiredIdempotencyRecords();
    } finally {
      this.running = false;
    }
  }

  private async expireSessions(): Promise<void> {
    const now = this.options.clock.now();
    const sessions = await this.options.database.printSession.findMany({
      where: {
        state: { in: [...EXPIRABLE_STATES] },
        OR: [{ idleExpiresAt: { lte: now } }, { hardExpiresAt: { lte: now } }]
      },
      select: { id: true },
      orderBy: { idleExpiresAt: "asc" },
      take: 25
    });

    for (const candidate of sessions) {
      try {
        await this.options.database.$transaction(async (transaction) => {
          const rows = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "print_sessions" WHERE "id" = ${candidate.id}::uuid FOR UPDATE
        `;
          if (rows.length === 0) return;
          const session = await transaction.printSession.findUnique({
            where: { id: candidate.id }
          });
          if (
            !session ||
            !EXPIRABLE_STATES.includes(session.state as (typeof EXPIRABLE_STATES)[number]) ||
            (now.getTime() < session.idleExpiresAt.getTime() &&
              now.getTime() < session.hardExpiresAt.getTime())
          ) {
            return;
          }

          const nextVersion = session.stateVersion + 1;
          // An expiring session may still hold an open provider intent. It is
          // closed here so the ledger cannot keep a live charge against a
          // session nobody can complete.
          const release = await releaseSessionPayments(transaction, {
            sessionId: session.id,
            now,
            startingSequence: session.eventSequence,
            newId: () => this.options.random.uuid(now),
            nextState: "EXPIRED",
            nextVersion
          });
          const invalidation = await invalidateSessionPricing(transaction, {
            sessionId: session.id,
            reason: "SESSION_TERMINAL",
            now,
            startingSequence: release.nextSequence,
            newEventId: () => this.options.random.uuid(now),
            clearSettingsRevision: false
          });
          const nextSequence = invalidation.nextSequence + 1;
          const reason =
            now.getTime() >= session.hardExpiresAt.getTime() ? "HARD_TIMEOUT" : "IDLE_TIMEOUT";
          await transaction.printSession.update({
            where: { id: session.id },
            data: {
              state: "EXPIRED",
              stateVersion: nextVersion,
              eventSequence: nextSequence,
              terminalReason: reason,
              expiredAt: now,
              updatedAt: now
            }
          });
          await Promise.all([
            transaction.sessionUploadGrant.updateMany({
              where: { sessionId: session.id, status: { in: ["ACTIVE", "CLAIMED"] } },
              data: { status: "EXPIRED", revokedAt: now }
            }),
            transaction.mobileClient.updateMany({
              where: { sessionId: session.id, status: "ACTIVE" },
              data: { status: "EXPIRED", revokedAt: now }
            }),
            scheduleSessionFilesForCleanup(transaction, session.id, now),
            transaction.auditEvent.create({
              data: {
                id: this.options.random.uuid(now),
                occurredAt: now,
                actorType: "SYSTEM",
                actorId: "file-janitor",
                kioskId: session.kioskId,
                sessionId: session.id,
                action: "session.expired",
                outcome: "SUCCESS",
                metadata: { previousState: session.state, version: nextVersion, reason }
              }
            }),
            transaction.outboxEvent.create({
              data: {
                id: this.options.random.uuid(now),
                aggregateType: "PRINT_SESSION",
                aggregateId: session.id,
                sequence: nextSequence,
                type: "session.expired",
                payload: { sessionId: session.id, state: "EXPIRED", version: nextVersion }
              }
            })
          ]);
        });
      } catch (error) {
        this.report(error, "session expiry");
      }
    }
  }

  /**
   * A quote that reached its deadline stops being a live price. The kiosk
   * already treats the deadline as authoritative, so this only settles the
   * stored row and releases the session's active-quote pointer; the customer
   * simply asks for a new price.
   */
  private async expireQuotes(): Promise<void> {
    const now = this.options.clock.now();
    const expired = await this.options.database.priceQuote.findMany({
      where: {
        status: "ACTIVE",
        expiresAt: { lte: now },
        // A quote being paid is left alone. Its payment window was cut to fit
        // inside its deadline, so the payment settles first; retiring the
        // price underneath an in-flight capture would turn a valid payment
        // into a compensation case for no reason.
        payments: { none: { status: { in: [...OPEN_PAYMENT_STATUSES] } } }
      },
      select: { id: true },
      orderBy: { expiresAt: "asc" },
      take: 100
    });
    if (expired.length === 0) return;

    const ids = expired.map((quote) => quote.id);
    await this.options.database.$transaction([
      this.options.database.printSession.updateMany({
        where: { activeQuoteId: { in: ids } },
        data: { activeQuoteId: null }
      }),
      this.options.database.priceQuote.updateMany({
        where: { id: { in: ids }, status: "ACTIVE" },
        data: { status: "EXPIRED", invalidatedAt: now }
      })
    ]);
  }

  private async expireMobileClients(): Promise<void> {
    const now = this.options.clock.now();
    await this.options.database.mobileClient.updateMany({
      where: { status: "ACTIVE", expiresAt: { lte: now } },
      data: { status: "EXPIRED", revokedAt: now }
    });
  }

  private async markInterruptedUploads(): Promise<void> {
    const now = this.options.clock.now();
    // Give an in-process uploader time to observe its own AbortSignal and stop
    // before the reconciler deletes the same key. A crashed uploader is still
    // recovered promptly, but cleanup never races the configured request limit.
    const staleAt = new Date(now.getTime() - (this.options.uploadTimeoutSeconds + 30) * 1_000);
    await this.options.database.uploadedFile.updateMany({
      where: { status: "UPLOADING", updatedAt: { lte: staleAt } },
      data: {
        status: "DELETE_PENDING",
        rejectionCode: "UPLOAD_FAILED",
        cleanupDueAt: now,
        cleanupErrorCode: null,
        updatedAt: now
      }
    });
  }

  private async cleanPendingFiles(): Promise<void> {
    const now = this.options.clock.now();
    const pending = await this.options.database.uploadedFile.findMany({
      where: {
        status: { in: ["DELETE_PENDING", "DELETING"] },
        OR: [{ cleanupDueAt: null }, { cleanupDueAt: { lte: now } }]
      },
      orderBy: { cleanupDueAt: "asc" },
      take: 25
    });

    for (const file of pending) {
      try {
        const claimed = await this.options.database.uploadedFile.updateMany({
          where: {
            id: file.id,
            status: file.status,
            updatedAt: file.updatedAt,
            cleanupAttempts: file.cleanupAttempts
          },
          data: {
            status: "DELETING",
            processingGeneration: { increment: 1 },
            processingClaimToken: null,
            processingLeaseExpiresAt: null,
            processingEnqueuedAt: null,
            cleanupAttempts: { increment: 1 },
            cleanupDueAt: now,
            updatedAt: now
          }
        });
        if (claimed.count !== 1) continue;

        try {
          const derivatives = await this.options.database.fileDerivative.findMany({
            where: { fileId: file.id, status: { not: "DELETED" } },
            select: { objectKey: true }
          });
          const keys = [
            ...new Set([
              ...(file.quarantineObjectKey ? [file.quarantineObjectKey] : []),
              ...derivatives.map((derivative) => derivative.objectKey)
            ])
          ];
          await deleteObjectKeys(this.options.objectStore, keys);
          await this.finishCleanup(file.id, file.sessionId, now);
        } catch {
          const attempts = file.cleanupAttempts + 1;
          await this.options.database.uploadedFile.updateMany({
            where: { id: file.id, status: "DELETING" },
            data: {
              status: "DELETE_PENDING",
              cleanupAttempts: attempts,
              cleanupDueAt: addSeconds(now, Math.min(3_600, 2 ** Math.min(attempts, 10))),
              cleanupErrorCode: "OBJECT_DELETE_FAILED",
              updatedAt: now
            }
          });
        }
      } catch (error) {
        this.report(error, "object cleanup");
      }
    }
  }

  private async purgeExpiredIdempotencyRecords(): Promise<void> {
    await this.options.database.idempotencyRecord.deleteMany({
      where: { expiresAt: { lte: this.options.clock.now() } }
    });
  }

  private async finishCleanup(fileId: string, sessionId: string, now: Date): Promise<void> {
    await this.options.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "print_sessions" WHERE "id" = ${sessionId}::uuid FOR UPDATE
      `;
      if (rows.length === 0) return;

      const session = await transaction.printSession.findUnique({
        where: { id: sessionId },
        select: { id: true, kioskId: true, eventSequence: true }
      });
      const file = await transaction.uploadedFile.findFirst({
        where: { id: fileId, sessionId }
      });
      if (!session || !file || (file.status !== "DELETE_PENDING" && file.status !== "DELETING")) {
        return;
      }

      const customerDeletion = Boolean(file.deleteRequestedAt);
      const targetStatus = customerDeletion ? "DELETED" : "REJECTED";
      await transaction.filePage.deleteMany({ where: { fileId: file.id } });
      await transaction.fileDerivative.deleteMany({ where: { fileId: file.id } });
      const updated = await transaction.uploadedFile.updateMany({
        where: {
          id: file.id,
          sessionId: session.id,
          status: { in: ["DELETE_PENDING", "DELETING"] }
        },
        data: customerDeletion
          ? {
              status: targetStatus,
              quarantineObjectKey: null,
              contentSha256: null,
              pageCount: null,
              processingClaimToken: null,
              processingLeaseExpiresAt: null,
              cleanupDueAt: null,
              cleanupErrorCode: null,
              deletedAt: now,
              updatedAt: now
            }
          : {
              status: targetStatus,
              quarantineObjectKey: null,
              contentSha256: null,
              pageCount: null,
              processingClaimToken: null,
              processingLeaseExpiresAt: null,
              cleanupDueAt: null,
              cleanupErrorCode: null,
              updatedAt: now
            }
      });
      if (updated.count !== 1) return;

      const nextSequence = session.eventSequence + 1;
      const payload = customerDeletion
        ? { sessionId: session.id, fileId: file.id }
        : {
            sessionId: session.id,
            file: uploadedFileSnapshotSchema.parse({
              id: file.id,
              ordinal: file.ordinal,
              status: targetStatus,
              kind: file.kind,
              sizeBytes: file.sizeBytes,
              processingRevision: file.processingRevision,
              pageCount: null,
              rejectionCode: file.rejectionCode ?? "PROCESSING_FAILED",
              createdAt: file.createdAt.toISOString()
            })
          };
      await Promise.all([
        transaction.printSession.update({
          where: { id: session.id },
          data: { eventSequence: nextSequence, updatedAt: now }
        }),
        transaction.outboxEvent.create({
          data: {
            id: this.options.random.uuid(now),
            aggregateType: "PRINT_SESSION",
            aggregateId: session.id,
            sequence: nextSequence,
            type: customerDeletion ? "file.deleted" : "file.rejected",
            payload
          }
        }),
        ...(customerDeletion
          ? [
              transaction.auditEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  occurredAt: now,
                  actorType: "SYSTEM",
                  actorId: "file-janitor",
                  kioskId: session.kioskId,
                  sessionId: session.id,
                  action: "file.deleted",
                  outcome: "SUCCESS",
                  metadata: { fileId: file.id, finalizedDeferredCleanup: true }
                }
              }),
              transaction.idempotencyRecord.updateMany({
                where: {
                  action: `files.delete:${session.id}:${file.id}`,
                  resourceId: file.id,
                  responseStatus: 202
                },
                data: { responseStatus: 204, responseBody: {} }
              })
            ]
          : [])
      ]);
    });
  }

  private report(error: unknown, operation: string): void {
    this.options.onError?.(error, operation);
  }
}

async function deleteObjectKeys(objectStore: ObjectStore, keys: readonly string[]): Promise<void> {
  const batchSize = 5;
  for (let index = 0; index < keys.length; index += batchSize) {
    await Promise.all(
      keys.slice(index, index + batchSize).map((key) => objectStore.deleteObject({ key }))
    );
  }
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

async function scheduleSessionFilesForCleanup(
  transaction: Prisma.TransactionClient,
  sessionId: string,
  now: Date
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
}
