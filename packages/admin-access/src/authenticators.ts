/**
 * What an admin account's authenticators must look like before it may be used.
 *
 * This module is pure. The API enforces it at enrolment, at activation and at
 * revocation, and PostgreSQL enforces the same two invariants again with
 * triggers, because losing them would either lock a privileged operator out
 * permanently or leave a weaker credential standing where a hardware key was
 * required.
 *
 * WebAuthn is the only factor in this system. There is no password, no TOTP, no
 * emailed link and no SMS — deliberately, because any of them would become the
 * cheapest way in and would make the choice of WebAuthn decorative. The cost of
 * that decision is that a lost authenticator has no "reset" path, so the rules
 * below exist to make sure no account ever depends on a single one.
 */

import { isPrivilegedRole, type AdminRole } from "./capabilities.js";

/**
 * Every privileged account keeps at least this many usable authenticators, so
 * losing one is a replacement rather than an account recovery.
 */
export const MINIMUM_PRIVILEGED_AUTHENTICATORS = 2;

/** An Operator still needs a spare; the consequence of losing one is smaller. */
export const MINIMUM_OPERATOR_AUTHENTICATORS = 2;

export function minimumAuthenticators(role: AdminRole): number {
  return isPrivilegedRole(role)
    ? MINIMUM_PRIVILEGED_AUTHENTICATORS
    : MINIMUM_OPERATOR_AUTHENTICATORS;
}

/**
 * An account cannot authenticate until it is ACTIVE, and it cannot become
 * ACTIVE until it satisfies `minimumAuthenticators`. PROVISIONING therefore
 * describes the only window in which an account holds fewer than the minimum,
 * and in that window it can do nothing but finish enrolling.
 */
export const ADMIN_USER_STATUSES = ["PROVISIONING", "ACTIVE", "SUSPENDED", "DISABLED"] as const;

export type AdminUserStatus = (typeof ADMIN_USER_STATUSES)[number];

export function isAdminUserStatus(value: string): value is AdminUserStatus {
  return (ADMIN_USER_STATUSES as readonly string[]).includes(value);
}

/** Only an ACTIVE account may hold a session or complete an assertion. */
export function canAuthenticate(status: AdminUserStatus): boolean {
  return status === "ACTIVE";
}

/**
 * What the authenticator told us about itself during registration. These are
 * the WebAuthn signals that distinguish a hardware key bound to one device from
 * a passkey synchronised across a vendor's cloud.
 */
export interface AuthenticatorProperties {
  /**
   * `cross-platform` is a roaming key (a USB/NFC security key);
   * `platform` is the device's own biometric sensor. Null when the
   * authenticator declined to say.
   */
  attachment: "platform" | "cross-platform" | null;
  /**
   * True when the credential is allowed to leave the device it was created on.
   * A synchronised passkey is only as strong as the cloud account holding it,
   * which is why a Technical Admin may not use one.
   */
  backupEligible: boolean;
  /** True once the credential actually has been synchronised off the device. */
  backedUp: boolean;
}

export type AuthenticatorRejectionReason =
  /** A Technical Admin key must not be synchronisable to a vendor cloud. */
  | "BACKUP_ELIGIBLE_NOT_ALLOWED"
  /** A Technical Admin key must be a roaming hardware authenticator. */
  | "CROSS_PLATFORM_REQUIRED";

export type AuthenticatorPolicyResult =
  { allowed: true } | { allowed: false; reason: AuthenticatorRejectionReason };

/**
 * Whether this authenticator may be enrolled for this role.
 *
 * Technical Admins hold the proposing half of every serious production change,
 * so their credential must be device-bound: not exportable, not synchronised,
 * and physically separable from the workstation. `backupEligible` is the
 * WebAuthn flag that reports exportability, and it is checked rather than
 * merely requested — a registration ceremony can ask for a resident key on a
 * roaming authenticator and still be answered by a synchronised passkey.
 *
 * Admins and Operators may use a platform authenticator. Their capabilities are
 * bounded by approval requirements and by the absence of any document or
 * credential access, so the stricter hardware rule would cost more in lockouts
 * than it buys.
 */
export function evaluateAuthenticatorPolicy(
  role: AdminRole,
  properties: AuthenticatorProperties
): AuthenticatorPolicyResult {
  if (role !== "TECHNICAL_ADMIN") return { allowed: true };

  if (properties.backupEligible || properties.backedUp) {
    return { allowed: false, reason: "BACKUP_ELIGIBLE_NOT_ALLOWED" };
  }
  // A null attachment means the authenticator declined to identify itself.
  // For this role that is not good enough to accept.
  if (properties.attachment !== "cross-platform") {
    return { allowed: false, reason: "CROSS_PLATFORM_REQUIRED" };
  }
  return { allowed: true };
}

export type ActivationRejectionReason = "NOT_ENOUGH_AUTHENTICATORS" | "STATUS_NOT_PROVISIONING";

export type ActivationResult =
  | { allowed: true }
  | { allowed: false; reason: ActivationRejectionReason; required: number; present: number };

/** Whether a provisioning account has enrolled enough to be switched on. */
export function evaluateActivation(
  role: AdminRole,
  status: AdminUserStatus,
  usableAuthenticators: number
): ActivationResult {
  const required = minimumAuthenticators(role);
  if (status !== "PROVISIONING") {
    return {
      allowed: false,
      reason: "STATUS_NOT_PROVISIONING",
      required,
      present: usableAuthenticators
    };
  }
  if (usableAuthenticators < required) {
    return {
      allowed: false,
      reason: "NOT_ENOUGH_AUTHENTICATORS",
      required,
      present: usableAuthenticators
    };
  }
  return { allowed: true };
}

/**
 * Whether one authenticator may be revoked.
 *
 * An ACTIVE account may not be taken below its minimum by a revocation: the
 * replacement is enrolled first, and only then is the lost key removed. Doing
 * it the other way round is how an operator ends up locked out of the control
 * plane during the incident they needed it for.
 *
 * A suspended or disabled account has no session to protect, so its
 * authenticators may be cleaned up freely.
 */
export function canRevokeAuthenticator(
  role: AdminRole,
  status: AdminUserStatus,
  usableAuthenticatorsBeforeRevocation: number
): boolean {
  if (status !== "ACTIVE") return true;
  return usableAuthenticatorsBeforeRevocation - 1 >= minimumAuthenticators(role);
}
