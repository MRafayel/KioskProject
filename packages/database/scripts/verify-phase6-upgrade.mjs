import { randomBytes } from "node:crypto";
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
const phase6FirstMigration = "20260731010000_phase6_settings_and_pricing";
const fixture = {
  kioskId: "kiosk_phase6_upgrade_fixture",
  sessionId: "01900000-0000-7000-8000-000000000801",
  clientId: "01900000-0000-7000-8000-000000000802",
  fileId: "01900000-0000-7000-8000-000000000803",
  clientFileId: "01900000-0000-7000-8000-000000000804",
  revisionId: "01900000-0000-7000-8000-000000000805",
  ruleSetId: "01900000-0000-7000-8000-000000000806",
  ruleId: "01900000-0000-7000-8000-000000000807",
  quoteId: "01900000-0000-7000-8000-000000000808"
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
const temporaryDatabase = `printing_kiosk_phase6_upgrade_${suffix}`;
const adminUrl = withDatabase(sourceUrl, "postgres");
const temporaryUrl = withDatabase(sourceUrl, temporaryDatabase);
const admin = new pg.Client({ connectionString: adminUrl.href });

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${temporaryDatabase}"`);
  await applyPhase5Migrations(temporaryUrl);
  await insertPhase5Fixture(temporaryUrl);
  runPrisma(["migrate", "deploy"], temporaryUrl);
  await verifyNeutralSessionDefaults(temporaryUrl);
  await verifyPricingInvariants(temporaryUrl);
  process.stdout.write(
    "Phase 5 -> Phase 6 migration upgrade verified: neutral session defaults, " +
      "append-only settings revisions, immutable published tariffs, and money invariants.\n"
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

async function applyPhase5Migrations(targetUrl) {
  const migrations = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{14}_[a-z0-9_]+$/u.test(entry.name) &&
        entry.name < phase6FirstMigration
    )
    .map((entry) => entry.name)
    .sort();
  if (migrations.length === 0) throw new Error("PHASE5_MIGRATIONS_NOT_FOUND");

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

/** A session that already holds a validated document when Phase 6 arrives. */
async function insertPhase5Fixture(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "kiosks" ("id", "public_code", "name", "capabilities")
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        fixture.kioskId,
        "PHASE6-UPGRADE",
        "Phase 6 migration fixture",
        JSON.stringify({
          service: "PRINT_ONLY",
          outputMode: "MONOCHROME",
          paperSizes: ["A4"],
          duplex: true
        })
      ]
    );
    await client.query(
      `INSERT INTO "print_sessions"
        ("id", "public_id", "kiosk_id", "locale", "state", "idle_expires_at", "hard_expires_at")
       VALUES ($1::uuid, $2, $3, 'hy', 'WAITING_FOR_UPLOAD',
         CURRENT_TIMESTAMP + INTERVAL '10 minutes',
         CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
      [fixture.sessionId, "ps_phase6_upgrade_fixture", fixture.kioskId]
    );
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
        `quarantine/v1/${fixture.sessionId}/${fixture.fileId}/phase6UpgradeToken`
      ]
    );
  } finally {
    await closeQuietly(client);
  }
}

async function verifyNeutralSessionDefaults(targetUrl) {
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
      row.state !== "WAITING_FOR_UPLOAD" ||
      row.current_settings_revision !== null ||
      row.active_quote_id !== null
    ) {
      throw new Error("PHASE6_UPGRADE_SESSION_DEFAULTS_INVALID");
    }

    const file = await client.query(
      `SELECT "status", "page_count" FROM "uploaded_files" WHERE "id" = $1::uuid`,
      [fixture.fileId]
    );
    if (file.rowCount !== 1 || file.rows[0]?.status !== "READY" || file.rows[0]?.page_count !== 3) {
      throw new Error("PHASE6_UPGRADE_FILE_CHANGED");
    }

    const tables = await client.query(
      `SELECT "table_name" FROM "information_schema"."tables"
       WHERE "table_schema" = 'public'
         AND "table_name" IN
           ('price_quotes', 'pricing_rule_sets', 'pricing_rules', 'print_setting_revisions')
       ORDER BY "table_name"`
    );
    if (tables.rowCount !== 4) throw new Error("PHASE6_UPGRADE_TABLES_MISSING");
  } finally {
    await closeQuietly(client);
  }
}

/**
 * The guarantees that must hold in the database itself: an append-only
 * settings revision, an immutable published tariff, and a quote whose stored
 * total is reconstructible from its stored parts.
 */
async function verifyPricingInvariants(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "pages_per_sheet", "scaling", "collate", "color_mode", "selections",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       VALUES ($1::uuid, $2::uuid, 1, 1, 'SIMPLEX', 'A4', 'AUTO', 1, 'FIT', true, 'MONOCHROME',
         $3::jsonb, 3, 3, 3, 1, $4, 'KIOSK', 'phase6-upgrade')`,
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
        "d".repeat(64)
      ]
    );

    await expectRejected(
      client,
      `UPDATE "print_setting_revisions" SET "copies" = 4 WHERE "id" = $1::uuid`,
      [fixture.revisionId],
      "PHASE6_SETTINGS_REVISION_MUTABLE"
    );

    await expectRejected(
      client,
      `INSERT INTO "print_setting_revisions"
        ("id", "session_id", "revision", "copies", "duplex", "paper_size", "orientation",
         "pages_per_sheet", "scaling", "collate", "color_mode", "selections",
         "selected_pages", "printed_sides", "physical_sheets", "capability_version",
         "manifest_hash", "created_by_actor_type", "created_by_actor_id")
       VALUES (gen_random_uuid(), $1::uuid, 2, 1, 'SIMPLEX', 'A4', 'AUTO', 1, 'FIT', true,
         'COLOR', $2::jsonb, 3, 3, 3, 1, $3, 'KIOSK', 'phase6-upgrade')`,
      [fixture.sessionId, JSON.stringify([{ fileId: fixture.fileId }]), "d".repeat(64)],
      "PHASE6_COLOUR_OUTPUT_ACCEPTED"
    );

    await client.query(
      `INSERT INTO "pricing_rule_sets"
        ("id", "version", "scope", "currency", "currency_exponent", "status", "rounding",
         "tax_mode", "minimum_application", "valid_from", "published_at")
       VALUES ($1::uuid, 'price-upgrade-check', 'GLOBAL', 'AMD', 2, 'PUBLISHED', 'HALF_UP',
         'EXCLUSIVE', 'BEFORE_TAX', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [fixture.ruleSetId]
    );
    await client.query(
      `INSERT INTO "pricing_rules"
        ("id", "rule_set_id", "service", "paper_size", "color_mode", "unit_amount_minor",
         "duplex_adjustment_basis_points", "service_fee_minor", "minimum_amount_minor",
         "tax_basis_points", "priority")
       VALUES ($1::uuid, $2::uuid, 'PRINT', 'A4', 'MONOCHROME', 5000, 0, 0, 10000, 2000, 0)`,
      [fixture.ruleId, fixture.ruleSetId]
    );

    await expectRejected(
      client,
      `UPDATE "pricing_rule_sets" SET "currency" = 'USD' WHERE "id" = $1::uuid`,
      [fixture.ruleSetId],
      "PHASE6_PUBLISHED_TARIFF_MUTABLE"
    );
    await expectRejected(
      client,
      `UPDATE "pricing_rules" SET "unit_amount_minor" = 1 WHERE "id" = $1::uuid`,
      [fixture.ruleId],
      "PHASE6_PUBLISHED_RULE_MUTABLE"
    );

    // A quote whose parts do not add up to its total must be impossible.
    await expectRejected(
      client,
      `INSERT INTO "price_quotes"
        ("id", "session_id", "settings_revision", "manifest_hash", "rule_set_id",
         "pricing_version", "status", "currency", "currency_exponent", "selected_pages",
         "printed_sides", "physical_sheets", "print_amount_minor", "duplex_adjustment_minor",
         "service_fee_minor", "minimum_adjustment_minor", "subtotal_minor", "tax_minor",
         "total_minor", "expires_at")
       VALUES (gen_random_uuid(), $1::uuid, 1, $2, $3::uuid, 'price-upgrade-check', 'ACTIVE',
         'AMD', 2, 3, 3, 3, 15000, 0, 0, 0, 15000, 3000, 1,
         CURRENT_TIMESTAMP + INTERVAL '5 minutes')`,
      [fixture.sessionId, "d".repeat(64), fixture.ruleSetId],
      "PHASE6_INCONSISTENT_QUOTE_ACCEPTED"
    );

    await client.query(
      `INSERT INTO "price_quotes"
        ("id", "session_id", "settings_revision", "manifest_hash", "rule_set_id",
         "pricing_version", "status", "currency", "currency_exponent", "selected_pages",
         "printed_sides", "physical_sheets", "print_amount_minor", "duplex_adjustment_minor",
         "service_fee_minor", "minimum_adjustment_minor", "subtotal_minor", "tax_minor",
         "total_minor", "expires_at")
       VALUES ($1::uuid, $2::uuid, 1, $3, $4::uuid, 'price-upgrade-check', 'ACTIVE',
         'AMD', 2, 3, 3, 3, 15000, 0, 0, 0, 15000, 3000, 18000,
         CURRENT_TIMESTAMP + INTERVAL '5 minutes')`,
      [fixture.quoteId, fixture.sessionId, "d".repeat(64), fixture.ruleSetId]
    );

    // Only one live price per session.
    await expectRejected(
      client,
      `INSERT INTO "price_quotes"
        ("id", "session_id", "settings_revision", "manifest_hash", "rule_set_id",
         "pricing_version", "status", "currency", "currency_exponent", "selected_pages",
         "printed_sides", "physical_sheets", "print_amount_minor", "duplex_adjustment_minor",
         "service_fee_minor", "minimum_adjustment_minor", "subtotal_minor", "tax_minor",
         "total_minor", "expires_at")
       VALUES (gen_random_uuid(), $1::uuid, 1, $2, $3::uuid, 'price-upgrade-check', 'ACTIVE',
         'AMD', 2, 3, 3, 3, 15000, 0, 0, 0, 15000, 3000, 18000,
         CURRENT_TIMESTAMP + INTERVAL '5 minutes')`,
      [fixture.sessionId, "d".repeat(64), fixture.ruleSetId],
      "PHASE6_SECOND_ACTIVE_QUOTE_ACCEPTED"
    );
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
    throw new Error("PHASE6_UPGRADE_TEST_REQUIRES_LOOPBACK_PRINTING_KIOSK_DATABASE");
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
