import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { config as loadDotenv } from "dotenv";
import pg from "pg";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
const migrationsDirectory = join(packageDirectory, "prisma", "migrations");
const phase8FirstMigration = "20260803030000_phase8_print_jobs";
const fixture = {
  kioskId: "kiosk_phase8_upgrade_fixture",
  otherKioskId: "kiosk_phase8_upgrade_other",
  sessionId: "01900000-0000-7000-8000-000000000a01",
  otherSessionId: "01900000-0000-7000-8000-000000000a11",
  clientId: "01900000-0000-7000-8000-000000000a02",
  fileId: "01900000-0000-7000-8000-000000000a03",
  clientFileId: "01900000-0000-7000-8000-000000000a04",
  revisionId: "01900000-0000-7000-8000-000000000a05",
  ruleSetId: "01900000-0000-7000-8000-000000000a06",
  quoteId: "01900000-0000-7000-8000-000000000a08",
  paymentId: "01900000-0000-7000-8000-000000000a09",
  printJobId: "01900000-0000-7000-8000-000000000a0a",
  commandId: "01900000-0000-7000-8000-000000000a0b",
  operationId: "01900000-0000-7000-8000-000000000a0c",
  ledgerId: "01900000-0000-7000-8000-000000000a0d",
  manifestHash: "d".repeat(64),
  jobManifestHash: "e".repeat(64)
};

loadDotenv({
  path: join(workspaceDirectory, ".env"),
  override: false,
  quiet: true
});

const sourceUrl = new URL(
  process.env.DATABASE_URL ??
    "postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk"
);
assertSafeSourceDatabase(sourceUrl);

const suffix = `${process.pid}_${randomBytes(5).toString("hex")}`;
const temporaryDatabase = `printing_kiosk_phase8_upgrade_${suffix}`;
const adminUrl = withDatabase(sourceUrl, "postgres");
const temporaryUrl = withDatabase(sourceUrl, temporaryDatabase);
const admin = new pg.Client({ connectionString: adminUrl.href });

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${temporaryDatabase}"`);
  await applyPhase7Migrations(temporaryUrl);
  await insertPhase7Fixture(temporaryUrl);
  runPrisma(["migrate", "deploy"], temporaryUrl);
  await verifyPaidSessionSurvives(temporaryUrl);
  await verifyPrintJobInvariants(temporaryUrl);
  process.stdout.write(
    "Phase 7 -> Phase 8 migration upgrade verified: an existing paid session is untouched, " +
      "a print job requires a capture applied to its own session and the settings that capture " +
      "paid for, a session prints once, the job snapshot cannot be rewritten, a settled job is " +
      "final, one command exists per job, and the operation ledger is write-once evidence.\n"
  );
} finally {
  await closeQuietly(admin);
  const cleanup = new pg.Client({ connectionString: adminUrl.href });
  try {
    await cleanup.connect();
    await cleanup.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
        "WHERE datname = $1 AND pid <> pg_backend_pid()",
      [temporaryDatabase]
    );
    await cleanup.query(`DROP DATABASE IF EXISTS "${temporaryDatabase}"`);
  } finally {
    await closeQuietly(cleanup);
  }
}

async function applyPhase7Migrations(targetUrl) {
  const migrations = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{14}_[a-z0-9_]+$/u.test(entry.name) &&
        entry.name < phase8FirstMigration
    )
    .map((entry) => entry.name)
    .sort();
  if (migrations.length === 0) throw new Error("PHASE7_MIGRATIONS_NOT_FOUND");

  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    for (const migration of migrations) {
      const sql = await readFile(join(migrationsDirectory, migration, "migration.sql"), "utf8");
      await client.query(sql);
      runPrisma(["migrate", "resolve", "--applied", migration], targetUrl);
    }
  } finally {
    await closeQuietly(client);
  }
}

