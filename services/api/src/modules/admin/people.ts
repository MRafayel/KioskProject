import {
  canRevokeAuthenticator,
  evaluateStatusTransition,
  isAdminUserStatus,
  revokesSessions,
  type AdminCapability,
  type ChangeAdminStatusBody,
  type KioskAssignmentBody,
  type RevokeAdminSessionsBody,
  type RevokeOperatorAuthenticatorBody
} from "@printing-kiosk/admin-access";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { writeAdminAuditEvent, type AdminAuditMetadataValue } from "./audit.js";
import { adminNotFound } from "./http.js";
import type { AdminPeopleDatabase, AdminPeopleTransaction } from "./people-database.js";
import type { AuthenticatedAdmin } from "./service.js";

/**
 * Administering the people who use the control plane.
 *
 * Kept in its own file, on its own connection, for the reason `refunds.ts` is:
 * this is the first surface that can change a row somebody's access depends on,
 * and everything shipped before it appends. A separation that amounted to two
 * handlers in one file would not be one.
 *
 * Four things this can do and four it cannot, which between them are the phase:
 *
 *   suspend, resume or disable an Operator      never change anybody's role
 *   assign a kiosk, or take one back            never delete the record of one
 *   end every session an Operator holds         never extend or issue one
 *   retire an Operator's security key           never enrol one
 *
 * The right-hand column is the interesting one, and none of it rests on this
 * file. `printing_kiosk_admin_people_writer` holds UPDATE on nine named columns
 * and `admin_users.role` is not among them; it holds no INSERT on
 * `admin_authenticators` or `admin_sessions`; and it holds no DELETE anywhere.
 * Creating an account — an invitation — is the identity service's act on the
 * application connection, behind its own capability and role matrix.
 *
 * **Every action here targets an Operator account and nothing else.** An Admin
 * cannot suspend another Admin, retire a Technical Admin's key, or end a peer's
 * session through this service — a target that is not an Operator answers 404,
 * the same way an unknown one does, so the panel cannot be used to discover who
 * holds which role. That is `operator.manage` being what its name says, and it
 * is also what stops two compromised Admin accounts from being able to lock
 * each other's colleagues out.
 */

/** How long a people action's transaction may hold the database. */
const PEOPLE_TRANSACTION_TIMEOUT_MILLISECONDS = 5_000;

/** `admin_sessions.revoked_reason` and its authenticator sibling are VARCHAR(48). */
const REVOCATION_REASON_LIMIT = 48;

export interface AdminPeopleServiceOptions {
  database: AdminPeopleDatabase;
  clock: Clock;
  random: RandomSource;
}

export interface ChangeStatusResult {
  targetAdminUserId: string;
  previousStatus: string;
  status: string;
  revokedSessions: number;
}

export interface KioskAssignmentResult {
  targetAdminUserId: string;
  kioskId: string;
  granted: boolean;
  /** False when the assignment was already in the state that was asked for. */
  changed: boolean;
}

export interface RevokeSessionsResult {
  targetAdminUserId: string;
  revokedSessions: number;
}

export interface RevokeAuthenticatorResult {
  targetAdminUserId: string;
  authenticatorId: string;
  usableAuthenticators: number;
}

export class AdminPeopleService {
  public constructor(private readonly options: AdminPeopleServiceOptions) {}

