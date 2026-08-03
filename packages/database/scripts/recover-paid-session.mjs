import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { config as loadDotenv } from "dotenv";
import pg from "pg";

const packageDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceDirectory = dirname(dirname(packageDirectory));

loadDotenv({
  path: join(workspaceDirectory, ".env"),
  override: false,
  quiet: true
});

const argumentsAfterSeparator = process.argv.slice(2).filter((argument) => argument !== "--");
const listOnly = argumentsAfterSeparator.includes("--list");
const sessionId = argumentsAfterSeparator.find((argument) => argument !== "--list");
if (
  !listOnly &&
  (!sessionId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId))
) {
  throw new Error(
    "Usage:\n" +
      "  pnpm db:recover-paid-session -- --list\n" +
      "  pnpm db:recover-paid-session -- <session-uuid>\n" +
      "Pass the exact PAID development session ID shown by the API or database."
  );
}

if (process.env.NODE_ENV === "production") {
  throw new Error("PAID_SESSION_RECOVERY_REFUSED_IN_PRODUCTION");
}
if (process.env.PAYMENT_PROVIDER?.toLowerCase() !== "mock") {
  throw new Error("PAID_SESSION_RECOVERY_REQUIRES_MOCK_PAYMENT_PROVIDER");
}

const databaseUrl = new URL(
  process.env.DATABASE_URL ??
    "postgresql://printing_kiosk:development-only@localhost:5432/printing_kiosk"
);
if (!["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname)) {
  throw new Error("PAID_SESSION_RECOVERY_REQUIRES_LOCAL_DATABASE");
}

const client = new pg.Client({ connectionString: databaseUrl.href });

try {
  await client.connect();
  if (listOnly) {
    const paidSessions = await client.query(
      `SELECT s."id", s."public_id", s."state_version", s."updated_at",
              p."id" AS "payment_id", p."provider"
         FROM "print_sessions" s
         JOIN "payments" p ON p."session_id" = s."id"
          AND p."status" = 'CAPTURED' AND p."applied_to_session" = true
        WHERE s."state" = 'PAID'
        ORDER BY s."updated_at" DESC`
    );
    if (paidSessions.rowCount === 0) {
      process.stdout.write("No PAID sessions with a captured payment were found.\n");
    } else {
      for (const session of paidSessions.rows) {
        process.stdout.write(
          `${session.id}  ${session.public_id}  version=${session.state_version}  ` +
            `provider=${session.provider}  updated=${session.updated_at.toISOString()}\n`
        );
      }
    }
  } else {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT "id", "kiosk_id", "state", "state_version", "event_sequence", "terminal_reason"
       FROM "print_sessions"
      WHERE "id" = $1::uuid
      FOR UPDATE`,
      [sessionId]
    );
    if (sessionResult.rowCount !== 1) throw new Error("SESSION_NOT_FOUND");

    const session = sessionResult.rows[0];
    if (
      session.state === "COMPLETED" &&
      session.terminal_reason === "DEVELOPMENT_MOCK_PRINT_COMPLETED"
    ) {
      await client.query("ROLLBACK");
      process.stdout.write(`Session ${sessionId} was already recovered.\n`);
      process.exitCode = 0;
    } else {
      if (session.state !== "PAID") {
        throw new Error(`SESSION_MUST_BE_PAID_CURRENT_STATE_${session.state}`);
      }

      const paymentResult = await client.query(
        `SELECT "id", "provider", "status"
         FROM "payments"
        WHERE "session_id" = $1::uuid
          AND "status" = 'CAPTURED' AND "applied_to_session" = true
        FOR UPDATE`,
        [sessionId]
      );
      if (paymentResult.rowCount !== 1) {
        throw new Error("EXACTLY_ONE_CAPTURED_PAYMENT_REQUIRED");
      }
      if (paymentResult.rows[0].provider !== "MOCK") {
        throw new Error("CAPTURED_PAYMENT_MUST_USE_MOCK_PROVIDER");
      }

      const now = new Date();
      const printingVersion = Number(session.state_version) + 1;
      const printingSequence = Number(session.event_sequence) + 1;
      const completedVersion = printingVersion + 1;
      const completedSequence = printingSequence + 1;

      const printing = await client.query(
        `UPDATE "print_sessions"
          SET "state" = 'PRINTING',
              "state_version" = $2,
              "event_sequence" = $3,
              "updated_at" = $4
        WHERE "id" = $1::uuid AND "state" = 'PAID' AND "state_version" = $5`,
        [sessionId, printingVersion, printingSequence, now, session.state_version]
      );
      if (printing.rowCount !== 1) throw new Error("SESSION_CHANGED_DURING_RECOVERY");

      await client.query(
        `INSERT INTO "outbox_events"
        ("id", "aggregate_type", "aggregate_id", "sequence", "type", "payload", "status", "available_at")
       VALUES ($1::uuid, 'PRINT_SESSION', $2::uuid, $3, 'print.started', $4::jsonb, 'PENDING', $5)`,
        [
          randomUUID(),
          sessionId,
          printingSequence,
          JSON.stringify({ sessionId, state: "PRINTING", version: printingVersion }),
          now
        ]
      );

      const completed = await client.query(
        `UPDATE "print_sessions"
          SET "state" = 'COMPLETED',
              "state_version" = $2,
              "event_sequence" = $3,
              "terminal_reason" = 'DEVELOPMENT_MOCK_PRINT_COMPLETED',
              "completed_at" = $4,
              "updated_at" = $4
        WHERE "id" = $1::uuid AND "state" = 'PRINTING' AND "state_version" = $5`,
        [sessionId, completedVersion, completedSequence, now, printingVersion]
      );
      if (completed.rowCount !== 1) throw new Error("SESSION_COMPLETION_LOST_RACE");

      await client.query(
        `INSERT INTO "outbox_events"
        ("id", "aggregate_type", "aggregate_id", "sequence", "type", "payload", "status", "available_at")
       VALUES ($1::uuid, 'PRINT_SESSION', $2::uuid, $3, 'session.completed', $4::jsonb, 'PENDING', $5)`,
        [
          randomUUID(),
          sessionId,
          completedSequence,
          JSON.stringify({ sessionId, state: "COMPLETED", version: completedVersion }),
          now
        ]
      );

      await client.query(
        `UPDATE "session_upload_grants"
          SET "status" = 'REVOKED', "revoked_at" = $2
        WHERE "session_id" = $1::uuid AND "status" IN ('ACTIVE', 'CLAIMED')`,
        [sessionId, now]
      );
      await client.query(
        `UPDATE "mobile_clients"
          SET "status" = 'REVOKED', "revoked_at" = $2
        WHERE "session_id" = $1::uuid AND "status" = 'ACTIVE'`,
        [sessionId, now]
      );
      await client.query(
        `UPDATE "uploaded_files"
          SET "status" = 'DELETE_PENDING',
              "processing_generation" = "processing_generation" + 1,
              "processing_claim_token" = NULL,
              "processing_lease_expires_at" = NULL,
              "processing_enqueued_at" = NULL,
              "delete_requested_at" = $2,
              "cleanup_due_at" = $2,
              "cleanup_error_code" = NULL,
              "updated_at" = $2
        WHERE "session_id" = $1::uuid AND "status" IN ('QUARANTINED', 'READY')`,
        [sessionId, now]
      );
      await client.query(
        `INSERT INTO "audit_events"
        ("id", "occurred_at", "actor_type", "actor_id", "kiosk_id", "session_id", "action", "outcome", "metadata")
       VALUES ($1::uuid, $2, 'SYSTEM', 'development-paid-session-recovery', $3, $4::uuid,
         'development.mock_print_completed', 'SUCCESS', $5::jsonb)`,
        [
          randomUUID(),
          now,
          session.kiosk_id,
          sessionId,
          JSON.stringify({
            previousState: "PAID",
            capturedPaymentId: paymentResult.rows[0].id,
            version: completedVersion
          })
        ]
      );

      await client.query("COMMIT");
      process.stdout.write(
        `Recovered mock-paid session ${sessionId}: PAID -> PRINTING -> COMPLETED ` +
          `(version ${session.state_version} -> ${completedVersion}).\n`
      );
    }
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
