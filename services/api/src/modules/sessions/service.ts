import {
  cancelSessionResponseSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  type CancelSessionResponse,
  type CreateSessionResponse,
  type GetSessionResponse,
  type SessionLocale,
  type SessionSnapshot,
  type SessionState
} from "@printing-kiosk/contracts";
import { Prisma, type PrismaClient } from "@printing-kiosk/database";
import { isSessionExpired, SessionDomainError, transitionSession } from "@printing-kiosk/domain";

import type { Clock, RandomSource } from "./crypto.js";
import {
  deriveUploadSecrets,
  digestIdempotencyKey,
  digestUploadValue,
  hashRequest,
  safelyEqualHexDigests
} from "./crypto.js";
import { ApiError } from "./errors.js";

const TERMINAL_STATES: SessionState[] = ["COMPLETED", "CANCELED", "EXPIRED"];
const EXPIRABLE_STATES: SessionState[] = [
  "CREATED",
  "WAITING_FOR_UPLOAD",
  "FILES_UPLOADED",
  "CONFIGURING",
  "AWAITING_PAYMENT"
];
const MAX_TRANSACTION_ATTEMPTS = 5;

interface SessionServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  uploadTokenPepper: string;
  publicUploadOrigin: string;
  idleTtlMinutes: number;
  hardTtlMinutes: number;
  idempotencyTtlHours: number;
}

interface CreateSessionInput {
  kioskId: string;
  credentialId: string;
  locale: SessionLocale;
  idempotencyKey: string;
  requestId: string;
}

interface GetSessionInput {
  kioskId: string;
  sessionId: string;
}

interface CancelSessionInput extends GetSessionInput {
  credentialId: string;
  expectedVersion: number;
  idempotencyKey: string;
  requestId: string;
}

export class SessionService {
  public constructor(private readonly options: SessionServiceOptions) {}

