import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { config as loadDotenv } from "dotenv";
import pg from "pg";

/**
 * Phase 9 -> Phase 10 upgrade verification.
 *
 * The device plane is new tables rather than a change to existing ones, so the
 * upgrade risk is not data loss — it is the invariants the new tables have to
 * hold from the first row. A kiosk that could carry two approved printers, or
 * an unapproved queue that could publish capabilities, would let the settings a
 * customer is offered depend on which row happened to be read. Those are the
 * properties this proves against a database that already has Phase 9 work in
 * it, not against an empty one.
 */

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
const migrationsDirectory = join(packageDirectory, "prisma", "migrations");
const phase10FirstMigration = "20260811010000_phase10_device_plane";

const fixture = {
  kioskId: "kiosk_phase10_upgrade_fixture",
  otherKioskId: "kiosk_phase10_upgrade_other",
  sessionId: "01900000-0000-7000-8000-000000000c01",
  agentId: "01900000-0000-7000-8000-000000000c02",
  otherAgentRowId: "01900000-0000-7000-8000-000000000c03",
  approvedPrinterId: "01900000-0000-7000-8000-000000000c04",
  secondPrinterId: "01900000-0000-7000-8000-000000000c05",
  thirdPrinterId: "01900000-0000-7000-8000-000000000c06",
  agentRowId: "01900000-0000-7000-8000-000000000c07",
  capabilityHash: "a".repeat(64)
};

const SQLSTATE = {
  checkViolation: "23514",
  foreignKeyViolation: "23503",
  uniqueViolation: "23505"
};

const capabilities = {
  version: 3,
  paperSizes: ["A4"],
  duplexModes: ["SIMPLEX", "LONG_EDGE"],
  colorModes: ["MONOCHROME"],
  orientations: ["AUTO", "PORTRAIT", "LANDSCAPE"],
  scalingModes: ["FIT", "ACTUAL_SIZE"],
  maxCopies: 20
};

loadDotenv({ path: join(workspaceDirectory, ".env"), override: false, quiet: true });

const sourceUrl = new URL(
  process.env.DATABASE_URL ??
    "postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk"
);
assertSafeSourceDatabase(sourceUrl);

