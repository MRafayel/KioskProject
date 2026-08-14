/**
 * How long the dashboard's reads take against a database with real volume, and
 * what they cost the print path while they run.
 *
 * Phase 0 §17 promised that dashboard queries would not degrade printing, and
 * Phase 2 bounded every list to satisfy it. Nothing had measured either claim
 * until Phase 6, which is the gap this closes: the bounds were reviewed, the
 * plans were not, and "bounded" and "fast" are different properties — a query
 * that returns fifty rows can still read a million to find them.
 *
 * What it measures is the real thing. It builds `AdminObservabilityService`
 * with the real admin read pool, so every query is the one the API issues,
 * planned by the same role with the same statement timeout. There is no
 * reimplementation of the SQL here to drift from what runs.
 *
 * Usage, from the repository root:
 *
 *   pnpm db:admin-benchmark seed --sessions 50000
 *   pnpm db:admin-benchmark measure --iterations 20
 *   pnpm db:admin-benchmark clean
 *
 * `seed` is additive and tags everything it writes with a kiosk id prefix, so
 * `clean` removes exactly what it made and nothing else. It refuses to run
 * against anything but a loopback database: this writes tens of thousands of
 * rows and the safety check is the same one the integration suite uses.
 */

import { performance } from "node:perf_hooks";
import process from "node:process";
import { parseArgs } from "node:util";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";
import { createAdminReadClient, createDatabaseClient } from "@printing-kiosk/database";

import {
  AdminObservabilityService,
  type AdminReadScope
} from "../src/modules/admin/observability.js";
import { asAdminReadDatabase } from "../src/modules/admin/read-database.js";

const BENCHMARK_KIOSK_PREFIX = "kiosk_bench_";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Which seeded sessions end badly, decided from the session's own identifier.
 *
 * A hash rather than a counter, so every statement in the seed can re-derive
 * the same answer without carrying a column for it — and so the exceptional
 * rows are scattered through the table the way they would be in production
 * rather than clustered at one end of an index.
 *
 * About one session in sixteen needs recovery, and one in two hundred and
 * fifty-six leaves a dead-lettered cleanup. Both are higher than a real estate
 * would see, which is the right direction for a benchmark: the screens that
 * exist to surface exceptions get exceptions to surface.
 */
const NEEDS_RECOVERY = `substr(md5(p."id"::text), 1, 1) = '0'`;
const CLEANUP_DEAD_LETTERED = `substr(md5(p."id"::text), 1, 2) = '00'`;

/**
 * The tables whose size is what makes a plan behave one way or another.
 *
 * Declared here with the other module constants rather than beside the function
 * that uses it: the command switch below runs at module evaluation, and a `const`
 * declared after it is still in its temporal dead zone when it does.
 */
const COUNTED_TABLES = [
  "print_sessions",
  "print_jobs",
  "payments",
  "session_events",
  "audit_events",
  "cleanup_runs"
] as const;

type Volumes = Record<(typeof COUNTED_TABLES)[number], number>;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sessions: { type: "string", default: "50000" },
    kiosks: { type: "string", default: "6" },
    iterations: { type: "string", default: "20" }
  }
});

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment(process.env);
assertLoopback(environment.DATABASE_URL);

const database = createDatabaseClient(environment.DATABASE_URL);
const readClient = createAdminReadClient(
  environment.ADMIN_READ_DATABASE_URL ?? environment.DATABASE_URL
);
const observability = new AdminObservabilityService({
  database: asAdminReadDatabase(readClient),
  clock: { now: () => new Date() },
  // Nothing may be answered from a cache: the point is to time the query.
  overviewCacheMilliseconds: 0
});

try {
  switch (positionals[0]) {
    case "seed":
      await seed(Number(values.sessions), Number(values.kiosks));
      break;
    case "measure":
      await measure(Number(values.iterations));
      break;
    case "clean":
      await clean();
      break;
    default:
      process.stderr.write(
        "Usage: admin-read-benchmark.ts <seed|measure|clean> [--sessions N] [--kiosks N] [--iterations N]\n"
      );
      process.exitCode = 1;
  }
} finally {
  await database.$disconnect();
  await readClient.$disconnect();
}

