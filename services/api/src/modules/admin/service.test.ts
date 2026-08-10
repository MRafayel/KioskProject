import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@printing-kiosk/database";

import type { RandomSource } from "../sessions/crypto.js";
import { AdminService, type AuthenticatedAdmin } from "./service.js";
import { createRegistrationOptions, verifyAuthentication, verifyRegistration } from "./webauthn.js";

vi.mock("./webauthn.js", () => ({
  createAuthenticationOptions: vi.fn(),
  createRegistrationOptions: vi.fn(),
  isSignCountRegression: (previous: number, next: number) =>
    previous === 0 && next === 0 ? false : next <= previous,
  verifyAuthentication: vi.fn(),
  verifyRegistration: vi.fn()
}));

const NOW = new Date("2026-08-10T12:00:00.000Z");
const ADMIN_USER_ID = "00000000-0000-7000-8000-000000000001";
const AUTHENTICATOR_ID = "00000000-0000-7000-8000-000000000002";
const SESSION_ID = "00000000-0000-7000-8000-000000000003";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authentication compare-and-set", () => {
  it("does not issue a session when another request advanced or revoked the authenticator", async () => {
    vi.mocked(verifyAuthentication).mockResolvedValue({ newSignCount: 6 });
    const sessionCreate = vi.fn().mockResolvedValue({});
    const authenticatorUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      adminUser: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      adminAuthenticator: { updateMany: authenticatorUpdate },
      adminSession: { create: sessionCreate },
      auditEvent: { create: auditCreate }
    };
    const database = databaseWithTransaction(transaction, {
      adminWebAuthnChallenge: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ challenge: "challenge" })
      },
      adminAuthenticator: {
        findUnique: vi.fn().mockResolvedValue(storedAuthenticator())
      },
      auditEvent: { create: auditCreate }
    });

    await expect(
      service(database).completeAuthentication({
        ceremonyId: "00000000-0000-7000-8000-000000000010",
        credential: credential(),
        requestId: "request-1"
      })
    ).rejects.toMatchObject({ statusCode: 401, code: "ADMIN_AUTHENTICATION_FAILED" });

    expect(authenticatorUpdate).toHaveBeenCalledWith({
      where: {
        id: AUTHENTICATOR_ID,
        adminUserId: ADMIN_USER_ID,
        revokedAt: null,
        signCount: 5
      },
      data: { signCount: 6, lastUsedAt: NOW }
    });
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("admin.authentication");
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("CREDENTIAL_STATE_CHANGED");
  });

  it("does not refresh step-up after the session or authenticator state changes", async () => {
    vi.mocked(verifyAuthentication).mockResolvedValue({ newSignCount: 6 });
    const authenticatorUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const sessionUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      adminUser: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      adminAuthenticator: { updateMany: authenticatorUpdate },
      adminSession: { updateMany: sessionUpdate },
      auditEvent: { create: auditCreate }
    };
    const database = databaseWithTransaction(transaction, {
      adminWebAuthnChallenge: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ challenge: "challenge" })
      },
      adminAuthenticator: {
        findFirst: vi.fn().mockResolvedValue(storedAuthenticator())
      },
      auditEvent: { create: auditCreate }
    });

    await expect(
      service(database).completeStepUp({
        admin: authenticatedAdmin(),
        ceremonyId: "00000000-0000-7000-8000-000000000010",
        credential: credential(),
        requestId: "request-2"
      })
    ).rejects.toMatchObject({ statusCode: 401, code: "ADMIN_STEP_UP_FAILED" });

    expect(authenticatorUpdate).toHaveBeenCalledWith({
      where: {
        id: AUTHENTICATOR_ID,
        adminUserId: ADMIN_USER_ID,
        revokedAt: null,
        signCount: 5
      },
      data: { signCount: 6, lastUsedAt: NOW }
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: {
        id: SESSION_ID,
        adminUserId: ADMIN_USER_ID,
        revokedAt: null,
        idleExpiresAt: { gt: NOW },
        hardExpiresAt: { gt: NOW }
      },
      data: { lastStepUpAt: NOW, lastSeenAt: NOW }
    });
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("admin.step_up");
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("CREDENTIAL_STATE_CHANGED");
  });
});

