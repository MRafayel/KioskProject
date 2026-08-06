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
const phase9ManifestHardeningMigration = "20260806010000_harden_phase9_manifest_redaction";
const fixture = {
  kioskId: "kiosk_phase9_upgrade_fixture",
  legacyKioskId: "kiosk_phase9_legacy_fixture",
  terminalKioskId: "kiosk_terminal_capacity_fixture",
  liveSessionId: "01900000-0000-7000-8000-000000000b01",
  doneSessionId: "01900000-0000-7000-8000-000000000b11",
  failedSessionId: "01900000-0000-7000-8000-000000000b21",
  recoverySessionId: "01900000-0000-7000-8000-000000000b22",
  replacementSessionId: "01900000-0000-7000-8000-000000000b23",
  clientId: "01900000-0000-7000-8000-000000000b02",
  fileId: "01900000-0000-7000-8000-000000000b03",
  clientFileId: "01900000-0000-7000-8000-000000000b04",
  revisionId: "01900000-0000-7000-8000-000000000b05",
  ruleSetId: "01900000-0000-7000-8000-000000000b06",
  quoteId: "01900000-0000-7000-8000-000000000b08",
  paymentId: "01900000-0000-7000-8000-000000000b09",
  printJobId: "01900000-0000-7000-8000-000000000b0a",
  cleanedRevisionId: "01900000-0000-7000-8000-000000000b31",
  graceSessionId: "01900000-0000-7000-8000-000000000b32",
  graceClientId: "01900000-0000-7000-8000-000000000b33",
  graceFileId: "01900000-0000-7000-8000-000000000b34",
  poisonSessionId: "01900000-0000-7000-8000-000000000b35",
  poisonRevisionId: "01900000-0000-7000-8000-000000000b36",
  poisonQuoteId: "01900000-0000-7000-8000-000000000b37",
  poisonPaymentId: "01900000-0000-7000-8000-000000000b38",
  poisonPrintJobId: "01900000-0000-7000-8000-000000000b39",
  poisonCleanupRunId: "01900000-0000-7000-8000-000000000b3a",
  directDoneSessionId: "01900000-0000-7000-8000-000000000b3b",
  directDoneRevisionId: "01900000-0000-7000-8000-000000000b3c",
  directDoneClientId: "01900000-0000-7000-8000-000000000b3d",
  directDoneFileId: "01900000-0000-7000-8000-000000000b3e",
  directDoneCleanupRunId: "01900000-0000-7000-8000-000000000b3f",
  manifestHash: "d".repeat(64),
  jobManifestHash: "e".repeat(64),
  poisonManifestHash: "f".repeat(64),
  poisonJobManifestHash: "9".repeat(64)
};

