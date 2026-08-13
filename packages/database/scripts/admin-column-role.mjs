/**
 * Provision and verify a database role whose power is a column list.
 *
 * `admin-append-role.mjs` runs the roles defined by one sentence — INSERT on a
 * named list, SELECT on a named list, and no privilege that changes a row that
 * already exists. Two roles cannot be defined that way, because changing an
 * existing row is exactly what they are for: the people role ends somebody's
 * access, and the pricing role archives the tariff it is replacing.
 *
 * They share this runner, which holds the same argument to a stricter standard:
 *
 *   - UPDATE is held per *column*, never per table, and `verify` walks every
 *     column of every table in the database to prove it.
 *   - DELETE, TRUNCATE, REFERENCES and TRIGGER are held nowhere at all.
 *   - INSERT is held on the tables the matrix names and refused everywhere else.
 *   - SELECT is column-scoped wherever the matrix says so, and a column added by
 *     a later migration is denied until somebody decides otherwise.
 *
 * Phase 4B shipped the people role with its own copy of this logic and recorded
 * the duplication as a cost: "no UPDATE anywhere" had been asserted by one
 * implementation, and column-level UPDATE was now asserted by another. Phase 5
 * would have made that three, so the copy became this file instead. Each role
 * supplies its own policy module (`*-matrix.mjs`), which is the file a reviewer
 * reads to see what that role may touch. This file is the mechanism; the matrix
 * is the decision.
 *
 * **This uses two connections, because no single role can do both halves.** The
 * `admin_*` tables and `audit_events` have been owned by `printing_kiosk_migrator`
 * since Phase 4, and only an owner may grant on what it owns — but that role is
 * deliberately `NOCREATEROLE`, because a role-creating migrator would be a second
 * path to manufacturing a privileged connection. So role management runs on
 * `DATABASE_URL` and every GRANT runs on `ADMIN_OWNER_DATABASE_URL`. The owner is
 * a member of the application role, so it can also revoke grants the application
 * issued on the product tables — which is what keeps `FORBIDDEN_TABLES`
 * enforceable rather than aspirational.
 */

import process from "node:process";

import pg from "pg";

import { quoteIdentifier, quoteLiteral } from "./sql-identifiers.mjs";

/**
 * The privileges this kind of role may never hold on anything. UPDATE is absent
 * because it is checked separately and far more precisely: table-level UPDATE is
 * a failure, and column-level UPDATE is a failure everywhere except the exact
 * pairs the matrix names.
 */
const DESTRUCTIVE_PRIVILEGES = ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const ALL_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", ...DESTRUCTIVE_PRIVILEGES];

/**
 * @typedef {object} ColumnRolePolicy
 * @property {string} role                       the PostgreSQL role name
 * @property {string} passwordVariable           env var holding its password
 * @property {string} urlVariable                env var the API points at it with
 * @property {string} matrixPath                 the policy file, named in errors
 * @property {string} command                    the pnpm script, named in errors
 * @property {Record<string,string>} insertable  tables it may append to
 * @property {Record<string,string[]>} updatable tables and columns it may change
 * @property {Record<string,string[]|"*">} readable tables and columns it may read
 * @property {Record<string,string>} forbidden   tables it may not touch at all
 * @property {Record<string,string>} settings    connection settings pinned on it
 * @property {string[]} summary                  printed after provisioning
 * @property {string} disabled                   printed after `disable`
 */

/**
 * Run one command against one policy. Returns the process exit code.
 *
 * @param {ColumnRolePolicy} policy
 * @param {string | undefined} command
 */
