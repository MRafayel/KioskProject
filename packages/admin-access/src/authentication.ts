import { z } from "zod";

import { isPrivilegedRole, type AdminRole } from "./capabilities.js";

/**
 * How each role proves who it is.
 *
 * A password is the base factor for everybody: it is the thing that survives a
 * lost device, a reinstalled browser and a cleared profile, which the
 * WebAuthn-only design turned out not to. WebAuthn is layered on top per role —
 * privileged roles must present a security key or platform authenticator after
 * the password, and the same assertion machinery keeps guarding sensitive
 * actions through step-up.
 *
 * This module is pure and holds the whole policy as data, so "which roles need
 * a key" is one predicate here rather than a condition scattered across the
 * login, unlock, step-up and activation paths. Requiring WebAuthn for a further
 * role later is a one-line change to `WEBAUTHN_REQUIRED_ROLES`.
 */

/**
 * Roles that must complete a WebAuthn assertion after their password, at login
 * and again at every step-up. Exactly the privileged set today; the list is
 * separate from `PRIVILEGED_ADMIN_ROLES` so tightening one does not silently
 * widen the other.
 */
const WEBAUTHN_REQUIRED_ROLES: readonly AdminRole[] = ["ADMIN", "TECHNICAL_ADMIN"];

export function requiresWebAuthn(role: AdminRole): boolean {
  return WEBAUTHN_REQUIRED_ROLES.includes(role);
}

/**
 * What "prove it is really you" means for this role — at unlock after
 * inactivity, and at step-up before a sensitive action.
 *
 * For a role that carries WebAuthn, only an assertion counts: a password can be
 * shoulder-surfed or phished in a way a key cannot, and the roles here are the
 * ones a stolen password must not be enough for. For an Operator the password
 * is the strong factor, because it is the only one they hold.
 */
export type StrongAuthMethod = "WEBAUTHN" | "PASSWORD";

export function strongAuthMethodForRole(role: AdminRole): StrongAuthMethod {
  return requiresWebAuthn(role) ? "WEBAUTHN" : "PASSWORD";
}

/**
 * Who may create an invitation for whom.
 *
 * Read the asymmetry deliberately: an Admin runs the business and brings in the
 * Operators who work it; a Technical Admin is the support role trusted with the
 * identity plane itself, so it can onboard any role — and it is the only one
 * that can mint another Technical Admin. An invitation carries its role from
 * the moment it is issued and the role is immutable afterwards, so this matrix
 * is the entire answer to "who can create a privileged account".
 */
const INVITABLE_ROLES: Readonly<Record<AdminRole, readonly AdminRole[]>> = {
  OPERATOR: [],
  ADMIN: ["OPERATOR"],
  TECHNICAL_ADMIN: ["OPERATOR", "ADMIN", "TECHNICAL_ADMIN"]
};

export function mayInviteRole(actorRole: AdminRole, targetRole: AdminRole): boolean {
  return INVITABLE_ROLES[actorRole].includes(targetRole);
}

export function invitableRoles(actorRole: AdminRole): readonly AdminRole[] {
  return INVITABLE_ROLES[actorRole];
}

/**
 * Who may issue a password reset for whom.
 *
 * Nobody resets a Technical Admin from the panel — that stays a CLI act with a
 * database credential behind it, because the people who could authorise it from
 * a browser are exactly the accounts an attacker would use it against. A reset
 * for a privileged target cannot become a takeover even when it is issued
 * maliciously: the issuer sets no password, sees no password, and the WebAuthn
 * factor they do not hold still stands between them and the account.
 */
const RESETTABLE_ROLES: Readonly<Record<AdminRole, readonly AdminRole[]>> = {
  OPERATOR: [],
  ADMIN: ["OPERATOR"],
  TECHNICAL_ADMIN: ["OPERATOR", "ADMIN"]
};

export function mayResetPassword(actorRole: AdminRole, targetRole: AdminRole): boolean {
  return RESETTABLE_ROLES[actorRole].includes(targetRole);
}

/**
 * A username is an identifier, not a secret: short, stable, unambiguous, and
 * safe to say over a phone. Lowercase-only removes the "is it Ada or ada"
 * class of lockout, and the character set keeps it printable everywhere a
 * login form or an audit row will carry it.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/u;

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN_LENGTH)
  .max(USERNAME_MAX_LENGTH)
  .regex(USERNAME_PATTERN, "lowercase letters, digits, and . _ - between them");

/**
 * Length is the policy, and there is no composition rule on purpose: forced
 * symbol classes produce predictable substitutions, not entropy. The ceiling
 * bounds what a request can feed the key-derivation function.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/**
 * A presented secret from an invitation or reset link: 256 bits, base64url,
 * generated server-side and stored only as a digest. Bounded here so a
 * redemption attempt with something that cannot be a code is refused before it
 * reaches a database lookup. Same shape the break-glass code has always had.
 */
export const oneTimeCodeSchema = z
  .string()
  .trim()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);

/** Whether isPrivilegedRole and the WebAuthn requirement agree today. Exported
 * for the test that pins the relationship so a future divergence is a decision
 * rather than an accident. */
export function webAuthnPolicyMatchesPrivilege(role: AdminRole): boolean {
  return requiresWebAuthn(role) === isPrivilegedRole(role);
}
