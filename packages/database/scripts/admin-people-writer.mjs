#!/usr/bin/env node
/**
 * Provision and verify the role that administers people.
 *
 * The three roles before this one share `admin-append-role.mjs`, because each of
 * them is defined by the same sentence: INSERT on a named list, SELECT on a
 * named list, and nothing that changes a row that already exists. This role is
 * the first one that has to change one — a suspension, a revocation, an
 * assignment ended — so it cannot use that runner and does not try to. What it
 * does instead is hold the same argument to a stricter standard:
 *
 *   - UPDATE is held per *column*, never per table, and `verify` walks every
 *     column of every table in the database to prove it.
 *   - DELETE, TRUNCATE, REFERENCES and TRIGGER are held nowhere at all.
 *   - INSERT is held on three tables and refused everywhere else.
 *   - SELECT stops short of every credential, digest and handle.
 *
 * Usage:
 *
 *   ADMIN_PEOPLE_DATABASE_PASSWORD=... node scripts/admin-people-writer.mjs provision
 *   node scripts/admin-people-writer.mjs verify
 *   node scripts/admin-people-writer.mjs disable
 *
 * **This uses two connections, because no single role can do both halves.** The
 * tables it grants on — `admin_users`, `admin_authenticators`, `admin_sessions`,
 * `admin_kiosk_scopes`, `admin_enrollment_tickets` — have been owned by
 * `printing_kiosk_migrator` since Phase 4, and only an owner may grant on what
 * it owns. But that role is deliberately `NOCREATEROLE`: it exists to hold
 * ownership of the audit log, and a role-creating migrator would be a second
 * path to manufacturing a privileged connection.
 *
 * So role management (`CREATE ROLE`, the password, the connection settings)
 * runs on `DATABASE_URL`, and every `GRANT` and `REVOKE` runs on
 * `ADMIN_OWNER_DATABASE_URL`. The owner is a member of the application role, so
 * it can also revoke grants the application issued on the product tables — which
 * is what keeps `FORBIDDEN_TABLES` enforceable rather than aspirational.
 *
 * In production this means the operator running `provision` needs a connection
 * that can create a role. That is the same requirement `db:admin-owner
 * provision` already has, and it is a one-off: `verify` needs neither.
 */

import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { config as loadDotenv } from "dotenv";
import pg from "pg";

import {
  ADMIN_PEOPLE_WRITER_ROLE,
  FORBIDDEN_TABLES,
  INSERTABLE_TABLES,
  READABLE_TABLES,
  ROLE_SETTINGS,
  UPDATABLE_COLUMNS
} from "./admin-people-writer-matrix.mjs";
import { quoteIdentifier, quoteLiteral } from "./sql-identifiers.mjs";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
loadDotenv({ path: `${workspaceDirectory}/.env`, override: false, quiet: true });

const MATRIX_PATH = "packages/database/scripts/admin-people-writer-matrix.mjs";
const COMMAND = "pnpm db:admin-people-writer";

/**
 * The privileges this role may never hold on anything. UPDATE is absent from
 * the list because it is checked separately and far more precisely: table-level
 * UPDATE is a failure, and column-level UPDATE is a failure everywhere except
 * the exact pairs the matrix names.
 */
const DESTRUCTIVE_PRIVILEGES = ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const ALL_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", ...DESTRUCTIVE_PRIVILEGES];

const { positionals } = parseArgs({ allowPositionals: true, options: {} });
const command = positionals[0];

// Role management: creating the role, setting its password and its connection
// settings. Needs CREATEROLE, which the owner role deliberately does not have.
const roleAdminUrl = process.env.DATABASE_URL;
// Granting: needs to own the admin tables, which the application no longer does.
const grantUrl = process.env.ADMIN_OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!roleAdminUrl || !grantUrl) {
  process.stderr.write("DATABASE_URL is required.\n");
  process.exit(1);
}

const client = new pg.Client({ connectionString: grantUrl });
await client.connect();

const sharesOneConnection = roleAdminUrl === grantUrl;
const roleAdminClient = sharesOneConnection
  ? client
  : new pg.Client({ connectionString: roleAdminUrl });
if (!sharesOneConnection) await roleAdminClient.connect();

let failures = 0;

try {
  switch (command) {
    case "provision":
      await provision();
      break;
    case "verify":
      await verify();
      break;
    case "disable":
      await disable();
      break;
    default:
      process.stderr.write(`Usage: ${COMMAND} <provision|verify|disable>\n`);
      process.exit(1);
  }
} finally {
  await client.end();
  if (!sharesOneConnection) await roleAdminClient.end();
}