const suffix = `${process.pid}_${randomBytes(5).toString("hex")}`;
const temporaryDatabase = `printing_kiosk_phase10_upgrade_${suffix}`;
const adminUrl = withDatabase(sourceUrl, "postgres");
const temporaryUrl = withDatabase(sourceUrl, temporaryDatabase);
const admin = new pg.Client({ connectionString: adminUrl.href });

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${temporaryDatabase}"`);
  await applyMigrationRange(temporaryUrl, undefined, phase10FirstMigration);
  await insertPhase9Fixture(temporaryUrl);
  runPrisma(["migrate", "deploy"], temporaryUrl);
  await verifyExistingWorkSurvives(temporaryUrl);
  await verifyDeviceRowsAccepted(temporaryUrl);
  await verifyOneApprovedPrinterPerKiosk(temporaryUrl);
  await verifyCapabilitiesRequireApproval(temporaryUrl);
  await verifyAgentIdentityIsGlobal(temporaryUrl);
  await verifyDeviceRowsAreBounded(temporaryUrl);
  await verifyDeviceRowsFollowTheirKiosk(temporaryUrl);
  process.stdout.write(
    "Phase 9 -> Phase 10 migration upgrade verified: existing kiosks, sessions and " +
      "capabilities are untouched, an agent installation registers once and cannot be " +
      "claimed by a second kiosk, a kiosk carries at most one approved printer, only an " +
      "approved printer may publish capabilities, a device string cannot smuggle control " +
      "characters into an operator console, and removing a kiosk removes its device rows.\n"
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

/** A kiosk with a live session, exactly as Phase 9 left it. */
async function insertPhase9Fixture(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    for (const [kioskId, code] of [
      [fixture.kioskId, "PHASE10-UPGRADE"],
      [fixture.otherKioskId, "PHASE10-OTHER"]
    ]) {
      await client.query(
        `INSERT INTO "kiosks" ("id", "public_code", "name", "capabilities", "capabilities_version")
         VALUES ($1, $2, 'Phase 10 migration fixture', $3::jsonb, 2)`,
        [
          kioskId,
          code,
          JSON.stringify({
            service: "PRINT_ONLY",
            outputMode: "MONOCHROME",
            paperSizes: ["A4"],
            duplex: true
          })
        ]
      );
    }
    await client.query(
      `INSERT INTO "print_sessions"
        ("id", "public_id", "kiosk_id", "locale", "state", "idle_expires_at", "hard_expires_at")
       VALUES ($1::uuid, 'ps_phase10_upgrade', $2, 'hy', 'CONFIGURING',
         CURRENT_TIMESTAMP + INTERVAL '10 minutes',
         CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
      [fixture.sessionId, fixture.kioskId]
    );
  } finally {
    await closeQuietly(client);
  }
}

/** The device plane adds tables; it must not disturb what was already there. */
async function verifyExistingWorkSurvives(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    const session = await client.query(
      `SELECT "state", "cleanup_status" FROM "print_sessions" WHERE "id" = $1::uuid`,
      [fixture.sessionId]
    );
    const kiosk = await client.query(
      `SELECT "capabilities_version" FROM "kiosks" WHERE "id" = $1`,
      [fixture.kioskId]
    );
    if (
      session.rows[0]?.state !== "CONFIGURING" ||
      session.rows[0]?.cleanup_status !== "NOT_DUE" ||
      kiosk.rows[0]?.capabilities_version !== 2
    ) {
      throw new Error("PHASE10_UPGRADE_DISTURBED_EXISTING_WORK");
    }

    const printers = await client.query(`SELECT count(*)::int AS total FROM "printers"`);
    const agents = await client.query(`SELECT count(*)::int AS total FROM "kiosk_agents"`);
    // A migration that invented a printer would make an uncertified kiosk look
    // certified on the first read.
    if (printers.rows[0]?.total !== 0 || agents.rows[0]?.total !== 0) {
      throw new Error("PHASE10_UPGRADE_INVENTED_A_DEVICE");
    }
  } finally {
    await closeQuietly(client);
  }
}

async function verifyDeviceRowsAccepted(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO "kiosk_agents"
        ("id", "kiosk_id", "agent_id", "agent_version", "platform", "platform_release",
         "adapter", "queue_name", "printer_health", "capability_hash", "last_heartbeat_at")
       VALUES ($1::uuid, $2, $3::uuid, '0.0.0', 'win32', '10.0.19045', 'WINDOWS', 'Kiosk A4',
         'READY', $4, CURRENT_TIMESTAMP)`,
      [fixture.agentRowId, fixture.kioskId, fixture.agentId, fixture.capabilityHash]
    );
    await client.query(
      `INSERT INTO "printers"
        ("id", "kiosk_id", "queue_name", "adapter", "approval", "queue_state", "is_default",
         "shared", "driver_name", "health", "capabilities", "capability_hash")
       VALUES ($1::uuid, $2, 'Kiosk A4', 'WINDOWS', 'APPROVED', 'READY', true, false,
         'Generic PCL6', 'READY', $3::jsonb, $4)`,
      [
        fixture.approvedPrinterId,
        fixture.kioskId,
        JSON.stringify(capabilities),
        fixture.capabilityHash
      ]
    );
    // Every queue the machine offers gets a row so an operator can see what is
    // installed, and an uncertified one carries no capabilities.
    await client.query(
      `INSERT INTO "printers"
        ("id", "kiosk_id", "queue_name", "adapter", "approval", "queue_state", "shared", "health")
       VALUES ($1::uuid, $2, 'Microsoft Print to PDF', 'WINDOWS', 'NOT_APPROVED', 'READY', false,
         'OFFLINE')`,
      [fixture.secondPrinterId, fixture.kioskId]
    );

    await expectRejected(
      client,
      `INSERT INTO "printers" ("id", "kiosk_id", "queue_name", "adapter")
       VALUES ($1::uuid, $2, 'Kiosk A4', 'WINDOWS')`,
      [fixture.thirdPrinterId, fixture.kioskId],
      "PHASE10_DUPLICATE_QUEUE_ACCEPTED",
      SQLSTATE.uniqueViolation
    );
  } finally {
    await closeQuietly(client);
  }
}

/**
 * Two approved printers would make "which printer is this kiosk's printer" a
 * question with two answers, and the settings a customer is offered would
 * depend on which row was read first.
 */
async function verifyOneApprovedPrinterPerKiosk(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await expectRejected(
      client,
      `UPDATE "printers"
         SET "approval" = 'APPROVED', "capabilities" = $2::jsonb, "capability_hash" = $3
       WHERE "id" = $1::uuid`,
      [fixture.secondPrinterId, JSON.stringify(capabilities), fixture.capabilityHash],
      "PHASE10_SECOND_APPROVED_PRINTER_ACCEPTED",
      SQLSTATE.uniqueViolation
    );

    // Another kiosk's approved printer is not this kiosk's business.
    await client.query(
      `INSERT INTO "printers"
        ("id", "kiosk_id", "queue_name", "adapter", "approval", "queue_state", "health",
         "capabilities", "capability_hash")
       VALUES ($1::uuid, $2, 'Kiosk A4', 'IPP', 'APPROVED', 'READY', 'READY', $3::jsonb, $4)`,
      [
        fixture.thirdPrinterId,
        fixture.otherKioskId,
        JSON.stringify(capabilities),
        fixture.capabilityHash
      ]
    );
  } finally {
    await closeQuietly(client);
  }
}

