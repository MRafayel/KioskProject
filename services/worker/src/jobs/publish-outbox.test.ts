import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { loadEnvironment } from "@printing-kiosk/config";
import { realtimeDeliveryJobSchema } from "@printing-kiosk/contracts";
import type { Prisma, PrismaClient } from "@printing-kiosk/database";

const queueAdd = vi.hoisted(() => vi.fn());
const queueClose = vi.hoisted(() => vi.fn());

vi.mock("bullmq", () => ({
  Queue: class {
    public add = queueAdd;
    public close = queueClose;
  }
}));

import { OutboxPublisher } from "./publish-outbox.js";

const sessionId = "01900000-0000-7000-8000-000000000010";
const outboxId = "01900000-0000-7000-8000-000000000011";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type UpdateManyMock = Mock<(input: Prisma.OutboxEventUpdateManyArgs) => Promise<{ count: number }>>;

describe("OutboxPublisher", () => {
  beforeEach(() => {
    queueAdd.mockReset().mockResolvedValue({ id: outboxId });
    queueClose.mockReset().mockResolvedValue(undefined);
    silentLogger.info.mockReset();
    silentLogger.warn.mockReset();
    silentLogger.error.mockReset();
  });

  it("materializes the durable event before queueing and then marks it published", async () => {
    const operations: string[] = [];
    const updateMany = updateManyMock()
      .mockImplementationOnce(() => {
        operations.push("claim");
        return Promise.resolve({ count: 1 });
      })
      .mockImplementationOnce(() => {
        operations.push("published");
        return Promise.resolve({ count: 1 });
      });
    const database = {
      outboxEvent: {
        findFirst: vi.fn().mockResolvedValue({
          id: outboxId,
          aggregateType: "PRINT_SESSION",
          aggregateId: sessionId,
          sequence: 1,
          type: "session.created",
          payload: {
            sessionId,
            kioskId: "kiosk_dev_001",
            state: "WAITING_FOR_UPLOAD",
            version: 1
          },
          status: "PENDING",
          publishAttempts: 0,
          createdAt: new Date("2030-01-01T00:00:00.000Z"),
          session: { kioskId: "kiosk_dev_001" }
        }),
        updateMany
      },
      sessionEvent: {
        upsert: vi.fn().mockImplementation(() => {
          operations.push("materialized");
          return Promise.resolve({
            id: outboxId,
            sessionId,
            kioskId: "kiosk_dev_001",
            sequence: 1,
            type: "session.created",
            payload: {
              sessionId,
              state: "WAITING_FOR_UPLOAD",
              version: 1
            },
            occurredAt: new Date("2030-01-01T00:00:00.000Z")
          });
        })
      }
    };
    queueAdd.mockImplementation(() => {
      operations.push("queued");
      return Promise.resolve({ id: outboxId });
    });
    const publisher = new OutboxPublisher(
      database as unknown as PrismaClient,
      loadEnvironment({ NODE_ENV: "test" }),
      silentLogger
    );

    await expect(publisher.publishNext()).resolves.toBe(true);
    expect(operations).toEqual(["claim", "materialized", "queued", "published"]);
    expect(queueAdd).toHaveBeenCalledOnce();
    const queued = realtimeDeliveryJobSchema.parse(queueAdd.mock.lastCall?.[1] as unknown);
    expect(queueAdd.mock.lastCall?.[0] as unknown).toBe("deliver-session-event");
    expect(queueAdd.mock.lastCall?.[2] as unknown).toEqual({ jobId: outboxId });
    expect(queued).toMatchObject({
      kioskId: "kiosk_dev_001",
      event: { sessionId, sequence: 1 }
    });
    const claimToken = updateMany.mock.calls[0]?.[0]?.data.claimToken as unknown;
    expect(claimToken).toEqual(expect.stringMatching(uuidPattern));
    expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
      where: {
        id: outboxId,
        status: "PROCESSING",
        claimToken
      },
      data: {
        status: "PUBLISHED",
        claimToken: null,
        lockedAt: null
      }
    });
    expect(JSON.stringify(queueAdd.mock.calls)).not.toContain("kiosk-api-key");
    await publisher.close();
  });

  it("publishes a payment event carrying only what the screen needs", async () => {
    const upsert = vi.fn().mockImplementation((args: { create: Record<string, unknown> }) =>
      Promise.resolve({
        id: outboxId,
        sessionId,
        kioskId: "kiosk_dev_001",
        sequence: 9,
        type: "payment.succeeded",
        payload: args.create.payload,
        occurredAt: new Date("2030-01-01T00:00:00.000Z")
      })
    );
    const database = {
      outboxEvent: {
        findFirst: vi.fn().mockResolvedValue({
          id: outboxId,
          aggregateType: "PRINT_SESSION",
          aggregateId: sessionId,
          sequence: 9,
          type: "payment.succeeded",
          payload: {
            sessionId,
            paymentId: "01900000-0000-7000-8000-0000000000bb",
            quoteId: "01900000-0000-7000-8000-0000000000aa",
            state: "PAID",
            version: 6,
            currency: "AMD",
            currencyExponent: 2,
            amountMinor: 60_000,
            capturedAt: "2030-01-01T00:00:00.000Z",
            // A provider reference has no business reaching a browser, so the
            // publisher must drop it even when a writer includes it.
            providerIntentId: "mock_pi_secret"
          },
          status: "PENDING",
          publishAttempts: 0,
          createdAt: new Date("2030-01-01T00:00:00.000Z"),
          session: { kioskId: "kiosk_dev_001" }
        }),
        updateMany: updateManyMock().mockResolvedValue({ count: 1 })
      },
      sessionEvent: { upsert }
    } as unknown as PrismaClient;

    await expect(publisherWith(database).publishNext()).resolves.toBe(true);

    const stored = upsert.mock.lastCall?.[0] as { create: { payload: Record<string, unknown> } };
    expect(stored.create.payload).toEqual({
      sessionId,
      paymentId: "01900000-0000-7000-8000-0000000000bb",
      quoteId: "01900000-0000-7000-8000-0000000000aa",
      state: "PAID",
      version: 6,
      currency: "AMD",
      currencyExponent: 2,
      amountMinor: 60_000,
      capturedAt: "2030-01-01T00:00:00.000Z"
    });
    expect(JSON.stringify(queueAdd.mock.calls)).not.toContain("mock_pi_secret");
  });

  it("cannot complete a row after a competing publisher reclaims its stale lease", async () => {
    const updateMany = updateManyMock()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const publisher = publisherWith(databaseWith(updateMany));

    await expect(publisher.publishNext()).resolves.toBe(true);

    const claimToken = updateMany.mock.calls[0]?.[0]?.data.claimToken as unknown;
    expect(claimToken).toEqual(expect.stringMatching(uuidPattern));
    expect(updateMany.mock.calls[1]?.[0]?.where).toMatchObject({
      id: outboxId,
      status: "PROCESSING",
      claimToken
    });
    expect(silentLogger.info).not.toHaveBeenCalled();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outboxEventId: outboxId }),
      "outbox lease lost before publication completion"
    );
    await publisher.close();
  });

  it("cannot release a failed row after a competing publisher reclaims its stale lease", async () => {
    const updateMany = updateManyMock()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    queueAdd.mockRejectedValueOnce(new Error("REDIS_UNAVAILABLE"));
    const publisher = publisherWith(databaseWith(updateMany));

    await expect(publisher.publishNext()).resolves.toBe(true);

    const claimToken = updateMany.mock.calls[0]?.[0]?.data.claimToken as unknown;
    expect(updateMany.mock.calls[1]?.[0]?.where).toMatchObject({
      id: outboxId,
      status: "PROCESSING",
      claimToken
    });
    expect(updateMany.mock.calls[1]?.[0]?.data).toMatchObject({
      status: "PENDING",
      claimToken: null,
      lockedAt: null
    });
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        outboxEventId: outboxId,
        attempts: 1,
        errorCode: "REDIS_UNAVAILABLE"
      }),
      "outbox lease lost before publication failure release"
    );
    await publisher.close();
  });

  it("releases an owned failure with retry backoff and clears its claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const updateMany = updateManyMock()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      queueAdd.mockRejectedValueOnce(new Error("REDIS_UNAVAILABLE"));
      const publisher = publisherWith(databaseWith(updateMany));

      await expect(publisher.publishNext()).resolves.toBe(true);

      const claimToken = updateMany.mock.calls[0]?.[0]?.data.claimToken as unknown;
      expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
        where: {
          id: outboxId,
          status: "PROCESSING",
          claimToken
        },
        data: {
          status: "PENDING",
          availableAt: new Date("2030-01-01T00:00:00.500Z"),
          lockedAt: null,
          claimToken: null,
          lastErrorCode: "REDIS_UNAVAILABLE"
        }
      });
      expect(silentLogger.warn).toHaveBeenCalledWith(
        {
          outboxEventId: outboxId,
          attempts: 1,
          errorCode: "REDIS_UNAVAILABLE",
          terminal: false
        },
        "outbox event publication failed"
      );
      await publisher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks only its owned twentieth failure terminal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const updateMany = updateManyMock()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      queueAdd.mockRejectedValueOnce(new Error("REDIS_UNAVAILABLE"));
      const publisher = publisherWith(databaseWith(updateMany, 19));

      await expect(publisher.publishNext()).resolves.toBe(true);

      const claimToken = updateMany.mock.calls[0]?.[0]?.data.claimToken as unknown;
      expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
        where: {
          id: outboxId,
          status: "PROCESSING",
          claimToken
        },
        data: {
          status: "FAILED",
          availableAt: new Date("2030-01-01T00:00:30.000Z"),
          lockedAt: null,
          claimToken: null,
          lastErrorCode: "REDIS_UNAVAILABLE"
        }
      });
      expect(silentLogger.warn).toHaveBeenCalledWith(
        {
          outboxEventId: outboxId,
          attempts: 20,
          errorCode: "REDIS_UNAVAILABLE",
          terminal: true
        },
        "outbox event publication failed"
      );
      await publisher.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