  /**
   * Suspend somebody, give their access back, or shut an account down.
   *
   * The transition rule is shared with the account CLI through
   * `evaluateStatusTransition`, and a database trigger enforces the same thing a
   * third time. Three layers for one rule looks excessive until you notice what
   * the rule prevents: `ACTIVE → PROVISIONING` would put a working account back
   * into the only state in which it may hold fewer keys than its role requires,
   * and `DISABLED → ACTIVE` would make a shut-down identity switchable back on
   * without anybody enrolling anything.
   *
   * Anything other than resuming ends every live session in the same
   * transaction. Suspending somebody whose browser tab keeps working is not
   * suspending them.
   */
  public async changeStatus(
    admin: AuthenticatedAdmin,
    targetAdminUserId: string,
    body: ChangeAdminStatusBody,
    requestId: string
  ): Promise<ChangeStatusResult> {
    const now = this.options.clock.now();

    try {
      return await this.options.database.$transaction(
        async (transaction) => {
          const target = await this.lockOperator(transaction, targetAdminUserId, now, {
            action: "admin.people.status",
            reason: body.reason
          });

          const currentStatus = target.status;
          const decision = evaluateStatusTransition(currentStatus, body.status, target.activatedAt);
          if (!decision.allowed) {
            throw new RefusedPeopleAction(statusTransitionError(decision.reason, body.status), {
              failureCode: decision.reason,
              reason: body.reason,
              targetAdminUserId,
              previousState: currentStatus,
              resultingState: body.status
            });
          }

          // Conditional on the status the decision was made against. A
          // concurrent change — another Admin, or the account activating itself
          // by enrolling — loses here rather than being silently overwritten.
          const changed = await transaction.adminUser.updateMany({
            where: { id: targetAdminUserId, role: "OPERATOR", status: currentStatus },
            data: {
              status: body.status,
              updatedAt: now,
              ...(body.status === "SUSPENDED" ? { suspendedAt: now } : {}),
              ...(body.status === "DISABLED" ? { disabledAt: now } : {})
            }
          });
          if (changed.count !== 1) {
            throw new RefusedPeopleAction(concurrentChange(), {
              failureCode: "ACCOUNT_STATE_CHANGED",
              reason: body.reason,
              targetAdminUserId,
              previousState: currentStatus,
              resultingState: body.status
            });
          }

          const revokedSessions = revokesSessions(body.status)
            ? await this.endSessions(transaction, targetAdminUserId, now, `ACCOUNT_${body.status}`)
            : 0;

          await writeAdminAuditEvent(transaction, {
            id: this.options.random.uuid(now),
            occurredAt: now,
            actorId: admin.adminUserId,
            action: "admin.people.status",
            outcome: "SUCCESS",
            requestId,
            metadata: {
              role: admin.role,
              targetAdminUserId,
              targetRole: target.role,
              reason: body.reason,
              previousState: currentStatus,
              resultingState: body.status,
              revokedSessions
            }
          });

          return {
            targetAdminUserId,
            previousStatus: currentStatus,
            status: body.status,
            revokedSessions
          };
        },
        { timeout: PEOPLE_TRANSACTION_TIMEOUT_MILLISECONDS }
      );
    } catch (error) {
      throw await this.refuse(admin, requestId, now, "admin.people.status", error);
    }
  }

  /**
   * Decide which kiosks an Operator may act on.
   *
   * Not a capability change — an Operator holds `print.recovery.resolve`
   * everywhere or nowhere — but a real widening of what they can reach, so it
   * carries the same risk class and the same step-up as suspending them.
   *
   * Taking a kiosk away sets `revokedAt` rather than deleting the row, and
   * giving it back clears the same column on the same row. The primary key is
   * still `(person, kiosk)`, so there is never a second row disagreeing about
   * whether the assignment is live, and "who could act on kiosk 4 last March"
   * stays answerable from the audit log rather than from a row that no longer
   * exists.
   */
  public async assignKiosk(
    admin: AuthenticatedAdmin,
    targetAdminUserId: string,
    body: KioskAssignmentBody,
    requestId: string
  ): Promise<KioskAssignmentResult> {
    const now = this.options.clock.now();

    try {
      return await this.options.database.$transaction(
        async (transaction) => {
          const target = await this.lockOperator(transaction, targetAdminUserId, now, {
            action: "admin.people.kiosk",
            reason: body.reason
          });

          const kiosk = await transaction.kiosk.findUnique({
            where: { id: body.kioskId },
            select: { id: true }
          });
          if (!kiosk) {
            throw new RefusedPeopleAction(
              new ApiError(404, "KIOSK_NOT_FOUND", "That kiosk does not exist."),
              {
                failureCode: "KIOSK_NOT_FOUND",
                reason: body.reason,
                targetAdminUserId,
                kioskAssigned: body.granted
              }
            );
          }

          const changed = body.granted
            ? await this.grantScope(transaction, targetAdminUserId, body.kioskId, now)
            : await this.revokeScope(transaction, targetAdminUserId, body.kioskId, now);

          await writeAdminAuditEvent(transaction, {
            id: this.options.random.uuid(now),
            occurredAt: now,
            actorId: admin.adminUserId,
            action: "admin.people.kiosk",
            outcome: "SUCCESS",
            requestId,
            kioskId: body.kioskId,
            metadata: {
              role: admin.role,
              targetAdminUserId,
              targetRole: target.role,
              reason: body.reason,
              kioskAssigned: body.granted,
              // A repeat of an assignment that is already in place is recorded
              // as what it was — somebody asked, nothing moved — rather than as
              // a second grant.
              resultingState: changed ? "CHANGED" : "UNCHANGED"
            }
          });

          return {
            targetAdminUserId,
            kioskId: body.kioskId,
            granted: body.granted,
            changed
          };
        },
        { timeout: PEOPLE_TRANSACTION_TIMEOUT_MILLISECONDS }
      );
    } catch (error) {
      throw await this.refuse(admin, requestId, now, "admin.people.kiosk", error);
    }
  }