  public async create(input: CreateSessionInput): Promise<CreateSessionResponse> {
    const action = "sessions.create";
    const requestHash = hashRequest({ kioskId: input.kioskId, locale: input.locale });

    let lastRetryReason: "allocation" | "concurrency" = "allocation";

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const now = this.options.clock.now();
      const candidate = this.createCandidate(now, input.idempotencyKey);

      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            await lockKiosk(transaction, input.kioskId);
            await deleteExpiredIdempotencyRecord(
              transaction,
              input.kioskId,
              action,
              input.idempotencyKey,
              this.options.uploadTokenPepper,
              now
            );

            const transactionReplay = await findIdempotencyRecord(
              transaction,
              input.kioskId,
              action,
              input.idempotencyKey,
              this.options.uploadTokenPepper
            );
            if (transactionReplay) {
              assertMatchingRequest(transactionReplay.requestHash, requestHash);
              return this.restoreCreateResponse(
                transaction,
                input.kioskId,
                input.idempotencyKey,
                transactionReplay
              );
            }

            const existing = await transaction.printSession.findFirst({
              where: { kioskId: input.kioskId, state: { notIn: TERMINAL_STATES } },
              orderBy: { createdAt: "desc" }
            });

            if (existing) {
              if (isExpirable(existing.state) && sessionHasExpired(existing, now)) {
                await expireSession(
                  transaction,
                  existing,
                  now,
                  input.credentialId,
                  input.requestId,
                  this.options.random
                );
              } else {
                throw new ApiError(
                  409,
                  "ACTIVE_SESSION_EXISTS",
                  "This kiosk already has an active session.",
                  {
                    sessionId: existing.id,
                    currentState: existing.state
                  }
                );
              }
            }

            const collision = await transaction.sessionUploadGrant.findFirst({
              where: {
                OR: [
                  { tokenDigest: candidate.tokenDigest },
                  { shortCodeDigest: candidate.shortCodeDigest }
                ]
              },
              select: { id: true }
            });
            const publicIdCollision = await transaction.printSession.findUnique({
              where: { publicId: candidate.publicId },
              select: { id: true }
            });
            if (collision || publicIdCollision) throw new AllocationCollisionError();

            const idleExpiresAt = addMinutes(now, this.options.idleTtlMinutes);
            const hardExpiresAt = addMinutes(now, this.options.hardTtlMinutes);
            const session = await transaction.printSession.create({
              data: {
                id: candidate.sessionId,
                publicId: candidate.publicId,
                kioskId: input.kioskId,
                locale: input.locale,
                state: "WAITING_FOR_UPLOAD",
                stateVersion: 1,
                idleExpiresAt,
                hardExpiresAt,
                createdAt: now,
                updatedAt: now
              }
            });

            await transaction.sessionUploadGrant.create({
              data: {
                id: this.options.random.uuid(now),
                sessionId: session.id,
                tokenDigest: candidate.tokenDigest,
                shortCodeDigest: candidate.shortCodeDigest,
                expiresAt: idleExpiresAt,
                createdAt: now
              }
            });

            const response = createSessionResponseSchema.parse({
              session: toSnapshot(session),
              upload: {
                shortCode: candidate.shortCode,
                qrUrl: buildUploadUrl(
                  this.options.publicUploadOrigin,
                  candidate.publicId,
                  candidate.uploadToken
                )
              }
            });

            await Promise.all([
              transaction.auditEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  occurredAt: now,
                  actorType: "KIOSK",
                  actorId: input.credentialId,
                  kioskId: input.kioskId,
                  sessionId: session.id,
                  action: "session.created",
                  outcome: "SUCCESS",
                  requestId: input.requestId,
                  metadata: { locale: input.locale }
                }
              }),
              transaction.outboxEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  aggregateType: "PRINT_SESSION",
                  aggregateId: session.id,
                  sequence: 1,
                  type: "session.created",
                  payload: {
                    sessionId: session.id,
                    kioskId: input.kioskId,
                    state: session.state,
                    version: session.stateVersion
                  }
                }
              }),
              storeIdempotency(transaction, {
                id: this.options.random.uuid(now),
                actorId: input.kioskId,
                action,
                keyDigest: digestIdempotencyKey(
                  input.kioskId,
                  action,
                  input.idempotencyKey,
                  this.options.uploadTokenPepper
                ),
                requestHash,
                responseStatus: 201,
                responseBody: getSessionResponseSchema.parse({ session: response.session }),
                resourceId: session.id,
                now,
                expiresAt: addHours(now, this.options.idempotencyTtlHours)
              })
            ]);

            return response;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (error instanceof AllocationCollisionError || isAllocationConstraintError(error)) {
          lastRetryReason = "allocation";
          continue;
        }
        if (isRetryableTransactionError(error) || isCreateConcurrencyConstraintError(error)) {
          lastRetryReason = "concurrency";
          continue;
        }
        throw mapDatabaseConflict(error);
      }
    }

    if (lastRetryReason === "concurrency") {
      throw new ApiError(
        409,
        "CONCURRENT_SESSION_UPDATE",
        "The session changed concurrently. Please retry."
      );
    }

    throw new ApiError(
      503,
      "SESSION_CODE_ALLOCATION_FAILED",
      "A unique session code could not be allocated. Please retry."
    );
  }

  public async get(input: GetSessionInput): Promise<GetSessionResponse> {
    const session = await this.options.database.printSession.findFirst({
      where: { id: input.sessionId, kioskId: input.kioskId }
    });
    if (!session) throw sessionNotFound();
    if (
      session.state === "EXPIRED" ||
      (isExpirable(session.state) && sessionHasExpired(session, this.options.clock.now()))
    ) {
      throw new ApiError(410, "SESSION_EXPIRED", "This session has expired.");
    }

    return getSessionResponseSchema.parse({ session: toSnapshot(session) });
  }

  public async cancel(input: CancelSessionInput): Promise<CancelSessionResponse> {
    const action = `sessions.cancel:${input.sessionId}`;
    const requestHash = hashRequest({
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion
    });

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            await lockSession(transaction, input.sessionId, input.kioskId);
            const replayNow = this.options.clock.now();
            await deleteExpiredIdempotencyRecord(
              transaction,
              input.kioskId,
              action,
              input.idempotencyKey,
              this.options.uploadTokenPepper,
              replayNow
            );
            const replay = await findIdempotencyRecord(
              transaction,
              input.kioskId,
              action,
              input.idempotencyKey,
              this.options.uploadTokenPepper
            );
            if (replay) {
              assertMatchingRequest(replay.requestHash, requestHash);
              return cancelSessionResponseSchema.parse(replay.responseBody);
            }

            const session = await transaction.printSession.findFirst({
              where: { id: input.sessionId, kioskId: input.kioskId }
            });
            if (!session) throw sessionNotFound();
            if (
              session.state === "EXPIRED" ||
              (isExpirable(session.state) && sessionHasExpired(session, this.options.clock.now()))
            ) {
              throw new ApiError(410, "SESSION_EXPIRED", "This session has expired.");
            }

            const next = transitionSession(
              { state: session.state as SessionState, version: session.stateVersion },
              "CANCELED",
              input.expectedVersion
            );
            const now = this.options.clock.now();
            const update = await transaction.printSession.updateMany({
              where: { id: session.id, stateVersion: input.expectedVersion },
              data: {
                state: next.state,
                stateVersion: next.version,
                terminalReason: "CUSTOMER_CANCELED",
                canceledAt: now,
                updatedAt: now
              }
            });
            if (update.count !== 1) throw staleVersion(input.expectedVersion, session.stateVersion);

            await transaction.sessionUploadGrant.updateMany({
              where: { sessionId: session.id, status: "ACTIVE" },
              data: { status: "REVOKED", revokedAt: now }
            });

            const canceled = await transaction.printSession.findUniqueOrThrow({
              where: { id: session.id }
            });
            const response = cancelSessionResponseSchema.parse({ session: toSnapshot(canceled) });

            await Promise.all([
              transaction.auditEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  occurredAt: now,
                  actorType: "KIOSK",
                  actorId: input.credentialId,
                  kioskId: input.kioskId,
                  sessionId: session.id,
                  action: "session.canceled",
                  outcome: "SUCCESS",
                  requestId: input.requestId,
                  metadata: { previousState: session.state, version: next.version }
                }
              }),
              transaction.outboxEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  aggregateType: "PRINT_SESSION",
                  aggregateId: session.id,
                  sequence: next.version,
                  type: "session.canceled",
                  payload: { sessionId: session.id, state: next.state, version: next.version }
                }
              }),
              storeIdempotency(transaction, {
                id: this.options.random.uuid(now),
                actorId: input.kioskId,
                action,
                keyDigest: digestIdempotencyKey(
                  input.kioskId,
                  action,
                  input.idempotencyKey,
                  this.options.uploadTokenPepper
                ),
                requestHash,
                responseStatus: 200,
                responseBody: response,
                resourceId: session.id,
                now,
                expiresAt: addHours(now, this.options.idempotencyTtlHours)
              })
            ]);

            return response;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (isRetryableTransactionError(error)) continue;
        if (error instanceof SessionDomainError) throw mapDomainError(error);
        throw mapDatabaseConflict(error);
      }
    }

    throw new ApiError(
      409,
      "CONCURRENT_SESSION_UPDATE",
      "The session changed concurrently. Please retry."
    );
  }

  private async restoreCreateResponse(
    client: TransactionClient,
    kioskId: string,
    idempotencyKey: string,
    replay: IdempotencyRecord
  ): Promise<CreateSessionResponse> {
    const stored = getSessionResponseSchema.parse(replay.responseBody);
    if (
      !replay.resourceId ||
      stored.session.id !== replay.resourceId ||
      stored.session.kioskId !== kioskId
    ) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_RECORD_INVALID",
        "The stored session replay record is invalid."
      );
    }

    await lockSession(client, replay.resourceId, kioskId);

    const session = await client.printSession.findFirst({
      where: { id: replay.resourceId, kioskId },
      include: { uploadGrant: true }
    });
    if (!session) throw sessionNotFound();

    const now = this.options.clock.now();
    if (
      sessionHasExpired(session, now) ||
      !session.uploadGrant ||
      session.uploadGrant.status !== "ACTIVE" ||
      session.uploadGrant.revokedAt ||
      now.getTime() >= session.uploadGrant.expiresAt.getTime()
    ) {
      throw new ApiError(410, "SESSION_UPLOAD_GRANT_EXPIRED", "The upload grant has expired.");
    }

    if (
      stored.session.state !== "WAITING_FOR_UPLOAD" ||
      stored.session.version !== 1 ||
      session.state !== stored.session.state ||
      session.stateVersion !== stored.session.version
    ) {
      throw new ApiError(
        409,
        "SESSION_UPLOAD_GRANT_REPLAY_UNAVAILABLE",
        "The upload grant is no longer available for replay.",
        { sessionId: session.id, currentState: session.state, currentVersion: session.stateVersion }
      );
    }

    const currentSnapshot = toSnapshot(session);
    if (!sessionSnapshotsMatch(stored.session, currentSnapshot)) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_RECORD_INVALID",
        "The stored session replay record is invalid."
      );
    }

    const secrets = deriveUploadSecrets(session.id, idempotencyKey, this.options.uploadTokenPepper);
    const tokenDigest = digestUploadValue(secrets.uploadToken, this.options.uploadTokenPepper);
    const shortCodeDigest = digestUploadValue(secrets.shortCode, this.options.uploadTokenPepper);
    if (
      !safelyEqualHexDigests(tokenDigest, session.uploadGrant.tokenDigest) ||
      !safelyEqualHexDigests(shortCodeDigest, session.uploadGrant.shortCodeDigest)
    ) {
      throw new ApiError(
        409,
        "SESSION_UPLOAD_GRANT_REPLAY_UNAVAILABLE",
        "The existing upload grant cannot be safely replayed. Cancel it and start a new session.",
        { sessionId: session.id, currentState: session.state, currentVersion: session.stateVersion }
      );
    }

    return createSessionResponseSchema.parse({
      session: stored.session,
      upload: {
        shortCode: secrets.shortCode,
        qrUrl: buildUploadUrl(
          this.options.publicUploadOrigin,
          session.publicId,
          secrets.uploadToken
        )
      }
    });
  }

  private createCandidate(now: Date, idempotencyKey: string) {
    const sessionId = this.options.random.uuid(now);
    const publicId = `ps_${this.options.random.token(16)}`;
    const { uploadToken, shortCode } = deriveUploadSecrets(
      sessionId,
      idempotencyKey,
      this.options.uploadTokenPepper
    );

    return {
      sessionId,
      publicId,
      uploadToken,
      shortCode,
      tokenDigest: digestUploadValue(uploadToken, this.options.uploadTokenPepper),
      shortCodeDigest: digestUploadValue(shortCode, this.options.uploadTokenPepper)
    };
  }
}

