import {
  canAuthenticate,
  canRevokeAuthenticator,
  evaluateActivation,
  evaluateSession,
  isAdminRole,
  isAdminUserStatus,
  mayInviteRole,
  mayResetPassword,
  minimumAuthenticators,
  nextIdleExpiry,
  requiresWebAuthn,
  strongAuthMethodForRole,
  type AdminRole,
  type AdminUserStatus,
  type StrongAuthMethod,
  type WebAuthnCredential
} from "@printing-kiosk/admin-access";
import type { PrismaClient } from "@printing-kiosk/database";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { writeAdminAuditEvent, ANONYMOUS_ADMIN_ACTOR_ID } from "./audit.js";
import {
  digestAdminCsrfToken,
  digestAdminSessionToken,
  digestBreakGlassSecret,
  digestInvitationSecret,
  digestPasswordResetSecret,
  digestsMatch
} from "./crypto.js";
import { burnEquivalentWork, hashPassword, verifyPassword } from "./passwords.js";
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  isSignCountRegression,
  verifyAuthentication,
  verifyRegistration,
  type WebAuthnRelyingParty
} from "./webauthn.js";

/**
 * The admin identity service.
 *
 * Everything a person can do to their own account lives here: proving who they
 * are (a password for everybody, a security key on top for privileged roles),
 * proving it again before a sensitive action, reopening a locked session,
 * managing their own sessions and password, enrolling and retiring
 * authenticators, and the sealed way back in when everything is gone. The two
 * ways an account comes to exist or recovers — invitations and
 * administrator-assisted password resets — live here too, because they are
 * identity operations whatever screen they are driven from.
 *
 * Three rules run through all of it. A failure never says why in a way that
 * distinguishes "no such account" from "wrong password" or "wrong key",
 * because that difference is an enumeration oracle. Every outcome is audited,
 * including the refusals. And nothing here reads or returns anything about a
 * customer — this module touches no session, document, payment or print row at
 * all.
 *
 * One rule about lifecycles, because losing it was the original sin of the
 * first design: **credentials belong to the person, sessions belong to the
 * browser, and nothing that happens to a session touches a credential.**
 * Logout, expiry and revocation end sessions; a WebAuthn credential is removed
 * only by an explicit revocation or recovery act.
 */

const SESSION_TOKEN_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;
const USER_HANDLE_BYTES = 32;
const ONE_TIME_CODE_BYTES = 32;
const USER_AGENT_LIMIT = 280;
const IP_ADDRESS_LIMIT = 64;

export interface AdminSessionCookiePair {
  sessionToken: string;
  csrfToken: string;
  idleExpiresAt: Date;
  hardExpiresAt: Date;
}

/** Per-role session windows, from configuration rather than constants. */
export interface AdminSessionWindows {
  idleTtlMilliseconds: Readonly<Record<AdminRole, number>>;
  absoluteTtlMilliseconds: Readonly<Record<AdminRole, number>>;
}

export interface AdminServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  relyingParty: WebAuthnRelyingParty;
  sessionPepper: string;
  breakGlassPepper: string;
  sessionWindows: AdminSessionWindows;
  challengeTtlMilliseconds: number;
  invitationTtlMilliseconds: number;
  passwordResetTtlMilliseconds: number;
}

/** Where a request came from. Recorded on the session for its owner to read;
 * never treated as proof of anything. */
export interface AdminClientContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuthenticatedAdmin {
  adminUserId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  sessionId: string;
  idleExpiresAt: Date;
  hardExpiresAt: Date;
  lastStepUpAt: Date | null;
  kioskScopes: readonly string[];
}

/**
 * A session past its idle window but not its absolute one. It can do exactly
 * two things: reauthenticate back to ACTIVE, or log out. Enough identity is
 * carried to drive both and to draw a lock screen, and nothing more.
 */
export interface LockedAdmin {
  adminUserId: string;
  displayName: string;
  role: AdminRole;
  sessionId: string;
  hardExpiresAt: Date;
}

export type AdminSessionResolution =
  { state: "ACTIVE"; admin: AuthenticatedAdmin } | { state: "LOCKED"; locked: LockedAdmin } | null;

export type PasswordLoginResult =
  | { state: "AUTHENTICATED"; admin: AuthenticatedAdmin; cookies: AdminSessionCookiePair }
  | { state: "WEBAUTHN_REQUIRED"; ceremonyId: string; options: unknown };

export interface OwnSessionView {
  sessionId: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  state: "ACTIVE" | "LOCKED";
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface InvitationView {
  invitationId: string;
  adminUserId: string;
  username: string;
  displayName: string;
  role: AdminRole;
  issuedByDisplayName: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
}

export interface InvitationProgress {
  activated: boolean;
  passwordSet: boolean;
  webAuthnRequired: boolean;
  usableAuthenticators: number;
}

/** Internal sentinel used to roll back a transaction before returning a generic auth failure. */
class AdminCredentialStateChangedError extends Error {}

class AdminAuthenticatorRevocationError extends Error {
  public constructor(
    public readonly reason:
      "USER_NOT_FOUND" | "KEY_NOT_FOUND" | "LAST_SPARE" | "AUTHORIZATION_CHANGED"
  ) {
    super(reason);
  }
}

export class AdminService {
  public constructor(private readonly options: AdminServiceOptions) {}

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  /**
   * The first — and for Operators the only — phase of a login.
   *
   * The password is verified for every request that names an existing account,
   * and equivalent work is burned for one that does not, so the response time
   * distinguishes nothing. What a correct password earns depends on the role:
   * an Operator gets a session; a privileged role gets a WebAuthn ceremony
   * bound to the account the password just proved.
   */
  public async loginWithPassword(input: {
    username: string;
    password: string;
    requestId: string;
    client: AdminClientContext;
  }): Promise<PasswordLoginResult> {
    const now = this.options.clock.now();
    const user = await this.options.database.adminUser.findUnique({
      where: { username: input.username },
      include: {
        password: true,
        authenticators: { where: { revokedAt: null }, select: { credentialId: true } }
      }
    });

    if (!user || !user.password) {
      await burnEquivalentWork(input.password);
      await this.auditAnonymousFailure(
        "admin.login.password",
        input.requestId,
        now,
        "CREDENTIALS_INVALID"
      );
      throw authenticationFailed();
    }

    const role = asRole(user.role);
    const verified = await verifyPassword(input.password, user.password.digest);
    if (!verified) {
      await this.auditFailure(user.id, "admin.login.password", input.requestId, now, {
        role,
        failureCode: "CREDENTIALS_INVALID"
      });
      throw authenticationFailed();
    }

    if (!canAuthenticate(asStatus(user.status))) {
      await this.auditFailure(user.id, "admin.login.password", input.requestId, now, {
        role,
        failureCode: "ACCOUNT_" + user.status
      });
      throw authenticationFailed();
    }

    if (!requiresWebAuthn(role)) {
      return {
        state: "AUTHENTICATED",
        ...(await this.issueSession({
          adminUserId: user.id,
          username: user.username,
          displayName: user.displayName,
          role,
          method: "PASSWORD",
          now,
          requestId: input.requestId,
          client: input.client
        }))
      };
    }

    // The ceremony exists only because the password verified, which is what
    // binds the assertion that follows to the knowledge factor. Recorded as
    // its own event: a stolen password with no key to follow it shows up in
    // the log as exactly this and nothing more.
    const options = await createAuthenticationOptions({
      relyingParty: this.options.relyingParty,
      allowCredentialIds: user.authenticators.map((entry) => entry.credentialId)
    });
    const ceremonyId = await this.storeChallenge("AUTHENTICATION", options.challenge, user.id);
    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: user.id,
      action: "admin.login.password",
      outcome: "SUCCESS",
      requestId: input.requestId,
      metadata: { role, method: "PASSWORD", resultingState: "WEBAUTHN_PENDING" }
    });