const SQLSTATE = {
  checkViolation: "23514",
  restrictViolation: "23001",
  uniqueViolation: "23505"
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
  await applyMigrationRange(temporaryUrl, phase9FirstMigration, phase9ManifestHardeningMigration);
  await verifyExistingWorkSurvives(temporaryUrl);
  await stageLegacyPhase9Rows(temporaryUrl);
  await verifyUnrecoverableManifestFailsClosed(temporaryUrl);
  await replaceUnrecoverableManifestWithRepairablePoison(temporaryUrl);
  runPrisma(["migrate", "deploy"], temporaryUrl);
  await verifyLegacyUpgradeRepairs(temporaryUrl);
  await verifyTerminalSessionCapacity(temporaryUrl);
  await verifyPreRedactedInsertsRejected(temporaryUrl);
  await verifyActiveSettingRedactionRejected(temporaryUrl);
  await verifyRollingDeploymentCompatibility(temporaryUrl);
  await verifyRetentionInvariants(temporaryUrl);
  await verifySettingDigestRedaction(temporaryUrl);
  await verifyManifestRedaction(temporaryUrl);
  process.stdout.write(
    "Phase 8 -> Phase 9 migration upgrade verified: existing sessions and captures are " +
      "untouched, a finished session is scheduled for cleanup, a run is leased and its " +
      "progress only moves forwards, a session cannot claim its documents are gone while it " +
      "still holds them, a cleaned session accepts no further document, legacy file schedules " +
      "retain their grace period, document fingerprints are removed from retained settings, " +
      "poisoned manifest timestamps are repaired only when their count is recoverable, new " +
      "snapshots cannot start redacted, old workers cannot skip settings redaction, old APIs " +
      "cannot shorten cleanup grace, terminal print evidence is immutable, a print manifest " +
      "can be redacted exactly once and only into the marker, failed sessions release their " +
      "kiosk, and the payment ledger survives.\n"
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

/** A live paid snapshot is still needed to create its print job. */
async function verifyActiveSettingRedactionRejected(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await expectRejected(
      client,
      `UPDATE "print_setting_revisions"
         SET "selections" = (
               SELECT jsonb_agg("entry" - 'contentSha256' ORDER BY "ordinal")
                 FROM jsonb_array_elements("selections")
                   WITH ORDINALITY AS items("entry", "ordinal")
             ),
             "selections_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.revisionId],
      "PHASE9_REDACTED_ACTIVE_SETTINGS"
    );
  } finally {
    await closeQuietly(client);
  }
}

/** Build the schema as it stood at the end of Phase 8. */
async function applyPhase8Migrations(targetUrl) {
  await applyMigrationRange(targetUrl, undefined, phase9FirstMigration);
}

/** Apply and record a contiguous migration range without advancing beyond it. */
async function applyMigrationRange(targetUrl, lowerInclusive, upperExclusive) {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrations = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{14}_[a-z0-9_]+$/u.test(entry.name) &&
        (lowerInclusive === undefined || entry.name >= lowerInclusive) &&
        entry.name < upperExclusive
    )
    .map((entry) => entry.name)
    .sort();
  if (migrations.length === 0) throw new Error("PHASE9_UPGRADE_MIGRATION_RANGE_EMPTY");

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

/**
 * Reproduce rows that an already-running, vulnerable Phase 9 deployment could
 * contain before the additive audit migrations arrive.
 */
async function stageLegacyPhase9Rows(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    await client.query(
      `INSERT INTO "kiosks" ("id", "public_code", "name", "capabilities")
       VALUES ($1, 'PHASE9-LEGACY', 'Phase 9 legacy fixture', $2::jsonb)`,
      [
        fixture.legacyKioskId,
        JSON.stringify({
          service: "PRINT_ONLY",
          outputMode: "MONOCHROME",
          paperSizes: ["A4"],
          duplex: true
        })
      ]
    );

    // This snapshot belongs to a session whose cleanup already completed.
    // The settings migration must backfill its digest because no worker will
    // revisit a DONE run merely to execute a newly-added metadata step.
    await client.query(
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "scaling", "collate", "color_mode", "selections",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       VALUES ($1::uuid, $2::uuid, 1, 1, 'SIMPLEX', 'A4', 'AUTO', 'FIT', true, 'MONOCHROME',
         $3::jsonb, 1, 1, 1, 1, $4, 'SYSTEM', 'phase9-legacy')`,
      [
        fixture.cleanedRevisionId,
        fixture.doneSessionId,
        JSON.stringify([
          {
            fileId: "01900000-0000-7000-8000-000000000b30",
            position: 0,
            pageCount: 1,
            processingRevision: 1,
            contentSha256: "8".repeat(64),
            pageRanges: [[1, 1]],
            pageRangeText: "1",
            selectedPages: 1
          }
        ]),
        "8".repeat(64)
      ]
    );
    await client.query(
      `UPDATE "print_sessions"
         SET "cleanup_status" = 'DONE', "files_deleted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.doneSessionId]
    );

    // Old application instances put a terminal file into DELETE_PENDING now,
    // even though the session policy allowed a later cleanup time.
    await client.query(
      `INSERT INTO "print_sessions"
        ("id", "public_id", "kiosk_id", "locale", "state", "terminal_reason",
         "idle_expires_at", "hard_expires_at", "cleanup_status", "cleanup_due_at")
       VALUES ($1::uuid, 'ps_phase9_legacy_grace', $2, 'hy', 'CANCELED', 'USER_CANCELED',
         CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP + INTERVAL '30 minutes',
         'PENDING', CURRENT_TIMESTAMP + INTERVAL '20 minutes')`,
      [fixture.graceSessionId, fixture.legacyKioskId]
    );
    await client.query(
      `INSERT INTO "mobile_clients"
        ("id", "session_id", "cookie_digest", "client_nonce_digest", "status", "expires_at",
         "revoked_at")
       VALUES ($1::uuid, $2::uuid, $3, $4, 'REVOKED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [fixture.graceClientId, fixture.graceSessionId, "6".repeat(64), "7".repeat(64)]
    );
    await client.query(
      `INSERT INTO "uploaded_files"
        ("id", "session_id", "uploaded_by_client_id", "client_file_id", "ordinal",
         "display_name", "status", "reserved_bytes", "content_sha256",
         "quarantine_object_key", "cleanup_due_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'Document 1', 'DELETE_PENDING',
         128, $5, $6, CURRENT_TIMESTAMP)`,
      [
        fixture.graceFileId,
        fixture.graceSessionId,
        fixture.graceClientId,
        randomUUID(),
        "7".repeat(64),
        `quarantine/v1/${fixture.graceSessionId}/${fixture.graceFileId}/phase9LegacyGrace`
      ]
    );

    // A timestamp-only terminal manifest is the original Phase 9 poisoning
    // bug. Start with a malformed raw manifest so the hardening migration can
    // first prove it refuses to invent a document count.
    await client.query(
      `INSERT INTO "print_sessions"
        ("id", "public_id", "kiosk_id", "locale", "state", "idle_expires_at", "hard_expires_at")
       VALUES ($1::uuid, 'ps_phase9_manifest_poison', $2, 'hy', 'PAID',
         CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
      [fixture.poisonSessionId, fixture.legacyKioskId]
    );
    await client.query(
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "scaling", "collate", "color_mode", "selections",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       VALUES ($1::uuid, $2::uuid, 1, 1, 'SIMPLEX', 'A4', 'AUTO', 'FIT', true, 'MONOCHROME',
         $3::jsonb, 2, 2, 2, 1, $4, 'SYSTEM', 'phase9-legacy')`,
      [
        fixture.poisonRevisionId,
        fixture.poisonSessionId,
        JSON.stringify([
          {
            fileId: "01900000-0000-7000-8000-000000000b40",
            position: 0,
            pageCount: 2,
            processingRevision: 1,
            contentSha256: "4".repeat(64),
            pageRanges: [[1, 2]],
            pageRangeText: "1-2",
            selectedPages: 2
          }
        ]),
        fixture.poisonManifestHash
      ]
    );
    await client.query(
      `INSERT INTO "price_quotes"
        ("id", "session_id", "settings_revision", "manifest_hash", "rule_set_id",
         "pricing_version", "status", "currency", "currency_exponent", "selected_pages",
         "printed_sides", "physical_sheets", "print_amount_minor", "duplex_adjustment_minor",
         "service_fee_minor", "minimum_adjustment_minor", "subtotal_minor", "tax_minor",
         "total_minor", "expires_at")
       VALUES ($1::uuid, $2::uuid, 1, $3, $4::uuid, 'price-phase9-check', 'CONSUMED',
         'AMD', 2, 2, 2, 2, 10000, 0, 0, 0, 10000, 2000, 12000,
         CURRENT_TIMESTAMP + INTERVAL '5 minutes')`,
      [
        fixture.poisonQuoteId,
        fixture.poisonSessionId,
        fixture.poisonManifestHash,
        fixture.ruleSetId
      ]
    );
    await client.query(
      `INSERT INTO "payments"
        ("id", "session_id", "quote_id", "provider", "provider_intent_id", "status",
         "applied_to_session", "amount_minor", "currency", "currency_exponent",
         "settings_revision", "manifest_hash", "created_by_actor_type", "created_by_actor_id",
         "expires_at", "captured_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MOCK', $4, 'CAPTURED', true,
         12000, 'AMD', 2, 1, $5, 'SYSTEM', 'phase9-legacy',
         CURRENT_TIMESTAMP + INTERVAL '3 minutes', CURRENT_TIMESTAMP)`,
      [
        fixture.poisonPaymentId,
        fixture.poisonSessionId,
        fixture.poisonQuoteId,
        `mock_pi_${fixture.poisonPaymentId}`,
        fixture.poisonManifestHash
      ]
    );
    await insertPoisonPrintJob(client, { documentsAreRecoverable: false });
    await poisonManifestTimestamp(client);
  } finally {
    await closeQuietly(client);
  }
}

async function verifyUnrecoverableManifestFailsClosed(targetUrl) {
  const migrationSql = await readFile(
    join(migrationsDirectory, phase9ManifestHardeningMigration, "migration.sql"),
    "utf8"
  );
  const client = new pg.Client({ connectionString: targetUrl.href });
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query("BEGIN");
    transactionOpen = true;
    try {
      await client.query(migrationSql);
    } catch (error) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      if (sqlState(error) === SQLSTATE.restrictViolation) return;
      throw new Error("PHASE9_UNRECOVERABLE_MANIFEST_WRONG_SQLSTATE", { cause: error });
    }
    throw new Error("PHASE9_UNRECOVERABLE_MANIFEST_WAS_GUESSED");
  } finally {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    await closeQuietly(client);
  }
}