function publisherWith(database: PrismaClient): OutboxPublisher {
  return new OutboxPublisher(database, loadEnvironment({ NODE_ENV: "test" }), silentLogger);
}

function databaseWith(updateMany: UpdateManyMock, publishAttempts = 0): PrismaClient {
  return {
    outboxEvent: {
      findFirst: vi.fn().mockResolvedValue({
        id: outboxId,
        aggregateType: "PRINT_SESSION",
        aggregateId: sessionId,
        sequence: 1,
        type: "session.created",
        payload: {
          sessionId,
          kioskId: "kiosk_dev_001",
          state: "WAITING_FOR_UPLOAD",
          version: 1
        },
        status: "PENDING",
        publishAttempts,
        createdAt: new Date("2030-01-01T00:00:00.000Z"),
        session: { kioskId: "kiosk_dev_001" }
      }),
      updateMany
    },
    sessionEvent: {
      upsert: vi.fn().mockResolvedValue({
        id: outboxId,
        sessionId,
        kioskId: "kiosk_dev_001",
        sequence: 1,
        type: "session.created",
        payload: {
          sessionId,
          state: "WAITING_FOR_UPLOAD",
          version: 1
        },
        occurredAt: new Date("2030-01-01T00:00:00.000Z")
      })
    }
  } as unknown as PrismaClient;
}

function updateManyMock(): UpdateManyMock {
  return vi.fn<(input: Prisma.OutboxEventUpdateManyArgs) => Promise<{ count: number }>>();
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};