    return { state: "WEBAUTHN_REQUIRED", ceremonyId, options };
  }

  /**
   * The second phase of a privileged login: the assertion that follows the
   * password. The ceremony row names the account the password proved, and the
   * asserted credential must belong to that same account.
   */
  public async completeLoginWebAuthn(input: {
    ceremonyId: string;
    credential: WebAuthnCredential;
    requestId: string;
    client: AdminClientContext;
  }): Promise<{ admin: AuthenticatedAdmin; cookies: AdminSessionCookiePair }> {
    const now = this.options.clock.now();
    const challenge = await this.consumeChallenge(input.ceremonyId, "AUTHENTICATION", now);
    if (!challenge.adminUserId) throw ceremonyExpired();

    const stored = await this.options.database.adminAuthenticator.findFirst({
      where: {
        credentialId: input.credential.id,
        adminUserId: challenge.adminUserId,
        revokedAt: null
      },
      include: { adminUser: true }
    });

    if (!stored) {
      await this.auditFailure(challenge.adminUserId, "admin.authentication", input.requestId, now, {
        failureCode: "UNKNOWN_CREDENTIAL"
      });
      throw authenticationFailed();
    }

    const status = asStatus(stored.adminUser.status);
    const role = asRole(stored.adminUser.role);
    if (!canAuthenticate(status)) {
      await this.auditFailure(stored.adminUserId, "admin.authentication", input.requestId, now, {
        role,
        failureCode: "ACCOUNT_" + status
      });
      throw authenticationFailed();
    }

    const verified = await verifyAuthentication({
      relyingParty: this.options.relyingParty,
      expectedChallenge: challenge.challenge,
      credential: input.credential,
      storedCredential: {
        id: stored.credentialId,
        publicKey: stored.publicKey,
        signCount: stored.signCount,
        transports: stored.transports
      }
    }).catch(() => null);

    if (!verified) {
      await this.auditFailure(stored.adminUserId, "admin.authentication", input.requestId, now, {
        role,
        failureCode: "ASSERTION_INVALID"
      });
      throw authenticationFailed();
    }

    // A counter that did not advance means this credential may have been
    // cloned. Refusing is the only safe answer, and it is worth an audit entry
    // an operator will actually look at.
    if (isSignCountRegression(stored.signCount, verified.newSignCount)) {
      await this.auditFailure(stored.adminUserId, "admin.authentication", input.requestId, now, {
        role,
        failureCode: "SIGN_COUNT_REGRESSION",
        authenticatorId: stored.id
      });
      throw authenticationFailed();
    }

    return this.issueSession({
      adminUserId: stored.adminUserId,
      username: stored.adminUser.username,
      displayName: stored.adminUser.displayName,
      role,
      method: "WEBAUTHN",
      authenticator: {
        id: stored.id,
        expectedSignCount: stored.signCount,
        newSignCount: verified.newSignCount
      },
      now,
      requestId: input.requestId,
      client: input.client
    });
  }

  // -------------------------------------------------------------------------
  // Step-up
  // -------------------------------------------------------------------------

  /**
   * Begin a step-up. Unlike login this names the account's own credentials:
   * the person is already identified, and asking for one of their keys
   * specifically gives a clearer prompt.
   */
  public async beginStepUp(adminUserId: string): Promise<{ ceremonyId: string; options: unknown }> {
    const authenticators = await this.options.database.adminAuthenticator.findMany({
      where: { adminUserId, revokedAt: null },
      select: { credentialId: true }
    });
    const options = await createAuthenticationOptions({
      relyingParty: this.options.relyingParty,
      allowCredentialIds: authenticators.map((entry) => entry.credentialId)
    });
    const ceremonyId = await this.storeChallenge("STEP_UP", options.challenge, adminUserId);
    return { ceremonyId, options };
  }

  /**
   * Finish a step-up, marking the session fresh for sensitive actions.
   *
   * The asserted credential must belong to the session's own account. Without
   * that check, anyone's key would refresh anyone's session.
   */
  public async completeStepUp(input: {
    admin: AuthenticatedAdmin;
    ceremonyId: string;
    credential: WebAuthnCredential;
    requestId: string;
  }): Promise<Date> {
    const now = this.options.clock.now();
    const challenge = await this.consumeChallenge(
      input.ceremonyId,
      "STEP_UP",
      now,
      input.admin.adminUserId
    );

    const stored = await this.options.database.adminAuthenticator.findFirst({
      where: {
        credentialId: input.credential.id,
        adminUserId: input.admin.adminUserId,
        revokedAt: null
      }
    });
    if (!stored) {
      await this.auditFailure(input.admin.adminUserId, "admin.step_up", input.requestId, now, {
        role: input.admin.role,
        failureCode: "CREDENTIAL_NOT_OWNED"
      });
      throw stepUpFailed();
    }

    const verified = await verifyAuthentication({
      relyingParty: this.options.relyingParty,
      expectedChallenge: challenge.challenge,
      credential: input.credential,
      storedCredential: {
        id: stored.credentialId,
        publicKey: stored.publicKey,
        signCount: stored.signCount,
        transports: stored.transports
      }
    }).catch(() => null);

    if (!verified || isSignCountRegression(stored.signCount, verified.newSignCount)) {
      await this.auditFailure(input.admin.adminUserId, "admin.step_up", input.requestId, now, {
        role: input.admin.role,
        failureCode: verified ? "SIGN_COUNT_REGRESSION" : "ASSERTION_INVALID"
      });
      throw stepUpFailed();
    }

    try {
      await this.options.database.$transaction(async (transaction) => {
        // Keep the same owner -> authenticator lock order as login, enrolment
        // and revocation. Database authenticator triggers also lock the owner,
        // so reversing this order here could otherwise deadlock with them.
        const activeUser = await transaction.adminUser.updateMany({
          where: {
            id: input.admin.adminUserId,
            role: input.admin.role,
            status: "ACTIVE"
          },
          data: { updatedAt: now }
        });
        if (activeUser.count !== 1) throw new AdminCredentialStateChangedError();

        const authenticator = await transaction.adminAuthenticator.updateMany({
          where: {
            id: stored.id,
            adminUserId: input.admin.adminUserId,
            revokedAt: null,
            signCount: stored.signCount
          },
          data: { signCount: verified.newSignCount, lastUsedAt: now }
        });
        if (authenticator.count !== 1) throw new AdminCredentialStateChangedError();

        const session = await transaction.adminSession.updateMany({
          where: {
            id: input.admin.sessionId,
            adminUserId: input.admin.adminUserId,
            revokedAt: null,
            idleExpiresAt: { gt: now },
            hardExpiresAt: { gt: now }
          },
          data: { lastStepUpAt: now, lastSeenAt: now }
        });
        if (session.count !== 1) throw new AdminCredentialStateChangedError();

        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: input.admin.adminUserId,
          action: "admin.step_up",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: { role: input.admin.role, method: "WEBAUTHN", authenticatorId: stored.id }
        });
      });
    } catch (error) {
      if (!(error instanceof AdminCredentialStateChangedError)) throw error;
      await this.auditFailure(input.admin.adminUserId, "admin.step_up", input.requestId, now, {
        role: input.admin.role,
        authenticatorId: stored.id,
        failureCode: "CREDENTIAL_STATE_CHANGED"
      });
      throw stepUpFailed();
    }

    return now;
  }

  /**
   * Step up with the password, for roles whose strong factor it is.
   *
   * A role that carries WebAuthn may not step up with a password: for those
   * accounts the password is the weaker factor, and R2 exists precisely for
   * the actions a stolen weaker factor must not reach.
   */
  public async stepUpWithPassword(input: {
    admin: AuthenticatedAdmin;
    password: string;
    requestId: string;
  }): Promise<Date> {
    const now = this.options.clock.now();
    if (strongAuthMethodForRole(input.admin.role) !== "PASSWORD") {
      await this.auditFailure(input.admin.adminUserId, "admin.step_up", input.requestId, now, {
        role: input.admin.role,
        failureCode: "METHOD_NOT_ALLOWED"
      });
      throw stepUpFailed();
    }

    if (!(await this.verifyAccountPassword(input.admin.adminUserId, input.password))) {
      await this.auditFailure(input.admin.adminUserId, "admin.step_up", input.requestId, now, {
        role: input.admin.role,
        failureCode: "CREDENTIALS_INVALID"
      });
      throw stepUpFailed();
    }

    try {
      await this.options.database.$transaction(async (transaction) => {
        const activeUser = await transaction.adminUser.updateMany({
          where: { id: input.admin.adminUserId, role: input.admin.role, status: "ACTIVE" },
          data: { updatedAt: now }
        });
        if (activeUser.count !== 1) throw new AdminCredentialStateChangedError();

        const session = await transaction.adminSession.updateMany({
          where: {
            id: input.admin.sessionId,
            adminUserId: input.admin.adminUserId,
            revokedAt: null,
            idleExpiresAt: { gt: now },
            hardExpiresAt: { gt: now }
          },
          data: { lastStepUpAt: now, lastSeenAt: now }
        });
        if (session.count !== 1) throw new AdminCredentialStateChangedError();

        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: input.admin.adminUserId,
          action: "admin.step_up",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: { role: input.admin.role, method: "PASSWORD" }
        });
      });
    } catch (error) {
      if (!(error instanceof AdminCredentialStateChangedError)) throw error;
      await this.auditFailure(input.admin.adminUserId, "admin.step_up", input.requestId, now, {
        role: input.admin.role,
        failureCode: "CREDENTIAL_STATE_CHANGED"
      });
      throw stepUpFailed();
    }

    return now;
  }

  // -------------------------------------------------------------------------
  // Unlock
  // -------------------------------------------------------------------------

  /** Begin a WebAuthn unlock of a locked session. */
  public async beginUnlock(locked: LockedAdmin): Promise<{ ceremonyId: string; options: unknown }> {
    const authenticators = await this.options.database.adminAuthenticator.findMany({
      where: { adminUserId: locked.adminUserId, revokedAt: null },
      select: { credentialId: true }
    });
    const options = await createAuthenticationOptions({
      relyingParty: this.options.relyingParty,
      allowCredentialIds: authenticators.map((entry) => entry.credentialId)
    });
    const ceremonyId = await this.storeChallenge("UNLOCK", options.challenge, locked.adminUserId);
    return { ceremonyId, options };
  }

  /**
   * Reopen a locked session with a key. The assertion is a strong
   * reauthentication, so it refreshes step-up as well — walking back to an
   * expired lock screen and touching the key once covers both.
   */
  public async completeUnlock(input: {
    locked: LockedAdmin;
    ceremonyId: string;
    credential: WebAuthnCredential;
    requestId: string;
  }): Promise<AuthenticatedAdmin> {
    const now = this.options.clock.now();
    const challenge = await this.consumeChallenge(
      input.ceremonyId,
      "UNLOCK",
      now,
      input.locked.adminUserId
    );

    const stored = await this.options.database.adminAuthenticator.findFirst({
      where: {
        credentialId: input.credential.id,
        adminUserId: input.locked.adminUserId,
        revokedAt: null
      }
    });
    if (!stored) {
      await this.auditFailure(
        input.locked.adminUserId,
        "admin.session.unlock",
        input.requestId,
        now,
        { role: input.locked.role, failureCode: "CREDENTIAL_NOT_OWNED" }
      );
      throw unlockFailed();
    }

    const verified = await verifyAuthentication({
      relyingParty: this.options.relyingParty,
      expectedChallenge: challenge.challenge,
      credential: input.credential,
      storedCredential: {
        id: stored.credentialId,
        publicKey: stored.publicKey,
        signCount: stored.signCount,
        transports: stored.transports
      }
    }).catch(() => null);

    if (!verified || isSignCountRegression(stored.signCount, verified.newSignCount)) {
      await this.auditFailure(
        input.locked.adminUserId,
        "admin.session.unlock",
        input.requestId,
        now,
        {
          role: input.locked.role,
          failureCode: verified ? "SIGN_COUNT_REGRESSION" : "ASSERTION_INVALID"
        }
      );
      throw unlockFailed();
    }

    return this.reopenSession({
      locked: input.locked,
      method: "WEBAUTHN",
      authenticator: {
        id: stored.id,
        expectedSignCount: stored.signCount,
        newSignCount: verified.newSignCount
      },
      now,
      requestId: input.requestId
    });
  }

  /**
   * Reopen a locked session with the password.
   *
   * Available to every role — the lock exists to keep a walked-up stranger out
   * of an unattended browser, and the password answers that. It refreshes
   * step-up only for roles whose strong factor the password is: a privileged
   * unlock-by-password reopens the dashboard but does not authorise R2.
   */
  public async unlockWithPassword(input: {
    locked: LockedAdmin;
    password: string;
    requestId: string;
  }): Promise<AuthenticatedAdmin> {
    const now = this.options.clock.now();
    if (!(await this.verifyAccountPassword(input.locked.adminUserId, input.password))) {
      await this.auditFailure(
        input.locked.adminUserId,
        "admin.session.unlock",
        input.requestId,
        now,
        { role: input.locked.role, failureCode: "CREDENTIALS_INVALID" }
      );
      throw unlockFailed();
    }

    return this.reopenSession({
      locked: input.locked,
      method: "PASSWORD",
      now,
      requestId: input.requestId
    });
  }

  // -------------------------------------------------------------------------
  // Enrolment
  // -------------------------------------------------------------------------

  /**
   * Begin enrolling an authenticator onto an account.
   *
   * `targetAdminUserId` is the account being enrolled onto — always the
   * session's own account here; invitation and break-glass enrolments begin
   * through their own code-authorised paths.
   */
  public async beginRegistration(
    targetAdminUserId: string
  ): Promise<{ ceremonyId: string; options: unknown }> {
    const user = await this.options.database.adminUser.findUnique({
      where: { id: targetAdminUserId },
      include: { authenticators: { where: { revokedAt: null }, select: { credentialId: true } } }
    });
    if (!user) throw new ApiError(404, "ADMIN_USER_NOT_FOUND", "Account not found.");

    const options = await createRegistrationOptions({
      relyingParty: this.options.relyingParty,
      userHandle: new Uint8Array(user.userHandle),
      displayName: user.displayName,
      existingCredentialIds: user.authenticators.map((entry) => entry.credentialId)
    });

    const ceremonyId = await this.storeChallenge(
      "REGISTRATION",
      options.challenge,
      targetAdminUserId
    );
    return { ceremonyId, options };
  }

  /**
   * Finish enrolling an authenticator.
   *
   * An account still PROVISIONING is activated here once it holds everything
   * its role signs in with — a password, and for privileged roles this key.
   * For an invitation enrolment, activation also consumes the invitation, in
   * the same transaction, so the code and the account state can never disagree.
   */
  public async completeRegistration(
    input: {
      targetAdminUserId: string;
      actorAdminUserId: string;
      ceremonyId: string;
      credential: WebAuthnCredential;
      label: string;
      requestId: string;
    } & (
      | { purpose?: "REGISTRATION"; actorSessionId: string }
      | { purpose: "BREAK_GLASS_REGISTRATION"; actorSessionId?: never }
      | { purpose: "INVITATION_REGISTRATION"; actorSessionId?: never }
    )
  ): Promise<{ authenticatorId: string; activated: boolean }> {
    const now = this.options.clock.now();
    const purpose = input.purpose ?? "REGISTRATION";
    const isBreakGlass = purpose === "BREAK_GLASS_REGISTRATION";
    const isInvitation = purpose === "INVITATION_REGISTRATION";
    // The two ceremonies that begin without a signed-in session have none to
    // lock and none to revalidate against.
    const hasActorSession = !isBreakGlass && !isInvitation;
    const challenge = await this.consumeChallenge(
      input.ceremonyId,
      purpose,
      now,
      input.targetAdminUserId
    );

    const user = await this.options.database.adminUser.findUnique({
      where: { id: input.targetAdminUserId }
    });
    if (!user) throw new ApiError(404, "ADMIN_USER_NOT_FOUND", "Account not found.");
    const role = asRole(user.role);
    const status = asStatus(user.status);

    // Three ceremonies, three eligible states. Break-glass may enrol onto a
    // PROVISIONING or ACTIVE account, because it exists for somebody who has
    // lost the keys they had. An invitation may only enrol onto an account
    // still being set up. A session may only enrol onto its own live account.
    const eligible = isBreakGlass
      ? isRecoveryEligibleStatus(status)
      : isInvitation
        ? status === "PROVISIONING"
        : status === "ACTIVE";

    // What the caller is told when the account is not in a state this ceremony
    // may enrol onto. None of the messages distinguishes "no such account"
    // from "wrong state" — that difference is an enumeration oracle.
    const ceremonyFailed = (): ApiError =>
      isBreakGlass
        ? recoveryFailed()
        : isInvitation
          ? invitationInvalid()
          : mutationAuthorizationFailed();

    if (!eligible) {
      await this.auditFailure(
        input.actorAdminUserId,
        "admin.authenticator.enrol",
        input.requestId,
        now,
        { role, targetAdminUserId: input.targetAdminUserId, failureCode: "ACCOUNT_" + status }
      );
      throw ceremonyFailed();
    }

    const verified = await verifyRegistration({
      relyingParty: this.options.relyingParty,
      expectedChallenge: challenge.challenge,
      credential: input.credential
    }).catch(() => null);

    if (!verified) {
      await this.auditFailure(
        input.actorAdminUserId,
        "admin.authenticator.enrol",
        input.requestId,
        now,
        {
          role,
          targetAdminUserId: input.targetAdminUserId,
          failureCode: "ATTESTATION_INVALID"
        }
      );
      throw new ApiError(400, "ADMIN_ENROLMENT_FAILED", "The authenticator could not be enrolled.");
    }

    const authenticatorId = this.options.random.uuid(now);
    let activated = false;

    try {
      await this.options.database.$transaction(async (transaction) => {
        // Registration and activation are one account-level state transition.
        // Serialising on the owner row prevents two first-key ceremonies from
        // each counting only their own insert. The status/role predicate is
        // also the final authority: authorization may have raced with
        // suspension, disablement or revocation after the checks above.
        const locked = await transaction.adminUser.updateMany({
          where: {
            id: input.targetAdminUserId,
            role,
            status: isBreakGlass
              ? { in: ["PROVISIONING", "ACTIVE"] }
              : isInvitation
                ? "PROVISIONING"
                : "ACTIVE"
          },
          data: { updatedAt: now }
        });
        if (locked.count !== 1) throw new AdminCredentialStateChangedError();

        // Ordinary enrolment is self-management. Locking the live session in
        // the same transaction means a logout/suspension that wins this race
        // prevents the key change. Recovery and invitation enrolments have no
        // session and are bounded by the account-status predicate above — and,
        // for an invitation, by the live-invitation check below.
        if (hasActorSession) {
          const actorSessionId = input.actorSessionId;
          if (!actorSessionId) throw new AdminCredentialStateChangedError();
          const session = await transaction.adminSession.updateMany({
            where: {
              id: actorSessionId,
              adminUserId: input.targetAdminUserId,
              revokedAt: null,
              idleExpiresAt: { gt: now },
              hardExpiresAt: { gt: now }
            },
            data: { lastSeenAt: now }
          });
          if (session.count !== 1) throw new AdminCredentialStateChangedError();
        }

        // A revoked invitation stops working mid-flight, not just at the next
        // options request: the enrolment that would finish it re-checks here,
        // inside the transaction, after the owner lock.
        if (isInvitation) {
          const liveInvitation = await transaction.adminInvitation.findFirst({
            where: {
              adminUserId: input.targetAdminUserId,
              consumedAt: null,
              revokedAt: null,
              expiresAt: { gt: now }
            },
            select: { id: true }
          });
          if (!liveInvitation) throw new AdminCredentialStateChangedError();
        }

        const lockedUser = await transaction.adminUser.findUnique({
          where: { id: input.targetAdminUserId },
          select: { role: true, status: true, password: { select: { adminUserId: true } } }
        });
        if (!lockedUser) throw new AdminCredentialStateChangedError();
        const lockedRole = asRole(lockedUser.role);
        const lockedStatus = asStatus(lockedUser.status);

        await transaction.adminAuthenticator.create({
          data: {
            id: authenticatorId,
            adminUserId: input.targetAdminUserId,
            credentialId: verified.credentialId,
            publicKey: Buffer.from(verified.publicKey),
            signCount: verified.signCount,
            transports: verified.transports,
            attachment: verified.attachment,
            backupEligible: verified.backupEligible,
            backedUp: verified.backedUp,
            aaguid: verified.aaguid,
            label: input.label,
            createdAt: now
          }
        });

        const usable = await transaction.adminAuthenticator.count({
          where: { adminUserId: input.targetAdminUserId, revokedAt: null }
        });
        if (
          evaluateActivation(lockedRole, lockedStatus, usable, Boolean(lockedUser.password)).allowed
        ) {
          await transaction.adminUser.update({
            where: { id: input.targetAdminUserId },
            data: { status: "ACTIVE", activatedAt: now }
          });
          activated = true;

          if (isInvitation) {
            const consumed = await transaction.adminInvitation.updateMany({
              where: {
                adminUserId: input.targetAdminUserId,
                consumedAt: null,
                revokedAt: null,
                expiresAt: { gt: now }
              },
              data: { consumedAt: now }
            });
            if (consumed.count !== 1) throw new AdminCredentialStateChangedError();
            await writeAdminAuditEvent(transaction, {
              id: this.options.random.uuid(now),
              occurredAt: now,
              actorId: input.targetAdminUserId,
              action: "admin.invitation.accept",
              outcome: "SUCCESS",
              requestId: input.requestId,
              metadata: { role: lockedRole, targetAdminUserId: input.targetAdminUserId }
            });
          }
        }

        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: input.actorAdminUserId,
          action: "admin.authenticator.enrol",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: {
            role: lockedRole,
            targetAdminUserId: input.targetAdminUserId,
            authenticatorId,
            authenticatorLabel: input.label,
            ceremonyPurpose: purpose,
            resultingState: activated ? "ACTIVE" : lockedStatus
          }
        });
      });
    } catch (error) {
      if (!(error instanceof AdminCredentialStateChangedError)) throw error;
      await this.auditFailure(
        input.actorAdminUserId,
        "admin.authenticator.enrol",
        input.requestId,
        now,
        {
          role,
          targetAdminUserId: input.targetAdminUserId,
          failureCode: "ACCOUNT_OR_SESSION_STATE_CHANGED"
        }
      );
      throw ceremonyFailed();
    }

    return { authenticatorId, activated };
  }

  /**
   * Retire an authenticator.
   *
   * Refused when it would strip an active privileged account of its last
   * usable key: the replacement is enrolled first. A database trigger refuses
   * the same thing, so a future code path cannot skip this.
   */
  public async revokeAuthenticator(input: {
    admin: AuthenticatedAdmin;
    targetAdminUserId: string;
    authenticatorId: string;
    reason: string;
    requestId: string;
  }): Promise<void> {
    const now = this.options.clock.now();
    let targetRole: AdminRole = input.admin.role;
    try {
      await this.options.database.$transaction(async (transaction) => {
        // Every enrolment and revocation locks the same owner row first. This
        // prevents two requests from each observing the same spare count and
        // concurrently taking an ACTIVE account below its minimum.
        const locked = await transaction.adminUser.updateMany({
          where: {
            id: input.targetAdminUserId,
            role: input.admin.role,
            status: "ACTIVE"
          },
          data: { updatedAt: now }
        });
        if (locked.count !== 1) {
          throw new AdminAuthenticatorRevocationError("AUTHORIZATION_CHANGED");
        }

        // Lock and revalidate the self-management session after the account
        // row. This matches suspension's owner -> sessions order and prevents
        // a request authorized just before logout from retiring a key later.
        const session = await transaction.adminSession.updateMany({
          where: {
            id: input.admin.sessionId,
            adminUserId: input.targetAdminUserId,
            revokedAt: null,
            idleExpiresAt: { gt: now },
            hardExpiresAt: { gt: now }
          },
          data: { lastSeenAt: now }
        });
        if (session.count !== 1) {
          throw new AdminAuthenticatorRevocationError("AUTHORIZATION_CHANGED");
        }

        const user = await transaction.adminUser.findUnique({
          where: { id: input.targetAdminUserId },
          include: { authenticators: { where: { revokedAt: null }, select: { id: true } } }
        });
        if (!user) throw new AdminAuthenticatorRevocationError("USER_NOT_FOUND");
        targetRole = asRole(user.role);

        const owns = user.authenticators.some((entry) => entry.id === input.authenticatorId);
        if (!owns) throw new AdminAuthenticatorRevocationError("KEY_NOT_FOUND");
        if (
          !canRevokeAuthenticator(targetRole, asStatus(user.status), user.authenticators.length)
        ) {
          throw new AdminAuthenticatorRevocationError("LAST_SPARE");
        }

        const revoked = await transaction.adminAuthenticator.updateMany({
          where: {
            id: input.authenticatorId,
            adminUserId: input.targetAdminUserId,
            revokedAt: null
          },
          data: { revokedAt: now, revokedReason: input.reason.slice(0, 48) }
        });
        if (revoked.count !== 1) {
          throw new AdminAuthenticatorRevocationError("KEY_NOT_FOUND");
        }

        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: input.admin.adminUserId,
          action: "admin.authenticator.revoke",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: {
            role: input.admin.role,
            targetAdminUserId: input.targetAdminUserId,
            authenticatorId: input.authenticatorId,
            reason: input.reason
          }
        });
      });
    } catch (error) {
      if (!(error instanceof AdminAuthenticatorRevocationError)) throw error;
      if (error.reason === "AUTHORIZATION_CHANGED") {
        await this.auditFailure(
          input.admin.adminUserId,
          "admin.authenticator.revoke",
          input.requestId,
          now,
          {
            role: input.admin.role,
            targetAdminUserId: input.targetAdminUserId,
            authenticatorId: input.authenticatorId,
            failureCode: "ACCOUNT_OR_SESSION_STATE_CHANGED"
          }
        );
        throw mutationAuthorizationFailed();
      }
      if (error.reason === "USER_NOT_FOUND") {
        throw new ApiError(404, "ADMIN_USER_NOT_FOUND", "Account not found.");
      }
      if (error.reason === "KEY_NOT_FOUND") {
        throw new ApiError(404, "ADMIN_AUTHENTICATOR_NOT_FOUND", "Authenticator not found.");
      }

      await this.auditFailure(
        input.admin.adminUserId,
        "admin.authenticator.revoke",
        input.requestId,
        now,
        {
          role: targetRole,
          targetAdminUserId: input.targetAdminUserId,
          authenticatorId: input.authenticatorId,
          failureCode: "WOULD_LEAVE_NO_SPARE"
        }
      );
      throw new ApiError(
        409,
        "ADMIN_AUTHENTICATOR_LAST_SPARE",
        "Enrol a replacement before retiring this key."
      );
    }
  }

  // -------------------------------------------------------------------------
  // Break-glass
  // -------------------------------------------------------------------------

  /**
   * Consume a sealed recovery credential to authorise one enrolment.
   *
   * Deliberately narrow: it starts a registration ceremony for one named
   * account and nothing else. It issues no session, carries no capability, and
   * cannot perform an operational action. Using it is a single-use event that
   * an operator is expected to notice.
   */
  public async beginBreakGlassRegistration(input: {
    recoveryCode: string;
    requestId: string;
  }): Promise<{ ceremonyId: string; options: unknown; adminUserId: string }> {
    const now = this.options.clock.now();
    const credential = await this.options.database.adminBreakGlassCredential.findUnique({
      where: {
        secretDigest: digestBreakGlassSecret(input.recoveryCode, this.options.breakGlassPepper)
      },
      include: {
        adminUser: {
          include: {
            authenticators: { where: { revokedAt: null }, select: { credentialId: true } }
          }
        }
      }
    });

    if (
      !credential ||
      credential.consumedAt ||
      credential.revokedAt ||
      now.getTime() >= credential.expiresAt.getTime()
    ) {
      await this.auditAnonymousFailure(
        "admin.break_glass",
        input.requestId,
        now,
        "RECOVERY_CODE_INVALID"
      );
      throw recoveryFailed();
    }

    const user = credential.adminUser;
    const role = asRole(user.role);
    const status = asStatus(user.status);
    if (!isRecoveryEligibleStatus(status)) {
      await this.auditAnonymousFailure(
        "admin.break_glass",
        input.requestId,
        now,
        "RECOVERY_ACCOUNT_UNAVAILABLE"
      );
      throw recoveryFailed();
    }
    const options = await createRegistrationOptions({
      relyingParty: this.options.relyingParty,
      userHandle: new Uint8Array(user.userHandle),
      displayName: user.displayName,
      // Recovery must not let the same physical authenticator masquerade as
      // a second credential for this RP.
      existingCredentialIds: user.authenticators.map((entry) => entry.credentialId)
    });

    const ceremonyId = this.options.random.uuid(now);
    const claimed = await this.options.database.$transaction(async (transaction) => {
      // Recovery cannot override account suspension or permanent disablement.
      // Lock the owner first, matching every other identity mutation, so a
      // concurrent status change and this one-use claim have a clear winner.
      const eligibleUser = await transaction.adminUser.updateMany({
        where: {
          id: user.id,
          role,
          status: { in: ["PROVISIONING", "ACTIVE"] }
        },
        data: { updatedAt: now }
      });
      if (eligibleUser.count !== 1) return false;

      // The read above is intentionally not the claim. Only this conditional
      // write consumes the credential, so concurrent requests cannot both open
      // a valid recovery ceremony (or leak a database constraint error).
      const consumed = await transaction.adminBreakGlassCredential.updateMany({
        where: {
          id: credential.id,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: now }
        },
        data: { consumedAt: now }
      });
      if (consumed.count !== 1) return false;

      await transaction.adminWebAuthnChallenge.create({
        data: {
          id: ceremonyId,
          purpose: "BREAK_GLASS_REGISTRATION",
          challenge: options.challenge,
          adminUserId: user.id,
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.options.challengeTtlMilliseconds)
        }
      });
      // Consumed at the point it authorises a ceremony, not at the point the
      // ceremony succeeds. A failed attempt must still burn the code, or it
      // would be retryable by anyone who saw it.
      await writeAdminAuditEvent(transaction, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: user.id,
        action: "admin.break_glass",
        outcome: "SUCCESS",
        requestId: input.requestId,
        metadata: { role, targetAdminUserId: user.id, ceremonyPurpose: "BREAK_GLASS_REGISTRATION" }
      });
      return true;
    });

    if (!claimed) {
      await this.auditAnonymousFailure(
        "admin.break_glass",
        input.requestId,
        now,
        "RECOVERY_CODE_INVALID"
      );
      throw recoveryFailed();
    }

    return { ceremonyId, options, adminUserId: user.id };
  }

  /**
   * The account a break-glass ceremony was opened for.
   *
   * The recovery credential named it; the browser only carries the ceremony
   * identifier, so the target is read back from the server rather than trusted
   * from the request.
   */
  public async resolveBreakGlassCeremonyTarget(ceremonyId: string): Promise<string | null> {
    const now = this.options.clock.now();
    const ceremony = await this.options.database.adminWebAuthnChallenge.findFirst({
      where: {
        id: ceremonyId,
        purpose: "BREAK_GLASS_REGISTRATION",
        consumedAt: null,
        expiresAt: { gt: now }
      },
      select: { adminUserId: true }
    });
    return ceremony?.adminUserId ?? null;
  }

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  /**
   * Create an account and the invitation that hands it over.
   *
   * The account exists from this moment, PROVISIONING, already holding its
   * role — acceptance decides nothing, it only proves the code and supplies
   * the factors. Which roles the actor may mint is the matrix in
   * `admin-access`; the capability on the route only opened the surface.
   */
  public async createInvitation(input: {
    actor: AuthenticatedAdmin;
    username: string;
    displayName: string;
    role: AdminRole;
    reason: string;
    requestId: string;
  }): Promise<{
    invitationId: string;
    adminUserId: string;
    invitationCode: string;
    expiresAt: Date;
  }> {
    const now = this.options.clock.now();
    if (!mayInviteRole(input.actor.role, input.role)) {
      await this.auditFailure(
        input.actor.adminUserId,
        "admin.invitation.create",
        input.requestId,
        now,
        {
          role: input.actor.role,
          targetRole: input.role,
          failureCode: "ROLE_NOT_INVITABLE"
        }
      );
      throw new ApiError(403, "ADMIN_FORBIDDEN", "Your role cannot invite this role.");
    }

    const adminUserId = this.options.random.uuid(now);
    const invitationId = this.options.random.uuid(now);
    const invitationCode = this.options.random.token(ONE_TIME_CODE_BYTES);
    const expiresAt = new Date(now.getTime() + this.options.invitationTtlMilliseconds);
    const userHandle = Buffer.from(
      this.options.random.token(USER_HANDLE_BYTES),
      "base64url"
    ).subarray(0, USER_HANDLE_BYTES);

    try {
      await this.options.database.$transaction(async (transaction) => {
        await transaction.adminUser.create({
          data: {
            id: adminUserId,
            userHandle,
            username: input.username,
            displayName: input.displayName,
            role: input.role,
            status: "PROVISIONING",
            createdAt: now
          }
        });
        await transaction.adminInvitation.create({
          data: {
            id: invitationId,
            adminUserId,
            issuedByAdminId: input.actor.adminUserId,
            secretDigest: digestInvitationSecret(invitationCode, this.options.breakGlassPepper),
            reason: input.reason,
            createdAt: now,
            expiresAt
          }
        });
        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: input.actor.adminUserId,
          action: "admin.invitation.create",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: {
            role: input.actor.role,
            targetAdminUserId: adminUserId,
            targetRole: input.role,
            invitationId,
            invitationExpiresAt: expiresAt.toISOString(),
            reason: input.reason
          }
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "ADMIN_USERNAME_TAKEN", "This username is already in use.");
      }
      throw error;
    }

    return { invitationId, adminUserId, invitationCode, expiresAt };
  }

  /**
   * Issue a fresh code for an account still PROVISIONING — the original
   * expired, or never reached the person. The old grant is revoked in the
   * same transaction, so exactly one code is ever live per account.
   */
  public async reissueInvitation(input: {
    actor: AuthenticatedAdmin;
    targetAdminUserId: string;
    reason: string;
    requestId: string;
  }): Promise<{ invitationId: string; invitationCode: string; expiresAt: Date }> {
    const now = this.options.clock.now();
    const target = await this.options.database.adminUser.findUnique({
      where: { id: input.targetAdminUserId },
      select: { role: true, status: true }
    });
    // One refusal for "no such account" and "not a role you may invite", the
    // same way the people module answers: a 403 here would confirm that an
    // identifier names a real account of a role the caller cannot reach, which
    // is the difference the reset path is careful not to disclose either.
    const targetRole = target ? asRole(target.role) : null;
    if (!target || !targetRole || !mayInviteRole(input.actor.role, targetRole)) {
      throw new ApiError(404, "ADMIN_NOT_FOUND", "No such record.");
    }
    if (asStatus(target.status) !== "PROVISIONING") {
      throw new ApiError(409, "ADMIN_INVITATION_NOT_APPLICABLE", "This account is already set up.");
    }

    const invitationId = this.options.random.uuid(now);
    const invitationCode = this.options.random.token(ONE_TIME_CODE_BYTES);
    const expiresAt = new Date(now.getTime() + this.options.invitationTtlMilliseconds);

    await this.options.database
      .$transaction(async (transaction) => {
        const locked = await transaction.adminUser.updateMany({
          where: { id: input.targetAdminUserId, role: targetRole, status: "PROVISIONING" },
          data: { updatedAt: now }
        });
        if (locked.count !== 1) throw new AdminCredentialStateChangedError();

        await transaction.adminInvitation.updateMany({
          where: { adminUserId: input.targetAdminUserId, consumedAt: null, revokedAt: null },
          data: { revokedAt: now }
        });
        await transaction.adminInvitation.create({
          data: {
            id: invitationId,
            adminUserId: input.targetAdminUserId,
            issuedByAdminId: input.actor.adminUserId,
            secretDigest: digestInvitationSecret(invitationCode, this.options.breakGlassPepper),
            reason: input.reason,
            createdAt: now,
            expiresAt
          }
        });
        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: input.actor.adminUserId,
          action: "admin.invitation.reissue",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: {
            role: input.actor.role,
            targetAdminUserId: input.targetAdminUserId,
            targetRole,
            invitationId,
            invitationExpiresAt: expiresAt.toISOString(),
            reason: input.reason
          }
        });
      })
      .catch((error: unknown) => {
        if (error instanceof AdminCredentialStateChangedError) {
          throw new ApiError(
            409,
            "ADMIN_INVITATION_NOT_APPLICABLE",
            "This account is already set up."
          );
        }
        throw error;
      });

    return { invitationId, invitationCode, expiresAt };
  }

  /** Invitations the actor is entitled to see: those for roles they may mint. */
  public async listInvitations(actor: AuthenticatedAdmin): Promise<InvitationView[]> {
    const now = this.options.clock.now();
    const rows = await this.options.database.adminInvitation.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        adminUser: { select: { username: true, displayName: true, role: true } },
        issuedBy: { select: { displayName: true } }
      }
    });

    return rows
      .filter((row) => mayInviteRole(actor.role, asRole(row.adminUser.role)))
      .map((row) => ({
        invitationId: row.id,
        adminUserId: row.adminUserId,
        username: row.adminUser.username,
        displayName: row.adminUser.displayName,
        role: asRole(row.adminUser.role),
        issuedByDisplayName: row.issuedBy?.displayName ?? null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        status: row.consumedAt
          ? ("ACCEPTED" as const)
          : row.revokedAt
            ? ("REVOKED" as const)
            : now.getTime() >= row.expiresAt.getTime()
              ? ("EXPIRED" as const)
              : ("PENDING" as const)
      }));
  }

  public async revokeInvitation(input: {
    actor: AuthenticatedAdmin;
    invitationId: string;
    requestId: string;
  }): Promise<void> {
    const now = this.options.clock.now();
    const invitation = await this.options.database.adminInvitation.findUnique({
      where: { id: input.invitationId },
      include: { adminUser: { select: { role: true } } }
    });
    if (!invitation) throw new ApiError(404, "ADMIN_NOT_FOUND", "No such record.");
    const targetRole = asRole(invitation.adminUser.role);
    if (!mayInviteRole(input.actor.role, targetRole)) {
      throw new ApiError(404, "ADMIN_NOT_FOUND", "No such record.");
    }

    const revoked = await this.options.database.adminInvitation.updateMany({
      where: { id: input.invitationId, consumedAt: null, revokedAt: null },
      data: { revokedAt: now }
    });
    if (revoked.count !== 1) {
      throw new ApiError(409, "ADMIN_INVITATION_NOT_LIVE", "This invitation is no longer live.");
    }

    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: input.actor.adminUserId,
      action: "admin.invitation.revoke",
      outcome: "SUCCESS",
      requestId: input.requestId,
      metadata: {
        role: input.actor.role,
        targetAdminUserId: invitation.adminUserId,
        targetRole,
        invitationId: invitation.id
      }
    });
  }

  /**
   * What the acceptance page needs, against a live code. One generic refusal
   * for every kind of dead code — wrong, expired, spent, revoked.
   */
  public async previewInvitation(input: { code: string; requestId: string }): Promise<{
    displayName: string;
    username: string;
    role: AdminRole;
    passwordSet: boolean;
    webAuthnRequired: boolean;
    usableAuthenticators: number;
  }> {
    const invitation = await this.resolveLiveInvitation(input.code, input.requestId);
    const role = asRole(invitation.adminUser.role);
    return {
      displayName: invitation.adminUser.displayName,
      username: invitation.adminUser.username,
      role,
      passwordSet: Boolean(invitation.adminUser.password),
      webAuthnRequired: requiresWebAuthn(role),
      usableAuthenticators: invitation.adminUser.authenticators.length
    };
  }

  /**
   * Set (or, while still PROVISIONING, replace) the invited account's
   * password. Activates the account — and consumes the invitation — when the
   * role needs nothing more.
   */
  public async setInvitationPassword(input: {
    code: string;
    password: string;
    requestId: string;
  }): Promise<InvitationProgress> {
    const now = this.options.clock.now();
    const invitation = await this.resolveLiveInvitation(input.code, input.requestId);
    const role = asRole(invitation.adminUser.role);
    const digest = await hashPassword(input.password);
    let activated = false;

    try {
      await this.options.database.$transaction(async (transaction) => {
        const locked = await transaction.adminUser.updateMany({
          where: { id: invitation.adminUserId, role, status: "PROVISIONING" },
          data: { updatedAt: now }
        });
        if (locked.count !== 1) throw new AdminCredentialStateChangedError();

        const live = await transaction.adminInvitation.findFirst({
          where: { id: invitation.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
          select: { id: true }
        });
        if (!live) throw new AdminCredentialStateChangedError();

        await transaction.adminPassword.upsert({
          where: { adminUserId: invitation.adminUserId },
          create: { adminUserId: invitation.adminUserId, digest, createdAt: now, updatedAt: now },
          update: { digest, updatedAt: now }
        });

        const usable = await transaction.adminAuthenticator.count({
          where: { adminUserId: invitation.adminUserId, revokedAt: null }
        });
        if (evaluateActivation(role, "PROVISIONING", usable, true).allowed) {
          await transaction.adminUser.update({
            where: { id: invitation.adminUserId },
            data: { status: "ACTIVE", activatedAt: now }
          });
          const consumed = await transaction.adminInvitation.updateMany({
            where: { id: invitation.id, consumedAt: null, revokedAt: null },
            data: { consumedAt: now }
          });
          if (consumed.count !== 1) throw new AdminCredentialStateChangedError();
          activated = true;
        }

        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: invitation.adminUserId,
          action: activated ? "admin.invitation.accept" : "admin.invitation.redeem",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: {
            role,
            targetAdminUserId: invitation.adminUserId,
            invitationId: invitation.id,
            resultingState: activated ? "ACTIVE" : "PROVISIONING"
          }
        });
      });
    } catch (error) {
      if (!(error instanceof AdminCredentialStateChangedError)) throw error;
      await this.auditAnonymousFailure(
        "admin.invitation.redeem",
        input.requestId,
        now,
        "INVITATION_STATE_CHANGED"
      );
      throw invitationInvalid();
    }

    const usable = await this.options.database.adminAuthenticator.count({
      where: { adminUserId: invitation.adminUserId, revokedAt: null }
    });
    return {
      activated,
      passwordSet: true,
      webAuthnRequired: requiresWebAuthn(role),
      usableAuthenticators: usable
    };
  }

  /**
   * Begin the key-enrolment half of an invitation, for roles that need one.
   *
   * Unlike break-glass, this does not consume the invitation: the code stays
   * redeemable until the account activates, so a fumbled prompt costs a retry
   * rather than a walk back to whoever issued it. What bounds it is the
   * ceremony's own expiry, the PROVISIONING requirement, and the live-code
   * check repeated inside the completing transaction.
   */
  public async beginInvitationRegistration(input: {
    code: string;
    requestId: string;
  }): Promise<{ ceremonyId: string; options: unknown; adminUserId: string }> {
    const invitation = await this.resolveLiveInvitation(input.code, input.requestId);
    const user = invitation.adminUser;

    const options = await createRegistrationOptions({
      relyingParty: this.options.relyingParty,
      userHandle: new Uint8Array(user.userHandle),
      displayName: user.displayName,
      existingCredentialIds: user.authenticators.map((entry) => entry.credentialId)
    });
    const ceremonyId = await this.storeChallenge(
      "INVITATION_REGISTRATION",
      options.challenge,
      invitation.adminUserId
    );
    return { ceremonyId, options, adminUserId: invitation.adminUserId };
  }

  /** The account an invitation ceremony was opened for; same shape as break-glass. */
  public async resolveInvitationCeremonyTarget(
    ceremonyId: string,
    code: string
  ): Promise<string | null> {
    const now = this.options.clock.now();
    const ceremony = await this.options.database.adminWebAuthnChallenge.findFirst({
      where: {
        id: ceremonyId,
        purpose: "INVITATION_REGISTRATION",
        consumedAt: null,
        expiresAt: { gt: now }
      },
      select: { adminUserId: true }
    });
    if (!ceremony?.adminUserId) return null;

    // The ceremony identifier alone would be enough — it is server-issued and
    // was only ever handed to somebody who presented a live code. Requiring the
    // code again binds the finishing request to the same grant the ceremony was
    // opened with, so a ceremony identifier that leaked on its own finishes
    // nothing.
    const invitation = await this.options.database.adminInvitation.findUnique({
      where: { secretDigest: digestInvitationSecret(code, this.options.breakGlassPepper) },
      select: { adminUserId: true, consumedAt: true, revokedAt: true, expiresAt: true }
    });
    if (
      !invitation ||
      invitation.adminUserId !== ceremony.adminUserId ||
      invitation.consumedAt ||
      invitation.revokedAt ||
      now.getTime() >= invitation.expiresAt.getTime()
    ) {
      return null;
    }

    return ceremony.adminUserId;
  }

  // -------------------------------------------------------------------------
  // Password change and administrator-assisted recovery
  // -------------------------------------------------------------------------

  /**
   * Change one's own password. The current password is demanded even inside a
   * fresh step-up, and every *other* session ends: whoever knows the new
   * password from this moment is whoever typed it, in this session.
   */
  public async changeOwnPassword(input: {
    admin: AuthenticatedAdmin;
    currentPassword: string;
    newPassword: string;
    requestId: string;
  }): Promise<{ revokedSessions: number }> {
    const now = this.options.clock.now();
    if (!(await this.verifyAccountPassword(input.admin.adminUserId, input.currentPassword))) {
      await this.auditFailure(
        input.admin.adminUserId,
        "admin.password.change",
        input.requestId,
        now,
        {
          role: input.admin.role,
          failureCode: "CREDENTIALS_INVALID"
        }
      );
      throw new ApiError(401, "ADMIN_PASSWORD_INCORRECT", "The current password is not correct.");
    }

    const digest = await hashPassword(input.newPassword);
    let revokedSessions = 0;
    try {
      await this.options.database.$transaction(async (transaction) => {
        const activeUser = await transaction.adminUser.updateMany({
          where: { id: input.admin.adminUserId, role: input.admin.role, status: "ACTIVE" },
          data: { updatedAt: now }
        });
        if (activeUser.count !== 1) throw new AdminCredentialStateChangedError();

        const session = await transaction.adminSession.updateMany({
          where: {
            id: input.admin.sessionId,
            adminUserId: input.admin.adminUserId,
            revokedAt: null,
            idleExpiresAt: { gt: now },
            hardExpiresAt: { gt: now }
          },
          data: { lastSeenAt: now }
        });
        if (session.count !== 1) throw new AdminCredentialStateChangedError();

        await transaction.adminPassword.update({
          where: { adminUserId: input.admin.adminUserId },
          data: { digest, updatedAt: now }
        });

        const revoked = await transaction.adminSession.updateMany({
          where: {
            adminUserId: input.admin.adminUserId,
            id: { not: input.admin.sessionId },
            revokedAt: null
          },
          data: { revokedAt: now, revokedReason: "PASSWORD_CHANGED" }
        });
        revokedSessions = revoked.count;

        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: input.admin.adminUserId,
          action: "admin.password.change",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: { role: input.admin.role, revokedSessions }
        });
      });
    } catch (error) {
      if (!(error instanceof AdminCredentialStateChangedError)) throw error;
      throw mutationAuthorizationFailed();
    }

    return { revokedSessions };
  }

  /**
   * Issue a password-reset code for another account. The issuer carries the
   * code to the person and never sees the password that results. For a
   * privileged target the WebAuthn factor still stands whatever the code
   * does, which is what keeps a malicious issuer out of the account.
   */
  public async issuePasswordReset(input: {
    actor: AuthenticatedAdmin;
    targetAdminUserId: string;
    reason: string;
    requestId: string;
  }): Promise<{
    resetId: string;
    resetCode: string;
    expiresAt: Date;
    targetDisplayName: string;
  }> {
    const now = this.options.clock.now();
    const target = await this.options.database.adminUser.findUnique({
      where: { id: input.targetAdminUserId },
      select: { role: true, status: true, displayName: true }
    });
    if (!target) throw new ApiError(404, "ADMIN_NOT_FOUND", "No such record.");
    const targetRole = asRole(target.role);
    if (!mayResetPassword(input.actor.role, targetRole)) {
      await this.auditFailure(
        input.actor.adminUserId,
        "admin.password_reset.issue",
        input.requestId,
        now,
        {
          role: input.actor.role,
          targetAdminUserId: input.targetAdminUserId,
          targetRole,
          failureCode: "ROLE_NOT_RESETTABLE"
        }
      );
      throw new ApiError(404, "ADMIN_NOT_FOUND", "No such record.");
    }
    if (asStatus(target.status) !== "ACTIVE") {
      throw new ApiError(
        409,
        "ADMIN_RESET_NOT_APPLICABLE",
        "Only an active account's password can be reset. A provisioning account needs a new invitation code instead."
      );
    }

    const resetId = this.options.random.uuid(now);
    const resetCode = this.options.random.token(ONE_TIME_CODE_BYTES);
    const expiresAt = new Date(now.getTime() + this.options.passwordResetTtlMilliseconds);

    await this.options.database.$transaction(async (transaction) => {
      // One live code per account: issuing again quietly replaces the old one.
      await transaction.adminPasswordReset.updateMany({
        where: { adminUserId: input.targetAdminUserId, consumedAt: null, revokedAt: null },
        data: { revokedAt: now }
      });
      await transaction.adminPasswordReset.create({
        data: {
          id: resetId,
          adminUserId: input.targetAdminUserId,
          issuedByAdminId: input.actor.adminUserId,
          secretDigest: digestPasswordResetSecret(resetCode, this.options.breakGlassPepper),
          reason: input.reason,
          createdAt: now,
          expiresAt
        }
      });
      await writeAdminAuditEvent(transaction, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: input.actor.adminUserId,
        action: "admin.password_reset.issue",
        outcome: "SUCCESS",
        requestId: input.requestId,
        metadata: {
          role: input.actor.role,
          targetAdminUserId: input.targetAdminUserId,
          targetRole,
          resetId,
          resetExpiresAt: expiresAt.toISOString(),
          reason: input.reason
        }
      });
    });

    return { resetId, resetCode, expiresAt, targetDisplayName: target.displayName };
  }

  public async revokePasswordReset(input: {
    actor: AuthenticatedAdmin;
    resetId: string;
    requestId: string;
  }): Promise<void> {
    const now = this.options.clock.now();
    const reset = await this.options.database.adminPasswordReset.findUnique({
      where: { id: input.resetId },
      include: { adminUser: { select: { role: true } } }
    });
    if (!reset) throw new ApiError(404, "ADMIN_NOT_FOUND", "No such record.");
    if (!mayResetPassword(input.actor.role, asRole(reset.adminUser.role))) {
      throw new ApiError(404, "ADMIN_NOT_FOUND", "No such record.");
    }

    const revoked = await this.options.database.adminPasswordReset.updateMany({
      where: { id: input.resetId, consumedAt: null, revokedAt: null },
      data: { revokedAt: now }
    });
    if (revoked.count !== 1) {
      throw new ApiError(409, "ADMIN_RESET_NOT_LIVE", "This reset is no longer live.");
    }

    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: input.actor.adminUserId,
      action: "admin.password_reset.revoke",
      outcome: "SUCCESS",
      requestId: input.requestId,
      metadata: {
        role: input.actor.role,
        targetAdminUserId: reset.adminUserId,
        resetId: reset.id
      }
    });
  }

  /**
   * Complete a reset: prove the code, set the new password, end every session
   * the account had. The person signs in fresh with the password only they
   * know — and, for privileged roles, the key only they hold.
   */
  public async completePasswordReset(input: {
    code: string;
    newPassword: string;
    requestId: string;
  }): Promise<{ revokedSessions: number }> {
    const now = this.options.clock.now();
    const reset = await this.options.database.adminPasswordReset.findUnique({
      where: {
        secretDigest: digestPasswordResetSecret(input.code, this.options.breakGlassPepper)
      },
      include: { adminUser: { select: { role: true, status: true } } }
    });

    if (
      !reset ||
      reset.consumedAt ||
      reset.revokedAt ||
      now.getTime() >= reset.expiresAt.getTime() ||
      asStatus(reset.adminUser.status) !== "ACTIVE"
    ) {
      await this.auditAnonymousFailure(
        "admin.password_reset.complete",
        input.requestId,
        now,
        "RESET_CODE_INVALID"
      );
      throw resetInvalid();
    }

    const digest = await hashPassword(input.newPassword);
    let revokedSessions = 0;
    try {
      await this.options.database.$transaction(async (transaction) => {
        const locked = await transaction.adminUser.updateMany({
          where: { id: reset.adminUserId, status: "ACTIVE" },
          data: { updatedAt: now }
        });
        if (locked.count !== 1) throw new AdminCredentialStateChangedError();

        const consumed = await transaction.adminPasswordReset.updateMany({
          where: { id: reset.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now }
        });
        if (consumed.count !== 1) throw new AdminCredentialStateChangedError();

        await transaction.adminPassword.upsert({
          where: { adminUserId: reset.adminUserId },
          create: { adminUserId: reset.adminUserId, digest, createdAt: now, updatedAt: now },
          update: { digest, updatedAt: now }
        });

        const revoked = await transaction.adminSession.updateMany({
          where: { adminUserId: reset.adminUserId, revokedAt: null },
          data: { revokedAt: now, revokedReason: "PASSWORD_RESET" }
        });
        revokedSessions = revoked.count;

        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: reset.adminUserId,
          action: "admin.password_reset.complete",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: {
            role: asRole(reset.adminUser.role),
            targetAdminUserId: reset.adminUserId,
            resetId: reset.id,
            revokedSessions
          }
        });
      });
    } catch (error) {
      if (!(error instanceof AdminCredentialStateChangedError)) throw error;
      await this.auditAnonymousFailure(
        "admin.password_reset.complete",
        input.requestId,
        now,
        "RESET_STATE_CHANGED"
      );
      throw resetInvalid();
    }

    return { revokedSessions };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Resolve a request's session cookie to an identity, a locked session, or
   * nothing.
   *
   * Every admin request goes through this, so revocation and expiry take
   * effect immediately rather than waiting for a sweep. The idle window rolls
   * forward here too, at most once a minute, so a busy session does not write
   * a row on every request. A locked session rolls nothing: only a
   * reauthentication moves it.
   */
  public async resolveSession(
    sessionToken: string,
    client?: AdminClientContext
  ): Promise<AdminSessionResolution> {
    const now = this.options.clock.now();
    const session = await this.options.database.adminSession.findUnique({
      where: { tokenDigest: digestAdminSessionToken(sessionToken, this.options.sessionPepper) },
      include: {
        adminUser: {
          include: { kioskScopes: { where: { revokedAt: null }, select: { kioskId: true } } }
        }
      }
    });
    if (!session) return null;
    if (!canAuthenticate(asStatus(session.adminUser.status))) return null;

    const role = asRole(session.adminUser.role);
    const evaluation = evaluateSession(session, now);
    if (evaluation.state === "INVALID") return null;
    if (evaluation.state === "LOCKED") {
      return {
        state: "LOCKED",
        locked: {
          adminUserId: session.adminUserId,
          displayName: session.adminUser.displayName,
          role,
          sessionId: session.id,
          hardExpiresAt: session.hardExpiresAt
        }
      };
    }

    const idleExpiresAt = nextIdleExpiry(
      now,
      this.options.sessionWindows.idleTtlMilliseconds[role]
    );
    // The idle window never extends past the absolute limit.
    const nextIdle =
      idleExpiresAt.getTime() > session.hardExpiresAt.getTime()
        ? session.hardExpiresAt
        : idleExpiresAt;

    const shouldRefresh =
      !session.lastSeenAt || now.getTime() - session.lastSeenAt.getTime() >= 60_000;
    if (shouldRefresh) {
      await this.options.database.adminSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: {
          lastSeenAt: now,
          idleExpiresAt: nextIdle,
          ...(client?.ipAddress ? { ipAddress: client.ipAddress.slice(0, IP_ADDRESS_LIMIT) } : {})
        }
      });
    }

    return {
      state: "ACTIVE",
      admin: {
        adminUserId: session.adminUserId,
        username: session.adminUser.username,
        displayName: session.adminUser.displayName,
        role,
        sessionId: session.id,
        idleExpiresAt: shouldRefresh ? nextIdle : session.idleExpiresAt,
        hardExpiresAt: session.hardExpiresAt,
        lastStepUpAt: session.lastStepUpAt,
        kioskScopes: session.adminUser.kioskScopes.map((scope) => scope.kioskId)
      }
    };
  }

  public async verifyCsrf(
    sessionId: string,
    presentedToken: string,
    options?: { allowLocked?: boolean }
  ): Promise<boolean> {
    const now = this.options.clock.now();
    const session = await this.options.database.adminSession.findFirst({
      // Re-check liveness while binding the token. This closes the ordinary
      // race where logout or suspension commits after initial session
      // resolution but before a mutating request reaches its CSRF check. The
      // unlock and logout routes accept a locked session — that is what they
      // are for — so for them only revocation and the absolute limit gate.
      where: {
        id: sessionId,
        revokedAt: null,
        hardExpiresAt: { gt: now },
        ...(options?.allowLocked ? {} : { idleExpiresAt: { gt: now } })
      },
      select: { csrfDigest: true }
    });
    if (!session) return false;
    return digestsMatch(
      session.csrfDigest,
      digestAdminCsrfToken(presentedToken, this.options.sessionPepper)
    );
  }

  public async revokeSession(input: {
    adminUserId: string;
    sessionId: string;
    role: AdminRole;
    reason: string;
    requestId: string;
  }): Promise<void> {
    const now = this.options.clock.now();
    await this.options.database.$transaction(async (transaction) => {
      const revoked = await transaction.adminSession.updateMany({
        where: { id: input.sessionId, adminUserId: input.adminUserId, revokedAt: null },
        data: { revokedAt: now, revokedReason: input.reason.slice(0, 48) }
      });
      // Logout is idempotent. A concurrent duplicate still succeeds and clears
      // its cookies, but only the request that changed state records SUCCESS.
      if (revoked.count !== 1) return;
      await writeAdminAuditEvent(transaction, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: input.adminUserId,
        action: "admin.logout",
        outcome: "SUCCESS",
        requestId: input.requestId,
        metadata: { role: input.role, reason: input.reason }
      });
    });
  }

  /** The caller's own sessions, newest activity first, current one marked. */
  public async listOwnSessions(admin: AuthenticatedAdmin): Promise<OwnSessionView[]> {
    const now = this.options.clock.now();
    const rows = await this.options.database.adminSession.findMany({
      where: { adminUserId: admin.adminUserId, revokedAt: null, hardExpiresAt: { gt: now } },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
      take: 50,
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        idleExpiresAt: true,
        ipAddress: true,
        userAgent: true
      }
    });
    return rows.map((row) => ({
      sessionId: row.id,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      state: now.getTime() >= row.idleExpiresAt.getTime() ? "LOCKED" : "ACTIVE",
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      current: row.id === admin.sessionId
    }));
  }

  /** End one of one's own sessions — never anybody else's through this path. */
  public async revokeOwnSession(input: {
    admin: AuthenticatedAdmin;
    sessionId: string;
    requestId: string;
  }): Promise<void> {
    const now = this.options.clock.now();
    const revoked = await this.options.database.adminSession.updateMany({
      where: { id: input.sessionId, adminUserId: input.admin.adminUserId, revokedAt: null },
      data: { revokedAt: now, revokedReason: "USER_REVOKED" }
    });
    if (revoked.count !== 1) {
      throw new ApiError(404, "ADMIN_NOT_FOUND", "No such record.");
    }
    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: input.admin.adminUserId,
      action: "admin.session.revoke",
      outcome: "SUCCESS",
      requestId: input.requestId,
      metadata: { role: input.admin.role, revokedSessionId: input.sessionId }
    });
  }

  /** "Sign out everywhere else." The session doing the asking survives. */
  public async revokeOtherSessions(input: {
    admin: AuthenticatedAdmin;
    requestId: string;
  }): Promise<{ revokedSessions: number }> {
    const now = this.options.clock.now();
    const revoked = await this.options.database.adminSession.updateMany({
      where: {
        adminUserId: input.admin.adminUserId,
        id: { not: input.admin.sessionId },
        revokedAt: null
      },
      data: { revokedAt: now, revokedReason: "USER_REVOKED_OTHERS" }
    });
    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: input.admin.adminUserId,
      action: "admin.session.revoke",
      outcome: "SUCCESS",
      requestId: input.requestId,
      metadata: { role: input.admin.role, revokedSessions: revoked.count }
    });
    return { revokedSessions: revoked.count };
  }

  public async listAuthenticators(adminUserId: string, role: AdminRole) {
    const items = await this.options.database.adminAuthenticator.findMany({
      where: { adminUserId, revokedAt: null },
      orderBy: { createdAt: "asc" }
    });
    return { items, minimumRequired: minimumAuthenticators(role), usableCount: items.length };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async verifyAccountPassword(adminUserId: string, password: string): Promise<boolean> {
    const stored = await this.options.database.adminPassword.findUnique({
      where: { adminUserId },
      select: { digest: true }
    });
    if (!stored) return burnEquivalentWork(password);
    return verifyPassword(password, stored.digest);
  }

  private async issueSession(input: {
    adminUserId: string;
    username: string;
    displayName: string;
    role: AdminRole;
    method: StrongAuthMethod;
    authenticator?: { id: string; expectedSignCount: number; newSignCount: number };
    now: Date;
    requestId: string;
    client: AdminClientContext;
  }): Promise<{ admin: AuthenticatedAdmin; cookies: AdminSessionCookiePair }> {
    const { now } = input;
    const sessionId = this.options.random.uuid(now);
    const sessionToken = this.options.random.token(SESSION_TOKEN_BYTES);
    const csrfToken = this.options.random.token(CSRF_TOKEN_BYTES);
    const hardExpiresAt = new Date(
      now.getTime() + this.options.sessionWindows.absoluteTtlMilliseconds[input.role]
    );
    const idleCandidate = nextIdleExpiry(
      now,
      this.options.sessionWindows.idleTtlMilliseconds[input.role]
    );
    const idleExpiresAt = idleCandidate > hardExpiresAt ? hardExpiresAt : idleCandidate;

    let scopes: { kioskId: string }[];
    try {
      scopes = await this.options.database.$transaction(async (transaction) => {
        // Lock the account first so authentication has the same lock order as
        // enrolment and account suspension. The conditional role/status check
        // also closes the gap between the pre-verification lookup and issuance.
        const activeUser = await transaction.adminUser.updateMany({
          where: { id: input.adminUserId, role: input.role, status: "ACTIVE" },
          data: { lastLoginAt: now }
        });
        if (activeUser.count !== 1) throw new AdminCredentialStateChangedError();

        // Compare-and-set is required in addition to cryptographic verification:
        // two assertions can verify against the same old counter concurrently.
        // Exactly one may advance it and receive a session.
        if (input.authenticator) {
          const authenticator = await transaction.adminAuthenticator.updateMany({
            where: {
              id: input.authenticator.id,
              adminUserId: input.adminUserId,
              revokedAt: null,
              signCount: input.authenticator.expectedSignCount
            },
            data: { signCount: input.authenticator.newSignCount, lastUsedAt: now }
          });
          if (authenticator.count !== 1) throw new AdminCredentialStateChangedError();
        }

        await transaction.adminSession.create({
          data: {
            id: sessionId,
            adminUserId: input.adminUserId,
            tokenDigest: digestAdminSessionToken(sessionToken, this.options.sessionPepper),
            csrfDigest: digestAdminCsrfToken(csrfToken, this.options.sessionPepper),
            createdAt: now,
            idleExpiresAt,
            hardExpiresAt,
            lastSeenAt: now,
            // Logging in is itself a fresh strong authentication for this
            // role, so a sensitive action taken immediately after does not ask
            // to prove it twice.
            lastStepUpAt: now,
            ipAddress: input.client.ipAddress?.slice(0, IP_ADDRESS_LIMIT) ?? null,
            userAgent: input.client.userAgent?.slice(0, USER_AGENT_LIMIT) ?? null
          }
        });
        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: input.adminUserId,
          action: "admin.authentication",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: {
            role: input.role,
            method: input.method,
            ...(input.authenticator ? { authenticatorId: input.authenticator.id } : {}),
            sessionId
          }
        });
        // Keep every database operation needed to return the new identity in
        // this transaction. If scope loading fails, no unreachable live session
        // is committed after the one-time ceremony has been consumed.
        return transaction.adminKioskScope.findMany({
          // Withdrawn assignments stay as rows so the history survives; they
          // are not assignments any more, so they are not loaded here.
          where: { adminUserId: input.adminUserId, revokedAt: null },
          select: { kioskId: true }
        });
      });
    } catch (error) {
      if (!(error instanceof AdminCredentialStateChangedError)) throw error;
      await this.auditFailure(input.adminUserId, "admin.authentication", input.requestId, now, {
        role: input.role,
        ...(input.authenticator ? { authenticatorId: input.authenticator.id } : {}),
        failureCode: "CREDENTIAL_STATE_CHANGED"
      });
      throw authenticationFailed();
    }

    return {
      admin: {
        adminUserId: input.adminUserId,
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        sessionId,
        idleExpiresAt,
        hardExpiresAt,
        lastStepUpAt: now,
        kioskScopes: scopes.map((scope) => scope.kioskId)
      },
      cookies: { sessionToken, csrfToken, idleExpiresAt, hardExpiresAt }
    };
  }

  /**
   * Bring a locked session back to ACTIVE after a verified reauthentication.
   * The same session row continues — same token, same cookie, same absolute
   * limit — because nothing about the session was ever wrong; the person had
   * merely stepped away.
   */
  private async reopenSession(input: {
    locked: LockedAdmin;
    method: StrongAuthMethod;
    authenticator?: { id: string; expectedSignCount: number; newSignCount: number };
    now: Date;
    requestId: string;
  }): Promise<AuthenticatedAdmin> {
    const { now, locked } = input;
    const idleCandidate = nextIdleExpiry(
      now,
      this.options.sessionWindows.idleTtlMilliseconds[locked.role]
    );
    const idleExpiresAt =
      idleCandidate > locked.hardExpiresAt ? locked.hardExpiresAt : idleCandidate;
    // The reauthentication refreshes step-up only when it used the role's
    // strong factor: a privileged password unlock reopens the dashboard, not
    // R2.
    const refreshesStepUp = strongAuthMethodForRole(locked.role) === input.method;

    let identity: {
      username: string;
      displayName: string;
      scopes: string[];
      lastStepUpAt: Date | null;
    };
    try {
      identity = await this.options.database.$transaction(async (transaction) => {
        const activeUser = await transaction.adminUser.updateMany({
          where: { id: locked.adminUserId, role: locked.role, status: "ACTIVE" },
          data: { updatedAt: now }
        });
        if (activeUser.count !== 1) throw new AdminCredentialStateChangedError();

        if (input.authenticator) {
          const authenticator = await transaction.adminAuthenticator.updateMany({
            where: {
              id: input.authenticator.id,
              adminUserId: locked.adminUserId,
              revokedAt: null,
              signCount: input.authenticator.expectedSignCount
            },
            data: { signCount: input.authenticator.newSignCount, lastUsedAt: now }
          });
          if (authenticator.count !== 1) throw new AdminCredentialStateChangedError();
        }

        // Only a session that is actually locked — idle passed, absolute not,
        // not revoked — can be reopened. An unlock raced by a revocation
        // loses.
        const session = await transaction.adminSession.updateMany({
          where: {
            id: locked.sessionId,
            adminUserId: locked.adminUserId,
            revokedAt: null,
            idleExpiresAt: { lte: now },
            hardExpiresAt: { gt: now }
          },
          data: {
            idleExpiresAt,
            lastSeenAt: now,
            ...(refreshesStepUp ? { lastStepUpAt: now } : {})
          }
        });
        if (session.count !== 1) throw new AdminCredentialStateChangedError();

        const user = await transaction.adminUser.findUnique({
          where: { id: locked.adminUserId },
          select: {
            username: true,
            displayName: true,
            kioskScopes: { where: { revokedAt: null }, select: { kioskId: true } },
            sessions: { where: { id: locked.sessionId }, select: { lastStepUpAt: true } }
          }
        });
        if (!user) throw new AdminCredentialStateChangedError();

        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: locked.adminUserId,
          action: "admin.session.unlock",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: {
            role: locked.role,
            method: input.method,
            sessionId: locked.sessionId,
            ...(input.authenticator ? { authenticatorId: input.authenticator.id } : {})
          }
        });

        return {
          username: user.username,
          displayName: user.displayName,
          scopes: user.kioskScopes.map((scope) => scope.kioskId),
          lastStepUpAt: user.sessions[0]?.lastStepUpAt ?? null
        };
      });
    } catch (error) {
      if (!(error instanceof AdminCredentialStateChangedError)) throw error;
      await this.auditFailure(locked.adminUserId, "admin.session.unlock", input.requestId, now, {
        role: locked.role,
        failureCode: "SESSION_STATE_CHANGED"
      });
      throw unlockFailed();
    }

    return {
      adminUserId: locked.adminUserId,
      username: identity.username,
      displayName: identity.displayName,
      role: locked.role,
      sessionId: locked.sessionId,
      idleExpiresAt,
      hardExpiresAt: locked.hardExpiresAt,
      lastStepUpAt: identity.lastStepUpAt,
      kioskScopes: identity.scopes
    };
  }

  private async resolveLiveInvitation(code: string, requestId: string) {
    const now = this.options.clock.now();
    const invitation = await this.options.database.adminInvitation.findUnique({
      where: { secretDigest: digestInvitationSecret(code, this.options.breakGlassPepper) },
      include: {
        adminUser: {
          include: {
            password: { select: { adminUserId: true } },
            authenticators: { where: { revokedAt: null }, select: { credentialId: true } }
          }
        }
      }
    });

    if (
      !invitation ||
      invitation.consumedAt ||
      invitation.revokedAt ||
      now.getTime() >= invitation.expiresAt.getTime() ||
      asStatus(invitation.adminUser.status) !== "PROVISIONING"
    ) {
      await this.auditAnonymousFailure(
        "admin.invitation.redeem",
        requestId,
        now,
        "INVITATION_CODE_INVALID"
      );
      throw invitationInvalid();
    }

    return invitation;
  }

  private async storeChallenge(
    purpose: "REGISTRATION" | "AUTHENTICATION" | "STEP_UP" | "UNLOCK" | "INVITATION_REGISTRATION",
    challenge: string,
    adminUserId: string | null
  ): Promise<string> {
    const now = this.options.clock.now();
    const id = this.options.random.uuid(now);
    await this.options.database.adminWebAuthnChallenge.create({
      data: {
        id,
        purpose,
        challenge,
        ...(adminUserId ? { adminUserId } : {}),
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.options.challengeTtlMilliseconds)
      }
    });
    return id;
  }

  /**
   * Claim a ceremony exactly once.
   *
   * The conditional update is the whole point: two concurrent requests
   * presenting the same ceremony cannot both proceed, so a captured challenge
   * cannot be replayed even in the moment before it expires.
   */
  private async consumeChallenge(
    ceremonyId: string,
    purpose: string,
    now: Date,
    expectedAdminUserId?: string
  ): Promise<{ challenge: string; adminUserId: string | null }> {
    const claimed = await this.options.database.adminWebAuthnChallenge.updateMany({
      where: {
        id: ceremonyId,
        purpose,
        consumedAt: null,
        expiresAt: { gt: now },
        ...(expectedAdminUserId ? { adminUserId: expectedAdminUserId } : {})
      },
      data: { consumedAt: now }
    });
    if (claimed.count !== 1) throw ceremonyExpired();

    const challenge = await this.options.database.adminWebAuthnChallenge.findUnique({
      where: { id: ceremonyId },
      select: { challenge: true, adminUserId: true }
    });
    if (!challenge) throw ceremonyExpired();
    return { challenge: challenge.challenge, adminUserId: challenge.adminUserId };
  }

  private async auditFailure(
    actorId: string,
    action: string,
    requestId: string,
    now: Date,
    metadata: Record<string, string | number | boolean | null>
  ): Promise<void> {
    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId,
      action,
      outcome: "FAILURE",
      requestId,
      metadata
    });
  }

  private async auditAnonymousFailure(
    action: string,
    requestId: string,
    now: Date,
    failureCode: string
  ): Promise<void> {
    await writeAdminAuditEvent(this.options.database, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: ANONYMOUS_ADMIN_ACTOR_ID,
      action,
      outcome: "FAILURE",
      requestId,
      metadata: { failureCode }
    });
  }
}

