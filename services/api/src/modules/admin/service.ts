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
      expectedSignCount: stored.signCount,
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
          metadata: { role: input.admin.role, authenticatorId: stored.id }
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

  // -------------------------------------------------------------------------
  // Enrolment
  // -------------------------------------------------------------------------

  /**
   * Begin enrolling an authenticator onto an account.
   *
   * `targetAdminUserId` is the account being enrolled onto. Phase 1 exposes
   * self-enrolment only; cross-account enrolment needs its own service contract
   * when Operator administration arrives.
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
    )
  ): Promise<{ authenticatorId: string; activated: boolean }> {
    const now = this.options.clock.now();
    const purpose = input.purpose ?? "REGISTRATION";
    const isBreakGlass = purpose === "BREAK_GLASS_REGISTRATION";
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

    if (
      (isBreakGlass && !isRecoveryEligibleStatus(status)) ||
      (!isBreakGlass && status !== "ACTIVE")
    ) {
      await this.auditFailure(
        input.actorAdminUserId,
        "admin.authenticator.enrol",
        input.requestId,
        now,
        { role, targetAdminUserId: input.targetAdminUserId, failureCode: "ACCOUNT_" + status }
      );
      throw isBreakGlass ? recoveryFailed() : mutationAuthorizationFailed();
    }

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

    try {
      await this.options.database.$transaction(async (transaction) => {
        // Registration and activation are one account-level state transition.
        // Serialising on the owner row prevents two first-key ceremonies from
        // each counting only their own insert and leaving a two-key account stuck
        // in PROVISIONING. The status/role predicate is also the final authority:
        // authorization may have raced with suspension, disablement or a role
        // change after the route's earlier checks.
        const locked = await transaction.adminUser.updateMany({
          where: {
            id: input.targetAdminUserId,
            role,
            status: isBreakGlass ? { in: ["PROVISIONING", "ACTIVE"] } : "ACTIVE"
          },
          data: { updatedAt: now }
        });
        if (locked.count !== 1) throw new AdminCredentialStateChangedError();

        // Ordinary enrolment is self-management in Phase 1. Locking the live
        // session in the same transaction means a logout/suspension that wins
        // this race prevents the key change. Recovery deliberately has no
        // session and is restricted by the account-status predicate above.
        if (!isBreakGlass) {
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

        const lockedUser = await transaction.adminUser.findUnique({
          where: { id: input.targetAdminUserId },
          select: { role: true, status: true }
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
        if (evaluateActivation(lockedRole, lockedStatus, usable).allowed) {
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
      throw isBreakGlass ? recoveryFailed() : mutationAuthorizationFailed();
    }

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
      // the required spare by creating another credential for this RP.
      existingCredentialIds: user.authenticators.map((entry) => entry.credentialId),
      requireCrossPlatform: role === "TECHNICAL_ADMIN"
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
    const now = this.options.clock.now();
    const session = await this.options.database.adminSession.findFirst({
      // Re-check liveness while binding the token. This closes the ordinary
      // race where logout or suspension commits after initial session
      // resolution but before a mutating request reaches its CSRF check.
      where: {
        id: sessionId,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        hardExpiresAt: { gt: now }
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
    admin: AuthenticatedAdmin;
    reason: string;
    requestId: string;
  }): Promise<void> {
    const now = this.options.clock.now();
    await this.options.database.$transaction(async (transaction) => {
      const revoked = await transaction.adminSession.updateMany({
        where: { id: input.admin.sessionId, revokedAt: null },
        data: { revokedAt: now, revokedReason: input.reason.slice(0, 48) }
      });
      // Logout is idempotent. A concurrent duplicate still succeeds and clears
      // its cookies, but only the request that changed state records SUCCESS.
      if (revoked.count !== 1) return;
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
    expectedSignCount: number;
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
        const authenticator = await transaction.adminAuthenticator.updateMany({
          where: {
            id: input.authenticatorId,
            adminUserId: input.adminUserId,
            revokedAt: null,
            signCount: input.expectedSignCount
          },
          data: { signCount: input.newSignCount, lastUsedAt: now }
        });
        if (authenticator.count !== 1) throw new AdminCredentialStateChangedError();

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
        await writeAdminAuditEvent(transaction, {
          id: this.options.random.uuid(now),
          occurredAt: now,
          actorId: input.adminUserId,
          action: "admin.authentication",
          outcome: "SUCCESS",
          requestId: input.requestId,
          metadata: { role: input.role, authenticatorId: input.authenticatorId, sessionId }
        });
        // Keep every database operation needed to return the new identity in
        // this transaction. If scope loading fails, no unreachable live session
        // is committed after the one-time ceremony has been consumed.
        return transaction.adminKioskScope.findMany({
          where: { adminUserId: input.adminUserId },
          select: { kioskId: true }
        });
      });
    } catch (error) {
      if (!(error instanceof AdminCredentialStateChangedError)) throw error;
      await this.auditFailure(input.adminUserId, "admin.authentication", input.requestId, now, {
        role: input.role,
        authenticatorId: input.authenticatorId,
        failureCode: "CREDENTIAL_STATE_CHANGED"
      });
      throw authenticationFailed();
    }

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

function isRecoveryEligibleStatus(status: AdminUserStatus): boolean {
  return status === "PROVISIONING" || status === "ACTIVE";
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

function recoveryFailed(): ApiError {
  return new ApiError(401, "ADMIN_RECOVERY_FAILED", "Recovery failed.");
}

function mutationAuthorizationFailed(): ApiError {
  return new ApiError(401, "ADMIN_AUTHENTICATION_REQUIRED", "Sign in to continue.");
}

function ceremonyExpired(): ApiError {
  return new ApiError(400, "ADMIN_CEREMONY_EXPIRED", "This request expired. Please try again.");
}
