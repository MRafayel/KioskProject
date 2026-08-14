import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdminRole } from "../../packages/admin-access/src/index.js";
import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import {
  createAdminReadClient,
  createAdminWriteClient,
  createDatabaseClient
} from "../../packages/database/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_CSRF_HEADER,
  ADMIN_SESSION_COOKIE
} from "../../services/api/src/modules/admin/authorize.js";
import {
  digestAdminCsrfToken,
  digestAdminSessionToken
} from "../../services/api/src/modules/admin/crypto.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

/**
 * The Phase 3 acceptance gate.
 *
 * Phase 3 lets the control plane change something for the first time, so these
 * tests are about the boundaries of that. Three questions run through the file,
 * taken directly from the phase's stated gate:
 *
 *   Can an Operator move money? Not through an endpoint, not as a side effect,
 *   and — the part worth proving rather than asserting — not even if this code
 *   were rewritten to try, because the connection it holds has no privilege on
 *   the money tables at all.
 *
 *   Can an Operator act outside their assigned kiosks? Including after their
 *   assignment is revoked while their session is still live.
 *
 *   Can anyone force a job into recovery in order to resolve it? The
 *   application refuses, and so does a trigger, and both are checked.
 *
 * The whole API is pointed at the least-privilege writer role wherever one is
 * configured, so these are statements about the deployed shape rather than
 * about a convenient one.
 */

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({ ...process.env, NODE_ENV: "test" });
assertSafeIntegrationEnvironment(environment);

const database = createDatabaseClient(environment.DATABASE_URL);
const readDatabase = createAdminReadClient(
  environment.ADMIN_READ_DATABASE_URL ?? environment.DATABASE_URL
);
const writeDatabase = createAdminWriteClient(
  environment.ADMIN_WRITE_DATABASE_URL ?? environment.DATABASE_URL
);
/** True when the tests are exercising the real grants rather than the app role. */
const usingWriterRole = Boolean(
  environment.ADMIN_WRITE_DATABASE_URL &&
  environment.ADMIN_WRITE_DATABASE_URL !== environment.DATABASE_URL
);

let app: Awaited<ReturnType<typeof buildApp>>;

const suite = randomBytes(4).toString("hex");
const kioskA = `kiosk_ops_a_${suite}`;
const kioskB = `kiosk_ops_b_${suite}`;

interface SeededSession {
  adminUserId: string;
  cookieHeader: string;
  csrfToken: string;
}

interface SeededWorld {
  sessionId: string;
  printJobId: string;
  paymentId: string;
  /** A second job on the same kiosk, settled COMPLETED. Never resolvable. */
  completedPrintJobId: string;
}

const seededAdminUserIds: string[] = [];
let operatorOnA: SeededSession;
let operatorOnB: SeededSession;
let operatorWithoutStepUp: SeededSession;
let admin: SeededSession;
let worldA: SeededWorld;
let worldB: SeededWorld;

beforeAll(async () => {
  app = await buildApp({
    environment,
    database,
    adminReadDatabase: readDatabase,
    adminWriteDatabase: writeDatabase,
    startBackgroundJobs: false
  });

  await cleanUpOperationalData();
  await seedPricing();
  worldA = await seedKioskWorld(kioskA);
  worldB = await seedKioskWorld(kioskB);

  operatorOnA = await seedAdminWithSession("OPERATOR", [kioskA], true);
  operatorOnB = await seedAdminWithSession("OPERATOR", [kioskB], true);
  operatorWithoutStepUp = await seedAdminWithSession("OPERATOR", [kioskA], false);
  admin = await seedAdminWithSession("ADMIN", [], true);
}, 60_000);

afterAll(async () => {
  // Operational data first: a resolution names the account that recorded it,
  // and the RESTRICT that protects that link applies to teardown too.
  await cleanUpOperationalData();
  await cleanUpSeededAdmins();
  await app.close();
  await database.$disconnect();
  await readDatabase.$disconnect();
  await writeDatabase.$disconnect();
});

// ---------------------------------------------------------------------------
// The gate: an Operator cannot move money
// ---------------------------------------------------------------------------