  /**
   * Sign an Operator out everywhere, without changing their account.
   *
   * The one action here that is reversible by the person it happened to: they
   * sign in again with a key they still hold. It exists for the case that is not
   * yet a suspension — a laptop left on a train, a session somebody does not
   * recognise — where waiting to be sure is the expensive option.
   */
  public async revokeSessions(
    admin: AuthenticatedAdmin,
    targetAdminUserId: string,
    body: RevokeAdminSessionsBody,
    requestId: string
  ): Promise<RevokeSessionsResult> {
    const now = this.options.clock.now();

    try {
      return await this.options.database.$transaction(
        async (transaction) => {
          const target = await this.lockOperator(transaction, targetAdminUserId, now, {
            action: "admin.people.sessions.revoke",
            reason: body.reason
          });

          const revokedSessions = await this.endSessions(
            transaction,
            targetAdminUserId,
            now,
            "ADMIN_REVOKED"
          );

          await writeAdminAuditEvent(transaction, {
            id: this.options.random.uuid(now),
            occurredAt: now,
            actorId: admin.adminUserId,
            action: "admin.people.sessions.revoke",
            outcome: "SUCCESS",
            requestId,
            metadata: {
              role: admin.role,
              targetAdminUserId,
              targetRole: target.role,
              reason: body.reason,
              revokedSessions
            }
          });

          return { targetAdminUserId, revokedSessions };
        },
        { timeout: PEOPLE_TRANSACTION_TIMEOUT_MILLISECONDS }
      );
    } catch (error) {
      throw await this.refuse(admin, requestId, now, "admin.people.sessions.revoke", error);
    }
  }

  /**
   * Retire one of an Operator's security keys.
   *
   * Refused when it would take an active account below the minimum its role
   * requires — the replacement is enrolled first, and only then is the lost key
   * removed. Doing it the other way round is how somebody ends up locked out of
   * the control plane during the incident they were needed for, and there is no
   * password to fall back on by design.
   *
   * A database trigger refuses the same thing, so this check is the one that
   * produces a message a person can act on rather than the one that makes the
   * rule true.
   */
  public async revokeAuthenticator(
    admin: AuthenticatedAdmin,
    targetAdminUserId: string,
    authenticatorId: string,
    body: RevokeOperatorAuthenticatorBody,
    requestId: string
  ): Promise<RevokeAuthenticatorResult> {
    const now = this.options.clock.now();

    try {
      return await this.options.database.$transaction(
        async (transaction) => {
          const target = await this.lockOperator(transaction, targetAdminUserId, now, {
            action: "admin.people.authenticator.revoke",
            reason: body.reason
          });

          const usable = await transaction.adminAuthenticator.findMany({
            where: { adminUserId: targetAdminUserId, revokedAt: null },
            select: { id: true }
          });

          if (!usable.some((entry) => entry.id === authenticatorId)) {
            throw new RefusedPeopleAction(
              new ApiError(404, "ADMIN_AUTHENTICATOR_NOT_FOUND", "Authenticator not found."),
              {
                failureCode: "KEY_NOT_FOUND",
                reason: body.reason,
                targetAdminUserId,
                authenticatorId
              }
            );
          }

          if (!canRevokeAuthenticator(target.role, target.status, usable.length)) {
            throw new RefusedPeopleAction(
              new ApiError(
                409,
                "ADMIN_AUTHENTICATOR_LAST_SPARE",
                "Enrol a replacement before retiring this key."
              ),
              {
                failureCode: "WOULD_LEAVE_NO_SPARE",
                reason: body.reason,
                targetAdminUserId,
                authenticatorId,
                usableAuthenticators: usable.length
              }
            );
          }

          const revoked = await transaction.adminAuthenticator.updateMany({
            where: { id: authenticatorId, adminUserId: targetAdminUserId, revokedAt: null },
            data: { revokedAt: now, revokedReason: "ADMIN_REVOKED" }
          });
          if (revoked.count !== 1) {
            throw new RefusedPeopleAction(concurrentChange(), {
              failureCode: "KEY_STATE_CHANGED",
              reason: body.reason,
              targetAdminUserId,
              authenticatorId
            });
          }

          await writeAdminAuditEvent(transaction, {
            id: this.options.random.uuid(now),
            occurredAt: now,
            actorId: admin.adminUserId,
            action: "admin.people.authenticator.revoke",
            outcome: "SUCCESS",
            requestId,
            metadata: {
              role: admin.role,
              targetAdminUserId,
              targetRole: target.role,
              authenticatorId,
              reason: body.reason,
              usableAuthenticators: usable.length - 1
            }
          });

          return {
            targetAdminUserId,
            authenticatorId,
            usableAuthenticators: usable.length - 1
          };
        },
        { timeout: PEOPLE_TRANSACTION_TIMEOUT_MILLISECONDS }
      );
    } catch (error) {
      throw await this.refuse(admin, requestId, now, "admin.people.authenticator.revoke", error);
    }
  }

