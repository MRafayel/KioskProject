#!/usr/bin/env node
/**
 * Provision and verify the control plane's read-only database role.
 *
 * The admin panel reads production data. The guarantee that it can only read —
 * and only the columns an operator is meant to see — is worth more as a
 * property of the connection than as a property of the code, because code is
 * reviewed once and a role is enforced on every statement forever.
 *
 * This is a command-line tool rather than a migration on purpose. Creating a
 * role needs privileges the application role does not have and should never
 * have; a managed PostgreSQL would fail the migration and block a deploy over a
 * grant. Provisioning a role is an operator action, like creating the database.
 *
 * Usage:
 *
 *   ADMIN_READ_DATABASE_PASSWORD=... node scripts/admin-reader.mjs provision
 *   node scripts/admin-reader.mjs verify
 *   node scripts/admin-reader.mjs disable
 *
 * Run `provision` again after every migration: a new table is denied by
 * default and a new column of a column-restricted table is invisible until it
 * is added to the matrix, which is the behaviour we want but only if somebody
 * notices. `verify` is what notices — run it in the deployment pipeline.
 */

import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { config as loadDotenv } from "dotenv";
import pg from "pg";

import {
  ADMIN_READER_ROLE,
  DENIED_TABLES,
  READABLE_TABLES,
  ROLE_SETTINGS,
  deniedColumnsFor,
  missingColumnsFor,
  staleTables,
  undecidedTables
} from "./admin-reader-matrix.mjs";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
loadDotenv({ path: `${workspaceDirectory}/.env`, override: false, quiet: true });

const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

const { positionals } = parseArgs({ allowPositionals: true, options: {} });
const command = positionals[0];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL is required.");

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
    case "disable":
      await disable();
      break;
    default:
      fail("Usage: admin-reader.mjs <provision|verify|disable>");
  }
} finally {
  await client.end();
}

if (failures > 0) process.exit(1);

/**
 * Create or update the role so that it matches the matrix exactly.
 *
 * Every grant is revoked first. That makes the operation a synchronisation
 * rather than an accumulation: a column removed from the allow-list actually
 * loses its grant instead of lingering because nobody thought to revoke it.
 */
async function provision() {
  const password = process.env.ADMIN_READ_DATABASE_PASSWORD;
  if (!password || password.length < 24) {
    fail(
      "ADMIN_READ_DATABASE_PASSWORD must be set to at least 24 characters.\n" +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
    );
  }

  const existingTables = await listTables();
  assertPolicyMatchesSchema(existingTables);

  const databaseName = (await client.query("SELECT current_database() AS name")).rows[0].name;
  const roleLiteral = quoteIdentifier(ADMIN_READER_ROLE);

  await client.query("BEGIN");
  try {
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
      ADMIN_READER_ROLE
    ]);
    if (exists.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${roleLiteral} LOGIN PASSWORD ${quoteLiteral(password)} ` +
          "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
      );
    } else {
      await client.query(`ALTER ROLE ${roleLiteral} LOGIN PASSWORD ${quoteLiteral(password)}`);
    }

    for (const [setting, value] of Object.entries(ROLE_SETTINGS)) {
      await client.query(
        `ALTER ROLE ${roleLiteral} SET ${quoteIdentifier(setting)} = ${quoteLiteral(value)}`
      );
    }

    // Start from nothing every time, so this command is a statement of the
    // whole policy rather than a patch on top of whatever ran before it.
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

    // A table added by a future migration must not inherit a grant. Default
    // privileges are the one place PostgreSQL would hand one out silently.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${roleLiteral}`
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    fail(error instanceof Error ? error.message : "Could not provision the reader role.");
  }

  const readable = Object.keys(READABLE_TABLES).length;
  const restricted = Object.values(READABLE_TABLES).filter((value) => value !== "*").length;
  process.stdout.write(
    [
      `Provisioned ${ADMIN_READER_ROLE}.`,
      `  readable tables : ${readable} (${restricted} column-restricted)`,
      `  denied tables   : ${Object.keys(DENIED_TABLES).length}`,
      "",
      "Point the API at it with ADMIN_READ_DATABASE_URL, using this role and",
      "password. Do not reuse the application role's connection string.",
      "",
      "Then confirm the result with: pnpm db:admin-reader verify",
      ""
    ].join("\n")
  );
}

/**
 * Check the live database against the matrix.
 *
 * This is the gate. It answers "can the control plane read a customer's
 * filename" by asking PostgreSQL rather than by reading the application.
 */