type TransactionClient = Prisma.TransactionClient;
type IdempotencyClient = Pick<PrismaClient, "idempotencyRecord"> | TransactionClient;
type IdempotencyRecord = NonNullable<Awaited<ReturnType<typeof findIdempotencyRecord>>>;

async function lockKiosk(transaction: TransactionClient, kioskId: string): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "kiosks" WHERE "id" = ${kioskId} FOR UPDATE
  `;
  if (rows.length === 0) throw new ApiError(404, "KIOSK_NOT_FOUND", "Kiosk not found.");
}

async function lockSession(
  transaction: TransactionClient,
  sessionId: string,
  kioskId: string
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "print_sessions"
    WHERE "id" = ${sessionId}::uuid AND "kiosk_id" = ${kioskId}
    FOR UPDATE
  `;
  if (rows.length === 0) throw sessionNotFound();
}

async function findIdempotencyRecord(
  client: IdempotencyClient,
  actorId: string,
  action: string,
  key: string,
  pepper: string
) {
  const keyDigest = digestIdempotencyKey(actorId, action, key, pepper);
  return client.idempotencyRecord.findUnique({
    where: { actorId_action_keyDigest: { actorId, action, keyDigest } }
  });
}

async function deleteExpiredIdempotencyRecord(
  transaction: TransactionClient,
  actorId: string,
  action: string,
  key: string,
  pepper: string,
  now: Date
): Promise<void> {
  await transaction.idempotencyRecord.deleteMany({
    where: {
      actorId,
      action,
      keyDigest: digestIdempotencyKey(actorId, action, key, pepper),
      expiresAt: { lte: now }
    }
  });
}

