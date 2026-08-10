import {
  canRevokeAuthenticator,
  canAuthenticate,
  evaluateActivation,
  evaluateAuthenticatorPolicy,
  evaluateSession,
  isAdminRole,
  isAdminUserStatus,
  minimumAuthenticators,
  nextIdleExpiry,
  type AdminRole,
  type AdminUserStatus,
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
  digestsMatch
} from "./crypto.js";
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
 * are, proving it again before a sensitive action, enrolling and retiring
 * authenticators, and the sealed way back in when every key is gone.
 *
 * Three rules run through all of it. A failure never says why in a way that
 * distinguishes "no such account" from "wrong key", because that difference is
 * an enumeration oracle. Every outcome is audited, including the refusals.
 * And nothing here reads or returns anything about a customer — this module
 * touches no session, document, payment or print row at all.
 */

const SESSION_TOKEN_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;
const USER_HANDLE_BYTES = 32;

export interface AdminSessionCookiePair {
  sessionToken: string;
  csrfToken: string;
  idleExpiresAt: Date;
  hardExpiresAt: Date;
}

export interface AdminServiceOptions {
  database: PrismaClient;
  clock: Clock;
  random: RandomSource;
  relyingParty: WebAuthnRelyingParty;
  sessionPepper: string;
  breakGlassPepper: string;
  idleTtlMilliseconds: number;
  absoluteTtlMilliseconds: number;
  challengeTtlMilliseconds: number;
}

export interface AuthenticatedAdmin {
  adminUserId: string;
  displayName: string;
  role: AdminRole;
  sessionId: string;
  idleExpiresAt: Date;
  hardExpiresAt: Date;
  lastStepUpAt: Date | null;
  kioskScopes: readonly string[];
}

export class AdminService {
  public constructor(private readonly options: AdminServiceOptions) {}

  // -------------------------------------------------------------------------
  // Ceremonies
  // -------------------------------------------------------------------------

  /**
   * Begin a login. No account is named: the credential is discoverable, so the
   * authenticator decides which identity to assert and the server learns it
   * only from a verified signature. There is nothing here to enumerate.
   */
  public async beginAuthentication(): Promise<{ ceremonyId: string; options: unknown }> {
    const options = await createAuthenticationOptions({
      relyingParty: this.options.relyingParty,
      allowCredentialIds: []
    });
    const ceremonyId = await this.storeChallenge("AUTHENTICATION", options.challenge, null);
    return { ceremonyId, options };
  }

