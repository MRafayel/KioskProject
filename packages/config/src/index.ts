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
/**
 * The shortest submission budget the Windows device host can be held to.
 *
 * It has to start a process, compile its inline type, load the PDF renderer,
 * rasterise the selection and draw it through the driver before it can observe
 * anything, and only 80% of the budget is left for the observation itself.
 */
const MIN_WINDOWS_PRINT_JOB_TIMEOUT_SECONDS = 120;

const stringBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Set by the Windows service installer, never by hand.
    //
    // `NODE_ENV` describes how the code was built; this describes where it is
    // running. A machine that installed the agent as a service is a deployment
    // — it starts unattended, nobody watches it, and it is the machine a
    // customer stands in front of — whatever `NODE_ENV` happens to say. The
    // simulation switches below are refused on the strength of this alone.
    PRINTING_KIOSK_SERVICE: stringBooleanSchema.default(false),
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
    // Session windows per role. Inactivity locks the session rather than
    // destroying it — a lock screen and a quick reauthentication, not a
    // sign-out — so these idle windows can match how the roles actually work: a
    // whole shift for an Operator, tighter for the roles a stolen unlocked
    // browser could do real damage as. The absolute window is the one nothing
    // extends; it exists so no cookie lives forever, not to interrupt a
    // working day.
    ADMIN_SESSION_IDLE_MINUTES_OPERATOR: z.coerce.number().int().min(2).max(720).default(360),
    ADMIN_SESSION_IDLE_MINUTES_ADMIN: z.coerce.number().int().min(2).max(360).default(120),
    ADMIN_SESSION_IDLE_MINUTES_TECHNICAL_ADMIN: z.coerce.number().int().min(2).max(240).default(60),
    ADMIN_SESSION_ABSOLUTE_HOURS_OPERATOR: z.coerce.number().int().min(1).max(2_160).default(720),
    ADMIN_SESSION_ABSOLUTE_HOURS_ADMIN: z.coerce.number().int().min(1).max(1_080).default(336),
    ADMIN_SESSION_ABSOLUTE_HOURS_TECHNICAL_ADMIN: z.coerce
      .number()
      .int()
      .min(1)
      .max(720)
      .default(168),
    // One-time grants. An invitation is carried to a colleague and accepted
    // within days; a reset is read out over a shoulder and used within the
    // hour.
    ADMIN_INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(336).default(72),
    ADMIN_PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(60),
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
    // The one connection in this system that can create a monetary obligation,
    // as the role provisioned by `pnpm db:admin-refund-writer provision`. It
    // holds INSERT on `refunds`, on the record of who authorized one, and on
    // the audit log — and no UPDATE anywhere, so the panel can raise a refund
    // and can never settle one. Kept apart from the writer role so that "which
    // connection can pay a customer" stays answerable by reading a grant list.
    // Production requires it; development may leave it unset, in which case
    // authorizing a refund is unavailable rather than silently unprotected.
    ADMIN_REFUND_DATABASE_URL: z
      .string()
      .min(1)
      .refine(isPostgresUrl, "ADMIN_REFUND_DATABASE_URL must be a valid PostgreSQL URL")
      .optional(),
    // The connection that administers people, as the role provisioned by
    // `pnpm db:admin-people-writer provision`. The first one in this list that
    // can change a row rather than add one, and the only one that holds UPDATE
    // at all — on nine named columns, never on a table. Notably absent from
    // those columns is `admin_users.role`: nothing reachable from a browser
    // promotes anybody. Production requires it; development may leave it unset,
    // in which case managing people is unavailable rather than unprotected.
    ADMIN_PEOPLE_DATABASE_URL: z
      .string()
      .min(1)
      .refine(isPostgresUrl, "ADMIN_PEOPLE_DATABASE_URL must be a valid PostgreSQL URL")
      .optional(),
    // The connection a tariff is published through, as the role provisioned by
    // `pnpm db:admin-pricing-writer provision`. The only one in this system that
    // can change what a customer will be charged, and it cannot commit a tariff
    // that no publication record accounts for — which is what makes "who changed
    // the prices" a fact about the database rather than a claim about the
    // application.
    ADMIN_PRICING_DATABASE_URL: z
      .string()
      .min(1)
      .refine(isPostgresUrl, "ADMIN_PRICING_DATABASE_URL must be a valid PostgreSQL URL")
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
    // One session may carry several documents. The ceiling is the same 10 the
    // settings contract and the print manifest already bound themselves to, so
    // this can be raised to that limit but never past what those accept. A
    // deployment that wants the older one-document-per-session behaviour sets
    // this to 1; nothing else has to change for that to keep working.
    MAX_FILES_PER_SESSION: z.coerce.number().int().min(1).max(10).default(10),
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
    MAX_COPIES: z.coerce.number().int().min(1).max(10).default(10),
    MAX_SELECTED_PAGES: z.coerce.number().int().min(1).max(2_000).default(200),
    MAX_PRINTED_SIDES: z.coerce.number().int().min(1).max(20_000).default(1_000),
    QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(1_800).default(300),
    // Which device this kiosk drives. `mock` writes files and `windows` drives
    // the local USB print subsystem through a device host. Network printing is
    // deliberately not a deployable option. Production refuses `mock`: a kiosk that took a
    // customer's money and wrote their document to a folder is not a kiosk.
    PRINTER_ADAPTER: z.enum(["mock", "windows"]).default("mock"),
    // The queue names an operator certified for this kiosk, comma separated.
    // Empty approves nothing, which is the only safe default: an uncertified
    // kiosk must not print to whatever queue a driver installer left behind.
    PRINTER_QUEUE_ALLOWLIST: z.string().max(2_000).default(""),
    // Which approved queue to use when the machine offers more than one. A
    // kiosk with two certified printers and no preference refuses rather than
    // guessing which room the customer's paper comes out in.
    PRINTER_QUEUE_NAME: z.string().max(220).default(""),
    // Whether a queue published to other machines may be used. A kiosk opens no
    // other inbound path, so this stays off unless a deployment says otherwise.
    PRINTER_ALLOW_SHARED_QUEUE: stringBooleanSchema.default(false),
    // The Windows device host executable. See docs/hardware/windows-device-host.md.
    PRINTER_WINDOWS_HOST_PATH: z.string().max(400).default(""),
    // Which printer/driver combinations an operator has certified, as JSON:
    //   [{"driverName":"Canon Generic Plus UFR II","portPattern":"^USB\\d+$"}]
    //
    // Approving a printer model is a certification decision, exactly like the
    // queue allowlist beside it — somebody tested that this driver renders what
    // a customer paid for. It used to be a constant inside the device host,
    // which meant approving a second model required editing a script on every
    // kiosk. Empty keeps the reference profile, so an existing deployment
    // behaves identically. A queue matching no profile is refused with
    // QUEUE_NOT_APPROVED; it is never a fall-back to another printer.
    PRINTER_DEVICE_PROFILES: z.string().max(4_000).default(""),
    // Where the agent keeps its record of what it handed to a device. It is
    // what separates "never submitted" from "submitted and forgotten", so it
    // has to survive a restart on the same machine as the agent.
    PRINTER_DEVICE_JOURNAL_DIR: z.string().min(1).default(".tmp/kiosk-agent-device"),
    // Physical printer telemetry over a dedicated Ethernet link.
    //
    // Printing stays on USB and does not change: this is a read-only SNMP path
    // to the printer's own engine, because the USB driver reports no physical
    // state at all — Canon's own tool answers "this device does not support
    // information retrieval via USB connection". Everything below configures one
    // explicitly named printer. There is no discovery, no fallback, and no
    // configuration in which a network queue becomes printable.
    PRINTER_TELEMETRY_ENABLED: stringBooleanSchema.default(false),
    // An IPv4 literal on the point-to-point segment, never a hostname: name
    // resolution on that cable is an attack surface with nothing to gain.
    PRINTER_TELEMETRY_HOST: z.string().max(45).default(""),
    PRINTER_TELEMETRY_PORT: z.coerce.number().int().min(1).max(65_535).default(161),
    // Pinned identity, checked on every reading. A reply from anything else is
    // discarded rather than believed.
    PRINTER_TELEMETRY_SERIAL: z.string().max(64).default(""),
    // Optional second pin. Empty disables the check; it is reported by the
    // device about itself, so it catches a cable moved to the wrong printer
    // rather than an attacker willing to echo whatever we pinned.
    PRINTER_TELEMETRY_MAC: z.string().max(17).default(""),
    // SNMPv3 only, and authPriv only. There is no setting here that sends an
    // unauthenticated request or an unencrypted one.
    PRINTER_TELEMETRY_SNMP_USER: z.string().max(32).default(""),
    // `md5` and `des` are the weakest the enumerations allow and are here
    // because the firmware, not the deployment, decides what is on offer:
    // refusing them outright would mean no telemetry at all on a printer that
    // supports nothing better, which is a worse outcome on a cable that has two
    // devices and no route off it. Prefer sha256/aes wherever the printer will.
    PRINTER_TELEMETRY_SNMP_AUTH_PROTOCOL: z
      .enum(["md5", "sha", "sha224", "sha256", "sha384", "sha512"])
      .default("sha256"),
    PRINTER_TELEMETRY_SNMP_AUTH_KEY: z.string().max(128).default(""),
    PRINTER_TELEMETRY_SNMP_PRIV_PROTOCOL: z
      .enum(["des", "aes", "aes256b", "aes256r"])
      .default("aes"),
    PRINTER_TELEMETRY_SNMP_PRIV_KEY: z.string().max(128).default(""),
    // Which local interface telemetry leaves by. Pinning it keeps SNMP on the
    // printer's dedicated adapter even if the routing table changes. Empty lets
    // the operating system choose.
    PRINTER_TELEMETRY_SOURCE_ADDRESS: z.string().max(45).default(""),
    // Whether a kiosk that cannot read its printer may keep selling. The safe
    // answer is no — nobody should pay for a job we could not honestly confirm —
    // so this defaults on and is a deliberate, documented opt-out.
    PRINTER_TELEMETRY_REQUIRED: stringBooleanSchema.default(true),
    PRINTER_TELEMETRY_POLL_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
    // One request's patience, and the ceiling on a whole reading across every
    // column and retry. The printer drops roughly one request in eight, so
    // retries are expected; the budget is what stops them accumulating.
    PRINTER_TELEMETRY_TIMEOUT_MS: z.coerce.number().int().min(200).max(5_000).default(1_000),
    PRINTER_TELEMETRY_BUDGET_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
    PRINTER_TELEMETRY_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
    // How old the telemetry behind a healthy verdict may be at the last check
    // before money moves. Read only by the payment gate; session start accepts
    // any age, because refusing a customer at the welcome screen over a poll
    // that is merely due costs a print and prevents nothing.
    //
    // The default allows for one heartbeat plus one poll plus slack, because
    // between changes the stored reading ages by both. It is a backstop against
    // a wedged poller rather than the thing that closes the empty-tray race —
    // that is the agent's beat-on-change, which lands in about a second.
    PRINTER_TELEMETRY_MAX_AGE_SECONDS: z.coerce.number().int().min(10).max(600).default(90),
    // How often the agent reports that it is alive, and how often it re-reads
    // what the printer can do. A swapped printer is noticed within one beat.
    AGENT_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
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

    // A real device is chosen by name, so the settings that name it have to be
    // present. A kiosk that started without them would only discover it at the
    // first paid print.
    if (environment.PRINTER_ADAPTER === "windows" && !environment.PRINTER_WINDOWS_HOST_PATH) {
      context.addIssue({
        code: "custom",
        path: ["PRINTER_WINDOWS_HOST_PATH"],
        message: "PRINTER_WINDOWS_HOST_PATH is required when PRINTER_ADAPTER=windows"
      });
    }

    // The Windows device host is a process that has to start, compile its inline
    // type, load the PDF renderer, rasterise the paid pages and draw them
    // through the driver before it can watch the queue at all. The agent kills
    // it at this timeout, and a submission killed mid-print is ambiguous rather
    // than failed — a paid job nobody can settle. A budget this short cannot be
    // met, so it is refused at startup rather than at the first print.
    if (
      environment.PRINTER_ADAPTER === "windows" &&
      environment.PRINT_JOB_TIMEOUT_SECONDS < MIN_WINDOWS_PRINT_JOB_TIMEOUT_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        path: ["PRINT_JOB_TIMEOUT_SECONDS"],
        message:
          "PRINT_JOB_TIMEOUT_SECONDS must be at least " +
          `${MIN_WINDOWS_PRINT_JOB_TIMEOUT_SECONDS} when PRINTER_ADAPTER=windows`
      });
    }

    // Approval is what stands between a paid job and an arbitrary queue. A
    // deployment driving real hardware has to state which queue it certified.
    if (
      environment.PRINTER_ADAPTER !== "mock" &&
      parseAllowlist(environment.PRINTER_QUEUE_ALLOWLIST).length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["PRINTER_QUEUE_ALLOWLIST"],
        message: "PRINTER_QUEUE_ALLOWLIST must name at least one certified queue"
      });
    }

    // A profile nobody can read approves nothing, and a kiosk that silently
    // fell back to the reference printer would be printing on a model its
    // operator never certified.
    if (parsePrinterProfiles(environment.PRINTER_DEVICE_PROFILES) === null) {
      context.addIssue({
        code: "custom",
        path: ["PRINTER_DEVICE_PROFILES"],
        message:
          "PRINTER_DEVICE_PROFILES must be a JSON array of " +
          "{ driverName, portPattern } with a valid regular expression"
      });
    }

    // Telemetry that is half-configured is worse than none: it would be enabled,
    // fail every reading, and — with PRINTER_TELEMETRY_REQUIRED on — stop the
    // kiosk selling, for a reason nobody would connect to a missing key. So the
    // whole set is demanded up front, at startup, where it is one clear error.
    if (environment.PRINTER_TELEMETRY_ENABLED) {
      const required = [
        ["PRINTER_TELEMETRY_HOST", environment.PRINTER_TELEMETRY_HOST],
        ["PRINTER_TELEMETRY_SERIAL", environment.PRINTER_TELEMETRY_SERIAL],
        ["PRINTER_TELEMETRY_SNMP_USER", environment.PRINTER_TELEMETRY_SNMP_USER],
        ["PRINTER_TELEMETRY_SNMP_AUTH_KEY", environment.PRINTER_TELEMETRY_SNMP_AUTH_KEY],
        ["PRINTER_TELEMETRY_SNMP_PRIV_KEY", environment.PRINTER_TELEMETRY_SNMP_PRIV_KEY]
      ] as const;
      for (const [name, value] of required) {
        if (value.trim().length === 0) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: `${name} is required when PRINTER_TELEMETRY_ENABLED=true`
          });
        }
      }

      // A hostname would mean a DNS lookup on a cable that has no DNS, and an
      // address off the point-to-point segment would mean this kiosk is talking
      // to a printer somewhere on a real network — which is the arrangement the
      // whole design exists to avoid.
      if (!isPrivateIpv4(environment.PRINTER_TELEMETRY_HOST)) {
        context.addIssue({
          code: "custom",
          path: ["PRINTER_TELEMETRY_HOST"],
          message: "PRINTER_TELEMETRY_HOST must be a private IPv4 address, not a hostname"
        });
      }
      if (
        environment.PRINTER_TELEMETRY_SOURCE_ADDRESS.trim().length > 0 &&
        !isPrivateIpv4(environment.PRINTER_TELEMETRY_SOURCE_ADDRESS)
      ) {
        context.addIssue({
          code: "custom",
          path: ["PRINTER_TELEMETRY_SOURCE_ADDRESS"],
          message: "PRINTER_TELEMETRY_SOURCE_ADDRESS must be a private IPv4 address"
        });
      }
      if (
        environment.PRINTER_TELEMETRY_MAC.trim().length > 0 &&
        !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(environment.PRINTER_TELEMETRY_MAC.trim())
      ) {
        context.addIssue({
          code: "custom",
          path: ["PRINTER_TELEMETRY_MAC"],
          message: "PRINTER_TELEMETRY_MAC must be six colon-separated hex octets"
        });
      }

      // RFC 3414 sets eight characters as the floor for a USM passphrase, and
      // reusing one passphrase for both authentication and privacy means a
      // single disclosure costs both properties at once.
      for (const [name, value] of [
        ["PRINTER_TELEMETRY_SNMP_AUTH_KEY", environment.PRINTER_TELEMETRY_SNMP_AUTH_KEY],
        ["PRINTER_TELEMETRY_SNMP_PRIV_KEY", environment.PRINTER_TELEMETRY_SNMP_PRIV_KEY]
      ] as const) {
        if (value.length > 0 && value.length < 8) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: `${name} must be at least 8 characters`
          });
        }
      }
      if (
        environment.PRINTER_TELEMETRY_SNMP_AUTH_KEY.length > 0 &&
        environment.PRINTER_TELEMETRY_SNMP_AUTH_KEY === environment.PRINTER_TELEMETRY_SNMP_PRIV_KEY
      ) {
        context.addIssue({
          code: "custom",
          path: ["PRINTER_TELEMETRY_SNMP_PRIV_KEY"],
          message:
            "PRINTER_TELEMETRY_SNMP_PRIV_KEY must differ from PRINTER_TELEMETRY_SNMP_AUTH_KEY"
        });
      }

      // A reading that cannot fit one request cannot fit any, so it would fail
      // every time and never say why.
      if (environment.PRINTER_TELEMETRY_BUDGET_MS <= environment.PRINTER_TELEMETRY_TIMEOUT_MS) {
        context.addIssue({
          code: "custom",
          path: ["PRINTER_TELEMETRY_BUDGET_MS"],
          message: "PRINTER_TELEMETRY_BUDGET_MS must exceed PRINTER_TELEMETRY_TIMEOUT_MS"
        });
      }

      // Between changes the stored reading ages by a poll and then by a beat,
      // because the agent only learns on one and only says so on the other. A
      // ceiling below that sum refuses payments on a healthy kiosk on a fixed
      // schedule — the worst kind of fault to diagnose, because the printer is
      // fine every time somebody goes to look at it.
      const propagationSeconds =
        environment.PRINTER_TELEMETRY_POLL_SECONDS + environment.AGENT_HEARTBEAT_SECONDS;
      if (environment.PRINTER_TELEMETRY_MAX_AGE_SECONDS <= propagationSeconds) {
        context.addIssue({
          code: "custom",
          path: ["PRINTER_TELEMETRY_MAX_AGE_SECONDS"],
          message:
            "PRINTER_TELEMETRY_MAX_AGE_SECONDS must exceed " +
            "PRINTER_TELEMETRY_POLL_SECONDS + AGENT_HEARTBEAT_SECONDS, or healthy " +
            "kiosks will refuse payments whenever a reading is merely due"
        });
      }
    }

    // An installed service is a deployment, so the switches that let a build
    // pretend are refused here as well as in production. Until now they were
    // gated on `NODE_ENV` alone, which a service install does not have to set —
    // and the failure mode is silent: a kiosk that reports healthy, takes
    // payment, and writes the customer's document to a folder.
    if (environment.PRINTING_KIOSK_SERVICE) {
      if (environment.PRINTER_ADAPTER === "mock") {
        context.addIssue({
          code: "custom",
          path: ["PRINTER_ADAPTER"],
          message: "PRINTER_ADAPTER must drive a real device when installed as a service"
        });
      }
      if (environment.PAYMENT_TEST_OUTCOMES_ENABLED) {
        context.addIssue({
          code: "custom",
          path: ["PAYMENT_TEST_OUTCOMES_ENABLED"],
          message: "PAYMENT_TEST_OUTCOMES_ENABLED must be false when installed as a service"
        });
      }
      if (environment.PRINT_TEST_OUTCOMES_ENABLED) {
        context.addIssue({
          code: "custom",
          path: ["PRINT_TEST_OUTCOMES_ENABLED"],
          message: "PRINT_TEST_OUTCOMES_ENABLED must be false when installed as a service"
        });
      }
    }

    // Naming a preference that is not itself approved would either be ignored
    // or would print somewhere nobody certified. Both are worse than refusing.
    const allowlist = parseAllowlist(environment.PRINTER_QUEUE_ALLOWLIST).map((entry) =>
      entry.toLocaleLowerCase("en-US")
    );
    if (
      environment.PRINTER_QUEUE_NAME &&
      !allowlist.includes(environment.PRINTER_QUEUE_NAME.trim().toLocaleLowerCase("en-US"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["PRINTER_QUEUE_NAME"],
        message: "PRINTER_QUEUE_NAME must be one of PRINTER_QUEUE_ALLOWLIST"
      });
    }

    // A heartbeat that could outlive a lease would let a kiosk look alive while
    // the control plane was already settling its job without it.
    if (environment.AGENT_HEARTBEAT_SECONDS >= environment.PRINT_COMMAND_LEASE_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["AGENT_HEARTBEAT_SECONDS"],
        message: "AGENT_HEARTBEAT_SECONDS must be shorter than PRINT_COMMAND_LEASE_SECONDS"
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

    // A session that could outlive its absolute window would be ended by a
    // sweep rather than by policy — per role, because the windows are.
    const adminSessionWindows = [
      ["OPERATOR", "ADMIN_SESSION_IDLE_MINUTES_OPERATOR", "ADMIN_SESSION_ABSOLUTE_HOURS_OPERATOR"],
      ["ADMIN", "ADMIN_SESSION_IDLE_MINUTES_ADMIN", "ADMIN_SESSION_ABSOLUTE_HOURS_ADMIN"],
      [
        "TECHNICAL_ADMIN",
        "ADMIN_SESSION_IDLE_MINUTES_TECHNICAL_ADMIN",
        "ADMIN_SESSION_ABSOLUTE_HOURS_TECHNICAL_ADMIN"
      ]
    ] as const;
    for (const [, idleKey, absoluteKey] of adminSessionWindows) {
      if (environment[idleKey] > environment[absoluteKey] * 60) {
        context.addIssue({
          code: "custom",
          path: [idleKey],
          message: `${idleKey} must not exceed ${absoluteKey}`
        });
      }
      // Step-up exists so a sensitive action needs a fresh touch. If it
      // outlived the session's own idle window it would never be the binding
      // constraint.
      if (environment.ADMIN_STEP_UP_TTL_SECONDS > environment[idleKey] * 60) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_STEP_UP_TTL_SECONDS"],
          message: `ADMIN_STEP_UP_TTL_SECONDS must not exceed the ${idleKey} window`
        });
      }
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

    if (
      environment.ADMIN_REFUND_DATABASE_URL !== undefined &&
      !isPostgresConnectionUrl(environment.ADMIN_REFUND_DATABASE_URL)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_REFUND_DATABASE_URL"],
        message: "ADMIN_REFUND_DATABASE_URL must be a postgresql:// or postgres:// URL"
      });
    }

    if (
      environment.ADMIN_PEOPLE_DATABASE_URL !== undefined &&
      !isPostgresConnectionUrl(environment.ADMIN_PEOPLE_DATABASE_URL)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_PEOPLE_DATABASE_URL"],
        message: "ADMIN_PEOPLE_DATABASE_URL must be a postgresql:// or postgres:// URL"
      });
    }

    if (
      environment.ADMIN_PRICING_DATABASE_URL !== undefined &&
      !isPostgresConnectionUrl(environment.ADMIN_PRICING_DATABASE_URL)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_PRICING_DATABASE_URL"],
        message: "ADMIN_PRICING_DATABASE_URL must be a postgresql:// or postgres:// URL"
      });
    }

    // The refund role is the only grant in this system that can pay somebody.
    // Pointing it at any other connection string would hand that grant to
    // whatever else uses that string, which is the entire thing this separation
    // exists to prevent — so it is checked outside production too.
    for (const [name, value] of [
      ["DATABASE_URL", environment.DATABASE_URL],
      ["ADMIN_READ_DATABASE_URL", environment.ADMIN_READ_DATABASE_URL],
      ["ADMIN_WRITE_DATABASE_URL", environment.ADMIN_WRITE_DATABASE_URL],
      ["ADMIN_PEOPLE_DATABASE_URL", environment.ADMIN_PEOPLE_DATABASE_URL]
    ] as const) {
      if (
        environment.ADMIN_REFUND_DATABASE_URL !== undefined &&
        environment.ADMIN_REFUND_DATABASE_URL === value
      ) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_REFUND_DATABASE_URL"],
          message:
            `ADMIN_REFUND_DATABASE_URL must not equal ${name}. It is the only connection ` +
            "that can create a refund; sharing it gives that power to everything else. " +
            "Provision the role with `pnpm db:admin-refund-writer provision`."
        });
      }
    }

    // The people role is the only grant in this system that can change a row an
    // account's access depends on. Sharing its connection string would give
    // "suspend this person" and "retire that key" to everything else that uses
    // it, so — like the refund role — this is checked outside production too.
    for (const [name, value] of [
      ["DATABASE_URL", environment.DATABASE_URL],
      ["ADMIN_READ_DATABASE_URL", environment.ADMIN_READ_DATABASE_URL],
      ["ADMIN_WRITE_DATABASE_URL", environment.ADMIN_WRITE_DATABASE_URL]
    ] as const) {
      if (
        environment.ADMIN_PEOPLE_DATABASE_URL !== undefined &&
        environment.ADMIN_PEOPLE_DATABASE_URL === value
      ) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_PEOPLE_DATABASE_URL"],
          message:
            `ADMIN_PEOPLE_DATABASE_URL must not equal ${name}. It is the only connection ` +
            "that can suspend an account or retire somebody's key; sharing it gives that " +
            "power to everything else. " +
            "Provision the role with `pnpm db:admin-people-writer provision`."
        });
      }
    }

    // The pricing role is the only grant that can change what a customer will be
    // charged. Sharing a string with any other pool would hand that reach to
    // every request that pool serves. Checked outside production for the same
    // reason the money check is.
    for (const [name, value] of [
      ["DATABASE_URL", environment.DATABASE_URL],
      ["ADMIN_READ_DATABASE_URL", environment.ADMIN_READ_DATABASE_URL],
      ["ADMIN_WRITE_DATABASE_URL", environment.ADMIN_WRITE_DATABASE_URL],
      ["ADMIN_REFUND_DATABASE_URL", environment.ADMIN_REFUND_DATABASE_URL],
      ["ADMIN_PEOPLE_DATABASE_URL", environment.ADMIN_PEOPLE_DATABASE_URL]
    ] as const) {
      if (
        environment.ADMIN_PRICING_DATABASE_URL !== undefined &&
        environment.ADMIN_PRICING_DATABASE_URL === value
      ) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_PRICING_DATABASE_URL"],
          message:
            `ADMIN_PRICING_DATABASE_URL must not equal ${name}. It is the only connection ` +
            "that can publish a tariff, and nothing else should be able to. " +
            "Provision the role with `pnpm db:admin-pricing-writer provision`."
        });
      }
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

    // Four connections, four different sets of grants. Without this one the
    // panel simply cannot authorize refunds — which is a safe failure, but a
    // silent one, and a production deployment that meant to offer the feature
    // should find out at boot rather than when an Admin tries to use it.
    if (environment.ADMIN_REFUND_DATABASE_URL === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_REFUND_DATABASE_URL"],
        message:
          "ADMIN_REFUND_DATABASE_URL must be set in production. Provision the role with " +
          "`pnpm db:admin-refund-writer provision`, or disable it deliberately with " +
          "`pnpm db:admin-refund-writer disable`."
      });
    }

    // Five connections, five different sets of grants. Same argument as the
    // refund role's: without this the panel cannot manage people at all, which
    // is safe but silent, and a deployment that meant to offer it should find
    // out at boot rather than when an Admin tries to suspend somebody.
    if (environment.ADMIN_PEOPLE_DATABASE_URL === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_PEOPLE_DATABASE_URL"],
        message:
          "ADMIN_PEOPLE_DATABASE_URL must be set in production. Provision the role with " +
          "`pnpm db:admin-people-writer provision`, or disable it deliberately with " +
          "`pnpm db:admin-people-writer disable`."
      });
    }

    // Six. Same argument as the refund and people roles': without it the panel
    // cannot publish a tariff at all, which is safe but silent, and a deployment
    // that meant to offer it should find out at boot rather than when an Admin
    // tries to change a price.
    if (environment.ADMIN_PRICING_DATABASE_URL === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_PRICING_DATABASE_URL"],
        message:
          "ADMIN_PRICING_DATABASE_URL must be set in production. Provision the role with " +
          "`pnpm db:admin-pricing-writer provision`, or disable it deliberately with " +
          "`pnpm db:admin-pricing-writer disable`."
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

    // The simulated printer writes a customer's document to a folder and
    // reports a successful print. In production that is a machine that takes
    // money and delivers nothing, so the selection is refused outright.
    if (environment.PRINTER_ADAPTER === "mock") {
      context.addIssue({
        code: "custom",
        path: ["PRINTER_ADAPTER"],
        message: "PRINTER_ADAPTER must drive a real device in production"
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
      "ADMIN_WRITE_DATABASE_URL",
      "ADMIN_REFUND_DATABASE_URL",
      "ADMIN_PEOPLE_DATABASE_URL",
      "ADMIN_PRICING_DATABASE_URL"
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

function parseAllowlist(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** A printer/driver combination an operator certified for this fleet. */
export interface PrinterDeviceProfile {
  driverName: string;
  /** Anchored regular expression the Windows port name must match. */
  portPattern: string;
}

/**
 * The printer this fleet was built around.
 *
 * Kept as the default rather than as the only option: an empty configuration
 * must behave exactly as the deployment does today, and adding a second
 * approved model must not require touching the device host.
 */
export const REFERENCE_PRINTER_PROFILES: readonly PrinterDeviceProfile[] = [
  { driverName: "Canon Generic Plus UFR II", portPattern: "^USB\\d+$" }
];

const printerDeviceProfileSchema = z
  .object({
    driverName: z.string().min(1).max(220),
    // Bounded and compiled at startup. It is operator configuration rather than
    // customer input, but it is evaluated once per queue check on a machine
    // nobody is watching, so a pattern that cannot terminate is worth refusing
    // at the point somebody can still read the error.
    portPattern: z.string().min(1).max(200)
  })
  .strict();

/**
 * Read the certified printer profiles, falling back to the reference printer.
 *
 * Returns `null` when the configuration is unusable so the caller can refuse at
 * startup. Silently returning the default there would approve the Canon on a
 * kiosk whose operator meant to approve something else.
 */
export function parsePrinterProfiles(value: string): PrinterDeviceProfile[] | null {
  const text = value.trim();
  if (text.length === 0) return [...REFERENCE_PRINTER_PROFILES];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const profiles = z.array(printerDeviceProfileSchema).min(1).max(16).safeParse(parsed);
  if (!profiles.success) return null;

  for (const profile of profiles.data) {
    try {
      new RegExp(profile.portPattern, "u");
    } catch {
      return null;
    }
  }
  return profiles.data;
}

/**
 * An IPv4 literal in a range that cannot be routed off the premises.
 *
 * The printer link is a cable between two machines with no gateway, so the only
 * legitimate addresses on it are private ones. Refusing anything else is what
 * turns a typo — a public address, or a hostname that resolves to one — into a
 * startup error rather than a kiosk quietly sending authenticated SNMP requests
 * to a stranger. Link-local is allowed because a direct cable without DHCP
 * legitimately lands there.
 */
function isPrivateIpv4(value: string): boolean {
  const octets = value.trim().split(".");
  if (octets.length !== 4) return false;
  const parsed: number[] = [];
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const number = Number.parseInt(octet, 10);
    if (number > 255) return false;
    parsed.push(number);
  }
  const [first, second] = parsed as [number, number, number, number];
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  return false;
}

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
  "ADMIN_SESSION_IDLE_MINUTES_OPERATOR",
  "ADMIN_SESSION_IDLE_MINUTES_ADMIN",
  "ADMIN_SESSION_IDLE_MINUTES_TECHNICAL_ADMIN",
  "ADMIN_SESSION_ABSOLUTE_HOURS_OPERATOR",
  "ADMIN_SESSION_ABSOLUTE_HOURS_ADMIN",
  "ADMIN_SESSION_ABSOLUTE_HOURS_TECHNICAL_ADMIN",
  "ADMIN_INVITATION_TTL_HOURS",
  "ADMIN_PASSWORD_RESET_TTL_MINUTES",
  "ADMIN_STEP_UP_TTL_SECONDS",
  "ADMIN_CHALLENGE_TTL_SECONDS",
  "ADMIN_BREAK_GLASS_TTL_HOURS",
  // Five more database passwords. A worker or kiosk process has no admin panel
  // to serve and therefore no reason to hold any of them — the write one is the
  // only credential in this system that can append to the audit log, the refund
  // one is the only credential that can create an obligation to pay a customer
  // back, the people one is the only credential that can change whether somebody
  // may sign in at all, and the pricing one is the only credential that can
  // change what a customer will be charged.
  "ADMIN_READ_DATABASE_URL",
  "ADMIN_WRITE_DATABASE_URL",
  "ADMIN_REFUND_DATABASE_URL",
  "ADMIN_PEOPLE_DATABASE_URL",
  "ADMIN_PRICING_DATABASE_URL"
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
    ADMIN_SESSION_IDLE_MINUTES_OPERATOR: "360",
    ADMIN_SESSION_IDLE_MINUTES_ADMIN: "120",
    ADMIN_SESSION_IDLE_MINUTES_TECHNICAL_ADMIN: "60",
    ADMIN_SESSION_ABSOLUTE_HOURS_OPERATOR: "720",
    ADMIN_SESSION_ABSOLUTE_HOURS_ADMIN: "336",
    ADMIN_SESSION_ABSOLUTE_HOURS_TECHNICAL_ADMIN: "168",
    ADMIN_INVITATION_TTL_HOURS: "72",
    ADMIN_PASSWORD_RESET_TTL_MINUTES: "60",
    ADMIN_STEP_UP_TTL_SECONDS: "300",
    ADMIN_CHALLENGE_TTL_SECONDS: "180",
    ADMIN_BREAK_GLASS_TTL_HOURS: "2160",
    // Loopback so the production transport rule does not demand TLS settings
    // for connections this process will never open, and distinct from each
    // other because production requires the seven roles to differ.
    ADMIN_READ_DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/not-loaded-outside-api",
    ADMIN_WRITE_DATABASE_URL:
      "postgresql://unused:unused@127.0.0.1:5432/not-loaded-outside-api-write",
    ADMIN_REFUND_DATABASE_URL:
      "postgresql://unused:unused@127.0.0.1:5432/not-loaded-outside-api-refund",
    ADMIN_PEOPLE_DATABASE_URL:
      "postgresql://unused:unused@127.0.0.1:5432/not-loaded-outside-api-people",
    ADMIN_PRICING_DATABASE_URL:
      "postgresql://unused:unused@127.0.0.1:5432/not-loaded-outside-api-pricing"
  });
  return Object.fromEntries(
    Object.entries(parsed).filter(([name]) => !ADMIN_ENVIRONMENT_KEY_SET.has(name))
  ) as NonAdminEnvironment;
}

/**
 * The variable a deployment uses to say where its configuration lives, instead
 * of leaving it to be discovered. Read before the schema, because it decides
 * what the schema will see.
 */
export const ENV_FILE_VARIABLE = "PRINTING_KIOSK_ENV_FILE";

/**
 * Load the configuration file.
 *
 * Two very different situations, and only one of them may be quiet about a
 * missing file.
 *
 * A developer runs workspace commands with the package as cwd, so the root
 * `.env` is found by walking upwards. Nothing is wrong if it is absent — the
 * defaults are development defaults and that is what development wants.
 *
 * A deployed service has no such luxury. Windows starts a service in
 * `C:\Windows\System32`, so the walk above climbs to the drive root, finds no
 * workspace marker, and returns having loaded nothing at all. The agent then
 * starts on schema defaults — including `PRINTER_ADAPTER=mock` — and a kiosk
 * that takes money and writes documents to a folder looks, from the outside,
 * exactly like a kiosk that works.
 *
 * So a deployment names its file explicitly and a missing one is fatal. The
 * discovery walk stays for development, where silence is correct.
 */
export function loadWorkspaceEnvironmentFile(startDirectory = process.cwd()): void {
  const configured = process.env[ENV_FILE_VARIABLE]?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      // Deliberately before any parsing: there is no safe way to continue.
      // Whatever this process would do next, it would do it with the wrong
      // configuration, and on a kiosk that means the wrong printer.
      throw new Error(
        `${ENV_FILE_VARIABLE} names a file that does not exist. ` +
          "A deployment must not fall back to development defaults."
      );
    }
    loadDotenv({ path: configured, override: false, quiet: true });
    return;
  }

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
