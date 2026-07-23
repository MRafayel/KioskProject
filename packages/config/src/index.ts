import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

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
      .default("postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk"),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    OBJECT_STORAGE_DRIVER: z.literal("s3").default("s3"),
    S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: z.string().min(3).default("printing-kiosk-private"),
    S3_ACCESS_KEY_ID: z.string().min(3).default("printing-kiosk-api"),
    S3_SECRET_ACCESS_KEY: z.string().min(16).default("development-api-secret-change-me"),
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
    PRINTER_ADAPTER: z.literal("mock").default("mock"),
    PAYMENT_PROVIDER: z.literal("mock").default("mock")
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

    if (environment.NODE_ENV !== "production") return;

    const productionSecrets = [
      ["COOKIE_SIGNING_KEY", environment.COOKIE_SIGNING_KEY],
      ["UPLOAD_TOKEN_PEPPER", environment.UPLOAD_TOKEN_PEPPER],
      ["MOBILE_TOKEN_PEPPER", environment.MOBILE_TOKEN_PEPPER],
      ["S3_SECRET_ACCESS_KEY", environment.S3_SECRET_ACCESS_KEY],
      ["DEV_KIOSK_API_KEY", environment.DEV_KIOSK_API_KEY]
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
      environment.MOBILE_TOKEN_PEPPER
    ];
    if (new Set(cryptographicKeys).size !== cryptographicKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["COOKIE_SIGNING_KEY"],
        message: "Cookie and token keys must be independent in production"
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
  });

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
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