/**
 * Write a plausible year of trading.
 *
 * The shapes match what the product actually writes — a settled session with a
 * settings revision, a quote, a captured payment and a print job — because a
 * query plan is only as honest as the data distribution it was made against.
 *
 * It is written in waves of one session per kiosk, and that is not an
 * optimisation but an invariant. `print_sessions_one_active_per_kiosk_idx`
 * permits exactly one non-terminal session per kiosk, and
 * `print_jobs_require_capture` refuses a print job whose session is not `PAID`
 * or `PRINTING` — so a print job can only be created while its session is the
 * one live session on its kiosk. Seeding around either would produce rows the
 * product could never make, and a benchmark against impossible data measures
 * nothing. Within a wave every insert is set-based; the rows that hang off a
 * settled session are written once at the end.
 */
async function seed(sessions: number, kiosks: number): Promise<void> {
  if (!Number.isInteger(sessions) || sessions < 1) fail("--sessions must be a positive integer.");
  if (!Number.isInteger(kiosks) || kiosks < 1) fail("--kiosks must be a positive integer.");

  const ruleSet = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED" },
    select: { id: true, version: true }
  });
  if (!ruleSet) fail("No published tariff. Run the development seed first.");

  process.stdout.write(`Seeding ${sessions} sessions across ${kiosks} kiosks...\n`);
  const startedAt = performance.now();

  for (let index = 0; index < kiosks; index += 1) {
    const id = `${BENCHMARK_KIOSK_PREFIX}${index}`;
    await database.kiosk.upsert({
      where: { id },
      update: {},
      create: {
        id,
        publicCode: id.toUpperCase(),
        name: `Benchmark ${index}`,
        capabilities: { paperSizes: ["A4"] },
        lastSeenAt: new Date()
      }
    });
  }

  // The live wave is identified by being the only `PAID` sessions on these
  // kiosks, which the unique index above guarantees. Every statement inside a
  // wave therefore filters on that and needs no marker column of its own.
  const live = `p."kiosk_id" LIKE '${BENCHMARK_KIOSK_PREFIX}%' AND p."state" = 'PAID'`;

  for (let written = 0; written < sessions; written += kiosks) {
    const wave = Math.min(kiosks, sessions - written);
    // An hour of headroom, so that the settled timestamps derived from this —
    // the completion, the audit row, the cleanup run — all land in the past.
    // Rows dated in the future are not data the product could produce, and they
    // sit at the top of every list ordered by time.
    const ageMinutes = written + 60;

    await database.$executeRawUnsafe(
      `
      INSERT INTO "print_sessions" (
        "id", "public_id", "kiosk_id", "locale", "state", "state_version",
        "event_sequence", "current_settings_revision", "idle_expires_at",
        "hard_expires_at", "cleanup_status", "created_at", "updated_at"
      )
      SELECT
        gen_random_uuid(),
        'ps_bench_' || replace(gen_random_uuid()::text, '-', ''),
        '${BENCHMARK_KIOSK_PREFIX}' || (s.n - 1),
        'en', 'PAID', 1, 4, 1,
        now() - ($2 || ' minutes')::interval + interval '30 minutes',
        now() - ($2 || ' minutes')::interval + interval '60 minutes',
        'NOT_DUE',
        now() - ($2 || ' minutes')::interval,
        now() - ($2 || ' minutes')::interval
      FROM generate_series(1, $1) AS s(n)
    `,
      wave,
      ageMinutes
    );

    // The settings a quote is priced against. A quote's foreign key points at
    // one, and its manifest hash has to be the same hash — both are derived
    // from the session id here so the two always agree.
    await database.$executeRawUnsafe(`
      INSERT INTO "print_setting_revisions" (
        "id", "session_id", "revision", "copies", "duplex", "paper_size",
        "orientation", "scaling", "collate", "color_mode", "selections",
        "selected_pages", "printed_sides", "physical_sheets", "capability_version",
        "manifest_hash", "created_by_actor_type", "created_by_actor_id", "created_at"
      )
      SELECT
        gen_random_uuid(), p."id", 1, 1, 'SIMPLEX', 'A4', 'PORTRAIT', 'FIT', true,
        'MONOCHROME',
        jsonb_build_array(jsonb_build_object(
          'fileId', gen_random_uuid(),
          'contentSha256', encode(sha256((p."id"::text || 'file')::bytea), 'hex'),
          'pages', '1-3'
        )),
        3, 3, 3, 1, encode(sha256(p."id"::text::bytea), 'hex'), 'KIOSK', p."kiosk_id",
        p."created_at"
      FROM "print_sessions" AS p
      WHERE ${live}
    `);

    // The payment's amount has to match its quote exactly — a trigger says so —
    // which is the kind of invariant that makes synthetic data worth generating
    // through SQL the database will still check.
    await database.$executeRawUnsafe(
      `
      INSERT INTO "price_quotes" (
        "id", "session_id", "settings_revision", "manifest_hash", "rule_set_id",
        "pricing_version", "status", "currency", "currency_exponent",
        "selected_pages", "printed_sides", "physical_sheets",
        "print_amount_minor", "duplex_adjustment_minor", "service_fee_minor",
        "minimum_adjustment_minor", "subtotal_minor", "tax_minor", "total_minor",
        "created_at", "expires_at"
      )
      SELECT
        gen_random_uuid(), p."id", 1, encode(sha256(p."id"::text::bytea), 'hex'),
        $1, $2, 'ACTIVE', 'AMD', 2, 3, 3, 3,
        15000, 0, 0, 0, 15000, 3000, 18000,
        p."created_at", p."created_at" + interval '30 minutes'
      FROM "print_sessions" AS p
      WHERE ${live}
    `,
      ruleSet.id,
      ruleSet.version
    );

    await database.$executeRawUnsafe(`
      INSERT INTO "payments" (
        "id", "session_id", "quote_id", "provider", "provider_intent_id", "status",
        "applied_to_session", "amount_minor", "currency", "currency_exponent",
        "settings_revision", "manifest_hash", "created_by_actor_type",
        "created_by_actor_id", "expires_at", "created_at", "updated_at", "captured_at"
      )
      SELECT
        gen_random_uuid(), q."session_id", q."id", 'MOCK',
        'intent_bench_' || q."id", 'CAPTURED', true, q."total_minor", q."currency",
        q."currency_exponent", 1, q."manifest_hash", 'KIOSK', 'benchmark',
        q."created_at" + interval '20 minutes', q."created_at", q."created_at",
        q."created_at" + interval '5 minutes'
      FROM "price_quotes" AS q
      JOIN "print_sessions" AS p ON p."id" = q."session_id"
      WHERE ${live}
    `);

    await database.$executeRawUnsafe(`
      INSERT INTO "print_jobs" (
        "id", "session_id", "kiosk_id", "quote_id", "payment_id", "settings_revision",
        "settings_manifest_hash", "job_manifest", "job_manifest_hash", "status",
        "copies", "printed_sides", "physical_sheets", "sheets_produced",
        "result_confidence", "failure_code", "dispatch_attempts", "deadline_at",
        "created_by_actor_type", "created_by_actor_id", "created_at", "updated_at",
        "dispatched_at", "started_at", "completed_at", "failed_at"
      )
      SELECT
        gen_random_uuid(), p."id", p."kiosk_id", q."id", m."id", 1,
        q."manifest_hash", '{"documents":[]}'::jsonb,
        encode(sha256(m."id"::text::bytea), 'hex'),
        CASE WHEN ${NEEDS_RECOVERY} THEN 'RECOVERY_REQUIRED' ELSE 'COMPLETED' END,
        1, 3, 3,
        CASE WHEN ${NEEDS_RECOVERY} THEN NULL ELSE 3 END,
        CASE WHEN ${NEEDS_RECOVERY} THEN 'UNCONFIRMED' ELSE 'CONFIRMED' END,
        CASE WHEN ${NEEDS_RECOVERY} THEN 'DEVICE_RESULT_UNCONFIRMED' ELSE NULL END,
        1, p."created_at" + interval '25 minutes', 'KIOSK', 'benchmark',
        p."created_at" + interval '6 minutes', p."created_at" + interval '6 minutes',
        p."created_at" + interval '7 minutes', p."created_at" + interval '8 minutes',
        CASE WHEN ${NEEDS_RECOVERY} THEN NULL
             ELSE p."created_at" + interval '10 minutes' END,
        CASE WHEN ${NEEDS_RECOVERY} THEN p."created_at" + interval '10 minutes'
             ELSE NULL END
      FROM "print_sessions" AS p
      JOIN "price_quotes" AS q ON q."session_id" = p."id"
      JOIN "payments" AS m ON m."session_id" = p."id"
      WHERE ${live}
    `);

    // Settling is what frees the kiosk for the next wave, exactly as it frees
    // it for the next customer.
    await database.$executeRawUnsafe(`
      UPDATE "print_sessions" AS p
         SET "state" = CASE WHEN ${NEEDS_RECOVERY} THEN 'RECOVERY_REQUIRED' ELSE 'COMPLETED' END,
             "terminal_reason" = CASE WHEN ${NEEDS_RECOVERY}
                                      THEN 'PRINT_UNCONFIRMED' ELSE 'PRINT_COMPLETED' END,
             "completed_at" = p."created_at" + interval '10 minutes',
             "cleanup_status" = CASE WHEN ${CLEANUP_DEAD_LETTERED}
                                     THEN 'DEAD_LETTER' ELSE 'DONE' END,
             "cleanup_due_at" = p."created_at" + interval '25 minutes',
             "state_version" = 2,
             "updated_at" = p."created_at" + interval '10 minutes'
       WHERE ${live}
    `);

    if (written > 0 && written % 5_000 < kiosks) {
      process.stdout.write(`  ${written.toLocaleString()} sessions...\n`);
    }
  }

  // Four events per session, which is what the timeline reads and what the
  // error centre groups over.
  await database.$executeRawUnsafe(`
    INSERT INTO "session_events" (
      "id", "session_id", "kiosk_id", "sequence", "type", "payload", "occurred_at"
    )
    SELECT
      gen_random_uuid(), p."id", p."kiosk_id", e.n,
      (ARRAY['SESSION_CREATED','FILES_UPLOADED','PAYMENT_CAPTURED','PRINT_SETTLED'])[e.n],
      '{}'::jsonb, p."created_at" + (e.n || ' minutes')::interval
    FROM "print_sessions" AS p
    CROSS JOIN generate_series(1, 4) AS e(n)
    WHERE p."kiosk_id" LIKE '${BENCHMARK_KIOSK_PREFIX}%'
      AND NOT EXISTS (SELECT 1 FROM "session_events" AS v WHERE v."session_id" = p."id")
  `);

  // A failed agent command on one session in ten, so the error centre has
  // something to group rather than an empty window.
  await database.$executeRawUnsafe(`
    INSERT INTO "agent_commands" (
      "id", "kiosk_id", "session_id", "print_job_id", "operation_id", "type",
      "status", "payload", "attempts", "expires_at", "created_at", "updated_at",
      "result_code", "completed_at"
    )
    SELECT
      gen_random_uuid(), j."kiosk_id", j."session_id", j."id", gen_random_uuid(),
      'PRINT', 'FAILED', '{"documents":[]}'::jsonb, 1,
      j."created_at" + interval '25 minutes', j."created_at", j."created_at",
      'DEVICE_UNREACHABLE', j."created_at" + interval '9 minutes'
    FROM "print_jobs" AS j
    JOIN "print_sessions" AS p ON p."id" = j."session_id"
    WHERE p."kiosk_id" LIKE '${BENCHMARK_KIOSK_PREFIX}%'
      AND j."status" = 'RECOVERY_REQUIRED'
      AND NOT EXISTS (SELECT 1 FROM "agent_commands" AS c WHERE c."session_id" = p."id")
  `);

  // An audit row per session, so the log the panel pages through is the size a
  // year of operation would make it.
  await database.$executeRawUnsafe(`
    INSERT INTO "audit_events" (
      "id", "occurred_at", "actor_type", "actor_id", "action", "outcome",
      "kiosk_id", "session_id", "metadata"
    )
    SELECT
      gen_random_uuid(), p."created_at" + interval '11 minutes', 'KIOSK',
      p."kiosk_id", 'print_job.settled', 'SUCCESS', p."kiosk_id", p."id",
      '{"sheetsProduced": 3}'::jsonb
    FROM "print_sessions" AS p
    WHERE p."kiosk_id" LIKE '${BENCHMARK_KIOSK_PREFIX}%'
      AND NOT EXISTS (
        SELECT 1 FROM "audit_events" AS a
         WHERE a."session_id" = p."id" AND a."action" = 'print_job.settled'
      )
  `);

  // A cleanup run for each, dead-lettered on the sessions marked so above.
  await database.$executeRawUnsafe(`
    INSERT INTO "cleanup_runs" (
      "id", "session_id", "reason", "status", "checkpoint", "attempts",
      "available_at", "created_at", "updated_at", "completed_at",
      "dead_lettered_at", "last_error_code"
    )
    SELECT
      gen_random_uuid(), p."id", 'SESSION_SETTLED',
      CASE WHEN p."cleanup_status" = 'DEAD_LETTER' THEN 'DEAD_LETTER' ELSE 'DONE' END,
      CASE WHEN p."cleanup_status" = 'DEAD_LETTER' THEN 'ARTIFACTS_DELETED' ELSE 'COMPLETED' END,
      CASE WHEN p."cleanup_status" = 'DEAD_LETTER' THEN 8 ELSE 1 END,
      p."created_at" + interval '30 minutes', p."created_at", p."created_at",
      CASE WHEN p."cleanup_status" = 'DEAD_LETTER'
           THEN NULL ELSE p."created_at" + interval '35 minutes' END,
      CASE WHEN p."cleanup_status" = 'DEAD_LETTER'
           THEN p."created_at" + interval '40 minutes' ELSE NULL END,
      CASE WHEN p."cleanup_status" = 'DEAD_LETTER' THEN 'STORAGE_UNAVAILABLE' ELSE NULL END
    FROM "print_sessions" AS p
    WHERE p."kiosk_id" LIKE '${BENCHMARK_KIOSK_PREFIX}%'
      AND NOT EXISTS (SELECT 1 FROM "cleanup_runs" AS r WHERE r."session_id" = p."id")
  `);

  await database.$executeRawUnsafe(`ANALYZE`);

  const counts = await volumes();
  process.stdout.write(
    `Seeded in ${((performance.now() - startedAt) / 1000).toFixed(1)}s.\n` +
      Object.entries(counts)
        .map(([table, count]) => `  ${table.padEnd(20)} ${count.toLocaleString()}`)
        .join("\n") +
      "\n"
  );
}

