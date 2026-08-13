#!/usr/bin/env node
/**
 * Take the control plane's evidence out of the application's hands.
 *
 * `audit_events` has been append-only since Phase 2, enforced by triggers that
 * refuse UPDATE and DELETE. The triggers work. The hole is one level up: the
 * application role *owns* the table, and a table's owner can
 * `ALTER TABLE ... DISABLE TRIGGER ALL` and then rewrite whatever it likes. So
 * an attacker who reaches the application's database credential can erase the
 * record of having done so, and every REVOKE aimed at that role is ineffective
 * because an owner's rights come from ownership rather than from a grant.
 *
 * This moves ownership of the audit log and the admin identity tables to a role
 * that only migrations use, and leaves the application role with exactly the
 * DML it needs: INSERT and SELECT on the audit log, ordinary CRUD on the admin
 * tables it manages. After that the append-only guarantee no longer depends on
 * a trigger the credential-holder could switch off.
 *
 * Usage:
 *
 *   ADMIN_OWNER_DATABASE_PASSWORD=... node scripts/admin-owner.mjs provision
 *   node scripts/admin-owner.mjs verify
 *
 * `provision` must be run by a connection that can create roles and reassign
 * ownership — the application role while it still owns these tables, or a
 * superuser. Afterwards, **a migration that alters an owned table must run as
 * this role**: point `DATABASE_URL` at `ADMIN_OWNER_DATABASE_URL` for
 * `prisma migrate deploy`, or use `pnpm db:migrate:owner`. Migrations that
 * touch only product tables are unaffected.
 *
 * The role is a member of the application role, so it can still alter tables
 * the application owns. That direction is fine and the other one is the point:
 * the migrator can do everything the application can, and the application
 * cannot do what the migrator can.
 */

import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { config as loadDotenv } from "dotenv";
import pg from "pg";

import { quoteIdentifier, quoteLiteral } from "./sql-identifiers.mjs";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
loadDotenv({ path: `${workspaceDirectory}/.env`, override: false, quiet: true });

/** The role that owns the control plane's evidence and runs its migrations. */
const ADMIN_OWNER_ROLE = "printing_kiosk_migrator";

/**
 * The tables whose ownership moves, and what the application keeps on each.
 *
 * Two groups, for two different reasons.
 *
 * `audit_events` is evidence. The application writes to it constantly and must
 * never change or remove a row, so it keeps INSERT and SELECT and loses
 * everything else — this time for real, because after the transfer the REVOKE
 * is not overridden by ownership.
 *
 * The `admin_*` tables are the control plane's identity. The application does
 * manage them — it creates sessions, bumps signature counters, consumes
 * challenges — so it keeps ordinary CRUD. What it loses is the ability to drop
 * them, alter them, or disable the triggers that enforce their invariants:
 * that a privileged account cannot fall below two authenticators, that a
 * credential identifier cannot be rewritten, that an account's identity is
 * immutable. Those are the rules that decide who can sign in to the panel at
 * all.
 *
 * Deliberately not here: `print_job_recovery_resolutions`, the Phase 4 tables
 * beside it, and every product table. Moving those is a bigger change than
 * this one — the integration teardown owns the resolutions table specifically
 * so it can suspend the append-only triggers — and it is a decision for
 * whoever takes it, not a side effect of this one. See ADMIN_PHASE_4_STATUS.md.
 */
const OWNED_TABLES = Object.freeze({
  audit_events: ["SELECT", "INSERT"],
  admin_users: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  admin_authenticators: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  admin_sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  admin_webauthn_challenges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  admin_break_glass_credentials: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  admin_kiosk_scopes: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  // Phase 4B. Redemption runs on the application connection — matching a
  // presented code against a stored digest, and marking the ticket consumed —
  // so the application keeps ordinary CRUD here. What it loses, as everywhere
  // else in this list, is the ability to drop the table or switch off the
  // trigger that makes a ticket single-use and refuses to let one name a
  // working account.
  admin_enrollment_tickets: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  // Phase 5. The application never writes either of these — proposing and
  // approving are the change and pricing roles' work — but it keeps the same
  // DML as the other admin tables so an integration teardown can clear them.
  // What it loses, as with the rest, is the ability to drop them or to switch
  // off the triggers enforcing who may approve what.
  admin_change_executions: ["SELECT", "INSERT", "UPDATE", "DELETE"]
});

