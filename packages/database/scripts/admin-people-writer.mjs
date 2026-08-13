#!/usr/bin/env node
/**
 * Provision and verify the role that administers people.
 *
 * The append-only roles share `admin-append-role.mjs`, because each of them is
 * defined by the same sentence: INSERT on a named list, SELECT on a named list,
 * and nothing that changes a row that already exists. This role was the first
 * that had to change one — a suspension, a revocation, an assignment ended — so
 * it cannot use that runner. It shares `admin-column-role.mjs` instead, with the
 * pricing role that publishes a tariff, and that runner holds the same argument
 * to a stricter standard: UPDATE per column, checked column by column across
 * every table in the database.
 *
 * Phase 4B shipped this script with its own copy of that logic and recorded the
 * duplication as a cost. Phase 5 needed the same shape a second time, so the
 * copy became the shared runner rather than becoming three copies.
 *
 * Usage:
 *
 *   ADMIN_PEOPLE_DATABASE_PASSWORD=... node scripts/admin-people-writer.mjs provision
 *   node scripts/admin-people-writer.mjs verify
 *   node scripts/admin-people-writer.mjs disable
 *
 * `provision` needs a connection that can create a role (`DATABASE_URL`) *and*
 * the owner connection (`ADMIN_OWNER_DATABASE_URL`) to issue the grants, for the
 * reasons `admin-column-role.mjs` sets out. `verify` needs neither.
 */

import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { config as loadDotenv } from "dotenv";

import { runColumnRoleCommand } from "./admin-column-role.mjs";
import {
  ADMIN_PEOPLE_WRITER_ROLE,
  FORBIDDEN_TABLES,
  INSERTABLE_TABLES,
  READABLE_TABLES,
  ROLE_SETTINGS,
  UPDATABLE_COLUMNS
} from "./admin-people-writer-matrix.mjs";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
loadDotenv({ path: `${workspaceDirectory}/.env`, override: false, quiet: true });

const { positionals } = parseArgs({ allowPositionals: true, options: {} });

const exitCode = await runColumnRoleCommand(
  {
    role: ADMIN_PEOPLE_WRITER_ROLE,
    passwordVariable: "ADMIN_PEOPLE_DATABASE_PASSWORD",
    urlVariable: "ADMIN_PEOPLE_DATABASE_URL",
    matrixPath: "packages/database/scripts/admin-people-writer-matrix.mjs",
    command: "pnpm db:admin-people-writer",
    insertable: INSERTABLE_TABLES,
    updatable: UPDATABLE_COLUMNS,
    readable: READABLE_TABLES,
    forbidden: FORBIDDEN_TABLES,
    settings: ROLE_SETTINGS,
    summary: [
      "It cannot change anybody's role, enrol an authenticator, read a credential",
      "or a session token, or touch any product table.",
      "",
      "Point the API at it with ADMIN_PEOPLE_DATABASE_URL, using this role and",
      "password. It must differ from every other connection string."
    ],
    disabled:
      "Reads through other roles are unaffected; suspension, revocation and enrollment\n" +
      "tickets will fail until it is provisioned again. Signing in and enrolling one's\n" +
      "own key are unaffected."
  },
  positionals[0]
);

process.exit(exitCode);