/**
 * Time every read the dashboard performs, as the dashboard performs it.
 *
 * Both scopes are measured. An unrestricted Admin reads across the estate; an
 * Operator's reads carry a kiosk filter, and whether that filter helps or hurts
 * is a question about indexes rather than about intent.
 *
 * The reported number that matters is p95, not the mean: a dashboard that is
 * usually fast and occasionally holds a connection for two seconds is the one
 * that competes with a paid print job.
 */
async function measure(iterations: number): Promise<void> {
  if (!Number.isInteger(iterations) || iterations < 1) fail("--iterations must be positive.");

  const counts = await volumes();
  if (counts.print_sessions === 0) fail("Nothing to measure. Run `seed` first.");

  const kiosk = `${BENCHMARK_KIOSK_PREFIX}0`;
  const scopes: Array<[string, AdminReadScope]> = [
    ["admin", { kioskIds: null }],
    ["operator", { kioskIds: [kiosk] }]
  ];

  const sample = await database.printSession.findFirst({
    where: { kioskId: { startsWith: BENCHMARK_KIOSK_PREFIX } },
    select: { id: true, printJobs: { select: { id: true }, take: 1 } }
  });
  if (!sample) fail("Seeded sessions are missing.");

  process.stdout.write(
    `\nVolume: ${counts.print_sessions.toLocaleString()} sessions, ` +
      `${counts.print_jobs.toLocaleString()} print jobs, ` +
      `${counts.audit_events.toLocaleString()} audit rows.\n` +
      `Each figure is ${iterations} runs on the admin read role.\n\n` +
      `${"read".padEnd(28)}${"scope".padEnd(10)}${"p50".padStart(9)}${"p95".padStart(9)}${"max".padStart(9)}\n`
  );

  for (const [scopeName, scope] of scopes) {
    const reads: Array<[string, () => Promise<unknown>]> = [
      ["overview", () => observability.overview(scope)],
      ["kiosks", () => observability.kiosks(scope)],
      ["sessions", () => observability.sessions(scope, {})],
      ["session detail", () => observability.session(scope, sample.id)],
      ["timeline", () => observability.timeline(scope, sample.id, undefined)],
      ["documents", () => observability.documents(scope, sample.id)],
      ["print jobs", () => observability.printJobs(scope, {})],
      [
        "print job detail",
        () => observability.printJob(scope, sample.printJobs[0]?.id ?? sample.id, true)
      ],
      ["payments", () => observability.payments(scope, { includeProviderReference: true })],
      ["refunds", () => observability.refunds(scope, { unsettledOnly: true })],
      ["refund queue", () => observability.refundQueue(scope, {})],
      ["retention", () => observability.retention(scope, { problemsOnly: true })],
      ["errors (24h)", () => observability.errors(scope, 24)],
      ["errors (168h)", () => observability.errors(scope, 168)],
      ["audit", () => observability.audit(scope, { selfActorId: null })]
    ];

    for (const [name, run] of reads) {
      const timings: number[] = [];
      for (let index = 0; index < iterations; index += 1) {
        const startedAt = performance.now();
        await run();
        timings.push(performance.now() - startedAt);
      }
      timings.sort((left, right) => left - right);
      process.stdout.write(
        name.padEnd(28) +
          scopeName.padEnd(10) +
          `${percentile(timings, 50).toFixed(1)}ms`.padStart(9) +
          `${percentile(timings, 95).toFixed(1)}ms`.padStart(9) +
          `${(timings.at(-1) ?? 0).toFixed(1)}ms`.padStart(9) +
          "\n"
      );
    }
    process.stdout.write("\n");
  }

  process.stdout.write(
    "The reader role carries statement_timeout=5s, so anything approaching it\n" +
      "would be cancelled by the database rather than left to compete with a\n" +
      "print job for a connection.\n"
  );
}

