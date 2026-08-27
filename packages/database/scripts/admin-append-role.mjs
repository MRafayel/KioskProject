/**
 * Provision and verify an append-only database role.
 *
 * Two roles now share this: the writer that records operator observations, and
 * the refund writer that records monetary obligations. They hold different
 * grants over different tables and exist for different reasons, but the
 * property that makes each of them worth having is the same one —
 *
 *     INSERT on a named list, SELECT on a named list, and no privilege that
 *     changes or destroys an existing row anywhere in the database.
 *
 * — so it is asserted here once. A second copy of this logic would be a second
 * place for the assertion to be weakened, and the whole argument of the control
 * plane's design is that "could this connection do X" is answerable by reading
 * one thing.
 *
 * Each role supplies its own policy module (`*-matrix.mjs`), which is the file a
 * reviewer reads to see what that role may touch. This file is the mechanism;
 * the matrix is the decision.
 */

import process from "node:process";
import { URL } from "node:url";

import pg from "pg";

import { quoteIdentifier, quoteLiteral } from "./sql-identifiers.mjs";

/**
 * The privileges that would let a role change or destroy something that already
 * exists. INSERT is absent on purpose: it is the one an append-only role is
 * allowed to hold, and only on the tables its matrix names.
 */
const MUTATING_PRIVILEGES = ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const ALL_PRIVILEGES = ["SELECT", "INSERT", ...MUTATING_PRIVILEGES];

/**
 * @typedef {object} AppendRolePolicy
 * @property {string} role                     the PostgreSQL role name
 * @property {string} passwordVariable         env var holding its password
 * @property {string} urlVariable              env var the API points at it with
 * @property {string} matrixPath               the policy file, named in errors
 * @property {string} command                  the pnpm script, named in errors
 * @property {Record<string,string>} insertable tables it may append to
 * @property {Record<string,string[]|"*">} readable tables and columns it may read
 * @property {Record<string,string>} forbidden tables it may not touch at all
 * @property {Record<string,string>} settings  connection settings pinned on it
 * @property {string} summary                  one line printed after provisioning
 */

const MINIMUM_ROLE_PASSWORD_LENGTH = 24;

/**
 * Resolve the credential used while creating or synchronising a role.
 *
 * Deployments already have to provide the role's connection URL to the API.
 * Requiring the same secret a second time in a transient `*_PASSWORD` variable
 * made routine post-migration provisioning fail even when the configured URL
 * was correct. The explicit variable remains useful when creating a role for
 * the first time, but an existing role URL is an equally valid source.
 *
 * The URL is accepted only when it names the role being provisioned. This
 * prevents a typo from changing the role to some other connection's password.
 * No error includes the URL or its password.
 *
 * @param {Pick<AppendRolePolicy, "role" | "passwordVariable" | "urlVariable">} policy
 * @param {Record<string, string | undefined>} environment
 */
export function resolveProvisionPassword(policy, environment = process.env) {
  const explicitPassword = environment[policy.passwordVariable];
  if (explicitPassword !== undefined && explicitPassword !== "") {
    assertPasswordLength(policy, explicitPassword, policy.passwordVariable);
    return explicitPassword;
  }

  const connectionString = environment[policy.urlVariable];
  if (connectionString) {
    let url;
    try {
      url = new URL(connectionString);
    } catch {
      throw new FatalPolicyError(
        `${policy.urlVariable} must be a valid PostgreSQL connection URL.`
      );
    }

    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
      throw new FatalPolicyError(
        `${policy.urlVariable} must be a PostgreSQL connection URL.`
      );
    }

    let username;
    let password;
    try {
      username = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
    } catch {
      throw new FatalPolicyError(
        `${policy.urlVariable} contains invalid percent-encoding in its credentials.`
      );
    }

    if (username !== policy.role) {
      throw new FatalPolicyError(
        `${policy.urlVariable} must use PostgreSQL role ${policy.role} before its ` +
          "password can be used for provisioning."
      );
    }

    assertPasswordLength(policy, password, policy.urlVariable);
    return password;
  }

  throw passwordConfigurationError(policy);
}

function assertPasswordLength(policy, password, source) {
  if (password.length >= MINIMUM_ROLE_PASSWORD_LENGTH) return;
  throw new FatalPolicyError(
    `${source} must provide a password of at least ${MINIMUM_ROLE_PASSWORD_LENGTH} characters.\n` +
      passwordConfigurationHelp(policy)
  );
}

