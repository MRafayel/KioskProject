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
const phase9FirstMigration = "20260804030000_phase9_retention";
const fixture = {
  kioskId: "kiosk_phase9_upgrade_fixture",
  liveSessionId: "01900000-0000-7000-8000-000000000b01",
  doneSessionId: "01900000-0000-7000-8000-000000000b11",
  clientId: "01900000-0000-7000-8000-000000000b02",
  fileId: "01900000-0000-7000-8000-000000000b03",
  clientFileId: "01900000-0000-7000-8000-000000000b04",
  revisionId: "01900000-0000-7000-8000-000000000b05",
  ruleSetId: "01900000-0000-7000-8000-000000000b06",
  quoteId: "01900000-0000-7000-8000-000000000b08",
  paymentId: "01900000-0000-7000-8000-000000000b09",
  printJobId: "01900000-0000-7000-8000-000000000b0a",
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
const temporaryDatabase = `printing_kiosk_phase9_upgrade_${suffix}`;
const adminUrl = withDatabase(sourceUrl, "postgres");
const temporaryUrl = withDatabase(sourceUrl, temporaryDatabase);
const admin = new pg.Client({ connectionString: adminUrl.href });

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${temporaryDatabase}"`);
  await applyPhase8Migrations(temporaryUrl);
  await insertPhase8Fixture(temporaryUrl);
  runPrisma(["migrate", "deploy"], temporaryUrl);
  await verifyExistingWorkSurvives(temporaryUrl);
  await verifyRetentionInvariants(temporaryUrl);
  await verifyManifestRedaction(temporaryUrl);
  process.stdout.write(
    "Phase 8 -> Phase 9 migration upgrade verified: existing sessions and captures are " +
      "untouched, a finished session is scheduled for cleanup, a run is leased and its " +
      "progress only moves forwards, a session cannot claim its documents are gone while it " +
      "still holds them, a cleaned session accepts no further document, a print manifest can " +
      "be redacted exactly once and only into the marker, and the payment ledger survives.\n"
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

/** Build the schema as it stood at the end of Phase 8. */
async function applyPhase8Migrations(targetUrl) {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrations = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{14}_[a-z0-9_]+$/u.test(entry.name) &&
        entry.name < phase9FirstMigration
    )
    .map((entry) => entry.name)
    .sort();
  if (migrations.length === 0) throw new Error("PHASE8_MIGRATIONS_NOT_FOUND");

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

/**
 * Two sessions written before retention existed: one still running with a
 * document in quarantine, one already finished with a capture and a settled
 * print job behind it.
 */
async function insertPhase8Fixture(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "kiosks" ("id", "public_code", "name", "capabilities")
       VALUES ($1, 'PHASE9-UPGRADE', 'Phase 9 migration fixture', $2::jsonb)`,
      [
        fixture.kioskId,
        JSON.stringify({
          service: "PRINT_ONLY",
          outputMode: "MONOCHROME",
          paperSizes: ["A4"],
          duplex: true
        })
      ]
    );
    for (const [sessionId, publicId, state] of [
      [fixture.liveSessionId, "ps_phase9_upgrade_live", "PAID"],
      [fixture.doneSessionId, "ps_phase9_upgrade_done", "CANCELED"]
    ]) {
      await client.query(
        `INSERT INTO "print_sessions"
          ("id", "public_id", "kiosk_id", "locale", "state", "idle_expires_at", "hard_expires_at")
         VALUES ($1::uuid, $2, $3, 'hy', $4,
           CURRENT_TIMESTAMP + INTERVAL '10 minutes',
           CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
        [sessionId, publicId, fixture.kioskId, state]
      );
    }
    await client.query(
      `INSERT INTO "mobile_clients"
        ("id", "session_id", "cookie_digest", "client_nonce_digest", "status", "expires_at")
       VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE',
         CURRENT_TIMESTAMP + INTERVAL '10 minutes')`,
      [fixture.clientId, fixture.liveSessionId, "a".repeat(64), "b".repeat(64)]
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
        fixture.liveSessionId,
        fixture.clientId,
        fixture.clientFileId,
        "c".repeat(64),
        `quarantine/v1/${fixture.liveSessionId}/${fixture.fileId}/phase9UpgradeToken`
      ]
    );
    await client.query(
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "scaling", "collate", "color_mode", "selections",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       VALUES ($1::uuid, $2::uuid, 1, 1, 'SIMPLEX', 'A4', 'AUTO', 'FIT', true, 'MONOCHROME',
         $3::jsonb, 3, 3, 3, 1, $4, 'KIOSK', 'phase9-upgrade')`,
      [
        fixture.revisionId,
        fixture.liveSessionId,
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
       VALUES ($1::uuid, 'price-phase9-check', 'GLOBAL', 'AMD', 2, 'PUBLISHED', 'HALF_UP',
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
       VALUES ($1::uuid, $2::uuid, 1, $3, $4::uuid, 'price-phase9-check', 'CONSUMED',
         'AMD', 2, 3, 3, 3, 15000, 0, 0, 0, 15000, 3000, 18000,
         CURRENT_TIMESTAMP + INTERVAL '5 minutes')`,
      [fixture.quoteId, fixture.liveSessionId, fixture.manifestHash, fixture.ruleSetId]
    );
    await client.query(
      `INSERT INTO "payments"
        ("id", "session_id", "quote_id", "provider", "provider_intent_id", "status",
         "applied_to_session", "amount_minor", "currency", "currency_exponent",
         "settings_revision", "manifest_hash", "created_by_actor_type", "created_by_actor_id",
         "expires_at", "captured_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MOCK', $4, 'CAPTURED', true,
         18000, 'AMD', 2, 1, $5, 'KIOSK', 'phase9-upgrade',
         CURRENT_TIMESTAMP + INTERVAL '3 minutes', CURRENT_TIMESTAMP)`,
      [
        fixture.paymentId,
        fixture.liveSessionId,
        fixture.quoteId,
        `mock_pi_${fixture.paymentId}`,
        fixture.manifestHash
      ]
    );
    await client.query(
      `INSERT INTO "print_jobs"
        ("id", "session_id", "kiosk_id", "quote_id", "payment_id", "settings_revision",
         "settings_manifest_hash", "job_manifest", "job_manifest_hash", "status",
         "copies", "printed_sides", "physical_sheets", "deadline_at",
         "created_by_actor_type", "created_by_actor_id")
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, 1,
         $6, $7::jsonb, $8, 'QUEUED',
         1, 3, 3, CURRENT_TIMESTAMP + INTERVAL '5 minutes', 'KIOSK', 'phase9-upgrade')`,
      [
        fixture.printJobId,
        fixture.liveSessionId,
        fixture.kioskId,
        fixture.quoteId,
        fixture.paymentId,
        fixture.manifestHash,
        JSON.stringify({
          manifestVersion: 1,
          documents: [{ documentId: fixture.fileId, sha256: "c".repeat(64), sizeBytes: 128 }]
        }),
        fixture.jobManifestHash
      ]
    );
    await client.query(
      `UPDATE "print_sessions" SET "current_settings_revision" = 1 WHERE "id" = $1::uuid`,
      [fixture.liveSessionId]
    );
  } finally {
    await closeQuietly(client);
  }
}

