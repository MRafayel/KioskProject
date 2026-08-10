#!/usr/bin/env node
/**
 * Provisioning for control-plane accounts.
 *
 * This is deliberately a command-line tool with direct database access rather
 * than a dashboard feature. The first account cannot be created from the
 * dashboard — there is nobody to authorise it — and account creation is rare
 * enough that a person at a terminal is the right control. It is the same
 * reasoning that keeps kiosk credential issuance out of the dashboard.
 *
 * Usage:
 *
 *   node scripts/admin-account.mjs create --name "Ada" --role TECHNICAL_ADMIN
 *   node scripts/admin-account.mjs break-glass --admin-user <uuid> --label "safe A"
 *   node scripts/admin-account.mjs list
 *   node scripts/admin-account.mjs suspend --admin-user <uuid>
 *   node scripts/admin-account.mjs resume --admin-user <uuid>
 *
 * A created account is PROVISIONING and can do nothing until the person uses a
 * break-glass code to enrol their first security key and then enrols a second.
 * That is the only bootstrap path, and it is the same path used to recover an
 * account that has lost every key.
 *
 * Like the other scripts here it speaks SQL directly rather than through the
 * generated client, so it runs from a checkout without a build step.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { config as loadDotenv } from "dotenv";
import pg from "pg";

import {
  assertBreakGlassIssuable,
  normalizeAdminUserId,
  normalizeRequiredOption,
  resolveAdminStatusTransition,
  resolveBreakGlassTtl
} from "./admin-account-options.mjs";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
loadDotenv({ path: `${workspaceDirectory}/.env`, override: false, quiet: true });

const BREAK_GLASS_PURPOSE = "printing-kiosk/admin-break-glass/v1";
const ROLES = ["OPERATOR", "ADMIN", "TECHNICAL_ADMIN"];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    role: { type: "string" },
    "admin-user": { type: "string" },
    label: { type: "string" },
    "expires-days": { type: "string" }
  }
});

const command = positionals[0];
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is required.");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  switch (command) {
    case "create":
      await create();
      break;
    case "break-glass":
      await issueBreakGlass();
      break;
    case "revoke-break-glass":
      await revokeBreakGlass();
      break;
    case "list":
      await list();
      break;
    case "suspend":
      await setStatus("SUSPENDED");
      break;
    case "resume":
      await setStatus("ACTIVE");
      break;
    case "disable":
      await setStatus("DISABLED");
      break;
    default:
      fail(
        "Usage: admin-account.mjs " +
          "<create|break-glass|revoke-break-glass|list|suspend|resume|disable> [options]"
      );
  }
} finally {
  await client.end();
}

async function create() {
  const name = validated(() => normalizeRequiredOption(values.name, "--name", 120));
  const role = values.role;
  if (!role || !ROLES.includes(role)) fail(`--role must be one of ${ROLES.join(", ")}.`);

  const id = randomUUID();
  await client.query(
    `INSERT INTO "admin_users" ("id", "user_handle", "display_name", "role", "status")
     VALUES ($1, $2, $3, $4, 'PROVISIONING')`,
    // 32 random bytes. Opaque and stable: never an email address, so a stolen
    // authenticator database reveals no identities.
    [id, randomBytes(32), name, role]
  );

  process.stdout.write(
    [
      `Created ${role} account for ${name}.`,
      `  admin user id: ${id}`,
      "",
      "The account is PROVISIONING and cannot sign in yet.",
      "Issue two one-time bootstrap codes, one for each initial security key:",
      "",
      `  pnpm db:admin break-glass --admin-user ${id} --label "initial key A"`,
      `  pnpm db:admin break-glass --admin-user ${id} --label "initial key B"`,
      "",
      "Each code authorises exactly one enrolment. The account activates only",
      "after both keys are enrolled; it cannot sign in between them.",
      "After activation, issue fresh codes for the sealed recovery envelopes.",
      ""
    ].join("\n")
  );
}

async function issueBreakGlass() {
  const adminUserId = validated(() => normalizeAdminUserId(values["admin-user"]));
  const label = validated(() => normalizeRequiredOption(values.label, "--label", 80));
  const pepper = process.env.ADMIN_BREAK_GLASS_PEPPER;
  if (!pepper || pepper.length < 32) {
    fail("ADMIN_BREAK_GLASS_PEPPER must be set to the value the API uses.");
  }

  const ttl = validated(() =>
    resolveBreakGlassTtl({
      expiresDays: values["expires-days"],
      configuredHours: process.env.ADMIN_BREAK_GLASS_TTL_HOURS
    })
  );

  // 256 bits. There is no rate at which this is guessable, which is why a
  // peppered digest rather than a slow hash is the right storage for it.
  const secret = randomBytes(32).toString("base64url");
  const secretDigest = createHmac("sha256", pepper)
    .update(BREAK_GLASS_PURPOSE, "utf8")
    .update("\0", "utf8")
    .update(secret, "utf8")
    .digest("hex");

  let user;
  await client.query("BEGIN");
  try {
    const found = await client.query(
      `SELECT "display_name", "role", "status"
       FROM "admin_users"
       WHERE "id" = $1::uuid
       FOR UPDATE`,
      [adminUserId]
    );
    if (found.rowCount !== 1) throw new Error("No such admin account.");
    user = found.rows[0];
    assertBreakGlassIssuable(user.status);

    await client.query(
      `INSERT INTO "admin_break_glass_credentials"
         ("id", "admin_user_id", "label", "secret_digest", "expires_at")
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), adminUserId, label, secretDigest, new Date(Date.now() + ttl.hours * 3_600_000)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    fail(error instanceof Error ? error.message : "Could not issue a recovery code.");
  }

  process.stdout.write(
    [
      "",
      "  RECOVERY CODE — shown once, never stored, never recoverable",
      "",
      `  ${secret}`,
      "",
      `  account : ${user.display_name} (${user.role})`,
      `  label   : ${label}`,
      `  expires : ${ttl.display}`,
      "",
      "  Print it, seal it, store it offline. Do not save it to a file, a",
      "  password manager, or a chat message.",
      "",
      "  It authorises one security-key enrolment on this account and nothing",
      "  else. It does not sign anyone in, carries no capability, and is burned",
      "  on first use whether or not the enrolment succeeds.",
      ""
    ].join("\n")
  );
}

/**
 * Retire every unused recovery credential for one account.
 *
 * Used when an envelope is opened, photographed, or simply cannot be accounted
 * for. A consumed credential is already spent and is left alone, so this cannot
 * rewrite the record of a recovery that actually happened.
 */