if (failures > 0) process.exit(1);

/**
 * Create or update the role so that it matches the matrix exactly.
 *
 * Everything is revoked first, so this synchronises rather than accumulates: a
 * column removed from `UPDATABLE_COLUMNS` actually loses its grant instead of
 * lingering because nobody thought to revoke it.
 */
async function provision() {
  const password = process.env.ADMIN_PEOPLE_DATABASE_PASSWORD;
  if (!password || password.length < 24) {
    fail(
      "ADMIN_PEOPLE_DATABASE_PASSWORD must be set to at least 24 characters.\n" +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
    );
  }

  const existingTables = await listTables();
  assertPolicyMatchesSchema(existingTables);

  const databaseName = (await client.query("SELECT current_database() AS name")).rows[0].name;
  const roleLiteral = quoteIdentifier(ADMIN_PEOPLE_WRITER_ROLE);

  // The role itself, on the connection that can create one. Kept outside the
  // grant transaction below because it is on a different connection and because
  // a role that exists with no grants can do nothing anyway.
  const exists = await roleAdminClient.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    ADMIN_PEOPLE_WRITER_ROLE
  ]);
  if (exists.rowCount === 0) {
    await roleAdminClient.query(
      `CREATE ROLE ${roleLiteral} LOGIN PASSWORD ${quoteLiteral(password)} ` +
        "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
    );
  } else {
    await roleAdminClient.query(
      `ALTER ROLE ${roleLiteral} LOGIN PASSWORD ${quoteLiteral(password)}`
    );
  }

  for (const [setting, value] of Object.entries(ROLE_SETTINGS)) {
    await roleAdminClient.query(
      `ALTER ROLE ${roleLiteral} SET ${quoteIdentifier(setting)} = ${quoteLiteral(value)}`
    );
  }

  await client.query("BEGIN");
  try {
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roleLiteral}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${roleLiteral}`);
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${roleLiteral}`);
    await client.query(
      `REVOKE ALL ON DATABASE ${quoteIdentifier(databaseName)} FROM ${roleLiteral}`
    );

    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${roleLiteral}`
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${roleLiteral}`);

    for (const [table, columns] of Object.entries(READABLE_TABLES)) {
      if (!existingTables.includes(table)) continue;
      const target = `public.${quoteIdentifier(table)}`;
      if (columns === "*") {
        await client.query(`GRANT SELECT ON ${target} TO ${roleLiteral}`);
      } else {
        const columnList = columns.map(quoteIdentifier).join(", ");
        await client.query(`GRANT SELECT (${columnList}) ON ${target} TO ${roleLiteral}`);
      }
    }

    for (const table of Object.keys(INSERTABLE_TABLES)) {
      if (!existingTables.includes(table)) continue;
      await client.query(`GRANT INSERT ON public.${quoteIdentifier(table)} TO ${roleLiteral}`);
    }

    // The grant this role exists for, and the only one in the control plane
    // that can change a row rather than add one. Always column-scoped: a bare
    // `GRANT UPDATE ON admin_users` would hand over `role` along with `status`.
    for (const [table, columns] of Object.entries(UPDATABLE_COLUMNS)) {
      if (!existingTables.includes(table)) continue;
      const columnList = columns.map(quoteIdentifier).join(", ");
      await client.query(
        `GRANT UPDATE (${columnList}) ON public.${quoteIdentifier(table)} TO ${roleLiteral}`
      );
    }

    // A table added by a future migration must not inherit a grant. Default
    // privileges are the one place PostgreSQL would hand one out silently, and
    // they are per grantor — so both the owner of these tables and the
    // application that owns the product ones have to be told.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${roleLiteral}`
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    fail(
      error instanceof Error ? error.message : `Could not provision ${ADMIN_PEOPLE_WRITER_ROLE}.`
    );
  }

  process.stdout.write(
    [
      `Provisioned ${ADMIN_PEOPLE_WRITER_ROLE}.`,
      `  may INSERT into : ${Object.keys(INSERTABLE_TABLES).join(", ")}`,
      ...Object.entries(UPDATABLE_COLUMNS).map(
        ([table, columns]) => `  may UPDATE      : ${table} (${columns.join(", ")})`
      ),
      `  may SELECT from : ${Object.keys(READABLE_TABLES).length} tables`,
      "  may DELETE      : nothing",
      "",
      "It cannot change anybody's role, enrol an authenticator, read a credential",
      "or a session token, or touch any product table.",
      "",
      `Then confirm the result with: ${COMMAND} verify`,
      ""
    ].join("\n")
  );
}

