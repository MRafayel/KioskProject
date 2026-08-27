#!/usr/bin/env node
/**
 * Provision and verify the role that can put money back.
 *
 * There are now four connections into this database with four different sets of
 * grants: the application, the control plane's reader, its writer, and this
 * one. That is not ceremony. It is the only way "which connection can pay a
 * customer" stays answerable by reading a grant list after the control plane
 * gained the ability to do it.
 *
 * Usage:
 *
 *   ADMIN_REFUND_DATABASE_PASSWORD=... node scripts/admin-refund-writer.mjs provision
 *   node scripts/admin-refund-writer.mjs provision # reuses ADMIN_REFUND_DATABASE_URL
 *   node scripts/admin-refund-writer.mjs verify
 *   node scripts/admin-refund-writer.mjs disable
 *
 * `disable` is the break-glass here: it takes away the panel's ability to
 * authorize refunds without touching anything else the control plane does, and
 * without dropping the grants, so it can be handed back afterwards.
 *
 * Run `provision` again after every migration and `verify` in the deployment
 * pipeline. A new table is forbidden by default and forces a decision in
 * `admin-refund-writer-matrix.mjs`.
 */

import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { config as loadDotenv } from "dotenv";

import { runAppendRoleCommand } from "./admin-append-role.mjs";
import {
  ADMIN_REFUND_WRITER_ROLE,
  FORBIDDEN_TABLES,
  INSERTABLE_TABLES,
  READABLE_TABLES,
  ROLE_SETTINGS
} from "./admin-refund-writer-matrix.mjs";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
loadDotenv({ path: `${workspaceDirectory}/.env`, override: false, quiet: true });

const { positionals } = parseArgs({ allowPositionals: true, options: {} });

const exitCode = await runAppendRoleCommand(
  {
    role: ADMIN_REFUND_WRITER_ROLE,
    passwordVariable: "ADMIN_REFUND_DATABASE_PASSWORD",
    urlVariable: "ADMIN_REFUND_DATABASE_URL",
    matrixPath: "scripts/admin-refund-writer-matrix.mjs",
    command: "pnpm db:admin-refund-writer",
    insertable: INSERTABLE_TABLES,
    readable: READABLE_TABLES,
    forbidden: FORBIDDEN_TABLES,
    settings: ROLE_SETTINGS,
    summary:
      "Point the API at it with ADMIN_REFUND_DATABASE_URL, using this role and\n" +
      "password. It must differ from every other connection string: sharing one\n" +
      "would hand the whole control plane the only grant that can pay somebody."
  },
  positionals[0]
);

process.exit(exitCode);