async function revokeBreakGlass() {
  const adminUserId = validated(() => normalizeAdminUserId(values["admin-user"]));

  const result = await client.query(
    `UPDATE "admin_break_glass_credentials"
     SET "revoked_at" = now()
     WHERE "admin_user_id" = $1::uuid
       AND "consumed_at" IS NULL
       AND "revoked_at" IS NULL`,
    [adminUserId]
  );

  process.stdout.write(
    result.rowCount === 0
      ? "No unused recovery credentials for that account.\n"
      : `Revoked ${result.rowCount} unused recovery credential(s). Issue a replacement.\n`
  );
}

async function list() {
  const result = await client.query(
    `SELECT u."id", u."status", u."role", u."display_name",
            count(a."id") FILTER (WHERE a."revoked_at" IS NULL) AS "usable_keys"
     FROM "admin_users" u
     LEFT JOIN "admin_authenticators" a ON a."admin_user_id" = u."id"
     GROUP BY u."id"
     ORDER BY u."created_at" ASC`
  );

  for (const row of result.rows) {
    process.stdout.write(
      `${row.id}  ${row.status.padEnd(12)} ${row.role.padEnd(16)} ` +
        `keys=${row.usable_keys}  ${row.display_name}\n`
    );
  }
  if (result.rowCount === 0) process.stdout.write("No admin accounts exist.\n");
}

async function setStatus(status) {
  const adminUserId = validated(() => normalizeAdminUserId(values["admin-user"]));
  let changed = false;

  await client.query("BEGIN");
  try {
    const found = await client.query(
      `SELECT "status", "activated_at"
       FROM "admin_users"
       WHERE "id" = $1::uuid
       FOR UPDATE`,
      [adminUserId]
    );
    if (found.rowCount !== 1) throw new Error("No such admin account.");
    const current = found.rows[0];
    const transition = resolveAdminStatusTransition(current.status, status, current.activated_at);

    if (!transition.shouldUpdate) {
      await client.query("COMMIT");
      process.stdout.write(`Account ${adminUserId} is already ${status}; no changes made.\n`);
      return;
    }

    const updated = await client.query(
      `UPDATE "admin_users"
       SET "status" = $2::varchar,
           "suspended_at" =
             CASE WHEN $2::varchar = 'SUSPENDED' THEN now() ELSE "suspended_at" END,
           "disabled_at" =
             CASE WHEN $2::varchar = 'DISABLED' THEN now() ELSE "disabled_at" END,
           "updated_at" = now()
       WHERE "id" = $1::uuid
         AND "status" = $3::varchar`,
      [adminUserId, status, current.status]
    );
    if (updated.rowCount !== 1) throw new Error("The account status changed concurrently.");

    // Suspension takes effect now, not when the session happens to expire.
    if (status !== "ACTIVE") {
      await client.query(
        `UPDATE "admin_sessions"
         SET "revoked_at" = now(), "revoked_reason" = $2
         WHERE "admin_user_id" = $1 AND "revoked_at" IS NULL`,
        [adminUserId, `ACCOUNT_${status}`]
      );
    }
    await client.query("COMMIT");
    changed = true;
  } catch (error) {
    await client.query("ROLLBACK");
    fail(error instanceof Error ? error.message : "Could not update the account.");
  }

  if (changed)
    process.stdout.write(
      status === "ACTIVE"
        ? `Account ${adminUserId} is now ACTIVE; previously revoked sessions remain revoked.\n`
        : `Account ${adminUserId} is now ${status}; sessions revoked.\n`
    );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function validated(operation) {
  try {
    return operation();
  } catch (error) {
    fail(error instanceof Error ? error.message : "Invalid command options.");
  }
}