describe("break-glass claim", () => {
  it("opens only one ceremony from a stale concurrent read and excludes existing credentials", async () => {
    vi.mocked(createRegistrationOptions).mockResolvedValue({
      challenge: "registration-challenge"
    } as never);
    const recoveryClaim = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const challengeCreate = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      adminUser: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      adminBreakGlassCredential: { updateMany: recoveryClaim },
      adminWebAuthnChallenge: { create: challengeCreate },
      auditEvent: { create: auditCreate }
    };
    const database = databaseWithTransaction(transaction, {
      adminBreakGlassCredential: {
        // Both calls deliberately receive the same pre-claim snapshot. The
        // conditional update, not this lookup, owns single-use enforcement.
        findUnique: vi.fn().mockResolvedValue({
          id: "00000000-0000-7000-8000-000000000020",
          consumedAt: null,
          revokedAt: null,
          expiresAt: new Date(NOW.getTime() + 60_000),
          adminUser: {
            id: ADMIN_USER_ID,
            role: "ADMIN",
            status: "ACTIVE",
            displayName: "Test Admin",
            userHandle: Buffer.alloc(32, 1),
            authenticators: [{ credentialId: "existing-credential" }]
          }
        })
      },
      auditEvent: { create: auditCreate }
    });
    const admin = service(database);

    await expect(
      admin.beginBreakGlassRegistration({ recoveryCode: "r".repeat(43), requestId: "first" })
    ).resolves.toMatchObject({ adminUserId: ADMIN_USER_ID });
    await expect(
      admin.beginBreakGlassRegistration({ recoveryCode: "r".repeat(43), requestId: "second" })
    ).rejects.toMatchObject({ statusCode: 401, code: "ADMIN_RECOVERY_FAILED" });

    expect(challengeCreate).toHaveBeenCalledOnce();
    expect(createRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ existingCredentialIds: ["existing-credential"] })
    );
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("admin.break_glass");
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("anonymous");
  });

  it("does not consume a recovery code when suspension wins the account lock", async () => {
    vi.mocked(createRegistrationOptions).mockResolvedValue({
      challenge: "registration-challenge"
    } as never);
    const recoveryClaim = vi.fn();
    const challengeCreate = vi.fn();
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      adminUser: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      adminBreakGlassCredential: { updateMany: recoveryClaim },
      adminWebAuthnChallenge: { create: challengeCreate },
      auditEvent: { create: auditCreate }
    };
    const database = databaseWithTransaction(transaction, {
      adminBreakGlassCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "00000000-0000-7000-8000-000000000020",
          consumedAt: null,
          revokedAt: null,
          expiresAt: new Date(NOW.getTime() + 60_000),
          adminUser: {
            id: ADMIN_USER_ID,
            role: "ADMIN",
            status: "ACTIVE",
            displayName: "Test Admin",
            userHandle: Buffer.alloc(32, 1),
            authenticators: []
          }
        })
      },
      auditEvent: { create: auditCreate }
    });

    await expect(
      service(database).beginBreakGlassRegistration({
        recoveryCode: "r".repeat(43),
        requestId: "request-recovery-suspended"
      })
    ).rejects.toMatchObject({ statusCode: 401, code: "ADMIN_RECOVERY_FAILED" });

    expect(recoveryClaim).not.toHaveBeenCalled();
    expect(challengeCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("RECOVERY_CODE_INVALID");
  });
});