/** A session that has already been paid: a capture applied to a live quote. */
async function insertPhase7Fixture(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    const capabilities = JSON.stringify({
      service: "PRINT_ONLY",
      outputMode: "MONOCHROME",
      paperSizes: ["A4"],
      duplex: true
    });
    for (const [kioskId, publicCode] of [
      [fixture.kioskId, "PHASE8-UPGRADE"],
      [fixture.otherKioskId, "PHASE8-UPGRADE-OTHER"]
    ]) {
      await client.query(
        `INSERT INTO "kiosks" ("id", "public_code", "name", "capabilities")
         VALUES ($1, $2, $3, $4::jsonb)`,
        [kioskId, publicCode, "Phase 8 migration fixture", capabilities]
      );
    }
    for (const [sessionId, publicId, kioskId, state] of [
      [fixture.sessionId, "ps_phase8_upgrade_fixture", fixture.kioskId, "PAID"],
      [fixture.otherSessionId, "ps_phase8_upgrade_other", fixture.otherKioskId, "CONFIGURING"]
    ]) {
      await client.query(
        `INSERT INTO "print_sessions"
          ("id", "public_id", "kiosk_id", "locale", "state", "idle_expires_at", "hard_expires_at")
         VALUES ($1::uuid, $2, $3, 'hy', $4,
           CURRENT_TIMESTAMP + INTERVAL '10 minutes',
           CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
        [sessionId, publicId, kioskId, state]
      );
    }
    await client.query(
      `INSERT INTO "mobile_clients"
        ("id", "session_id", "cookie_digest", "client_nonce_digest", "status", "expires_at")
       VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE',
         CURRENT_TIMESTAMP + INTERVAL '10 minutes')`,
      [fixture.clientId, fixture.sessionId, "a".repeat(64), "b".repeat(64)]
    );
    await client.query(
      `INSERT INTO "uploaded_files"
        ("id", "session_id", "uploaded_by_client_id", "client_file_id", "ordinal",
         "display_name", "status", "kind", "declared_mime", "detected_mime", "extension",
         "reserved_bytes", "size_bytes", "content_sha256", "quarantine_object_key",
         "quarantined_at", "ready_at", "page_count", "malware_scan_status",
         "processing_generation", "processing_attempts", "processing_started_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0,
         'Document 1', 'READY', 'PDF', 'application/pdf', 'application/pdf', 'pdf',
         128, 128, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 3, 'CLEAN',
         1, 1, CURRENT_TIMESTAMP)`,
      [
        fixture.fileId,
        fixture.sessionId,
        fixture.clientId,
        fixture.clientFileId,
        "c".repeat(64),
        `quarantine/v1/${fixture.sessionId}/${fixture.fileId}/phase8UpgradeToken`
      ]
    );
    await client.query(
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "scaling", "collate", "color_mode", "selections",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       VALUES ($1::uuid, $2::uuid, 1, 1, 'SIMPLEX', 'A4', 'AUTO', 'FIT', true, 'MONOCHROME',
         $3::jsonb, 3, 3, 3, 1, $4, 'KIOSK', 'phase8-upgrade')`,
      [
        fixture.revisionId,
        fixture.sessionId,
        JSON.stringify([
          {
            fileId: fixture.fileId,
            position: 0,
            pageCount: 3,
            processingRevision: 1,
            contentSha256: "c".repeat(64),
            pageRanges: [[1, 3]],
            pageRangeText: "1-3",
            selectedPages: 3
          }
        ]),
        fixture.manifestHash
      ]
    );
    await client.query(
      `INSERT INTO "pricing_rule_sets"
        ("id", "version", "scope", "currency", "currency_exponent", "status", "rounding",
         "tax_mode", "minimum_application", "valid_from", "published_at")
       VALUES ($1::uuid, 'price-phase8-check', 'GLOBAL', 'AMD', 2, 'PUBLISHED', 'HALF_UP',
         'EXCLUSIVE', 'BEFORE_TAX', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [fixture.ruleSetId]
    );
    await client.query(
      `INSERT INTO "price_quotes"
        ("id", "session_id", "settings_revision", "manifest_hash", "rule_set_id",
         "pricing_version", "status", "currency", "currency_exponent", "selected_pages",
         "printed_sides", "physical_sheets", "print_amount_minor", "duplex_adjustment_minor",
         "service_fee_minor", "minimum_adjustment_minor", "subtotal_minor", "tax_minor",
         "total_minor", "expires_at")
       VALUES ($1::uuid, $2::uuid, 1, $3, $4::uuid, 'price-phase8-check', 'CONSUMED',
         'AMD', 2, 3, 3, 3, 15000, 0, 0, 0, 15000, 3000, 18000,
         CURRENT_TIMESTAMP + INTERVAL '5 minutes')`,
      [fixture.quoteId, fixture.sessionId, fixture.manifestHash, fixture.ruleSetId]
    );
    await client.query(
      `INSERT INTO "payments"
        ("id", "session_id", "quote_id", "provider", "provider_intent_id", "status",
         "applied_to_session", "amount_minor", "currency", "currency_exponent",
         "settings_revision", "manifest_hash", "created_by_actor_type", "created_by_actor_id",
         "expires_at", "captured_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MOCK', $4, 'CAPTURED', true,
         18000, 'AMD', 2, 1, $5, 'KIOSK', 'phase8-upgrade',
         CURRENT_TIMESTAMP + INTERVAL '3 minutes', CURRENT_TIMESTAMP)`,
      [
        fixture.paymentId,
        fixture.sessionId,
        fixture.quoteId,
        `mock_pi_${fixture.paymentId}`,
        fixture.manifestHash
      ]
    );
    await client.query(
      `UPDATE "print_sessions" SET "current_settings_revision" = 1 WHERE "id" = $1::uuid`,
      [fixture.sessionId]
    );
  } finally {
    await closeQuietly(client);
  }
}

async function verifyPaidSessionSurvives(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    const session = await client.query(
      `SELECT "state", "current_settings_revision" FROM "print_sessions" WHERE "id" = $1::uuid`,
      [fixture.sessionId]
    );
    if (
      session.rowCount !== 1 ||
      session.rows[0]?.state !== "PAID" ||
      session.rows[0]?.current_settings_revision !== 1
    ) {
      throw new Error("PHASE8_UPGRADE_SESSION_CHANGED");
    }

    const payment = await client.query(
      `SELECT "status", "applied_to_session", "amount_minor"
       FROM "payments" WHERE "id" = $1::uuid`,
      [fixture.paymentId]
    );
    if (
      payment.rowCount !== 1 ||
      payment.rows[0]?.status !== "CAPTURED" ||
      payment.rows[0]?.applied_to_session !== true ||
      payment.rows[0]?.amount_minor !== 18000
    ) {
      throw new Error("PHASE8_UPGRADE_PAYMENT_CHANGED");
    }

    const tables = await client.query(
      `SELECT "table_name" FROM "information_schema"."tables"
       WHERE "table_schema" = 'public'
         AND "table_name" IN ('print_jobs', 'print_job_events', 'agent_commands')
       ORDER BY "table_name"`
    );
    if (tables.rowCount !== 3) throw new Error("PHASE8_UPGRADE_TABLES_MISSING");

    const jobs = await client.query(`SELECT COUNT(*)::int AS "count" FROM "print_jobs"`);
    if (jobs.rows[0]?.count !== 0) throw new Error("PHASE8_UPGRADE_INVENTED_PRINT_JOBS");
  } finally {
    await closeQuietly(client);
  }
}

/**
 * The guarantees that hold in the database itself, whatever application code
 * believes: only a paid capture prints, it prints exactly what was paid for, a
 * session prints once, the snapshot is immutable, a settled job is final, and
 * what the device said is write-once evidence.
 */
async function verifyPrintJobInvariants(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    // A payment that did not capture, or a capture that was not applied to
    // this session, cannot print.
    const openPaymentId = randomUUID();
    await client.query(
      `INSERT INTO "payments"
        ("id", "session_id", "quote_id", "provider", "provider_intent_id", "status",
         "amount_minor", "currency", "currency_exponent", "settings_revision", "manifest_hash",
         "created_by_actor_type", "created_by_actor_id", "expires_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MOCK', $4, 'PENDING',
         18000, 'AMD', 2, 1, $5, 'KIOSK', 'phase8-upgrade',
         CURRENT_TIMESTAMP + INTERVAL '3 minutes')`,
      [
        openPaymentId,
        fixture.sessionId,
        fixture.quoteId,
        `mock_pi_${openPaymentId}`,
        fixture.manifestHash
      ]
    );
    await expectRejected(
      client,
      insertPrintJobSql(),
      printJobParameters({ id: randomUUID(), paymentId: openPaymentId }),
      "PHASE8_UNPAID_PRINT_JOB_ACCEPTED"
    );

    // Nor may a job print settings or a price the capture did not pay for.
    await expectRejected(
      client,
      insertPrintJobSql(),
      printJobParameters({ id: randomUUID(), settingsManifestHash: "0".repeat(64) }),
      "PHASE8_STALE_MANIFEST_PRINT_JOB_ACCEPTED"
    );
    await expectRejected(
      client,
      insertPrintJobSql(),
      printJobParameters({ id: randomUUID(), kioskId: fixture.otherKioskId }),
      "PHASE8_FOREIGN_KIOSK_PRINT_JOB_ACCEPTED"
    );

    await client.query(insertPrintJobSql(), printJobParameters({ id: fixture.printJobId }));

    // A session prints once. A second job is refused by the database, not only
    // by application code.
    await expectRejected(
      client,
      insertPrintJobSql(),
      printJobParameters({ id: randomUUID() }),
      "PHASE8_SECOND_PRINT_JOB_ACCEPTED"
    );

    // The snapshot is decided at creation and never edited afterwards.
    for (const [column, value, failureCode] of [
      ["copies", 9, "PHASE8_PRINT_JOB_COPIES_MUTABLE"],
      ["physical_sheets", 9, "PHASE8_PRINT_JOB_SHEETS_MUTABLE"],
      ["job_manifest_hash", "1".repeat(64), "PHASE8_PRINT_JOB_MANIFEST_MUTABLE"],
      ["settings_revision", 2, "PHASE8_PRINT_JOB_SETTINGS_MUTABLE"],
      ["simulated_outcome", "OFFLINE", "PHASE8_PRINT_JOB_SCENARIO_MUTABLE"],
      ["created_by_actor_id", "rewritten", "PHASE8_PRINT_JOB_CREATOR_MUTABLE"]
    ]) {
      await expectRejected(
        client,
        `UPDATE "print_jobs" SET "${column}" = $2 WHERE "id" = $1::uuid`,
        [fixture.printJobId, value],
        failureCode
      );
    }
    await expectRejected(
      client,
      `UPDATE "print_jobs" SET "job_manifest" = '{"tampered":true}'::jsonb WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE8_PRINT_JOB_SNAPSHOT_MUTABLE"
    );

    await expectRejected(
      client,
      `INSERT INTO "idempotency_records"
        ("id", "actor_id", "action", "key_digest", "request_hash", "response_status",
         "response_body", "expires_at")
       VALUES (gen_random_uuid(), 'phase8-upgrade', 'print-jobs.create:test', $1, $2, 201,
         '{"printJob":{"id":"leak","objectKey":"normalized/v1/private"}}'::jsonb,
         CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
      ["1".repeat(64), "2".repeat(64)],
      "PHASE8_UNSAFE_PRINT_REPLAY_STORED"
    );

    // A device cannot report more sheets than the job describes.
    await expectRejected(
      client,
      `UPDATE "print_jobs" SET "sheets_produced" = 99 WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE8_IMPOSSIBLE_SHEET_COUNT_ACCEPTED"
    );
    await expectRejected(
      client,
      `UPDATE "print_jobs"
       SET "status" = 'COMPLETED', "result_confidence" = 'CONFIRMED',
           "sheets_produced" = 0, "completed_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE8_ZERO_SHEET_COMPLETION_ACCEPTED"
    );

    // One command per job, ever: a redelivery re-leases this row rather than
    // opening a second operation the device could mistake for new work.
    await client.query(insertCommandSql(), commandParameters({ id: fixture.commandId }));
    await expectRejected(
      client,
      insertCommandSql(),
      commandParameters({ id: randomUUID(), operationId: randomUUID() }),
      "PHASE8_SECOND_COMMAND_PER_JOB_ACCEPTED"
    );
    await expectRejected(
      client,
      `UPDATE "agent_commands" SET "payload" = '{"tampered":true}'::jsonb WHERE "id" = $1::uuid`,
      [fixture.commandId],
      "PHASE8_ISSUED_COMMAND_MUTABLE"
    );
    await expectRejected(
      client,
      `UPDATE "agent_commands" SET "expires_at" = "expires_at" + INTERVAL '1 minute'
       WHERE "id" = $1::uuid`,
      [fixture.commandId],
      "PHASE8_COMMAND_DEADLINE_MUTABLE"
    );
    // A claimed command holds a lease and a token together, or neither.
    await expectRejected(
      client,
      `UPDATE "agent_commands" SET "status" = 'CLAIMED' WHERE "id" = $1::uuid`,
      [fixture.commandId],
      "PHASE8_CLAIM_WITHOUT_LEASE_ACCEPTED"
    );
    await expectRejected(
      client,
      `UPDATE "agent_commands"
       SET "status" = 'CLAIMED', "claim_token" = gen_random_uuid(),
           "lease_expires_at" = "expires_at" + INTERVAL '1 second'
       WHERE "id" = $1::uuid`,
      [fixture.commandId],
      "PHASE8_LEASE_OUTLIVED_DEADLINE"
    );

    // The operation ledger is evidence: appended, never rewritten.
    await client.query(
      `INSERT INTO "print_job_events"
        ("id", "print_job_id", "sequence", "type", "status", "operation_id")
       VALUES ($1::uuid, $2::uuid, 1, 'CREATED', 'QUEUED', $3::uuid)`,
      [fixture.ledgerId, fixture.printJobId, fixture.operationId]
    );
    await expectRejected(
      client,
      `UPDATE "print_job_events" SET "status" = 'COMPLETED' WHERE "id" = $1::uuid`,
      [fixture.ledgerId],
      "PHASE8_PRINT_LEDGER_MUTABLE"
    );
    await expectRejected(
      client,
      `INSERT INTO "print_job_events"
        ("id", "print_job_id", "sequence", "type", "status")
       VALUES (gen_random_uuid(), $1::uuid, 1, 'DISPATCHED', 'DISPATCHED')`,
      [fixture.printJobId],
      "PHASE8_DUPLICATE_LEDGER_SEQUENCE_ACCEPTED"
    );

    // A settled job is final in every direction. Nothing may rewrite a
    // recorded outcome, and nothing may walk a job backwards.
    await client.query(
      `UPDATE "print_jobs" SET "status" = 'RECOVERY_REQUIRED', "result_confidence" = 'UNCONFIRMED',
         "failure_code" = 'SUBMISSION_UNCONFIRMED', "failed_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId]
    );
    await expectRejected(
      client,
      `UPDATE "print_jobs" SET "status" = 'COMPLETED', "result_confidence" = 'CONFIRMED',
         "completed_at" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE8_SETTLED_JOB_REOPENED"
    );
    await expectRejected(
      client,
      `UPDATE "print_jobs" SET "status" = 'QUEUED' WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE8_JOB_MOVED_BACKWARDS"
    );

    // A failure without a reason, or a completion nobody can audit, cannot be
    // stored at all.
    const secondSessionJobId = randomUUID();
    await expectRejected(
      client,
      insertPrintJobSql({ status: "FAILED" }),
      printJobParameters({ id: secondSessionJobId }),
      "PHASE8_FAILURE_WITHOUT_REASON_ACCEPTED"
    );

    // Immutable is not undeletable: Phase 9 retention must be able to remove a
    // whole lineage through the foreign keys.
    await client.query(`DELETE FROM "print_jobs" WHERE "id" = $1::uuid`, [fixture.printJobId]);
    const orphaned = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM "print_job_events" WHERE "print_job_id" = $1::uuid) AS "events",
         (SELECT COUNT(*)::int FROM "agent_commands" WHERE "print_job_id" = $1::uuid) AS "commands"`,
      [fixture.printJobId]
    );
    if (orphaned.rows[0]?.events !== 0 || orphaned.rows[0]?.commands !== 0) {
      throw new Error("PHASE8_PRINT_LINEAGE_ORPHANED");
    }

    // The capture the job printed is still in the ledger afterwards: deleting
    // a print job never removes the accounting record of the money.
    const payment = await client.query(
      `SELECT COUNT(*)::int AS "count" FROM "payments" WHERE "id" = $1::uuid`,
      [fixture.paymentId]
    );
    if (payment.rows[0]?.count !== 1) throw new Error("PHASE8_PAYMENT_REMOVED_WITH_PRINT_JOB");
  } finally {
    await closeQuietly(client);
  }
}

function insertPrintJobSql(overrides = {}) {
  return `INSERT INTO "print_jobs"
    ("id", "session_id", "kiosk_id", "quote_id", "payment_id", "settings_revision",
     "settings_manifest_hash", "job_manifest", "job_manifest_hash", "status",
     "copies", "printed_sides", "physical_sheets", "deadline_at",
     "created_by_actor_type", "created_by_actor_id")
   VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, 1,
     $6, '{"manifestVersion":1}'::jsonb, $7, '${overrides.status ?? "QUEUED"}',
     1, 3, 3, CURRENT_TIMESTAMP + INTERVAL '5 minutes', 'KIOSK', 'phase8-upgrade')`;
}

function printJobParameters(overrides) {
  return [
    overrides.id,
    overrides.sessionId ?? fixture.sessionId,
    overrides.kioskId ?? fixture.kioskId,
    overrides.quoteId ?? fixture.quoteId,
    overrides.paymentId ?? fixture.paymentId,
    overrides.settingsManifestHash ?? fixture.manifestHash,
    overrides.jobManifestHash ?? fixture.jobManifestHash
  ];
}

function insertCommandSql() {
  return `INSERT INTO "agent_commands"
    ("id", "kiosk_id", "session_id", "print_job_id", "operation_id", "type", "status",
     "payload", "expires_at")
   VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'PRINT', 'PENDING',
     '{"manifestHash":"e"}'::jsonb, CURRENT_TIMESTAMP + INTERVAL '5 minutes')`;
}

function commandParameters(overrides) {
  return [
    overrides.id,
    fixture.kioskId,
    fixture.sessionId,
    fixture.printJobId,
    overrides.operationId ?? fixture.operationId
  ];
}

async function expectRejected(client, sql, parameters, failureCode) {
  try {
    await client.query(sql, parameters);
  } catch {
    // A failed statement aborts the surrounding implicit transaction block
    // only when one is open; each query here runs on its own.
    return;
  }
  throw new Error(failureCode);
}

function runPrisma(arguments_, targetUrl) {
  execFileSync("pnpm", ["exec", "prisma", ...arguments_], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      DATABASE_URL: targetUrl.href
    },
    stdio: "inherit"
  });
}

function assertSafeSourceDatabase(url) {
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    !allowedHosts.has(url.hostname) ||
    databaseName !== "printing_kiosk"
  ) {
    throw new Error("PHASE8_UPGRADE_TEST_REQUIRES_LOOPBACK_PRINTING_KIOSK_DATABASE");
  }
}

function withDatabase(source, databaseName) {
  const result = new URL(source);
  result.pathname = `/${databaseName}`;
  return result;
}

async function closeQuietly(client) {
  await client.end().catch(() => undefined);
}