async function replaceUnrecoverableManifestWithRepairablePoison(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await client.query(`DELETE FROM "print_jobs" WHERE "id" = $1::uuid`, [
      fixture.poisonPrintJobId
    ]);
    await insertPoisonPrintJob(client, { documentsAreRecoverable: true });
    await poisonManifestTimestamp(client);
  } finally {
    await closeQuietly(client);
  }
}

async function insertPoisonPrintJob(client, { documentsAreRecoverable }) {
  const manifest = documentsAreRecoverable
    ? {
        manifestVersion: 1,
        documents: [
          { documentId: "01900000-0000-7000-8000-000000000b40", sha256: "4".repeat(64) },
          { documentId: "01900000-0000-7000-8000-000000000b41", sha256: "5".repeat(64) }
        ]
      }
    : { manifestVersion: 1, items: [{ privateDigest: "4".repeat(64) }] };

  await client.query(
    `INSERT INTO "print_jobs"
      ("id", "session_id", "kiosk_id", "quote_id", "payment_id", "settings_revision",
       "settings_manifest_hash", "job_manifest", "job_manifest_hash", "status",
       "copies", "printed_sides", "physical_sheets", "deadline_at",
       "created_by_actor_type", "created_by_actor_id")
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, 1,
       $6, $7::jsonb, $8, 'QUEUED', 1, 2, 2, CURRENT_TIMESTAMP + INTERVAL '5 minutes',
       'SYSTEM', 'phase9-legacy')`,
    [
      fixture.poisonPrintJobId,
      fixture.poisonSessionId,
      fixture.legacyKioskId,
      fixture.poisonQuoteId,
      fixture.poisonPaymentId,
      fixture.poisonManifestHash,
      JSON.stringify(manifest),
      fixture.poisonJobManifestHash
    ]
  );
}

