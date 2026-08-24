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
 *   node scripts/admin-account.mjs bootstrap-technical-admin --name "Ada" --username ada
 *   node scripts/admin-account.mjs create --name "Ada" --username ada --role OPERATOR
 *   node scripts/admin-account.mjs invite --admin-user <uuid>
 *   node scripts/admin-account.mjs reset-password --admin-user <uuid>
 *   node scripts/admin-account.mjs break-glass --admin-user <uuid> --label "safe A"
 *   node scripts/admin-account.mjs set-username --admin-user <uuid> --username ada
 *   node scripts/admin-account.mjs list
 *   node scripts/admin-account.mjs suspend --admin-user <uuid>
 *   node scripts/admin-account.mjs resume --admin-user <uuid>
 *
 * A created account is PROVISIONING and can do nothing until the person
 * accepts an invitation: sets their password and, for privileged roles, enrols
 * a security key. `bootstrap-technical-admin` is `create` + `invite` for the
 * first Technical Administrator, and refuses to run while a working Technical
 * Admin exists — day-to-day accounts are invited from the dashboard, and this
 * must not become the alternative registration path.
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
// Must match `services/api/src/modules/admin/crypto.ts` byte for byte: the API
// is what redeems these codes.
const INVITATION_PURPOSE = "printing-kiosk/admin-invitation/v1";
const PASSWORD_RESET_PURPOSE = "printing-kiosk/admin-password-reset/v1";
const ROLES = ["OPERATOR", "ADMIN", "TECHNICAL_ADMIN"];
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/u;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    username: { type: "string" },
    role: { type: "string" },
    "admin-user": { type: "string" },
    label: { type: "string" },
    "expires-days": { type: "string" },
    force: { type: "boolean" }
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
    case "bootstrap-technical-admin":
      await bootstrapTechnicalAdmin();
      break;
    case "invite":
      await invite();
      break;
    case "reset-password":
      await resetPassword();
      break;
    case "set-username":
      await setUsername();
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
          "<create|bootstrap-technical-admin|invite|reset-password|set-username|" +
          "break-glass|revoke-break-glass|list|suspend|resume|disable> [options]"
      );
  }
} finally {
  await client.end();
}

function normalizeUsername(value) {
  const username = (value ?? "").trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      "--username must be 3-32 characters: lowercase letters, digits, and . _ - between them."
    );
  }
  return username;
}

function oneTimeGrantPepper() {
  const pepper = process.env.ADMIN_BREAK_GLASS_PEPPER;
  if (!pepper || pepper.length < 32) {
    fail("ADMIN_BREAK_GLASS_PEPPER must be set to the value the API uses.");
  }
  return pepper;
}

function digestOneTimeCode(purpose, secret, pepper) {
  return createHmac("sha256", pepper)
    .update(purpose, "utf8")
    .update("\0", "utf8")
    .update(secret, "utf8")
    .digest("hex");
}

/** CLI acts are audited like panel acts, under their own actor type. */
async function writeCliAuditEvent(action, metadata) {
  await client.query(
    `INSERT INTO "audit_events" ("id", "actor_type", "actor_id", "action", "outcome", "metadata")
     VALUES ($1, 'ADMIN_CLI', 'cli', $2, 'SUCCESS', $3::jsonb)`,
    [randomUUID(), action, JSON.stringify(metadata)]
  );
}

async function createProvisioningAccount(name, username, role) {
  const id = randomUUID();
  try {
    await client.query(
      `INSERT INTO "admin_users" ("id", "user_handle", "username", "display_name", "role", "status")
       VALUES ($1, $2, $3, $4, $5, 'PROVISIONING')`,
      // 32 random bytes. Opaque and stable: never an email address, so a stolen
      // authenticator database reveals no identities.
      [id, randomBytes(32), username, name, role]
    );
  } catch (error) {
    if (error && error.code === "23505") fail(`The username "${username}" is already in use.`);
    throw error;
  }
  return id;
}

/**
 * Issue (or replace) the invitation for a PROVISIONING account and print the
 * code. The database keeps only a digest; losing the printed code means
 * running this again.
 */