describe("an Operator cannot move money", () => {
  it("exposes exactly one money endpoint, and no Operator may reach it", async () => {
    // Phase 4 added `refund.authorize`. It is one route, it is the only one,
    // and an Operator is refused it — which is the Phase 3 property restated
    // rather than retired: recording what happened at a tray and authorizing a
    // payout stayed different capabilities held by different people.
    const refused = await request(
      operatorOnA,
      "POST",
      `/v1/admin/print-jobs/${worldA.printJobId}/refund-authorization`,
      { amountMinor: 100, reason: "An Operator reaching for the money route." }
    );
    expect(refused.statusCode).toBe(403);

    // Nothing else answers. A settle route in particular does not exist for
    // anybody: money moves against the provider, not from this panel.
    const absent = [
      { method: "POST" as const, url: "/v1/admin/refunds" },
      { method: "POST" as const, url: `/v1/admin/refunds/${randomUUID()}/authorize` },
      { method: "POST" as const, url: `/v1/admin/refunds/${randomUUID()}/settle` },
      { method: "POST" as const, url: `/v1/admin/payments/${worldA.paymentId}/refund` },
      { method: "POST" as const, url: `/v1/admin/sessions/${worldA.sessionId}/refund` },
      {
        method: "POST" as const,
        url: `/v1/admin/print-jobs/${worldA.printJobId}/refund`
      }
    ];

    for (const attempt of absent) {
      const response = await request(admin, attempt.method, attempt.url, {});
      expect(response.statusCode, attempt.url).toBe(404);
    }
  });

  it("records an observation that money looks owed without any money moving", async () => {
    const before = await database.refund.count({ where: { paymentId: worldA.paymentId } });

    const response = await request(
      operatorOnA,
      "POST",
      `/v1/admin/print-jobs/${worldA.printJobId}/recovery-resolution`,
      {
        outcome: "NOT_DELIVERED",
        reason: "Tray was empty and the display showed a paper jam.",
        observedSheets: 0
      }
    );

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.resolution.refundSuggested).toBe(true);
    // The response says so itself, so a client cannot read a suggestion as a
    // payout even by accident.
    expect(body.refundAuthorized).toBe(false);

    // Nothing was created, settled, or altered in the money tables.
    expect(await database.refund.count({ where: { paymentId: worldA.paymentId } })).toBe(before);
    const payment = await database.payment.findUniqueOrThrow({
      where: { id: worldA.paymentId },
      select: { status: true, amountMinor: true }
    });
    expect(payment.status).toBe("CAPTURED");
    expect(payment.amountMinor).toBe(18_000);
  });

  it("holds no database privilege that could pay anybody", async () => {
    if (!usingWriterRole) {
      // Provision the role and this becomes the strongest test in the file.
      // Without it the assertion would be about the application role, which
      // legitimately holds every grant, so it would prove nothing.
      expect(usingWriterRole).toBe(false);
      return;
    }

    // The heart of the phase. Not "no code path calls this" but "the statement
    // is refused by PostgreSQL", which survives any future rewrite of the code
    // above it.
    await expectRefused(
      `INSERT INTO refunds (id, payment_id, session_id, provider, reason, amount_minor,
         currency, currency_exponent, status, created_at, updated_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'MOCK', 'PRINT_FAILED',
         18000, 'AMD', 2, 'PENDING', now(), now())`
    );
    await expectRefused(`UPDATE refunds SET status = 'COMPLETED'`);
    await expectRefused(`UPDATE payments SET status = 'REFUNDED'`);
    await expectRefused(`SELECT amount_minor FROM refunds LIMIT 1`);
  });
});

// ---------------------------------------------------------------------------
// The gate: nobody can force a job into recovery
// ---------------------------------------------------------------------------

