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
    case "disable":
      await setStatus("DISABLED");
      break;
    default:
      fail(
        "Usage: admin-account.mjs " +
          "<create|break-glass|revoke-break-glass|list|suspend|disable> [options]"
      );
  }
} finally {
  await client.end();
}

async function create() {
  const name = values.name;
  const role = values.role;
  if (!name) fail("--name is required.");
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
      "Issue a break-glass code so they can enrol their first security key:",
      "",
      `  pnpm db:admin break-glass --admin-user ${id} --label "initial enrolment"`,
      "",
      "They must enrol two keys before the account activates.",
      ""
    ].join("\n")
  );
}

async function issueBreakGlass() {
  const adminUserId = values["admin-user"];
  const label = values.label;
  const pepper = process.env.ADMIN_BREAK_GLASS_PEPPER;
  if (!adminUserId) fail("--admin-user is required.");
  if (!label) fail("--label is required, so a sealed envelope can be identified.");
  if (!pepper || pepper.length < 32) {
    fail("ADMIN_BREAK_GLASS_PEPPER must be set to the value the API uses.");
  }

  const found = await client.query(
    `SELECT "display_name", "role" FROM "admin_users" WHERE "id" = $1`,
    [adminUserId]
  );
  if (found.rowCount !== 1) fail("No such admin account.");
  const user = found.rows[0];

  const expiresDays = Number(values["expires-days"] ?? 90);
  if (!Number.isSafeInteger(expiresDays) || expiresDays < 1 || expiresDays > 365) {
    fail("--expires-days must be between 1 and 365.");
  }

  // 256 bits. There is no rate at which this is guessable, which is why a
  // peppered digest rather than a slow hash is the right storage for it.
  const secret = randomBytes(32).toString("base64url");
  const secretDigest = createHmac("sha256", pepper)
    .update(BREAK_GLASS_PURPOSE, "utf8")
    .update("\0", "utf8")
    .update(secret, "utf8")
    .digest("hex");

  await client.query(
    `INSERT INTO "admin_break_glass_credentials"
       ("id", "admin_user_id", "label", "secret_digest", "expires_at")
     VALUES ($1, $2, $3, $4, $5)`,
    [
      randomUUID(),
      adminUserId,
      label,
      secretDigest,
      new Date(Date.now() + expiresDays * 86_400_000)
    ]
  );

  process.stdout.write(
    [
      "",
      "  RECOVERY CODE — shown once, never stored, never recoverable",
      "",
      `  ${secret}`,
      "",
      `  account : ${user.display_name} (${user.role})`,
      `  label   : ${label}`,
      `  expires : ${expiresDays} days`,
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
  const adminUserId = values["admin-user"];
  if (!adminUserId) fail("--admin-user is required.");

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
  const adminUserId = values["admin-user"];
  if (!adminUserId) fail("--admin-user is required.");

  await client.query("BEGIN");
  try {
    const updated = await client.query(
      `UPDATE "admin_users"
       SET "status" = $2::varchar,
           "suspended_at" =
             CASE WHEN $2::varchar = 'SUSPENDED' THEN now() ELSE "suspended_at" END,
           "disabled_at" =
             CASE WHEN $2::varchar = 'DISABLED' THEN now() ELSE "disabled_at" END,
           "updated_at" = now()
       WHERE "id" = $1::uuid`,
      [adminUserId, status]
    );
    if (updated.rowCount !== 1) throw new Error("No such admin account.");

    // Suspension takes effect now, not when the session happens to expire.
    await client.query(
      `UPDATE "admin_sessions"
       SET "revoked_at" = now(), "revoked_reason" = $2
       WHERE "admin_user_id" = $1 AND "revoked_at" IS NULL`,
      [adminUserId, `ACCOUNT_${status}`]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    fail(error instanceof Error ? error.message : "Could not update the account.");
  }

  process.stdout.write(`Account ${adminUserId} is now ${status}; sessions revoked.\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