function passwordConfigurationError(policy) {
  return new FatalPolicyError(
    `${policy.passwordVariable} or ${policy.urlVariable} must provide the role password.\n` +
      passwordConfigurationHelp(policy)
  );
}

function passwordConfigurationHelp(policy) {
  return (
    `Set ${policy.passwordVariable} explicitly, or configure ${policy.urlVariable} with ` +
    `the ${policy.role} credential.\n` +
    "Generate a password with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
  );
}

/**
 * Run one command against one policy. Returns the process exit code.
 *
 * @param {AppendRolePolicy} policy
 * @param {string | undefined} command
 */
export async function runAppendRoleCommand(policy, command) {
  // Role management — CREATE ROLE, the password, the connection settings —
  // needs CREATEROLE, which the owner role deliberately does not have.
  const roleAdminUrl = process.env.DATABASE_URL;
  if (!roleAdminUrl) {
    process.stderr.write("DATABASE_URL is required.\n");
    return 1;
  }

  // Granting needs to own the table being granted on. Since Phase 4 the
  // application owns neither `audit_events` nor any `admin_*` table, and every
  // role here needs a grant on at least one of them — so the GRANTs run as the
  // owner, which is also a member of the application role and can therefore
  // grant on the product tables as well. Development, where the application is
  // the cluster's bootstrap superuser, works either way; production does not.
  const grantUrl = process.env.ADMIN_OWNER_DATABASE_URL ?? roleAdminUrl;

  const client = new pg.Client({ connectionString: grantUrl });
  await client.connect();

  const sharesOneConnection = grantUrl === roleAdminUrl;
  const roleAdminClient = sharesOneConnection
    ? client
    : new pg.Client({ connectionString: roleAdminUrl });
  if (!sharesOneConnection) await roleAdminClient.connect();

  const session = new AppendRoleSession(policy, client, roleAdminClient);
  try {
    switch (command) {
      case "provision":
        await session.provision();
        break;
      case "verify":
        await session.verify();
        break;
      case "disable":
        await session.disable();
        break;
      default:
        process.stderr.write(`Usage: ${policy.command} <provision|verify|disable>\n`);
        return 1;
    }
  } catch (error) {
    if (!(error instanceof FatalPolicyError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  } finally {
    await client.end();
    if (!sharesOneConnection) await roleAdminClient.end();
  }

  return session.failures > 0 ? 1 : 0;
}

class AppendRoleSession {
  /**
   * @param {AppendRolePolicy} policy
   * @param {pg.Client} client          owns the tables; issues every GRANT
   * @param {pg.Client} roleAdminClient may CREATE ROLE; issues no GRANT
   */
  constructor(policy, client, roleAdminClient) {
    this.policy = policy;
    this.client = client;
    this.roleAdminClient = roleAdminClient;
    this.failures = 0;
  }

  /**
   * Create or update the role so that it matches the matrix exactly.
   *
   * Everything is revoked first, so this is a synchronisation rather than an
   * accumulation: a grant removed from the matrix actually goes away instead of
   * lingering because nobody thought to revoke it.
   */
  async provision() {
    const { policy, client } = this;
    const password = resolveProvisionPassword(policy);

    const existingTables = await this.listTables();
    this.assertPolicyMatchesSchema(existingTables);

    const databaseName = (await client.query("SELECT current_database() AS name")).rows[0].name;
    const roleLiteral = quoteIdentifier(policy.role);

    // The role itself, on the connection that can create one. Kept outside the
    // grant transaction below because it is on a different connection, and
    // because a role that exists with no grants can do nothing anyway.
    const exists = await this.roleAdminClient.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
      policy.role
    ]);
    if (exists.rowCount === 0) {
      await this.roleAdminClient.query(
        `CREATE ROLE ${roleLiteral} LOGIN PASSWORD ${quoteLiteral(password)} ` +
          "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
      );
    } else {
      await this.roleAdminClient.query(
        `ALTER ROLE ${roleLiteral} LOGIN PASSWORD ${quoteLiteral(password)}`
      );
    }

    for (const [setting, value] of Object.entries(policy.settings)) {
      await this.roleAdminClient.query(
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

      for (const [table, columns] of Object.entries(policy.readable)) {
        if (!existingTables.includes(table)) continue;
        const target = `public.${quoteIdentifier(table)}`;
        if (columns === "*") {
          await client.query(`GRANT SELECT ON ${target} TO ${roleLiteral}`);
        } else {
          const columnList = columns.map(quoteIdentifier).join(", ");
          await client.query(`GRANT SELECT (${columnList}) ON ${target} TO ${roleLiteral}`);
        }
      }

      for (const table of Object.keys(policy.insertable)) {
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
      throw new FatalPolicyError(
        error instanceof Error ? error.message : `Could not provision ${policy.role}.`
      );
    }

    process.stdout.write(
      [
        `Provisioned ${policy.role}.`,
        `  may INSERT into : ${Object.keys(policy.insertable).join(", ")}`,
        `  may SELECT from : ${Object.keys(policy.readable).length} tables`,
        "  may UPDATE      : nothing",
        "  may DELETE      : nothing",
        "",
        policy.summary,
        "",
        `Then confirm the result with: ${policy.command} verify`,
        ""
      ].join("\n")
    );
  }

  /**
   * Check the live database against the matrix.
   *
   * This is the gate. It answers "what could a compromised admin backend do
   * through this connection" by asking PostgreSQL rather than by reading the
   * application.
   */
  async verify() {
    const { policy, client } = this;
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [policy.role]);
    if (exists.rowCount === 0) {
      throw new FatalPolicyError(
        `Role ${policy.role} does not exist. Run: ${policy.command} provision`
      );
    }

    const existingTables = await this.listTables();
    this.assertPolicyMatchesSchema(existingTables);

    // The property that defines an append-only role: no privilege that changes
    // or destroys an existing row, anywhere in the database, whatever the
    // matrix says.
    for (const table of existingTables) {
      for (const privilege of MUTATING_PRIVILEGES) {
        if (await this.hasTablePrivilege(table, privilege)) {
          this.report(`${table}: role holds ${privilege}; this role may only append`);
        }
      }
    }

    for (const table of Object.keys(policy.insertable)) {
      if (!existingTables.includes(table)) continue;
      if (!(await this.hasTablePrivilege(table, "INSERT"))) {
        this.report(`${table}: expected INSERT, role has none`);
      }
    }

    // INSERT anywhere else is the failure this list is really about: a row
    // appearing in a table nobody authorised this role to append to.
    const insertable = new Set(Object.keys(policy.insertable));
    for (const table of existingTables) {
      if (insertable.has(table)) continue;
      if (await this.hasTablePrivilege(table, "INSERT")) {
        this.report(`${table}: role holds INSERT on a table it must not write to`);
      }
    }

    for (const [table, columns] of Object.entries(policy.readable)) {
      if (!existingTables.includes(table)) continue;
      const existingColumns = await this.listColumns(table);

      if (columns === "*") {
        if (!(await this.hasTablePrivilege(table, "SELECT"))) {
          this.report(`${table}: expected SELECT, role has none`);
        }
        continue;
      }

      for (const column of columns) {
        if (!(await this.hasColumnPrivilege(table, column, "SELECT"))) {
          this.report(`${table}.${column}: expected SELECT, role has none`);
        }
      }
      for (const column of deniedColumnsFor(policy.readable, table, existingColumns)) {
        if (await this.hasColumnPrivilege(table, column, "SELECT")) {
          this.report(`${table}.${column}: MUST NOT be readable but the role can SELECT it`);
        }
      }
    }

    for (const [table, reason] of Object.entries(policy.forbidden)) {
      if (!existingTables.includes(table)) continue;
      for (const privilege of ALL_PRIVILEGES) {
        if (await this.hasTablePrivilege(table, privilege)) {
          this.report(`${table}: role holds ${privilege} on a forbidden table — ${reason}`);
        }
      }
    }

    const settings = await client.query("SELECT rolconfig FROM pg_roles WHERE rolname = $1", [
      policy.role
    ]);
    const configured = new Set(settings.rows[0].rolconfig ?? []);
    for (const [setting, value] of Object.entries(policy.settings)) {
      if (!configured.has(`${setting}=${value}`)) {
        this.report(`role setting ${setting} is not ${value}`);
      }
    }

    const attributes = await client.query(
      "SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = $1",
      [policy.role]
    );
    for (const [attribute, held] of Object.entries(attributes.rows[0])) {
      if (held) this.report(`role holds ${attribute}`);
    }

    process.stdout.write(
      this.failures === 0
        ? `${policy.role}: privilege matrix verified. ` +
            `${Object.keys(policy.insertable).length} INSERT(s), no UPDATE, no DELETE.\n`
        : `\n${this.failures} privilege problem(s). ` +
            "The control plane is not safe to point at this role.\n"
    );
  }

  /** Take the role's login away without dropping it or losing the grants. */
  async disable() {
    const { policy, client } = this;
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [policy.role]);
    if (exists.rowCount === 0) {
      process.stdout.write(`Role ${policy.role} does not exist.\n`);
      return;
    }
    await this.roleAdminClient.query(`ALTER ROLE ${quoteIdentifier(policy.role)} NOLOGIN`);
    process.stdout.write(
      `${policy.role} can no longer connect. Reads through other roles are\n` +
        "unaffected; the actions this role serves will fail until it is provisioned again.\n"
    );
  }

  /**
   * Refuse to act on a schema or a policy the tool cannot trust.
   *
   * A table nobody has decided about, and a table claimed by both lists, are
   * both failures rather than warnings: they stop the command instead of
   * producing a partial grant.
   */
  assertPolicyMatchesSchema(existingTables) {
    const { policy } = this;

    const contradictory = Object.keys(policy.insertable)
      .filter((table) => table in policy.forbidden)
      .sort();
    if (contradictory.length > 0) {
      throw new FatalPolicyError(
        "These tables are listed as both insertable and forbidden:\n" +
          contradictory.map((table) => `  - ${table}`).join("\n") +
          `\n\nResolve the contradiction in ${policy.matrixPath} before provisioning.` +
          "\nA table claimed by both lists is treated as forbidden."
      );
    }

    const decided = new Set([
      ...Object.keys(policy.insertable),
      ...Object.keys(policy.readable),
      ...Object.keys(policy.forbidden)
    ]);

    const undecided = existingTables.filter((table) => !decided.has(table)).sort();
    if (undecided.length > 0) {
      throw new FatalPolicyError(
        "These tables exist but the policy does not mention them:\n" +
          undecided.map((table) => `  - ${table}`).join("\n") +
          `\n\nAdd each one to READABLE_TABLES, INSERTABLE_TABLES or FORBIDDEN_TABLES in\n` +
          `${policy.matrixPath}. A table is forbidden until somebody decides otherwise.`
      );
    }

    const existing = new Set(existingTables);
    const stale = [...decided].filter((table) => !existing.has(table)).sort();
    if (stale.length > 0) {
      throw new FatalPolicyError(
        "The policy names tables that no longer exist:\n" +
          stale.map((table) => `  - ${table}`).join("\n") +
          `\n\nRemove them from ${policy.matrixPath}.`
      );
    }
  }

  async listTables() {
    const result = await this.client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    return result.rows.map((row) => row.tablename);
  }

  async listColumns(table) {
    const result = await this.client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );
    const columns = result.rows.map((row) => row.column_name);
    const missing = missingColumnsFor(this.policy.readable, table, columns);
    if (missing.length > 0) {
      this.report(`${table}: policy allows columns that do not exist: ${missing.join(", ")}`);
    }
    return columns;
  }

  async hasTablePrivilege(table, privilege) {
    const result = await this.client.query("SELECT has_table_privilege($1, $2, $3) AS held", [
      this.policy.role,
      `public.${table}`,
      privilege
    ]);
    return result.rows[0].held === true;
  }

  async hasColumnPrivilege(table, column, privilege) {
    const result = await this.client.query("SELECT has_column_privilege($1, $2, $3, $4) AS held", [
      this.policy.role,
      `public.${table}`,
      column,
      privilege
    ]);
    return result.rows[0].held === true;
  }

  report(message) {
    this.failures += 1;
    process.stderr.write(`  FAIL  ${message}\n`);
  }
}

/**
 * Columns of a readable table the role must NOT hold a grant on.
 *
 * Derived rather than listed, so adding a column to the schema without adding
 * it to the allow-list denies it automatically.
 */
export function deniedColumnsFor(readable, table, existingColumns) {
  const allowed = readable[table];
  if (allowed === undefined || allowed === "*") return [];
  const allowedSet = new Set(allowed);
  return existingColumns.filter((column) => !allowedSet.has(column));
}

/** Allow-listed columns the live schema does not have. */
export function missingColumnsFor(readable, table, existingColumns) {
  const allowed = readable[table];
  if (allowed === undefined || allowed === "*") return [];
  const existing = new Set(existingColumns);
  return allowed.filter((column) => !existing.has(column));
}

/** A problem that stops the command rather than counting as a finding. */
class FatalPolicyError extends Error {}