  /**
   * Record that somebody without the capability tried a people action.
   *
   * The same argument the money route makes, and the second place in the
   * control plane that makes it: most capability refusals are uninteresting
   * noise, but an account asking to suspend a colleague is worth a permanent
   * row whatever else it is. Failures are swallowed — the request is refused
   * either way, and a 500 would tell a prober they hit something.
   */
  public async recordForbiddenAttempt(
    admin: AuthenticatedAdmin,
    capability: AdminCapability,
    action: string,
    requestId: string
  ): Promise<void> {
    const now = this.options.clock.now();
    try {
      await writeAdminAuditEvent(this.options.database, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: admin.adminUserId,
        action,
        outcome: "DENIED",
        requestId,
        metadata: { role: admin.role, capability, failureCode: "CAPABILITY_NOT_HELD" }
      });
    } catch {
      // See above.
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Take the owner row and confirm the target is somebody this service may act
   * on at all.
   *
   * Every identity mutation in this system locks `admin_users` first, and this
   * keeps that order: a status change, a key revocation and a ticket issuance
   * racing each other then serialise on one row rather than each reading a
   * world the others are in the middle of changing.
   *
   * A target that is not an Operator answers 404, exactly as an unknown one
   * does. The panel is not a way to find out who the Technical Admins are.
   */
  private async lockOperator(
    transaction: AdminPeopleTransaction,
    targetAdminUserId: string,
    now: Date,
    context: { action: string; reason: string }
  ): Promise<{
    role: "OPERATOR";
    status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "DISABLED";
    displayName: string;
    activatedAt: Date | null;
  }> {
    // `updateMany` on a column the role may write is how this connection takes
    // a row lock: there is no `SELECT ... FOR UPDATE` on a narrowed client, and
    // touching `updated_at` is a change the audit event beside it explains.
    const locked = await transaction.adminUser.updateMany({
      where: { id: targetAdminUserId, role: "OPERATOR" },
      data: { updatedAt: now }
    });
    if (locked.count !== 1) {
      throw new RefusedPeopleAction(adminNotFound(), {
        failureCode: "TARGET_NOT_AN_OPERATOR",
        reason: context.reason,
        targetAdminUserId
      });
    }

    const person = await transaction.adminUser.findUnique({
      where: { id: targetAdminUserId },
      select: { role: true, status: true, displayName: true, activatedAt: true }
    });
    if (!person || person.role !== "OPERATOR" || !isAdminUserStatus(person.status)) {
      throw new RefusedPeopleAction(adminNotFound(), {
        failureCode: "TARGET_NOT_AN_OPERATOR",
        reason: context.reason,
        targetAdminUserId
      });
    }

    return {
      role: "OPERATOR",
      status: person.status,
      displayName: person.displayName,
      activatedAt: person.activatedAt
    };
  }

  /** End every session that is still worth ending. Returns how many there were. */
  private async endSessions(
    transaction: AdminPeopleTransaction,
    targetAdminUserId: string,
    now: Date,
    reason: string
  ): Promise<number> {
    const revoked = await transaction.adminSession.updateMany({
      where: {
        adminUserId: targetAdminUserId,
        revokedAt: null,
        hardExpiresAt: { gt: now }
      },
      data: { revokedAt: now, revokedReason: reason.slice(0, REVOCATION_REASON_LIMIT) }
    });
    return revoked.count;
  }

  /**
   * Assign a kiosk, whether or not this person has ever covered it before.
   *
   * There is no `upsert` on this client on purpose, so the two cases are
   * written out: clear a previous revocation if the row exists, and append if it
   * does not. The `create` can still lose a race with another Admin assigning
   * the same pair, and a unique-violation there means the row now exists — so
   * the update is retried rather than the request failed.
   */
  private async grantScope(
    transaction: AdminPeopleTransaction,
    targetAdminUserId: string,
    kioskId: string,
    now: Date
  ): Promise<boolean> {
    const restored = await transaction.adminKioskScope.updateMany({
      where: { adminUserId: targetAdminUserId, kioskId, revokedAt: { not: null } },
      data: { revokedAt: null }
    });
    if (restored.count === 1) return true;

    const existing = await transaction.adminKioskScope.count({
      where: { adminUserId: targetAdminUserId, kioskId, revokedAt: null }
    });
    if (existing > 0) return false;

    try {
      await transaction.adminKioskScope.create({
        data: { adminUserId: targetAdminUserId, kioskId, createdAt: now }
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const retried = await transaction.adminKioskScope.updateMany({
        where: { adminUserId: targetAdminUserId, kioskId, revokedAt: { not: null } },
        data: { revokedAt: null }
      });
      return retried.count === 1;
    }
  }

  /** Take a kiosk back. Idempotent: an assignment already ended reports no change. */
  private async revokeScope(
    transaction: AdminPeopleTransaction,
    targetAdminUserId: string,
    kioskId: string,
    now: Date
  ): Promise<boolean> {
    const revoked = await transaction.adminKioskScope.updateMany({
      where: { adminUserId: targetAdminUserId, kioskId, revokedAt: null },
      data: { revokedAt: now }
    });
    return revoked.count === 1;
  }

  /**
   * Turn a refusal into an audit row and the error the caller sees.
   *
   * The audit write happens outside the transaction that was rolled back, which
   * is the only way it survives: a refusal recorded inside the transaction it
   * refused would be discarded along with it.
   */
  private async refuse(
    admin: AuthenticatedAdmin,
    requestId: string,
    now: Date,
    action: string,
    error: unknown
  ): Promise<unknown> {
    if (!(error instanceof RefusedPeopleAction)) return error;

    try {
      await writeAdminAuditEvent(this.options.database, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: admin.adminUserId,
        action,
        outcome: "FAILURE",
        requestId,
        metadata: { role: admin.role, ...error.details }
      });
    } catch {
      // The caller is refused either way. Losing the record of a refusal is
      // worse than not logging it, but it is not worth turning into a 500.
    }

    return error.apiError;
  }
}

/** A refusal carrying both what the caller is told and what the log records. */
class RefusedPeopleAction extends Error {
  public constructor(
    public readonly apiError: ApiError,
    public readonly details: Readonly<Record<string, AdminAuditMetadataValue>>
  ) {
    super("admin people action refused");
    this.name = "RefusedPeopleAction";
  }
}

function statusTransitionError(reason: string, requested: string): ApiError {
  if (reason === "ALREADY_IN_STATE") {
    return new ApiError(
      409,
      "ADMIN_STATUS_UNCHANGED",
      `This account is already ${requested.toLowerCase()}.`
    );
  }
  if (reason === "NEVER_ACTIVATED") {
    return new ApiError(
      409,
      "ADMIN_NEVER_ACTIVATED",
      "This account never finished enrolling, so there is no access to give back."
    );
  }
  return new ApiError(
    409,
    "ADMIN_STATUS_TRANSITION_INVALID",
    "That change is not allowed from this account's current state."
  );
}

function concurrentChange(): ApiError {
  return new ApiError(
    409,
    "ADMIN_ACCOUNT_STATE_CHANGED",
    "This account changed while you were looking at it. Reload and try again."
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
