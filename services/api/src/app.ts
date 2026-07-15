import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { Environment } from "@printing-kiosk/config";
import { PRODUCT_SCOPE, healthResponseSchema } from "@printing-kiosk/contracts";
import { createDatabaseClient, type PrismaClient } from "@printing-kiosk/database";

import {
  CryptoRandomSource,
  SystemClock,
  type Clock,
  type RandomSource
} from "./modules/sessions/crypto.js";
import { ApiError } from "./modules/sessions/errors.js";
import { registerSessionRoutes } from "./modules/sessions/routes.js";
import { SessionService } from "./modules/sessions/service.js";

export interface BuildAppOptions {
  environment: Environment;
  logger?: boolean;
  readinessCheck?: () => Record<string, "ok" | "failed"> | Promise<Record<string, "ok" | "failed">>;
  database?: PrismaClient;
  clock?: Clock;
  random?: RandomSource;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({
      disableRequestLogging: true
    })
  });

  await app.register(helmet);
  await app.register(cors, {
    credentials: true,
    origin: [options.environment.KIOSK_ORIGIN, options.environment.UPLOAD_ORIGIN]
  });

  const ownsDatabase = !options.database;
  const database = options.database ?? createDatabaseClient(options.environment.DATABASE_URL);
  const clock = options.clock ?? new SystemClock();
  const random = options.random ?? new CryptoRandomSource();
  const sessions = new SessionService({
    database,
    clock,
    random,
    uploadTokenPepper: options.environment.UPLOAD_TOKEN_PEPPER,
    publicUploadOrigin: options.environment.PUBLIC_UPLOAD_ORIGIN,
    idleTtlMinutes: options.environment.SESSION_IDLE_TTL_MINUTES,
    hardTtlMinutes: options.environment.SESSION_ABSOLUTE_TTL_MINUTES,
    idempotencyTtlHours: options.environment.IDEMPOTENCY_TTL_HOURS
  });

  if (ownsDatabase) {
    app.addHook("onClose", async () => database.$disconnect());
  }

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details ? { details: error.details } : {})
        }
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The request is invalid.",
          requestId: request.id
        }
      });
    }

    request.log.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        ...getSafeErrorCodes(error)
      },
      "unhandled API error"
    );
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        requestId: request.id
      }
    });
  });

  app.get("/health/live", () =>
    healthResponseSchema.parse({
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
      productScope: PRODUCT_SCOPE
    })
  );

  app.get("/health/ready", async (_request, reply) => {
    const checks = await (options.readinessCheck ?? defaultReadinessCheck)();
    const ready = Object.values(checks).every((status) => status === "ok");
    const response = healthResponseSchema.parse({
      status: ready ? "ready" : "not_ready",
      service: "api",
      timestamp: new Date().toISOString(),
      productScope: PRODUCT_SCOPE,
      checks
    });

    return reply.code(ready ? 200 : 503).send(response);
  });

  registerSessionRoutes(app, { database, clock, sessions });

  return app;
}

function defaultReadinessCheck(): Record<string, "ok"> {
  return { configuration: "ok" };
}

function getSafeErrorCodes(error: unknown): {
  errorCode?: string;
  databaseCode?: string;
} {
  if (!error || typeof error !== "object") return {};
  const errorCode = "code" in error ? Reflect.get(error, "code") : undefined;
  const meta = "meta" in error ? Reflect.get(error, "meta") : undefined;
  const driverAdapterError =
    meta && typeof meta === "object" && "driverAdapterError" in meta
      ? Reflect.get(meta, "driverAdapterError")
      : undefined;
  const cause =
    driverAdapterError && typeof driverAdapterError === "object" && "cause" in driverAdapterError
      ? Reflect.get(driverAdapterError, "cause")
      : undefined;
  const databaseCode =
    cause && typeof cause === "object" && "originalCode" in cause
      ? Reflect.get(cause, "originalCode")
      : undefined;

  return {
    ...(typeof errorCode === "string" ? { errorCode } : {}),
    ...(typeof databaseCode === "string" ? { databaseCode } : {})
  };
}