async function poisonManifestTimestamp(client) {
  await client.query(
    `UPDATE "print_jobs"
       SET "status" = 'CANCELED', "result_confidence" = 'CONFIRMED',
           "failure_code" = 'CANCELED_BY_CUSTOMER', "sheets_produced" = 0,
           "failed_at" = CURRENT_TIMESTAMP, "manifest_redacted_at" = CURRENT_TIMESTAMP
     WHERE "id" = $1::uuid`,
    [fixture.poisonPrintJobId]
  );
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

/** Verify every additive audit migration repaired the vulnerable legacy row. */
async function verifyLegacyUpgradeRepairs(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    const poison = await client.query(
      `SELECT "job_manifest", "manifest_redacted_at", "status", "result_confidence",
              "failure_code", "sheets_produced", "dispatch_attempts"
         FROM "print_jobs" WHERE "id" = $1::uuid`,
      [fixture.poisonPrintJobId]
    );
    const poisonedJob = poison.rows[0];
    if (
      poison.rowCount !== 1 ||
      poisonedJob?.manifest_redacted_at === null ||
      poisonedJob?.status !== "CANCELED" ||
      poisonedJob?.result_confidence !== "CONFIRMED" ||
      poisonedJob?.failure_code !== "CANCELED_BY_CUSTOMER" ||
      poisonedJob?.sheets_produced !== 0 ||
      poisonedJob?.job_manifest?.redacted !== true ||
      poisonedJob?.job_manifest?.documentCount !== 2 ||
      Object.keys(poisonedJob?.job_manifest ?? {}).length !== 2
    ) {
      throw new Error("PHASE9_RECOVERABLE_MANIFEST_POISON_NOT_REPAIRED");
    }

    // The same-status loophole used to permit terminal evidence to be edited.
    // Both outcome and progress now remain frozen after settlement.
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "failure_code" = 'TAMPERED', "dispatch_attempts" = "dispatch_attempts" + 1
       WHERE "id" = $1::uuid`,
      [fixture.poisonPrintJobId],
      "PHASE9_TERMINAL_PRINT_EVIDENCE_REWRITTEN",
      SQLSTATE.restrictViolation
    );
    await client.query(
      `UPDATE "print_jobs" SET "updated_at" = "updated_at" + INTERVAL '1 second'
       WHERE "id" = $1::uuid`,
      [fixture.poisonPrintJobId]
    );

    const cleanedSettings = await client.query(
      `SELECT "selections"::text AS "selections", "selections_redacted_at"
         FROM "print_setting_revisions" WHERE "id" = $1::uuid`,
      [fixture.cleanedRevisionId]
    );
    if (
      cleanedSettings.rowCount !== 1 ||
      cleanedSettings.rows[0]?.selections_redacted_at === null ||
      (cleanedSettings.rows[0]?.selections ?? "").includes("contentSha256") ||
      (cleanedSettings.rows[0]?.selections ?? "").includes("8".repeat(64))
    ) {
      throw new Error("PHASE9_TERMINAL_SETTINGS_DIGEST_NOT_BACKFILLED");
    }

    const grace = await client.query(
      `SELECT file."cleanup_due_at" AS "file_due_at",
              session."cleanup_due_at" AS "session_due_at"
         FROM "uploaded_files" AS file
         JOIN "print_sessions" AS session ON session."id" = file."session_id"
        WHERE file."id" = $1::uuid`,
      [fixture.graceFileId]
    );
    if (
      grace.rowCount !== 1 ||
      grace.rows[0]?.file_due_at === null ||
      grace.rows[0]?.session_due_at === null ||
      grace.rows[0].file_due_at < grace.rows[0].session_due_at
    ) {
      throw new Error("PHASE9_ROLLING_UPGRADE_SHORTENED_CLEANUP_GRACE");
    }
  } finally {
    await closeQuietly(client);
  }
}

/** Inserts cannot masquerade as already-redacted retention output. */
async function verifyPreRedactedInsertsRejected(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    await expectRejected(
      client,
      `INSERT INTO "print_jobs"
        ("id", "session_id", "kiosk_id", "quote_id", "payment_id", "settings_revision",
         "settings_manifest_hash", "job_manifest", "job_manifest_hash", "status",
         "result_confidence", "failure_code", "copies", "printed_sides", "physical_sheets",
         "sheets_produced", "deadline_at", "created_by_actor_type", "created_by_actor_id",
         "failed_at", "manifest_redacted_at")
       SELECT $2::uuid, "session_id", "kiosk_id", "quote_id", "payment_id", "settings_revision",
              "settings_manifest_hash", '{"redacted":true,"documentCount":2}'::jsonb,
              "job_manifest_hash", "status", "result_confidence", "failure_code", "copies",
              "printed_sides", "physical_sheets", "sheets_produced", "deadline_at",
              "created_by_actor_type", "created_by_actor_id", "failed_at", CURRENT_TIMESTAMP
         FROM "print_jobs" WHERE "id" = $1::uuid`,
      [fixture.poisonPrintJobId, randomUUID()],
      "PHASE9_PRE_REDACTED_PRINT_JOB_INSERTED",
      SQLSTATE.restrictViolation
    );

    await expectRejected(
      client,
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "scaling", "collate", "color_mode", "selections", "selections_redacted_at",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       SELECT $2::uuid, "session_id", 99, "copies", "duplex", "paper_size", "orientation",
              "scaling", "collate", "color_mode", "selections", CURRENT_TIMESTAMP,
              "selected_pages", "printed_sides", "physical_sheets", "capability_version",
              "manifest_hash", "created_by_actor_type", "created_by_actor_id"
         FROM "print_setting_revisions" WHERE "id" = $1::uuid`,
      [fixture.cleanedRevisionId, randomUUID()],
      "PHASE9_PRE_REDACTED_SETTINGS_INSERTED",
      SQLSTATE.restrictViolation
    );

    await expectRejected(
      client,
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "scaling", "collate", "color_mode", "selections",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       SELECT $2::uuid, "session_id", 100, "copies", "duplex", "paper_size", "orientation",
              "scaling", "collate", "color_mode", "selections",
              "selected_pages", "printed_sides", "physical_sheets", "capability_version",
              "manifest_hash", "created_by_actor_type", "created_by_actor_id"
         FROM "print_setting_revisions" WHERE "id" = $1::uuid`,
      [fixture.cleanedRevisionId, randomUUID()],
      "PHASE9_DIGEST_FREE_SETTINGS_INSERTED_WITHOUT_REDACTION",
      SQLSTATE.restrictViolation
    );
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Old Phase 9 processes may remain live while the audit migrations deploy.
 * Database triggers bridge both newly-added retention rules until those
 * processes have drained.
 */
async function verifyRollingDeploymentCompatibility(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    // This session was active when the migrations ran, so its settings were
    // intentionally not part of the one-time terminal backfill. Simulate an
    // old worker reaching its known metadata checkpoint without the new
    // application-level settings update.
    await client.query(
      `UPDATE "print_sessions"
         SET "state" = 'CANCELED', "terminal_reason" = 'USER_CANCELED',
             "canceled_at" = CURRENT_TIMESTAMP, "cleanup_status" = 'PENDING',
             "cleanup_due_at" = CURRENT_TIMESTAMP + INTERVAL '20 minutes'
       WHERE "id" = $1::uuid`,
      [fixture.poisonSessionId]
    );
    await assertSettingsDigestState(client, fixture.poisonRevisionId, false);
    await client.query(
      `INSERT INTO "cleanup_runs" ("id", "session_id", "reason")
       VALUES ($1::uuid, $2::uuid, 'CANCELED')`,
      [fixture.poisonCleanupRunId, fixture.poisonSessionId]
    );
    await client.query(
      `UPDATE "cleanup_runs"
         SET "status" = 'IN_PROGRESS', "checkpoint" = 'METADATA_SCRUBBED'
       WHERE "id" = $1::uuid`,
      [fixture.poisonCleanupRunId]
    );
    await assertSettingsDigestState(client, fixture.poisonRevisionId, true);

    // The inverse ordering also occurs in old cancellation paths: a file is
    // marked DELETE_PENDING first and the terminal parent schedule is written
    // afterwards. The parent trigger must lift that existing early deadline.
    await client.query(
      `INSERT INTO "print_sessions"
        ("id", "public_id", "kiosk_id", "locale", "state",
         "idle_expires_at", "hard_expires_at")
       VALUES ($1::uuid, 'ps_phase9_direct_done_compat', $2, 'hy', 'CREATED',
         CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
      [fixture.directDoneSessionId, fixture.legacyKioskId]
    );
    await client.query(
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "scaling", "collate", "color_mode", "selections",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       VALUES ($1::uuid, $2::uuid, 1, 1, 'SIMPLEX', 'A4', 'AUTO', 'FIT', true, 'MONOCHROME',
         $3::jsonb, 1, 1, 1, 1, $4, 'SYSTEM', 'phase9-rolling-compat')`,
      [
        fixture.directDoneRevisionId,
        fixture.directDoneSessionId,
        JSON.stringify([
          {
            fileId: fixture.directDoneFileId,
            position: 0,
            pageCount: 1,
            processingRevision: 1,
            contentSha256: "3".repeat(64),
            pageRanges: [[1, 1]],
            pageRangeText: "1",
            selectedPages: 1
          }
        ]),
        "3".repeat(64)
      ]
    );
    await client.query(
      `INSERT INTO "mobile_clients"
        ("id", "session_id", "cookie_digest", "client_nonce_digest", "status", "expires_at")
       VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', CURRENT_TIMESTAMP + INTERVAL '10 minutes')`,
      [fixture.directDoneClientId, fixture.directDoneSessionId, "1".repeat(64), "2".repeat(64)]
    );
    await client.query(
      `INSERT INTO "uploaded_files"
        ("id", "session_id", "uploaded_by_client_id", "client_file_id", "ordinal",
         "display_name", "status", "reserved_bytes", "content_sha256",
         "quarantine_object_key", "cleanup_due_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'Document 1', 'DELETE_PENDING',
         128, $5, $6, CURRENT_TIMESTAMP)`,
      [
        fixture.directDoneFileId,
        fixture.directDoneSessionId,
        fixture.directDoneClientId,
        randomUUID(),
        "3".repeat(64),
        `quarantine/v1/${fixture.directDoneSessionId}/${fixture.directDoneFileId}/phase9RollingCompat`
      ]
    );
    await client.query(
      `UPDATE "print_sessions"
         SET "state" = 'CANCELED', "terminal_reason" = 'USER_CANCELED',
             "canceled_at" = CURRENT_TIMESTAMP, "cleanup_status" = 'PENDING',
             "cleanup_due_at" = CURRENT_TIMESTAMP + INTERVAL '25 minutes'
       WHERE "id" = $1::uuid`,
      [fixture.directDoneSessionId]
    );
    await assertFileRespectsSessionDue(client, fixture.directDoneFileId);

    // An old API that writes `now` after the parent schedule exists is clamped
    // by the file trigger as well.
    await client.query(
      `UPDATE "uploaded_files" SET "cleanup_due_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.directDoneFileId]
    );
    await assertFileRespectsSessionDue(client, fixture.directDoneFileId);

    // A direct SCHEDULED -> DONE worker path must also invoke settings
    // redaction; it cannot rely on a separate METADATA_SCRUBBED update.
    await client.query(
      `UPDATE "uploaded_files"
         SET "status" = 'DELETED', "quarantine_object_key" = NULL,
             "content_sha256" = NULL, "deleted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.directDoneFileId]
    );
    await client.query(
      `INSERT INTO "cleanup_runs" ("id", "session_id", "reason")
       VALUES ($1::uuid, $2::uuid, 'CANCELED')`,
      [fixture.directDoneCleanupRunId, fixture.directDoneSessionId]
    );
    await client.query(
      `UPDATE "cleanup_runs"
         SET "status" = 'DONE', "checkpoint" = 'COMPLETED',
             "completed_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.directDoneCleanupRunId]
    );
    await assertSettingsDigestState(client, fixture.directDoneRevisionId, true);
  } finally {
    await closeQuietly(client);
  }
}

async function assertSettingsDigestState(client, revisionId, expectedRedacted) {
  const result = await client.query(
    `SELECT "selections"::text AS "selections", "selections_redacted_at"
       FROM "print_setting_revisions" WHERE "id" = $1::uuid`,
    [revisionId]
  );
  if (result.rowCount !== 1) throw new Error("PHASE9_SETTINGS_REVISION_MISSING");
  const selections = result.rows[0]?.selections ?? "";
  const isRedacted =
    result.rows[0]?.selections_redacted_at !== null && !selections.includes("contentSha256");
  if (isRedacted !== expectedRedacted) {
    throw new Error(
      expectedRedacted
        ? "PHASE9_OLD_WORKER_SKIPPED_SETTINGS_REDACTION"
        : "PHASE9_ACTIVE_SETTINGS_REDACTED_BEFORE_CLEANUP"
    );
  }
}

async function assertFileRespectsSessionDue(client, fileId) {
  const result = await client.query(
    `SELECT file."cleanup_due_at" AS "file_due_at",
            session."cleanup_due_at" AS "session_due_at"
       FROM "uploaded_files" AS file
       JOIN "print_sessions" AS session ON session."id" = file."session_id"
      WHERE file."id" = $1::uuid`,
    [fileId]
  );
  if (
    result.rowCount !== 1 ||
    result.rows[0]?.file_due_at === null ||
    result.rows[0]?.session_due_at === null ||
    result.rows[0].file_due_at < result.rows[0].session_due_at
  ) {
    throw new Error("PHASE9_OLD_API_SHORTENED_CLEANUP_GRACE");
  }
}

/** Terminal failures release the kiosk, but two live sessions remain forbidden. */
async function verifyTerminalSessionCapacity(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "kiosks" ("id", "public_code", "name", "capabilities")
       VALUES ($1, 'TERMINAL-CAPACITY', 'Terminal capacity migration fixture', '{}'::jsonb)`,
      [fixture.terminalKioskId]
    );

    for (const [sessionId, publicId, state] of [
      [fixture.failedSessionId, "ps_phase9_failed_terminal", "FAILED"],
      [fixture.recoverySessionId, "ps_phase9_recovery_terminal", "RECOVERY_REQUIRED"]
    ]) {
      await client.query(
        `INSERT INTO "print_sessions"
          ("id", "public_id", "kiosk_id", "locale", "state", "terminal_reason",
           "idle_expires_at", "hard_expires_at", "cleanup_status", "cleanup_due_at")
         VALUES ($1::uuid, $2, $3, 'hy', $4, 'UPGRADE_FIXTURE',
           CURRENT_TIMESTAMP + INTERVAL '10 minutes',
           CURRENT_TIMESTAMP + INTERVAL '30 minutes', 'PENDING', CURRENT_TIMESTAMP)`,
        [sessionId, publicId, fixture.terminalKioskId, state]
      );
    }

    await client.query(
      `INSERT INTO "print_sessions"
        ("id", "public_id", "kiosk_id", "locale", "state",
         "idle_expires_at", "hard_expires_at")
       VALUES ($1::uuid, 'ps_phase9_active_replacement', $2, 'hy', 'WAITING_FOR_UPLOAD',
         CURRENT_TIMESTAMP + INTERVAL '10 minutes',
         CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
      [fixture.replacementSessionId, fixture.terminalKioskId]
    );

    await expectRejected(
      client,
      `INSERT INTO "print_sessions"
        ("id", "public_id", "kiosk_id", "locale", "state",
         "idle_expires_at", "hard_expires_at")
       VALUES ($1::uuid, 'ps_phase9_competing_active', $2, 'hy', 'CREATED',
         CURRENT_TIMESTAMP + INTERVAL '10 minutes',
         CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
      [randomUUID(), fixture.terminalKioskId],
      "PHASE9_SECOND_ACTIVE_SESSION_ACCEPTED",
      SQLSTATE.uniqueViolation
    );
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
      "PHASE9_SECOND_RUN_ACCEPTED",
      SQLSTATE.uniqueViolation
    );

    // A half-written lease is a run two workers could both believe they hold.
    await expectRejected(
      client,
      `UPDATE "cleanup_runs" SET "lease_token" = $2::uuid WHERE "id" = $1::uuid`,
      [runId, randomUUID()],
      "PHASE9_PARTIAL_LEASE_ACCEPTED",
      SQLSTATE.checkViolation
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
 * Retained settings keep the priced paper/range choices, but not the raw digest
 * that can identify a customer's document after its bytes are gone.
 */
async function verifySettingDigestRedaction(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    // The cleanup run reached DONE through the ordinary verifier workflow.
    // The rolling-compatibility trigger must already have applied the exact
    // redaction even though this path did not issue a settings update itself.
    const revision = await client.query(
      `SELECT "selections"::text AS "selections", "selections_redacted_at"
         FROM "print_setting_revisions" WHERE "id" = $1::uuid`,
      [fixture.revisionId]
    );
    const selections = revision.rows[0]?.selections ?? "";
    if (
      selections.includes("contentSha256") ||
      selections.includes("c".repeat(64)) ||
      !selections.includes(fixture.fileId) ||
      revision.rows[0]?.selections_redacted_at === null
    ) {
      throw new Error("PHASE9_SETTING_DIGEST_REDACTION_INVALID");
    }

    // Once redacted, neither the snapshot nor its timestamp can be rewritten.
    await expectRejected(
      client,
      `UPDATE "print_setting_revisions"
         SET "selections" = '[{"fileId":"${fixture.fileId}","position":0,"pageCount":99}]'::jsonb,
             "selections_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.revisionId],
      "PHASE9_SETTING_REDACTION_REWROTE_SNAPSHOT"
    );

    await expectRejected(
      client,
      `UPDATE "print_setting_revisions"
         SET "selections_redacted_at" = CURRENT_TIMESTAMP + INTERVAL '1 second'
       WHERE "id" = $1::uuid`,
      [fixture.revisionId],
      "PHASE9_SETTING_REDACTED_TWICE"
    );
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

    // The timestamp must never get ahead of the destructive change. If it did,
    // retention would skip this job forever while its document digest remained.
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "manifest_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE9_REDACTION_TIMESTAMP_SET_WITHOUT_REDACTION"
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
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "job_manifest" = '{"redacted":true,"documentCount":-1}'::jsonb,
             "manifest_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE9_NEGATIVE_DOCUMENT_COUNT_ACCEPTED"
    );
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "job_manifest" = '{"redacted":true,"documentCount":1.5}'::jsonb,
             "manifest_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE9_FRACTIONAL_DOCUMENT_COUNT_ACCEPTED"
    );
    await expectRejected(
      client,
      `UPDATE "print_jobs"
         SET "job_manifest" = '{"redacted":true,"documentCount":2}'::jsonb,
             "manifest_redacted_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.printJobId],
      "PHASE9_INCORRECT_DOCUMENT_COUNT_ACCEPTED"
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

async function expectRejected(
  client,
  sql,
  parameters,
  failureCode,
  expectedSqlState = SQLSTATE.restrictViolation
) {
  try {
    await client.query(sql, parameters);
  } catch (error) {
    // A failed statement aborts the surrounding implicit transaction block
    // only when one is open; each query here runs on its own.
    const actualSqlState = sqlState(error);
    if (actualSqlState === expectedSqlState) return;
    throw new Error(
      `${failureCode}_WRONG_SQLSTATE_EXPECTED_${expectedSqlState}_GOT_${actualSqlState ?? "NONE"}`,
      { cause: error }
    );
  }
  throw new Error(failureCode);
}

function sqlState(error) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
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
