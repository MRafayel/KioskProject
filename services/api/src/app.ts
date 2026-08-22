import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { Environment } from "@printing-kiosk/config";
import { PRODUCT_SCOPE, healthResponseSchema } from "@printing-kiosk/contracts";
import {
  assertAdminPeopleClientIsBounded,
  assertAdminPricingClientIsBounded,
  assertAdminReadClientIsReadOnly,
  assertAdminRefundClientIsAppendOnly,
  assertAdminWriteClientIsAppendOnly,
  assertApplicationRoleIsNotPrivileged,
  createAdminPeopleClient,
  createAdminPricingClient,
  createAdminReadClient,
  createAdminRefundClient,
  createAdminWriteClient,
  createDatabaseClient,
  type PrismaClient
} from "@printing-kiosk/database";
import type { RetentionPolicy } from "@printing-kiosk/domain";
import { MockPaymentProvider } from "@printing-kiosk/payment-adapters";

import { registerAdminChangeRoutes } from "./modules/admin/change-routes.js";
import { AdminChangeService } from "./modules/admin/changes.js";
import { AdminObservabilityService } from "./modules/admin/observability.js";
import { registerAdminObservabilityRoutes } from "./modules/admin/observability-routes.js";
import { AdminOperationsService } from "./modules/admin/operations.js";
import { registerAdminOperationsRoutes } from "./modules/admin/operations-routes.js";
import { asAdminPeopleDatabase } from "./modules/admin/people-database.js";
import { registerAdminPeopleRoutes } from "./modules/admin/people-routes.js";
import { AdminPeopleService } from "./modules/admin/people.js";
import { asAdminPricingDatabase } from "./modules/admin/pricing-database.js";
import { asAdminRefundDatabase } from "./modules/admin/refund-database.js";
import { registerAdminRefundRoutes } from "./modules/admin/refund-routes.js";
import { AdminRefundService } from "./modules/admin/refunds.js";
import { asAdminReadDatabase } from "./modules/admin/read-database.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { AdminService } from "./modules/admin/service.js";
import { asAdminWriteDatabase } from "./modules/admin/write-database.js";
import { registerDeviceRoutes } from "./modules/devices/routes.js";
import { DeviceRegistryService } from "./modules/devices/service.js";
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
import { AgentCommandService } from "./modules/print-jobs/agent-service.js";
import { registerAgentCommandRoutes, registerPrintJobRoutes } from "./modules/print-jobs/routes.js";
import { PrintJobService } from "./modules/print-jobs/service.js";
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
import { PrinterReadinessGate } from "./modules/devices/readiness.js";
import { registerSessionRoutes } from "./modules/sessions/routes.js";
import { SessionService } from "./modules/sessions/service.js";

const NON_UPLOAD_BODY_LIMIT_BYTES = 16 * 1024;

