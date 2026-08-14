import {
  mobileContextResponseSchema,
  type MobileContextResponse,
  type SessionState
} from "@printing-kiosk/contracts";
import { Prisma, type PrismaClient } from "@printing-kiosk/database";
import { isSessionExpired, UPLOADABLE_SESSION_STATES } from "@printing-kiosk/domain";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { digestUploadValue, safelyEqualHexDigests } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import {
  deriveCsrfToken,
  deriveMobileCookie,
  digestClientNonce,
  digestMobileCookie,
  safelyEqualSecrets
} from "./crypto.js";

const MAX_TRANSACTION_ATTEMPTS = 4;
const MOBILE_COOKIE_PATTERN = /^m_[A-Za-z0-9_-]{43}$/;
/**
 * A phone stays connected for as long as the session still takes documents.
 * One session may carry several, so this deliberately outlives the first
 * validated upload; the shared list is what the upload path itself enforces.
 */
const MOBILE_ALLOWED_STATES: readonly SessionState[] = UPLOADABLE_SESSION_STATES;

interface MobileAccessServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  uploadTokenPepper: string;
  mobileTokenPepper: string;
  cookieSigningKey: string;
  mobileClientTtlMinutes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

interface ExchangeInput {
  publicSessionId: string;
  uploadToken: string;
  clientNonce: string;
  requestId: string;
}

export interface MobileCookie {
  value: string;
  expiresAt: Date;
  issuedAt: Date;
}

export interface MobileIdentity {
  clientId: string;
  sessionId: string;
  kioskId: string;
  rawCookie: string;
  expiresAt: Date;
  session: {
    id: string;
    publicId: string;
    locale: string;
    state: string;
    stateVersion: number;
    idleExpiresAt: Date;
    hardExpiresAt: Date;
  };
}

export interface ExchangeResult {
  context: MobileContextResponse;
  cookie: MobileCookie;
}

export class MobileAccessService {
  public constructor(private readonly options: MobileAccessServiceOptions) {}

  public async exchange(input: ExchangeInput): Promise<ExchangeResult> {
    const tokenDigest = digestUploadValue(input.uploadToken, this.options.uploadTokenPepper);
    const nonceDigest = digestClientNonce(input.clientNonce, this.options.mobileTokenPepper);

    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.options.database.$transaction(
          async (transaction) => {
            const candidate = await transaction.sessionUploadGrant.findUnique({
              where: { tokenDigest },
              select: { sessionId: true }
            });
            if (!candidate) throw invalidGrant();
            await lockSession(transaction, candidate.sessionId);
            await lockGrant(transaction, tokenDigest);
            const grant = await transaction.sessionUploadGrant.findUnique({
              where: { tokenDigest },
              include: { session: true }
            });
            if (!grant || grant.session.publicId !== input.publicSessionId) throw invalidGrant();

            const now = this.options.clock.now();
            if (
              now.getTime() >= grant.expiresAt.getTime() ||
              isSessionExpired(now, grant.session.idleExpiresAt, grant.session.hardExpiresAt) ||
              grant.session.state === "EXPIRED"
            ) {
              throw new ApiError(410, "UPLOAD_SESSION_EXPIRED", "This upload session has expired.");
            }
            if ((grant.status !== "ACTIVE" && grant.status !== "CLAIMED") || grant.revokedAt) {
              throw invalidGrant();
            }
            if (!MOBILE_ALLOWED_STATES.includes(grant.session.state as SessionState)) {
              throw new ApiError(
                409,
                "UPLOAD_SESSION_NOT_EDITABLE",
                "This session no longer accepts files."
              );
            }

            if (grant.status === "CLAIMED") {
              return this.restoreClaimedExchange(
                transaction,
                grant,
                input.uploadToken,
                input.clientNonce,
                nonceDigest,
                now
              );
            }
            const clientId = this.options.random.uuid(now);
            const rawCookie = deriveMobileCookie(
              grant.sessionId,
              input.uploadToken,
              input.clientNonce,
              this.options.cookieSigningKey
            );
            const expiresAt = earliestDate(
              grant.expiresAt,
              grant.session.idleExpiresAt,
              grant.session.hardExpiresAt,
              addMinutes(now, this.options.mobileClientTtlMinutes)
            );

            await transaction.mobileClient.create({
              data: {
                id: clientId,
                sessionId: grant.sessionId,
                cookieDigest: digestMobileCookie(rawCookie, this.options.mobileTokenPepper),
                clientNonceDigest: nonceDigest,
                status: "ACTIVE",
                expiresAt,
                lastSeenAt: now,
                createdAt: now
              }
            });
            const claimed = await transaction.sessionUploadGrant.updateMany({
              where: { id: grant.id, status: "ACTIVE", claimedClientId: null },
              data: {
                status: "CLAIMED",
                claimedClientId: clientId,
                claimedAt: now
              }
            });
            if (claimed.count !== 1) {
              throw new ApiError(
                409,
                "UPLOAD_GRANT_ALREADY_CLAIMED",
                "This QR code is already connected to another phone."
              );
            }

            const nextSequence = grant.session.eventSequence + 1;
            await Promise.all([
              transaction.printSession.update({
                where: { id: grant.sessionId },
                data: { eventSequence: nextSequence, updatedAt: now }
              }),
              transaction.auditEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  occurredAt: now,
                  actorType: "MOBILE",
                  actorId: clientId,
                  kioskId: grant.session.kioskId,
                  sessionId: grant.sessionId,
                  action: "mobile.connected",
                  outcome: "SUCCESS",
                  requestId: input.requestId,
                  metadata: {}
                }
              }),
              transaction.outboxEvent.create({
                data: {
                  id: this.options.random.uuid(now),
                  aggregateType: "PRINT_SESSION",
                  aggregateId: grant.sessionId,
                  sequence: nextSequence,
                  type: "mobile.connected",
                  payload: { sessionId: grant.sessionId }
                }
              })
            ]);