async function issueInvitationFor(adminUserId, { quiet = false } = {}) {
  const pepper = oneTimeGrantPepper();
  const ttlHours = Number(process.env.ADMIN_INVITATION_TTL_HOURS ?? "72");
  if (!Number.isInteger(ttlHours) || ttlHours < 1) {
    fail("ADMIN_INVITATION_TTL_HOURS must be a positive whole number of hours.");
  }

  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  let user;

  await client.query("BEGIN");
  try {
    const found = await client.query(
      `SELECT "display_name", "username", "role", "status"
       FROM "admin_users" WHERE "id" = $1::uuid FOR UPDATE`,
      [adminUserId]
    );
    if (found.rowCount !== 1) throw new Error("No such admin account.");
    user = found.rows[0];
    if (user.status !== "PROVISIONING") {
      throw new Error(
        "Only a PROVISIONING account can be invited. An active account that lost " +
          "its password needs `reset-password` instead."
      );
    }

    await client.query(
      `UPDATE "admin_invitations" SET "revoked_at" = now()
       WHERE "admin_user_id" = $1::uuid AND "consumed_at" IS NULL AND "revoked_at" IS NULL`,
      [adminUserId]
    );
    await client.query(
      `INSERT INTO "admin_invitations"
         ("id", "admin_user_id", "secret_digest", "reason", "expires_at")
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        adminUserId,
        digestOneTimeCode(INVITATION_PURPOSE, secret, pepper),
        "Issued from the account CLI.",
        expiresAt
      ]
    );
    await writeCliAuditEvent("admin.invitation.create", {
      targetAdminUserId: adminUserId,
      targetRole: user.role,
      invitationExpiresAt: expiresAt.toISOString()
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    fail(error instanceof Error ? error.message : "Could not issue an invitation.");
  }

  if (!quiet) {
    process.stdout.write(
      [
        "",
        "  INVITATION CODE — shown once, never stored, never recoverable",
        "",
        `  ${secret}`,
        "",
        `  account : ${user.display_name} (${user.role})`,
        `  username: ${user.username}`,
        `  expires : ${expiresAt.toISOString()}`,
        "",
        "  Hand it to the person securely. On the dashboard sign-in screen they",
        '  choose "I have an invitation code", set their password, and — for',
        "  privileged roles — enrol a security key. The code dies when the",
        "  account activates, when it expires, or when a new one is issued.",
        ""
      ].join("\n")
    );
  }
  return secret;
}

async function bootstrapTechnicalAdmin() {
  const name = validated(() => normalizeRequiredOption(values.name, "--name", 120));
  const username = validated(() => normalizeUsername(values.username));

  // The bootstrap exists for an empty system. Once a Technical Admin can sign
  // in — or is one accepted invitation away from it — new accounts come from
  // the dashboard, where an authorized person creates them behind a step-up
  // ceremony and an audit trail.
  const existing = await client.query(
    `SELECT count(*)::int AS "count" FROM "admin_users"
     WHERE "role" = 'TECHNICAL_ADMIN' AND "status" IN ('PROVISIONING', 'ACTIVE')`
  );
  if (existing.rows[0].count > 0 && !values.force) {
    fail(
      "A Technical Admin already exists. Invite further accounts from the dashboard\n" +
        "(People section), or pass --force if every Technical Admin is truly\n" +
        "unrecoverable and this is a deliberate re-bootstrap."
    );
  }

  const id = await createProvisioningAccount(name, username, "TECHNICAL_ADMIN");
  process.stdout.write(`Created TECHNICAL_ADMIN account for ${name} (${username}): ${id}\n`);
  await issueInvitationFor(id);
}

async function invite() {
  const adminUserId = validated(() => normalizeAdminUserId(values["admin-user"]));
  await issueInvitationFor(adminUserId);
}

async function resetPassword() {
  const adminUserId = validated(() => normalizeAdminUserId(values["admin-user"]));
  const pepper = oneTimeGrantPepper();
  const ttlMinutes = Number(process.env.ADMIN_PASSWORD_RESET_TTL_MINUTES ?? "60");
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 5) {
    fail("ADMIN_PASSWORD_RESET_TTL_MINUTES must be at least 5.");
  }

  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  let user;

  await client.query("BEGIN");
  try {
    const found = await client.query(
      `SELECT "display_name", "username", "role", "status"
       FROM "admin_users" WHERE "id" = $1::uuid FOR UPDATE`,
      [adminUserId]
    );
    if (found.rowCount !== 1) throw new Error("No such admin account.");
    user = found.rows[0];
    if (user.status !== "ACTIVE") {
      throw new Error(
        "Only an ACTIVE account's password can be reset. A PROVISIONING account " +
          "needs `invite`; a suspended one needs `resume` first."
      );
    }

    await client.query(
      `UPDATE "admin_password_resets" SET "revoked_at" = now()
       WHERE "admin_user_id" = $1::uuid AND "consumed_at" IS NULL AND "revoked_at" IS NULL`,
      [adminUserId]
    );
    await client.query(
      `INSERT INTO "admin_password_resets"
         ("id", "admin_user_id", "secret_digest", "reason", "expires_at")
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        adminUserId,
        digestOneTimeCode(PASSWORD_RESET_PURPOSE, secret, pepper),
        "Issued from the account CLI.",
        expiresAt
      ]
    );
    await writeCliAuditEvent("admin.password_reset.issue", {
      targetAdminUserId: adminUserId,
      targetRole: user.role,
      resetExpiresAt: expiresAt.toISOString()
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    fail(error instanceof Error ? error.message : "Could not issue a reset code.");
  }

  process.stdout.write(
    [
      "",
      "  PASSWORD RESET CODE — shown once, never stored, never recoverable",
      "",
      `  ${secret}`,
      "",
      `  account : ${user.display_name} (${user.role})`,
      `  username: ${user.username}`,
      `  expires : ${expiresAt.toISOString()}`,
      "",
      '  On the sign-in screen the person chooses "I have a reset code" and',
      "  sets a new password. Completing it signs the account out everywhere.",
      "  WebAuthn keys are untouched: a privileged sign-in still needs theirs.",
      ""
    ].join("\n")
  );
}

async function setUsername() {
  const adminUserId = validated(() => normalizeAdminUserId(values["admin-user"]));
  const username = validated(() => normalizeUsername(values.username));
  try {
    const updated = await client.query(
      `UPDATE "admin_users" SET "username" = $2, "updated_at" = now() WHERE "id" = $1::uuid`,
      [adminUserId, username]
    );
    if (updated.rowCount !== 1) fail("No such admin account.");
  } catch (error) {
    if (error && error.code === "23505") fail(`The username "${username}" is already in use.`);
    throw error;
  }
  process.stdout.write(`Account ${adminUserId} now signs in as "${username}".\n`);
}

async function create() {
  const name = validated(() => normalizeRequiredOption(values.name, "--name", 120));
  const username = validated(() => normalizeUsername(values.username));
  const role = values.role;
  if (!role || !ROLES.includes(role)) fail(`--role must be one of ${ROLES.join(", ")}.`);

  const id = await createProvisioningAccount(name, username, role);

  process.stdout.write(
    [
      `Created ${role} account for ${name} (${username}).`,
      `  admin user id: ${id}`,
      "",
      "The account is PROVISIONING and cannot sign in yet. Hand it over with:",
      "",
      `  pnpm db:admin invite --admin-user ${id}`,
      "",
      "(Ordinary accounts are better invited from the dashboard's People",
      "section, which records who authorised them.)",
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
    `SELECT u."id", u."status", u."role", u."username", u."display_name",
            count(a."id") FILTER (WHERE a."revoked_at" IS NULL) AS "usable_keys",
            (p."admin_user_id" IS NOT NULL) AS "has_password"
     FROM "admin_users" u
     LEFT JOIN "admin_authenticators" a ON a."admin_user_id" = u."id"
     LEFT JOIN "admin_passwords" p ON p."admin_user_id" = u."id"
     GROUP BY u."id", p."admin_user_id"
     ORDER BY u."created_at" ASC`
  );

  for (const row of result.rows) {
    process.stdout.write(
      `${row.id}  ${row.status.padEnd(12)} ${row.role.padEnd(16)} ` +
        `${String(row.username).padEnd(20)} password=${row.has_password ? "yes" : "no "} ` +
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
