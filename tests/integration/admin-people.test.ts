import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AdminRole } from "../../packages/admin-access/src/index.js";
import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import {
  createAdminPeopleClient,
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
 * The Phase 4B acceptance gate.
 *
 * Everything the control plane could do before this phase appends. This is the
 * first surface that changes a row somebody's access depends on, so the
 * questions are about what that connection cannot reach.
 *
 *   Can it promote anybody? `admin_users.role` is not among the nine columns
 *   the people role may UPDATE, so the answer has to be no at the database
 *   rather than in a handler — and it is asked that way below.
 *
 *   Can it manufacture an identity? It holds no INSERT on `admin_users`, none
 *   on `admin_authenticators` and none on `admin_sessions`. The only thing it
 *   can create that leads to a credential is a ticket, and a trigger confines
 *   that to an Operator account which has never held one.
 *
 *   Can it erase what it did? No DELETE anywhere, and no UPDATE on
 *   `audit_events`. Retiring a key, ending a session and taking a kiosk back
 *   are all timestamps on rows that stay.
 *
 *   Does the split between the two people capabilities hold? A Technical Admin
 *   can issue a ticket and retire a key; it is refused a suspension and a kiosk
 *   assignment, and the refusal is recorded.
 *
 * Every action runs through the real API on the least-privilege people role, so
 * these are statements about the deployed shape rather than about this file.
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
const peopleDatabase = createAdminPeopleClient(
  environment.ADMIN_PEOPLE_DATABASE_URL ?? environment.DATABASE_URL
);

/** True when the tests exercise the real grants rather than the app role. */
const usingPeopleRole = Boolean(
  environment.ADMIN_PEOPLE_DATABASE_URL &&
  environment.ADMIN_PEOPLE_DATABASE_URL !== environment.DATABASE_URL
);

let app: Awaited<ReturnType<typeof buildApp>>;

const suite = randomBytes(4).toString("hex");
const kioskId = `kiosk_people_${suite}`;
const otherKioskId = `kiosk_people_other_${suite}`;

interface SeededSession {
  adminUserId: string;
  cookieHeader: string;
  csrfToken: string;
}

const seededAdminUserIds: string[] = [];
let admin: SeededSession;
let technical: SeededSession;
let operatorSession: SeededSession;

beforeAll(async () => {
  app = await buildApp({
    environment,
    database,
    adminReadDatabase: readDatabase,
    adminWriteDatabase: writeDatabase,
    adminPeopleDatabase: peopleDatabase,
    startBackgroundJobs: false
  });

  await cleanUpSeededAdmins();
  for (const id of [kioskId, otherKioskId]) {
    await database.kiosk.create({
      data: {
        id,
        publicCode: id.toUpperCase(),
        name: `People ${id}`,
        capabilities: { paperSizes: ["A4"] },
        lastSeenAt: new Date()
      }
    });
  }

  admin = await seedSession("ADMIN", { steppedUp: true });
  technical = await seedSession("TECHNICAL_ADMIN", { steppedUp: true });
  operatorSession = await seedSession("OPERATOR", { steppedUp: true });
}, 60_000);

/**
 * A fresh session per test, on the same three accounts.
 *
 * The per-account rate limit is keyed on the session, and it is deliberately
 * tight — twenty people actions a minute from one signed-in session. A suite
 * driving forty of them through one session would be testing the rate limiter
 * rather than the phase, so each test starts with a new one.
 */
beforeEach(async () => {
  admin = await seedLiveSession(admin.adminUserId, { steppedUp: true });
  technical = await seedLiveSession(technical.adminUserId, { steppedUp: true });
  operatorSession = await seedLiveSession(operatorSession.adminUserId, { steppedUp: true });
});

afterAll(async () => {
  await cleanUpSeededAdmins();
  await database.kiosk.deleteMany({ where: { id: { in: [kioskId, otherKioskId] } } });
  await app.close();
  await database.$disconnect();
  await readDatabase.$disconnect();
  await writeDatabase.$disconnect();
  await peopleDatabase.$disconnect();
});

// ---------------------------------------------------------------------------
// The gate: what the people connection cannot reach
// ---------------------------------------------------------------------------

describe("the people connection is bounded by grants rather than by handlers", () => {
  it("cannot change anybody's role", async () => {
    if (!usingPeopleRole) return expectSkippedRoleCheck();

    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    const failure = await captureFailure(() =>
      peopleDatabase.$executeRawUnsafe(
        `UPDATE "admin_users" SET "role" = 'TECHNICAL_ADMIN' WHERE "id" = $1`,
        target
      )
    );

    // 42501 is insufficient_privilege: PostgreSQL refused the column, not a
    // trigger and not a check in this repository.
    expect(failure).toBe("42501");
    const unchanged = await database.adminUser.findUnique({ where: { id: target } });
    expect(unchanged?.role).toBe("OPERATOR");
  });

  it("cannot create an account, a credential or a session", async () => {
    if (!usingPeopleRole) return expectSkippedRoleCheck();

    const target = await seedOperator({ status: "ACTIVE", keys: 2 });

    expect(
      await captureFailure(() =>
        peopleDatabase.$executeRawUnsafe(
          `INSERT INTO "admin_users" ("id", "user_handle", "display_name", "role", "status")
           VALUES ($1, $2, 'Invented', 'ADMIN', 'ACTIVE')`,
          randomUUID(),
          randomBytes(32)
        )
      )
    ).toBe("42501");

    expect(
      await captureFailure(() =>
        peopleDatabase.$executeRawUnsafe(
          `INSERT INTO "admin_authenticators"
             ("id", "admin_user_id", "credential_id", "public_key", "label")
           VALUES ($1, $2, $3, $4, 'planted')`,
          randomUUID(),
          target,
          `planted-${suite}`,
          randomBytes(32)
        )
      )
    ).toBe("42501");

    expect(
      await captureFailure(() =>
        peopleDatabase.$executeRawUnsafe(
          `INSERT INTO "admin_sessions"
             ("id", "admin_user_id", "token_digest", "csrf_digest", "idle_expires_at", "hard_expires_at")
           VALUES ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '1 hour')`,
          randomUUID(),
          target,
          randomBytes(32).toString("hex"),
          randomBytes(32).toString("hex")
        )
      )
    ).toBe("42501");
  });

  it("cannot read a credential, a session token, or a ticket digest", async () => {
    if (!usingPeopleRole) return expectSkippedRoleCheck();

    for (const [table, column] of [
      ["admin_authenticators", "public_key"],
      ["admin_authenticators", "credential_id"],
      ["admin_sessions", "token_digest"],
      ["admin_users", "user_handle"],
      ["admin_enrollment_tickets", "secret_digest"]
    ] as const) {
      expect(
        await captureFailure(() =>
          peopleDatabase.$queryRawUnsafe(`SELECT "${column}" FROM "${table}" LIMIT 1`)
        )
      ).toBe("42501");
    }
  });

  it("cannot delete anything, or rewrite the audit log", async () => {
    if (!usingPeopleRole) return expectSkippedRoleCheck();

    for (const table of [
      "admin_users",
      "admin_authenticators",
      "admin_sessions",
      "admin_kiosk_scopes",
      "admin_enrollment_tickets",
      "audit_events"
    ]) {
      expect(
        await captureFailure(() => peopleDatabase.$executeRawUnsafe(`DELETE FROM "${table}"`))
      ).toBe("42501");
    }

    expect(
      await captureFailure(() =>
        peopleDatabase.$executeRawUnsafe(`UPDATE "audit_events" SET "outcome" = 'SUCCESS'`)
      )
    ).toBe("42501");
  });

  it("holds nothing at all on the printing system or on money", async () => {
    if (!usingPeopleRole) return expectSkippedRoleCheck();

    for (const table of ["print_jobs", "payments", "refunds", "uploaded_files", "cleanup_runs"]) {
      expect(
        await captureFailure(() =>
          peopleDatabase.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`)
        )
      ).toBe("42501");
    }
  });
});

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

describe("the two people capabilities are split", () => {
  it("refuses an Operator every people route, and records the refusal", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });

    for (const [url, payload] of [
      [`/v1/admin/people/${target}/status`, { status: "SUSPENDED", reason: "Trying it on." }],
      [
        `/v1/admin/people/${target}/kiosks`,
        { kioskId, granted: true, reason: "Trying it on as well." }
      ],
      [`/v1/admin/people/${target}/sessions/revoke`, { reason: "Trying it on again." }],
      [`/v1/admin/people/${target}/enrollment-ticket`, { reason: "Minting myself a colleague." }]
    ] as const) {
      const response = await request(operatorSession, "POST", url, payload);
      expect(response.statusCode).toBe(403);
    }

    const denied = await database.auditEvent.findMany({
      where: { actorId: operatorSession.adminUserId, outcome: "DENIED" }
    });
    expect(denied.length).toBeGreaterThanOrEqual(4);
    expect(denied.every((row) => row.action.startsWith("admin.people."))).toBe(true);
  });

  it("refuses a Technical Admin a suspension and a kiosk assignment", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });

    const suspension = await request(technical, "POST", `/v1/admin/people/${target}/status`, {
      status: "SUSPENDED",
      reason: "Not my capability to hold."
    });
    expect(suspension.statusCode).toBe(403);

    const assignment = await request(technical, "POST", `/v1/admin/people/${target}/kiosks`, {
      kioskId,
      granted: true,
      reason: "Also not my capability to hold."
    });
    expect(assignment.statusCode).toBe(403);

    const unchanged = await database.adminUser.findUnique({ where: { id: target } });
    expect(unchanged?.status).toBe("ACTIVE");
    expect(await database.adminKioskScope.count({ where: { adminUserId: target } })).toBe(0);
  });

  it("lets a Technical Admin issue a ticket and retire a key", async () => {
    const target = await seedOperator({ status: "PROVISIONING", keys: 0 });

    const ticket = await request(
      technical,
      "POST",
      `/v1/admin/people/${target}/enrollment-ticket`,
      { reason: "Onboarding at three in the morning, no Admin awake." }
    );
    expect(ticket.statusCode).toBe(200);
    expect(ticket.json().grantsSession).toBe(false);

    const keyed = await seedOperator({ status: "ACTIVE", keys: 3 });
    const key = await database.adminAuthenticator.findFirst({
      where: { adminUserId: keyed, revokedAt: null }
    });
    const retirement = await request(
      technical,
      "POST",
      `/v1/admin/people/${keyed}/authenticators/${key?.id}/revoke`,
      { reason: "Reported lost this morning." }
    );
    expect(retirement.statusCode).toBe(200);
  });

  it("refuses every people action against an account that is not an Operator, as a 404", async () => {
    // Not a 403: the panel must not become a way to find out who the Admins and
    // Technical Admins are.
    const response = await request(
      admin,
      "POST",
      `/v1/admin/people/${technical.adminUserId}/status`,
      {
        status: "SUSPENDED",
        reason: "Suspending a peer, which is not a thing."
      }
    );
    expect(response.statusCode).toBe(404);

    const unchanged = await database.adminUser.findUnique({
      where: { id: technical.adminUserId }
    });
    expect(unchanged?.status).toBe("ACTIVE");
  });

  it("shows only Operators on the roster", async () => {
    await seedOperator({ status: "ACTIVE", keys: 2 });
    const response = await request(admin, "GET", "/v1/admin/people");
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((person: { role: string }) => person.role === "OPERATOR")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(technical.adminUserId);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("account status", () => {
  it("suspends an account, ends its sessions, and records what changed", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    await seedLiveSession(target);
    await seedLiveSession(target);

    const response = await request(admin, "POST", `/v1/admin/people/${target}/status`, {
      status: "SUSPENDED",
      reason: "Left the company on Friday."
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      previousStatus: "ACTIVE",
      status: "SUSPENDED",
      revokedSessions: 2
    });

    const after = await database.adminUser.findUnique({ where: { id: target } });
    expect(after?.status).toBe("SUSPENDED");
    expect(after?.suspendedAt).not.toBeNull();
    // The role is untouched, and no path here could have touched it.
    expect(after?.role).toBe("OPERATOR");

    expect(
      await database.adminSession.count({ where: { adminUserId: target, revokedAt: null } })
    ).toBe(0);

    const event = await database.auditEvent.findFirst({
      where: { action: "admin.people.status", actorId: admin.adminUserId },
      orderBy: { occurredAt: "desc" }
    });
    expect(event?.outcome).toBe("SUCCESS");
    expect(event?.metadata).toMatchObject({
      targetAdminUserId: target,
      targetRole: "OPERATOR",
      previousState: "ACTIVE",
      resultingState: "SUSPENDED",
      revokedSessions: 2
    });
    // The reason is recorded; nothing about a customer ever is.
    expect(String((event?.metadata as { reason?: string }).reason)).toContain("Left the company");
  });

  it("gives access back without re-enrolling anything", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    await request(admin, "POST", `/v1/admin/people/${target}/status`, {
      status: "SUSPENDED",
      reason: "Suspended pending a conversation."
    });

    const resumed = await request(admin, "POST", `/v1/admin/people/${target}/status`, {
      status: "ACTIVE",
      reason: "Conversation had; back on shift tomorrow."
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().revokedSessions).toBe(0);
    const after = await database.adminUser.findUnique({
      where: { id: target },
      include: { authenticators: { where: { revokedAt: null } } }
    });
    expect(after?.status).toBe("ACTIVE");
    expect(after?.authenticators).toHaveLength(2);
  });

  it("treats DISABLED as terminal", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    const disabled = await request(admin, "POST", `/v1/admin/people/${target}/status`, {
      status: "DISABLED",
      reason: "Account shut down permanently."
    });
    expect(disabled.statusCode).toBe(200);

    const reopened = await request(admin, "POST", `/v1/admin/people/${target}/status`, {
      status: "ACTIVE",
      reason: "Trying to switch a dead identity back on."
    });
    expect(reopened.statusCode).toBe(409);
    expect((await database.adminUser.findUnique({ where: { id: target } }))?.status).toBe(
      "DISABLED"
    );
  });

  it("refuses to resume an account that never finished enrolling", async () => {
    const target = await seedOperator({ status: "PROVISIONING", keys: 0 });
    const response = await request(admin, "POST", `/v1/admin/people/${target}/status`, {
      status: "ACTIVE",
      reason: "Trying to activate somebody with no key at all."
    });
    expect(response.statusCode).toBe(409);
    expect((await database.adminUser.findUnique({ where: { id: target } }))?.status).toBe(
      "PROVISIONING"
    );
  });
});

// ---------------------------------------------------------------------------
// Kiosk assignment
// ---------------------------------------------------------------------------

describe("kiosk assignment", () => {
  it("assigns a kiosk, takes it back, and never deletes the record of either", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });

    const granted = await request(admin, "POST", `/v1/admin/people/${target}/kiosks`, {
      kioskId,
      granted: true,
      reason: "Covering the central branch from Monday."
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({ granted: true, changed: true });

    // A repeat is not a second grant.
    const again = await request(admin, "POST", `/v1/admin/people/${target}/kiosks`, {
      kioskId,
      granted: true,
      reason: "Clicking the button twice."
    });
    expect(again.json().changed).toBe(false);

    const revoked = await request(admin, "POST", `/v1/admin/people/${target}/kiosks`, {
      kioskId,
      granted: false,
      reason: "Moved to the other branch."
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ granted: false, changed: true });

    // The row survives the revocation, which is the point: who could act where
    // stays answerable.
    const row = await database.adminKioskScope.findUnique({
      where: { adminUserId_kioskId: { adminUserId: target, kioskId } }
    });
    expect(row).not.toBeNull();
    expect(row?.revokedAt).not.toBeNull();

    // And re-assigning clears it again on the same row rather than adding one.
    await request(admin, "POST", `/v1/admin/people/${target}/kiosks`, {
      kioskId,
      granted: true,
      reason: "Back at the central branch after all."
    });
    expect(await database.adminKioskScope.count({ where: { adminUserId: target } })).toBe(1);
  });

  it("stops a withdrawn Operator acting on that kiosk at their next action", async () => {
    // The property the `revokedAt` column exists for. A revocation has to bite
    // on the next action rather than on the next sign-in, or an Operator with a
    // live session keeps the kiosk they were just taken off.
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    await request(admin, "POST", `/v1/admin/people/${target}/kiosks`, {
      kioskId,
      granted: true,
      reason: "Assigned before the session was opened."
    });

    const session = await seedLiveSession(target, { steppedUp: true });
    const identity = await request(session, "GET", "/v1/admin/me");
    expect(identity.json().kioskScopes).toEqual([kioskId]);

    await request(admin, "POST", `/v1/admin/people/${target}/kiosks`, {
      kioskId,
      granted: false,
      reason: "Taken off this kiosk mid-shift."
    });

    const afterward = await request(session, "GET", "/v1/admin/me");
    expect(afterward.json().kioskScopes).toEqual([]);
  });

  it("refuses a kiosk that does not exist", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    const response = await request(admin, "POST", `/v1/admin/people/${target}/kiosks`, {
      kioskId: `kiosk_absent_${suite}`,
      granted: true,
      reason: "Assigning a kiosk nobody installed."
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Keys and sessions
// ---------------------------------------------------------------------------

describe("keys and sessions belonging to somebody else", () => {
  it("refuses a revocation that would leave an active account unable to sign in", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    const key = await database.adminAuthenticator.findFirst({
      where: { adminUserId: target, revokedAt: null }
    });

    const response = await request(
      admin,
      "POST",
      `/v1/admin/people/${target}/authenticators/${key?.id}/revoke`,
      { reason: "Retiring their last spare." }
    );

    expect(response.statusCode).toBe(409);
    expect(
      await database.adminAuthenticator.count({ where: { adminUserId: target, revokedAt: null } })
    ).toBe(2);
  });

  it("retires a key when a spare remains, and leaves the row in place", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 3 });
    const key = await database.adminAuthenticator.findFirst({
      where: { adminUserId: target, revokedAt: null }
    });

    const response = await request(
      admin,
      "POST",
      `/v1/admin/people/${target}/authenticators/${key?.id}/revoke`,
      { reason: "Reported lost this morning." }
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().usableAuthenticators).toBe(2);

    const retired = await database.adminAuthenticator.findUnique({ where: { id: key?.id } });
    expect(retired).not.toBeNull();
    expect(retired?.revokedAt).not.toBeNull();
  });

  it("ends every live session without touching the account", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    await seedLiveSession(target);
    await seedLiveSession(target);

    const response = await request(admin, "POST", `/v1/admin/people/${target}/sessions/revoke`, {
      reason: "Laptop left on a train."
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().revokedSessions).toBe(2);
    expect((await database.adminUser.findUnique({ where: { id: target } }))?.status).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Enrollment tickets
// ---------------------------------------------------------------------------

describe("enrollment tickets", () => {
  it("mints one that names an account with no key, and audits both the issue and the redemption", async () => {
    const target = await seedOperator({ status: "PROVISIONING", keys: 0 });

    const issued = await request(admin, "POST", `/v1/admin/people/${target}/enrollment-ticket`, {
      reason: "First day; enrolling their key at the counter."
    });

    expect(issued.statusCode).toBe(200);
    const body = issued.json();
    expect(body.targetAdminUserId).toBe(target);
    expect(body.grantsSession).toBe(false);
    expect(body.enrollmentCode).toMatch(/^[A-Za-z0-9_-]{40,}$/u);

    // The code is never stored in a form anything can read back.
    const stored = await database.adminEnrollmentTicket.findUnique({
      where: { id: body.ticketId }
    });
    expect(stored?.secretDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored?.secretDigest).not.toContain(body.enrollmentCode);
    expect(stored?.consumedAt).toBeNull();

    const issueEvent = await database.auditEvent.findFirst({
      where: { action: "admin.people.enrollment.issue", actorId: admin.adminUserId },
      orderBy: { occurredAt: "desc" }
    });
    expect(issueEvent?.outcome).toBe("SUCCESS");
    expect(issueEvent?.metadata).toMatchObject({
      targetAdminUserId: target,
      ticketId: body.ticketId
    });
    // The code itself is not in the audit row, and neither is anything derived
    // from it that could be replayed.
    expect(JSON.stringify(issueEvent?.metadata)).not.toContain(body.enrollmentCode);

    // Redemption opens a ceremony and burns the ticket. The WebAuthn half
    // cannot run here, so this asserts what happens up to the browser: a
    // ceremony bound to the right account, and a spent code.
    const opened = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/enrollment/registration/options",
      payload: { enrollmentCode: body.enrollmentCode }
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().ceremonyId).toBeTruthy();

    const consumed = await database.adminEnrollmentTicket.findUnique({
      where: { id: body.ticketId }
    });
    expect(consumed?.consumedAt).not.toBeNull();

    const redeemEvent = await database.auditEvent.findFirst({
      where: { action: "admin.enrollment.redeem", actorId: target },
      orderBy: { occurredAt: "desc" }
    });
    expect(redeemEvent?.outcome).toBe("SUCCESS");

    // Single use: the same code a second time is refused, in the same words a
    // wrong code gets.
    const replayed = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/enrollment/registration/options",
      payload: { enrollmentCode: body.enrollmentCode }
    });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json().error.code).toBe("ADMIN_ENROLLMENT_FAILED");
  });

  it("refuses to mint one for an account that already has a key", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    const response = await request(admin, "POST", `/v1/admin/people/${target}/enrollment-ticket`, {
      reason: "Trying to add a key to a working identity."
    });
    expect(response.statusCode).toBe(409);
    expect(await database.adminEnrollmentTicket.count({ where: { adminUserId: target } })).toBe(0);
  });

  it("refuses one for a suspended or disabled account", async () => {
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });
    await request(admin, "POST", `/v1/admin/people/${target}/status`, {
      status: "SUSPENDED",
      reason: "Suspended before anybody tried this."
    });

    const response = await request(admin, "POST", `/v1/admin/people/${target}/enrollment-ticket`, {
      reason: "Trying to enrol onto a suspended account."
    });
    expect(response.statusCode).toBe(409);
  });

  it("cannot be minted for a Technical Admin, at the database as well as the route", async () => {
    if (!usingPeopleRole) return expectSkippedRoleCheck();

    // The route refuses it as a 404 before this matters. The trigger is what
    // makes it true for anything else that ever holds this grant.
    const failure = await captureFailure(() =>
      peopleDatabase.$executeRawUnsafe(
        `INSERT INTO "admin_enrollment_tickets"
           ("id", "admin_user_id", "issued_by_admin_id", "secret_digest", "reason", "expires_at")
         VALUES ($1, $2, $3, $4, 'planted by hand', now() + interval '15 minutes')`,
        randomUUID(),
        technical.adminUserId,
        admin.adminUserId,
        randomBytes(32).toString("hex")
      )
    );
    expect(failure).toBe("23514");
  });

  it("cannot be issued to oneself", async () => {
    if (!usingPeopleRole) return expectSkippedRoleCheck();

    const failure = await captureFailure(() =>
      peopleDatabase.$executeRawUnsafe(
        `INSERT INTO "admin_enrollment_tickets"
           ("id", "admin_user_id", "issued_by_admin_id", "secret_digest", "reason", "expires_at")
         VALUES ($1, $2, $2, $3, 'authorising my own enrolment', now() + interval '15 minutes')`,
        randomUUID(),
        admin.adminUserId,
        randomBytes(32).toString("hex")
      )
    );
    expect(failure).toBe("23514");
  });

  it("refuses an expired code", async () => {
    const target = await seedOperator({ status: "PROVISIONING", keys: 0 });
    const issued = await request(admin, "POST", `/v1/admin/people/${target}/enrollment-ticket`, {
      reason: "Issued and then left too long."
    });
    const { ticketId, enrollmentCode } = issued.json();

    // Ageing the ticket needs a connection that owns the table; the people role
    // cannot move an expiry, which is itself the property being relied on. Both
    // timestamps move, because `expires_at > created_at` is a CHECK constraint
    // rather than a trigger and survives the suspension below — which is the
    // right outcome, and worth seeing here rather than only asserting.
    await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `ALTER TABLE "admin_enrollment_tickets" DISABLE TRIGGER USER`
      );
      await transaction.$executeRawUnsafe(
        `UPDATE "admin_enrollment_tickets"
            SET "created_at" = now() - interval '2 hours',
                "expires_at" = now() - interval '1 hour'
          WHERE "id" = $1`,
        ticketId
      );
      await transaction.$executeRawUnsafe(
        `ALTER TABLE "admin_enrollment_tickets" ENABLE TRIGGER USER`
      );
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/enrollment/registration/options",
      payload: { enrollmentCode }
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a code that was never issued", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/enrollment/registration/options",
      payload: { enrollmentCode: randomBytes(32).toString("base64url") }
    });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

describe("every people action is R2", () => {
  it("refuses each one without a fresh assertion", async () => {
    const stale = await seedSession("ADMIN", { steppedUp: false });
    const target = await seedOperator({ status: "ACTIVE", keys: 2 });

    for (const [url, payload] of [
      [`/v1/admin/people/${target}/status`, { status: "SUSPENDED", reason: "No key touched." }],
      [
        `/v1/admin/people/${target}/kiosks`,
        { kioskId, granted: true, reason: "No key touched here either." }
      ],
      [`/v1/admin/people/${target}/sessions/revoke`, { reason: "Still no key touched." }]
    ] as const) {
      const response = await request(stale, "POST", url, payload);
      expect(response.statusCode).toBe(401);
    }

    expect((await database.adminUser.findUnique({ where: { id: target } }))?.status).toBe("ACTIVE");
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

/**
 * Run a statement expected to be refused, and return the PostgreSQL error code.
 *
 * `42501` is insufficient_privilege and `23514` is check_violation. Reading the
 * code rather than the message is what makes these assertions about the grant
 * and the constraint rather than about the wording of an error.
 */
async function captureFailure(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return postgresErrorCode(error);
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  const walk = (value: unknown, depth = 0): string | undefined => {
    if (depth > 6 || !value || typeof value !== "object") return undefined;
    const code = Reflect.get(value, "code");
    if (typeof code === "string" && /^\d{5}$/u.test(code)) return code;
    const meta = Reflect.get(value, "meta");
    const nested = walk(meta, depth + 1) ?? walk(Reflect.get(value, "cause"), depth + 1);
    if (nested) return nested;
    const message = Reflect.get(value, "message");
    if (typeof message === "string") {
      const matched = /\b(42501|23514|23503|25006)\b/u.exec(message);
      if (matched) return matched[1];
    }
    return undefined;
  };
  return walk(error);
}

/**
 * Development may run without the dedicated role, in which case the grant
 * assertions have nothing to assert. Say so rather than passing quietly.
 */
function expectSkippedRoleCheck(): void {
  expect(usingPeopleRole).toBe(false);
}

async function seedOperator(options: {
  status: "PROVISIONING" | "ACTIVE";
  keys: number;
}): Promise<string> {
  const adminUserId = randomUUID();
  seededAdminUserIds.push(adminUserId);

  await database.adminUser.create({
    data: {
      id: adminUserId,
      userHandle: randomBytes(32),
      displayName: `People operator ${randomBytes(3).toString("hex")}`,
      role: "OPERATOR",
      status: "PROVISIONING"
    }
  });

  for (let index = 0; index < options.keys; index += 1) {
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId,
        credentialId: `people-credential-${adminUserId}-${index}`,
        publicKey: randomBytes(32),
        label: `key ${index}`,
        attachment: "cross-platform",
        backupEligible: false
      }
    });
  }

  if (options.status === "ACTIVE") {
    await database.adminUser.update({
      where: { id: adminUserId },
      data: { status: "ACTIVE", activatedAt: new Date() }
    });
  }

  return adminUserId;
}

async function seedSession(
  role: AdminRole,
  options: { steppedUp: boolean }
): Promise<SeededSession> {
  const adminUserId = randomUUID();
  seededAdminUserIds.push(adminUserId);

  await database.adminUser.create({
    data: {
      id: adminUserId,
      userHandle: randomBytes(32),
      displayName: `People ${role} ${randomBytes(2).toString("hex")}`,
      role,
      status: "PROVISIONING"
    }
  });

  for (let index = 0; index < 2; index += 1) {
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId,
        credentialId: `people-session-${adminUserId}-${index}`,
        publicKey: randomBytes(32),
        label: `key ${index}`,
        attachment: "cross-platform",
        backupEligible: false
      }
    });
  }

  await database.adminUser.update({
    where: { id: adminUserId },
    data: { status: "ACTIVE", activatedAt: new Date() }
  });

  return seedLiveSession(adminUserId, { steppedUp: options.steppedUp });
}

async function seedLiveSession(
  adminUserId: string,
  options: { steppedUp?: boolean } = {}
): Promise<SeededSession> {
  const now = Date.now();
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
      ...(options.steppedUp ? { lastStepUpAt: new Date(now) } : {})
    }
  });

  return {
    adminUserId,
    csrfToken,
    cookieHeader: `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`
  };
}

/**
 * Remove this suite's accounts.
 *
 * Tickets go first: they hold `ON DELETE RESTRICT` to the accounts they name,
 * which is the property that stops an account being removed while the record of
 * an enrolment it authorised still stands.
 */
async function cleanUpSeededAdmins(): Promise<void> {
  const ids = seededAdminUserIds.splice(0);
  if (ids.length === 0) return;

  await database.adminEnrollmentTicket.deleteMany({
    where: { OR: [{ adminUserId: { in: ids } }, { issuedByAdminId: { in: ids } }] }
  });
  await database.adminWebAuthnChallenge.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminBreakGlassCredential.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminKioskScope.deleteMany({ where: { adminUserId: { in: ids } } });
  // Suspend first: the keep-a-spare trigger refuses to strip an ACTIVE account,
  // which is the invariant these tests rely on elsewhere.
  await database.adminUser.updateMany({
    where: { id: { in: ids }, status: { not: "DISABLED" } },
    data: { status: "SUSPENDED" }
  });
  await database.adminAuthenticator.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminUser.deleteMany({ where: { id: { in: ids } } });
}
