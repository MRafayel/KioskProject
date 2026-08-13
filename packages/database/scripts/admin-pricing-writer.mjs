#!/usr/bin/env node
/**
 * Provision and verify the role that publishes a tariff.
 *
 * The sixth least-privilege connection into this database, and the only one that
 * can change what a customer will be charged. It shares `admin-column-role.mjs`
 * with the people role, because both are defined by a column list rather than by
 * the absence of one: this role holds UPDATE on `status`, `archived_at` and
 * `updated_at` of `pricing_rule_sets`, and on nothing else anywhere — so it can
 * retire the tariff it is replacing and cannot edit any tariff at all.
 *
 * A compromised admin backend holding this credential can change the prices —
 * that is what the credential is for, and this system has one Admin, so there is
 * no second person standing between it and the tariff. What it cannot do is
 * change them quietly. Every tariff it writes must, at COMMIT, be accounted for
 * by a row in `admin_change_executions` naming an active Admin and carrying the
 * digest of exactly those numbers; that table takes no UPDATE or DELETE from any
 * role, including its owner.
 *
 * Usage:
 *
 *   ADMIN_PRICING_DATABASE_PASSWORD=... node scripts/admin-pricing-writer.mjs provision
 *   node scripts/admin-pricing-writer.mjs verify
 *   node scripts/admin-pricing-writer.mjs disable
 *
 * `disable` is the break-glass for prices: it stops any tariff being published
 * without touching anything else the control plane does, and without dropping
 * the grants, so it can be handed back afterwards. Quoting is unaffected — the
 * kiosk reads the tariff through the application connection and does not know
 * this role exists.
 */

import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";

import { config as loadDotenv } from "dotenv";

import { runColumnRoleCommand } from "./admin-column-role.mjs";
import {
  ADMIN_PRICING_WRITER_ROLE,
  FORBIDDEN_TABLES,
  INSERTABLE_TABLES,
  READABLE_TABLES,
  ROLE_SETTINGS,
  UPDATABLE_COLUMNS
} from "./admin-pricing-writer-matrix.mjs";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));
loadDotenv({ path: `${workspaceDirectory}/.env`, override: false, quiet: true });

const { positionals } = parseArgs({ allowPositionals: true, options: {} });

const exitCode = await runColumnRoleCommand(
  {
    role: ADMIN_PRICING_WRITER_ROLE,
    passwordVariable: "ADMIN_PRICING_DATABASE_PASSWORD",
    urlVariable: "ADMIN_PRICING_DATABASE_URL",
    matrixPath: "packages/database/scripts/admin-pricing-writer-matrix.mjs",
    command: "pnpm db:admin-pricing-writer",
    insertable: INSERTABLE_TABLES,
    updatable: UPDATABLE_COLUMNS,
    readable: READABLE_TABLES,
    forbidden: FORBIDDEN_TABLES,
    settings: ROLE_SETTINGS,
    summary: [
      "It cannot edit a tariff, un-archive one, or read or alter a quote. A deferred",
      "trigger refuses, at COMMIT, any tariff it publishes that no publication record",
      "accounts for, or that differs from the numbers that record carries.",
      "",
      "Point the API at it with ADMIN_PRICING_DATABASE_URL, using this role and",
      "password. It must differ from every other connection string."
    ],
    disabled:
      "No tariff can be published until it is provisioned again. Quoting is unaffected,\n" +
      "and the tariff in force stays in force."
  },
  positionals[0]
);

process.exit(exitCode);