/** Nothing that existed before the migration is changed by it, except the schedule. */
async function verifyExistingWorkSurvives(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    const live = await client.query(
      `SELECT "state", "cleanup_status", "cleanup_due_at", "files_deleted_at"
       FROM "print_sessions" WHERE "id" = $1::uuid`,
      [fixture.liveSessionId]
    );
    if (
      live.rowCount !== 1 ||
      live.rows[0]?.state !== "PAID" ||
      live.rows[0]?.cleanup_status !== "NOT_DUE" ||
      live.rows[0]?.cleanup_due_at !== null ||
      live.rows[0]?.files_deleted_at !== null
    ) {
      throw new Error("PHASE9_UPGRADE_SCHEDULED_A_LIVE_SESSION");
    }

    // A session that had already ended is overdue by definition: its customer
    // left before retention existed.
    const finished = await client.query(
      `SELECT "cleanup_status", "cleanup_due_at" FROM "print_sessions" WHERE "id" = $1::uuid`,
      [fixture.doneSessionId]
    );
    if (
      finished.rowCount !== 1 ||
      finished.rows[0]?.cleanup_status !== "PENDING" ||
      finished.rows[0]?.cleanup_due_at === null
    ) {
      throw new Error("PHASE9_UPGRADE_DID_NOT_ADOPT_FINISHED_SESSION");
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
      throw new Error("PHASE9_UPGRADE_PAYMENT_CHANGED");
    }

    const job = await client.query(
      `SELECT "job_manifest_hash", "manifest_redacted_at"
       FROM "print_jobs" WHERE "id" = $1::uuid`,
      [fixture.printJobId]
    );
    if (
      job.rowCount !== 1 ||
      job.rows[0]?.job_manifest_hash !== fixture.jobManifestHash ||
      job.rows[0]?.manifest_redacted_at !== null
    ) {
      throw new Error("PHASE9_UPGRADE_PRINT_JOB_CHANGED");
    }

    const runs = await client.query(`SELECT COUNT(*)::int AS "count" FROM "cleanup_runs"`);
    if (runs.rows[0]?.count !== 0) throw new Error("PHASE9_UPGRADE_INVENTED_CLEANUP_RUNS");
  } finally {
    await closeQuietly(client);
  }
}

