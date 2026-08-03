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
const phase7FirstMigration = "20260802010000_phase7_payments";
const fixture = {
  kioskId: "kiosk_phase7_upgrade_fixture",
  otherKioskId: "kiosk_phase7_upgrade_other",
  sessionId: "01900000-0000-7000-8000-000000000901",
  otherSessionId: "01900000-0000-7000-8000-000000000911",
  clientId: "01900000-0000-7000-8000-000000000902",
  fileId: "01900000-0000-7000-8000-000000000903",
  clientFileId: "01900000-0000-7000-8000-000000000904",
  revisionId: "01900000-0000-7000-8000-000000000905",
  ruleSetId: "01900000-0000-7000-8000-000000000906",
  ruleId: "01900000-0000-7000-8000-000000000907",
  quoteId: "01900000-0000-7000-8000-000000000908",
  paymentId: "01900000-0000-7000-8000-000000000909",
  attemptId: "01900000-0000-7000-8000-00000000090a",
  inboxId: "01900000-0000-7000-8000-00000000090b",
  refundId: "01900000-0000-7000-8000-00000000090c",
  manifestHash: "d".repeat(64)
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
const temporaryDatabase = `printing_kiosk_phase7_upgrade_${suffix}`;
const adminUrl = withDatabase(sourceUrl, "postgres");
const temporaryUrl = withDatabase(sourceUrl, temporaryDatabase);
const admin = new pg.Client({ connectionString: adminUrl.href });

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${temporaryDatabase}"`);
  await applyPhase6Migrations(temporaryUrl);
  await insertPhase6Fixture(temporaryUrl);
  runPrisma(["migrate", "deploy"], temporaryUrl);
  await verifyPricedSessionSurvives(temporaryUrl);
  await verifyPaymentInvariants(temporaryUrl);
  process.stdout.write(
    "Phase 6 -> Phase 7 migration upgrade verified: an existing priced session is untouched, " +
      "a payment must equal its quote, at most one applied capture and one open payment exist " +
      "per session, late captures remain accountable, captured state is final, and callbacks " +
      "and attempts are write-once evidence.\n"
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

async function applyPhase6Migrations(targetUrl) {
  const migrations = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{14}_[a-z0-9_]+$/u.test(entry.name) &&
        entry.name < phase7FirstMigration
    )
    .map((entry) => entry.name)
    .sort();
  if (migrations.length === 0) throw new Error("PHASE6_MIGRATIONS_NOT_FOUND");

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

/** A session that already holds a settings revision and a live price. */
async function insertPhase6Fixture(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    const capabilities = JSON.stringify({
      service: "PRINT_ONLY",
      outputMode: "MONOCHROME",
      paperSizes: ["A4"],
      duplex: true
    });
    // One active session per kiosk, so the second session — the one used to
    // prove a payment cannot borrow another session's price — needs its own.
    for (const [kioskId, publicCode] of [
      [fixture.kioskId, "PHASE7-UPGRADE"],
      [fixture.otherKioskId, "PHASE7-UPGRADE-OTHER"]
    ]) {
      await client.query(
        `INSERT INTO "kiosks" ("id", "public_code", "name", "capabilities")
         VALUES ($1, $2, $3, $4::jsonb)`,
        [kioskId, publicCode, "Phase 7 migration fixture", capabilities]
      );
    }
    for (const [sessionId, publicId, kioskId] of [
      [fixture.sessionId, "ps_phase7_upgrade_fixture", fixture.kioskId],
      [fixture.otherSessionId, "ps_phase7_upgrade_other", fixture.otherKioskId]
    ]) {
      await client.query(
        `INSERT INTO "print_sessions"
          ("id", "public_id", "kiosk_id", "locale", "state", "idle_expires_at", "hard_expires_at")
         VALUES ($1::uuid, $2, $3, 'hy', 'CONFIGURING',
           CURRENT_TIMESTAMP + INTERVAL '10 minutes',
           CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
        [sessionId, publicId, kioskId]
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
        `quarantine/v1/${fixture.sessionId}/${fixture.fileId}/phase7UpgradeToken`
      ]
    );
    await client.query(
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "scaling", "collate", "color_mode", "selections",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       VALUES ($1::uuid, $2::uuid, 1, 1, 'SIMPLEX', 'A4', 'AUTO', 'FIT', true, 'MONOCHROME',
         $3::jsonb, 3, 3, 3, 1, $4, 'KIOSK', 'phase7-upgrade')`,
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
       VALUES ($1::uuid, 'price-phase7-check', 'GLOBAL', 'AMD', 2, 'PUBLISHED', 'HALF_UP',
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
       VALUES ($1::uuid, $2::uuid, 1, $3, $4::uuid, 'price-phase7-check', 'ACTIVE',
         'AMD', 2, 3, 3, 3, 15000, 0, 0, 0, 15000, 3000, 18000,
         CURRENT_TIMESTAMP + INTERVAL '5 minutes')`,
      [fixture.quoteId, fixture.sessionId, fixture.manifestHash, fixture.ruleSetId]
    );
    await client.query(
      `UPDATE "print_sessions"
       SET "current_settings_revision" = 1, "active_quote_id" = $2::uuid
       WHERE "id" = $1::uuid`,
      [fixture.sessionId, fixture.quoteId]
    );
  } finally {
    await closeQuietly(client);
  }
}

async function verifyPricedSessionSurvives(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    const session = await client.query(
      `SELECT "state", "current_settings_revision", "active_quote_id"
       FROM "print_sessions" WHERE "id" = $1::uuid`,
      [fixture.sessionId]
    );
    const row = session.rows[0];
    if (
      session.rowCount !== 1 ||
      row.state !== "CONFIGURING" ||
      row.current_settings_revision !== 1 ||
      row.active_quote_id !== fixture.quoteId
    ) {
      throw new Error("PHASE7_UPGRADE_SESSION_CHANGED");
    }

    const quote = await client.query(
      `SELECT "status", "total_minor" FROM "price_quotes" WHERE "id" = $1::uuid`,
      [fixture.quoteId]
    );
    if (
      quote.rowCount !== 1 ||
      quote.rows[0]?.status !== "ACTIVE" ||
      quote.rows[0]?.total_minor !== 18000
    ) {
      throw new Error("PHASE7_UPGRADE_QUOTE_CHANGED");
    }

    const tables = await client.query(
      `SELECT "table_name" FROM "information_schema"."tables"
       WHERE "table_schema" = 'public'
         AND "table_name" IN
           ('payments', 'payment_attempts', 'payment_webhook_inbox', 'refunds')
       ORDER BY "table_name"`
    );
    if (tables.rowCount !== 4) throw new Error("PHASE7_UPGRADE_TABLES_MISSING");

    const payments = await client.query(`SELECT COUNT(*)::int AS "count" FROM "payments"`);
    if (payments.rows[0]?.count !== 0) throw new Error("PHASE7_UPGRADE_INVENTED_PAYMENTS");
  } finally {
    await closeQuietly(client);
  }
}

/**
 * The guarantees that must hold in the database itself, whatever application
 * code believes: a payment equals its quote, one capture at most is applied to
 * a session, late captures remain recordable, a capture is final, and received
 * evidence cannot be rewritten.
 */
async function verifyPaymentInvariants(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();

    // An amount that is not the quoted total cannot be stored at all.
    await expectRejected(
      client,
      insertPaymentSql(),
      paymentParameters({ id: randomUuid(), amountMinor: 17999 }),
      "PHASE7_PAYMENT_AMOUNT_MISMATCH_ACCEPTED"
    );
    await expectRejected(
      client,
      insertPaymentSql(),
      paymentParameters({ id: randomUuid(), currency: "USD" }),
      "PHASE7_PAYMENT_CURRENCY_MISMATCH_ACCEPTED"
    );
    // Nor may a payment borrow another session's price.
    await expectRejected(
      client,
      insertPaymentSql(),
      paymentParameters({ id: randomUuid(), sessionId: fixture.otherSessionId }),
      "PHASE7_FOREIGN_QUOTE_PAYMENT_ACCEPTED"
    );

    await client.query(insertPaymentSql(), paymentParameters({ id: fixture.paymentId }));

    // One payment in flight per session, and one provider intent per payment.
    await expectRejected(
      client,
      insertPaymentSql(),
      paymentParameters({ id: randomUuid(), providerIntentId: "mock_pi_second" }),
      "PHASE7_SECOND_OPEN_PAYMENT_ACCEPTED"
    );
    await client.query(
      `UPDATE "payments" SET "status" = 'DECLINED', "failure_code" = 'CARD_DECLINED',
         "failed_at" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`,
      [fixture.paymentId]
    );
    await expectRejected(
      client,
      insertPaymentSql(),
      paymentParameters({ id: randomUuid() }),
      "PHASE7_DUPLICATE_PROVIDER_INTENT_ACCEPTED"
    );
    // A decline is final in the other direction too: money cannot appear after
    // the provider said it never moved.
    await expectRejected(
      client,
      `UPDATE "payments" SET "status" = 'CAPTURED', "captured_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [fixture.paymentId],
      "PHASE7_DECLINED_PAYMENT_CAPTURED"
    );

    const capturedId = randomUuid();
    await client.query(
      insertPaymentSql(),
      paymentParameters({ id: capturedId, providerIntentId: `mock_pi_${capturedId}` })
    );
    await client.query(
      `UPDATE "payments" SET "status" = 'CAPTURED', "applied_to_session" = true,
         "captured_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [capturedId]
    );

    // Another provider capture can be recorded for accounting, but it cannot
    // also be applied to the session.
    const secondCaptureId = randomUuid();
    await client.query(
      insertPaymentSql(),
      paymentParameters({ id: secondCaptureId, providerIntentId: `mock_pi_${secondCaptureId}` })
    );
    await client.query(
      `UPDATE "payments" SET "status" = 'CAPTURED', "captured_at" = CURRENT_TIMESTAMP
       WHERE "id" = $1::uuid`,
      [secondCaptureId]
    );
    await expectRejected(
      client,
      `UPDATE "payments" SET "applied_to_session" = true
       WHERE "id" = $1::uuid`,
      [secondCaptureId],
      "PHASE7_SECOND_APPLIED_CAPTURE_ACCEPTED"
    );

    await expectRejected(
      client,
      `UPDATE "payments" SET "applied_to_session" = true WHERE "id" = $1::uuid`,
      [fixture.paymentId],
      "PHASE7_UNCAPTURED_PAYMENT_APPLIED"
    );

    // A late failure cannot overwrite a capture.
    await expectRejected(
      client,
      `UPDATE "payments" SET "status" = 'DECLINED', "failure_code" = 'CARD_DECLINED',
         "failed_at" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`,
      [capturedId],
      "PHASE7_LATE_DECLINE_OVERWROTE_CAPTURE"
    );
    await expectRejected(
      client,
      `UPDATE "payments" SET "provider_intent_id" = 'mock_pi_rewritten'
       WHERE "id" = $1::uuid`,
      [capturedId],
      "PHASE7_PAYMENT_IDENTITY_MUTABLE"
    );

    // Attempts and callbacks are write-once evidence.
    await client.query(
      `INSERT INTO "payment_attempts" ("id", "payment_id", "attempt", "action", "status")
       VALUES ($1::uuid, $2::uuid, 1, 'CREATE', 'PENDING')`,
      [fixture.attemptId, capturedId]
    );
    await expectRejected(
      client,
      `UPDATE "payment_attempts" SET "status" = 'CAPTURED' WHERE "id" = $1::uuid`,
      [fixture.attemptId],
      "PHASE7_PAYMENT_ATTEMPT_MUTABLE"
    );
    // Immutable is not the same as undeletable: a payment lineage removed
    // under the retention schedule must be able to take its own evidence with
    // it, and the foreign keys are what govern that.
    await client.query(
      `INSERT INTO "payment_attempts" ("id", "payment_id", "attempt", "action", "status")
       VALUES (gen_random_uuid(), $1::uuid, 1, 'CREATE', 'PENDING')`,
      [secondCaptureId]
    );
    await client.query(`DELETE FROM "payments" WHERE "id" = $1::uuid`, [secondCaptureId]);
    const orphaned = await client.query(
      `SELECT COUNT(*)::int AS "count" FROM "payment_attempts" WHERE "payment_id" = $1::uuid`,
      [secondCaptureId]
    );
    if (orphaned.rows[0]?.count !== 0) throw new Error("PHASE7_PAYMENT_ATTEMPT_ORPHANED");

    await client.query(
      `INSERT INTO "payment_webhook_inbox"
        ("id", "provider", "provider_event_id", "provider_intent_id", "payment_id",
         "event_type", "payload_digest", "result")
       VALUES ($1::uuid, 'MOCK', 'mock_evt_1', $2, $3::uuid, 'PAYMENT_CAPTURED', $4, 'CAPTURED')`,
      [fixture.inboxId, `mock_pi_${capturedId}`, capturedId, "e".repeat(64)]
    );
    await expectRejected(
      client,
      `INSERT INTO "payment_webhook_inbox"
        ("id", "provider", "provider_event_id", "provider_intent_id", "payment_id",
         "event_type", "payload_digest", "result")
       VALUES (gen_random_uuid(), 'MOCK', 'mock_evt_1', $1, $2::uuid,
         'PAYMENT_CAPTURED', $3, 'CAPTURED')`,
      [`mock_pi_${capturedId}`, capturedId, "e".repeat(64)],
      "PHASE7_DUPLICATE_CALLBACK_ACCEPTED"
    );
    await expectRejected(
      client,
      `UPDATE "payment_webhook_inbox" SET "payload_digest" = $2 WHERE "id" = $1::uuid`,
      [fixture.inboxId, "f".repeat(64)],
      "PHASE7_CALLBACK_EVIDENCE_MUTABLE"
    );
    await expectRejected(
      client,
      `UPDATE "payment_webhook_inbox" SET "result" = 'FAILED' WHERE "id" = $1::uuid`,
      [fixture.inboxId],
      "PHASE7_CALLBACK_DECISION_MUTABLE"
    );
    await expectRejected(
      client,
      `INSERT INTO "payment_webhook_inbox"
        ("id", "provider", "provider_event_id", "provider_intent_id", "payment_id",
         "event_type", "payload_digest", "result")
       VALUES (gen_random_uuid(), 'MOCK', 'mock_evt_wrong_link', 'mock_pi_wrong', $1::uuid,
         'PAYMENT_CAPTURED', $2, 'CAPTURED')`,
      [capturedId, "e".repeat(64)],
      "PHASE7_CALLBACK_LINK_MISMATCH_ACCEPTED"
    );

    // A compensation record is written once per payment and reason.
    await expectRejected(
      client,
      `INSERT INTO "refunds"
        ("id", "payment_id", "session_id", "provider", "reason", "amount_minor",
         "currency", "currency_exponent", "status")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'MOCK', 'LATE_CAPTURE', 18000,
         'AMD', 2, 'PENDING')`,
      [capturedId, fixture.otherSessionId],
      "PHASE7_FOREIGN_SESSION_REFUND_ACCEPTED"
    );
    await client.query(
      `INSERT INTO "refunds"
        ("id", "payment_id", "session_id", "provider", "reason", "amount_minor",
         "currency", "currency_exponent", "status")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MOCK', 'LATE_CAPTURE', 18000, 'AMD', 2, 'PENDING')`,
      [fixture.refundId, capturedId, fixture.sessionId]
    );
    await expectRejected(
      client,
      `INSERT INTO "refunds"
        ("id", "payment_id", "session_id", "provider", "reason", "amount_minor",
         "currency", "currency_exponent", "status")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'MOCK', 'LATE_CAPTURE', 18000,
         'AMD', 2, 'PENDING')`,
      [capturedId, fixture.sessionId],
      "PHASE7_DUPLICATE_COMPENSATION_ACCEPTED"
    );
    await expectRejected(
      client,
      `UPDATE "refunds" SET "amount_minor" = 1 WHERE "id" = $1::uuid`,
      [fixture.refundId],
      "PHASE7_REFUND_IDENTITY_MUTABLE"
    );
    // A capture that owes money back cannot be deleted out of the ledger.
    await expectRejected(
      client,
      `DELETE FROM "payments" WHERE "id" = $1::uuid`,
      [capturedId],
      "PHASE7_CAPTURED_PAYMENT_DELETABLE"
    );
  } finally {
    await closeQuietly(client);
  }
}

function insertPaymentSql() {
  return `INSERT INTO "payments"
    ("id", "session_id", "quote_id", "provider", "provider_intent_id", "status",
     "amount_minor", "currency", "currency_exponent", "settings_revision", "manifest_hash",
     "created_by_actor_type", "created_by_actor_id", "expires_at")
   VALUES ($1::uuid, $2::uuid, $3::uuid, 'MOCK', $4, 'PENDING',
     $5, $6, 2, 1, $7, 'KIOSK', 'phase7-upgrade',
     CURRENT_TIMESTAMP + INTERVAL '3 minutes')`;
}

function paymentParameters(overrides) {
  return [
    overrides.id,
    overrides.sessionId ?? fixture.sessionId,
    fixture.quoteId,
    overrides.providerIntentId ?? `mock_pi_${fixture.paymentId}`,
    overrides.amountMinor ?? 18000,
    overrides.currency ?? "AMD",
    overrides.manifestHash ?? fixture.manifestHash
  ];
}

function randomUuid() {
  return randomUUID();
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
    throw new Error("PHASE7_UPGRADE_TEST_REQUIRES_LOOPBACK_PRINTING_KIOSK_DATABASE");
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