const ALL_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER"
];

const { positionals } = parseArgs({ allowPositionals: true, options: {} });
const command = positionals[0];

const databaseUrl = process.env.ADMIN_OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is required.");

/**
 * The role the application connects as, taken from the connection string rather
 * than hard-coded: a deployment that renamed it should still be able to run
 * this, and getting it wrong would revoke privileges from the wrong role.
 */
const applicationRole = new URL(process.env.DATABASE_URL ?? databaseUrl).username;
if (!applicationRole) fail("DATABASE_URL must name the role the application connects as.");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

let failures = 0;

try {
  switch (command) {
    case "provision":
      await provision();
      break;
    case "verify":
      await verify();
      break;
    default:
      fail("Usage: admin-owner.mjs <provision|verify>");
  }
} finally {
  await client.end();
}

if (failures > 0) process.exit(1);

async function provision() {
  const password = process.env.ADMIN_OWNER_DATABASE_PASSWORD;
  if (!password || password.length < 24) {
    fail(
      "ADMIN_OWNER_DATABASE_PASSWORD must be set to at least 24 characters.\n" +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
    );
  }

  const existingTables = await listTables();
  const missing = Object.keys(OWNED_TABLES).filter((table) => !existingTables.includes(table));
  if (missing.length > 0) {
    fail(
      `These tables do not exist yet: ${missing.join(", ")}.\n` +
        "Run `pnpm db:migrate` before provisioning the owner role."
    );
  }

  const databaseName = (await client.query("SELECT current_database() AS name")).rows[0].name;
  const ownerLiteral = quoteIdentifier(ADMIN_OWNER_ROLE);
  const applicationLiteral = quoteIdentifier(applicationRole);

  await client.query("BEGIN");
  try {
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
      ADMIN_OWNER_ROLE
    ]);
    if (exists.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${ownerLiteral} LOGIN PASSWORD ${quoteLiteral(password)} ` +
          "NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS"
      );
    } else {
      await client.query(`ALTER ROLE ${ownerLiteral} LOGIN PASSWORD ${quoteLiteral(password)}`);
    }

    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${ownerLiteral}`
    );
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${ownerLiteral}`);

    // So a migration run as this role can still alter tables the application
    // owns. The migrator being able to do everything the application can is
    // not the risk; the application being able to do what the migrator can is.
    await client.query(`GRANT ${applicationLiteral} TO ${ownerLiteral}`);

    // The migration ledger stays with the application, so an ordinary migration
    // that touches only product tables still runs on the ordinary connection.
    await client.query(`GRANT ALL ON public."_prisma_migrations" TO ${ownerLiteral}`);

    for (const [table, privileges] of Object.entries(OWNED_TABLES)) {
      const target = `public.${quoteIdentifier(table)}`;
      await client.query(`ALTER TABLE ${target} OWNER TO ${ownerLiteral}`);
      // Ownership carried the application's rights until a moment ago. Grant
      // back exactly what it needs, which for the audit log is not everything.
      await client.query(`REVOKE ALL ON ${target} FROM ${applicationLiteral}`);
      await client.query(`GRANT ${privileges.join(", ")} ON ${target} TO ${applicationLiteral}`);
    }

    // A table a future migration creates as this role must not leave the
    // application without the grants the product needs to run. The restriction
    // here is about DDL, not about the application's ordinary work.
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerLiteral} IN SCHEMA public ` +
        `GRANT ALL ON TABLES TO ${applicationLiteral}`
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    fail(error instanceof Error ? error.message : "Could not provision the owner role.");
  }

  process.stdout.write(
    [
      `Provisioned ${ADMIN_OWNER_ROLE}.`,
      `  now owns   : ${Object.keys(OWNED_TABLES).join(", ")}`,
      `  ${applicationRole} keeps INSERT and SELECT on audit_events, and no more.`,
      "",
      "Set ADMIN_OWNER_DATABASE_URL to this role and password. A migration that",
      "alters one of the tables above must now run as it: `pnpm db:migrate:owner`.",
      "",
      "The other three admin roles held grants issued by the previous owner.",
      "Re-provision and re-verify all of them now:",
      "  pnpm db:admin-reader provision && pnpm db:admin-reader verify",
      "  pnpm db:admin-writer provision && pnpm db:admin-writer verify",
      "  pnpm db:admin-refund-writer provision && pnpm db:admin-refund-writer verify",
      "",
      "Then confirm the result with: pnpm db:admin-owner verify",
      ""
    ].join("\n")
  );
}