/**
 * The guarantees that hold in the database itself: one run per session, a run
 * whose progress only moves forwards and is final once done, a session that
 * cannot claim its documents are gone while it still holds them, and one that
 * accepts nothing further once they are.
 */
async function verifyRetentionInvariants(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    const runId = randomUUID();
    await client.query(
      `INSERT INTO "cleanup_runs" ("id", "session_id", "reason")
       VALUES ($1::uuid, $2::uuid, 'CANCELED')`,
      [runId, fixture.liveSessionId]
    );

    // One run per session: a second scheduler cannot open a rival lease over
    // the same documents.
    await expectRejected(
      client,
      `INSERT INTO "cleanup_runs" ("id", "session_id", "reason")
       VALUES ($1::uuid, $2::uuid, 'CANCELED')`,
      [randomUUID(), fixture.liveSessionId],
      "PHASE9_SECOND_RUN_ACCEPTED"
    );

    // A half-written lease is a run two workers could both believe they hold.
    await expectRejected(
      client,
      `UPDATE "cleanup_runs" SET "lease_token" = $2::uuid WHERE "id" = $1::uuid`,
      [runId, randomUUID()],
      "PHASE9_PARTIAL_LEASE_ACCEPTED"
    );

    await client.query(
      `UPDATE "cleanup_runs"
         SET "checkpoint" = 'ARTIFACTS_DELETED', "status" = 'IN_PROGRESS'
       WHERE "id" = $1::uuid`,
      [runId]
    );
    // A worker holding an expired lease cannot rewind a run that has moved on.
    await expectRejected(
      client,
      `UPDATE "cleanup_runs" SET "checkpoint" = 'ACCESS_REVOKED' WHERE "id" = $1::uuid`,
      [runId],
      "PHASE9_CHECKPOINT_WALKED_BACKWARDS"
    );
    await client.query(`UPDATE "cleanup_runs" SET "attempts" = 2 WHERE "id" = $1::uuid`, [runId]);
    await expectRejected(
      client,
      `UPDATE "cleanup_runs" SET "attempts" = 1 WHERE "id" = $1::uuid`,
      [runId],
      "PHASE9_ATTEMPTS_REWOUND"
    );

    // The session still holds a READY document, so it cannot record that its
    // documents are gone however the update is phrased.
    await expectRejected(
      client,
      `UPDATE "print_sessions"
         SET "cleanup_status" = 'DONE', "files_deleted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.liveSessionId],
      "PHASE9_CLAIMED_DELETION_WITH_DOCUMENTS_PRESENT"
    );

    // Emptying it for real is accepted — but only once it is finished.
    await client.query(
      `UPDATE "uploaded_files"
         SET "status" = 'DELETED', "quarantine_object_key" = NULL, "content_sha256" = NULL,
             "page_count" = NULL, "deleted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.fileId]
    );
    await expectRejected(
      client,
      `UPDATE "print_sessions"
         SET "cleanup_status" = 'DONE', "files_deleted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.liveSessionId],
      "PHASE9_CLEANED_A_LIVE_SESSION"
    );

    await client.query(
      `UPDATE "print_sessions" SET "state" = 'CANCELED', "canceled_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.liveSessionId]
    );
    await client.query(
      `UPDATE "print_sessions"
         SET "cleanup_status" = 'DONE', "cleanup_due_at" = CURRENT_TIMESTAMP,
             "files_deleted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.liveSessionId]
    );

    // A cleaned session is closed for good in both directions: nothing may be
    // added to it, and it cannot be reopened.
    await expectRejected(
      client,
      `INSERT INTO "uploaded_files"
        ("id", "session_id", "uploaded_by_client_id", "client_file_id", "ordinal",
         "display_name", "status", "reserved_bytes", "quarantine_object_key")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 5, 'Document 6', 'UPLOADING', 128, $5)`,
      [
        randomUUID(),
        fixture.liveSessionId,
        fixture.clientId,
        randomUUID(),
        `quarantine/v1/${fixture.liveSessionId}/${randomUUID()}/phase9AfterCleanupToken`
      ],
      "PHASE9_CLEANED_SESSION_ACCEPTED_A_DOCUMENT"
    );
    await expectRejected(
      client,
      `UPDATE "print_sessions" SET "files_deleted_at" = NULL WHERE "id" = $1::uuid`,
      [fixture.liveSessionId],
      "PHASE9_CLEANED_SESSION_REOPENED"
    );

    // A finished run is final.
    await client.query(
      `UPDATE "cleanup_runs"
         SET "status" = 'DONE', "checkpoint" = 'COMPLETED',
             "completed_at" = CURRENT_TIMESTAMP, "lease_token" = NULL,
             "lease_expires_at" = NULL
       WHERE "id" = $1::uuid`,
      [runId]
    );
    await expectRejected(
      client,
      `UPDATE "cleanup_runs" SET "status" = 'PENDING' WHERE "id" = $1::uuid`,
      [runId],
      "PHASE9_FINISHED_RUN_REOPENED"
    );

    // The money the session generated is untouched by all of it.
    const payment = await client.query(
      `SELECT "status", "amount_minor" FROM "payments" WHERE "id" = $1::uuid`,
      [fixture.paymentId]
    );
    if (payment.rows[0]?.status !== "CAPTURED" || payment.rows[0]?.amount_minor !== 18000) {
      throw new Error("PHASE9_PAYMENT_LOST_TO_CLEANUP");
    }
  } finally {
    await closeQuietly(client);
  }
}

/**
 * A print manifest names each document by digest, and a digest confirms
 * possession of a file long after the file is gone. It may be replaced by a
 * count — once, only on a settled job, and only with the marker.
 */
async function verifyManifestRedaction(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    // An unsettled job still has to be printable from its own manifest.
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "job_manifest" = '{"redacted":true,"documentCount":1}'::jsonb,
             "manifest_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE9_REDACTED_AN_UNSETTLED_JOB"
    );

    await client.query(
      `UPDATE "print_jobs"
         SET "status" = 'CANCELED', "result_confidence" = 'CONFIRMED',
             "failure_code" = 'CANCELED_BY_CUSTOMER', "sheets_produced" = 0,
             "failed_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId]
    );

    // Rewriting the manifest into anything else is still a rewrite.
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "job_manifest" = '{"manifestVersion":1,"documents":[]}'::jsonb,
             "manifest_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE9_ARBITRARY_MANIFEST_REWRITE_ACCEPTED"
    );
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "job_manifest" = '{"redacted":true,"documentCount":1,"documents":[]}'::jsonb,
             "manifest_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE9_EXTRA_MANIFEST_KEYS_ACCEPTED"
    );
    // And without the marker it is a rewrite too, whatever the timestamp says.
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "job_manifest" = '{"redacted":true,"documentCount":1}'::jsonb
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE9_UNRECORDED_REDACTION_ACCEPTED"
    );

    await client.query(
      `UPDATE "print_jobs"
         SET "job_manifest" = '{"redacted":true,"documentCount":1}'::jsonb,
             "manifest_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId]
    );

    // Redaction happens once. What was paid for and what the device reported
    // stay readable afterwards.
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "job_manifest" = '{"redacted":true,"documentCount":9}'::jsonb,
             "manifest_redacted_at" = CURRENT_TIMESTAMP + INTERVAL '1 second'
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE9_MANIFEST_REDACTED_TWICE"
    );

    const job = await client.query(
      `SELECT "job_manifest"::text AS "manifest", "job_manifest_hash", "physical_sheets",
              "result_confidence", "failure_code"
       FROM "print_jobs" WHERE "id" = $1::uuid`,
      [fixture.printJobId]
    );
    const manifest = job.rows[0]?.manifest ?? "";
    if (
      manifest.includes("c".repeat(64)) ||
      manifest.includes(fixture.fileId) ||
      job.rows[0]?.job_manifest_hash !== fixture.jobManifestHash ||
      job.rows[0]?.physical_sheets !== 3 ||
      job.rows[0]?.result_confidence !== "CONFIRMED" ||
      job.rows[0]?.failure_code !== "CANCELED_BY_CUSTOMER"
    ) {
      throw new Error("PHASE9_REDACTION_LOST_THE_WRONG_THING");
    }
  } finally {
    await closeQuietly(client);
  }
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
    throw new Error("PHASE9_UPGRADE_TEST_REQUIRES_LOOPBACK_PRINTING_KIOSK_DATABASE");
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
