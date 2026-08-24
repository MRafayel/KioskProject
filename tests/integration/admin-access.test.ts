import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { capabilitiesForRole, type AdminRole } from "../../packages/admin-access/src/index.js";
import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import { createDatabaseClient } from "../../packages/database/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE
} from "../../services/api/src/modules/admin/authorize.js";
import {
  digestAdminCsrfToken,
  digestAdminSessionToken
} from "../../services/api/src/modules/admin/crypto.js";
import { hashPassword } from "../../services/api/src/modules/admin/passwords.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

/**
 * The Phase 1 acceptance gate.
 *
 * These tests do not exercise the WebAuthn ceremonies themselves — that needs a
 * real authenticator, and the cryptography belongs to a reviewed library. What
 * they exercise is everything this system decided on its own: who may call
 * what, what a stolen cookie is worth, whether a hidden button is still refused
 * on the server, and whether the audit trail can be edited.
 *
 * Sessions are inserted directly rather than earned through a ceremony,
 * because the question under test is what a *valid* session is allowed to do.
 */

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({ ...process.env, NODE_ENV: "test" });
assertSafeIntegrationEnvironment(environment);

const database = createDatabaseClient(environment.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;

const seededAdminUserIds: string[] = [];

beforeAll(async () => {
  app = await buildApp({ environment, database, startBackgroundJobs: false });
});

afterAll(async () => {
  await cleanUpSeededAdmins();
  await app.close();
  await database.$disconnect();
});

beforeEach(async () => {
  await cleanUpSeededAdmins();
});

async function cleanUpSeededAdmins(): Promise<void> {
  const ids = seededAdminUserIds.splice(0);
  if (ids.length === 0) return;
  // Audit events are append-only and reference nothing deletable here, so they
  // are left in place; the accounts they name are removed.
  await database.adminWebAuthnChallenge.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminBreakGlassCredential.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminKioskScope.deleteMany({ where: { adminUserId: { in: ids } } });
  // Suspend first: the "keep a spare" trigger refuses to strip an ACTIVE
  // account, which is exactly the invariant these tests rely on elsewhere.
  await database.adminUser.updateMany({
    // DISABLED is permanent and already permits key cleanup. Every other
    // seeded state may transition to SUSPENDED.
    where: { id: { in: ids }, status: { not: "DISABLED" } },
    data: { status: "SUSPENDED" }
  });
  await database.adminAuthenticator.deleteMany({ where: { adminUserId: { in: ids } } });
  // The knowledge factor and the two kinds of one-time grant hold the account
  // by a RESTRICT foreign key, so they go first.
  await database.adminPassword.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminInvitation.deleteMany({
    where: { OR: [{ adminUserId: { in: ids } }, { issuedByAdminId: { in: ids } }] }
  });
  await database.adminPasswordReset.deleteMany({
    where: { OR: [{ adminUserId: { in: ids } }, { issuedByAdminId: { in: ids } }] }
  });
  await database.adminUser.deleteMany({ where: { id: { in: ids } } });
}

interface SeededSession {
  adminUserId: string;
  sessionToken: string;
  csrfToken: string;
  cookieHeader: string;
}

async function seedAdminWithSession(
  role: AdminRole,
  overrides: {
    steppedUpAgo?: number;
    revoked?: boolean;
    idleExpiredAgo?: number;
    /** Past the absolute limit, which no reauthentication can reopen. */
    hardExpiredAgo?: number;
    status?: "ACTIVE" | "SUSPENDED" | "DISABLED" | "PROVISIONING";
  } = {}
): Promise<SeededSession> {
  const now = Date.now();
  const adminUserId = randomUUID();
  seededAdminUserIds.push(adminUserId);

  await database.adminUser.create({
    data: {
      id: adminUserId,
      userHandle: randomBytes(32),
      username: `u-${adminUserId.slice(0, 12)}`,
      displayName: `Test ${role}`,
      role,
      status: "PROVISIONING"
    }
  });

  // No account may become ACTIVE without a password now.
  await database.adminPassword.create({
    data: { adminUserId, digest: await hashPassword("integration-suite-password") }
  });

  // One authenticator: a privileged account's second factor.
  for (let index = 0; index < 1; index += 1) {
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId,
        credentialId: `test-credential-${adminUserId}-${index}`,
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
  if (overrides.status && overrides.status !== "ACTIVE") {
    await database.adminUser.update({
      where: { id: adminUserId },
      data: { status: overrides.status }
    });
  }

  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await database.adminSession.create({
    data: {
      id: randomUUID(),
      adminUserId,
      tokenDigest: digestAdminSessionToken(sessionToken, environment.ADMIN_SESSION_PEPPER),
      csrfDigest: digestAdminCsrfToken(csrfToken, environment.ADMIN_SESSION_PEPPER),
      idleExpiresAt: new Date(
        (overrides.idleExpiredAgo ?? overrides.hardExpiredAgo)
          ? now - (overrides.idleExpiredAgo ?? overrides.hardExpiredAgo ?? 0)
          : now + 600_000
      ),
      hardExpiresAt: new Date(
        overrides.hardExpiredAgo ? now - overrides.hardExpiredAgo : now + 3_600_000
      ),
      ...(overrides.revoked ? { revokedAt: new Date(now - 1_000) } : {}),
      ...(overrides.steppedUpAgo === undefined
        ? {}
        : { lastStepUpAt: new Date(now - overrides.steppedUpAgo) })
    }
  });

  return {
    adminUserId,
    sessionToken,
    csrfToken,
    cookieHeader: `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`
  };
}

describe("unauthenticated access", () => {
  it("refuses every admin route without a session", async () => {
    for (const [method, url] of [
      ["GET", "/v1/admin/me"],
      ["GET", "/v1/admin/health"],
      ["GET", "/v1/admin/authenticators"],
      ["POST", "/v1/admin/auth/logout"],
      ["POST", "/v1/admin/auth/step-up/options"],
      ["POST", "/v1/admin/authenticators/registration/options"]
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json().error.code).toBe("ADMIN_AUTHENTICATION_REQUIRED");
    }
  });

  it("does not reveal whether an account exists", async () => {
    // Login names an account now, so the property this used to get for free
    // has to be asserted: a wrong password against a real account and any
    // password against an account that does not exist answer identically.
    const real = await seedAdminWithSession("ADMIN");
    const account = await database.adminUser.findUniqueOrThrow({
      where: { id: real.adminUserId },
      select: { username: true }
    });

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { username: account.username, password: "not-the-right-password" }
    });
    const noSuchAccount = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { username: "nobody-by-this-name", password: "not-the-right-password" }
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchAccount.statusCode).toBe(401);
    // Everything but the per-request identifier, which differs by design.
    expect(noSuchAccount.json().error.code).toBe(wrongPassword.json().error.code);
    expect(noSuchAccount.json().error.message).toBe(wrongPassword.json().error.message);
  });

  it("refuses a forged session cookie", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${randomBytes(32).toString("base64url")}` }
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("session lifecycle", () => {
  it("accepts a live session", async () => {
    const session = await seedAdminWithSession("OPERATOR");
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      adminUserId: session.adminUserId,
      role: "OPERATOR"
    });
  });

  it("refuses a revoked session immediately", async () => {
    const session = await seedAdminWithSession("ADMIN", { revoked: true });
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(response.statusCode).toBe(401);
  });

  it("locks an idle-expired session rather than destroying it", async () => {
    // The behaviour the whole rework exists for. `/me` reports the lock so the
    // page can draw a lock screen; every other route refuses with a code the
    // UI can tell apart from "sign in again"; and the session row survives, so
    // one reauthentication reopens it.
    const session = await seedAdminWithSession("ADMIN", { idleExpiredAgo: 1_000 });

    const me = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ state: "LOCKED", strongAuthMethod: "WEBAUTHN" });

    const work = await app.inject({
      method: "GET",
      url: "/v1/admin/health",
      headers: { cookie: session.cookieHeader }
    });
    expect(work.statusCode).toBe(401);
    expect(work.json().error.code).toBe("ADMIN_SESSION_LOCKED");

    await expect(
      database.adminSession.count({
        where: { adminUserId: session.adminUserId, revokedAt: null }
      })
    ).resolves.toBe(1);
  });

  it("reopens the same locked session on a correct password, keeping its absolute limit", async () => {
    const session = await seedAdminWithSession("OPERATOR", { idleExpiredAgo: 1_000 });
    const before = await database.adminSession.findFirstOrThrow({
      where: { adminUserId: session.adminUserId, revokedAt: null }
    });

    const unlocked = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/unlock/password",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken },
      payload: { password: "integration-suite-password" }
    });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json()).toMatchObject({ state: "ACTIVE" });

    // The same row, moved forward — not a new session, and not a later
    // absolute limit than the one it was issued with.
    const after = await database.adminSession.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.revokedAt).toBeNull();
    expect(after.idleExpiresAt.getTime()).toBeGreaterThan(before.idleExpiresAt.getTime());
    expect(after.hardExpiresAt.getTime()).toBe(before.hardExpiresAt.getTime());

    // And the reopened session works.
    const work = await app.inject({
      method: "GET",
      url: "/v1/admin/health",
      headers: { cookie: session.cookieHeader }
    });
    expect(work.statusCode).toBe(200);
  });

  it("refuses to unlock a session past its absolute limit: nothing saves that one", async () => {
    const session = await seedAdminWithSession("OPERATOR", { hardExpiredAgo: 1_000 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/unlock/password",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken },
      payload: { password: "integration-suite-password" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_AUTHENTICATION_REQUIRED");
  });

  it("refuses a session whose account was suspended", async () => {
    // The session row is still live; the account is not. Suspension must take
    // effect without waiting for the session to expire.
    const session = await seedAdminWithSession("TECHNICAL_ADMIN", { status: "SUSPENDED" });
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(response.statusCode).toBe(401);
  });

  it("revokes the session on logout and refuses the cookie afterwards", async () => {
    const session = await seedAdminWithSession("ADMIN");
    const logout = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken }
    });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("CSRF", () => {
  it("refuses a state-changing request with no CSRF header", async () => {
    const session = await seedAdminWithSession("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie: session.cookieHeader }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ADMIN_CSRF_FAILED");
  });

  it("refuses a CSRF token from a different session", async () => {
    const victim = await seedAdminWithSession("ADMIN");
    const attacker = await seedAdminWithSession("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: {
        // The victim's session cookie with the attacker's CSRF token in both
        // halves of the double submit.
        cookie: `${ADMIN_SESSION_COOKIE}=${victim.sessionToken}; ${ADMIN_CSRF_COOKIE}=${attacker.csrfToken}`,
        "x-csrf-token": attacker.csrfToken
      }
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses when the header and cookie halves disagree", async () => {
    const session = await seedAdminWithSession("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: {
        cookie: session.cookieHeader,
        "x-csrf-token": randomBytes(32).toString("base64url")
      }
    });
    expect(response.statusCode).toBe(403);
  });

  it("does not require CSRF for safe methods", async () => {
    const session = await seedAdminWithSession("OPERATOR");
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("capability enforcement", () => {
  it("grants dashboard.read to every role", async () => {
    for (const role of ["OPERATOR", "ADMIN", "TECHNICAL_ADMIN"] as const) {
      const session = await seedAdminWithSession(role);
      const response = await app.inject({
        method: "GET",
        url: "/v1/admin/health",
        headers: { cookie: session.cookieHeader }
      });
      expect(response.statusCode, role).toBe(200);
      expect(response.json()).toMatchObject({ authenticated: true, role });
    }
  });

  it("reports only the capabilities the signed-in role actually holds", async () => {
    for (const role of ["OPERATOR", "ADMIN", "TECHNICAL_ADMIN"] as const) {
      const session = await seedAdminWithSession(role);
      const response = await app.inject({
        method: "GET",
        url: "/v1/admin/me",
        headers: { cookie: session.cookieHeader }
      });
      expect(response.json().capabilities).toEqual([...capabilitiesForRole(role)]);
    }
  });

  it("never reports a document-content or kiosk-credential capability", async () => {
    for (const role of ["OPERATOR", "ADMIN", "TECHNICAL_ADMIN"] as const) {
      const session = await seedAdminWithSession(role);
      const response = await app.inject({
        method: "GET",
        url: "/v1/admin/me",
        headers: { cookie: session.cookieHeader }
      });
      const capabilities: string[] = response.json().capabilities;
      for (const capability of capabilities) {
        expect(capability.startsWith("kiosk.credential")).toBe(false);
        expect(capability.includes("document.content")).toBe(false);
        expect(capability.includes("sql")).toBe(false);
        expect(capability.includes("shell")).toBe(false);
      }
    }
  });
});

describe("step-up enforcement", () => {
  it("refuses an R2 action when the session has never stepped up", async () => {
    const session = await seedAdminWithSession("ADMIN");
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/authenticators/registration/options",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_STEP_UP_REQUIRED");
  });

  it("refuses an R2 action when the step-up has gone stale", async () => {
    const stale = environment.ADMIN_STEP_UP_TTL_SECONDS * 1_000 + 1_000;
    const session = await seedAdminWithSession("ADMIN", { steppedUpAgo: stale });
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/authenticators/registration/options",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_STEP_UP_REQUIRED");
  });

  it("allows an R2 action with a fresh step-up", async () => {
    const session = await seedAdminWithSession("ADMIN", { steppedUpAgo: 1_000 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/authenticators/registration/options",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("ceremonyId");
    expect(response.json().adminUserId).toBe(session.adminUserId);
  });

  it("lets an Operator manage their own keys, since that capability is theirs", async () => {
    // Every role holds `authenticator.manage.self`. Capability denial and the
    // ordering of the checks are covered by the authorize unit tests, where a
    // role can be paired with a capability it does not hold.
    const session = await seedAdminWithSession("OPERATOR", { steppedUpAgo: 1_000 });
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/authenticators/registration/options",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken }
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("authenticator invariants", () => {
  it("refuses to retire the last key of an active privileged account", async () => {
    // A password alone must not be enough to reach an administrator account,
    // so the second factor cannot be removed while the account is live: a
    // replacement is enrolled first.
    const session = await seedAdminWithSession("TECHNICAL_ADMIN", { steppedUpAgo: 1_000 });
    const authenticators = await database.adminAuthenticator.findMany({
      where: { adminUserId: session.adminUserId, revokedAt: null }
    });
    expect(authenticators).toHaveLength(1);

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/authenticators/${authenticators[0]!.id}/revoke`,
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken },
      payload: { reason: "LOST_KEY" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("ADMIN_AUTHENTICATOR_LAST_SPARE");
  });

  it("allows retiring a key once a replacement exists", async () => {
    const session = await seedAdminWithSession("TECHNICAL_ADMIN", { steppedUpAgo: 1_000 });
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId: session.adminUserId,
        credentialId: `test-credential-${session.adminUserId}-replacement`,
        publicKey: randomBytes(32),
        label: "replacement",
        attachment: "cross-platform",
        backupEligible: false
      }
    });

    const authenticators = await database.adminAuthenticator.findMany({
      where: { adminUserId: session.adminUserId, revokedAt: null }
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/authenticators/${authenticators[0]!.id}/revoke`,
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken },
      payload: { reason: "ROTATION" }
    });

    expect(response.statusCode).toBe(204);
  });

  it("refuses to retire an authenticator belonging to somebody else", async () => {
    const victim = await seedAdminWithSession("ADMIN");
    const attacker = await seedAdminWithSession("ADMIN", { steppedUpAgo: 1_000 });
    const victimKeys = await database.adminAuthenticator.findMany({
      where: { adminUserId: victim.adminUserId }
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/authenticators/${victimKeys[0]!.id}/revoke`,
      headers: { cookie: attacker.cookieHeader, "x-csrf-token": attacker.csrfToken },
      payload: { reason: "ATTACK" }
    });

    expect(response.statusCode).toBe(404);
  });

  it("accepts a platform authenticator for a Technical Admin, the rule having retired", async () => {
    // The device-bound requirement was right while WebAuthn stood alone. With
    // a password as the first factor it cost more in lockouts than it bought:
    // on a machine with no hardware key it forced a browser-lifetime virtual
    // authenticator and burned a break-glass code per restart. Asserted in the
    // affirmative so that reintroducing the rule fails here rather than in
    // somebody's browser.
    const session = await seedAdminWithSession("TECHNICAL_ADMIN");
    await expect(
      database.adminAuthenticator.create({
        data: {
          id: randomUUID(),
          adminUserId: session.adminUserId,
          credentialId: `test-credential-${session.adminUserId}-synced`,
          publicKey: randomBytes(32),
          label: "synced passkey",
          attachment: "platform",
          backupEligible: true
        }
      })
    ).resolves.toMatchObject({ label: "synced passkey" });
  });

  it("refuses to activate an account that holds a key but no password", async () => {
    const adminUserId = randomUUID();
    seededAdminUserIds.push(adminUserId);
    await database.adminUser.create({
      data: {
        id: adminUserId,
        userHandle: randomBytes(32),
        username: `u-${adminUserId.slice(0, 12)}`,
        displayName: "Half provisioned",
        role: "ADMIN",
        status: "PROVISIONING"
      }
    });
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId,
        credentialId: `test-credential-${adminUserId}-only`,
        publicKey: randomBytes(32),
        label: "only key",
        attachment: "cross-platform",
        backupEligible: false
      }
    });

    await expect(
      database.adminUser.update({ where: { id: adminUserId }, data: { status: "ACTIVE" } })
    ).rejects.toThrow();

    // The password is the missing half, and adding it is enough.
    await database.adminPassword.create({
      data: { adminUserId, digest: await hashPassword("integration-suite-password") }
    });
    await expect(
      database.adminUser.update({ where: { id: adminUserId }, data: { status: "ACTIVE" } })
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("refuses to activate a privileged account that holds a password but no key", async () => {
    const adminUserId = randomUUID();
    seededAdminUserIds.push(adminUserId);
    await database.adminUser.create({
      data: {
        id: adminUserId,
        userHandle: randomBytes(32),
        username: `u-${adminUserId.slice(0, 12)}`,
        displayName: "Keyless admin",
        role: "ADMIN",
        status: "PROVISIONING"
      }
    });
    await database.adminPassword.create({
      data: { adminUserId, digest: await hashPassword("integration-suite-password") }
    });

    await expect(
      database.adminUser.update({ where: { id: adminUserId }, data: { status: "ACTIVE" } })
    ).rejects.toThrow();
  });

  it("activates an Operator on a password alone: they sign in with no key", async () => {
    const adminUserId = randomUUID();
    seededAdminUserIds.push(adminUserId);
    await database.adminUser.create({
      data: {
        id: adminUserId,
        userHandle: randomBytes(32),
        username: `u-${adminUserId.slice(0, 12)}`,
        displayName: "Keyless operator",
        role: "OPERATOR",
        status: "PROVISIONING"
      }
    });
    await database.adminPassword.create({
      data: { adminUserId, digest: await hashPassword("integration-suite-password") }
    });

    await expect(
      database.adminUser.update({ where: { id: adminUserId }, data: { status: "ACTIVE" } })
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("serializes concurrent registrations so the count that activates is the committed one", async () => {
    const adminUserId = randomUUID();
    seededAdminUserIds.push(adminUserId);
    await database.adminUser.create({
      data: {
        id: adminUserId,
        userHandle: randomBytes(32),
        username: `u-${adminUserId.slice(0, 12)}`,
        displayName: "Concurrent enrolment",
        role: "ADMIN",
        status: "PROVISIONING"
      }
    });
    await database.adminPassword.create({
      data: { adminUserId, digest: await hashPassword("integration-suite-password") }
    });

    const firstInserted = deferred();
    const releaseFirst = deferred();
    const register = async (index: number, holdAfterCount: boolean): Promise<void> => {
      await database.$transaction(async (transaction) => {
        await transaction.adminAuthenticator.create({
          data: {
            id: randomUUID(),
            adminUserId,
            credentialId: `concurrent-registration-${adminUserId}-${index}`,
            publicKey: randomBytes(32),
            label: `key ${index}`,
            attachment: "cross-platform",
            backupEligible: false
          }
        });
        const usable = await transaction.adminAuthenticator.count({
          where: { adminUserId, revokedAt: null }
        });
        if (holdAfterCount) {
          firstInserted.resolve();
          await releaseFirst.promise;
        }
        if (usable >= 2) {
          await transaction.adminUser.update({
            where: { id: adminUserId },
            data: { status: "ACTIVE" }
          });
        }
      });
    };

    const first = register(0, true);
    await firstInserted.promise;
    let secondSettled = false;
    const second = register(1, false).finally(() => {
      secondSettled = true;
    });
    const both = Promise.allSettled([first, second]);
    await delay(75);
    const secondWaitedForOwner = !secondSettled;
    releaseFirst.resolve();

    const results = await both;
    expect(secondWaitedForOwner).toBe(true);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    await expect(
      database.adminUser.findUniqueOrThrow({ where: { id: adminUserId } })
    ).resolves.toMatchObject({ status: "ACTIVE" });
    // Both enrolments committed: the owner lock serialised them rather than
    // losing one, which is the property being asserted.
    await expect(
      database.adminAuthenticator.count({ where: { adminUserId, revokedAt: null } })
    ).resolves.toBe(2);
  });

  it("serializes concurrent revocations so two keys cannot become none", async () => {
    const session = await seedAdminWithSession("ADMIN");
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId: session.adminUserId,
        credentialId: `concurrent-revocation-${session.adminUserId}-second`,
        publicKey: randomBytes(32),
        label: "second key",
        attachment: "cross-platform",
        backupEligible: false
      }
    });
    const keys = await database.adminAuthenticator.findMany({
      where: { adminUserId: session.adminUserId, revokedAt: null },
      orderBy: { createdAt: "asc" }
    });

    const firstRevoked = deferred();
    const releaseFirst = deferred();
    const first = database.$transaction(async (transaction) => {
      await transaction.adminAuthenticator.update({
        where: { id: keys[0]!.id },
        data: { revokedAt: new Date(), revokedReason: "first concurrent request" }
      });
      firstRevoked.resolve();
      await releaseFirst.promise;
    });
    await firstRevoked.promise;

    let secondSettled = false;
    const second = database
      .$transaction(async (transaction) => {
        await transaction.adminAuthenticator.update({
          where: { id: keys[1]!.id },
          data: { revokedAt: new Date(), revokedReason: "second concurrent request" }
        });
      })
      .finally(() => {
        secondSettled = true;
      });
    const both = Promise.allSettled([first, second]);
    await delay(75);
    const secondWaitedForOwner = !secondSettled;
    releaseFirst.resolve();

    const results = await both;
    expect(secondWaitedForOwner).toBe(true);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("rejected");
    if (results[1]!.status === "rejected") {
      expect(String(results[1]!.reason)).toContain("must keep a usable security key");
    }
    // One key left, which is the privileged minimum: the second revocation
    // waited for the owner lock and was then refused against the committed
    // count rather than its own snapshot.
    await expect(
      database.adminAuthenticator.count({
        where: { adminUserId: session.adminUserId, revokedAt: null }
      })
    ).resolves.toBe(1);
  });

  it("serializes activation against revocation", async () => {
    const adminUserId = randomUUID();
    seededAdminUserIds.push(adminUserId);
    await database.adminUser.create({
      data: {
        id: adminUserId,
        userHandle: randomBytes(32),
        username: `u-${adminUserId.slice(0, 12)}`,
        displayName: "Activation race",
        role: "ADMIN",
        status: "PROVISIONING"
      }
    });
    await database.adminPassword.create({
      data: { adminUserId, digest: await hashPassword("integration-suite-password") }
    });
    // One key, which is the privileged minimum: revoking it while activation
    // is in flight is exactly the race the owner lock exists to settle.
    const authenticatorIds: string[] = [];
    for (let index = 0; index < 1; index += 1) {
      const id = randomUUID();
      authenticatorIds.push(id);
      await database.adminAuthenticator.create({
        data: {
          id,
          adminUserId,
          credentialId: `activation-race-${adminUserId}-${index}`,
          publicKey: randomBytes(32),
          label: `key ${index}`,
          attachment: "cross-platform",
          backupEligible: false
        }
      });
    }

    const activated = deferred();
    const releaseActivation = deferred();
    const first = database.$transaction(async (transaction) => {
      await transaction.adminUser.update({
        where: { id: adminUserId },
        data: { status: "ACTIVE" }
      });
      activated.resolve();
      await releaseActivation.promise;
    });
    await activated.promise;

    let revocationSettled = false;
    const second = database
      .$transaction(async (transaction) => {
        await transaction.adminAuthenticator.update({
          where: { id: authenticatorIds[0]! },
          data: { revokedAt: new Date(), revokedReason: "raced activation" }
        });
      })
      .finally(() => {
        revocationSettled = true;
      });
    const both = Promise.allSettled([first, second]);
    await delay(75);
    const revocationWaitedForOwner = !revocationSettled;
    releaseActivation.resolve();

    const results = await both;
    expect(revocationWaitedForOwner).toBe(true);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status).toBe("rejected");
    await expect(
      database.adminUser.findUniqueOrThrow({ where: { id: adminUserId } })
    ).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(
      database.adminAuthenticator.count({ where: { adminUserId, revokedAt: null } })
    ).resolves.toBe(1);
  });

  it("keeps authenticator ownership, policy and revocation history immutable", async () => {
    const owner = await seedAdminWithSession("ADMIN");
    const other = await seedAdminWithSession("ADMIN");
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId: owner.adminUserId,
        credentialId: `immutable-authenticator-${owner.adminUserId}`,
        publicKey: randomBytes(32),
        label: "replacement",
        attachment: "cross-platform",
        backupEligible: false
      }
    });
    const authenticator = await database.adminAuthenticator.findFirstOrThrow({
      where: { adminUserId: owner.adminUserId, revokedAt: null }
    });

    await expect(
      database.adminAuthenticator.update({
        where: { id: authenticator.id },
        data: { adminUserId: other.adminUserId }
      })
    ).rejects.toThrow("identity and policy are immutable");

    await expect(
      database.adminAuthenticator.update({
        where: { id: authenticator.id },
        data: { id: randomUUID() }
      })
    ).rejects.toThrow("identity and policy are immutable");

    const revokedAt = new Date();
    await database.adminAuthenticator.update({
      where: { id: authenticator.id },
      data: { revokedAt, revokedReason: "rotation" }
    });
    await expect(
      database.adminAuthenticator.update({
        where: { id: authenticator.id },
        data: { revokedAt: null, revokedReason: null }
      })
    ).rejects.toThrow("revocation is final");
  });

  it("enforces forward-only account status transitions", async () => {
    const session = await seedAdminWithSession("ADMIN");
    await expect(
      database.adminUser.update({
        where: { id: session.adminUserId },
        data: { status: "PROVISIONING" }
      })
    ).rejects.toThrow("status transition");

    await database.adminUser.update({
      where: { id: session.adminUserId },
      data: { status: "SUSPENDED" }
    });
    await expect(
      database.adminUser.update({
        where: { id: session.adminUserId },
        data: { status: "ACTIVE" }
      })
    ).resolves.toMatchObject({ status: "ACTIVE" });

    await database.adminUser.update({
      where: { id: session.adminUserId },
      data: { status: "DISABLED" }
    });
    await expect(
      database.adminUser.update({
        where: { id: session.adminUserId },
        data: { status: "SUSPENDED" }
      })
    ).rejects.toThrow("status transition");
  });

  it("keeps durable admin account identity immutable", async () => {
    const session = await seedAdminWithSession("ADMIN");
    const account = await database.adminUser.findUniqueOrThrow({
      where: { id: session.adminUserId }
    });

    await expect(
      database.adminUser.update({
        where: { id: session.adminUserId },
        data: { id: randomUUID() }
      })
    ).rejects.toThrow("admin account identity is immutable");
    await expect(
      database.adminUser.update({
        where: { id: session.adminUserId },
        data: { userHandle: randomBytes(32) }
      })
    ).rejects.toThrow("admin account identity is immutable");
    await expect(
      database.adminUser.update({
        where: { id: session.adminUserId },
        data: { createdAt: new Date(account.createdAt.getTime() + 1_000) }
      })
    ).rejects.toThrow("admin account identity is immutable");
  });

  it("makes break-glass consumption, revocation and identity final", async () => {
    const session = await seedAdminWithSession("ADMIN");
    const consumedId = randomUUID();
    const consumedAt = new Date();
    await database.adminBreakGlassCredential.create({
      data: {
        id: consumedId,
        adminUserId: session.adminUserId,
        label: "consumed",
        secretDigest: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    await database.adminBreakGlassCredential.update({
      where: { id: consumedId },
      data: { consumedAt }
    });
    await expect(
      database.adminBreakGlassCredential.update({
        where: { id: consumedId },
        data: { consumedAt }
      })
    ).rejects.toThrow("consumed break-glass credential cannot be changed");

    const revokedId = randomUUID();
    await database.adminBreakGlassCredential.create({
      data: {
        id: revokedId,
        adminUserId: session.adminUserId,
        label: "revoked",
        secretDigest: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    await database.adminBreakGlassCredential.update({
      where: { id: revokedId },
      data: { revokedAt: new Date() }
    });
    await expect(
      database.adminBreakGlassCredential.update({
        where: { id: revokedId },
        data: { revokedAt: null }
      })
    ).rejects.toThrow("revoked break-glass credential cannot be changed");

    const unusedId = randomUUID();
    const originalExpiry = new Date(Date.now() + 60_000);
    await database.adminBreakGlassCredential.create({
      data: {
        id: unusedId,
        adminUserId: session.adminUserId,
        label: "unused",
        secretDigest: randomBytes(32).toString("hex"),
        expiresAt: originalExpiry
      }
    });
    await expect(
      database.adminBreakGlassCredential.update({
        where: { id: unusedId },
        data: { expiresAt: new Date(originalExpiry.getTime() + 60_000) }
      })
    ).rejects.toThrow("cannot be re-pointed or extended");
  });
});

describe("audit integrity", () => {
  it("records a successful admin action", async () => {
    const session = await seedAdminWithSession("ADMIN");
    await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken }
    });

    const events = await database.auditEvent.findMany({
      where: { actorId: session.adminUserId, action: "admin.logout" }
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: "ADMIN_USER", outcome: "SUCCESS" });
  });

  it("cannot be rewritten or deleted by the application's own credential", async () => {
    const session = await seedAdminWithSession("ADMIN");
    await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken }
    });
    const event = await database.auditEvent.findFirst({
      where: { actorId: session.adminUserId, action: "admin.logout" }
    });
    expect(event).not.toBeNull();

    await expect(
      database.auditEvent.update({ where: { id: event!.id }, data: { outcome: "FAILURE" } })
    ).rejects.toThrow();
    await expect(database.auditEvent.delete({ where: { id: event!.id } })).rejects.toThrow();
  });

  it("cannot be truncated by the application's own credential", async () => {
    const session = await seedAdminWithSession("ADMIN");
    await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken }
    });
    const event = await database.auditEvent.findFirstOrThrow({
      where: { actorId: session.adminUserId, action: "admin.logout" }
    });

    await expect(database.$executeRawUnsafe('TRUNCATE TABLE "audit_events"')).rejects.toThrow(
      "audit_events is append-only"
    );
    await expect(
      database.auditEvent.findUnique({ where: { id: event.id } })
    ).resolves.not.toBeNull();
  });

  it("keeps document identifiers and free text out of admin audit metadata", async () => {
    const session = await seedAdminWithSession("TECHNICAL_ADMIN", { steppedUpAgo: 1_000 });
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId: session.adminUserId,
        credentialId: `test-credential-${session.adminUserId}-third`,
        publicKey: randomBytes(32),
        label: "third",
        attachment: "cross-platform",
        backupEligible: false
      }
    });
    const keys = await database.adminAuthenticator.findMany({
      where: { adminUserId: session.adminUserId, revokedAt: null }
    });
    await app.inject({
      method: "POST",
      url: `/v1/admin/authenticators/${keys[0]!.id}/revoke`,
      headers: { cookie: session.cookieHeader, "x-csrf-token": session.csrfToken },
      payload: { reason: "ROTATION" }
    });

    const event = await database.auditEvent.findFirst({
      where: { actorId: session.adminUserId, action: "admin.authenticator.revoke" }
    });
    const metadata = event?.metadata as Record<string, unknown>;
    // Only allow-listed keys survive sanitisation.
    for (const key of Object.keys(metadata)) {
      expect([
        "role",
        "capability",
        "risk",
        "reason",
        "authenticatorId",
        "authenticatorLabel",
        "targetAdminUserId",
        "sessionId",
        "ceremonyPurpose",
        "failureCode",
        "previousState",
        "resultingState",
        "stepUpFresh"
      ]).toContain(key);
    }
  });
});

describe("the admin plane never serves a document", () => {
  /**
   * Phase 2 gave the control plane operational reads, and those are bounded by
   * their own suite (`admin-observability.test.ts`). What stays true at every
   * phase, and is asserted here because it is an identity-level guarantee
   * rather than an observability one, is that no admin route returns a
   * customer's document, a rendered page, a storage URL or a print manifest —
   * at any role, however fresh their step-up.
   */
  it("exposes no route returning document bytes, a preview or a storage URL", async () => {
    const session = await seedAdminWithSession("TECHNICAL_ADMIN", { steppedUpAgo: 1_000 });
    for (const url of [
      "/v1/admin/documents",
      "/v1/admin/documents/download",
      "/v1/admin/files",
      "/v1/admin/previews",
      "/v1/admin/storage",
      "/v1/admin/kiosk-credentials"
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: session.cookieHeader }
      });
      expect(response.statusCode, url).toBe(404);
    }
  });
});

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
