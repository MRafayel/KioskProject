import { randomBytes, randomUUID } from "node:crypto";

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
    where: { id: { in: ids } },
    data: { status: "SUSPENDED" }
  });
  await database.adminAuthenticator.deleteMany({ where: { adminUserId: { in: ids } } });
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
      displayName: `Test ${role}`,
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
        overrides.idleExpiredAgo ? now - overrides.idleExpiredAgo : now + 600_000
      ),
      hardExpiresAt: new Date(now + 3_600_000),
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
    // Login is discoverable-credential: there is no username field to probe,
    // and the options route answers identically regardless of what exists.
    const first = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/authentication/options"
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/authentication/options"
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(Object.keys(first.json())).toEqual(Object.keys(second.json()));
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

  it("refuses an idle-expired session", async () => {
    const session = await seedAdminWithSession("ADMIN", { idleExpiredAgo: 1_000 });
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(response.statusCode).toBe(401);
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
  it("refuses to retire the last spare of an active account", async () => {
    const session = await seedAdminWithSession("TECHNICAL_ADMIN", { steppedUpAgo: 1_000 });
    const authenticators = await database.adminAuthenticator.findMany({
      where: { adminUserId: session.adminUserId, revokedAt: null }
    });
    expect(authenticators).toHaveLength(2);

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

  it("refuses a synchronised passkey for a Technical Admin at the database level", async () => {
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
    ).rejects.toThrow();
  });

  it("refuses to activate an account with a single authenticator", async () => {
    const adminUserId = randomUUID();
    seededAdminUserIds.push(adminUserId);
    await database.adminUser.create({
      data: {
        id: adminUserId,
        userHandle: randomBytes(32),
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

describe("the admin plane reads nothing operational in Phase 1", () => {
  it("exposes no route returning session, document, payment or print data", async () => {
    const session = await seedAdminWithSession("TECHNICAL_ADMIN", { steppedUpAgo: 1_000 });
    for (const url of [
      "/v1/admin/sessions",
      "/v1/admin/print-jobs",
      "/v1/admin/payments",
      "/v1/admin/documents",
      "/v1/admin/kiosks"
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