/** Remove everything `seed` wrote, and nothing else. */
async function clean(): Promise<void> {
  const sessions = await database.printSession.findMany({
    where: { kioskId: { startsWith: BENCHMARK_KIOSK_PREFIX } },
    select: { id: true }
  });
  const ids = sessions.map((session) => session.id);
  process.stdout.write(`Removing ${ids.length} benchmark sessions...\n`);

  if (ids.length > 0) {
    // The audit log is append-only for everybody, so its rows stay. They are
    // tagged with a benchmark kiosk id and are harmless; saying so is better
    // than pretending the teardown is complete.
    await database.$executeRawUnsafe(
      `DELETE FROM "agent_commands" WHERE "kiosk_id" LIKE '${BENCHMARK_KIOSK_PREFIX}%'`
    );
    await database.$executeRawUnsafe(
      `DELETE FROM "print_jobs" WHERE "kiosk_id" LIKE '${BENCHMARK_KIOSK_PREFIX}%'`
    );
    await database.cleanupRun.deleteMany({ where: { sessionId: { in: ids } } });
    await database.sessionEvent.deleteMany({ where: { sessionId: { in: ids } } });
    await database.payment.deleteMany({ where: { sessionId: { in: ids } } });
    await database.priceQuote.deleteMany({ where: { sessionId: { in: ids } } });
    await database.printSession.deleteMany({ where: { id: { in: ids } } });
  }

  await database.kiosk.deleteMany({ where: { id: { startsWith: BENCHMARK_KIOSK_PREFIX } } });
  await database.$executeRawUnsafe(`ANALYZE`);
  process.stdout.write(
    "Done. Audit rows written by the benchmark remain, because the log is\n" +
      "append-only for every role in this system.\n"
  );
}

async function volumes(): Promise<Volumes> {
  const rows = await database.$queryRawUnsafe<Array<Record<string, bigint>>>(`
    SELECT
      ${COUNTED_TABLES.map((table) => `(SELECT count(*) FROM "${table}") AS "${table}"`).join(",\n      ")}
  `);
  const row = rows[0] ?? {};
  const counts = {} as Volumes;
  for (const table of COUNTED_TABLES) counts[table] = Number(row[table] ?? 0);
  return counts;
}

function percentile(sorted: readonly number[], percent: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function assertLoopback(url: string): void {
  const parsed = new URL(url);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    fail(
      "This writes tens of thousands of rows and refuses to run against anything " +
        "but a loopback database."
    );
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
