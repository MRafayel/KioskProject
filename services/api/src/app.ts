import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { Environment } from "@printing-kiosk/config";
import { PRODUCT_SCOPE, healthResponseSchema } from "@printing-kiosk/contracts";
import { createDatabaseClient, type PrismaClient } from "@printing-kiosk/database";
import { MockPaymentProvider } from "@printing-kiosk/payment-adapters";

import { FileJanitor } from "./modules/files/janitor.js";
import { createS3ObjectStore, type ObjectStore } from "./modules/files/object-store.js";
import { registerDocumentPreviewRoutes } from "./modules/files/previews.js";
import { registerFileRoutes } from "./modules/files/routes.js";
import { FileService } from "./modules/files/service.js";
import { registerEventRoutes } from "./modules/events/routes.js";
import { registerMobileAccessRoutes } from "./modules/mobile-access/routes.js";
import { MobileAccessService } from "./modules/mobile-access/service.js";
import {
  registerPaymentOutcomeTestRoutes,
  registerPaymentRoutes,
  registerPaymentWebhookRoutes
} from "./modules/payments/routes.js";
import { PaymentService } from "./modules/payments/service.js";
import { registerQuoteRoutes } from "./modules/quotes/routes.js";
import { QuoteService } from "./modules/quotes/service.js";
import { registerSettingsRoutes } from "./modules/settings/routes.js";
import { PrintSettingsService } from "./modules/settings/service.js";
import {
  LocalSessionEventBus,
  type SessionEventSource
} from "./modules/realtime/session-event-bus.js";
import {
  CryptoRandomSource,
  SystemClock,
  type Clock,
  type RandomSource
} from "./modules/sessions/crypto.js";
import { ApiError } from "./modules/sessions/errors.js";
import { createKioskAuthenticationThrottle } from "./modules/sessions/rate-limit.js";
import { registerSessionRoutes } from "./modules/sessions/routes.js";
import { SessionService } from "./modules/sessions/service.js";

const NON_UPLOAD_BODY_LIMIT_BYTES = 16 * 1024;

