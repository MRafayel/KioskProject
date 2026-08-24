import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Digests for the admin plane.
 *
 * Every value the browser holds is stored here only as a peppered HMAC, so
 * reading `admin_sessions` or `admin_break_glass_credentials` yields nothing
 * that can be replayed. The peppers are separate from every other secret in the
 * system and from each other, which configuration validation enforces in
 * production: leaking the session pepper must not also forge recovery
 * credentials.
 *
 * These are HMACs of high-entropy random tokens, not of passwords. There is no
 * password anywhere in the admin plane, so no slow key-derivation function is
 * needed — a 256-bit random token is not guessable at any hash rate.
 */

const SESSION_TOKEN_PURPOSE = "printing-kiosk/admin-session-token/v1";
const CSRF_TOKEN_PURPOSE = "printing-kiosk/admin-csrf-token/v1";
const BREAK_GLASS_PURPOSE = "printing-kiosk/admin-break-glass/v1";
/**
 * Invitations and password resets share the break-glass pepper deliberately.
 *
 * They are the same kind of thing — a one-time code that authorises exactly one
 * account operation and nothing else — so a deployment holding one secret for
 * all three is coherent rather than lazy. What keeps them from being
 * interchangeable is the purpose string: the same code digests differently for
 * each, so an invitation presented to the reset endpoint matches nothing, and
 * neither does a recovery code presented anywhere but break-glass.
 */
const INVITATION_PURPOSE = "printing-kiosk/admin-invitation/v1";
const PASSWORD_RESET_PURPOSE = "printing-kiosk/admin-password-reset/v1";

function digest(purpose: string, value: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(purpose, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function digestAdminSessionToken(token: string, pepper: string): string {
  return digest(SESSION_TOKEN_PURPOSE, token, pepper);
}

export function digestAdminCsrfToken(token: string, pepper: string): string {
  return digest(CSRF_TOKEN_PURPOSE, token, pepper);
}

export function digestBreakGlassSecret(secret: string, pepper: string): string {
  return digest(BREAK_GLASS_PURPOSE, secret, pepper);
}

export function digestInvitationSecret(secret: string, pepper: string): string {
  return digest(INVITATION_PURPOSE, secret, pepper);
}

export function digestPasswordResetSecret(secret: string, pepper: string): string {
  return digest(PASSWORD_RESET_PURPOSE, secret, pepper);
}

/**
 * Compares two hex digests without leaking the position of the first
 * difference. Used for the CSRF double-submit check, which compares a value the
 * caller controls against one from the session row.
 */
export function digestsMatch(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