            return {
              context: this.toContext(grant.session, rawCookie, clientId, expiresAt),
              cookie: { value: rawCookie, expiresAt, issuedAt: now }
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        if (isRetryableTransactionError(error)) continue;
        throw error;
      }
    }

    throw new ApiError(
      409,
      "CONCURRENT_UPLOAD_CLAIM",
      "The upload session changed concurrently. Please retry."
    );
  }

  public async authenticate(
    rawCookie: string | undefined,
    sessionId?: string
  ): Promise<MobileIdentity> {
    if (!rawCookie || !MOBILE_COOKIE_PATTERN.test(rawCookie)) throw unauthorizedMobile();

    const client = await this.options.database.mobileClient.findUnique({
      where: {
        cookieDigest: digestMobileCookie(rawCookie, this.options.mobileTokenPepper)
      },
      include: { session: true }
    });
    if (!client || client.status !== "ACTIVE" || client.revokedAt) throw unauthorizedMobile();
    if (sessionId && client.sessionId !== sessionId) throw hiddenSession();

    const now = this.options.clock.now();
    if (
      now.getTime() >= client.expiresAt.getTime() ||
      isSessionExpired(now, client.session.idleExpiresAt, client.session.hardExpiresAt) ||
      client.session.state === "EXPIRED"
    ) {
      throw new ApiError(410, "UPLOAD_SESSION_EXPIRED", "This upload session has expired.");
    }
    if (!MOBILE_ALLOWED_STATES.includes(client.session.state as SessionState)) {
      throw new ApiError(
        409,
        "UPLOAD_SESSION_NOT_EDITABLE",
        "This session no longer accepts changes."
      );
    }

    await this.options.database.mobileClient.updateMany({
      where: {
        id: client.id,
        status: "ACTIVE",
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: new Date(now.getTime() - 30_000) } }]
      },
      data: { lastSeenAt: now }
    });

    return {
      clientId: client.id,
      sessionId: client.sessionId,
      kioskId: client.session.kioskId,
      rawCookie,
      expiresAt: client.expiresAt,
      session: client.session
    };
  }

  public async resolveSessionId(publicSessionId: string): Promise<string> {
    const session = await this.options.database.printSession.findUnique({
      where: { publicId: publicSessionId },
      select: { id: true }
    });
    if (!session) throw hiddenSession();
    return session.id;
  }

  public context(identity: MobileIdentity): MobileContextResponse {
    return this.toContext(
      identity.session,
      identity.rawCookie,
      identity.clientId,
      identity.expiresAt
    );
  }

  public assertCsrf(identity: MobileIdentity, suppliedToken: string | undefined): void {
    const expected = deriveCsrfToken(
      identity.rawCookie,
      identity.clientId,
      this.options.cookieSigningKey
    );
    if (!suppliedToken || !safelyEqualSecrets(suppliedToken, expected)) {
      throw new ApiError(403, "INVALID_CSRF_TOKEN", "The request could not be verified.");
    }
  }

  private async restoreClaimedExchange(
    transaction: Prisma.TransactionClient,
    grant: {
      claimedClientId: string | null;
      sessionId: string;
      session: {
        id: string;
        publicId: string;
        locale: string;
        state: string;
        stateVersion: number;
        idleExpiresAt: Date;
        hardExpiresAt: Date;
      };
    },
    uploadToken: string,
    clientNonce: string,
    nonceDigest: string,
    now: Date
  ): Promise<ExchangeResult> {
    if (!grant.claimedClientId) throw invalidGrant();
    const client = await transaction.mobileClient.findUnique({
      where: { id: grant.claimedClientId }
    });
    if (
      !client ||
      client.sessionId !== grant.sessionId ||
      client.status !== "ACTIVE" ||
      client.revokedAt ||
      now.getTime() >= client.expiresAt.getTime()
    ) {
      throw invalidGrant();
    }
    if (!safelyEqualHexDigests(client.clientNonceDigest, nonceDigest)) {
      throw new ApiError(
        409,
        "UPLOAD_GRANT_ALREADY_CLAIMED",
        "This QR code is already connected to another phone."
      );
    }

    const rawCookie = deriveMobileCookie(
      grant.sessionId,
      uploadToken,
      clientNonce,
      this.options.cookieSigningKey
    );
    if (
      !safelyEqualHexDigests(
        digestMobileCookie(rawCookie, this.options.mobileTokenPepper),
        client.cookieDigest
      )
    ) {
      throw invalidGrant();
    }

    await transaction.mobileClient.update({
      where: { id: client.id },
      data: { lastSeenAt: now }
    });
    return {
      context: this.toContext(grant.session, rawCookie, client.id, client.expiresAt),
      cookie: { value: rawCookie, expiresAt: client.expiresAt, issuedAt: now }
    };
  }

  private toContext(
    session: {
      id: string;
      publicId: string;
      locale: string;
      state: string;
      stateVersion: number;
      idleExpiresAt: Date;
      hardExpiresAt: Date;
    },
    rawCookie: string,
    clientId: string,
    clientExpiresAt?: Date
  ): MobileContextResponse {
    return mobileContextResponseSchema.parse({
      session: {
        id: session.id,
        publicId: session.publicId,
        locale: session.locale,
        state: session.state,
        version: session.stateVersion,
        expiresAt: earliestDate(
          session.idleExpiresAt,
          session.hardExpiresAt,
          clientExpiresAt ?? session.idleExpiresAt
        ).toISOString(),
        hardExpiresAt: session.hardExpiresAt.toISOString()
      },
      csrfToken: deriveCsrfToken(rawCookie, clientId, this.options.cookieSigningKey),
      limits: {
        maxFiles: this.options.maxFiles,
        maxFileBytes: this.options.maxFileBytes,
        maxTotalBytes: this.options.maxTotalBytes,
        allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"]
      }
    });
  }
}

