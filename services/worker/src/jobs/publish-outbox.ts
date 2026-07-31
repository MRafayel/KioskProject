import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";

import { redisConnectionOptions, type Environment } from "@printing-kiosk/config";
import {
  realtimeDeliveryJobSchema,
  SESSION_EVENT_QUEUE_NAME,
  sessionEventSchema,
  type SessionEvent
} from "@printing-kiosk/contracts";
import type { Prisma, PrismaClient } from "@printing-kiosk/database";

const DEFAULT_POLL_INTERVAL_MS = 250;
const LOCK_TIMEOUT_MS = 30_000;
const MAX_PUBLISH_ATTEMPTS = 20;

export interface OutboxPublisherLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export class OutboxPublisher {
  private readonly queue: Queue;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  public constructor(
    private readonly database: PrismaClient,
    environment: Environment,
    private readonly logger: OutboxPublisherLogger,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  ) {
    this.queue = new Queue(SESSION_EVENT_QUEUE_NAME, {
      connection: redisConnectionOptions(environment.REDIS_URL),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 500 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 604_800, count: 10_000 }
      }
    });
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  public async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.queue.close();
  }

  public async publishNext(): Promise<boolean> {
    const claimed = await this.claimNext();
    if (!claimed) return false;

    try {
      const event = await this.materialize(claimed);
      const job = realtimeDeliveryJobSchema.parse({
        kioskId: claimed.session.kioskId,
        event
      });
      await this.queue.add("deliver-session-event", job, { jobId: event.id });
      const completed = await this.database.outboxEvent.updateMany({
        where: {
          id: claimed.id,
          status: "PROCESSING",
          claimToken: claimed.claimToken
        },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
          lockedAt: null,
          claimToken: null,
          lastErrorCode: null
        }
      });
      if (completed.count !== 1) {
        this.logger.warn(
          { outboxEventId: claimed.id, sessionId: event.sessionId, sequence: event.sequence },
          "outbox lease lost before publication completion"
        );
        return true;
      }
      this.logger.info(
        { outboxEventId: claimed.id, sessionId: event.sessionId, sequence: event.sequence },
        "outbox event published"
      );
      return true;
    } catch (error) {
      await this.releaseFailure(claimed.id, claimed.claimToken, claimed.publishAttempts, error);
      return true;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const processed = await this.publishNext();
      this.schedule(processed ? 0 : this.pollIntervalMs);
    } catch (error) {
      this.logger.error(safeError(error), "outbox publisher tick failed");
      this.schedule(this.pollIntervalMs);
    }
  }

  private async claimNext() {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const claimable: Prisma.OutboxEventWhereInput = {
      aggregateType: "PRINT_SESSION",
      OR: [
        { status: "PENDING", availableAt: { lte: now } },
        { status: "PROCESSING", lockedAt: { lte: staleBefore } }
      ]
    };
    const candidate = await this.database.outboxEvent.findFirst({
      where: claimable,
      orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
      include: { session: { select: { kioskId: true } } }
    });
    if (!candidate) return null;

    const claimToken = randomUUID();
    const claimed = await this.database.outboxEvent.updateMany({
      where: { id: candidate.id, ...claimable },
      data: {
        status: "PROCESSING",
        lockedAt: now,
        claimToken,
        lastErrorCode: null,
        publishAttempts: { increment: 1 }
      }
    });
    return claimed.count === 1
      ? {
          ...candidate,
          claimToken,
          publishAttempts: candidate.publishAttempts + 1
        }
      : null;
  }

  private async materialize(input: {
    id: string;
    aggregateId: string;
    sequence: number;
    type: string;
    payload: unknown;
    createdAt: Date;
    session: { kioskId: string };
  }): Promise<SessionEvent> {
    const event = toSafeSessionEvent(input);
    const stored = await this.database.sessionEvent.upsert({
      where: {
        sessionId_sequence: {
          sessionId: event.sessionId,
          sequence: event.sequence
        }
      },
      create: {
        id: event.id,
        sessionId: event.sessionId,
        kioskId: input.session.kioskId,
        sequence: event.sequence,
        type: event.type,
        payload: event.payload,
        occurredAt: new Date(event.occurredAt)
      },
      update: {}
    });

    return sessionEventSchema.parse({
      id: stored.id,
      sessionId: stored.sessionId,
      sequence: stored.sequence,
      type: stored.type,
      payload: stored.payload,
      occurredAt: stored.occurredAt.toISOString()
    });
  }

  private async releaseFailure(
    id: string,
    claimToken: string,
    attempts: number,
    error: unknown
  ): Promise<void> {
    const failed = attempts >= MAX_PUBLISH_ATTEMPTS;
    const delayMs = Math.min(30_000, 250 * 2 ** Math.min(attempts, 7));
    const errorCode = safeErrorCode(error);
    const released = await this.database.outboxEvent.updateMany({
      where: { id, status: "PROCESSING", claimToken },
      data: {
        status: failed ? "FAILED" : "PENDING",
        availableAt: new Date(Date.now() + delayMs),
        lockedAt: null,
        claimToken: null,
        lastErrorCode: errorCode
      }
    });
    if (released.count !== 1) {
      this.logger.warn(
        { outboxEventId: id, attempts, errorCode },
        "outbox lease lost before publication failure release"
      );
      return;
    }
    this.logger.warn(
      { outboxEventId: id, attempts, errorCode, terminal: failed },
      "outbox event publication failed"
    );
  }
}

