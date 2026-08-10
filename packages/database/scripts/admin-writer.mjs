#!/usr/bin/env node
/**
 * Provision and verify the control plane's write role.
 *
 * The read role from Phase 2 answers "what can the dashboard see". This one
 * answers the harder question: what can it *change*. The answer is two INSERTs
 * and nothing else, and it is worth more as a property of the connection than
 * as a property of the code, because code is reviewed once and a role is
 * enforced on every statement forever.
 *
 * A command-line tool rather than a migration, for the same reason as its
 * sibling: creating a role needs privileges the application role does not have
 * and should never have, and a managed PostgreSQL would fail a deploy over a
 * grant. Provisioning a role is an operator action, like creating the database.
 *
 * Usage:
 *
 *   ADMIN_WRITE_DATABASE_PASSWORD=... node scripts/admin-writer.mjs provision
 *   node scripts/admin-writer.mjs verify
 *   node scripts/admin-writer.mjs disable
 *
 * Run `provision` again after every migration and `verify` in the deployment
 * pipeline. A new table is forbidden by default and forces a decision here.
 */

import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { config as loadDotenv } from "dotenv";
import pg from "pg";

import {
  ADMIN_WRITER_ROLE,
  FORBIDDEN_TABLES,
  INSERTABLE_TABLES,
  READABLE_TABLES,
  ROLE_SETTINGS,
  contradictoryTables,
  deniedColumnsFor,
  missingColumnsFor,
  staleTables,
  undecidedTables
} from "./admin-writer-matrix.mjs";
import { quoteIdentifier, quoteLiteral } from "./sql-identifiers.mjs";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
loadDotenv({ path: `${workspaceDirectory}/.env`, override: false, quiet: true });

/**
 * The privileges that would let the control plane change or destroy something
 * that already exists. INSERT is absent on purpose: it is the one this role is
 * allowed to hold, and only on the two tables named by the matrix.
 */
const MUTATING_PRIVILEGES = ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const ALL_PRIVILEGES = ["SELECT", "INSERT", ...MUTATING_PRIVILEGES];

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
      fail("Usage: admin-writer.mjs <provision|verify|disable>");
  }
} finally {
  await client.end();
}

if (failures > 0) process.exit(1);

/**
 * Create or update the role so that it matches the matrix exactly.
 *
 * Everything is revoked first, so this is a synchronisation rather than an
 * accumulation: a grant removed from the matrix actually goes away instead of
 * lingering because nobody thought to revoke it.
 */