async function lockGrant(
  transaction: Prisma.TransactionClient,
  tokenDigest: string
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "session_upload_grants"
    WHERE "token_digest" = ${tokenDigest}
    FOR UPDATE
  `;
  if (rows.length === 0) throw invalidGrant();
}

async function lockSession(
  transaction: Prisma.TransactionClient,
  sessionId: string
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "print_sessions" WHERE "id" = ${sessionId}::uuid FOR UPDATE
  `;
  if (rows.length === 0) throw invalidGrant();
}

function invalidGrant(): ApiError {
  return new ApiError(401, "INVALID_UPLOAD_GRANT", "The upload link is invalid.");
}

function unauthorizedMobile(): ApiError {
  return new ApiError(401, "INVALID_MOBILE_SESSION", "Mobile authentication failed.");
}

function hiddenSession(): ApiError {
  return new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
}

function earliestDate(...dates: Date[]): Date {
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = Reflect.get(error, "code");
  if (code === "P2034") return true;
  if (code !== "P2010" || !("meta" in error)) return false;
  const meta = Reflect.get(error, "meta");
  if (!meta || typeof meta !== "object" || !("driverAdapterError" in meta)) return false;
  const driverError = Reflect.get(meta, "driverAdapterError");
  if (!driverError || typeof driverError !== "object" || !("cause" in driverError)) return false;
  const cause = Reflect.get(driverError, "cause");
  if (!cause || typeof cause !== "object" || !("originalCode" in cause)) return false;
  const databaseCode = Reflect.get(cause, "originalCode");
  return databaseCode === "40001" || databaseCode === "40P01";
}