function asRole(value: string): AdminRole {
  if (!isAdminRole(value)) throw new Error("ADMIN_ROLE_INVALID");
  return value;
}

function asStatus(value: string): AdminUserStatus {
  if (!isAdminUserStatus(value)) throw new Error("ADMIN_STATUS_INVALID");
  return value;
}

function isRecoveryEligibleStatus(status: AdminUserStatus): boolean {
  return status === "PROVISIONING" || status === "ACTIVE";
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * One message for every login failure. Distinguishing "no such account" from
 * "wrong password" or "wrong account state" would tell an attacker which
 * guesses were close.
 */
function authenticationFailed(): ApiError {
  return new ApiError(401, "ADMIN_AUTHENTICATION_FAILED", "Authentication failed.");
}

function stepUpFailed(): ApiError {
  return new ApiError(401, "ADMIN_STEP_UP_FAILED", "Confirmation failed.");
}

function unlockFailed(): ApiError {
  return new ApiError(401, "ADMIN_UNLOCK_FAILED", "Unlock failed.");
}

/**
 * Every way an invitation can fail says the same thing. Wrong code, expired
 * code, spent code, revoked code, account already active — one message,
 * because the differences are exactly what somebody holding a stolen code
 * would like to learn.
 */
function invitationInvalid(): ApiError {
  return new ApiError(
    401,
    "ADMIN_INVITATION_INVALID",
    "This invitation code is not valid. Ask for a new one."
  );
}

function resetInvalid(): ApiError {
  return new ApiError(
    401,
    "ADMIN_RESET_INVALID",
    "This reset code is not valid. Ask for a new one."
  );
}

function recoveryFailed(): ApiError {
  return new ApiError(401, "ADMIN_RECOVERY_FAILED", "Recovery failed.");
}

function mutationAuthorizationFailed(): ApiError {
  return new ApiError(401, "ADMIN_AUTHENTICATION_REQUIRED", "Sign in to continue.");
}

function ceremonyExpired(): ApiError {
  return new ApiError(400, "ADMIN_CEREMONY_EXPIRED", "This request expired. Please try again.");
}