async function provision() {
  const password = process.env.ADMIN_WRITE_DATABASE_PASSWORD;
  if (!password || password.length < 24) {
    fail(
      "ADMIN_WRITE_DATABASE_PASSWORD must be set to at least 24 characters.\n" +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
    );
  }

  const existingTables = await listTables();
  assertPolicyMatchesSchema(existingTables);

  const databaseName = (await client.query("SELECT current_database() AS name")).rows[0].name;
  const roleLiteral = quoteIdentifier(ADMIN_WRITER_ROLE);

  await client.query("BEGIN");
  try {
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
      ADMIN_WRITER_ROLE
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

    // A table added by a future migration must not inherit a grant. Default
    // privileges are the one place PostgreSQL would hand one out silently.
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${roleLiteral}`
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    fail(error instanceof Error ? error.message : "Could not provision the writer role.");
  }

  process.stdout.write(
    [
      `Provisioned ${ADMIN_WRITER_ROLE}.`,
      `  may INSERT into : ${Object.keys(INSERTABLE_TABLES).join(", ")}`,
      `  may SELECT from : ${Object.keys(READABLE_TABLES).length} tables`,
      "  may UPDATE      : nothing",
      "  may DELETE      : nothing",
      "",
      "Point the API at it with ADMIN_WRITE_DATABASE_URL, using this role and",
      "password. Do not reuse the application or reader connection string.",
      "",
      "Then confirm the result with: pnpm db:admin-writer verify",
      ""
    ].join("\n")
  );
}

/**
 * Check the live database against the matrix.
 *
 * This is the gate. It answers "can a compromised admin backend issue a refund"
 * by asking PostgreSQL rather than by reading the application.
 */
async function verify() {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    ADMIN_WRITER_ROLE
  ]);
  if (exists.rowCount === 0) {
    fail(`Role ${ADMIN_WRITER_ROLE} does not exist. Run: pnpm db:admin-writer provision`);
  }

  const existingTables = await listTables();
  assertPolicyMatchesSchema(existingTables);

  // The property that defines this role: no privilege that changes or destroys
  // an existing row, anywhere in the database, whatever the matrix says.
  for (const table of existingTables) {
    for (const privilege of MUTATING_PRIVILEGES) {
      if (await hasTablePrivilege(table, privilege)) {
        report(`${table}: role holds ${privilege}; the control plane may only append`);
      }
    }
  }

  for (const table of Object.keys(INSERTABLE_TABLES)) {
    if (!existingTables.includes(table)) continue;
    if (!(await hasTablePrivilege(table, "INSERT"))) {
      report(`${table}: expected INSERT, role has none`);
    }
  }

  // INSERT anywhere else is the failure this list is really about: a row
  // appearing in a table nobody authorised the control plane to append to.
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

  for (const [table, reason] of Object.entries(FORBIDDEN_TABLES)) {
    if (!existingTables.includes(table)) continue;
    for (const privilege of ALL_PRIVILEGES) {
      if (await hasTablePrivilege(table, privilege)) {
        report(`${table}: role holds ${privilege} on a forbidden table — ${reason}`);
      }
    }
  }

  const settings = await client.query("SELECT rolconfig FROM pg_roles WHERE rolname = $1", [
    ADMIN_WRITER_ROLE
  ]);
  const configured = new Set(settings.rows[0].rolconfig ?? []);
  for (const [setting, value] of Object.entries(ROLE_SETTINGS)) {
    if (!configured.has(`${setting}=${value}`)) {
      report(`role setting ${setting} is not ${value}`);
    }
  }

  const attributes = await client.query(
    "SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [ADMIN_WRITER_ROLE]
  );
  for (const [attribute, held] of Object.entries(attributes.rows[0])) {
    if (held) report(`role holds ${attribute}`);
  }

  process.stdout.write(
    failures === 0
      ? `${ADMIN_WRITER_ROLE}: privilege matrix verified. Two INSERTs, no UPDATE, no DELETE.\n`
      : `\n${failures} privilege problem(s). The control plane is not safe to point at this role.\n`
  );
}

/** Take the role's login away without dropping it or losing the grants. */
async function disable() {
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
    ADMIN_WRITER_ROLE
  ]);
  if (exists.rowCount === 0) {
    process.stdout.write(`Role ${ADMIN_WRITER_ROLE} does not exist.\n`);
    return;
  }
  await client.query(`ALTER ROLE ${quoteIdentifier(ADMIN_WRITER_ROLE)} NOLOGIN`);
  process.stdout.write(
    `${ADMIN_WRITER_ROLE} can no longer connect. The panel's reads are unaffected;\n` +
      "operator actions will fail until it is provisioned again.\n"
  );
}

/**
 * Refuse to act on a schema or a policy the tool cannot trust.
 *
 * A table nobody has decided about, and a table claimed by both lists, are both
 * failures rather than warnings: they stop the command instead of producing a
 * partial grant.
 */
function assertPolicyMatchesSchema(existingTables) {
  const contradictory = contradictoryTables();
  if (contradictory.length > 0) {
    fail(
      "These tables are listed as both insertable and forbidden:\n" +
        contradictory.map((table) => `  - ${table}`).join("\n") +
        "\n\nResolve the contradiction in scripts/admin-writer-matrix.mjs before" +
        " provisioning.\nA table claimed by both lists is treated as forbidden."
    );
  }

  const undecided = undecidedTables(existingTables);
  if (undecided.length > 0) {
    fail(
      "These tables exist but the admin write policy does not mention them:\n" +
        undecided.map((table) => `  - ${table}`).join("\n") +
        "\n\nAdd each one to READABLE_TABLES, INSERTABLE_TABLES or FORBIDDEN_TABLES" +
        " in\nscripts/admin-writer-matrix.mjs. A table is forbidden until somebody" +
        " decides otherwise."
    );
  }

  const stale = staleTables(existingTables);
  if (stale.length > 0) {
    fail(
      "The admin write policy names tables that no longer exist:\n" +
        stale.map((table) => `  - ${table}`).join("\n") +
        "\n\nRemove them from scripts/admin-writer-matrix.mjs."
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
    ADMIN_WRITER_ROLE,
    `public.${table}`,
    privilege
  ]);
  return result.rows[0].held === true;
}

async function hasColumnPrivilege(table, column, privilege) {
  const result = await client.query("SELECT has_column_privilege($1, $2, $3, $4) AS held", [
    ADMIN_WRITER_ROLE,
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