describe("nobody can force a job into recovery", () => {
  it("refuses to resolve a job that is not in recovery", async () => {
    const response = await request(
      operatorOnA,
      "POST",
      `/v1/admin/print-jobs/${worldA.completedPrintJobId}/recovery-resolution`,
      { outcome: "DELIVERED", reason: "Trying to resolve a print that already worked." }
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PRINT_JOB_NOT_IN_RECOVERY");
    expect(
      await database.printJobRecoveryResolution.count({
        where: { printJobId: worldA.completedPrintJobId }
      })
    ).toBe(0);
  });

  it("refuses the row itself, whatever the application believes", async () => {
    // The application check above can be bypassed by a bug or by a future
    // endpoint. This one cannot: the trigger reads the job's own status.
    await expect(
      database.printJobRecoveryResolution.create({
        data: {
          id: randomUUID(),
          printJobId: worldA.completedPrintJobId,
          sessionId: worldA.sessionId,
          kioskId: kioskA,
          outcome: "DELIVERED",
          reason: "Bypassing the application entirely.",
          refundSuggested: false,
          resolvedByAdminId: operatorOnA.adminUserId,
          resolvedByRole: "OPERATOR",
          requestDigest: "a".repeat(64)
        }
      })
    ).rejects.toThrow();
  });

  it("refuses a resolution attributed to a kiosk other than the job's own", async () => {
    // The read side scopes an Operator by these columns, so a wrong value here
    // would be a way to make another kiosk's work visible — or to hide one's own.
    await expect(
      database.printJobRecoveryResolution.create({
        data: {
          id: randomUUID(),
          printJobId: worldB.printJobId,
          sessionId: worldB.sessionId,
          kioskId: kioskA,
          outcome: "DELIVERED",
          reason: "Attributing kiosk B's work to kiosk A.",
          refundSuggested: false,
          resolvedByAdminId: operatorOnA.adminUserId,
          resolvedByRole: "OPERATOR",
          requestDigest: "b".repeat(64)
        }
      })
    ).rejects.toThrow();
  });

  it("leaves the job and its session exactly as the device left them", async () => {
    const job = await database.printJob.findUniqueOrThrow({
      where: { id: worldA.printJobId },
      select: { status: true, resultConfidence: true, sheetsProduced: true, completedAt: true }
    });
    // The first test in this file resolved this job as NOT_DELIVERED. None of
    // that may have reached the device's own account of what happened.
    expect(job.status).toBe("RECOVERY_REQUIRED");
    expect(job.resultConfidence).toBe("UNCONFIRMED");
    expect(job.completedAt).toBeNull();

    const session = await database.printSession.findUniqueOrThrow({
      where: { id: worldA.sessionId },
      select: { state: true }
    });
    expect(session.state).toBe("RECOVERY_REQUIRED");
  });

  it("cannot rewrite or delete an observation once it is made", async () => {
    // The row has to exist, or `updateMany` would report zero rows changed and
    // the test would pass without the trigger ever being consulted.
    expect(
      await database.printJobRecoveryResolution.count({ where: { printJobId: worldA.printJobId } })
    ).toBe(1);

    await expect(
      database.printJobRecoveryResolution.updateMany({
        where: { printJobId: worldA.printJobId },
        data: { outcome: "DELIVERED", refundSuggested: false }
      })
    ).rejects.toThrow();

    await expect(
      database.printJobRecoveryResolution.deleteMany({ where: { printJobId: worldA.printJobId } })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The gate: an Operator cannot act outside their kiosks
// ---------------------------------------------------------------------------

describe("an Operator cannot act outside their assigned kiosks", () => {
  it("answers 404 rather than 403 for another kiosk's job", async () => {
    const response = await request(
      operatorOnA,
      "POST",
      `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      { outcome: "DELIVERED", reason: "Reaching into another operator's kiosk." }
    );

    // A 403 would confirm the identifier names a real job, which is the whole
    // mechanism of an enumeration attack.
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("ADMIN_NOT_FOUND");
    expect(
      await database.printJobRecoveryResolution.count({ where: { printJobId: worldB.printJobId } })
    ).toBe(0);
  });

  it("re-reads the assignment from the database rather than trusting the session", async () => {
    const temporary = await seedAdminWithSession("OPERATOR", [kioskB], true);

    // Revoked after the session was issued. The next action must feel it, not
    // the next sign-in: a scope carried in a cookie is a scope that outlives
    // the decision to remove it.
    await database.adminKioskScope.deleteMany({
      where: { adminUserId: temporary.adminUserId, kioskId: kioskB }
    });

    const response = await request(
      temporary,
      "POST",
      `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      { outcome: "DELIVERED", reason: "Acting after the assignment was revoked." }
    );

    expect(response.statusCode).toBe(404);
  });

  it("records the refusal even though nothing was written", async () => {
    // Somebody probing for jobs they cannot reach should leave exactly as much
    // evidence as somebody doing their job. The refusal is written after its
    // transaction rolls back, so it survives.
    const denied = await database.auditEvent.findFirst({
      where: {
        actorId: operatorOnA.adminUserId,
        action: "admin.print.recovery.resolve",
        outcome: "DENIED"
      },
      orderBy: { occurredAt: "desc" },
      select: { metadata: true }
    });

    expect(denied).not.toBeNull();
    const metadata = denied?.metadata as Record<string, unknown>;
    expect(metadata.failureCode).toBe("NOT_FOUND_OR_OUT_OF_SCOPE");
  });

  it("cannot acknowledge a failure on a kiosk it is not assigned to", async () => {
    const response = await request(operatorOnB, "POST", "/v1/admin/incidents/acknowledge", {
      subsystem: "PRINTING",
      code: "DEVICE_RESULT_UNCONFIRMED",
      kioskId: kioskA,
      reason: "Acknowledging somebody else's kiosk."
    });

    expect(response.statusCode).toBe(404);
  });

  it("cannot acknowledge a system-wide failure that names no kiosk", async () => {
    // Upload, payment, retention and event-publishing failures hang off a
    // session rather than a device. An Operator's view is scoped to devices, so
    // speaking for one of those is not theirs to do.
    const response = await request(operatorOnA, "POST", "/v1/admin/incidents/acknowledge", {
      subsystem: "RETENTION",
      code: "OBJECT_STORE_UNAVAILABLE",
      kioskId: null,
      reason: "Acknowledging a system-wide retention failure."
    });

    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Authorization on the action itself
// ---------------------------------------------------------------------------

describe("authorization", () => {
  it("refuses an action with no session", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      payload: { outcome: "DELIVERED", reason: "No session at all here." }
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses an action without the CSRF header", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      headers: { cookie: operatorOnB.cookieHeader },
      payload: { outcome: "DELIVERED", reason: "Missing the double-submit token." }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ADMIN_CSRF_FAILED");
  });

  it("refuses another session's CSRF token", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      headers: {
        cookie: operatorOnB.cookieHeader,
        [ADMIN_CSRF_HEADER]: operatorOnA.csrfToken
      },
      payload: { outcome: "DELIVERED", reason: "Borrowing another session's token." }
    });
    expect(response.statusCode).toBe(403);
  });

  it("requires a fresh security-key assertion for a recovery resolution", async () => {
    const response = await request(
      operatorWithoutStepUp,
      "POST",
      `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      { outcome: "DELIVERED", reason: "A live cookie with no recent assertion." }
    );

    // R2. A stolen cookie alone must never be enough to write about a paid print.
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_STEP_UP_REQUIRED");
  });

  it("does not require step-up to say somebody is looking at a failure", async () => {
    // R1. Acknowledging changes no operational state, and demanding a security
    // key for it would teach people to reach for the key without reading.
    const response = await request(
      operatorWithoutStepUp,
      "POST",
      "/v1/admin/incidents/acknowledge",
      {
        subsystem: "PRINTING",
        code: "DEVICE_RESULT_UNCONFIRMED",
        kioskId: kioskA,
        reason: "Walking over to check the paper path."
      }
    );

    expect(response.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// What may be recorded
// ---------------------------------------------------------------------------

describe("what an observation may say", () => {
  it("refuses a reason that explains nothing", async () => {
    for (const reason of ["", "ok", "   ", "x".repeat(281)]) {
      const response = await request(
        operatorOnB,
        "POST",
        `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
        { outcome: "DELIVERED", reason }
      );
      expect(response.statusCode, JSON.stringify(reason)).toBe(400);
    }
  });

  it("refuses an outcome outside the vocabulary", async () => {
    for (const outcome of ["COMPLETED", "delivered", "REFUNDED", ""]) {
      const response = await request(
        operatorOnB,
        "POST",
        `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
        { outcome, reason: "A perfectly reasonable explanation." }
      );
      expect(response.statusCode, outcome).toBe(400);
    }
  });

  it("refuses a sheet count that contradicts the outcome", async () => {
    const response = await request(
      operatorOnB,
      "POST",
      `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      {
        outcome: "NOT_DELIVERED",
        reason: "Claiming nothing came out and also counting three sheets.",
        observedSheets: 3
      }
    );
    expect(response.statusCode).toBe(400);
  });

  it("refuses a refund flag submitted by the client", async () => {
    // Derived from the outcome on the server and pinned by a check constraint.
    // A client that could set it could ask an Admin to pay out on a print that
    // worked.
    const response = await request(
      operatorOnB,
      "POST",
      `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      {
        outcome: "DELIVERED",
        reason: "Everything printed, and also please refund it.",
        refundSuggested: true
      }
    );
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("one observation per print", () => {
  const body = {
    outcome: "PARTIALLY_DELIVERED",
    reason: "Two of the three pages were in the tray.",
    observedSheets: 2
  };

  it("records the first submission and replays an identical repeat", async () => {
    const first = await request(
      operatorOnB,
      "POST",
      `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      body
    );
    expect(first.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);

    const repeat = await request(
      operatorOnB,
      "POST",
      `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      body
    );
    // A double-clicked button reads as "already done" rather than as a second
    // success, and leaves one row rather than two.
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().replayed).toBe(true);
    expect(repeat.json().resolution.resolvedAt).toBe(first.json().resolution.resolvedAt);

    expect(
      await database.printJobRecoveryResolution.count({ where: { printJobId: worldB.printJobId } })
    ).toBe(1);
  });

  it("refuses a contradictory second account rather than dropping it", async () => {
    const response = await request(
      operatorOnB,
      "POST",
      `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      { outcome: "DELIVERED", reason: "Actually everything came out fine." }
    );

    // Two people disagreeing about what they saw is something a person needs to
    // know about, not something to swallow.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PRINT_RECOVERY_ALREADY_RESOLVED");

    const stored = await database.printJobRecoveryResolution.findUniqueOrThrow({
      where: { printJobId: worldB.printJobId }
    });
    expect(stored.outcome).toBe("PARTIALLY_DELIVERED");
  });

  it("also refuses the same outcome told a different way", async () => {
    // The reason is part of the request, because the text is the part somebody
    // will read later.
    const response = await request(
      operatorOnB,
      "POST",
      `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      { ...body, reason: "A different account of the same outcome entirely." }
    );
    expect(response.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// What the panel shows afterwards
// ---------------------------------------------------------------------------

describe("the read side reflects the action", () => {
  it("returns the observation on the job it belongs to", async () => {
    const response = await request(operatorOnA, "GET", `/v1/admin/print-jobs/${worldA.printJobId}`);
    expect(response.statusCode).toBe(200);

    const resolution = response.json().resolution;
    expect(resolution.outcome).toBe("NOT_DELIVERED");
    expect(resolution.refundSuggested).toBe(true);
    expect(resolution.resolvedByRole).toBe("OPERATOR");
    expect(resolution.resolvedByDisplayName).toBe("Operations OPERATOR");
  });

  it("marks the job answered in the list", async () => {
    const response = await request(operatorOnA, "GET", "/v1/admin/print-jobs");
    const job = response
      .json()
      .items.find((candidate: { id: string }) => candidate.id === worldA.printJobId);
    expect(job.recoveryResolved).toBe(true);
    // The device's own account is untouched by the human one beside it.
    expect(job.status).toBe("RECOVERY_REQUIRED");
    expect(job.resultConfidence).toBe("UNCONFIRMED");
  });

  it("takes the answered job off the worklist without hiding that it exists", async () => {
    const response = await request(operatorOnA, "GET", "/v1/admin/overview");
    const overview = response.json();

    // Somebody who records what they saw has to watch the number they are
    // working through go down, or they stop believing it.
    expect(overview.printing.recoveryRequired).toBeGreaterThan(0);
    expect(overview.printing.recoveryUnresolved).toBe(0);
    expect(
      overview.attention.some((item: { code: string }) => item.code === "PRINT_RECOVERY_REQUIRED")
    ).toBe(false);
  });

  it("does not present a command that simply finished as a failure", async () => {
    // A settled agent command records `failureCode ?? status`, so a successful
    // one carries the code `COMPLETED`. Listing those would fill the error
    // centre with successes and make an acknowledgement meaningless.
    const errors = await request(operatorOnA, "GET", "/v1/admin/errors?windowHours=168");
    const codes = errors
      .json()
      .groups.filter((group: { subsystem: string }) => group.subsystem === "KIOSK_AGENT")
      .map((group: { code: string }) => group.code);

    expect(codes).toContain("DEVICE_UNREACHABLE");
    expect(codes).not.toContain("COMPLETED");
  });

  it("shows who is handling an acknowledged failure", async () => {
    const acknowledged = await request(operatorOnA, "POST", "/v1/admin/incidents/acknowledge", {
      subsystem: "KIOSK_AGENT",
      code: "DEVICE_UNREACHABLE",
      kioskId: kioskA,
      reason: "Checking the agent on this kiosk now."
    });
    expect(acknowledged.statusCode).toBe(201);

    const errors = await request(operatorOnA, "GET", "/v1/admin/errors?windowHours=168");
    const group = errors
      .json()
      .groups.find(
        (candidate: { subsystem: string; code: string }) =>
          candidate.subsystem === "KIOSK_AGENT" && candidate.code === "DEVICE_UNREACHABLE"
      );

    expect(group.acknowledgedBy).toBe("Operations OPERATOR");
    expect(group.acknowledgedAt).not.toBeNull();
  });

  it("refuses to acknowledge a failure that never happened", async () => {
    // Without this the endpoint would be a way to write caller-chosen strings
    // into a permanent log that operators read back.
    const response = await request(operatorOnA, "POST", "/v1/admin/incidents/acknowledge", {
      subsystem: "PRINTING",
      code: "TOTALLY_INVENTED_CODE",
      kioskId: kioskA,
      reason: "Acknowledging something that never happened."
    });

    expect(response.statusCode).toBe(404);

    const recorded = await database.auditEvent.findMany({
      where: { action: "admin.incident.acknowledge" },
      select: { outcome: true, metadata: true }
    });
    const invented = recorded.filter((event) =>
      JSON.stringify(event.metadata).includes("TOTALLY_INVENTED_CODE")
    );
    // The attempt is on the record; the claim is not treated as a fact.
    expect(invented).not.toHaveLength(0);
    expect(invented.every((event) => event.outcome === "DENIED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

describe("the audit trail", () => {
  it("records the action with what the device said beside what the person said", async () => {
    const event = await database.auditEvent.findFirstOrThrow({
      where: {
        actorId: operatorOnA.adminUserId,
        action: "admin.print.recovery.resolve",
        outcome: "SUCCESS"
      },
      orderBy: { occurredAt: "asc" }
    });

    const metadata = event.metadata as Record<string, unknown>;
    expect(event.kioskId).toBe(kioskA);
    expect(metadata.capability).toBe("print.recovery.resolve");
    expect(metadata.risk).toBe("R2");
    expect(metadata.recoveryOutcome).toBe("NOT_DELIVERED");
    expect(metadata.refundSuggested).toBe(true);
    expect(metadata.observedSheets).toBe(0);
    // The gap between the two is the reason the record exists.
    expect(metadata.confidence).toBe("UNCONFIRMED");
    expect(metadata.failureCode).toBe("DEVICE_RESULT_UNCONFIRMED");
    // Before and after are identical, which is the claim: nothing moved.
    expect(metadata.previousState).toBe("RECOVERY_REQUIRED");
    expect(metadata.resultingState).toBe("RECOVERY_REQUIRED");
  });

  it("carries no document content into permanent storage", async () => {
    const events = await database.auditEvent.findMany({
      where: { action: { in: ["admin.print.recovery.resolve", "admin.incident.acknowledge"] } },
      select: { metadata: true }
    });

    const serialized = JSON.stringify(events);
    // The reason is operator-written free text and the only thing here a person
    // typed. They are never shown a filename, but the allow-list is what makes
    // that a guarantee rather than a circumstance.
    for (const forbidden of ["displayName", "objectKey", "contentSha256", "jobManifest"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("is visible to the operator who wrote it", async () => {
    const response = await request(
      operatorOnA,
      "GET",
      "/v1/admin/audit?action=admin.print.recovery.resolve"
    );
    expect(response.statusCode).toBe(200);

    // The list also carries this operator's refused attempts, which is the
    // point of auditing them; the recorded observation is the one with an
    // outcome of SUCCESS.
    const entry = response
      .json()
      .items.find((candidate: { outcome: string }) => candidate.outcome === "SUCCESS");
    expect(entry.actorDisplayName).toBe("Operations OPERATOR");
    expect(entry.metadata.recoveryOutcome).toBe("NOT_DELIVERED");
  });
});

// ---------------------------------------------------------------------------
// The write connection
// ---------------------------------------------------------------------------

describe("the connection an action writes through", () => {
  it("cannot touch anything but the two tables it appends to", async () => {
    if (!usingWriterRole) {
      expect(usingWriterRole).toBe(false);
      return;
    }

    await expectRefused(`UPDATE print_jobs SET status = 'COMPLETED'`);
    await expectRefused(`UPDATE print_sessions SET state = 'COMPLETED'`);
    await expectRefused(`DELETE FROM audit_events`);
    await expectRefused(`UPDATE audit_events SET action = 'rewritten'`);
    await expectRefused(`DELETE FROM print_job_recovery_resolutions`);
    await expectRefused(`UPDATE print_job_recovery_resolutions SET outcome = 'DELIVERED'`);
    await expectRefused(
      `INSERT INTO agent_commands (id, kiosk_id, operation_id, type, status, payload,
         expires_at, created_at, updated_at)
       VALUES (gen_random_uuid(), 'k', gen_random_uuid(), 'PRINT', 'PENDING', '{}'::jsonb,
         now(), now(), now())`
    );
    await expectRefused(`UPDATE uploaded_files SET deleted_at = now()`);
    await expectRefused(`SELECT secret_digest FROM kiosk_credentials LIMIT 1`);
    await expectRefused(`SELECT display_name FROM uploaded_files LIMIT 1`);
    await expectRefused(`SELECT job_manifest FROM print_jobs LIMIT 1`);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(
  session: SeededSession,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown
) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: session.cookieHeader,
      ...(method === "GET" ? {} : { [ADMIN_CSRF_HEADER]: session.csrfToken })
    },
    ...(payload === undefined ? {} : { payload })
  });
}

/**
 * Assert that PostgreSQL itself refuses a statement on the write connection.
 *
 * `42501` is permission denied and `25006` is a read-only transaction. Either
 * is the database saying no; an application-level exception would not be, which
 * is why the code is checked rather than just the throw.
 */
async function expectRefused(sql: string): Promise<void> {
  let code: string | undefined;
  try {
    await writeDatabase.$executeRawUnsafe(sql);
  } catch (error) {
    code = extractDatabaseCode(error);
  }
  expect(code, sql).toMatch(/^(42501|25006)$/u);
}

function extractDatabaseCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    for (const key of ["originalCode", "code"]) {
      const candidate = Reflect.get(value, key);
      if (typeof candidate === "string" && /^\d{5}$/u.test(candidate)) return candidate;
    }
    for (const key of Object.keys(value)) {
      const found = walk(Reflect.get(value, key));
      if (found) return found;
    }
    // Prisma wraps the driver error in `meta`, and the message carries the code
    // when the structured chain does not.
    const message = Reflect.get(value, "message");
    if (typeof message === "string") {
      const matched = /\b(42501|25006)\b/u.exec(message);
      if (matched) return matched[1];
    }
    return undefined;
  };
  return walk(error);
}

async function seedAdminWithSession(
  role: AdminRole,
  kioskScopes: readonly string[],
  steppedUp: boolean
): Promise<SeededSession> {
  const now = Date.now();
  const adminUserId = randomUUID();
  seededAdminUserIds.push(adminUserId);

  await database.adminUser.create({
    data: {
      id: adminUserId,
      userHandle: randomBytes(32),
      displayName: `Operations ${role}`,
      role,
      status: "PROVISIONING"
    }
  });

  // Two authenticators, because an active account may not exist with fewer.
  for (let index = 0; index < 2; index += 1) {
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId,
        credentialId: `ops-credential-${adminUserId}-${index}`,
        publicKey: randomBytes(32),
        label: `key ${index}`,
        attachment: "cross-platform",
        backupEligible: false
      }
    });
  }

  await database.adminUser.update({
    where: { id: adminUserId },
    data: { status: "ACTIVE", activatedAt: new Date(now) }
  });

  for (const kioskId of kioskScopes) {
    await database.adminKioskScope.create({ data: { adminUserId, kioskId } });
  }

  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await database.adminSession.create({
    data: {
      id: randomUUID(),
      adminUserId,
      tokenDigest: digestAdminSessionToken(sessionToken, environment.ADMIN_SESSION_PEPPER),
      csrfDigest: digestAdminCsrfToken(csrfToken, environment.ADMIN_SESSION_PEPPER),
      idleExpiresAt: new Date(now + 600_000),
      hardExpiresAt: new Date(now + 3_600_000),
      // A session that has not recently proved presence cannot perform an R2
      // action, which is what one of the tests above is for.
      ...(steppedUp ? { lastStepUpAt: new Date(now) } : {})
    }
  });

  return {
    adminUserId,
    csrfToken,
    cookieHeader: `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`
  };
}

let ruleSetId: string;
let pricingVersion: string;
let seededRuleSet = false;

async function seedPricing(): Promise<void> {
  const existing = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED" },
    select: { id: true, version: true }
  });
  if (existing) {
    ruleSetId = existing.id;
    pricingVersion = existing.version;
    return;
  }

  ruleSetId = randomUUID();
  pricingVersion = `ops-${suite}`;
  seededRuleSet = true;
  await database.pricingRuleSet.create({
    data: {
      id: ruleSetId,
      version: pricingVersion,
      scope: "KIOSK",
      scopeRef: kioskA,
      currency: "AMD",
      currencyExponent: 2,
      status: "PUBLISHED",
      rounding: "HALF_UP",
      taxMode: "EXCLUSIVE",
      minimumApplication: "BEFORE_TAX",
      validFrom: new Date(Date.now() - 86_400_000),
      publishedAt: new Date(Date.now() - 86_400_000)
    }
  });
}

/**
 * One kiosk with a print waiting for a person, and one that already worked.
 *
 * Built through the same invariants production uses — a quote a payment must
 * match, a capture a print job cannot exist without — so what these tests act
 * on is shaped like a real recovery rather than like whatever was convenient.
 */
async function seedKioskWorld(kioskId: string): Promise<SeededWorld> {
  const now = Date.now();
  const sessionId = randomUUID();
  const completedSessionId = randomUUID();

  await database.kiosk.create({
    data: {
      id: kioskId,
      publicCode: kioskId.toUpperCase(),
      name: `Operations ${kioskId}`,
      capabilities: { paperSizes: ["A4"] },
      lastSeenAt: new Date(now - 30_000)
    }
  });

  const recovery = await seedPaidSession(kioskId, sessionId, now, "RECOVERY_REQUIRED");
  const completed = await seedPaidSession(kioskId, completedSessionId, now, "COMPLETED");

  // A kiosk-agent failure for the error centre to group, so there is something
  // real to acknowledge. Its sibling below is a command that simply finished:
  // the error centre must not list that one, because a settled command records
  // `failureCode ?? status` and a successful one therefore carries a code.
  await database.agentCommand.create({
    data: {
      id: randomUUID(),
      kioskId,
      sessionId,
      printJobId: recovery.printJobId,
      operationId: randomUUID(),
      type: "PRINT",
      status: "FAILED",
      payload: { documents: [] },
      expiresAt: new Date(now - 6_000_000),
      resultCode: "DEVICE_UNREACHABLE",
      completedAt: new Date(now - 6_500_000)
    }
  });

  await database.agentCommand.create({
    data: {
      id: randomUUID(),
      kioskId,
      sessionId,
      printJobId: completed.printJobId,
      operationId: randomUUID(),
      type: "PRINT",
      status: "COMPLETED",
      payload: { documents: [] },
      expiresAt: new Date(now - 6_000_000),
      resultCode: "COMPLETED",
      completedAt: new Date(now - 6_500_000)
    }
  });

  return {
    sessionId,
    printJobId: recovery.printJobId,
    paymentId: recovery.paymentId,
    completedPrintJobId: completed.printJobId
  };
}

async function seedPaidSession(
  kioskId: string,
  sessionId: string,
  now: number,
  settle: "RECOVERY_REQUIRED" | "COMPLETED"
): Promise<{ printJobId: string; paymentId: string }> {
  const quoteId = randomUUID();
  const paymentId = randomUUID();
  const printJobId = randomUUID();
  // Referenced only inside the settings and manifest JSON. These tests are
  // about a print that could not be settled, not about the documents in it.
  const fileId = randomUUID();
  const manifestHash = randomBytes(32).toString("hex");

  await database.printSession.create({
    data: {
      id: sessionId,
      publicId: `ps_ops_${randomBytes(8).toString("hex")}`,
      kioskId,
      locale: "en",
      state: "PRINTING",
      currentSettingsRevision: 1,
      idleExpiresAt: new Date(now - 3_600_000),
      hardExpiresAt: new Date(now - 3_600_000),
      createdAt: new Date(now - 7_200_000)
    }
  });

  await database.printSettingRevision.create({
    data: {
      id: randomUUID(),
      sessionId,
      revision: 1,
      paperSize: "A4",
      scaling: "FIT",
      collate: true,
      colorMode: "MONOCHROME",
      // A trigger refuses a settings revision without per-document digests, so
      // the seed carries one exactly as the real upload path would.
      selections: [
        {
          fileId,
          position: 0,
          pageCount: 3,
          processingRevision: 1,
          contentSha256: randomBytes(32).toString("hex"),
          pageRanges: [[1, 3]],
          pageRangeText: "1-3",
          selectedPages: 3,
          copies: 1,
          duplex: "SIMPLEX",
          orientation: "PORTRAIT",
          printedSides: 3,
          physicalSheets: 3
        }
      ],
      selectedPages: 3,
      printedSides: 3,
      physicalSheets: 3,
      capabilityVersion: 1,
      manifestHash,
      createdByActorType: "KIOSK",
      createdByActorId: kioskId
    }
  });

  await database.priceQuote.create({
    data: {
      id: quoteId,
      sessionId,
      settingsRevision: 1,
      manifestHash,
      ruleSetId,
      pricingVersion,
      status: "ACTIVE",
      currency: "AMD",
      currencyExponent: 2,
      selectedPages: 3,
      printedSides: 3,
      physicalSheets: 3,
      printAmountMinor: 15_000,
      duplexAdjustmentMinor: 0,
      serviceFeeMinor: 0,
      minimumAdjustmentMinor: 0,
      subtotalMinor: 15_000,
      taxMinor: 3_000,
      totalMinor: 18_000,
      expiresAt: new Date(now + 3_600_000)
    }
  });

  await database.payment.create({
    data: {
      id: paymentId,
      sessionId,
      quoteId,
      provider: "MOCK",
      providerIntentId: `intent_ops_${randomBytes(8).toString("hex")}`,
      status: "CAPTURED",
      appliedToSession: true,
      amountMinor: 18_000,
      currency: "AMD",
      currencyExponent: 2,
      settingsRevision: 1,
      manifestHash,
      createdByActorType: "KIOSK",
      createdByActorId: kioskId,
      expiresAt: new Date(now - 3_600_000),
      createdAt: new Date(now - 7_000_000),
      capturedAt: new Date(now - 6_900_000)
    }
  });

  await database.printSession.update({ where: { id: sessionId }, data: { state: "PAID" } });

  await database.printJob.create({
    data: {
      id: printJobId,
      sessionId,
      kioskId,
      quoteId,
      paymentId,
      settingsRevision: 1,
      settingsManifestHash: manifestHash,
      jobManifest: { documents: [{ fileId }] },
      jobManifestHash: randomBytes(32).toString("hex"),
      status: "QUEUED",
      copies: 1,
      printedSides: 3,
      physicalSheets: 3,
      deadlineAt: new Date(now - 6_000_000),
      createdByActorType: "KIOSK",
      createdByActorId: kioskId,
      createdAt: new Date(now - 6_800_000)
    }
  });

  await database.printSession.update({ where: { id: sessionId }, data: { state: "PRINTING" } });

  if (settle === "RECOVERY_REQUIRED") {
    await database.printJob.update({
      where: { id: printJobId },
      data: {
        status: "RECOVERY_REQUIRED",
        resultConfidence: "UNCONFIRMED",
        failureCode: "DEVICE_RESULT_UNCONFIRMED",
        dispatchAttempts: 1,
        dispatchedAt: new Date(now - 6_700_000),
        startedAt: new Date(now - 6_600_000),
        failedAt: new Date(now - 6_500_000)
      }
    });
    await database.printSession.update({
      where: { id: sessionId },
      data: { state: "RECOVERY_REQUIRED", terminalReason: "PRINT_UNCONFIRMED" }
    });
  } else {
    await database.printJob.update({
      where: { id: printJobId },
      data: {
        status: "COMPLETED",
        resultConfidence: "CONFIRMED",
        sheetsProduced: 3,
        dispatchAttempts: 1,
        dispatchedAt: new Date(now - 6_700_000),
        startedAt: new Date(now - 6_600_000),
        completedAt: new Date(now - 6_500_000)
      }
    });
    await database.printSession.update({
      where: { id: sessionId },
      data: { state: "COMPLETED", terminalReason: "PRINT_COMPLETED" }
    });
  }

  return { printJobId, paymentId };
}

async function cleanUpSeededAdmins(): Promise<void> {
  const ids = seededAdminUserIds.splice(0);
  if (ids.length === 0) return;
  await database.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminKioskScope.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminUser.updateMany({
    where: { id: { in: ids } },
    data: { status: "SUSPENDED" }
  });
  await database.adminAuthenticator.deleteMany({ where: { adminUserId: { in: ids } } });
  // An account that recorded an observation cannot be deleted while the
  // observation names it, which is the point of the RESTRICT. The suite's
  // resolutions are removed first, below.
  await database.adminUser.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Remove this suite's kiosks and everything hanging off them.
 *
 * Recovery resolutions need the append-only triggers suspended to delete, which
 * requires owning the table. That is worth noticing rather than working around
 * quietly: the role the control plane actually writes through cannot do this,
 * and a teardown that needed no special step would mean the guarantee was not
 * really there.
 */
async function cleanUpOperationalData(): Promise<void> {
  const kioskIds = [kioskA, kioskB];
  const sessions = await database.printSession.findMany({
    where: { kioskId: { in: kioskIds } },
    select: { id: true }
  });
  const sessionIds = sessions.map((session) => session.id);

  if (sessionIds.length > 0) {
    await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `ALTER TABLE "print_job_recovery_resolutions" DISABLE TRIGGER USER`
      );
      await transaction.$executeRawUnsafe(
        `DELETE FROM "print_job_recovery_resolutions"
         WHERE "session_id" = ANY($1::uuid[])`,
        sessionIds
      );
      await transaction.$executeRawUnsafe(
        `ALTER TABLE "print_job_recovery_resolutions" ENABLE TRIGGER USER`
      );
    });

    await database.printJobEvent.deleteMany({
      where: { printJob: { sessionId: { in: sessionIds } } }
    });
    await database.agentCommand.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.printJob.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.refund.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.paymentAttempt.deleteMany({
      where: { payment: { sessionId: { in: sessionIds } } }
    });
    await database.payment.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.cleanupRun.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.sessionEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.uploadedFile.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.priceQuote.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.printSettingRevision.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.printSession.deleteMany({ where: { id: { in: sessionIds } } });
  }

  await database.adminKioskScope.deleteMany({ where: { kioskId: { in: kioskIds } } });
  await database.kiosk.deleteMany({ where: { id: { in: kioskIds } } });
  if (seededRuleSet) await database.pricingRuleSet.deleteMany({ where: { id: ruleSetId } });
}
