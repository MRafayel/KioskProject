import type { Server as HttpServer } from "node:http";

import { Worker } from "bullmq";
import { Server } from "socket.io";

import { redisConnectionOptions, type Environment } from "@printing-kiosk/config";
import {
  realtimeDeliveryJobSchema,
  realtimeSocketAuthSchema,
  SESSION_EVENT_QUEUE_NAME,
  SESSION_EVENT_SOCKET_NAME,
  type SessionEvent
} from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import { authenticateKioskCredential } from "../sessions/auth.js";
import type { Clock } from "../sessions/crypto.js";
import type { SessionEventSink } from "./session-event-bus.js";

export interface RealtimeGatewayLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

type ClientToServerEvents = Record<never, never>;

interface ServerToClientEvents {
  "session:event": (event: SessionEvent) => void;
}

interface KioskSocketData {
  kioskId?: string;
}

export class RealtimeGateway {
  private readonly io: Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<never, never>,
    KioskSocketData
  >;
  private readonly deliveryWorker: Worker;

  public constructor(
    httpServer: HttpServer,
    private readonly database: PrismaClient,
    private readonly clock: Clock,
    environment: Environment,
    private readonly logger: RealtimeGatewayLogger,
    private readonly sessionEvents: SessionEventSink = NOOP_SESSION_EVENT_SINK
  ) {
    this.io = new Server<
      ClientToServerEvents,
      ServerToClientEvents,
      Record<never, never>,
      KioskSocketData
    >(httpServer, {
      path: "/socket.io",
      serveClient: false,
      transports: ["websocket"],
      allowUpgrades: false,
      maxHttpBufferSize: 16 * 1024,
      pingInterval: 15_000,
      pingTimeout: 10_000
    });

    this.io.use((socket, next) => {
      void (async () => {
        const auth = realtimeSocketAuthSchema.parse(socket.handshake.auth);
        const identity = await authenticateKioskCredential(
          auth.credential,
          this.database,
          this.clock,
          "sessions:read"
        );
        if (identity.kioskId !== auth.kioskId) throw new Error("KIOSK_IDENTITY_MISMATCH");
        socket.data.kioskId = identity.kioskId;
      })().then(
        () => {
          next();
        },
        () => {
          next(new Error("AUTHENTICATION_FAILED"));
        }
      );
    });

    this.io.on("connection", (socket) => {
      const kioskId = socket.data.kioskId;
      if (typeof kioskId !== "string") {
        socket.disconnect(true);
        return;
      }
      void socket.join(kioskRoom(kioskId));
      this.logger.info({ kioskId, socketId: socket.id }, "kiosk realtime connection established");
    });

    this.deliveryWorker = new Worker(
      SESSION_EVENT_QUEUE_NAME,
      (job) =>
        Promise.resolve().then(() => {
          const delivery = realtimeDeliveryJobSchema.parse(job.data);
          this.io.to(kioskRoom(delivery.kioskId)).emit(SESSION_EVENT_SOCKET_NAME, delivery.event);
          this.sessionEvents.publish(delivery.event);
        }),
      {
        connection: redisConnectionOptions(environment.REDIS_URL),
        concurrency: 1
      }
    );
    this.deliveryWorker.on("failed", (job, error) => {
      this.logger.warn(
        {
          jobId: job?.id,
          errorName: error.name,
          errorCode: safeErrorCode(error)
        },
        "realtime delivery job failed"
      );
    });
    this.deliveryWorker.on("error", (error) => {
      this.logger.error(
        { errorName: error.name, errorCode: safeErrorCode(error) },
        "realtime delivery worker error"
      );
    });
  }

  /**
   * Readiness borrows the delivery worker's own connection, so a healthy answer
   * means the connection this process actually depends on is usable. BullMQ
   * types only the commands it uses, so a keyspace read is the cheapest typed
   * round-trip that still proves the server answers this client.
   */
  public async checkRedis(): Promise<void> {
    const client = await this.deliveryWorker.client;
    await client.get("printing-kiosk:readiness-probe");
  }

  public async close(): Promise<void> {
    await this.deliveryWorker.close();
    await this.io.close();
  }
}

const NOOP_SESSION_EVENT_SINK: SessionEventSink = {
  publish: () => undefined
};

function kioskRoom(kioskId: string): string {
  return `kiosk:${kioskId}`;
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && /^[A-Z0-9_]{2,80}$/.test(code)) return code;
  }
  return "REALTIME_DELIVERY_FAILED";
}
