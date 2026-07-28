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
const phase5FirstMigration = "20260725010000_phase5_document_processing";
const fixture = {
  sessionId: "01900000-0000-7000-8000-000000000701",
  clientId: "01900000-0000-7000-8000-000000000702",
  fileId: "01900000-0000-7000-8000-000000000703",
  clientFileId: "01900000-0000-7000-8000-000000000704"
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
const temporaryDatabase = `printing_kiosk_phase5_upgrade_${suffix}`;
const adminUrl = withDatabase(sourceUrl, "postgres");
const temporaryUrl = withDatabase(sourceUrl, temporaryDatabase);
const admin = new pg.Client({ connectionString: adminUrl.href });

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${temporaryDatabase}"`);
  await applyPhase4Migrations(temporaryUrl);
  await insertPhase4Fixture(temporaryUrl);
  runPrisma(["migrate", "deploy"], temporaryUrl);
  await verifyUpgradedFixture(temporaryUrl);
  process.stdout.write(
    "Phase 4 -> Phase 5 migration upgrade verified with a preserved quarantined-file fixture.\n"
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

async function applyPhase4Migrations(targetUrl) {
  const migrations = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^\d{14}_[a-z0-9_]+$/u.test(entry.name) &&
        entry.name < phase5FirstMigration
    )
    .map((entry) => entry.name)
    .sort();
  if (migrations.length === 0) throw new Error("PHASE4_MIGRATIONS_NOT_FOUND");

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

async function insertPhase4Fixture(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "kiosks"
        ("id", "public_code", "name", "capabilities")
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "kiosk_phase5_upgrade_fixture",
        "PHASE5-UPGRADE",
        "Phase 5 migration fixture",
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
      [fixture.sessionId, "ps_phase5_upgrade_fixture", "kiosk_phase5_upgrade_fixture"]
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
         "quarantined_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0,
         'Document 1', 'QUARANTINED', 'PDF', 'application/pdf', 'application/pdf', 'pdf',
         128, 128, $5, $6, CURRENT_TIMESTAMP)`,
      [
        fixture.fileId,
        fixture.sessionId,
        fixture.clientId,
        fixture.clientFileId,
        "c".repeat(64),
        `quarantine/v1/${fixture.sessionId}/${fixture.fileId}/phase5UpgradeToken`
      ]
    );
  } finally {
    await closeQuietly(client);
  }
}

async function verifyUpgradedFixture(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    const result = await client.query(
      `SELECT "status", "processing_revision", "processing_generation",
              "processing_attempts", "processing_available_at", "processing_enqueued_at",
              "processing_claim_token", "processing_lease_expires_at",
              "processing_error_code", "malware_scan_status", "page_count", "ready_at"
       FROM "uploaded_files"
       WHERE "id" = $1::uuid`,
      [fixture.fileId]
    );
    const row = result.rows[0];
    if (
      result.rowCount !== 1 ||
      row.status !== "QUARANTINED" ||
      row.processing_revision !== 1 ||
      row.processing_generation !== 0 ||
      row.processing_attempts !== 0 ||
      !row.processing_available_at ||
      row.processing_enqueued_at !== null ||
      row.processing_claim_token !== null ||
      row.processing_lease_expires_at !== null ||
      row.processing_error_code !== null ||
      row.malware_scan_status !== "PENDING" ||
      row.page_count !== null ||
      row.ready_at !== null
    ) {
      throw new Error("PHASE5_UPGRADE_FIXTURE_INVALID");
    }

    const tables = await client.query(
      `SELECT "table_name"
       FROM "information_schema"."tables"
       WHERE "table_schema" = 'public'
         AND "table_name" IN ('file_derivatives', 'file_pages')
       ORDER BY "table_name"`
    );
    if (
      tables.rowCount !== 2 ||
      tables.rows[0]?.table_name !== "file_derivatives" ||
      tables.rows[1]?.table_name !== "file_pages"
    ) {
      throw new Error("PHASE5_UPGRADE_TABLES_MISSING");
    }
  } finally {
    await closeQuietly(client);
  }
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
    throw new Error("PHASE5_UPGRADE_TEST_REQUIRES_LOOPBACK_PRINTING_KIOSK_DATABASE");
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
