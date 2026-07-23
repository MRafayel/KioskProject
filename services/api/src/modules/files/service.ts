import type { Readable } from "node:stream";

import {
  listUploadedFilesResponseSchema,
  uploadFileResponseSchema,
  type ListUploadedFilesResponse,
  type SessionState,
  type UploadedFileSnapshot,
  type UploadFileResponse
} from "@printing-kiosk/contracts";
import { Prisma, type PrismaClient } from "@printing-kiosk/database";
import {
  PreliminaryFileValidationError,
  validatePreliminaryFile
} from "@printing-kiosk/file-processing";

import type { MobileIdentity } from "../mobile-access/service.js";
import type { Clock, RandomSource } from "../sessions/crypto.js";
import { digestIdempotencyKey, hashRequest } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import type { ObjectStore } from "./object-store.js";
import { UploadInspectionTransform, UploadSizeLimitError } from "./upload-inspection.js";

const ACTIVE_FILE_STATUSES = ["UPLOADING", "QUARANTINED", "DELETING", "DELETE_PENDING"] as const;
const VISIBLE_FILE_STATUSES = [...ACTIVE_FILE_STATUSES, "REJECTED"] as const;
const UPLOADABLE_STATES: SessionState[] = ["WAITING_FOR_UPLOAD"];
const MAX_TRANSACTION_ATTEMPTS = 4;

interface FileServiceOptions {
  database: PrismaClient;
  objectStore: ObjectStore;
  clock: Clock;
  random: RandomSource;
  idempotencyPepper: string;
  idempotencyTtlHours: number;
  maxFileBytes: number;
  maxSessionBytes: number;
  maxFiles: number;
  uploadTimeoutSeconds: number;
}

interface UploadInput {
  identity: MobileIdentity;
  clientFileId: string;
  idempotencyKey: string;
  declaredBytes: number;
  declaredMime: string;
  originalFilename: string;
  stream: Readable;
  wasTruncated: () => boolean;
  requestId: string;
  signal?: AbortSignal;
  afterStreamConsumed?: () => Promise<void>;
}

interface DeleteInput {
  identity: MobileIdentity;
  fileId: string;
  idempotencyKey: string;
  requestId: string;
}

interface ReservedUpload {
  replay?: UploadFileResponse;
  file: {
    id: string;
    sessionId: string;
    ordinal: number;
    objectKey: string;
    createdAt: Date;
  };
  action: string;
  requestHash: string;
}

export class FileService {
  public constructor(private readonly options: FileServiceOptions) {}

  public async upload(input: UploadInput): Promise<UploadFileResponse> {
    let reservation: ReservedUpload;
    try {
      reservation = await this.reserveUpload(input);
    } catch (error) {
      input.stream.resume();
      throw error;
    }
    if (reservation.replay) {
      input.stream.resume();
      return reservation.replay;
    }

    const inspection = new UploadInspectionTransform({ maxBytes: this.options.maxFileBytes });
    input.stream.pipe(inspection);
    const uploadStartedAt = this.options.clock.now();
    const uploadDeadline = Math.min(
      uploadStartedAt.getTime() + this.options.uploadTimeoutSeconds * 1_000,
      input.identity.expiresAt.getTime(),
      input.identity.session.idleExpiresAt.getTime(),
      input.identity.session.hardExpiresAt.getTime()
    );
    const timeoutSignal = AbortSignal.timeout(
      Math.max(1, uploadDeadline - uploadStartedAt.getTime())
    );
    const uploadSignal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    const abortStreams = () => {
      const error = asError(uploadSignal.reason, "The upload was interrupted.");
      input.stream.destroy(error);
      inspection.destroy(error);
    };
    const abortFromSourceError = (error: Error) => inspection.destroy(error);
    input.stream.once("error", abortFromSourceError);
    uploadSignal.addEventListener("abort", abortStreams, { once: true });

    try {
      await this.options.objectStore.putObject({
        key: reservation.file.objectKey,
        body: inspection,
        contentType: "application/octet-stream",
        signal: uploadSignal
      });
      uploadSignal.throwIfAborted();
      const inspected = inspection.getResult();
      if (input.wasTruncated()) throw new UploadSizeLimitError(this.options.maxFileBytes);
      if (inspected.sizeBytes !== input.declaredBytes) {
        throw new ApiError(
          400,
          "FILE_SIZE_MISMATCH",
          "The received file size does not match the declared size."
        );
      }

      const validated = validatePreliminaryFile({
        declaredMime: input.declaredMime,
        filename: input.originalFilename,
        firstBytes: inspected.firstBytes,
        sizeBytes: inspected.sizeBytes
      });
      if (input.afterStreamConsumed) {
        await waitForAbortable(input.afterStreamConsumed(), uploadSignal);
      }

      return await this.finalizeUpload({
        input,
        reservation,
        sizeBytes: inspected.sizeBytes,
        sha256: Buffer.from(inspected.sha256Digest).toString("hex"),
        kind: validated.kind,
        detectedMime: validated.detectedMime,
        extension: validated.extension
      });
    } catch (error) {
      input.stream.unpipe(inspection);
      input.stream.resume();
      inspection.destroy();
      const rejection = mapUploadFailure(error);
      await this.rejectAndClean(
        reservation.file.id,
        reservation.file.sessionId,
        reservation.file.objectKey,
        rejection.code
      );
      throw rejection.error;
    } finally {
      input.stream.off("error", abortFromSourceError);
      uploadSignal.removeEventListener("abort", abortStreams);
    }
  }