/**
 * Check the live database against the matrix.
 *
 * This is the gate. It answers "what could a compromised admin backend do to an
 * account through this connection" by asking PostgreSQL rather than by reading
 * the application.
 */
async function verify() {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    ADMIN_PEOPLE_WRITER_ROLE
  ]);
  if (exists.rowCount === 0) {
    fail(`Role ${ADMIN_PEOPLE_WRITER_ROLE} does not exist. Run: ${COMMAND} provision`);
  }

  const existingTables = await listTables();
  assertPolicyMatchesSchema(existingTables);

  for (const table of existingTables) {
    for (const privilege of DESTRUCTIVE_PRIVILEGES) {
      if (await hasTablePrivilege(table, privilege)) {
        report(`${table}: role holds ${privilege}; this role may never destroy a row`);
      }
    }

    // Table-level UPDATE is always a failure, including on the tables the
    // matrix names: holding it would mean holding every column, which is the
    // difference between "may suspend an account" and "may promote one".
    if (await hasTablePrivilege(table, "UPDATE")) {
      report(`${table}: role holds table-level UPDATE; UPDATE must be column-scoped`);
    }

    const allowed = new Set(UPDATABLE_COLUMNS[table] ?? []);
    for (const column of await listColumns(table)) {
      const held = await hasColumnPrivilege(table, column, "UPDATE");
      if (held && !allowed.has(column)) {
        report(`${table}.${column}: role can UPDATE a column the policy does not name`);
      }
      if (!held && allowed.has(column)) {
        report(`${table}.${column}: expected UPDATE, role has none`);
      }
    }
  }

  for (const table of Object.keys(INSERTABLE_TABLES)) {
    if (!existingTables.includes(table)) continue;
    if (!(await hasTablePrivilege(table, "INSERT"))) {
      report(`${table}: expected INSERT, role has none`);
    }
  }

  const insertable = new Set(Object.keys(INSERTABLE_TABLES));
  for (const table of existingTables) {
    if (insertable.has(table)) continue;
    if (await hasTablePrivilege(table, "INSERT")) {
      report(`${table}: role holds INSERT on a table it must not write to`);
    }
  }

  for (const [table, columns] of Object.entries(READABLE_TABLES)) {
    if (!existingTables.includes(table)) continue;
    const existingColumns = await listColumns(table);

    if (columns === "*") {
      if (!(await hasTablePrivilege(table, "SELECT"))) {
        report(`${table}: expected SELECT, role has none`);
      }
      continue;
    }

    const allowed = new Set(columns);
    for (const column of columns) {
      if (!existingColumns.includes(column)) {
        report(`${table}: policy allows a column that does not exist: ${column}`);
        continue;
      }
      if (!(await hasColumnPrivilege(table, column, "SELECT"))) {
        report(`${table}.${column}: expected SELECT, role has none`);
      }
    }
    for (const column of existingColumns) {
      if (allowed.has(column)) continue;
      if (await hasColumnPrivilege(table, column, "SELECT")) {
        report(`${table}.${column}: MUST NOT be readable but the role can SELECT it`);
      }
    }
  }

  for (const [table, reason] of Object.entries(FORBIDDEN_TABLES)) {
    if (!existingTables.includes(table)) continue;
    for (const privilege of ALL_PRIVILEGES) {
      if (await hasTablePrivilege(table, privilege)) {
        report(`${table}: role holds ${privilege} on a forbidden table — ${reason}`);
      }
    }
  }

  const settings = await client.query("SELECT rolconfig FROM pg_roles WHERE rolname = $1", [
    ADMIN_PEOPLE_WRITER_ROLE
  ]);
  const configured = new Set(settings.rows[0].rolconfig ?? []);
  for (const [setting, value] of Object.entries(ROLE_SETTINGS)) {
    if (!configured.has(`${setting}=${value}`)) {
      report(`role setting ${setting} is not ${value}`);
    }
  }

  const attributes = await client.query(
    "SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [ADMIN_PEOPLE_WRITER_ROLE]
  );
  for (const [attribute, held] of Object.entries(attributes.rows[0])) {
    if (held) report(`role holds ${attribute}`);
  }

  const updatable = Object.values(UPDATABLE_COLUMNS).reduce(
    (total, columns) => total + columns.length,
    0
  );
  process.stdout.write(
    failures === 0
      ? `${ADMIN_PEOPLE_WRITER_ROLE}: privilege matrix verified. ` +
          `${updatable} updatable column(s) across ${Object.keys(UPDATABLE_COLUMNS).length} ` +
          "tables, no table-level UPDATE, no DELETE, no privilege on any product table.\n"
      : `\n${failures} privilege problem(s). ` +
          "The control plane is not safe to point at this role.\n"
  );
}

