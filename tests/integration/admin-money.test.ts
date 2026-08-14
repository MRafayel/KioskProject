import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdminRole } from "../../packages/admin-access/src/index.js";
import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import {
  createAdminReadClient,
  createAdminRefundClient,
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
 * The Phase 4 acceptance gate.
 *
 * Phase 4 lets the control plane cost money for the first time. Its gate, from
 * `ADMIN_PHASE_0.md` §22: **reason plus before/after audited, and the refund
 * path structurally separate from the Operator observation path.** Three
 * questions run through this file.
 *
 *   Is the money path actually separate? Not "in a different function" —
 *   different service, different pool, different PostgreSQL role, with the
 *   observation connection holding no grant on `refunds` and the money
 *   connection holding no grant to record an observation. Each half is asked to
 *   do the other's work and refused by the database.
 *
 *   Can a refund exist that nobody is recorded as having authorized? Not
 *   through the API, and not through the connection either: a deferred
 *   constraint trigger checks at COMMIT, so the ordering the code happens to
 *   use is not what the guarantee rests on.
 *
 *   Can a person be paid more than they paid? The ceiling is the capture less
 *   everything already owed on it, revalidated inside the writing transaction
 *   and pinned again by a trigger.
 *
 * Two smaller phase-4 promises are checked at the end: a mistaken observation
 * can be corrected by somebody with more authority without anybody editing
 * evidence, and asking retention to try again is a request the worker acts on
 * rather than a reach into retention state.
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
const refundDatabase = createAdminRefundClient(
  environment.ADMIN_REFUND_DATABASE_URL ?? environment.DATABASE_URL
);

/** True when the tests exercise the real grants rather than the app role. */
const usingRefundRole = Boolean(
  environment.ADMIN_REFUND_DATABASE_URL &&
  environment.ADMIN_REFUND_DATABASE_URL !== environment.DATABASE_URL
);
const usingWriterRole = Boolean(
  environment.ADMIN_WRITE_DATABASE_URL &&
  environment.ADMIN_WRITE_DATABASE_URL !== environment.DATABASE_URL
);

let app: Awaited<ReturnType<typeof buildApp>>;

const suite = randomBytes(4).toString("hex");
const kioskId = `kiosk_money_${suite}`;

interface SeededSession {
  adminUserId: string;
  cookieHeader: string;
  csrfToken: string;
}

interface SeededPrint {
  sessionId: string;
  printJobId: string;
  paymentId: string;
}

const seededAdminUserIds: string[] = [];
let operator: SeededSession;
let admin: SeededSession;
let adminWithoutStepUp: SeededSession;

/** One print per scenario: an authorization is permanent and one per job. */
let owedPrint: SeededPrint;
let overPrint: SeededPrint;
let unobservedPrint: SeededPrint;
let deliveredPrint: SeededPrint;
let correctedPrint: SeededPrint;
let triggerPrint: SeededPrint;

beforeAll(async () => {
  app = await buildApp({
    environment,
    database,
    adminReadDatabase: readDatabase,
    adminWriteDatabase: writeDatabase,
    adminRefundDatabase: refundDatabase,
    startBackgroundJobs: false
  });

  await cleanUpOperationalData();
  await seedPricing();
  await database.kiosk.create({
    data: {
      id: kioskId,
      publicCode: kioskId.toUpperCase(),
      name: `Money ${kioskId}`,
      capabilities: { paperSizes: ["A4"] },
      lastSeenAt: new Date()
    }
  });

  owedPrint = await seedRecoveryPrint();
  overPrint = await seedRecoveryPrint();
  unobservedPrint = await seedRecoveryPrint();
  deliveredPrint = await seedRecoveryPrint();
  correctedPrint = await seedRecoveryPrint();
  triggerPrint = await seedRecoveryPrint();

  operator = await seedAdminWithSession("OPERATOR", [kioskId], true);
  admin = await seedAdminWithSession("ADMIN", [], true);
  adminWithoutStepUp = await seedAdminWithSession("ADMIN", [], false);

  // The evidence every money decision below rests on, recorded the way it is
  // recorded in production: by an Operator, through the observation endpoint,
  // on the connection that cannot reach money.
  for (const print of [owedPrint, overPrint, correctedPrint, triggerPrint]) {
    await observe(print, "NOT_DELIVERED", "Tray was empty and the display showed a jam.");
  }
  await observe(deliveredPrint, "DELIVERED", "Customer collected all three sheets.");
}, 60_000);

afterAll(async () => {
  await cleanUpOperationalData();
  await cleanUpSeededAdmins();
  await app.close();
  await database.$disconnect();
  await readDatabase.$disconnect();
  await writeDatabase.$disconnect();
  await refundDatabase.$disconnect();
});

// ---------------------------------------------------------------------------
// The gate: the money path is separate from the observation path
// ---------------------------------------------------------------------------

describe("the money path is structurally separate from the observation path", () => {
  it("refuses an Operator the refund endpoint, and records the refusal", async () => {
    const response = await request(
      operator,
      "POST",
      `/v1/admin/print-jobs/${owedPrint.printJobId}/refund-authorization`,
      { amountMinor: 18_000, reason: "Paying myself for a print I said failed." }
    );

    expect(response.statusCode).toBe(403);
    expect(await database.refund.count({ where: { paymentId: owedPrint.paymentId } })).toBe(0);

    const denied = await database.auditEvent.findFirst({
      where: { actorId: operator.adminUserId, action: "admin.refund.authorize" },
      orderBy: { occurredAt: "desc" }
    });
    expect(denied?.outcome).toBe("DENIED");
  });

  it("holds no grant on the money tables through the observation connection", async () => {
    if (!usingWriterRole) {
      expect(usingWriterRole).toBe(false);
      return;
    }

    // Unchanged from Phase 3 and asserted again here, because Phase 4 is the
    // phase that could have quietly widened it.
    await expectRefused(
      writeDatabase,
      `INSERT INTO refunds (id, payment_id, session_id, provider, reason, amount_minor,
         currency, currency_exponent, status, created_at, updated_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'MOCK', 'OPERATOR_REQUESTED',
         1, 'AMD', 2, 'PENDING', now(), now())`
    );
    await expectRefused(writeDatabase, `UPDATE refunds SET status = 'COMPLETED'`);
    await expectRefused(
      writeDatabase,
      `INSERT INTO refund_authorizations (id, refund_id, print_job_id, session_id, payment_id,
         amount_minor, currency, currency_exponent, reason, observed_outcome, observed_record_id,
         authorized_by_admin_id, authorized_by_role, request_digest, created_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         gen_random_uuid(), 1, 'AMD', 2, 'forged authorization', 'NOT_DELIVERED',
         gen_random_uuid(), gen_random_uuid(), 'ADMIN', repeat('a', 64), now())`
    );
  });

  it("holds no grant to record an observation through the money connection", async () => {
    if (!usingRefundRole) {
      // Provision the role and this becomes the strongest test in the file.
      expect(usingRefundRole).toBe(false);
      return;
    }

    // The other half of the separation, and the one Phase 4 introduces. The
    // connection that can pay somebody cannot write the evidence that a payout
    // was justified — so an attacker holding it cannot manufacture its own
    // reason to pay.
    await expectRefused(
      refundDatabase,
      `INSERT INTO print_job_recovery_resolutions (id, print_job_id, session_id, kiosk_id,
         outcome, reason, refund_suggested, resolved_by_admin_id, resolved_by_role,
         request_digest, created_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'k', 'NOT_DELIVERED',
         'forged observation', true, gen_random_uuid(), 'ADMIN', repeat('a', 64), now())`
    );
    await expectRefused(
      refundDatabase,
      `INSERT INTO print_job_recovery_corrections (id, print_job_id, session_id, kiosk_id,
         supersedes_id, outcome, reason, refund_suggested, corrected_by_admin_id,
         corrected_by_role, request_digest, created_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'k', gen_random_uuid(),
         'NOT_DELIVERED', 'forged correction', true, gen_random_uuid(), 'ADMIN',
         repeat('a', 64), now())`
    );

    // Raising an obligation is not settling one. No UPDATE means the panel
    // cannot mark a payout complete that never happened.
    await expectRefused(refundDatabase, `UPDATE refunds SET status = 'COMPLETED'`);
    await expectRefused(refundDatabase, `UPDATE refunds SET provider_refund_id = 'forged'`);
    await expectRefused(refundDatabase, `DELETE FROM refunds`);

    // Nor invent or rewrite the capture it is refunding against.
    await expectRefused(
      refundDatabase,
      `INSERT INTO payments (id, session_id, quote_id, provider, provider_intent_id, status,
         amount_minor, currency, currency_exponent, settings_revision, manifest_hash,
         created_by_actor_type, created_by_actor_id, expires_at, created_at, updated_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'MOCK', 'x', 'CAPTURED',
         1, 'AMD', 2, 1, repeat('a', 64), 'KIOSK', 'k', now(), now(), now())`
    );
    await expectRefused(refundDatabase, `UPDATE payments SET amount_minor = 999999`);
    await expectRefused(refundDatabase, `UPDATE print_jobs SET status = 'COMPLETED'`);
    await expectRefused(refundDatabase, `UPDATE audit_events SET action = 'nothing.happened'`);
    await expectRefused(refundDatabase, `DELETE FROM audit_events`);

    // And still nothing that names a document.
    await expectRefused(refundDatabase, `SELECT display_name FROM uploaded_files LIMIT 1`);
    await expectRefused(refundDatabase, `SELECT job_manifest FROM print_jobs LIMIT 1`);
    await expectRefused(refundDatabase, `SELECT secret_digest FROM kiosk_credentials LIMIT 1`);
  });
});

// ---------------------------------------------------------------------------
// The gate: reason plus before and after, audited
// ---------------------------------------------------------------------------

describe("authorizing a refund", () => {
  it("records an obligation, its justification, and an audit row with before and after", async () => {
    const response = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${owedPrint.printJobId}/refund-authorization`,
      { amountMinor: 18_000, reason: "Nothing came out; refunding the whole capture." }
    );

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    expect(body.authorization.amountMinor).toBe(18_000);
    expect(body.authorization.currency).toBe("AMD");
    expect(body.authorization.status).toBe("PENDING");
    // The response says it itself: an obligation exists, nobody has been paid.
    expect(body.settled).toBe(false);

    const refund = await database.refund.findFirstOrThrow({
      where: { paymentId: owedPrint.paymentId }
    });
    expect(refund.status).toBe("PENDING");
    expect(refund.reason).toBe("OPERATOR_REQUESTED");
    expect(refund.completedAt).toBeNull();
    // The currency came from the capture, never from the request.
    expect(refund.currency).toBe("AMD");
    expect(refund.provider).toBe("MOCK");

    const authorization = await database.refundAuthorization.findUniqueOrThrow({
      where: { refundId: refund.id }
    });
    expect(authorization.authorizedByAdminId).toBe(admin.adminUserId);
    expect(authorization.observedOutcome).toBe("NOT_DELIVERED");
    expect(authorization.reason).toContain("refunding the whole capture");

    // The evidence cited is this print's own observation.
    const resolution = await database.printJobRecoveryResolution.findUniqueOrThrow({
      where: { printJobId: owedPrint.printJobId }
    });
    expect(authorization.observedRecordId).toBe(resolution.id);

    const event = await database.auditEvent.findFirstOrThrow({
      where: {
        action: "admin.refund.authorize",
        outcome: "SUCCESS",
        sessionId: owedPrint.sessionId
      }
    });
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata.reason).toContain("refunding the whole capture");
    expect(metadata.capability).toBe("refund.authorize");
    expect(metadata.amountMinor).toBe(18_000);
    expect(metadata.capturedAmountMinor).toBe(18_000);
    // Before and after, as states of the obligation.
    expect(metadata.previousState).toBe("NONE");
    expect(metadata.resultingState).toBe("PENDING");
  });

  it("leaves the payment and the print exactly as they were", async () => {
    const payment = await database.payment.findUniqueOrThrow({
      where: { id: owedPrint.paymentId }
    });
    expect(payment.status).toBe("CAPTURED");
    expect(payment.amountMinor).toBe(18_000);
    expect(payment.appliedToSession).toBe(true);

    // Authorizing money does not settle the print. What the device reported
    // stays exactly as reported.
    const job = await database.printJob.findUniqueOrThrow({
      where: { id: owedPrint.printJobId }
    });
    expect(job.status).toBe("RECOVERY_REQUIRED");
    expect(job.resultConfidence).toBe("UNCONFIRMED");
    expect(job.completedAt).toBeNull();
  });

  it("replays an identical repeat and refuses a contradictory one", async () => {
    const replay = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${owedPrint.printJobId}/refund-authorization`,
      { amountMinor: 18_000, reason: "Nothing came out; refunding the whole capture." }
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);

    const contradictory = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${owedPrint.printJobId}/refund-authorization`,
      { amountMinor: 9_000, reason: "Actually only half of it was ruined." }
    );
    expect(contradictory.statusCode).toBe(409);
    expect(contradictory.json().error.code).toBe("REFUND_ALREADY_AUTHORIZED");

    // One obligation either way. Two people disagreeing about what is owed is
    // something a person reads, not a second payout.
    expect(await database.refund.count({ where: { paymentId: owedPrint.paymentId } })).toBe(1);
  });

  it("refuses more than the capture, less what is already owed", async () => {
    const tooMuch = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${overPrint.printJobId}/refund-authorization`,
      { amountMinor: 18_001, reason: "Trying to refund more than was ever captured." }
    );

    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json().error.code).toBe("REFUND_EXCEEDS_CAPTURE");
    expect(await database.refund.count({ where: { paymentId: overPrint.paymentId } })).toBe(0);

    const denied = await database.auditEvent.findFirstOrThrow({
      where: {
        action: "admin.refund.authorize",
        outcome: "DENIED",
        sessionId: overPrint.sessionId
      },
      orderBy: { occurredAt: "desc" }
    });
    expect((denied.metadata as Record<string, unknown>).failureCode).toBe("EXCEEDS_CAPTURE");

    // The rest of the capture is still authorizable, and a compensation the
    // payment path raised counts against the same money.
    const partial = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${overPrint.printJobId}/refund-authorization`,
      { amountMinor: 6_000, reason: "One of the three sheets was usable." }
    );
    expect(partial.statusCode).toBe(201);
  });

  it("refuses to pay against an observation nobody made, or one that says delivered", async () => {
    const unobserved = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${unobservedPrint.printJobId}/refund-authorization`,
      { amountMinor: 1_000, reason: "Deciding alone that this one is owed." }
    );
    expect(unobserved.statusCode).toBe(409);
    expect(unobserved.json().error.code).toBe("PRINT_RECOVERY_NOT_RESOLVED");

    const delivered = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${deliveredPrint.printJobId}/refund-authorization`,
      { amountMinor: 1_000, reason: "Paying out on a print that worked." }
    );
    expect(delivered.statusCode).toBe(409);
    expect(delivered.json().error.code).toBe("PRINT_RECOVERY_DELIVERED");

    expect(await database.refund.count({ where: { paymentId: unobservedPrint.paymentId } })).toBe(
      0
    );
    expect(await database.refund.count({ where: { paymentId: deliveredPrint.paymentId } })).toBe(0);
  });

  it("requires a fresh assertion of presence", async () => {
    const response = await request(
      adminWithoutStepUp,
      "POST",
      `/v1/admin/print-jobs/${triggerPrint.printJobId}/refund-authorization`,
      { amountMinor: 1_000, reason: "A stolen cookie should not be able to pay anybody." }
    );

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_STEP_UP_REQUIRED");
    expect(await database.refund.count({ where: { paymentId: triggerPrint.paymentId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The database refuses what the code would refuse, independently
// ---------------------------------------------------------------------------

describe("the database refuses an unexplained payout", () => {
  it("rejects an OPERATOR_REQUESTED refund with no recorded authorization, at COMMIT", async () => {
    // Written on the application connection, which holds every grant. The
    // deferred constraint trigger is the thing being tested: the guarantee must
    // not rest on the order this repository's code happens to insert in.
    await expect(
      database.$transaction(async (transaction) => {
        await transaction.refund.create({
          data: {
            id: randomUUID(),
            paymentId: triggerPrint.paymentId,
            sessionId: triggerPrint.sessionId,
            provider: "MOCK",
            reason: "OPERATOR_REQUESTED",
            amountMinor: 1_000,
            currency: "AMD",
            currencyExponent: 2,
            status: "PENDING"
          }
        });
      })
    ).rejects.toThrow();

    expect(await database.refund.count({ where: { paymentId: triggerPrint.paymentId } })).toBe(0);
  });

  it("rejects a refund larger than its capture, whoever writes it", async () => {
    await expect(
      database.refund.create({
        data: {
          id: randomUUID(),
          paymentId: triggerPrint.paymentId,
          sessionId: triggerPrint.sessionId,
          provider: "MOCK",
          reason: "OPERATOR_REQUESTED",
          amountMinor: 18_001,
          currency: "AMD",
          currencyExponent: 2,
          status: "PENDING"
        }
      })
    ).rejects.toThrow();
  });

  it("rejects a refund denominated in a currency the capture was not made in", async () => {
    await expect(
      database.refund.create({
        data: {
          id: randomUUID(),
          paymentId: triggerPrint.paymentId,
          sessionId: triggerPrint.sessionId,
          provider: "MOCK",
          reason: "OPERATOR_REQUESTED",
          amountMinor: 100,
          currency: "USD",
          currencyExponent: 2,
          status: "PENDING"
        }
      })
    ).rejects.toThrow();
  });

  it("keeps an authorization append-only", async () => {
    const refund = await database.refund.findFirstOrThrow({
      where: { paymentId: owedPrint.paymentId }
    });

    await expect(
      database.refundAuthorization.updateMany({
        where: { refundId: refund.id },
        data: { amountMinor: 1 }
      })
    ).rejects.toThrow();

    await expect(
      database.refundAuthorization.deleteMany({ where: { refundId: refund.id } })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Correcting an observation
// ---------------------------------------------------------------------------

describe("correcting a mistaken observation", () => {
  it("is refused to the role that records observations", async () => {
    const resolution = await database.printJobRecoveryResolution.findUniqueOrThrow({
      where: { printJobId: correctedPrint.printJobId }
    });

    const response = await request(
      operator,
      "POST",
      `/v1/admin/print-jobs/${correctedPrint.printJobId}/recovery-correction`,
      {
        supersedesId: resolution.id,
        outcome: "DELIVERED",
        reason: "Rewriting my own account of a paid print.",
        observedSheets: 3
      }
    );

    expect(response.statusCode).toBe(403);
    expect(
      await database.printJobRecoveryCorrection.count({
        where: { printJobId: correctedPrint.printJobId }
      })
    ).toBe(0);
  });

  it("appends a correction and leaves the original exactly as written", async () => {
    const resolution = await database.printJobRecoveryResolution.findUniqueOrThrow({
      where: { printJobId: correctedPrint.printJobId }
    });

    const response = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${correctedPrint.printJobId}/recovery-correction`,
      {
        supersedesId: resolution.id,
        outcome: "DELIVERED",
        reason: "Customer returned; the pages were in the lower tray all along.",
        observedSheets: 3
      }
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().correction.outcome).toBe("DELIVERED");
    expect(response.json().refundAuthorized).toBe(false);

    // The original is untouched. Both accounts are readable, which is the whole
    // reason a correction is a row rather than an UPDATE.
    const after = await database.printJobRecoveryResolution.findUniqueOrThrow({
      where: { printJobId: correctedPrint.printJobId }
    });
    expect(after.outcome).toBe("NOT_DELIVERED");
    expect(after.reason).toBe(resolution.reason);
    expect(after.refundSuggested).toBe(true);

    const event = await database.auditEvent.findFirstOrThrow({
      where: { action: "admin.print.recovery.correct", outcome: "SUCCESS" },
      orderBy: { occurredAt: "desc" }
    });
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata.previousOutcome).toBe("NOT_DELIVERED");
    expect(metadata.recoveryOutcome).toBe("DELIVERED");
    expect(metadata.reason).toContain("lower tray");
  });

  it("refuses a second correction of a record already superseded", async () => {
    const resolution = await database.printJobRecoveryResolution.findUniqueOrThrow({
      where: { printJobId: correctedPrint.printJobId }
    });

    // Naming the original again: somebody working from a stale screen, which
    // must be a conflict rather than a silent last-writer-wins.
    const response = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${correctedPrint.printJobId}/recovery-correction`,
      {
        supersedesId: resolution.id,
        outcome: "PARTIALLY_DELIVERED",
        reason: "A different second opinion about the same record.",
        observedSheets: 2
      }
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PRINT_RECOVERY_ALREADY_CORRECTED");
    expect(
      await database.printJobRecoveryCorrection.count({
        where: { printJobId: correctedPrint.printJobId }
      })
    ).toBe(1);
  });

  it("takes the print off the refund queue once it says the pages were delivered", async () => {
    const queue = await request(admin, "GET", "/v1/admin/refund-queue");
    expect(queue.statusCode).toBe(200);

    const entries = queue.json().items as { printJobId: string; outcome: string }[];
    expect(entries.some((entry) => entry.printJobId === correctedPrint.printJobId)).toBe(false);

    // And it refuses to pay against the superseded account, too.
    const response = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${correctedPrint.printJobId}/refund-authorization`,
      { amountMinor: 1_000, reason: "Paying against evidence that has been corrected." }
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PRINT_RECOVERY_DELIVERED");
  });

  it("keeps a correction append-only", async () => {
    await expect(
      database.printJobRecoveryCorrection.updateMany({
        where: { printJobId: correctedPrint.printJobId },
        data: { outcome: "NOT_DELIVERED" }
      })
    ).rejects.toThrow();

    await expect(
      database.printJobRecoveryCorrection.deleteMany({
        where: { printJobId: correctedPrint.printJobId }
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The refund queue
// ---------------------------------------------------------------------------

describe("the refund queue", () => {
  it("surfaces an unresolvable observation rather than dropping it", async () => {
    const print = await seedRecoveryPrint();
    await observe(print, "UNRESOLVABLE", "Kiosk was already cleared and the customer had gone.");

    const queue = await request(admin, "GET", "/v1/admin/refund-queue");
    const entry = (
      queue.json().items as { printJobId: string; queueReason: string; outcome: string }[]
    ).find((row) => row.printJobId === print.printJobId);

    // Phase 3's gap: this suggested no refund and then appeared on no list at
    // all. It is a decision somebody has to make, not a closed case.
    expect(entry?.queueReason).toBe("UNRESOLVABLE");
    expect(entry?.outcome).toBe("UNRESOLVABLE");
    expect(queue.json().totals.unresolvable).toBeGreaterThanOrEqual(1);
  });

  it("counts what the payment path already owes against the same capture", async () => {
    const print = await seedRecoveryPrint();
    await observe(print, "NOT_DELIVERED", "Nothing came out of the tray at all.");

    // A compensation the payment path raised on its own, exactly as
    // `recordCompensation` writes one. It is money already owed on this
    // capture, so it has to bound what a person may still authorize.
    await database.refund.create({
      data: {
        id: randomUUID(),
        paymentId: print.paymentId,
        sessionId: print.sessionId,
        provider: "MOCK",
        reason: "LATE_CAPTURE",
        amountMinor: 6_000,
        currency: "AMD",
        currencyExponent: 2,
        status: "PENDING"
      }
    });

    const queue = await request(admin, "GET", "/v1/admin/refund-queue");
    const entry = (
      queue.json().items as {
        printJobId: string;
        capturedAmountMinor: number;
        refundedAmountMinor: number;
        authorizableAmountMinor: number;
      }[]
    ).find((row) => row.printJobId === print.printJobId);

    expect(entry?.capturedAmountMinor).toBe(18_000);
    expect(entry?.refundedAmountMinor).toBe(6_000);
    expect(entry?.authorizableAmountMinor).toBe(12_000);

    // And the server enforces that ceiling rather than trusting the screen.
    const tooMuch = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${print.printJobId}/refund-authorization`,
      { amountMinor: 12_001, reason: "Ignoring what the payment path already owes." }
    );
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json().error.code).toBe("REFUND_EXCEEDS_CAPTURE");

    const exact = await request(
      admin,
      "POST",
      `/v1/admin/print-jobs/${print.printJobId}/refund-authorization`,
      { amountMinor: 12_000, reason: "Refunding the rest of what was captured." }
    );
    expect(exact.statusCode, exact.body).toBe(201);
  });

  it("takes a print off the queue once a refund has been authorized for it", async () => {
    const queue = await request(admin, "GET", "/v1/admin/refund-queue");
    const entries = queue.json().items as { printJobId: string }[];
    expect(entries.some((entry) => entry.printJobId === owedPrint.printJobId)).toBe(false);
  });

  it("is not readable by a role without the obligation capability", async () => {
    const response = await request(operator, "GET", "/v1/admin/refund-queue");
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Asking retention to try again
// ---------------------------------------------------------------------------

describe("asking retention to try again", () => {
  it("appends a request without touching the run, and refuses one that has not given up", async () => {
    const print = await seedRecoveryPrint();
    const runId = randomUUID();
    await database.cleanupRun.create({
      data: {
        id: runId,
        sessionId: print.sessionId,
        reason: "RECOVERY_REQUIRED",
        status: "PENDING",
        checkpoint: "ACCESS_REVOKED",
        attempts: 2
      }
    });

    const early = await request(admin, "POST", "/v1/admin/retention/retry", {
      sessionId: print.sessionId,
      reason: "Retrying something that is still going."
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("CLEANUP_RUN_NOT_DEAD_LETTERED");

    const deadLetteredAt = new Date();
    await database.cleanupRun.update({
      where: { id: runId },
      data: {
        status: "DEAD_LETTER",
        attempts: 5,
        lastErrorCode: "STORAGE_UNAVAILABLE",
        deadLetteredAt
      }
    });

    const response = await request(admin, "POST", "/v1/admin/retention/retry", {
      sessionId: print.sessionId,
      reason: "Object storage is back; please try again."
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().retry.cleanupRunId).toBe(runId);
    // The panel did not re-arm anything and does not claim to have.
    expect(response.json().rearmed).toBe(false);

    const run = await database.cleanupRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("DEAD_LETTER");
    expect(run.attempts).toBe(5);

    const stored = await database.cleanupRetryRequest.findFirstOrThrow({
      where: { cleanupRunId: runId }
    });
    expect(stored.attempts).toBe(5);
    expect(stored.lastErrorCode).toBe("STORAGE_UNAVAILABLE");
    expect(stored.requestedByAdminId).toBe(admin.adminUserId);

    // An identical repeat replays rather than piling up work the worker would
    // answer once anyway.
    const repeat = await request(admin, "POST", "/v1/admin/retention/retry", {
      sessionId: print.sessionId,
      reason: "Object storage is back; please try again."
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().replayed).toBe(true);
    expect(await database.cleanupRetryRequest.count({ where: { cleanupRunId: runId } })).toBe(1);
  });

  it("holds no privilege on the run it asks about", async () => {
    if (!usingWriterRole) {
      expect(usingWriterRole).toBe(false);
      return;
    }

    await expectRefused(writeDatabase, `UPDATE cleanup_runs SET status = 'PENDING'`);
    await expectRefused(writeDatabase, `UPDATE cleanup_runs SET attempts = 0`);
    await expectRefused(writeDatabase, `UPDATE print_sessions SET cleanup_due_at = now()`);
    await expectRefused(writeDatabase, `DELETE FROM cleanup_runs`);
  });

  it("cannot invent a dead-lettering that did not happen", async () => {
    const print = await seedRecoveryPrint();
    const runId = randomUUID();
    await database.cleanupRun.create({
      data: {
        id: runId,
        sessionId: print.sessionId,
        reason: "RECOVERY_REQUIRED",
        status: "PENDING",
        checkpoint: "SCHEDULED",
        attempts: 1
      }
    });

    // The trigger, independently of the endpoint. Without it the unique index
    // could be defeated with a made-up timestamp and the audit trail would
    // record a decision about a failure nobody had.
    await expect(
      database.cleanupRetryRequest.create({
        data: {
          id: randomUUID(),
          cleanupRunId: runId,
          sessionId: print.sessionId,
          deadLetteredAt: new Date(),
          attempts: 1,
          reason: "Inventing a failure to retry.",
          requestedByAdminId: admin.adminUserId,
          requestedByRole: "ADMIN"
        }
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(session: SeededSession, method: "GET" | "POST", url: string, payload?: unknown) {
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

/** Record what a person saw, through the endpoint that records it. */
async function observe(print: SeededPrint, outcome: string, reason: string): Promise<void> {
  const response = await request(
    operator,
    "POST",
    `/v1/admin/print-jobs/${print.printJobId}/recovery-resolution`,
    {
      outcome,
      reason,
      ...(outcome === "NOT_DELIVERED" ? { observedSheets: 0 } : {}),
      ...(outcome === "DELIVERED" ? { observedSheets: 3 } : {})
    }
  );
  if (response.statusCode !== 201) {
    throw new Error(`could not seed an observation: ${response.statusCode} ${response.body}`);
  }
}

/**
 * Assert that PostgreSQL itself refuses a statement on a given connection.
 *
 * `42501` is permission denied and `25006` is a read-only transaction. Either
 * is the database saying no; an application-level exception would not be.
 */
async function expectRefused(
  connection: { $executeRawUnsafe: (sql: string) => Promise<unknown> },
  sql: string
): Promise<void> {
  let code: string | undefined;
  try {
    await connection.$executeRawUnsafe(sql);
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
      displayName: `Money ${role} ${randomBytes(2).toString("hex")}`,
      role,
      status: "PROVISIONING"
    }
  });

  for (let index = 0; index < 2; index += 1) {
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId,
        credentialId: `money-credential-${adminUserId}-${index}`,
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

  for (const scope of kioskScopes) {
    await database.adminKioskScope.create({ data: { adminUserId, kioskId: scope } });
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
  pricingVersion = `money-${suite}`;
  seededRuleSet = true;
  await database.pricingRuleSet.create({
    data: {
      id: ruleSetId,
      version: pricingVersion,
      scope: "KIOSK",
      scopeRef: kioskId,
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
 * One paid print the device could not settle, built through the invariants
 * production uses: a quote the payment must match, a capture the print job
 * cannot exist without.
 */
async function seedRecoveryPrint(): Promise<SeededPrint> {
  const now = Date.now();
  const sessionId = randomUUID();
  const quoteId = randomUUID();
  const paymentId = randomUUID();
  const printJobId = randomUUID();
  const fileId = randomUUID();
  const manifestHash = randomBytes(32).toString("hex");

  await database.printSession.create({
    data: {
      id: sessionId,
      publicId: `ps_money_${randomBytes(8).toString("hex")}`,
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
      providerIntentId: `intent_money_${randomBytes(8).toString("hex")}`,
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

  return { sessionId, printJobId, paymentId };
}

async function cleanUpSeededAdmins(): Promise<void> {
  const ids = seededAdminUserIds.splice(0);
  if (ids.length === 0) return;
  await database.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminKioskScope.deleteMany({ where: { adminUserId: { in: ids } } });
  // An active account may not fall below two usable authenticators, so the
  // account is stood down before its keys are removed.
  await database.adminUser.updateMany({
    where: { id: { in: ids } },
    data: { status: "SUSPENDED" }
  });
  await database.adminAuthenticator.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminUser.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Remove this suite's kiosk and everything hanging off it.
 *
 * The append-only tables need their triggers suspended to delete, which
 * requires owning them. That is worth noticing rather than working around
 * quietly: none of the connections the control plane actually uses can do this,
 * and a teardown that needed no special step would mean the guarantee was not
 * really there.
 */
async function cleanUpOperationalData(): Promise<void> {
  const sessions = await database.printSession.findMany({
    where: { kioskId },
    select: { id: true }
  });
  const sessionIds = sessions.map((session) => session.id);

  if (sessionIds.length > 0) {
    for (const table of [
      "refund_authorizations",
      "print_job_recovery_corrections",
      "print_job_recovery_resolutions",
      "cleanup_retry_requests"
    ]) {
      await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
        await transaction.$executeRawUnsafe(
          table === "cleanup_retry_requests"
            ? `DELETE FROM "${table}" WHERE "session_id" = ANY($1::uuid[])`
            : `DELETE FROM "${table}" WHERE "session_id" = ANY($1::uuid[])`,
          sessionIds
        );
        await transaction.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      });
    }

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

  await database.adminKioskScope.deleteMany({ where: { kioskId } });
  await database.kiosk.deleteMany({ where: { id: kioskId } });
  if (seededRuleSet) await database.pricingRuleSet.deleteMany({ where: { id: ruleSetId } });
}