export interface BuildAppOptions {
  environment: Environment;
  logger?: boolean;
  readinessCheck?: () => Record<string, "ok" | "failed"> | Promise<Record<string, "ok" | "failed">>;
  database?: PrismaClient;
  /**
   * The control plane's read pool. Supplied only by a test that wants to point
   * it somewhere specific — for instance at the least-privilege reader role, to
   * prove the privilege matrix is what actually stops a query.
   */
  adminReadDatabase?: PrismaClient;
  /**
   * The control plane's write pool. Supplied only by a test that wants to point
   * it somewhere specific — for instance at the least-privilege writer role, to
   * prove that the absence of a grant is what stops a refund, not the code.
   */
  adminWriteDatabase?: PrismaClient;
  /**
   * The refund pool. Absent means the panel cannot authorize refunds at all,
   * which is how a deployment turns the capability off without code changes.
   */
  adminRefundDatabase?: PrismaClient;
  /**
   * The people pool. Absent means the panel cannot manage people at all, which
   * is how a deployment turns the capability off without code changes.
   */
  adminPeopleDatabase?: PrismaClient;
  /**
   * The pool an Admin proposes a change through, and the pool a tariff is
   * published through. Two, because the connection that publishes must not be
   * able to write the proposal it publishes. Absent means the panel cannot
   * change prices at all.
   */
  adminPricingDatabase?: PrismaClient;
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
              "req.headers['x-print-claim-token']",
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
    origin: [
      options.environment.KIOSK_ORIGIN,
      options.environment.UPLOAD_ORIGIN,
      // Admin is allowed by global CORS, then narrowed to this exact origin and
      // host again by the admin route hook. Cookie scope alone is not an origin
      // boundary because ports on the same hostname share cookies.
      options.environment.ADMIN_ORIGIN
    ]
  });

  const ownsDatabase = !options.database;
  const database = options.database ?? createDatabaseClient(options.environment.DATABASE_URL);
  // Every ownership separation in the control plane assumes the product's own
  // credential cannot take back what was taken from it. A superuser can, so in
  // production this refuses to start rather than serve a control plane whose
  // guarantees are decoration. Development runs as the compose image's
  // bootstrap superuser and is exempt.
  if (options.environment.NODE_ENV === "production") {
    await assertApplicationRoleIsNotPrivileged(database);
  }
  const clock = options.clock ?? new SystemClock();
  const random = options.random ?? new CryptoRandomSource();
  const objectStore = options.objectStore ?? createS3ObjectStore(options.environment);
  const sessionEvents = options.sessionEvents ?? new LocalSessionEventBus();
  // One retention policy for every path that can end a session, so a
  // cancellation, an expiry and a finished print cannot disagree about how long
  // a customer's documents stay.
  const retentionPolicy: RetentionPolicy = {
    settledGraceMilliseconds: options.environment.RETENTION_SETTLED_GRACE_SECONDS * 1_000,
    recoveryGraceMilliseconds: options.environment.RETENTION_RECOVERY_GRACE_SECONDS * 1_000
  };
  // The device gate. A kiosk whose printer cannot finish a job should say so on
  // the welcome screen, not after a customer has uploaded their documents and
  // reached a checkout. Several missed heartbeats is a machine that has stopped
  // talking; a couple is a slow network.
  const printerReadiness = new PrinterReadinessGate({
    clock,
    maxSilenceMs: options.environment.AGENT_HEARTBEAT_SECONDS * 3 * 1_000,
    maxTelemetryAgeMs: options.environment.PRINTER_TELEMETRY_MAX_AGE_SECONDS * 1_000,
    logger: app.log
  });

  const sessions = new SessionService({
    database,
    clock,
    random,
    uploadTokenPepper: options.environment.UPLOAD_TOKEN_PEPPER,
    publicUploadOrigin: options.environment.PUBLIC_UPLOAD_ORIGIN,
    idleTtlMinutes: options.environment.SESSION_IDLE_TTL_MINUTES,
    hardTtlMinutes: options.environment.SESSION_ABSOLUTE_TTL_MINUTES,
    idempotencyTtlHours: options.environment.IDEMPOTENCY_TTL_HOURS,
    retentionPolicy,
    printerReadiness
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
    paymentTimeoutSeconds: options.environment.PAYMENT_TIMEOUT_SECONDS,
    printerReadiness
  });
  // The scenario control never exists in a production build: configuration
  // validation refuses to enable it there, and this second check means a
  // mistaken environment still cannot expose a way to fail a paid print.
  const printTestOutcomesEnabled =
    options.environment.PRINT_TEST_OUTCOMES_ENABLED &&
    options.environment.NODE_ENV !== "production";
  const printJobs = new PrintJobService({
    database,
    clock,
    random,
    idempotencyPepper: options.environment.UPLOAD_TOKEN_PEPPER,
    idempotencyTtlHours: options.environment.IDEMPOTENCY_TTL_HOURS,
    printJobTimeoutSeconds: options.environment.PRINT_JOB_TIMEOUT_SECONDS,
    testOutcomesEnabled: printTestOutcomesEnabled,
    retentionPolicy
  });
  const agentCommands = new AgentCommandService({
    database,
    clock,
    random,
    leaseSeconds: options.environment.PRINT_COMMAND_LEASE_SECONDS,
    retentionPolicy
  });
  const devices = new DeviceRegistryService({
    database,
    clock,
    random,
    heartbeatIntervalSeconds: options.environment.AGENT_HEARTBEAT_SECONDS
  });
  const janitor = new FileJanitor({
    database,
    objectStore,
    clock,
    random,
    uploadTimeoutSeconds: options.environment.UPLOAD_TIMEOUT_SECONDS,
    retentionPolicy,
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
  registerPrintJobRoutes(app, {
    database,
    clock,
    printJobs,
    kioskAuthentication,
    testOutcomesEnabled: printTestOutcomesEnabled
  });
  registerAgentCommandRoutes(app, {
    database,
    clock,
    objectStore,
    commands: agentCommands,
    kioskAuthentication,
    maxDocumentBytes: options.environment.MAX_NORMALIZED_FILE_BYTES
  });
  registerDeviceRoutes(app, { database, clock, devices, kioskAuthentication });
  registerDocumentPreviewRoutes(app, {
    database,
    objectStore,
    clock,
    kioskAuthentication,
    maxPreviewBytes: options.environment.MAX_PREVIEW_FILE_BYTES
  });

  const stepUpTtlMilliseconds = options.environment.ADMIN_STEP_UP_TTL_SECONDS * 1_000;
  const adminService = new AdminService({
    database,
    clock,
    random,
    relyingParty: {
      id: options.environment.ADMIN_WEBAUTHN_RP_ID,
      name: options.environment.ADMIN_WEBAUTHN_RP_NAME,
      origin: new URL(options.environment.ADMIN_ORIGIN).origin
    },
    sessionPepper: options.environment.ADMIN_SESSION_PEPPER,
    breakGlassPepper: options.environment.ADMIN_BREAK_GLASS_PEPPER,
    idleTtlMilliseconds: options.environment.ADMIN_SESSION_IDLE_MINUTES * 60_000,
    absoluteTtlMilliseconds: options.environment.ADMIN_SESSION_ABSOLUTE_MINUTES * 60_000,
    challengeTtlMilliseconds: options.environment.ADMIN_CHALLENGE_TTL_SECONDS * 1_000
  });
  registerAdminRoutes(app, {
    admin: adminService,
    clock,
    stepUpTtlMilliseconds,
    adminOrigin: new URL(options.environment.ADMIN_ORIGIN).origin
  });

  // A pool of its own, opened read-only and — in production — connecting as a
  // role that holds no write grant and cannot select a filename, an object key
  // or a credential digest. A dashboard must not be able to write to
  // production, and it must not be able to take the connections the print path
  // needs. Both are properties of this connection rather than of the code above
  // it, and the assertion below refuses to serve the panel if either lapses.
  const adminReadDatabase =
    options.adminReadDatabase ??
    createAdminReadClient(
      options.environment.ADMIN_READ_DATABASE_URL ?? options.environment.DATABASE_URL
    );
  const ownsAdminReadDatabase = !options.adminReadDatabase;
  await assertAdminReadClientIsReadOnly(adminReadDatabase);
  if (ownsAdminReadDatabase) {
    app.addHook("onClose", async () => {
      await adminReadDatabase.$disconnect();
    });
  }

  const observability = new AdminObservabilityService({
    database: asAdminReadDatabase(adminReadDatabase),
    clock
  });

  registerAdminObservabilityRoutes(app, {
    admin: adminService,
    clock,
    stepUpTtlMilliseconds,
    observability
  });

  // A third pool, and the one that writes on an operator's behalf. In
  // production it connects as a role holding INSERT on a short list of tables
  // and no UPDATE or DELETE on anything — which is what makes "an Operator
  // cannot move money" and "nobody can rewrite what a device reported"
  // properties of the database rather than of the code above it.
  const adminWriteDatabase =
    options.adminWriteDatabase ??
    createAdminWriteClient(
      options.environment.ADMIN_WRITE_DATABASE_URL ?? options.environment.DATABASE_URL
    );
  const ownsAdminWriteDatabase = !options.adminWriteDatabase;

  // Only assert when a dedicated role is actually configured. A development
  // environment sharing the application role would fail every check below, and
  // refusing to start over that would be an outage in exchange for nothing —
  // so it gets a warning it can act on instead. Production configuration
  // requires the role, so production always asserts.
  if (options.environment.ADMIN_WRITE_DATABASE_URL) {
    await assertAdminWriteClientIsAppendOnly(adminWriteDatabase);
  } else {
    app.log.warn(
      "ADMIN_WRITE_DATABASE_URL is not set: admin actions will run on the application role. " +
        "The application still refuses everything it should, but the database is no longer " +
        "the thing enforcing it. Provision the role with `pnpm db:admin-writer provision`."
    );
  }

  if (ownsAdminWriteDatabase) {
    app.addHook("onClose", async () => {
      await adminWriteDatabase.$disconnect();
    });
  }

  registerAdminOperationsRoutes(app, {
    admin: adminService,
    clock,
    stepUpTtlMilliseconds,
    operations: new AdminOperationsService({
      database: asAdminWriteDatabase(adminWriteDatabase),
      observability,
      clock,
      random
    })
  });

  // A fourth pool, and the only connection in this process that can create an
  // obligation to pay a customer back. Separate from the write pool on purpose:
  // that one is defined by holding no grant on money at all, and the way to add
  // `refund.authorize` without discarding that property is another role, not a
  // wider one.
  //
  // Unset means the panel simply cannot authorize refunds. That is a safe
  // failure and a deliberate one — an environment without the role is an
  // environment where the route answers 503 rather than one where money moves
  // on the application's own grants.
  if (options.environment.ADMIN_REFUND_DATABASE_URL || options.adminRefundDatabase) {
    const adminRefundDatabase =
      options.adminRefundDatabase ??
      createAdminRefundClient(options.environment.ADMIN_REFUND_DATABASE_URL as string);
    const ownsAdminRefundDatabase = !options.adminRefundDatabase;

    if (options.environment.ADMIN_REFUND_DATABASE_URL) {
      await assertAdminRefundClientIsAppendOnly(adminRefundDatabase);
    }

    if (ownsAdminRefundDatabase) {
      app.addHook("onClose", async () => {
        await adminRefundDatabase.$disconnect();
      });
    }

    registerAdminRefundRoutes(app, {
      admin: adminService,
      clock,
      stepUpTtlMilliseconds,
      refunds: new AdminRefundService({
        database: asAdminRefundDatabase(adminRefundDatabase),
        clock,
        random
      })
    });
  } else {
    app.log.warn(
      "ADMIN_REFUND_DATABASE_URL is not set: authorizing a refund is unavailable. " +
        "Provision the role with `pnpm db:admin-refund-writer provision`."
    );
  }

  // A fifth pool, and the only connection in this process that can change a row
  // an account's access depends on. Separate again, for the reason the refund
  // pool is separate: the roles before it are defined by holding no UPDATE
  // anywhere, and the way to add "suspend this person" without discarding that
  // is another role rather than a wider one.
  //
  // Unset means the panel cannot manage people. Safe and deliberate, matching
  // the refund route: an environment without the role is one where these routes
  // do not exist, not one where suspensions run on the application's grants.
  if (options.environment.ADMIN_PEOPLE_DATABASE_URL || options.adminPeopleDatabase) {
    const adminPeopleDatabase =
      options.adminPeopleDatabase ??
      createAdminPeopleClient(options.environment.ADMIN_PEOPLE_DATABASE_URL as string);
    const ownsAdminPeopleDatabase = !options.adminPeopleDatabase;

    if (options.environment.ADMIN_PEOPLE_DATABASE_URL) {
      await assertAdminPeopleClientIsBounded(adminPeopleDatabase);
    }

    if (ownsAdminPeopleDatabase) {
      app.addHook("onClose", async () => {
        await adminPeopleDatabase.$disconnect();
      });
    }

    registerAdminPeopleRoutes(app, {
      admin: adminService,
      clock,
      stepUpTtlMilliseconds,
      people: new AdminPeopleService({
        database: asAdminPeopleDatabase(adminPeopleDatabase),
        clock,
        random,
        breakGlassPepper: options.environment.ADMIN_BREAK_GLASS_PEPPER
      })
    });
  } else {
    app.log.warn(
      "ADMIN_PEOPLE_DATABASE_URL is not set: managing people is unavailable. " +
        "Provision the role with `pnpm db:admin-people-writer provision`."
    );
  }

  // Changing the prices needs its own connection. Without it the panel cannot —
  // safe and deliberate, matching the refund and people routes.
  const pricingDatabaseUrl = options.environment.ADMIN_PRICING_DATABASE_URL;

  if (pricingDatabaseUrl || options.adminPricingDatabase) {
    const adminPricingDatabase =
      options.adminPricingDatabase ?? createAdminPricingClient(pricingDatabaseUrl as string);
    const ownsAdminPricingDatabase = !options.adminPricingDatabase;

    if (pricingDatabaseUrl) await assertAdminPricingClientIsBounded(adminPricingDatabase);

    if (ownsAdminPricingDatabase) {
      app.addHook("onClose", async () => {
        await adminPricingDatabase.$disconnect();
      });
    }

    registerAdminChangeRoutes(app, {
      admin: adminService,
      clock,
      stepUpTtlMilliseconds,
      changes: new AdminChangeService({
        pricing: asAdminPricingDatabase(adminPricingDatabase),
        read: asAdminReadDatabase(adminReadDatabase),
        clock,
        random
      })
    });
  } else {
    app.log.warn(
      "ADMIN_PRICING_DATABASE_URL is not set: changing prices is unavailable. " +
        "Provision the role with `pnpm db:admin-pricing-writer provision`."
    );
  }

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
