#!/usr/bin/env node
/**
 * Provision and verify the control plane's write role.
 *
 * The read role from Phase 2 answers "what can the dashboard see". This one
 * answers the harder question: what can it *change*. The answer is a handful of
 * INSERTs and nothing else, and it is worth more as a property of the
 * connection than as a property of the code, because code is reviewed once and
 * a role is enforced on every statement forever.
 *
 * A command-line tool rather than a migration, for the same reason as its
 * siblings: creating a role needs privileges the application role does not have
 * and should never have, and a managed PostgreSQL would fail a deploy over a
 * grant. Provisioning a role is an operator action, like creating the database.
 *
 * Usage:
 *
 *   ADMIN_WRITE_DATABASE_PASSWORD=... node scripts/admin-writer.mjs provision
 *   node scripts/admin-writer.mjs provision # reuses ADMIN_WRITE_DATABASE_URL
 *   node scripts/admin-writer.mjs verify
 *   node scripts/admin-writer.mjs disable
 *
 * Run `provision` again after every migration and `verify` in the deployment
 * pipeline. A new table is forbidden by default and forces a decision here.
 *
 * Money is not in this role. `refund.authorize` writes through
 * `printing_kiosk_admin_refund_writer`, provisioned by `admin-refund-writer.mjs`
 * — see `admin-refund-writer-matrix.mjs` for why it is separate.
 */

import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { config as loadDotenv } from "dotenv";

import { runAppendRoleCommand } from "./admin-append-role.mjs";
import {
  ADMIN_WRITER_ROLE,
  FORBIDDEN_TABLES,
  INSERTABLE_TABLES,
  READABLE_TABLES,
  ROLE_SETTINGS,
  UPDATABLE_COLUMNS
} from "./admin-writer-matrix.mjs";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
loadDotenv({ path: `${workspaceDirectory}/.env`, override: false, quiet: true });

const { positionals } = parseArgs({ allowPositionals: true, options: {} });

const exitCode = await runAppendRoleCommand(
  {
    role: ADMIN_WRITER_ROLE,
    passwordVariable: "ADMIN_WRITE_DATABASE_PASSWORD",
    urlVariable: "ADMIN_WRITE_DATABASE_URL",
    matrixPath: "scripts/admin-writer-matrix.mjs",
    command: "pnpm db:admin-writer",
    insertable: INSERTABLE_TABLES,
    updatable: UPDATABLE_COLUMNS,
    readable: READABLE_TABLES,
    forbidden: FORBIDDEN_TABLES,
    settings: ROLE_SETTINGS,
    summary:
      "Point the API at it with ADMIN_WRITE_DATABASE_URL, using this role and\n" +
      "password. Do not reuse the application, reader or refund connection string."
  },
  positionals[0]
);

process.exit(exitCode);
