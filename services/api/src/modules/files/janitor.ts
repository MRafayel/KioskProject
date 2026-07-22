import type { PrismaClient } from "@printing-kiosk/database";

import type { Clock, RandomSource } from "../sessions/crypto.js";
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
          const nextSequence = session.eventSequence + 1;
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
            transaction.uploadedFile.updateMany({
              where: {
                sessionId: session.id,
                quarantineObjectKey: { not: null },
                status: { in: ["QUARANTINED", "DELETE_PENDING"] }
              },
              data: {
                status: "DELETE_PENDING",
                deleteRequestedAt: now,
                cleanupDueAt: now,
                cleanupErrorCode: null,
                updatedAt: now
              }
            }),
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
        rejectionCode: "UPLOAD_INTERRUPTED",
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
        if (!file.quarantineObjectKey) {
          await this.finishCleanup(file.id, Boolean(file.deleteRequestedAt), now);
          continue;
        }

        const claimed = await this.options.database.uploadedFile.updateMany({
          where: {
            id: file.id,
            status: file.status,
            updatedAt: file.updatedAt,
            cleanupAttempts: file.cleanupAttempts
          },
          data: {
            status: "DELETING",
            cleanupAttempts: { increment: 1 },
            cleanupDueAt: now,
            updatedAt: now
          }
        });
        if (claimed.count !== 1) continue;

        try {
          await this.options.objectStore.deleteObject({ key: file.quarantineObjectKey });
          await this.finishCleanup(file.id, Boolean(file.deleteRequestedAt), now);
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

  private async finishCleanup(fileId: string, customerDeletion: boolean, now: Date): Promise<void> {
    await this.options.database.uploadedFile.updateMany({
      where: { id: fileId, status: { in: ["DELETE_PENDING", "DELETING"] } },
      data: customerDeletion
        ? {
            status: "DELETED",
            quarantineObjectKey: null,
            contentSha256: null,
            cleanupDueAt: null,
            cleanupErrorCode: null,
            deletedAt: now,
            updatedAt: now
          }
        : {
            status: "REJECTED",
            quarantineObjectKey: null,
            contentSha256: null,
            cleanupDueAt: null,
            cleanupErrorCode: null,
            updatedAt: now
          }
    });
  }

  private report(error: unknown, operation: string): void {
    this.options.onError?.(error, operation);
  }
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}