  /**
   * Finish a login. Returns the tokens for the caller to set as cookies; the
   * service never touches the reply itself, so cookie policy stays in one place
   * in the route layer.
   */
  public async completeAuthentication(input: {
    ceremonyId: string;
    credential: WebAuthnCredential;
    requestId: string;
  }): Promise<{ admin: AuthenticatedAdmin; cookies: AdminSessionCookiePair }> {
    const now = this.options.clock.now();
    const challenge = await this.consumeChallenge(input.ceremonyId, "AUTHENTICATION", now);

    const stored = await this.options.database.adminAuthenticator.findUnique({
      where: { credentialId: input.credential.id },
      include: { adminUser: true }
    });

    if (!stored || stored.revokedAt) {
      await this.auditAnonymousFailure(
        "admin.authentication",
        input.requestId,
        now,
        "UNKNOWN_CREDENTIAL"
      );
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
      expectedChallenge: challenge,
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
      displayName: stored.adminUser.displayName,
      role,
      authenticatorId: stored.id,
      newSignCount: verified.newSignCount,
      now,
      requestId: input.requestId
    });
  }

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
      expectedChallenge: challenge,
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

    await this.options.database.$transaction(async (transaction) => {
      await transaction.adminAuthenticator.update({
        where: { id: stored.id },
        data: { signCount: verified.newSignCount, lastUsedAt: now }
      });
      await transaction.adminSession.update({
        where: { id: input.admin.sessionId },
        data: { lastStepUpAt: now, lastSeenAt: now }
      });
      await writeAdminAuditEvent(transaction, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: input.admin.adminUserId,
        action: "admin.step_up",
        outcome: "SUCCESS",
        requestId: input.requestId,
        metadata: { role: input.admin.role, authenticatorId: stored.id }
      });
    });

    return now;
  }

  // -------------------------------------------------------------------------
  // Enrolment
  // -------------------------------------------------------------------------

  /**
   * Begin enrolling an authenticator onto an account.
   *
   * `targetAdminUserId` is the account being enrolled onto. A caller may always
   * enrol onto themselves; enrolling onto someone else is an Admin capability
   * restricted to Operators, checked by the route before this is reached.
   */
  public async beginRegistration(
    targetAdminUserId: string
  ): Promise<{ ceremonyId: string; options: unknown }> {
    const user = await this.options.database.adminUser.findUnique({
      where: { id: targetAdminUserId },
      include: { authenticators: { where: { revokedAt: null }, select: { credentialId: true } } }
    });
    if (!user) throw new ApiError(404, "ADMIN_USER_NOT_FOUND", "Account not found.");

    const role = asRole(user.role);
    const options = await createRegistrationOptions({
      relyingParty: this.options.relyingParty,
      userHandle: new Uint8Array(user.userHandle),
      displayName: user.displayName,
      existingCredentialIds: user.authenticators.map((entry) => entry.credentialId),
      // Asking the browser for a roaming key is a hint, not a guarantee. The
      // answer is checked again below and once more by a database trigger.
      requireCrossPlatform: role === "TECHNICAL_ADMIN"
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
   * An account still PROVISIONING is activated here once it reaches its
   * minimum, which is what makes PROVISIONING the only state in which fewer
   * than two usable authenticators exist.
   */
  public async completeRegistration(input: {
    targetAdminUserId: string;
    actorAdminUserId: string;
    ceremonyId: string;
    credential: WebAuthnCredential;
    label: string;
    requestId: string;
    purpose?: "REGISTRATION" | "BREAK_GLASS_REGISTRATION";
  }): Promise<{ authenticatorId: string; activated: boolean }> {
    const now = this.options.clock.now();
    const purpose = input.purpose ?? "REGISTRATION";
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

    const verified = await verifyRegistration({
      relyingParty: this.options.relyingParty,
      expectedChallenge: challenge,
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

    // The device-bound rule for Technical Admins, checked against what the
    // authenticator actually reported rather than what we asked for.
    const policy = evaluateAuthenticatorPolicy(role, {
      attachment: verified.attachment,
      backupEligible: verified.backupEligible,
      backedUp: verified.backedUp
    });
    if (!policy.allowed) {
      await this.auditFailure(
        input.actorAdminUserId,
        "admin.authenticator.enrol",
        input.requestId,
        now,
        {
          role,
          targetAdminUserId: input.targetAdminUserId,
          failureCode: policy.reason
        }
      );
      throw new ApiError(
        422,
        "ADMIN_AUTHENTICATOR_NOT_PERMITTED",
        "This role requires a device-bound hardware security key."
      );
    }

    const authenticatorId = this.options.random.uuid(now);
    let activated = false;

    await this.options.database.$transaction(async (transaction) => {
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
      if (evaluateActivation(role, status, usable).allowed) {
        await transaction.adminUser.update({
          where: { id: input.targetAdminUserId },
          data: { status: "ACTIVE", activatedAt: now }
        });
        activated = true;
      }

      await writeAdminAuditEvent(transaction, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: input.actorAdminUserId,
        action: "admin.authenticator.enrol",
        outcome: "SUCCESS",
        requestId: input.requestId,
        metadata: {
          role,
          targetAdminUserId: input.targetAdminUserId,
          authenticatorId,
          authenticatorLabel: input.label,
          ceremonyPurpose: purpose,
          resultingState: activated ? "ACTIVE" : status
        }
      });
    });

    return { authenticatorId, activated };
  }

  /**
   * Retire an authenticator.
   *
   * Refused when it would take an active account below its minimum: the
   * replacement is enrolled first. A database trigger refuses the same thing,
   * so a future code path cannot skip this.
   */
  public async revokeAuthenticator(input: {
    admin: AuthenticatedAdmin;
    targetAdminUserId: string;
    authenticatorId: string;
    reason: string;
    requestId: string;
  }): Promise<void> {
    const now = this.options.clock.now();
    const user = await this.options.database.adminUser.findUnique({
      where: { id: input.targetAdminUserId },
      include: { authenticators: { where: { revokedAt: null }, select: { id: true } } }
    });
    if (!user) throw new ApiError(404, "ADMIN_USER_NOT_FOUND", "Account not found.");

    const owns = user.authenticators.some((entry) => entry.id === input.authenticatorId);
    if (!owns) {
      throw new ApiError(404, "ADMIN_AUTHENTICATOR_NOT_FOUND", "Authenticator not found.");
    }

    const role = asRole(user.role);
    if (!canRevokeAuthenticator(role, asStatus(user.status), user.authenticators.length)) {
      await this.auditFailure(
        input.admin.adminUserId,
        "admin.authenticator.revoke",
        input.requestId,
        now,
        {
          role,
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

    await this.options.database.$transaction(async (transaction) => {
      await transaction.adminAuthenticator.update({
        where: { id: input.authenticatorId },
        data: { revokedAt: now, revokedReason: input.reason.slice(0, 48) }
      });
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
  }

  // -------------------------------------------------------------------------
  // Break-glass
  // -------------------------------------------------------------------------

  /**
   * Consume a sealed recovery credential to authorise one enrolment.
   *
   * This is the only path that does not begin with an authenticator, and it is
   * deliberately narrow: it starts a registration ceremony for one named
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
      include: { adminUser: true }
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
      throw new ApiError(401, "ADMIN_RECOVERY_FAILED", "Recovery failed.");
    }

    const user = credential.adminUser;
    const role = asRole(user.role);
    const options = await createRegistrationOptions({
      relyingParty: this.options.relyingParty,
      userHandle: new Uint8Array(user.userHandle),
      displayName: user.displayName,
      existingCredentialIds: [],
      requireCrossPlatform: role === "TECHNICAL_ADMIN"
    });

    const ceremonyId = this.options.random.uuid(now);
    await this.options.database.$transaction(async (transaction) => {
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
      await transaction.adminBreakGlassCredential.update({
        where: { id: credential.id },
        data: { consumedAt: now }
      });
      await writeAdminAuditEvent(transaction, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: user.id,
        action: "admin.break_glass",
        outcome: "SUCCESS",
        requestId: input.requestId,
        metadata: { role, targetAdminUserId: user.id, ceremonyPurpose: "BREAK_GLASS_REGISTRATION" }
      });
    });

    return { ceremonyId, options, adminUserId: user.id };
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /**
   * Resolve a request's session cookie to an identity, or null.
   *
   * Every admin request goes through this, so revocation and expiry take effect
   * immediately rather than waiting for a sweep. The idle window is rolled
   * forward here too, at most once a minute, so a busy session does not write a
   * row on every request.
   */
  public async resolveSession(sessionToken: string): Promise<AuthenticatedAdmin | null> {
    const now = this.options.clock.now();
    const session = await this.options.database.adminSession.findUnique({
      where: { tokenDigest: digestAdminSessionToken(sessionToken, this.options.sessionPepper) },
      include: { adminUser: { include: { kioskScopes: { select: { kioskId: true } } } } }
    });
    if (!session) return null;

    if (!evaluateSession(session, now).valid) return null;
    if (!canAuthenticate(asStatus(session.adminUser.status))) return null;

    const idleExpiresAt = nextIdleExpiry(now, this.options.idleTtlMilliseconds);
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
        data: { lastSeenAt: now, idleExpiresAt: nextIdle }
      });
    }

    return {
      adminUserId: session.adminUserId,
      displayName: session.adminUser.displayName,
      role: asRole(session.adminUser.role),
      sessionId: session.id,
      idleExpiresAt: shouldRefresh ? nextIdle : session.idleExpiresAt,
      hardExpiresAt: session.hardExpiresAt,
      lastStepUpAt: session.lastStepUpAt,
      kioskScopes: session.adminUser.kioskScopes.map((scope) => scope.kioskId)
    };
  }

  public async verifyCsrf(sessionId: string, presentedToken: string): Promise<boolean> {
    const session = await this.options.database.adminSession.findUnique({
      where: { id: sessionId },
      select: { csrfDigest: true }
    });
    if (!session) return false;
    return digestsMatch(
      session.csrfDigest,
      digestAdminCsrfToken(presentedToken, this.options.sessionPepper)
    );
  }

  public async revokeSession(input: {
    admin: AuthenticatedAdmin;
    reason: string;
    requestId: string;
  }): Promise<void> {
    const now = this.options.clock.now();
    await this.options.database.$transaction(async (transaction) => {
      await transaction.adminSession.updateMany({
        where: { id: input.admin.sessionId, revokedAt: null },
        data: { revokedAt: now, revokedReason: input.reason.slice(0, 48) }
      });
      await writeAdminAuditEvent(transaction, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: input.admin.adminUserId,
        action: "admin.logout",
        outcome: "SUCCESS",
        requestId: input.requestId,
        metadata: { role: input.admin.role, reason: input.reason }
      });
    });
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

  public async listAuthenticators(adminUserId: string, role: AdminRole) {
    const items = await this.options.database.adminAuthenticator.findMany({
      where: { adminUserId, revokedAt: null },
      orderBy: { createdAt: "asc" }
    });
    return { items, minimumRequired: minimumAuthenticators(role), usableCount: items.length };
  }

  /**
   * Create an account. Provisioning only: it has no authenticator yet, so it
   * cannot authenticate, and it stays that way until two are enrolled.
   */
  public async createAdminUser(input: {
    displayName: string;
    role: AdminRole;
    actorAdminUserId: string;
    requestId: string;
  }): Promise<{ adminUserId: string }> {
    const now = this.options.clock.now();
    const adminUserId = this.options.random.uuid(now);
    const userHandle = Buffer.from(
      this.options.random.token(USER_HANDLE_BYTES),
      "base64url"
    ).subarray(0, USER_HANDLE_BYTES);

    await this.options.database.$transaction(async (transaction) => {
      await transaction.adminUser.create({
        data: {
          id: adminUserId,
          userHandle,
          displayName: input.displayName,
          role: input.role,
          status: "PROVISIONING",
          createdAt: now
        }
      });
      await writeAdminAuditEvent(transaction, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: input.actorAdminUserId,
        action: "admin.account.create",
        outcome: "SUCCESS",
        requestId: input.requestId,
        metadata: {
          role: input.role,
          targetAdminUserId: adminUserId,
          resultingState: "PROVISIONING"
        }
      });
    });

    return { adminUserId };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async issueSession(input: {
    adminUserId: string;
    displayName: string;
    role: AdminRole;
    authenticatorId: string;
    newSignCount: number;
    now: Date;
    requestId: string;
  }): Promise<{ admin: AuthenticatedAdmin; cookies: AdminSessionCookiePair }> {
    const { now } = input;
    const sessionId = this.options.random.uuid(now);
    const sessionToken = this.options.random.token(SESSION_TOKEN_BYTES);
    const csrfToken = this.options.random.token(CSRF_TOKEN_BYTES);
    const hardExpiresAt = new Date(now.getTime() + this.options.absoluteTtlMilliseconds);
    const idleCandidate = nextIdleExpiry(now, this.options.idleTtlMilliseconds);
    const idleExpiresAt = idleCandidate > hardExpiresAt ? hardExpiresAt : idleCandidate;

    await this.options.database.$transaction(async (transaction) => {
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
          // Logging in is itself a fresh assertion, so a sensitive action taken
          // immediately after does not ask for the key twice.
          lastStepUpAt: now
        }
      });
      await transaction.adminAuthenticator.update({
        where: { id: input.authenticatorId },
        data: { signCount: input.newSignCount, lastUsedAt: now }
      });
      await transaction.adminUser.update({
        where: { id: input.adminUserId },
        data: { lastLoginAt: now }
      });
      await writeAdminAuditEvent(transaction, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: input.adminUserId,
        action: "admin.authentication",
        outcome: "SUCCESS",
        requestId: input.requestId,
        metadata: { role: input.role, authenticatorId: input.authenticatorId, sessionId }
      });
    });

    const scopes = await this.options.database.adminKioskScope.findMany({
      where: { adminUserId: input.adminUserId },
      select: { kioskId: true }
    });

    return {
      admin: {
        adminUserId: input.adminUserId,
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

  private async storeChallenge(
    purpose: "REGISTRATION" | "AUTHENTICATION" | "STEP_UP",
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
  ): Promise<string> {
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
      select: { challenge: true }
    });
    if (!challenge) throw ceremonyExpired();
    return challenge.challenge;
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

/**
 * One message for every login failure. Distinguishing "no such credential"
 * from "wrong account state" would tell an attacker which guesses were close.
 */
function authenticationFailed(): ApiError {
  return new ApiError(401, "ADMIN_AUTHENTICATION_FAILED", "Authentication failed.");
}

function stepUpFailed(): ApiError {
  return new ApiError(401, "ADMIN_STEP_UP_FAILED", "Confirmation failed.");
}

function ceremonyExpired(): ApiError {
  return new ApiError(400, "ADMIN_CEREMONY_EXPIRED", "This request expired. Please try again.");
}