async function verifyCapabilitiesRequireApproval(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await expectRejected(
      client,
      `UPDATE "printers" SET "capabilities" = $2::jsonb, "capability_hash" = $3 WHERE "id" = $1::uuid`,
      [fixture.secondPrinterId, JSON.stringify(capabilities), fixture.capabilityHash],
      "PHASE10_UNAPPROVED_PRINTER_PUBLISHED_CAPABILITIES",
      SQLSTATE.checkViolation
    );
    await expectRejected(
      client,
      `UPDATE "printers" SET "capabilities" = NULL, "capability_hash" = NULL WHERE "id" = $1::uuid`,
      [fixture.approvedPrinterId],
      "PHASE10_APPROVED_PRINTER_WITHOUT_CAPABILITIES",
      SQLSTATE.checkViolation
    );
  } finally {
    await closeQuietly(client);
  }
}

/**
 * An installation identifier is global. A second kiosk claiming the same agent
 * would make the fleet's liveness view describe a machine that does not exist.
 */
async function verifyAgentIdentityIsGlobal(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await expectRejected(
      client,
      `INSERT INTO "kiosk_agents"
        ("id", "kiosk_id", "agent_id", "agent_version", "platform", "adapter")
       VALUES ($1::uuid, $2, $3::uuid, '0.0.0', 'win32', 'WINDOWS')`,
      [fixture.otherAgentRowId, fixture.otherKioskId, fixture.agentId],
      "PHASE10_AGENT_CLAIMED_BY_TWO_KIOSKS",
      SQLSTATE.uniqueViolation
    );
  } finally {
    await closeQuietly(client);
  }
}

/** Device strings reach an operator console and a support ticket verbatim. */
async function verifyDeviceRowsAreBounded(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await expectRejected(
      client,
      `INSERT INTO "printers" ("id", "kiosk_id", "queue_name", "adapter")
       VALUES ($1::uuid, $2, E'Kiosk\\nA4', 'WINDOWS')`,
      ["01900000-0000-7000-8000-000000000c11", fixture.kioskId],
      "PHASE10_CONTROL_CHARACTER_QUEUE_NAME_ACCEPTED",
      SQLSTATE.checkViolation
    );
    await expectRejected(
      client,
      `INSERT INTO "printers" ("id", "kiosk_id", "queue_name", "adapter")
       VALUES ($1::uuid, $2, 'Unknown adapter queue', 'CUPS')`,
      ["01900000-0000-7000-8000-000000000c12", fixture.kioskId],
      "PHASE10_UNKNOWN_ADAPTER_ACCEPTED",
      SQLSTATE.checkViolation
    );
    await expectRejected(
      client,
      `UPDATE "kiosk_agents" SET "capability_hash" = 'not-a-digest' WHERE "id" = $1::uuid`,
      [fixture.agentRowId],
      "PHASE10_MALFORMED_CAPABILITY_DIGEST_ACCEPTED",
      SQLSTATE.checkViolation
    );
    await expectRejected(
      client,
      `INSERT INTO "kiosk_agents"
        ("id", "kiosk_id", "agent_id", "agent_version", "platform", "adapter")
       VALUES ($1::uuid, 'kiosk_that_does_not_exist', $2::uuid, '0.0.0', 'win32', 'WINDOWS')`,
      ["01900000-0000-7000-8000-000000000c13", "01900000-0000-7000-8000-000000000c14"],
      "PHASE10_AGENT_WITHOUT_KIOSK_ACCEPTED",
      SQLSTATE.foreignKeyViolation
    );
  } finally {
    await closeQuietly(client);
  }
}

/** Device rows describe a kiosk; a removed kiosk must not leave them behind. */
async function verifyDeviceRowsFollowTheirKiosk(targetUrl) {
  const client = new pg.Client({ connectionString: targetUrl.href });
  try {
    await client.connect();
    await client.query(`DELETE FROM "kiosks" WHERE "id" = $1`, [fixture.otherKioskId]);
    const remaining = await client.query(
      `SELECT count(*)::int AS total FROM "printers" WHERE "kiosk_id" = $1`,
      [fixture.otherKioskId]
    );
    if (remaining.rows[0]?.total !== 0) throw new Error("PHASE10_ORPHANED_DEVICE_ROWS");
  } finally {
    await closeQuietly(client);
  }
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
  if (migrations.length === 0) throw new Error("PHASE10_UPGRADE_MIGRATION_RANGE_EMPTY");

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

async function expectRejected(
  client,
  sql,
  parameters,
  failureCode,
  expectedSqlState = SQLSTATE.checkViolation
) {
  try {
    await client.query(sql, parameters);
  } catch (error) {
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
    env: { ...process.env, DATABASE_URL: targetUrl.href },
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
    throw new Error("PHASE10_UPGRADE_TEST_REQUIRES_LOOPBACK_PRINTING_KIOSK_DATABASE");
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