export interface BuildAppOptions {
  environment: Environment;
  logger?: boolean;
  readinessCheck?: () => Record<string, "ok" | "failed"> | Promise<Record<string, "ok" | "failed">>;
  database?: PrismaClient;
  clock?: Clock;
  random?: RandomSource;
  objectStore?: ObjectStore;
  sessionEvents?: SessionEventSource;
  /**
   * The simulated payment provider. Only a test replaces it, and only to
   * exercise scenarios such as an unavailable provider.
   */
  paymentProvider?: MockPaymentProvider;
  startBackgroundJobs?: boolean;
  /**
   * Per-IP ceiling on phone handoffs. Production keeps the built-in default;
   * only an automated suite driving many sessions from one address raises it.
   */
  maxMobileExchangesPerMinute?: number;
  /**
   * Per-credential ceiling on session creation. Production keeps the built-in
   * default; only an automated suite driving many sessions through one kiosk
   * credential raises it.
   */
  maxSessionsPerMinute?: number;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          level: options.environment.LOG_LEVEL,
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers['x-csrf-token']",
              "req.headers['idempotency-key']",
              "res.headers['set-cookie']"
            ],
            censor: "[REDACTED]"
          }
        }
      : false,
    // File uploads opt into their larger limit on the upload route. Keeping
    // the global limit small prevents anonymous JSON routes from buffering a
    // file-sized request before schema validation or rate limiting.
    bodyLimit: NON_UPLOAD_BODY_LIMIT_BYTES,
    connectionTimeout: 15_000,
    requestTimeout: (options.environment.UPLOAD_TIMEOUT_SECONDS + 15) * 1_000,
    keepAliveTimeout: 5_000,
    logController: new LogController({
      disableRequestLogging: true
    })
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    attachFieldsToBody: false,
    limits: {
      fileSize: options.environment.MAX_FILE_BYTES,
      files: 1,
      fields: 0,
      parts: 1
    }
  });
  await app.register(cors, {
    credentials: true,
    origin: [options.environment.KIOSK_ORIGIN, options.environment.UPLOAD_ORIGIN]
  });

  const ownsDatabase = !options.database;
  const database = options.database ?? createDatabaseClient(options.environment.DATABASE_URL);
  const clock = options.clock ?? new SystemClock();
  const random = options.random ?? new CryptoRandomSource();
  const objectStore = options.objectStore ?? createS3ObjectStore(options.environment);
  const sessionEvents = options.sessionEvents ?? new LocalSessionEventBus();
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
  const mobileAccess = new MobileAccessService({
    database,
    clock,
    random,
    uploadTokenPepper: options.environment.UPLOAD_TOKEN_PEPPER,
    mobileTokenPepper: options.environment.MOBILE_TOKEN_PEPPER,
    cookieSigningKey: options.environment.COOKIE_SIGNING_KEY,
    mobileClientTtlMinutes: options.environment.MOBILE_CLIENT_TTL_MINUTES,
    maxFiles: options.environment.MAX_FILES_PER_SESSION,
    maxFileBytes: options.environment.MAX_FILE_BYTES,
    maxTotalBytes: options.environment.MAX_SESSION_UPLOAD_BYTES
  });
  const files = new FileService({
    database,
    objectStore,
    clock,
    random,
    idempotencyPepper: options.environment.UPLOAD_TOKEN_PEPPER,
    idempotencyTtlHours: options.environment.IDEMPOTENCY_TTL_HOURS,
    maxFileBytes: options.environment.MAX_FILE_BYTES,
    maxSessionBytes: options.environment.MAX_SESSION_UPLOAD_BYTES,
    maxFiles: options.environment.MAX_FILES_PER_SESSION,
    uploadTimeoutSeconds: options.environment.UPLOAD_TIMEOUT_SECONDS
  });
  const printSettingsLimits = {
    maxCopies: options.environment.MAX_COPIES,
    maxSelectedPages: options.environment.MAX_SELECTED_PAGES,
    maxPrintedSides: options.environment.MAX_PRINTED_SIDES
  };
  const settings = new PrintSettingsService({
    database,
    clock,
    random,
    idempotencyPepper: options.environment.UPLOAD_TOKEN_PEPPER,
    idempotencyTtlHours: options.environment.IDEMPOTENCY_TTL_HOURS,
    limits: printSettingsLimits
  });
  const quotes = new QuoteService({
    database,
    clock,
    random,
    idempotencyPepper: options.environment.UPLOAD_TOKEN_PEPPER,
    idempotencyTtlHours: options.environment.IDEMPOTENCY_TTL_HOURS,
    quoteTtlSeconds: options.environment.QUOTE_TTL_SECONDS,
    limits: printSettingsLimits
  });
  const paymentProvider =
    options.paymentProvider ??
    new MockPaymentProvider({
      webhookSecret: options.environment.PAYMENT_WEBHOOK_SECRET,
      signatureToleranceSeconds: options.environment.PAYMENT_WEBHOOK_TOLERANCE_SECONDS
    });
  const payments = new PaymentService({
    database,
    clock,
    random,
    provider: paymentProvider,
    idempotencyPepper: options.environment.UPLOAD_TOKEN_PEPPER,
    idempotencyTtlHours: options.environment.IDEMPOTENCY_TTL_HOURS,
    paymentTimeoutSeconds: options.environment.PAYMENT_TIMEOUT_SECONDS
  });
  const janitor = new FileJanitor({
    database,
    objectStore,
    clock,
    random,
    uploadTimeoutSeconds: options.environment.UPLOAD_TIMEOUT_SECONDS,
    onError: (error, operation) => {
      app.log.error(
        {
          operation,
          errorName: error instanceof Error ? error.name : "UnknownError",
          ...getSafeErrorCodes(error)
        },
        "file cleanup operation failed"
      );
    }
  });

  if (options.startBackgroundJobs ?? options.environment.NODE_ENV !== "test") janitor.start();

  app.addHook("onClose", async () => {
    janitor.stop();
    if (ownsDatabase) await database.$disconnect();
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .header("cache-control", "no-store")
        .code(error.statusCode)
        .send({
          error: {
            code: error.code,
            message: error.message,
            requestId: request.id,
            ...(error.details ? { details: error.details } : {})
          }
        });
    }

    if (error instanceof ZodError) {
      return reply
        .header("cache-control", "no-store")
        .code(400)
        .send({
          error: {
            code: "INVALID_REQUEST",
            message: "The request is invalid.",
            requestId: request.id
          }
        });
    }

    const fastifyCode = getFastifyErrorCode(error);
    if (fastifyCode === "FST_REQ_FILE_TOO_LARGE") {
      return reply
        .header("cache-control", "no-store")
        .code(413)
        .send({
          error: {
            code: "FILE_TOO_LARGE",
            message: "The selected file is too large.",
            requestId: request.id
          }
        });
    }

    if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply
        .header("cache-control", "no-store")
        .code(413)
        .send({
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "The request payload is too large.",
            requestId: request.id
          }
        });
    }

    if (
      fastifyCode === "FST_PARTS_LIMIT" ||
      fastifyCode === "FST_FILES_LIMIT" ||
      fastifyCode === "FST_FIELDS_LIMIT"
    ) {
      return reply
        .header("cache-control", "no-store")
        .code(400)
        .send({
          error: {
            code: "INVALID_MULTIPART_REQUEST",
            message: "Exactly one file is required.",
            requestId: request.id
          }
        });
    }

    if (fastifyCode === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
      return reply
        .header("cache-control", "no-store")
        .code(415)
        .send({
          error: {
            code: "MULTIPART_REQUIRED",
            message: "A multipart file upload is required.",
            requestId: request.id
          }
        });
    }

    if (getErrorStatusCode(error) === 429) {
      return reply
        .header("cache-control", "no-store")
        .code(429)
        .send({
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests. Please wait before trying again.",
            requestId: request.id
          }
        });
    }

    if (fastifyCode?.startsWith("FST_") && getErrorStatusCode(error) === 400) {
      return reply
        .header("cache-control", "no-store")
        .code(400)
        .send({
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
    return reply
      .header("cache-control", "no-store")
      .code(500)
      .send({
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

  // One throttle across every kiosk-authenticated route, so a caller cannot
  // spend a fresh allowance simply by guessing against a different path.
  const kioskAuthentication = createKioskAuthenticationThrottle(app);

  registerSessionRoutes(app, {
    database,
    clock,
    sessions,
    kioskAuthentication,
    ...(options.maxSessionsPerMinute === undefined
      ? {}
      : { maxSessionsPerMinute: options.maxSessionsPerMinute })
  });
  registerEventRoutes(app, { database, clock, kioskAuthentication });
  registerMobileAccessRoutes(app, {
    mobileAccess,
    sessionEvents,
    uploadOrigin: options.environment.UPLOAD_ORIGIN,
    secureCookie: new URL(options.environment.UPLOAD_ORIGIN).protocol === "https:",
    ...(options.maxMobileExchangesPerMinute === undefined
      ? {}
      : { maxExchangesPerMinute: options.maxMobileExchangesPerMinute })
  });
  registerFileRoutes(app, {
    database,
    clock,
    files,
    mobileAccess,
    kioskAuthentication,
    uploadOrigin: options.environment.UPLOAD_ORIGIN,
    maxFileBytes: options.environment.MAX_FILE_BYTES
  });
  registerSettingsRoutes(app, { database, clock, settings, kioskAuthentication });
  registerQuoteRoutes(app, { database, clock, quotes, kioskAuthentication });
  registerPaymentRoutes(app, { database, clock, payments, kioskAuthentication });
  await registerPaymentWebhookRoutes(app, { payments });
  // A route that dictates payment outcomes never exists in a production
  // build: configuration validation refuses to enable it there, and this
  // second check means a mistaken environment cannot expose it either.
  if (
    options.environment.PAYMENT_TEST_OUTCOMES_ENABLED &&
    options.environment.NODE_ENV !== "production"
  ) {
    registerPaymentOutcomeTestRoutes(app, {
      database,
      clock,
      payments,
      kioskAuthentication,
      mockProvider: paymentProvider
    });
  }
  registerDocumentPreviewRoutes(app, {
    database,
    objectStore,
    clock,
    kioskAuthentication,
    maxPreviewBytes: options.environment.MAX_PREVIEW_FILE_BYTES
  });

  return app;
}

function getFastifyErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const statusCode = Reflect.get(error, "statusCode");
  return typeof statusCode === "number" ? statusCode : undefined;
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