function assertMatchingRequest(storedHash: string, requestHash: string): void {
  if (storedHash !== requestHash) {
    throw new ApiError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used with a different request."
    );
  }
}

async function storeIdempotency(
  transaction: TransactionClient,
  input: {
    id: string;
    actorId: string;
    action: string;
    keyDigest: string;
    requestHash: string;
    responseStatus: number;
    responseBody: GetSessionResponse | CancelSessionResponse;
    resourceId: string;
    now: Date;
    expiresAt: Date;
  }
) {
  return transaction.idempotencyRecord.create({
    data: {
      id: input.id,
      actorId: input.actorId,
      action: input.action,
      keyDigest: input.keyDigest,
      requestHash: input.requestHash,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
      resourceId: input.resourceId,
      createdAt: input.now,
      expiresAt: input.expiresAt
    }
  });
}

async function expireSession(
  transaction: TransactionClient,
  session: {
    id: string;
    kioskId: string;
    state: string;
    stateVersion: number;
  },
  now: Date,
  credentialId: string,
  requestId: string,
  random: RandomSource
): Promise<void> {
  const next = transitionSession(
    { state: session.state as SessionState, version: session.stateVersion },
    "EXPIRED",
    session.stateVersion
  );

  await transaction.printSession.update({
    where: { id: session.id },
    data: {
      state: next.state,
      stateVersion: next.version,
      terminalReason: "IDLE_TIMEOUT",
      expiredAt: now,
      updatedAt: now
    }
  });
  await transaction.sessionUploadGrant.updateMany({
    where: { sessionId: session.id, status: "ACTIVE" },
    data: { status: "EXPIRED", revokedAt: now }
  });
  await transaction.auditEvent.create({
    data: {
      id: random.uuid(now),
      occurredAt: now,
      actorType: "SYSTEM",
      actorId: credentialId,
      kioskId: session.kioskId,
      sessionId: session.id,
      action: "session.expired",
      outcome: "SUCCESS",
      requestId,
      metadata: { previousState: session.state, version: next.version }
    }
  });
  await transaction.outboxEvent.create({
    data: {
      id: random.uuid(now),
      aggregateType: "PRINT_SESSION",
      aggregateId: session.id,
      sequence: next.version,
      type: "session.expired",
      payload: { sessionId: session.id, state: next.state, version: next.version }
    }
  });
}