function toSafeSessionEvent(input: {
  id: string;
  aggregateId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}): SessionEvent {
  const payload = objectRecord(input.payload);
  const sessionId = payload.sessionId;
  if (sessionId !== input.aggregateId) throw new Error("OUTBOX_SESSION_MISMATCH");

  let safePayload: unknown;
  if (input.type === "session.created") {
    safePayload = {
      sessionId,
      state: payload.state,
      version: payload.version
    };
  } else if (input.type === "mobile.connected") {
    safePayload = { sessionId };
  } else if (
    input.type === "upload.started" ||
    input.type === "file.uploaded" ||
    input.type === "file.ready" ||
    input.type === "file.rejected"
  ) {
    safePayload = { sessionId, file: payload.file };
  } else if (input.type === "file.deleted") {
    safePayload = { sessionId, fileId: payload.fileId };
  } else if (input.type === "settings.updated") {
    safePayload = {
      sessionId,
      settingsRevision: payload.settingsRevision,
      state: payload.state,
      version: payload.version,
      selectedPages: payload.selectedPages,
      printedSides: payload.printedSides,
      physicalSheets: payload.physicalSheets
    };
  } else if (input.type === "quote.created") {
    safePayload = {
      sessionId,
      quoteId: payload.quoteId,
      settingsRevision: payload.settingsRevision,
      pricingVersion: payload.pricingVersion,
      currency: payload.currency,
      currencyExponent: payload.currencyExponent,
      totalMinor: payload.totalMinor,
      expiresAt: payload.expiresAt
    };
  } else if (input.type === "quote.invalidated") {
    safePayload = { sessionId, quoteId: payload.quoteId, reason: payload.reason };
  } else if (input.type === "session.canceled" || input.type === "session.expired") {
    safePayload = {
      sessionId,
      state: payload.state,
      version: payload.version
    };
  } else {
    throw new Error("OUTBOX_EVENT_TYPE_UNSUPPORTED");
  }

  return sessionEventSchema.parse({
    id: input.id,
    sessionId: input.aggregateId,
    sequence: input.sequence,
    type: input.type,
    payload: safePayload,
    occurredAt: input.createdAt.toISOString()
  });
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OUTBOX_PAYLOAD_INVALID");
  }
  return value as Record<string, unknown>;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)) return error.message;
  if (error && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && /^[A-Z0-9_]{2,80}$/.test(code)) return code;
  }
  return "OUTBOX_PUBLICATION_FAILED";
}

function safeError(error: unknown): Record<string, unknown> {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorCode: safeErrorCode(error)
  };
}