/** Take the role's login away without dropping it or losing the grants. */
async function disable() {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    ADMIN_PEOPLE_WRITER_ROLE
  ]);
  if (exists.rowCount === 0) {
    process.stdout.write(`Role ${ADMIN_PEOPLE_WRITER_ROLE} does not exist.\n`);
    return;
  }
  await roleAdminClient.query(`ALTER ROLE ${quoteIdentifier(ADMIN_PEOPLE_WRITER_ROLE)} NOLOGIN`);
  process.stdout.write(
    `${ADMIN_PEOPLE_WRITER_ROLE} can no longer connect. Reads through other roles are\n` +
      "unaffected; suspension, revocation and enrollment tickets will fail until it is\n" +
      "provisioned again. Signing in and enrolling one's own key are unaffected.\n"
  );
}

/**
 * Refuse to act on a schema or a policy the tool cannot trust.
 *
 * A table nobody has decided about stops the command rather than producing a
 * partial grant. This is the check that notices a migration adding a table, and
 * it is the reason every role is re-provisioned after one.
 */
function assertPolicyMatchesSchema(existingTables) {
  const contradictory = [...Object.keys(INSERTABLE_TABLES), ...Object.keys(UPDATABLE_COLUMNS)]
    .filter((table) => table in FORBIDDEN_TABLES)
    .sort();
  if (contradictory.length > 0) {
    fail(
      "These tables are listed as both writable and forbidden:\n" +
        contradictory.map((table) => `  - ${table}`).join("\n") +
        `\n\nResolve the contradiction in ${MATRIX_PATH} before provisioning.`
    );
  }

  // Every table this role may change must also be one it may read: a policy
  // that could write a column it cannot see would be one nobody could review.
  const unreadable = Object.keys(UPDATABLE_COLUMNS)
    .filter((table) => !(table in READABLE_TABLES))
    .sort();
  if (unreadable.length > 0) {
    fail(
      "These tables are updatable but not readable:\n" +
        unreadable.map((table) => `  - ${table}`).join("\n") +
        `\n\nAdd them to READABLE_TABLES in ${MATRIX_PATH}.`
    );
  }

  const decided = new Set([
    ...Object.keys(INSERTABLE_TABLES),
    ...Object.keys(UPDATABLE_COLUMNS),
    ...Object.keys(READABLE_TABLES),
    ...Object.keys(FORBIDDEN_TABLES)
  ]);

  const undecided = existingTables.filter((table) => !decided.has(table)).sort();
  if (undecided.length > 0) {
    fail(
      "These tables exist but the policy does not mention them:\n" +
        undecided.map((table) => `  - ${table}`).join("\n") +
        `\n\nAdd each one to READABLE_TABLES, INSERTABLE_TABLES, UPDATABLE_COLUMNS or\n` +
        `FORBIDDEN_TABLES in ${MATRIX_PATH}. A table is forbidden until somebody\n` +
        "decides otherwise."
    );
  }

  const existing = new Set(existingTables);
  const stale = [...decided].filter((table) => !existing.has(table)).sort();
  if (stale.length > 0) {
    fail(
      "The policy names tables that no longer exist:\n" +
        stale.map((table) => `  - ${table}`).join("\n") +
        `\n\nRemove them from ${MATRIX_PATH}.`
    );
  }
}

async function listTables() {
  const result = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  return result.rows.map((row) => row.tablename);
}

async function listColumns(table) {
  const result = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return result.rows.map((row) => row.column_name);
}

async function hasTablePrivilege(table, privilege) {
  const result = await client.query("SELECT has_table_privilege($1, $2, $3) AS held", [
    ADMIN_PEOPLE_WRITER_ROLE,
    `public.${table}`,
    privilege
  ]);
  return result.rows[0].held === true;
}

async function hasColumnPrivilege(table, column, privilege) {
  const result = await client.query("SELECT has_column_privilege($1, $2, $3, $4) AS held", [
    ADMIN_PEOPLE_WRITER_ROLE,
    `public.${table}`,
    column,
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
