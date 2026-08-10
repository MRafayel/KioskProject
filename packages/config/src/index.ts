import { existsSync } from "node:fs";
import { isIP } from "node:net";
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
    // The admin control plane. Its API routes enforce this exact browser origin
    // in addition to CORS. Cookies are scoped to hosts rather than ports, so a
    // dedicated production hostname remains preferable to port-only isolation.
    ADMIN_ORIGIN: z.string().url().default("http://localhost:5175"),
    // The WebAuthn relying party. RP_ID is the registrable domain credentials
    // are bound to; a credential enrolled against one RP_ID cannot be used
    // against another, which is what makes admin credentials unphishable.
    ADMIN_WEBAUTHN_RP_ID: z.string().min(1).max(253).default("localhost"),
    ADMIN_WEBAUTHN_RP_NAME: z.string().min(1).max(64).default("Printing Kiosk Admin"),
    ADMIN_SESSION_PEPPER: z
      .string()
      .min(32)
      .default("development-only-admin-session-pepper-change-me"),
    // Break-glass digests are peppered separately, so a leak of the session
    // pepper cannot be used to forge a recovery credential.
    ADMIN_BREAK_GLASS_PEPPER: z
      .string()
      .min(32)
      .default("development-only-admin-break-glass-pepper-change-me"),
    // Admin sessions are short. An unattended browser in a back office is a
    // realistic threat, and nothing in this plane is worth a long window.
    ADMIN_SESSION_IDLE_MINUTES: z.coerce.number().int().min(2).max(120).default(15),
    ADMIN_SESSION_ABSOLUTE_MINUTES: z.coerce.number().int().min(5).max(720).default(240),
    // How long a WebAuthn assertion authorises R2 actions. Short enough that it
    // covers one deliberate task, not a whole shift.
    ADMIN_STEP_UP_TTL_SECONDS: z.coerce.number().int().min(30).max(1_800).default(300),
    // A ceremony a person is actively completing. Long enough to find a key in
    // a drawer, short enough that an abandoned challenge does not linger.
    ADMIN_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(180),
    ADMIN_BREAK_GLASS_TTL_HOURS: z.coerce.number().int().min(1).max(8_760).default(2_160),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine(isPostgresUrl, "DATABASE_URL must be a valid PostgreSQL URL")
      .default("postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk"),
    // The control plane's own connection, as the least-privilege reader role
    // provisioned by `pnpm db:admin-reader provision`. Production requires it:
    // that role's grants are what stop an admin read path from reaching a
    // customer's filename or a credential digest, and they only apply if the
    // panel actually connects as it. Development may leave it unset and share
    // the application role, which is still opened read-only.
    ADMIN_READ_DATABASE_URL: z
      .string()
      .min(1)
      .refine(isPostgresUrl, "ADMIN_READ_DATABASE_URL must be a valid PostgreSQL URL")
      .optional(),
    // The connection the control plane's few operator actions write through, as
    // the least-privilege writer role provisioned by `pnpm db:admin-writer
    // provision`. That role holds INSERT on two tables and no UPDATE or DELETE
    // anywhere, which is what stops a compromised admin backend from issuing a
    // refund or rewriting what a printer reported. Production requires it.
    // Development may leave it unset and share the application role — the
    // application's own checks still apply, but the database stops enforcing
    // them, so the API says so at boot.
    ADMIN_WRITE_DATABASE_URL: z
      .string()
      .min(1)
      .refine(isPostgresUrl, "ADMIN_WRITE_DATABASE_URL must be a valid PostgreSQL URL")
      .optional(),
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
    // Where the simulated printer writes its output. It is a private local
    // directory, never a web root, and it holds one folder per operation.
    PRINTER_MOCK_OUTPUT_DIR: z.string().min(1).default("var/mock-printer/output"),
    // The agent's local spool. A print-ready artifact is written here under a
    // random name, verified, printed, and deleted.
    PRINTER_SPOOL_DIR: z.string().min(1).default(".tmp/kiosk-agent-spool"),
    // How long a whole print job may take before it is settled without the
    // device. It never claims an outcome: a job past its deadline that was
    // already handed over becomes RECOVERY_REQUIRED.
    PRINT_JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1_800).default(300),
    PRINT_COMMAND_LEASE_SECONDS: z.coerce.number().int().min(15).max(900).default(120),
    // A lease may be handed back at most this many times. Every redelivery
    // makes the agent ask the device what it already did before submitting.
    PRINT_COMMAND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
    PRINT_DISPATCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    // How long the simulated printer's output survives. It is the evidence a
    // redelivered operation is resolved against, so it must outlive the job it
    // belongs to; after that it is only a copy of a customer's document.
    PRINTER_OUTPUT_RETENTION_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    // The deterministic device scenarios. Refused outright in production, so a
    // production build cannot be told to fail a print on request.
    PRINT_TEST_OUTCOMES_ENABLED: stringBooleanSchema.default(false),
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
    PAYMENT_TEST_OUTCOMES_ENABLED: stringBooleanSchema.default(false),
    // Retention. A session that ended without reaching a device deletes its
    // documents immediately; only an outcome somebody may still ask about is
    // given a grace, and it is measured in minutes.
    RETENTION_SETTLED_GRACE_SECONDS: z.coerce.number().int().min(0).max(3_600).default(300),
    RETENTION_RECOVERY_GRACE_SECONDS: z.coerce.number().int().min(0).max(3_600).default(900),
    RETENTION_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
    RETENTION_LEASE_SECONDS: z.coerce.number().int().min(30).max(900).default(120),
    // A run that has failed this many times stops retrying and is dead-lettered
    // for a person. It is never treated as finished: the documents are still
    // there and only the storage lifecycle rule is still holding the line.
    RETENTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
    // How old a stray object must be before the reconciler is willing to call
    // it orphaned. It has to outlive the longest-lived live session, or the
    // sweep could delete a document somebody is still uploading.
    RETENTION_ORPHAN_GRACE_SECONDS: z.coerce.number().int().min(300).max(86_400).default(7_200)
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

    // A lease that outlives the job it belongs to could hand work to a device
    // after the control plane has already settled the job without it.
    if (environment.PRINT_COMMAND_LEASE_SECONDS >= environment.PRINT_JOB_TIMEOUT_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["PRINT_COMMAND_LEASE_SECONDS"],
        message: "PRINT_COMMAND_LEASE_SECONDS must be shorter than PRINT_JOB_TIMEOUT_SECONDS"
      });
    }

    // Printing happens after payment, inside a session that no longer refreshes
    // its idle window. A job that could outlive its session would be settled by
    // expiry rather than by the device.
    if (environment.PRINT_JOB_TIMEOUT_SECONDS > environment.SESSION_ABSOLUTE_TTL_MINUTES * 60) {
      context.addIssue({
        code: "custom",
        path: ["PRINT_JOB_TIMEOUT_SECONDS"],
        message: "PRINT_JOB_TIMEOUT_SECONDS must not outlive the absolute session window"
      });
    }

    // The mock printer's output is what a redelivered operation is resolved
    // against instead of being printed a second time. Pruning it before the job
    // it belongs to can no longer be redelivered would turn a duplicate command
    // into a duplicate print.
    if (environment.PRINTER_OUTPUT_RETENTION_SECONDS < environment.PRINT_JOB_TIMEOUT_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["PRINTER_OUTPUT_RETENTION_SECONDS"],
        message: "PRINTER_OUTPUT_RETENTION_SECONDS must be at least PRINT_JOB_TIMEOUT_SECONDS"
      });
    }

    // The reconciler deletes by prefix age alone, without a ledger row to
    // confirm against. Its cutoff must therefore be older than any object a
    // live session could still own, including one written at the very end of
    // the longest retention grace.
    const longestSessionLifetimeSeconds =
      environment.SESSION_ABSOLUTE_TTL_MINUTES * 60 +
      Math.max(
        environment.RETENTION_SETTLED_GRACE_SECONDS,
        environment.RETENTION_RECOVERY_GRACE_SECONDS
      );
    if (environment.RETENTION_ORPHAN_GRACE_SECONDS <= longestSessionLifetimeSeconds) {
      context.addIssue({
        code: "custom",
        path: ["RETENTION_ORPHAN_GRACE_SECONDS"],
        message:
          "RETENTION_ORPHAN_GRACE_SECONDS must exceed the absolute session window plus the longest retention grace"
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

    const adminUrl = new URL(environment.ADMIN_ORIGIN);
    // Origins have no path, query, fragment or credentials. Keeping the
    // serialized value canonical matters because CORS compares it as a string;
    // accepting a URL-shaped value such as a trailing slash would start an
    // admin plane that the browser cannot reach.
    if (adminUrl.origin !== environment.ADMIN_ORIGIN) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_ORIGIN"],
        message: "ADMIN_ORIGIN must be a serialized origin with no path, query or trailing slash"
      });
    }

    // WebAuthn is available over HTTP only in a potentially trustworthy local
    // context. A LAN URL may work for ordinary HTTP but the browser will refuse
    // every credential ceremony, so fail at startup in every environment.
    if (
      adminUrl.protocol !== "https:" &&
      !(adminUrl.protocol === "http:" && isWebAuthnLoopbackHostname(adminUrl.hostname))
    ) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_ORIGIN"],
        message: "ADMIN_ORIGIN must use HTTPS unless it is a loopback or localhost origin"
      });
    }

    // A credential is bound to the relying party identifier, and the browser
    // refuses a ceremony whose RP ID is not a suffix of the page's own domain.
    // Catching syntax and relationship mistakes at startup turns an unusable
    // login into a failure that names the setting.
    const adminHost = adminUrl.hostname;
    const relyingPartyId = environment.ADMIN_WEBAUTHN_RP_ID;
    if (!isCanonicalWebAuthnRpId(relyingPartyId)) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_WEBAUTHN_RP_ID"],
        message: "ADMIN_WEBAUTHN_RP_ID must be a canonical hostname without a scheme or port"
      });
    }

    const adminIsIpAddress = ipVersionOfHostname(adminHost) !== 0;
    const relyingPartyIsIpAddress = ipVersionOfHostname(relyingPartyId) !== 0;
    const relyingPartyMatches =
      adminIsIpAddress || relyingPartyIsIpAddress
        ? adminHost === relyingPartyId
        : adminHost === relyingPartyId || adminHost.endsWith("." + relyingPartyId);
    if (!relyingPartyMatches) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_WEBAUTHN_RP_ID"],
        message: "ADMIN_WEBAUTHN_RP_ID must equal the ADMIN_ORIGIN host or be a parent domain of it"
      });
    }

    // An admin session that could outlive its absolute window would be ended by
    // a sweep rather than by policy.
    if (environment.ADMIN_SESSION_IDLE_MINUTES > environment.ADMIN_SESSION_ABSOLUTE_MINUTES) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_SESSION_IDLE_MINUTES"],
        message: "ADMIN_SESSION_IDLE_MINUTES must not exceed ADMIN_SESSION_ABSOLUTE_MINUTES"
      });
    }

    // Step-up exists so a sensitive action needs a fresh touch. If it outlived
    // the session's own idle window it would never be the binding constraint.
    if (environment.ADMIN_STEP_UP_TTL_SECONDS > environment.ADMIN_SESSION_IDLE_MINUTES * 60) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_STEP_UP_TTL_SECONDS"],
        message: "ADMIN_STEP_UP_TTL_SECONDS must not exceed the admin idle session window"
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

    if (
      environment.ADMIN_READ_DATABASE_URL !== undefined &&
      !isPostgresConnectionUrl(environment.ADMIN_READ_DATABASE_URL)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_READ_DATABASE_URL"],
        message: "ADMIN_READ_DATABASE_URL must be a postgresql:// or postgres:// URL"
      });
    }

    if (
      environment.ADMIN_WRITE_DATABASE_URL !== undefined &&
      !isPostgresConnectionUrl(environment.ADMIN_WRITE_DATABASE_URL)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_WRITE_DATABASE_URL"],
        message: "ADMIN_WRITE_DATABASE_URL must be a postgresql:// or postgres:// URL"
      });
    }

    if (environment.NODE_ENV !== "production") return;

    // Sharing the application role would give the control plane every grant the
    // print path holds, including the columns that name and locate a customer's
    // documents. In production the panel connects as its own role or not at all.
    if (
      environment.ADMIN_READ_DATABASE_URL === undefined ||
      environment.ADMIN_READ_DATABASE_URL === environment.DATABASE_URL
    ) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_READ_DATABASE_URL"],
        message:
          "ADMIN_READ_DATABASE_URL must be set in production and must not equal DATABASE_URL. " +
          "Provision the reader role with `pnpm db:admin-reader provision`."
      });
    }

    // Three connections, three different sets of grants. The write role must
    // differ from the application role for the obvious reason, and from the
    // read role for a less obvious one: the read role cannot write at all, so
    // pointing the write pool at it would fail every operator action at
    // runtime rather than at deploy time.
    if (
      environment.ADMIN_WRITE_DATABASE_URL === undefined ||
      environment.ADMIN_WRITE_DATABASE_URL === environment.DATABASE_URL ||
      environment.ADMIN_WRITE_DATABASE_URL === environment.ADMIN_READ_DATABASE_URL
    ) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_WRITE_DATABASE_URL"],
        message:
          "ADMIN_WRITE_DATABASE_URL must be set in production and must differ from both " +
          "DATABASE_URL and ADMIN_READ_DATABASE_URL. " +
          "Provision the writer role with `pnpm db:admin-writer provision`."
      });
    }

    // A route that dictates payment outcomes is a way to print money. It does
    // not exist in production, whatever else the environment says.
    if (environment.PAYMENT_TEST_OUTCOMES_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["PAYMENT_TEST_OUTCOMES_ENABLED"],
        message: "PAYMENT_TEST_OUTCOMES_ENABLED must be false in production"
      });
    }

    // A route that dictates print outcomes is a way to fail a paid job on
    // request. It does not exist in production either.
    if (environment.PRINT_TEST_OUTCOMES_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["PRINT_TEST_OUTCOMES_ENABLED"],
        message: "PRINT_TEST_OUTCOMES_ENABLED must be false in production"
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
      ["PAYMENT_WEBHOOK_SECRET", environment.PAYMENT_WEBHOOK_SECRET],
      ["ADMIN_SESSION_PEPPER", environment.ADMIN_SESSION_PEPPER],
      ["ADMIN_BREAK_GLASS_PEPPER", environment.ADMIN_BREAK_GLASS_PEPPER]
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

    const independentSecrets = [
      environment.COOKIE_SIGNING_KEY,
      environment.UPLOAD_TOKEN_PEPPER,
      environment.MOBILE_TOKEN_PEPPER,
      environment.S3_SECRET_ACCESS_KEY,
      environment.S3_WORKER_SECRET_ACCESS_KEY,
      environment.DOCUMENT_PROCESSOR_AUTH_TOKEN,
      environment.DEV_KIOSK_API_KEY,
      environment.PAYMENT_WEBHOOK_SECRET,
      environment.ADMIN_SESSION_PEPPER,
      environment.ADMIN_BREAK_GLASS_PEPPER
    ];
    if (new Set(independentSecrets).size !== independentSecrets.length) {
      context.addIssue({
        code: "custom",
        path: ["PAYMENT_WEBHOOK_SECRET"],
        message: "Every production credential and cryptographic secret must be independent"
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
      ["PUBLIC_UPLOAD_ORIGIN", environment.PUBLIC_UPLOAD_ORIGIN, false],
      // No loopback exception. WebAuthn requires a secure context, and the
      // `__Host-` session cookie the admin plane sets requires HTTPS.
      ["ADMIN_ORIGIN", environment.ADMIN_ORIGIN, false]
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

    // The control plane's connection carries the same data over the same
    // network, so it is held to the same transport rule as the application's.
    for (const name of [
      "DATABASE_URL",
      "ADMIN_READ_DATABASE_URL",
      "ADMIN_WRITE_DATABASE_URL"
    ] as const) {
      const value = environment[name];
      if (value === undefined) continue;
      const url = new URL(value);
      if (!isLoopbackHostname(url.hostname) && url.searchParams.get("sslmode") !== "verify-full") {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `Remote production ${name} must use sslmode=verify-full for certificate and hostname verification`
        });
      }
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

function ipVersionOfHostname(hostname: string): number {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(unwrapped);
}

function isWebAuthnLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const version = isIP(unwrapped);
  if (version === 6) return unwrapped === "::1";
  return version === 4 && unwrapped.startsWith("127.");
}

function isCanonicalWebAuthnRpId(value: string): boolean {
  if (value.endsWith(".")) return false;
  const ipVersion = ipVersionOfHostname(value);
  if (ipVersion !== 0) {
    try {
      return new URL(`https://${value}`).hostname === value;
    } catch {
      return false;
    }
  }

  if (value.length > 253) return false;
  return value
    .split(".")
    .every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    );
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

const ADMIN_ENVIRONMENT_KEYS = [
  "ADMIN_ORIGIN",
  "ADMIN_WEBAUTHN_RP_ID",
  "ADMIN_WEBAUTHN_RP_NAME",
  "ADMIN_SESSION_PEPPER",
  "ADMIN_BREAK_GLASS_PEPPER",
  "ADMIN_SESSION_IDLE_MINUTES",
  "ADMIN_SESSION_ABSOLUTE_MINUTES",
  "ADMIN_STEP_UP_TTL_SECONDS",
  "ADMIN_CHALLENGE_TTL_SECONDS",
  "ADMIN_BREAK_GLASS_TTL_HOURS",
  // Two more database passwords. A worker or kiosk process has no admin panel
  // to serve and therefore no reason to hold either — and the write one is the
  // only credential in this system that can append to the audit log.
  "ADMIN_READ_DATABASE_URL",
  "ADMIN_WRITE_DATABASE_URL"
] as const;
type AdminEnvironmentKey = (typeof ADMIN_ENVIRONMENT_KEYS)[number];
const ADMIN_ENVIRONMENT_KEY_SET: ReadonlySet<string> = new Set(ADMIN_ENVIRONMENT_KEYS);

/** Runtime configuration for processes that must never receive admin secrets. */
export type NonAdminEnvironment = Omit<Environment, AdminEnvironmentKey>;

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

/** Explicit API entry point: the API is the only long-running process that owns admin secrets. */
export function loadApiEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return loadEnvironment(source);
}

/**
 * Parse shared worker/device settings without requiring or retaining any admin
 * control-plane configuration. Values from the source are deliberately
 * overwritten before validation, then removed from the returned object. This
 * prevents a broad legacy Environment type from turning into a reason to
 * distribute recovery peppers to a kiosk or background worker.
 */
export function loadNonAdminEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NonAdminEnvironment {
  const nonAdminSource: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(source)) {
    if (!ADMIN_ENVIRONMENT_KEY_SET.has(name)) nonAdminSource[name] = source[name];
  }

  const parsed = environmentSchema.parse({
    ...nonAdminSource,
    ADMIN_ORIGIN: "https://admin.invalid",
    ADMIN_WEBAUTHN_RP_ID: "admin.invalid",
    ADMIN_WEBAUTHN_RP_NAME: "Unused outside API",
    ADMIN_SESSION_PEPPER: "not-loaded-outside-api-admin-session-pepper",
    ADMIN_BREAK_GLASS_PEPPER: "not-loaded-outside-api-break-glass-pepper",
    ADMIN_SESSION_IDLE_MINUTES: "15",
    ADMIN_SESSION_ABSOLUTE_MINUTES: "240",
    ADMIN_STEP_UP_TTL_SECONDS: "300",
    ADMIN_CHALLENGE_TTL_SECONDS: "180",
    ADMIN_BREAK_GLASS_TTL_HOURS: "2160",
    // Loopback so the production transport rule does not demand TLS settings
    // for connections this process will never open, and distinct from each
    // other because production requires the three roles to differ.
    ADMIN_READ_DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/not-loaded-outside-api",
    ADMIN_WRITE_DATABASE_URL:
      "postgresql://unused:unused@127.0.0.1:5432/not-loaded-outside-api-write"
  });
  return Object.fromEntries(
    Object.entries(parsed).filter(([name]) => !ADMIN_ENVIRONMENT_KEY_SET.has(name))
  ) as NonAdminEnvironment;
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