export async function runColumnRoleCommand(policy, command) {
  const roleAdminUrl = process.env.DATABASE_URL;
  if (!roleAdminUrl) {
    process.stderr.write("DATABASE_URL is required.\n");
    return 1;
  }
  const grantUrl = process.env.ADMIN_OWNER_DATABASE_URL ?? roleAdminUrl;

  const client = new pg.Client({ connectionString: grantUrl });
  await client.connect();

  const sharesOneConnection = grantUrl === roleAdminUrl;
  const roleAdminClient = sharesOneConnection
    ? client
    : new pg.Client({ connectionString: roleAdminUrl });
  if (!sharesOneConnection) await roleAdminClient.connect();

  const session = new ColumnRoleSession(policy, client, roleAdminClient);
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

class ColumnRoleSession {
  /**
   * @param {ColumnRolePolicy} policy
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
   * Everything is revoked first, so this synchronises rather than accumulates: a
   * column removed from the matrix actually loses its grant instead of lingering
   * because nobody thought to revoke it.
   */
  async provision() {
    const { policy, client } = this;
    const password = process.env[policy.passwordVariable];
    if (!password || password.length < 24) {
      throw new FatalPolicyError(
        `${policy.passwordVariable} must be set to at least 24 characters.\n` +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
      );
    }

    const existingTables = await this.listTables();
    this.assertPolicyMatchesSchema(existingTables);

    const databaseName = (await client.query("SELECT current_database() AS name")).rows[0].name;
    const roleLiteral = quoteIdentifier(policy.role);

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

      // The grant this kind of role exists for. Always column-scoped: a bare
      // `GRANT UPDATE ON admin_users` would hand over `role` along with
      // `status`, and a bare one on `pricing_rule_sets` would hand over the
      // amounts along with the status that archives them.
      for (const [table, columns] of Object.entries(policy.updatable)) {
        if (!existingTables.includes(table)) continue;
        const columnList = columns.map(quoteIdentifier).join(", ");
        await client.query(
          `GRANT UPDATE (${columnList}) ON public.${quoteIdentifier(table)} TO ${roleLiteral}`
        );
      }

      // A table added by a future migration must not inherit a grant. Default
      // privileges are the one place PostgreSQL would hand one out silently, and
      // they are per grantor — so both the owner of the admin tables and the
      // application that owns the product ones have to be told.
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
        ...Object.entries(policy.updatable).map(
          ([table, columns]) => `  may UPDATE      : ${table} (${columns.join(", ")})`
        ),
        `  may SELECT from : ${Object.keys(policy.readable).length} tables`,
        "  may DELETE      : nothing",
        "",
        ...policy.summary,
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

    for (const table of existingTables) {
      for (const privilege of DESTRUCTIVE_PRIVILEGES) {
        if (await this.hasTablePrivilege(table, privilege)) {
          this.report(`${table}: role holds ${privilege}; this role may never destroy a row`);
        }
      }

      // Table-level UPDATE is always a failure, including on the tables the
      // matrix names: holding it would mean holding every column, which is the
      // difference between "may suspend an account" and "may promote one".
      if (await this.hasTablePrivilege(table, "UPDATE")) {
        this.report(`${table}: role holds table-level UPDATE; UPDATE must be column-scoped`);
      }

      const allowed = new Set(policy.updatable[table] ?? []);
      for (const column of await this.listColumns(table)) {
        const held = await this.hasColumnPrivilege(table, column, "UPDATE");
        if (held && !allowed.has(column)) {
          this.report(`${table}.${column}: role can UPDATE a column the policy does not name`);
        }
        if (!held && allowed.has(column)) {
          this.report(`${table}.${column}: expected UPDATE, role has none`);
        }
      }
    }

    for (const table of Object.keys(policy.insertable)) {
      if (!existingTables.includes(table)) continue;
      if (!(await this.hasTablePrivilege(table, "INSERT"))) {
        this.report(`${table}: expected INSERT, role has none`);
      }
    }

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

      const allowed = new Set(columns);
      for (const column of columns) {
        if (!existingColumns.includes(column)) {
          this.report(`${table}: policy allows a column that does not exist: ${column}`);
          continue;
        }
        if (!(await this.hasColumnPrivilege(table, column, "SELECT"))) {
          this.report(`${table}.${column}: expected SELECT, role has none`);
        }
      }
      for (const column of existingColumns) {
        if (allowed.has(column)) continue;
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

    const updatable = Object.values(policy.updatable).reduce(
      (total, columns) => total + columns.length,
      0
    );
    process.stdout.write(
      this.failures === 0
        ? `${policy.role}: privilege matrix verified. ` +
            `${updatable} updatable column(s) across ${Object.keys(policy.updatable).length} ` +
            "table(s), no table-level UPDATE, no DELETE.\n"
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
    process.stdout.write(`${policy.role} can no longer connect.\n${policy.disabled}\n`);
  }

  /**
   * Refuse to act on a schema or a policy the tool cannot trust.
   *
   * A table nobody has decided about stops the command rather than producing a
   * partial grant. This is the check that notices a migration adding a table,
   * and it is the reason every role is re-provisioned after one.
   */
  assertPolicyMatchesSchema(existingTables) {
    const { policy } = this;

    const contradictory = [...Object.keys(policy.insertable), ...Object.keys(policy.updatable)]
      .filter((table) => table in policy.forbidden)
      .sort();
    if (contradictory.length > 0) {
      throw new FatalPolicyError(
        "These tables are listed as both writable and forbidden:\n" +
          contradictory.map((table) => `  - ${table}`).join("\n") +
          `\n\nResolve the contradiction in ${policy.matrixPath} before provisioning.`
      );
    }

    // Every table this role may change must also be one it may read: a policy
    // that could write a column it cannot see would be one nobody could review.
    const unreadable = Object.keys(policy.updatable)
      .filter((table) => !(table in policy.readable))
      .sort();
    if (unreadable.length > 0) {
      throw new FatalPolicyError(
        "These tables are updatable but not readable:\n" +
          unreadable.map((table) => `  - ${table}`).join("\n") +
          `\n\nAdd them to READABLE_TABLES in ${policy.matrixPath}.`
      );
    }

    const decided = new Set([
      ...Object.keys(policy.insertable),
      ...Object.keys(policy.updatable),
      ...Object.keys(policy.readable),
      ...Object.keys(policy.forbidden)
    ]);

    const undecided = existingTables.filter((table) => !decided.has(table)).sort();
    if (undecided.length > 0) {
      throw new FatalPolicyError(
        "These tables exist but the policy does not mention them:\n" +
          undecided.map((table) => `  - ${table}`).join("\n") +
          `\n\nAdd each one to READABLE_TABLES, INSERTABLE_TABLES, UPDATABLE_COLUMNS or\n` +
          `FORBIDDEN_TABLES in ${policy.matrixPath}. A table is forbidden until somebody\n` +
          "decides otherwise."
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
    return result.rows.map((row) => row.column_name);
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

/** A problem that stops the command rather than counting as a finding. */
class FatalPolicyError extends Error {}