async function verify() {
  const exists = await client.query("SELECT rolsuper FROM pg_roles WHERE rolname = $1", [
    ADMIN_OWNER_ROLE
  ]);
  if (exists.rowCount === 0) {
    fail(`Role ${ADMIN_OWNER_ROLE} does not exist. Run: pnpm db:admin-owner provision`);
  }
  if (exists.rows[0].rolsuper) report(`${ADMIN_OWNER_ROLE} is a superuser`);

  // The check that decides whether any of this means anything.
  //
  // A superuser bypasses every privilege check there is, so if the application
  // connects as one, it can still take these tables back, disable their
  // triggers and rewrite the audit log — and the ownership transfer is
  // decorative. This is exactly the case in the development compose file, where
  // the application role is the cluster's bootstrap superuser, so this is
  // reported as a finding rather than assumed away.
  const application = await client.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [applicationRole]
  );
  if (application.rowCount === 0) {
    fail(`The application role ${applicationRole} does not exist.`);
  }
  const applicationIsSuperuser = application.rows[0].rolsuper === true;
  if (applicationIsSuperuser) {
    report(
      `${applicationRole} is a SUPERUSER, so it can retake ownership of these tables and ` +
        "disable their triggers at will. Ownership separation is ineffective until the " +
        "application connects as an ordinary role. (The development compose file runs the " +
        "application as the cluster's bootstrap superuser, so this is expected there and " +
        "must not be true in production.)"
    );
  }
  if (application.rows[0].rolbypassrls) report(`${applicationRole} holds BYPASSRLS`);

  const existingTables = await listTables();
  for (const [table, privileges] of Object.entries(OWNED_TABLES)) {
    if (!existingTables.includes(table)) {
      report(`${table}: does not exist`);
      continue;
    }

    const owner = (
      await client.query(
        "SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
        [table]
      )
    ).rows[0].tableowner;

    if (owner !== ADMIN_OWNER_ROLE) {
      report(`${table}: owned by ${owner}, expected ${ADMIN_OWNER_ROLE}`);
    }

    // A superuser passes `has_table_privilege` for everything, so asking it
    // about one would produce a page of findings that all say the same thing
    // the report above already said. Ownership and trigger state are still
    // worth checking: those are facts about the schema rather than about what
    // this particular role could talk its way into.
    if (applicationIsSuperuser) continue;

    const allowed = new Set(privileges);
    for (const privilege of ALL_PRIVILEGES) {
      const held = await hasTablePrivilege(applicationRole, table, privilege);
      if (allowed.has(privilege) && !held) {
        report(`${table}: ${applicationRole} lacks ${privilege}, which the product needs`);
      }
      if (!allowed.has(privilege) && held) {
        report(`${table}: ${applicationRole} holds ${privilege} and must not`);
      }
    }
  }

  // The triggers are still the mechanism; ownership is what stops them being
  // switched off. Both have to be true, so both are checked.
  const disabled = await client.query(
    `SELECT c.relname AS table_name, t.tgname AS trigger_name
       FROM pg_trigger AS t
       JOIN pg_class AS c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND t.tgenabled = 'D'
        AND c.relname = ANY($1::text[])`,
    [Object.keys(OWNED_TABLES)]
  );
  for (const row of disabled.rows) {
    report(`${row.table_name}: trigger ${row.trigger_name} is DISABLED`);
  }

  process.stdout.write(
    failures === 0
      ? `${ADMIN_OWNER_ROLE}: owns the audit log and the admin identity tables. ` +
          `${applicationRole} can append to the audit log and cannot rewrite it.\n`
      : `\n${failures} problem(s). The audit log's immutability is not fully enforced.\n`
  );
}

async function listTables() {
  const result = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  return result.rows.map((row) => row.tablename);
}

async function hasTablePrivilege(role, table, privilege) {
  const result = await client.query("SELECT has_table_privilege($1, $2, $3) AS held", [
    role,
    `public.${table}`,
    privilege
  ]);
  return result.rows[0].held === true;
}

function report(message) {
  failures += 1;
  process.stderr.write(`  FAIL  ${message}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