function toSnapshot(session: {
  id: string;
  publicId: string;
  kioskId: string;
  locale: string;
  state: string;
  stateVersion: number;
  idleExpiresAt: Date;
  hardExpiresAt: Date;
  createdAt: Date;
  canceledAt: Date | null;
}): SessionSnapshot {
  return {
    id: session.id,
    publicId: session.publicId,
    kioskId: session.kioskId,
    locale: session.locale as SessionLocale,
    state: session.state as SessionState,
    version: session.stateVersion,
    expiresAt: session.idleExpiresAt.toISOString(),
    hardExpiresAt: session.hardExpiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    canceledAt: session.canceledAt?.toISOString() ?? null
  };
}

function sessionSnapshotsMatch(left: SessionSnapshot, right: SessionSnapshot): boolean {
  return (
    left.id === right.id &&
    left.publicId === right.publicId &&
    left.kioskId === right.kioskId &&
    left.locale === right.locale &&
    left.state === right.state &&
    left.version === right.version &&
    left.expiresAt === right.expiresAt &&
    left.hardExpiresAt === right.hardExpiresAt &&
    left.createdAt === right.createdAt &&
    left.canceledAt === right.canceledAt
  );
}

function buildUploadUrl(origin: string, publicId: string, uploadToken: string): string {
  const url = new URL(`/s/${publicId}`, origin);
  url.hash = `t=${uploadToken}`;
  return url.toString();
}