  public async list(sessionId: string): Promise<ListUploadedFilesResponse> {
    const files = await this.options.database.uploadedFile.findMany({
      where: {
        sessionId,
        status: { in: [...VISIBLE_FILE_STATUSES] }
      },
      orderBy: { ordinal: "asc" }
    });
    return listUploadedFilesResponseSchema.parse({ items: files.map(toFileSnapshot) });
  }

  public async remove(input: DeleteInput): Promise<void> {
    const action = `files.delete:${input.identity.sessionId}:${input.fileId}`;
    const requestHash = hashRequest({
      sessionId: input.identity.sessionId,
      fileId: input.fileId
    });
    const now = this.options.clock.now();

    const prepared = await this.options.database.$transaction(
      async (transaction) => {
        await lockSession(transaction, input.identity.sessionId);
        const replay = await findIdempotency(
          transaction,
          input.identity.clientId,
          action,
          input.idempotencyKey,
          this.options.idempotencyPepper,
          now
        );
        if (replay) {
          assertMatchingRequest(replay.requestHash, requestHash);
          return { replay: true as const, objectKey: null };
        }

        const file = await transaction.uploadedFile.findFirst({
          where: { id: input.fileId, sessionId: input.identity.sessionId }
        });
        if (!file) throw hiddenFile();
        if (file.status === "DELETED") {
          await storeDeleteIdempotency(transaction, {
            id: this.options.random.uuid(now),
            actorId: input.identity.clientId,
            action,
            keyDigest: digestIdempotencyKey(
              input.identity.clientId,
              action,
              input.idempotencyKey,
              this.options.idempotencyPepper
            ),
            requestHash,
            resourceId: file.id,
            now,
            expiresAt: addHours(now, this.options.idempotencyTtlHours)
          });
          return { replay: true as const, objectKey: null };
        }
        if (file.status === "REJECTED") {
          const session = await transaction.printSession.findUniqueOrThrow({
            where: { id: input.identity.sessionId }
          });
          const updated = await transaction.uploadedFile.updateMany({
            where: { id: file.id, sessionId: session.id, status: "REJECTED" },
            data: { status: "DELETED", deletedAt: now, updatedAt: now }
          });
          if (updated.count !== 1) throw hiddenFile();
          const nextSequence = session.eventSequence + 1;
          await Promise.all([
            transaction.printSession.update({
              where: { id: session.id },
              data: { eventSequence: nextSequence, updatedAt: now }
            }),
            transaction.auditEvent.create({
              data: {
                id: this.options.random.uuid(now),
                occurredAt: now,
                actorType: "MOBILE",
                actorId: input.identity.clientId,
                kioskId: session.kioskId,
                sessionId: session.id,
                action: "file.deleted",
                outcome: "SUCCESS",
                requestId: input.requestId,
                metadata: { fileId: file.id, previousStatus: "REJECTED" }
              }
            }),
            transaction.outboxEvent.create({
              data: {
                id: this.options.random.uuid(now),
                aggregateType: "PRINT_SESSION",
                aggregateId: session.id,
                sequence: nextSequence,
                type: "file.deleted",
                payload: { sessionId: session.id, fileId: file.id }
              }
            }),
            storeDeleteIdempotency(transaction, {
              id: this.options.random.uuid(now),
              actorId: input.identity.clientId,
              action,
              keyDigest: digestIdempotencyKey(
                input.identity.clientId,
                action,
                input.idempotencyKey,
                this.options.idempotencyPepper
              ),
              requestHash,
              resourceId: file.id,
              now,
              expiresAt: addHours(now, this.options.idempotencyTtlHours)
            })
          ]);
          return { replay: true as const, objectKey: null };
        }
        if (file.status === "UPLOADING") {
          throw new ApiError(409, "FILE_UPLOAD_IN_PROGRESS", "The file is still uploading.");
        }
        if (!file.quarantineObjectKey) throw hiddenFile();

        await transaction.uploadedFile.update({
          where: { id: file.id },
          data: {
            status: "DELETING",
            deleteRequestedAt: now,
            cleanupDueAt: now,
            cleanupErrorCode: null,
            updatedAt: now
          }
        });
        return { replay: false as const, objectKey: file.quarantineObjectKey };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    if (prepared.replay || !prepared.objectKey) return;

    try {
      await this.options.objectStore.deleteObject({ key: prepared.objectKey });
    } catch {
      await this.options.database.uploadedFile.updateMany({
        where: { id: input.fileId, status: "DELETING" },
        data: {
          status: "DELETE_PENDING",
          cleanupAttempts: { increment: 1 },
          cleanupDueAt: addSeconds(now, 15),
          cleanupErrorCode: "OBJECT_DELETE_FAILED"
        }
      });
      throw new ApiError(503, "FILE_DELETE_DEFERRED", "The file is scheduled for secure cleanup.");
    }

    await this.finalizeDeletion(input, action, requestHash, now);
  }

  private async reserveUpload(input: UploadInput): Promise<ReservedUpload> {
    if (input.declaredBytes < 1) {
      throw new ApiError(400, "EMPTY_FILE", "Choose a non-empty file.");
    }
    if (input.declaredBytes > this.options.maxFileBytes) {
      throw new ApiError(413, "FILE_TOO_LARGE", "The selected file is too large.");
    }

    const action = `files.upload:${input.identity.sessionId}:${input.clientFileId}`;
    const requestHash = hashRequest({
      sessionId: input.identity.sessionId,
      clientFileId: input.clientFileId,
      declaredBytes: input.declaredBytes,
      declaredMime: input.declaredMime
    });

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            const now = this.options.clock.now();
            await lockSession(transaction, input.identity.sessionId);
            const replay = await findIdempotency(
              transaction,
              input.identity.clientId,
              action,
              input.idempotencyKey,
              this.options.idempotencyPepper,
              now
            );
            if (replay) {
              assertMatchingRequest(replay.requestHash, requestHash);
              return {
                replay: uploadFileResponseSchema.parse(replay.responseBody),
                file: {
                  id: replay.resourceId ?? "",
                  sessionId: input.identity.sessionId,
                  ordinal: 0,
                  objectKey: "",
                  createdAt: replay.createdAt
                },
                action,
                requestHash
              };
            }

            const session = await transaction.printSession.findUnique({
              where: { id: input.identity.sessionId }
            });
            if (!session || session.kioskId !== input.identity.kioskId) throw hiddenSession();
            if (!UPLOADABLE_STATES.includes(session.state as SessionState)) {
              throw new ApiError(
                409,
                "UPLOAD_SESSION_NOT_EDITABLE",
                "This session no longer accepts files."
              );
            }
            if (
              now.getTime() >= session.idleExpiresAt.getTime() ||
              now.getTime() >= session.hardExpiresAt.getTime()
            ) {
              throw new ApiError(410, "UPLOAD_SESSION_EXPIRED", "This upload session has expired.");
            }

            const sessionFiles = await transaction.uploadedFile.findMany({
              where: { sessionId: session.id },
              select: { reservedBytes: true, sizeBytes: true, ordinal: true, status: true }
            });
            const activeFiles = sessionFiles.filter((file) =>
              ACTIVE_FILE_STATUSES.includes(file.status as (typeof ACTIVE_FILE_STATUSES)[number])
            );
            if (activeFiles.length >= this.options.maxFiles) {
              throw new ApiError(
                409,
                "FILE_LIMIT_REACHED",
                "Remove the current file before uploading another."
              );
            }
            const allocatedBytes = activeFiles.reduce(
              (sum, file) => sum + (file.sizeBytes ?? file.reservedBytes),
              0
            );
            if (allocatedBytes + input.declaredBytes > this.options.maxSessionBytes) {
              throw new ApiError(413, "SESSION_SIZE_LIMIT_REACHED", "The session is too large.");
            }

            const ordinal =
              sessionFiles.reduce((highest, file) => Math.max(highest, file.ordinal), -1) + 1;
            const fileId = this.options.random.uuid(now);
            const objectKey = `quarantine/v1/${session.id}/${fileId}/${this.options.random.token(24)}`;
            const file = await transaction.uploadedFile.create({
              data: {
                id: fileId,
                sessionId: session.id,
                uploadedByClientId: input.identity.clientId,
                clientFileId: input.clientFileId,
                ordinal,
                displayName: `Document ${ordinal + 1}`,
                status: "UPLOADING",
                declaredMime: input.declaredMime.slice(0, 100),
                reservedBytes: input.declaredBytes,
                quarantineObjectKey: objectKey,
                createdAt: now,
                updatedAt: now
              }
            });
            const nextSequence = session.eventSequence + 1;
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
                  type: "upload.started",
                  payload: { sessionId: session.id, file: toFileSnapshot(file) }
                }
              })
            ]);

            return {
              file: {
                id: file.id,
                sessionId: file.sessionId,
                ordinal: file.ordinal,
                objectKey,
                createdAt: file.createdAt
              },
              action,
              requestHash
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (isRetryableTransactionError(error)) continue;
        throw mapReservationConflict(error);
      }
    }
    throw new ApiError(409, "CONCURRENT_FILE_UPLOAD", "Another upload is already in progress.");
  }

  private async finalizeUpload(input: {
    input: UploadInput;
    reservation: ReservedUpload;
    sizeBytes: number;
    sha256: string;
    kind: "PDF" | "JPEG" | "PNG";
    detectedMime: string;
    extension: string;
  }): Promise<UploadFileResponse> {
    const now = this.options.clock.now();
    return this.options.database.$transaction(
      async (transaction) => {
        await lockSession(transaction, input.reservation.file.sessionId);
        const session = await transaction.printSession.findUniqueOrThrow({
          where: { id: input.reservation.file.sessionId }
        });
        const expired =
          now.getTime() >= session.idleExpiresAt.getTime() ||
          now.getTime() >= session.hardExpiresAt.getTime();
        if (!UPLOADABLE_STATES.includes(session.state as SessionState) || expired) {
          throw new ApiError(
            expired ? 410 : 409,
            expired ? "UPLOAD_SESSION_EXPIRED" : "UPLOAD_SESSION_NOT_EDITABLE",
            "This session no longer accepts files."
          );
        }
        const updated = await transaction.uploadedFile.updateMany({
          where: {
            id: input.reservation.file.id,
            sessionId: input.reservation.file.sessionId,
            uploadedByClientId: input.input.identity.clientId,
            status: "UPLOADING",
            quarantineObjectKey: input.reservation.file.objectKey
          },
          data: {
            status: "QUARANTINED",
            kind: input.kind,
            detectedMime: input.detectedMime,
            extension: input.extension,
            sizeBytes: input.sizeBytes,
            reservedBytes: input.sizeBytes,
            contentSha256: input.sha256,
            quarantinedAt: now,
            updatedAt: now
          }
        });
        if (updated.count !== 1) {
          throw new ApiError(409, "FILE_UPLOAD_STATE_CHANGED", "The upload state changed.");
        }

        const stored = await transaction.uploadedFile.findUniqueOrThrow({
          where: { id: input.reservation.file.id }
        });
        const response = uploadFileResponseSchema.parse({ file: toFileSnapshot(stored) });
        const nextSequence = session.eventSequence + 1;
        await Promise.all([
          transaction.printSession.update({
            where: { id: session.id },
            data: { eventSequence: nextSequence, updatedAt: now }
          }),
          transaction.auditEvent.create({
            data: {
              id: this.options.random.uuid(now),
              occurredAt: now,
              actorType: "MOBILE",
              actorId: input.input.identity.clientId,
              kioskId: session.kioskId,
              sessionId: session.id,
              action: "file.quarantined",
              outcome: "SUCCESS",
              requestId: input.input.requestId,
              metadata: {
                fileId: stored.id,
                kind: stored.kind,
                sizeBytes: stored.sizeBytes
              }
            }
          }),
          transaction.outboxEvent.create({
            data: {
              id: this.options.random.uuid(now),
              aggregateType: "PRINT_SESSION",
              aggregateId: session.id,
              sequence: nextSequence,
              type: "file.uploaded",
              payload: { sessionId: session.id, file: response.file }
            }
          }),
          transaction.idempotencyRecord.create({
            data: {
              id: this.options.random.uuid(now),
              actorId: input.input.identity.clientId,
              action: input.reservation.action,
              keyDigest: digestIdempotencyKey(
                input.input.identity.clientId,
                input.reservation.action,
                input.input.idempotencyKey,
                this.options.idempotencyPepper
              ),
              requestHash: input.reservation.requestHash,
              responseStatus: 202,
              responseBody: response,
              resourceId: stored.id,
              createdAt: now,
              expiresAt: addHours(now, this.options.idempotencyTtlHours)
            }
          })
        ]);
        return response;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private async rejectAndClean(
    fileId: string,
    sessionId: string,
    objectKey: string,
    rejectionCode: string
  ) {
    const now = this.options.clock.now();
    const claimed = await this.options.database.uploadedFile.updateMany({
      where: { id: fileId, status: "UPLOADING" },
      data: {
        status: "DELETE_PENDING",
        rejectionCode,
        cleanupDueAt: now,
        cleanupErrorCode: null,
        updatedAt: now
      }
    });
    if (claimed.count !== 1) return;

    try {
      await this.options.objectStore.deleteObject({ key: objectKey });
      await this.options.database.$transaction(
        async (transaction) => {
          await lockSession(transaction, sessionId);
          const session = await transaction.printSession.findUniqueOrThrow({
            where: { id: sessionId }
          });
          const updated = await transaction.uploadedFile.updateMany({
            where: { id: fileId, sessionId, status: "DELETE_PENDING" },
            data: {
              status: "REJECTED",
              quarantineObjectKey: null,
              contentSha256: null,
              cleanupDueAt: null,
              cleanupErrorCode: null,
              updatedAt: now
            }
          });
          if (updated.count !== 1) return;
          const file = await transaction.uploadedFile.findUniqueOrThrow({
            where: { id: fileId }
          });
          const nextSequence = session.eventSequence + 1;
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
                type: "file.rejected",
                payload: { sessionId: session.id, file: toFileSnapshot(file) }
              }
            })
          ]);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch {
      await this.options.database.uploadedFile.updateMany({
        where: { id: fileId, status: "DELETE_PENDING" },
        data: {
          cleanupAttempts: { increment: 1 },
          cleanupDueAt: addSeconds(now, 15),
          cleanupErrorCode: "OBJECT_DELETE_FAILED",
          updatedAt: now
        }
      });
    }
  }

  private async finalizeDeletion(
    input: DeleteInput,
    action: string,
    requestHash: string,
    now: Date
  ): Promise<void> {
    await this.options.database.$transaction(
      async (transaction) => {
        await lockSession(transaction, input.identity.sessionId);
        const session = await transaction.printSession.findUniqueOrThrow({
          where: { id: input.identity.sessionId }
        });
        const updated = await transaction.uploadedFile.updateMany({
          where: { id: input.fileId, sessionId: session.id, status: "DELETING" },
          data: {
            status: "DELETED",
            quarantineObjectKey: null,
            contentSha256: null,
            cleanupDueAt: null,
            cleanupErrorCode: null,
            deletedAt: now,
            updatedAt: now
          }
        });
        if (updated.count !== 1) return;

        const nextSequence = session.eventSequence + 1;
        await Promise.all([
          transaction.printSession.update({
            where: { id: session.id },
            data: { eventSequence: nextSequence, updatedAt: now }
          }),
          transaction.auditEvent.create({
            data: {
              id: this.options.random.uuid(now),
              occurredAt: now,
              actorType: "MOBILE",
              actorId: input.identity.clientId,
              kioskId: session.kioskId,
              sessionId: session.id,
              action: "file.deleted",
              outcome: "SUCCESS",
              requestId: input.requestId,
              metadata: { fileId: input.fileId }
            }
          }),
          transaction.outboxEvent.create({
            data: {
              id: this.options.random.uuid(now),
              aggregateType: "PRINT_SESSION",
              aggregateId: session.id,
              sequence: nextSequence,
              type: "file.deleted",
              payload: { sessionId: session.id, fileId: input.fileId }
            }
          }),
          storeDeleteIdempotency(transaction, {
            id: this.options.random.uuid(now),
            actorId: input.identity.clientId,
            action,
            keyDigest: digestIdempotencyKey(
              input.identity.clientId,
              action,
              input.idempotencyKey,
              this.options.idempotencyPepper
            ),
            requestHash,
            resourceId: input.fileId,
            now,
            expiresAt: addHours(now, this.options.idempotencyTtlHours)
          })
        ]);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }
}

type IdempotencyClient = Pick<PrismaClient, "idempotencyRecord"> | Prisma.TransactionClient;

async function findIdempotency(
  client: IdempotencyClient,
  actorId: string,
  action: string,
  key: string,
  pepper: string,
  now: Date
) {
  const keyDigest = digestIdempotencyKey(actorId, action, key, pepper);
  const record = await client.idempotencyRecord.findUnique({
    where: {
      actorId_action_keyDigest: {
        actorId,
        action,
        keyDigest
      }
    }
  });
  if (!record || record.expiresAt.getTime() > now.getTime()) return record;
  await client.idempotencyRecord.deleteMany({
    where: { id: record.id, expiresAt: { lte: now } }
  });
  return null;
}

async function storeDeleteIdempotency(
  transaction: Prisma.TransactionClient,
  input: {
    id: string;
    actorId: string;
    action: string;
    keyDigest: string;
    requestHash: string;
    resourceId: string;
    now: Date;
    expiresAt: Date;
  }
): Promise<void> {
  await transaction.idempotencyRecord.create({
    data: {
      id: input.id,
      actorId: input.actorId,
      action: input.action,
      keyDigest: input.keyDigest,
      requestHash: input.requestHash,
      responseStatus: 204,
      responseBody: {},
      resourceId: input.resourceId,
      createdAt: input.now,
      expiresAt: input.expiresAt
    }
  });
}

async function lockSession(
  transaction: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "print_sessions" WHERE "id" = ${sessionId}::uuid FOR UPDATE
  `;
  if (rows.length === 0) throw hiddenSession();
}

function toFileSnapshot(file: {
  id: string;
  ordinal: number;
  status: string;
  kind: string | null;
  sizeBytes: number | null;
  createdAt: Date;
}): UploadedFileSnapshot {
  return {
    id: file.id,
    ordinal: file.ordinal,
    status: file.status as UploadedFileSnapshot["status"],
    kind: file.kind as UploadedFileSnapshot["kind"],
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt.toISOString()
  };
}

function mapUploadFailure(error: unknown): { code: string; error: ApiError } {
  if (error instanceof ApiError) return { code: error.code, error };
  if (error instanceof UploadSizeLimitError) {
    return {
      code: error.code,
      error: new ApiError(413, error.code, "The selected file is too large.")
    };
  }
  if (error instanceof PreliminaryFileValidationError) {
    return {
      code: error.code,
      error: new ApiError(
        error.code === "EMPTY_FILE" ? 400 : 415,
        error.code,
        error.code === "EMPTY_FILE"
          ? "Choose a non-empty file."
          : "The file type or contents are not supported."
      )
    };
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return {
      code: "UPLOAD_TIMEOUT",
      error: new ApiError(408, "UPLOAD_TIMEOUT", "The upload took too long.")
    };
  }
  return {
    code: "UPLOAD_INTERRUPTED",
    error: new ApiError(503, "UPLOAD_INTERRUPTED", "The upload was interrupted. Please retry.")
  };
}

function assertMatchingRequest(stored: string, current: string): void {
  if (stored !== current) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used with a different request."
    );
  }
}

function mapReservationConflict(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return new ApiError(409, "CONCURRENT_FILE_UPLOAD", "Another upload is already in progress.");
  }
  return error;
}

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function hiddenSession(): ApiError {
  return new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
}

function hiddenFile(): ApiError {
  return new ApiError(404, "FILE_NOT_FOUND", "File not found.");
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}

function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(asError(signal.reason, "The upload was interrupted."));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(asError(signal.reason, "The upload was interrupted."));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(asError(error, "The upload failed."));
      }
    );
  });
}
