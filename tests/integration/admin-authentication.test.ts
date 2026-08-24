import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

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
import { hashPassword } from "../../services/api/src/modules/admin/passwords.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

/**
 * The authentication rework's own acceptance gate.
 *
 * `admin-access.test.ts` asks whether the gate refuses what it should;
 * `admin-security.test.ts` asks it of every route at once. This asks the
 * questions that are specific to the way somebody actually signs in, and it
 * asks them through the real API against a real database:
 *
 *   Does a password alone sign an Operator in, and does it refuse to sign an
 *   Admin in without their key?
 *
 *   Does logging out leave the WebAuthn credential exactly where it was? This
 *   is the defect the whole rework began with, and it is the first test below
 *   that would have caught it.
 *
 *   Does a session survive the browser closing — that is, is the cookie
 *   persistent and the server-side row still valid afterwards?
 *
 *   Does inactivity lock rather than destroy, and does one reauthentication
 *   reopen the same session rather than issue a new one?
 *
 *   Does the absolute limit end a session that no amount of activity should
 *   have kept alive?
 *
 *   Does a step-up actually gate a sensitive action, and does an Operator's
 *   password satisfy it where an Admin's would not?
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
const peopleDatabase = environment.ADMIN_PEOPLE_DATABASE_URL
  ? createAdminPeopleClient(environment.ADMIN_PEOPLE_DATABASE_URL)
  : undefined;

const PASSWORD = "an-entirely-ordinary-password";
const seededAdminUserIds: string[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    environment,
    database,
    adminReadDatabase: readDatabase,
    adminWriteDatabase: writeDatabase,
    ...(peopleDatabase ? { adminPeopleDatabase: peopleDatabase } : {}),
    startBackgroundJobs: false
  });
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
  await database.$disconnect();
  await readDatabase.$disconnect();
  await writeDatabase.$disconnect();
  await peopleDatabase?.$disconnect();
});

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

describe("signing in", () => {
  it("signs an Operator in on a password alone, with a persistent cookie", async () => {
    const account = await seedAccount("OPERATOR");

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { username: account.username, password: PASSWORD }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "AUTHENTICATED",
      identity: { username: account.username, role: "OPERATOR", strongAuthMethod: "PASSWORD" }
    });

    // Persistent, not a session cookie: closing the browser must not sign
    // anybody out, which is half the point of the rework.
    const cookies = setCookies(response);
    const session = cookies.find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE}=`));
    expect(session).toContain("Expires=");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Strict");
  });

  it("refuses to sign an Admin in on a password alone, and hands back a key ceremony", async () => {
    const account = await seedAccount("ADMIN");

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { username: account.username, password: PASSWORD }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("WEBAUTHN_REQUIRED");
    expect(response.json().ceremonyId).toBeTruthy();
    // No session yet: the password bought a ceremony, not access.
    expect(setCookies(response)).toEqual([]);
    expect(await database.adminSession.count({ where: { adminUserId: account.adminUserId } })).toBe(
      0
    );
  });

  it("refuses a suspended account that knows its own password", async () => {
    const account = await seedAccount("OPERATOR");
    await database.adminUser.update({
      where: { id: account.adminUserId },
      data: { status: "SUSPENDED" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { username: account.username, password: PASSWORD }
    });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle rule the rework exists for
// ---------------------------------------------------------------------------

describe("credentials outlive sessions", () => {
  it("leaves every WebAuthn credential untouched when a session ends", async () => {
    // The defect this rework began with. Logging out revokes one session row
    // and nothing else — the credential is the person's, not the session's.
    const account = await seedAccount("ADMIN");
    const session = await seedLiveSession(account.adminUserId);
    const before = await database.adminAuthenticator.findMany({
      where: { adminUserId: account.adminUserId },
      orderBy: { createdAt: "asc" }
    });
    expect(before).toHaveLength(1);

    const loggedOut = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie: session.cookieHeader, [ADMIN_CSRF_HEADER]: session.csrfToken }
    });
    expect(loggedOut.statusCode).toBe(204);

    const after = await database.adminAuthenticator.findMany({
      where: { adminUserId: account.adminUserId },
      orderBy: { createdAt: "asc" }
    });
    expect(after).toEqual(before);
    expect(after[0]?.revokedAt).toBeNull();

    // And the account can still be asked for a key ceremony afterwards, which
    // is what "the credential is still usable" means in practice.
    const login = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { username: account.username, password: PASSWORD }
    });
    expect(login.json().state).toBe("WEBAUTHN_REQUIRED");
  });

  it("leaves credentials untouched when every session is revoked at once", async () => {
    const account = await seedAccount("ADMIN");
    await seedLiveSession(account.adminUserId);
    await seedLiveSession(account.adminUserId);

    await database.adminSession.updateMany({
      where: { adminUserId: account.adminUserId },
      data: { revokedAt: new Date(), revokedReason: "TEST" }
    });

    expect(
      await database.adminAuthenticator.count({
        where: { adminUserId: account.adminUserId, revokedAt: null }
      })
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Locking, unlocking, and the two expiries
// ---------------------------------------------------------------------------

describe("a session that is left alone", () => {
  it("survives a browser restart: the same cookie still works", async () => {
    // A browser restart is not an event the server can see. What it can see is
    // the same token arriving again on a new connection, which is this.
    const account = await seedAccount("OPERATOR");
    const session = await seedLiveSession(account.adminUserId);

    const first = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().state).toBe("ACTIVE");

    const afterRestart = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json().state).toBe("ACTIVE");
  });

  it("locks after its idle window, and one password reopens the very same session", async () => {
    const account = await seedAccount("OPERATOR");
    const session = await seedLiveSession(account.adminUserId, { idleExpiredAgo: 60_000 });
    const before = await database.adminSession.findUniqueOrThrow({
      where: { id: session.sessionId }
    });

    const locked = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(locked.json()).toMatchObject({ state: "LOCKED", strongAuthMethod: "PASSWORD" });

    const refused = await app.inject({
      method: "GET",
      url: "/v1/admin/health",
      headers: { cookie: session.cookieHeader }
    });
    expect(refused.json().error.code).toBe("ADMIN_SESSION_LOCKED");

    const unlocked = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/unlock/password",
      headers: { cookie: session.cookieHeader, [ADMIN_CSRF_HEADER]: session.csrfToken },
      payload: { password: PASSWORD }
    });
    expect(unlocked.statusCode).toBe(200);

    // The same row, and no new session beside it.
    const after = await database.adminSession.findUniqueOrThrow({
      where: { id: session.sessionId }
    });
    expect(after.revokedAt).toBeNull();
    expect(after.hardExpiresAt.getTime()).toBe(before.hardExpiresAt.getTime());
    expect(after.idleExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(
      await database.adminSession.count({
        where: { adminUserId: account.adminUserId, revokedAt: null }
      })
    ).toBe(1);

    // And work resumes.
    const working = await app.inject({
      method: "GET",
      url: "/v1/admin/health",
      headers: { cookie: session.cookieHeader }
    });
    expect(working.statusCode).toBe(200);
  });

  it("refuses the wrong password at the lock screen, and stays locked", async () => {
    const account = await seedAccount("OPERATOR");
    const session = await seedLiveSession(account.adminUserId, { idleExpiredAgo: 60_000 });

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/unlock/password",
      headers: { cookie: session.cookieHeader, [ADMIN_CSRF_HEADER]: session.csrfToken },
      payload: { password: "not-the-right-password" }
    });
    expect(response.statusCode).toBe(401);

    const still = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(still.json().state).toBe("LOCKED");
  });

  it("ends at its absolute limit, which nothing reopens", async () => {
    const account = await seedAccount("OPERATOR");
    const session = await seedLiveSession(account.adminUserId, { hardExpiredAgo: 60_000 });

    const me = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe("ADMIN_AUTHENTICATION_REQUIRED");

    const unlock = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/unlock/password",
      headers: { cookie: session.cookieHeader, [ADMIN_CSRF_HEADER]: session.csrfToken },
      payload: { password: PASSWORD }
    });
    expect(unlock.statusCode).toBe(401);
  });

  it("is gone the moment it is revoked, locked or not", async () => {
    const account = await seedAccount("OPERATOR");
    const session = await seedLiveSession(account.adminUserId);
    await database.adminSession.update({
      where: { id: session.sessionId },
      data: { revokedAt: new Date(), revokedReason: "TEST" }
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: session.cookieHeader }
    });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// One's own sessions
// ---------------------------------------------------------------------------

describe("managing one's own sessions", () => {
  it("lists them, marks the current one, and signs the others out", async () => {
    const account = await seedAccount("OPERATOR");
    const current = await seedLiveSession(account.adminUserId);
    await seedLiveSession(account.adminUserId);
    await seedLiveSession(account.adminUserId);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/admin/account/sessions",
      headers: { cookie: current.cookieHeader }
    });
    expect(listed.statusCode).toBe(200);
    const items = listed.json().items as { sessionId: string; current: boolean }[];
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.current)).toHaveLength(1);
    expect(items.find((item) => item.current)?.sessionId).toBe(current.sessionId);

    const revoked = await app.inject({
      method: "POST",
      url: "/v1/admin/account/sessions/revoke-others",
      headers: { cookie: current.cookieHeader, [ADMIN_CSRF_HEADER]: current.csrfToken }
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedSessions).toBe(2);

    // The session that asked survives, and is still usable.
    const survivor = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: current.cookieHeader }
    });
    expect(survivor.json().state).toBe("ACTIVE");
  });

  it("refuses to revoke a session belonging to somebody else", async () => {
    const victim = await seedAccount("OPERATOR");
    const victimSession = await seedLiveSession(victim.adminUserId);
    const attacker = await seedAccount("OPERATOR");
    const attackerSession = await seedLiveSession(attacker.adminUserId);

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/account/sessions/${victimSession.sessionId}/revoke`,
      headers: {
        cookie: attackerSession.cookieHeader,
        [ADMIN_CSRF_HEADER]: attackerSession.csrfToken
      }
    });
    expect(response.statusCode).toBe(404);
    await expect(
      database.adminSession.findUniqueOrThrow({ where: { id: victimSession.sessionId } })
    ).resolves.toMatchObject({ revokedAt: null });
  });
});

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

describe("step-up before a sensitive action", () => {
  it("lets an Operator read all day without proving anything again", async () => {
    const account = await seedAccount("OPERATOR");
    const session = await seedLiveSession(account.adminUserId, { steppedUpAgo: 24 * 3_600_000 });

    for (const url of ["/v1/admin/health", "/v1/admin/overview", "/v1/admin/print-jobs"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: session.cookieHeader }
      });
      expect(`${url} ${response.statusCode}`).toBe(`${url} 200`);
    }
  });

  it("refuses a sensitive action on a stale session and accepts it after a password step-up", async () => {
    const account = await seedAccount("OPERATOR");
    const session = await seedLiveSession(account.adminUserId, { steppedUpAgo: 24 * 3_600_000 });

    // Changing one's own password is R2, so a stale session is refused.
    const stale = await app.inject({
      method: "POST",
      url: "/v1/admin/account/password",
      headers: { cookie: session.cookieHeader, [ADMIN_CSRF_HEADER]: session.csrfToken },
      payload: { currentPassword: PASSWORD, newPassword: "a-brand-new-password" }
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe("ADMIN_STEP_UP_REQUIRED");

    // The Operator's strong factor is the password, so it satisfies step-up.
    const steppedUp = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/step-up/password",
      headers: { cookie: session.cookieHeader, [ADMIN_CSRF_HEADER]: session.csrfToken },
      payload: { password: PASSWORD }
    });
    expect(steppedUp.statusCode).toBe(200);

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/admin/account/password",
      headers: { cookie: session.cookieHeader, [ADMIN_CSRF_HEADER]: session.csrfToken },
      payload: { currentPassword: PASSWORD, newPassword: "a-brand-new-password" }
    });
    expect(accepted.statusCode).toBe(200);

    // The new password works and the old one does not.
    const withOld = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { username: account.username, password: PASSWORD }
    });
    expect(withOld.statusCode).toBe(401);
    const withNew = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { username: account.username, password: "a-brand-new-password" }
    });
    expect(withNew.statusCode).toBe(200);
  });

  it("refuses a privileged account a password step-up: only their key counts", async () => {
    // A stolen password must not reach an R2 action on an administrator
    // account. The key is the factor that stands between the two.
    const account = await seedAccount("ADMIN");
    const session = await seedLiveSession(account.adminUserId, { steppedUpAgo: 24 * 3_600_000 });

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/step-up/password",
      headers: { cookie: session.cookieHeader, [ADMIN_CSRF_HEADER]: session.csrfToken },
      payload: { password: PASSWORD }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_STEP_UP_FAILED");

    await expect(
      database.adminSession.findUniqueOrThrow({ where: { id: session.sessionId } })
    ).resolves.toMatchObject({ lastStepUpAt: expect.any(Date) });
    const row = await database.adminSession.findUniqueOrThrow({
      where: { id: session.sessionId }
    });
    // Unchanged: the refusal did not quietly refresh anything.
    expect(Date.now() - (row.lastStepUpAt?.getTime() ?? 0)).toBeGreaterThan(3_600_000);
  });

  it("refuses to change a password without the current one, however fresh the session", async () => {
    const account = await seedAccount("OPERATOR");
    const session = await seedLiveSession(account.adminUserId, { steppedUpAgo: 1_000 });

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/account/password",
      headers: { cookie: session.cookieHeader, [ADMIN_CSRF_HEADER]: session.csrfToken },
      payload: { currentPassword: "not-the-current-password", newPassword: "a-brand-new-password" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_PASSWORD_INCORRECT");
  });

  it("ends every other session when the password changes, keeping the one that changed it", async () => {
    const account = await seedAccount("OPERATOR");
    const current = await seedLiveSession(account.adminUserId, { steppedUpAgo: 1_000 });
    await seedLiveSession(account.adminUserId);

    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/account/password",
      headers: { cookie: current.cookieHeader, [ADMIN_CSRF_HEADER]: current.csrfToken },
      payload: { currentPassword: PASSWORD, newPassword: "a-brand-new-password" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revokedSessions).toBe(1);

    const survivors = await database.adminSession.findMany({
      where: { adminUserId: account.adminUserId, revokedAt: null }
    });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(current.sessionId);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SeededAccount {
  adminUserId: string;
  username: string;
}

interface SeededSession {
  sessionId: string;
  cookieHeader: string;
  csrfToken: string;
}

async function seedAccount(role: "OPERATOR" | "ADMIN" | "TECHNICAL_ADMIN"): Promise<SeededAccount> {
  const adminUserId = randomUUID();
  const username = `auth-${adminUserId.slice(0, 12)}`;
  seededAdminUserIds.push(adminUserId);

  await database.adminUser.create({
    data: {
      id: adminUserId,
      userHandle: randomBytes(32),
      username,
      displayName: `Authentication ${role}`,
      role,
      status: "PROVISIONING"
    }
  });
  await database.adminPassword.create({
    data: { adminUserId, digest: await hashPassword(PASSWORD) }
  });
  // Privileged roles need a key; an Operator is given one anyway so the
  // "logout leaves credentials alone" assertions have something to check.
  await database.adminAuthenticator.create({
    data: {
      id: randomUUID(),
      adminUserId,
      credentialId: `auth-credential-${adminUserId}`,
      publicKey: randomBytes(32),
      label: "key",
      attachment: "cross-platform",
      backupEligible: false
    }
  });
  await database.adminUser.update({
    where: { id: adminUserId },
    data: { status: "ACTIVE", activatedAt: new Date() }
  });

  return { adminUserId, username };
}

async function seedLiveSession(
  adminUserId: string,
  overrides: { idleExpiredAgo?: number; hardExpiredAgo?: number; steppedUpAgo?: number } = {}
): Promise<SeededSession> {
  const { digestAdminCsrfToken, digestAdminSessionToken } =
    await import("../../services/api/src/modules/admin/crypto.js");
  const now = Date.now();
  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");

  await database.adminSession.create({
    data: {
      id: sessionId,
      adminUserId,
      tokenDigest: digestAdminSessionToken(sessionToken, environment.ADMIN_SESSION_PEPPER),
      csrfDigest: digestAdminCsrfToken(csrfToken, environment.ADMIN_SESSION_PEPPER),
      idleExpiresAt: new Date(
        (overrides.idleExpiredAgo ?? overrides.hardExpiredAgo)
          ? now - (overrides.idleExpiredAgo ?? overrides.hardExpiredAgo ?? 0)
          : now + 600_000
      ),
      hardExpiresAt: new Date(
        overrides.hardExpiredAgo ? now - overrides.hardExpiredAgo : now + 7 * 24 * 3_600_000
      ),
      lastSeenAt: new Date(now - 120_000),
      lastStepUpAt: new Date(now - (overrides.steppedUpAgo ?? 1_000))
    }
  });

  return {
    sessionId,
    csrfToken,
    cookieHeader: `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`
  };
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers["set-cookie"];
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as string[]) : [value as string];
}

async function cleanUp(): Promise<void> {
  const ids = seededAdminUserIds.splice(0);
  if (ids.length === 0) return;
  await database.adminWebAuthnChallenge.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminKioskScope.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminUser.updateMany({
    where: { id: { in: ids }, status: { not: "DISABLED" } },
    data: { status: "SUSPENDED" }
  });
  await database.adminAuthenticator.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminPassword.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminInvitation.deleteMany({
    where: { OR: [{ adminUserId: { in: ids } }, { issuedByAdminId: { in: ids } }] }
  });
  await database.adminPasswordReset.deleteMany({
    where: { OR: [{ adminUserId: { in: ids } }, { issuedByAdminId: { in: ids } }] }
  });
  await database.adminUser.deleteMany({ where: { id: { in: ids } } });
}