function sessionHasExpired(
  session: { idleExpiresAt: Date; hardExpiresAt: Date },
  now: Date
): boolean {
  return isSessionExpired(now, session.idleExpiresAt, session.hardExpiresAt);
}

function isExpirable(state: string): boolean {
  return EXPIRABLE_STATES.includes(state as SessionState);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

function staleVersion(expectedVersion: number, currentVersion: number): ApiError {
  return new ApiError(412, "STALE_SESSION_VERSION", "The session version is stale.", {
    expectedVersion,
    currentVersion
  });
}

function sessionNotFound(): ApiError {
  return new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
}

function mapDomainError(error: SessionDomainError): ApiError {
  if (error.code === "STALE_SESSION_VERSION") {
    return new ApiError(412, error.code, "The session version is stale.", error.details);
  }
  return new ApiError(409, error.code, "This session transition is not allowed.", error.details);
}

function mapDatabaseConflict(error: unknown): unknown {
  if (error instanceof ApiError || error instanceof SessionDomainError) return error;
  if (isRetryableTransactionError(error)) {
    return new ApiError(409, "CONCURRENT_SESSION_UPDATE", "The session changed concurrently.");
  }
  return error;
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = Reflect.get(error, "code");
  if (code === "P2034") return true;

  // Prisma can surface PostgreSQL serialization failures raised by a raw
  // SELECT ... FOR UPDATE as P2010 instead of P2034. Retry only the two
  // PostgreSQL transaction-conflict SQLSTATEs; other raw-query errors must
  // remain visible rather than being mistaken for a safe concurrency retry.
  if (code !== "P2010" || !("meta" in error)) return false;
  const meta = Reflect.get(error, "meta");
  const databaseCode = getDriverDatabaseCode(meta);
  return databaseCode === "40001" || databaseCode === "40P01";
}

function getDriverDatabaseCode(meta: unknown): unknown {
  if (!meta || typeof meta !== "object" || !("driverAdapterError" in meta)) return undefined;
  const driverAdapterError = Reflect.get(meta, "driverAdapterError");
  if (
    !driverAdapterError ||
    typeof driverAdapterError !== "object" ||
    !("cause" in driverAdapterError)
  )
    return undefined;
  const cause = Reflect.get(driverAdapterError, "cause");
  if (!cause || typeof cause !== "object" || !("originalCode" in cause)) return undefined;
  return Reflect.get(cause, "originalCode");
}

function isAllocationConstraintError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002")
    return false;
  const target = JSON.stringify(error.meta?.target ?? "");
  return /public_id|token_digest|short_code_digest/.test(target);
}

function isCreateConcurrencyConstraintError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002")
    return false;
  const target = JSON.stringify(error.meta?.target ?? "");
  return /kiosk_?id|key_?digest|one_active_per_kiosk/i.test(target);
}

class AllocationCollisionError extends Error {}