async function verify() {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    ADMIN_READER_ROLE
  ]);
  if (exists.rowCount === 0) {
    fail(`Role ${ADMIN_READER_ROLE} does not exist. Run: pnpm db:admin-reader provision`);
  }

  const existingTables = await listTables();
  assertPolicyMatchesSchema(existingTables);

  for (const [table, columns] of Object.entries(READABLE_TABLES)) {
    if (!existingTables.includes(table)) continue;
    const existingColumns = await listColumns(table);

    if (columns === "*") {
      if (!(await hasTablePrivilege(table, "SELECT"))) {
        report(`${table}: expected SELECT, role has none`);
      }
    } else {
      for (const column of columns) {
        if (!(await hasColumnPrivilege(table, column, "SELECT"))) {
          report(`${table}.${column}: expected SELECT, role has none`);
        }
      }
      for (const column of deniedColumnsFor(table, existingColumns)) {
        if (await hasColumnPrivilege(table, column, "SELECT")) {
          report(`${table}.${column}: MUST NOT be readable but the role can SELECT it`);
        }
      }
    }

    for (const privilege of WRITE_PRIVILEGES) {
      if (await hasTablePrivilege(table, privilege)) {
        report(`${table}: role holds ${privilege}; the control plane must never write`);
      }
    }
  }

  for (const table of Object.keys(DENIED_TABLES)) {
    if (!existingTables.includes(table)) continue;
    for (const privilege of ["SELECT", ...WRITE_PRIVILEGES]) {
      if (await hasTablePrivilege(table, privilege)) {
        report(`${table}: role holds ${privilege} on a denied table — ${DENIED_TABLES[table]}`);
      }
    }
  }

  const settings = await client.query("SELECT rolconfig FROM pg_roles WHERE rolname = $1", [
    ADMIN_READER_ROLE
  ]);
  const configured = new Set(settings.rows[0].rolconfig ?? []);
  for (const [setting, value] of Object.entries(ROLE_SETTINGS)) {
    if (!configured.has(`${setting}=${value}`)) {
      report(`role setting ${setting} is not ${value}`);
    }
  }

  const attributes = await client.query(
    "SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [ADMIN_READER_ROLE]
  );
  for (const [attribute, held] of Object.entries(attributes.rows[0])) {
    if (held) report(`role holds ${attribute}`);
  }

  process.stdout.write(
    failures === 0
      ? `${ADMIN_READER_ROLE}: privilege matrix verified.\n`
      : `\n${failures} privilege problem(s). The control plane is not safe to point at this role.\n`
  );
}

/** Take the role's login away without dropping it or losing the grants. */
async function disable() {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    ADMIN_READER_ROLE
  ]);
  if (exists.rowCount === 0) {
    process.stdout.write(`Role ${ADMIN_READER_ROLE} does not exist.\n`);
    return;
  }
  await client.query(`ALTER ROLE ${quoteIdentifier(ADMIN_READER_ROLE)} NOLOGIN`);
  process.stdout.write(
    `${ADMIN_READER_ROLE} can no longer connect. Existing connections are unaffected;\n` +
      "terminate them with pg_terminate_backend if this is an incident response.\n"
  );
}

/**
 * Refuse to act on a schema the policy does not describe.
 *
 * A table nobody has decided about is the failure mode this whole file exists
 * to prevent, so it stops the command rather than producing a partial grant.
 */
function assertPolicyMatchesSchema(existingTables) {
  const undecided = undecidedTables(existingTables);
  if (undecided.length > 0) {
    fail(
      "These tables exist but the admin read policy does not mention them:\n" +
        undecided.map((table) => `  - ${table}`).join("\n") +
        "\n\nAdd each one to READABLE_TABLES or DENIED_TABLES in" +
        " scripts/admin-reader-matrix.mjs.\nA table is denied until somebody decides otherwise."
    );
  }

  const stale = staleTables(existingTables);
  if (stale.length > 0) {
    fail(
      "The admin read policy names tables that no longer exist:\n" +
        stale.map((table) => `  - ${table}`).join("\n") +
        "\n\nRemove them from scripts/admin-reader-matrix.mjs."
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
  const columns = result.rows.map((row) => row.column_name);
  const missing = missingColumnsFor(table, columns);
  if (missing.length > 0) {
    report(`${table}: policy allows columns that do not exist: ${missing.join(", ")}`);
  }
  return columns;
}

async function hasTablePrivilege(table, privilege) {
  const result = await client.query("SELECT has_table_privilege($1, $2, $3) AS held", [
    ADMIN_READER_ROLE,
    `public.${table}`,
    privilege
  ]);
  return result.rows[0].held === true;
}

async function hasColumnPrivilege(table, column, privilege) {
  const result = await client.query("SELECT has_column_privilege($1, $2, $3, $4) AS held", [
    ADMIN_READER_ROLE,
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

/**
 * Identifiers and passwords cannot be bound as parameters in DDL, so they are
 * quoted here. Both come from this repository or an operator's environment
 * rather than from a request, but a role name that ends up in `GRANT` unquoted
 * is the kind of thing that is only safe until it is not.
 */
function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Refusing to use ${JSON.stringify(value)} as a SQL identifier.`);
  }
  return `"${value}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
