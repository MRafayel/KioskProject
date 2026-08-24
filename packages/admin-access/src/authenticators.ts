/**
 * What an admin account's credentials must look like before it may be used.
 *
 * This module is pure. The API enforces it at enrolment, at activation and at
 * revocation, and PostgreSQL enforces the activation and keep-a-spare
 * invariants again with triggers, because losing them would either lock a
 * privileged operator out or leave an account usable without the factors its
 * role requires.
 *
 * Authentication is a password plus, for privileged roles, a WebAuthn
 * credential (`authentication.ts` holds that policy). The password is what
 * makes a lost or reinstalled authenticator a recoverable event rather than a
 * break-glass ceremony, which is why the minimum key counts here are lower
 * than they were when WebAuthn stood alone: an account is no longer one
 * misplaced USB stick away from the sealed-envelope procedure.
 */

import { requiresWebAuthn } from "./authentication.js";
import { isPrivilegedRole, type AdminRole } from "./capabilities.js";

/**
 * How many usable WebAuthn credentials each role must keep while ACTIVE.
 *
 * One for privileged roles: the key is their second factor, so zero would let
 * a password alone sign them in. It was two when WebAuthn was the only factor
 * and losing the last key meant losing the account; with a password beneath it
 * and administrator-assisted recovery beside it, a lost key is now an
 * inconvenience, and the second mandatory key bought lockouts more often than
 * it bought safety.
 */
export const MINIMUM_PRIVILEGED_AUTHENTICATORS = 1;

/** Operators authenticate with a password alone; a key is not part of their
 * sign-in and so none is required. */
export const MINIMUM_OPERATOR_AUTHENTICATORS = 0;

export function minimumAuthenticators(role: AdminRole): number {
  return isPrivilegedRole(role)
    ? MINIMUM_PRIVILEGED_AUTHENTICATORS
    : MINIMUM_OPERATOR_AUTHENTICATORS;
}

/**
 * An account cannot authenticate until it is ACTIVE, and it cannot become
 * ACTIVE until it holds a password and `minimumAuthenticators` usable keys.
 * PROVISIONING therefore describes the only window in which an account is
 * missing a factor its role requires, and in that window it can do nothing but
 * finish accepting its invitation.
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
  /** True when the credential is allowed to leave the device it was created on. */
  backupEligible: boolean;
  /** True once the credential actually has been synchronised off the device. */
  backedUp: boolean;
}

export type AuthenticatorPolicyResult = { allowed: true };

/**
 * Whether this authenticator may be enrolled for this role.
 *
 * Every role may now use a platform authenticator or a synchronised passkey.
 * Technical Admins were once restricted to device-bound roaming keys — the
 * right rule while WebAuthn was the only factor, and the rule that in practice
 * forced a browser-lifetime virtual authenticator on any machine without a
 * hardware key, burning a break-glass code per browser restart. With a
 * password in front of every assertion, the credential is a second factor, and
 * a platform authenticator that persists is strictly safer than a perfect key
 * that keeps not existing.
 *
 * The function survives the relaxation on purpose: it is the one seam where a
 * quality rule for a role's keys would return, and the enrolment path still
 * routes every registration through it.
 */
export function evaluateAuthenticatorPolicy(
  role: AdminRole,
  properties: AuthenticatorProperties
): AuthenticatorPolicyResult {
  void role;
  void properties;
  return { allowed: true };
}

export type ActivationRejectionReason =
  "NOT_ENOUGH_AUTHENTICATORS" | "PASSWORD_NOT_SET" | "STATUS_NOT_PROVISIONING";

export type ActivationResult =
  | { allowed: true }
  | { allowed: false; reason: ActivationRejectionReason; required: number; present: number };

/**
 * Whether a provisioning account has everything its role needs to be switched
 * on: a password always, and for roles that sign in with a key, at least the
 * minimum number of them.
 */
export function evaluateActivation(
  role: AdminRole,
  status: AdminUserStatus,
  usableAuthenticators: number,
  hasPassword: boolean
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
  if (!hasPassword) {
    return { allowed: false, reason: "PASSWORD_NOT_SET", required, present: usableAuthenticators };
  }
  if (requiresWebAuthn(role) && usableAuthenticators < required) {
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
 * An ACTIVE account may not be taken below its minimum by a revocation: for a
 * privileged role that means the last usable key stays until a replacement is
 * enrolled, because removing it would leave a password as the only thing
 * between the internet and an administrator account.
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