describe("registration activation serialization", () => {
  it("locks the owner before inserting and counting credentials", async () => {
    vi.mocked(verifyRegistration).mockResolvedValue({
      credentialId: "new-credential",
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0,
      transports: [],
      attachment: "cross-platform",
      backupEligible: false,
      backedUp: false,
      aaguid: null
    });
    const ownerLock = vi.fn().mockResolvedValue({ count: 1 });
    const ownerActivate = vi.fn().mockResolvedValue({});
    const authenticatorCreate = vi.fn().mockResolvedValue({});
    const credentialCount = vi.fn().mockResolvedValue(2);
    const transaction = {
      adminUser: {
        updateMany: ownerLock,
        findUnique: vi.fn().mockResolvedValue({ role: "ADMIN", status: "PROVISIONING" }),
        update: ownerActivate
      },
      adminAuthenticator: { create: authenticatorCreate, count: credentialCount },
      auditEvent: { create: vi.fn().mockResolvedValue({}) }
    };
    const database = databaseWithTransaction(transaction, {
      adminWebAuthnChallenge: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ challenge: "challenge" })
      },
      adminUser: {
        findUnique: vi.fn().mockResolvedValue({ role: "ADMIN", status: "PROVISIONING" })
      }
    });

    const result = await service(database).completeRegistration({
      targetAdminUserId: ADMIN_USER_ID,
      actorAdminUserId: ADMIN_USER_ID,
      ceremonyId: "00000000-0000-7000-8000-000000000010",
      credential: credential(),
      label: "spare",
      requestId: "request-3",
      purpose: "BREAK_GLASS_REGISTRATION"
    });

    expect(result.activated).toBe(true);
    const lockOrder = ownerLock.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(authenticatorCreate.mock.invocationCallOrder[0]!);
    expect(lockOrder).toBeLessThan(credentialCount.mock.invocationCallOrder[0]!);
  });

  it("does not enrol after the self-management session was revoked", async () => {
    vi.mocked(verifyRegistration).mockResolvedValue({
      credentialId: "new-credential",
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0,
      transports: [],
      attachment: "cross-platform",
      backupEligible: false,
      backedUp: false,
      aaguid: null
    });
    const authenticatorCreate = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      adminUser: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      adminSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      adminAuthenticator: { create: authenticatorCreate },
      auditEvent: { create: auditCreate }
    };
    const database = databaseWithTransaction(transaction, {
      adminWebAuthnChallenge: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ challenge: "challenge" })
      },
      adminUser: {
        findUnique: vi.fn().mockResolvedValue({ role: "ADMIN", status: "ACTIVE" })
      },
      auditEvent: { create: auditCreate }
    });

    await expect(
      service(database).completeRegistration({
        targetAdminUserId: ADMIN_USER_ID,
        actorAdminUserId: ADMIN_USER_ID,
        actorSessionId: SESSION_ID,
        ceremonyId: "00000000-0000-7000-8000-000000000010",
        credential: credential(),
        label: "replacement",
        requestId: "request-session-race"
      })
    ).rejects.toMatchObject({ statusCode: 401, code: "ADMIN_AUTHENTICATION_REQUIRED" });

    expect(authenticatorCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("ACCOUNT_OR_SESSION_STATE_CHANGED");
  });

  it("does not let break-glass enrol after the account was suspended", async () => {
    vi.mocked(verifyRegistration).mockResolvedValue({
      credentialId: "new-credential",
      publicKey: new Uint8Array([1, 2, 3]),
      signCount: 0,
      transports: [],
      attachment: "cross-platform",
      backupEligible: false,
      backedUp: false,
      aaguid: null
    });
    const authenticatorCreate = vi.fn().mockResolvedValue({});
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      // The account was ACTIVE at the pre-verification read, but suspension
      // won the owner-row race before this transaction could lock it.
      adminUser: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      adminAuthenticator: { create: authenticatorCreate },
      auditEvent: { create: auditCreate }
    };
    const database = databaseWithTransaction(transaction, {
      adminWebAuthnChallenge: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ challenge: "challenge" })
      },
      adminUser: {
        findUnique: vi.fn().mockResolvedValue({ role: "ADMIN", status: "ACTIVE" })
      },
      auditEvent: { create: auditCreate }
    });

    await expect(
      service(database).completeRegistration({
        targetAdminUserId: ADMIN_USER_ID,
        actorAdminUserId: ADMIN_USER_ID,
        ceremonyId: "00000000-0000-7000-8000-000000000010",
        credential: credential(),
        label: "replacement",
        requestId: "request-recovery-race",
        purpose: "BREAK_GLASS_REGISTRATION"
      })
    ).rejects.toMatchObject({ statusCode: 401, code: "ADMIN_RECOVERY_FAILED" });

    expect(authenticatorCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("ACCOUNT_OR_SESSION_STATE_CHANGED");
  });
});

