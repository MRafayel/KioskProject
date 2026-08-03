import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const MEBIBYTE = 1024 * 1024;
const MAXIMUM_IMAGE_PIXELS = 200_000_000;
const PROCESSOR_RUNTIME_HEADROOM_BYTES = 1024 * MEBIBYTE;
// Disk working set for one 32 MiB canonical page, one bounded Poppler raster,
// filesystem metadata, and temporary encoder output. Canonical pages are
// deleted before the next page is decoded.
const PROCESSOR_TRANSIENT_SCRATCH_BYTES = 96 * MEBIBYTE;

const stringBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    API_HOST: z.string().default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_ORIGIN: z.string().url().default("http://127.0.0.1:3000"),
    KIOSK_AGENT_HOST: z.string().default("127.0.0.1"),
    KIOSK_AGENT_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
    KIOSK_ORIGIN: z.string().url().default("http://localhost:5173"),
    UPLOAD_ORIGIN: z.string().url().default("http://localhost:5174"),
    PUBLIC_UPLOAD_ORIGIN: z.string().url().default("http://localhost:5174"),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine(isPostgresUrl, "DATABASE_URL must be a valid PostgreSQL URL")
      .default("postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk"),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    OBJECT_STORAGE_DRIVER: z.literal("s3").default("s3"),
    S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: z.string().min(3).default("printing-kiosk-private"),
    S3_ACCESS_KEY_ID: z.string().min(3).default("printing-kiosk-api"),
    S3_SECRET_ACCESS_KEY: z.string().min(16).default("development-api-secret-change-me"),
    S3_WORKER_ACCESS_KEY_ID: z.string().min(3).default("printing-kiosk-worker"),
    S3_WORKER_SECRET_ACCESS_KEY: z.string().min(16).default("development-worker-secret-change-me"),
    S3_FORCE_PATH_STYLE: stringBooleanSchema.default(true),
    S3_SERVER_SIDE_ENCRYPTION: z.enum(["AES256", "aws:kms"]).optional(),
    S3_KMS_KEY_ID: z.string().min(1).optional(),
    COOKIE_SIGNING_KEY: z.string().min(32).default("development-only-cookie-key-change-me"),
    UPLOAD_TOKEN_PEPPER: z.string().min(32).default("development-only-token-pepper-change-me"),
    MOBILE_TOKEN_PEPPER: z.string().min(32).default("development-only-mobile-pepper-change-me"),
    DEV_KIOSK_API_KEY: z.string().min(24).default("development-only-kiosk-key"),
    DEV_KIOSK_ID: z.string().min(1).max(64).default("kiosk_dev_001"),
    SESSION_IDLE_TTL_MINUTES: z.coerce.number().int().min(2).max(60).default(10),
    SESSION_ABSOLUTE_TTL_MINUTES: z.coerce.number().int().min(2).max(240).default(30),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    MOBILE_CLIENT_TTL_MINUTES: z.coerce.number().int().min(2).max(60).default(10),
    MAX_FILE_BYTES: z.coerce.number().int().min(1_024).max(104_857_600).default(52_428_800),
    MAX_SESSION_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(157_286_400)
      .default(52_428_800),
    MAX_FILES_PER_SESSION: z.coerce.number().int().min(1).max(10).default(1),
    UPLOAD_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(300).default(120),
    MAX_DOCUMENT_PAGES: z.coerce.number().int().min(1).max(1_000).default(200),
    MAX_IMAGE_DIMENSION_PIXELS: z.coerce.number().int().min(1_000).max(100_000).default(20_000),
    MAX_IMAGE_PIXELS: z.coerce
      .number()
      .int()
      .min(1_000_000)
      .max(MAXIMUM_IMAGE_PIXELS)
      .default(40_000_000),
    MAX_NORMALIZED_FILE_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(524_288_000)
      .default(104_857_600),
    MAX_PREVIEW_FILE_BYTES: z.coerce.number().int().min(1_024).max(20_971_520).default(2_097_152),
    PREVIEW_MAX_WIDTH_PIXELS: z.coerce.number().int().min(320).max(10_000).default(1_600),
    PREVIEW_MAX_HEIGHT_PIXELS: z.coerce.number().int().min(320).max(10_000).default(2_200),
    DOCUMENT_PROCESSOR_ADAPTER: z.literal("container").default("container"),
    DOCUMENT_PROCESSOR_IMAGE: z.string().min(1).optional(),
    DOCUMENT_PROCESSOR_URL: z.string().url().default("http://127.0.0.1:3200"),
    DOCUMENT_PROCESSOR_AUTH_TOKEN: z
      .string()
      .min(32)
      .default("development-processor-auth-token-change-me"),
    DOCUMENT_PROCESSOR_RESPONSE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(536_870_912)
      .default(536_870_912),
    DOCUMENT_PROCESSOR_SCRATCH_DIR: z.string().min(1).default(".tmp/document-worker"),
    MALWARE_SCANNER_ADAPTER: z.literal("clamav").default("clamav"),
    CLAMAV_UPDATE_CHECKS_PER_DAY: z.coerce.number().int().min(1).max(50).default(12),
    CLAMAV_HOST: z.string().min(1).default("127.0.0.1"),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
    // The current processor is intentionally single-flight. Raising worker
    // concurrency before horizontal processor routing exists only converts
    // valid work into PROCESSOR_BUSY retries.
    DOCUMENT_PROCESSING_CONCURRENCY: z.coerce.number().int().min(1).max(1).default(1),
    DOCUMENT_PROCESSOR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    DOCUMENT_PROCESSOR_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(600).default(120),
    DOCUMENT_PROCESSOR_LEASE_SECONDS: z.coerce.number().int().min(30).max(900).default(180),
    DOCUMENT_PROCESSOR_MEMORY_MIB: z.coerce.number().int().min(128).max(4_096).default(3_072),
    DOCUMENT_PROCESSOR_CPU_MILLIS: z.coerce.number().int().min(100).max(8_000).default(1_000),
    DOCUMENT_PROCESSOR_PIDS_LIMIT: z.coerce.number().int().min(8).max(512).default(64),
    DOCUMENT_PROCESSOR_SCRATCH_BYTES: z.coerce
      .number()
      .int()
      .min(16_777_216)
      .max(2_147_483_648)
      .default(2_147_483_648),
    MAX_COPIES: z.coerce.number().int().min(1).max(100).default(20),
    MAX_SELECTED_PAGES: z.coerce.number().int().min(1).max(2_000).default(200),
    MAX_PRINTED_SIDES: z.coerce.number().int().min(1).max(20_000).default(1_000),
    QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(1_800).default(300),
    PRINTER_ADAPTER: z.literal("mock").default("mock"),
    PAYMENT_PROVIDER: z.literal("mock").default("mock"),
    PAYMENT_WEBHOOK_SECRET: z
      .string()
      .min(32)
      .default("development-only-payment-webhook-secret-change-me"),
    // How long a customer has to complete a payment. It can never outlive the
    // price it is paying, so configuration validation ties it to the quote.
    PAYMENT_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(900).default(180),
    PAYMENT_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    // The deterministic outcome control for the mock provider. It is refused
    // outright in production, so a production build cannot expose it.
    PAYMENT_TEST_OUTCOMES_ENABLED: stringBooleanSchema.default(false)
  })
  .superRefine((environment, context) => {
    if (environment.SESSION_ABSOLUTE_TTL_MINUTES < environment.SESSION_IDLE_TTL_MINUTES) {
      context.addIssue({
        code: "custom",
        path: ["SESSION_ABSOLUTE_TTL_MINUTES"],
        message: "SESSION_ABSOLUTE_TTL_MINUTES must be at least SESSION_IDLE_TTL_MINUTES"
      });
    }

    if (environment.MAX_SESSION_UPLOAD_BYTES < environment.MAX_FILE_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["MAX_SESSION_UPLOAD_BYTES"],
        message: "MAX_SESSION_UPLOAD_BYTES must be at least MAX_FILE_BYTES"
      });
    }

    if (environment.MOBILE_CLIENT_TTL_MINUTES < environment.SESSION_IDLE_TTL_MINUTES) {
      context.addIssue({
        code: "custom",
        path: ["MOBILE_CLIENT_TTL_MINUTES"],
        message: "MOBILE_CLIENT_TTL_MINUTES must be at least SESSION_IDLE_TTL_MINUTES"
      });
    }

    if (
      environment.DOCUMENT_PROCESSOR_LEASE_SECONDS <= environment.DOCUMENT_PROCESSOR_TIMEOUT_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        path: ["DOCUMENT_PROCESSOR_LEASE_SECONDS"],
        message: "DOCUMENT_PROCESSOR_LEASE_SECONDS must exceed DOCUMENT_PROCESSOR_TIMEOUT_SECONDS"
      });
    }

    if (
      environment.PREVIEW_MAX_WIDTH_PIXELS > environment.MAX_IMAGE_DIMENSION_PIXELS ||
      environment.PREVIEW_MAX_HEIGHT_PIXELS > environment.MAX_IMAGE_DIMENSION_PIXELS
    ) {
      context.addIssue({
        code: "custom",
        path: ["PREVIEW_MAX_WIDTH_PIXELS"],
        message: "Preview dimensions must not exceed MAX_IMAGE_DIMENSION_PIXELS"
      });
    }

    const maximumDerivativeArchiveBytes =
      environment.MAX_NORMALIZED_FILE_BYTES +
      environment.MAX_DOCUMENT_PAGES * environment.MAX_PREVIEW_FILE_BYTES +
      1_048_576;
    if (environment.DOCUMENT_PROCESSOR_RESPONSE_MAX_BYTES < maximumDerivativeArchiveBytes) {
      context.addIssue({
        code: "custom",
        path: ["DOCUMENT_PROCESSOR_RESPONSE_MAX_BYTES"],
        message:
          "DOCUMENT_PROCESSOR_RESPONSE_MAX_BYTES must cover normalized output, every preview and archive overhead"
      });
    }

    const minimumProcessorScratchBytes =
      environment.DOCUMENT_PROCESSOR_RESPONSE_MAX_BYTES +
      environment.MAX_NORMALIZED_FILE_BYTES +
      environment.MAX_FILE_BYTES +
      environment.MAX_DOCUMENT_PAGES * environment.MAX_PREVIEW_FILE_BYTES +
      PROCESSOR_TRANSIENT_SCRATCH_BYTES;
    if (environment.DOCUMENT_PROCESSOR_SCRATCH_BYTES < minimumProcessorScratchBytes) {
      context.addIssue({
        code: "custom",
        path: ["DOCUMENT_PROCESSOR_SCRATCH_BYTES"],
        message:
          "DOCUMENT_PROCESSOR_SCRATCH_BYTES must cover source, retained previews, normalized output, response archive and one-page processing workspace"
      });
    }

    const processorMemoryBytes = environment.DOCUMENT_PROCESSOR_MEMORY_MIB * MEBIBYTE;
    if (
      processorMemoryBytes <
      environment.DOCUMENT_PROCESSOR_SCRATCH_BYTES + PROCESSOR_RUNTIME_HEADROOM_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["DOCUMENT_PROCESSOR_MEMORY_MIB"],
        message:
          "DOCUMENT_PROCESSOR_MEMORY_MIB must cover tmpfs scratch plus 1024 MiB runtime headroom"
      });
    }

    const selectablePages = environment.MAX_DOCUMENT_PAGES * environment.MAX_FILES_PER_SESSION;
    if (environment.MAX_SELECTED_PAGES > selectablePages) {
      context.addIssue({
        code: "custom",
        path: ["MAX_SELECTED_PAGES"],
        message: "MAX_SELECTED_PAGES cannot exceed MAX_DOCUMENT_PAGES × MAX_FILES_PER_SESSION"
      });
    }

    // One copy of the largest allowed selection must always be priceable;
    // otherwise a customer could upload an accepted document and then be told
    // that printing it at all is impossible.
    if (environment.MAX_PRINTED_SIDES < environment.MAX_SELECTED_PAGES) {
      context.addIssue({
        code: "custom",
        path: ["MAX_PRINTED_SIDES"],
        message: "MAX_PRINTED_SIDES must be at least MAX_SELECTED_PAGES"
      });
    }

    if (environment.QUOTE_TTL_SECONDS > environment.SESSION_IDLE_TTL_MINUTES * 60) {
      context.addIssue({
        code: "custom",
        path: ["QUOTE_TTL_SECONDS"],
        message: "QUOTE_TTL_SECONDS must not outlive the idle session window"
      });
    }

    // A payment window that outlives its quote would allow a capture against a
    // price that has already stopped being payable.
    if (environment.PAYMENT_TIMEOUT_SECONDS > environment.QUOTE_TTL_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["PAYMENT_TIMEOUT_SECONDS"],
        message: "PAYMENT_TIMEOUT_SECONDS must not exceed QUOTE_TTL_SECONDS"
      });
    }

    if (environment.S3_KMS_KEY_ID && environment.S3_SERVER_SIDE_ENCRYPTION !== "aws:kms") {
      context.addIssue({
        code: "custom",
        path: ["S3_KMS_KEY_ID"],
        message: "S3_KMS_KEY_ID requires S3_SERVER_SIDE_ENCRYPTION=aws:kms"
      });
    }

    if (
      new URL(environment.PUBLIC_UPLOAD_ORIGIN).origin !== new URL(environment.UPLOAD_ORIGIN).origin
    ) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_UPLOAD_ORIGIN"],
        message: "PUBLIC_UPLOAD_ORIGIN and UPLOAD_ORIGIN must use the same origin"
      });
    }

    // Every consumer parses this value as a URL. Rejecting it here keeps a typo
    // a fast startup failure instead of a later HTTP 500 from readiness.
    if (!isPostgresConnectionUrl(environment.DATABASE_URL)) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL must be a postgresql:// or postgres:// URL"
      });
    }

    if (environment.NODE_ENV !== "production") return;

    // A route that dictates payment outcomes is a way to print money. It does
    // not exist in production, whatever else the environment says.
    if (environment.PAYMENT_TEST_OUTCOMES_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["PAYMENT_TEST_OUTCOMES_ENABLED"],
        message: "PAYMENT_TEST_OUTCOMES_ENABLED must be false in production"
      });
    }

    const productionSecrets = [
      ["COOKIE_SIGNING_KEY", environment.COOKIE_SIGNING_KEY],
      ["UPLOAD_TOKEN_PEPPER", environment.UPLOAD_TOKEN_PEPPER],
      ["MOBILE_TOKEN_PEPPER", environment.MOBILE_TOKEN_PEPPER],
      ["S3_SECRET_ACCESS_KEY", environment.S3_SECRET_ACCESS_KEY],
      ["S3_WORKER_SECRET_ACCESS_KEY", environment.S3_WORKER_SECRET_ACCESS_KEY],
      ["DOCUMENT_PROCESSOR_AUTH_TOKEN", environment.DOCUMENT_PROCESSOR_AUTH_TOKEN],
      ["DEV_KIOSK_API_KEY", environment.DEV_KIOSK_API_KEY],
      ["PAYMENT_WEBHOOK_SECRET", environment.PAYMENT_WEBHOOK_SECRET]
    ] as const;

    for (const [name, value] of productionSecrets) {
      if (
        value.includes("development-only") ||
        value.includes("change-me") ||
        value.includes("replace-with")
      ) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: name + " must be replaced in production"
        });
      }
    }

    const cryptographicKeys = [
      environment.COOKIE_SIGNING_KEY,
      environment.UPLOAD_TOKEN_PEPPER,
      environment.MOBILE_TOKEN_PEPPER,
      environment.PAYMENT_WEBHOOK_SECRET
    ];
    if (new Set(cryptographicKeys).size !== cryptographicKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["COOKIE_SIGNING_KEY"],
        message: "Cookie and token keys must be independent in production"
      });
    }

    if (
      environment.S3_ACCESS_KEY_ID === environment.S3_WORKER_ACCESS_KEY_ID ||
      environment.S3_SECRET_ACCESS_KEY === environment.S3_WORKER_SECRET_ACCESS_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["S3_WORKER_ACCESS_KEY_ID"],
        message: "API and processor worker object-storage credentials must be independent"
      });
    }

    if (
      !environment.DOCUMENT_PROCESSOR_IMAGE ||
      !/@sha256:[0-9a-f]{64}$/u.test(environment.DOCUMENT_PROCESSOR_IMAGE)
    ) {
      context.addIssue({
        code: "custom",
        path: ["DOCUMENT_PROCESSOR_IMAGE"],
        message: "Production document processor image must be pinned by sha256 digest"
      });
    }

    const processorUrl = new URL(environment.DOCUMENT_PROCESSOR_URL);
    if (
      processorUrl.protocol !== "https:" &&
      !(processorUrl.protocol === "http:" && isLoopbackHostname(processorUrl.hostname))
    ) {
      context.addIssue({
        code: "custom",
        path: ["DOCUMENT_PROCESSOR_URL"],
        message: "DOCUMENT_PROCESSOR_URL must use HTTPS in production unless it is loopback-only"
      });
    }

    if (!environment.S3_SERVER_SIDE_ENCRYPTION) {
      context.addIssue({
        code: "custom",
        path: ["S3_SERVER_SIDE_ENCRYPTION"],
        message: "S3_SERVER_SIDE_ENCRYPTION is required in production"
      });
    }

    const productionOrigins = [
      ["API_ORIGIN", environment.API_ORIGIN, true],
      ["KIOSK_ORIGIN", environment.KIOSK_ORIGIN, true],
      ["UPLOAD_ORIGIN", environment.UPLOAD_ORIGIN, false],
      ["PUBLIC_UPLOAD_ORIGIN", environment.PUBLIC_UPLOAD_ORIGIN, false]
    ] as const;

    for (const [name, value, allowHttpLoopback] of productionOrigins) {
      const url = new URL(value);
      const isSecure = url.protocol === "https:";
      const isAllowedLoopback =
        allowHttpLoopback && url.protocol === "http:" && isLoopbackHostname(url.hostname);
      if (!isSecure && !isAllowedLoopback) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: name + " must use HTTPS in production"
        });
      }
    }

    const objectStorageUrl = new URL(environment.S3_ENDPOINT);
    if (
      objectStorageUrl.protocol !== "https:" &&
      !(objectStorageUrl.protocol === "http:" && isLoopbackHostname(objectStorageUrl.hostname))
    ) {
      context.addIssue({
        code: "custom",
        path: ["S3_ENDPOINT"],
        message: "S3_ENDPOINT must use HTTPS in production unless it is loopback-only"
      });
    }

    const redisUrl = new URL(environment.REDIS_URL);
    if (
      redisUrl.protocol !== "rediss:" &&
      !(redisUrl.protocol === "redis:" && isLoopbackHostname(redisUrl.hostname))
    ) {
      context.addIssue({
        code: "custom",
        path: ["REDIS_URL"],
        message: "REDIS_URL must use TLS in production unless it is loopback-only"
      });
    }

    const databaseUrl = new URL(environment.DATABASE_URL);
    if (
      !isLoopbackHostname(databaseUrl.hostname) &&
      databaseUrl.searchParams.get("sslmode") !== "verify-full"
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message:
          "Remote production DATABASE_URL must use sslmode=verify-full for certificate and hostname verification"
      });
    }
  });

function isPostgresUrl(value: string): boolean {
  try {
    return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isPostgresConnectionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgresql:" || url.protocol === "postgres:";
  } catch {
    return false;
  }
}

export type Environment = z.infer<typeof environmentSchema>;

export interface RedisConnectionOptions {
  host: string;
  port: number;
  db: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
}

export function redisConnectionOptions(redisUrl: string): RedisConnectionOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL_PROTOCOL_UNSUPPORTED");
  }
  const databasePath = url.pathname.replace(/^\//, "");
  const database = databasePath ? Number(databasePath) : 0;
  if (!Number.isInteger(database) || database < 0) {
    throw new Error("REDIS_URL_DATABASE_INVALID");
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "rediss:" ? 6380 : 6379,
    db: database,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null
  };
}

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}

/**
 * Workspace commands execute with the package as cwd. Locate the repository
 * root explicitly so the documented root .env file behaves the same on every
 * service and on Windows, macOS, and Linux.
 */
export function loadWorkspaceEnvironmentFile(startDirectory = process.cwd()): void {
  let directory = resolve(startDirectory);
  while (true) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      const path = join(directory, ".env");
      if (existsSync(path)) loadDotenv({ path, override: false, quiet: true });
      return;
    }

    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

export { environmentSchema };