describe("idempotent revocation", () => {
  it("does not rewrite or re-audit an authenticator a concurrent request already revoked", async () => {
    const authenticatorUpdate = vi.fn().mockResolvedValue({ count: 0 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      adminUser: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          role: "ADMIN",
          status: "ACTIVE",
          authenticators: [
            { id: AUTHENTICATOR_ID },
            { id: "00000000-0000-7000-8000-000000000004" },
            { id: "00000000-0000-7000-8000-000000000005" }
          ]
        })
      },
      adminSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      adminAuthenticator: { updateMany: authenticatorUpdate },
      auditEvent: { create: auditCreate }
    };

    await expect(
      service(databaseWithTransaction(transaction, {})).revokeAuthenticator({
        admin: authenticatedAdmin(),
        targetAdminUserId: ADMIN_USER_ID,
        authenticatorId: AUTHENTICATOR_ID,
        reason: "ROTATION",
        requestId: "request-4"
      })
    ).rejects.toMatchObject({ statusCode: 404, code: "ADMIN_AUTHENTICATOR_NOT_FOUND" });

    expect(authenticatorUpdate).toHaveBeenCalledWith({
      where: {
        id: AUTHENTICATOR_ID,
        adminUserId: ADMIN_USER_ID,
        revokedAt: null
      },
      data: { revokedAt: NOW, revokedReason: "ROTATION" }
    });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("does not revoke a key after the self-management session was revoked", async () => {
    const userRead = vi.fn();
    const authenticatorUpdate = vi.fn();
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      adminUser: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: userRead
      },
      adminSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      adminAuthenticator: { updateMany: authenticatorUpdate },
      auditEvent: { create: auditCreate }
    };

    await expect(
      service(
        databaseWithTransaction(transaction, { auditEvent: { create: auditCreate } })
      ).revokeAuthenticator({
        admin: authenticatedAdmin(),
        targetAdminUserId: ADMIN_USER_ID,
        authenticatorId: AUTHENTICATOR_ID,
        reason: "ROTATION",
        requestId: "request-revoke-race"
      })
    ).rejects.toMatchObject({ statusCode: 401, code: "ADMIN_AUTHENTICATION_REQUIRED" });

    expect(userRead).not.toHaveBeenCalled();
    expect(authenticatorUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(auditCreate.mock.calls)).toContain("ACCOUNT_OR_SESSION_STATE_CHANGED");
  });

  it("keeps duplicate logout idempotent without a second success audit", async () => {
    const auditCreate = vi.fn().mockResolvedValue({});
    const transaction = {
      adminSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      auditEvent: { create: auditCreate }
    };

    await expect(
      service(databaseWithTransaction(transaction, {})).revokeSession({
        admin: authenticatedAdmin(),
        reason: "USER_LOGOUT",
        requestId: "request-5"
      })
    ).resolves.toBeUndefined();
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe("CSRF session liveness", () => {
  it("does not accept a token from a revoked or newly expired session", async () => {
    const findLiveSession = vi.fn().mockResolvedValue(null);
    const database = {
      adminSession: { findFirst: findLiveSession }
    } as unknown as PrismaClient;

    await expect(service(database).verifyCsrf(SESSION_ID, "csrf-token")).resolves.toBe(false);
    expect(findLiveSession).toHaveBeenCalledWith({
      where: {
        id: SESSION_ID,
        revokedAt: null,
        idleExpiresAt: { gt: NOW },
        hardExpiresAt: { gt: NOW }
      },
      select: { csrfDigest: true }
    });
  });
});

function service(database: PrismaClient): AdminService {
  let uuidCounter = 0;
  const random: RandomSource = {
    uuid: () => `00000000-0000-7000-8000-${String(++uuidCounter).padStart(12, "0")}`,
    token: () => "t".repeat(43),
    integer: () => 0
  };
  return new AdminService({
    database,
    clock: { now: () => NOW },
    random,
    relyingParty: { id: "admin.example.test", name: "Admin", origin: "https://admin.example.test" },
    sessionPepper: "session-pepper-at-least-thirty-two-characters",
    breakGlassPepper: "recovery-pepper-at-least-thirty-two-characters",
    idleTtlMilliseconds: 15 * 60_000,
    absoluteTtlMilliseconds: 4 * 60 * 60_000,
    challengeTtlMilliseconds: 3 * 60_000
  });
}

function databaseWithTransaction(
  transaction: object,
  delegates: Record<string, unknown>
): PrismaClient {
  return {
    ...delegates,
    $transaction: vi.fn(async (operation: (client: object) => Promise<unknown>) =>
      operation(transaction)
    )
  } as unknown as PrismaClient;
}

function storedAuthenticator() {
  return {
    id: AUTHENTICATOR_ID,
    adminUserId: ADMIN_USER_ID,
    credentialId: "credential-id",
    publicKey: Buffer.from([1, 2, 3]),
    signCount: 5,
    transports: [],
    revokedAt: null,
    adminUser: { status: "ACTIVE", role: "ADMIN", displayName: "Test Admin" }
  };
}

function credential() {
  return {
    id: "credential-id",
    rawId: "credential-id",
    type: "public-key" as const,
    response: {}
  };
}

function authenticatedAdmin(): AuthenticatedAdmin {
  return {
    adminUserId: ADMIN_USER_ID,
    displayName: "Test Admin",
    role: "ADMIN",
    sessionId: SESSION_ID,
    idleExpiresAt: new Date(NOW.getTime() + 15 * 60_000),
    hardExpiresAt: new Date(NOW.getTime() + 4 * 60 * 60_000),
    lastStepUpAt: NOW,
    kioskScopes: []
  };
}
