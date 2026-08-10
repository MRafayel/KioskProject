/**
 * When an admin session is still usable, and when a sensitive action still
 * needs the person to touch their key again.
 *
 * Pure: the caller supplies the clock. The API applies this on every admin
 * request, so a revoked or aged session stops being answered without waiting
 * for a sweep to notice it.
 */

import type { ActionRisk } from "./capabilities.js";
import { requiresStepUp } from "./capabilities.js";

export interface AdminSessionWindow {
  /** Rolls forward while the session is used. */
  idleExpiresAt: Date;
  /** Never extends. A session cannot outlive this whatever the operator does. */
  hardExpiresAt: Date;
  revokedAt: Date | null;
  /** When this session last completed a WebAuthn assertion. */
  lastStepUpAt: Date | null;
}

export type SessionRejectionReason = "REVOKED" | "IDLE_EXPIRED" | "ABSOLUTE_EXPIRED";

export type SessionValidity = { valid: true } | { valid: false; reason: SessionRejectionReason };

export function evaluateSession(session: AdminSessionWindow, now: Date): SessionValidity {
  if (session.revokedAt) return { valid: false, reason: "REVOKED" };
  const current = now.getTime();
  // The absolute limit is checked first so an expired-by-both session reports
  // the reason an operator cannot fix by clicking again.
  if (current >= session.hardExpiresAt.getTime()) {
    return { valid: false, reason: "ABSOLUTE_EXPIRED" };
  }
  if (current >= session.idleExpiresAt.getTime()) {
    return { valid: false, reason: "IDLE_EXPIRED" };
  }
  return { valid: true };
}

/**
 * A session's step-up is fresh for a short window after the assertion. It is
 * deliberately short: it exists so that confirming three related jobs does not
 * require three touches, not so that one morning assertion authorises a day of
 * changes.
 */
export function hasFreshStepUp(
  session: AdminSessionWindow,
  now: Date,
  stepUpTtlMilliseconds: number
): boolean {
  if (!Number.isSafeInteger(stepUpTtlMilliseconds) || stepUpTtlMilliseconds < 0) {
    throw new Error("ADMIN_STEP_UP_TTL_INVALID");
  }
  if (!session.lastStepUpAt) return false;
  const age = now.getTime() - session.lastStepUpAt.getTime();
  // Fail closed if the wall clock moved backwards or persisted data is from
  // the future. A negative age must not extend R2 authorization indefinitely.
  return age >= 0 && age < stepUpTtlMilliseconds;
}

/**
 * Whether this session may perform an action of this risk right now.
 *
 * R3 is never authorised by a session alone. It needs a second Technical Admin
 * and an Admin, which no single request can prove, so this returns false and
 * the endpoint refuses until the approval workflow exists to carry it.
 */
export function canPerform(
  session: AdminSessionWindow,
  risk: ActionRisk,
  now: Date,
  stepUpTtlMilliseconds: number
): boolean {
  if (evaluateSession(session, now).valid === false) return false;
  if (risk === "R3") return false;
  if (!requiresStepUp(risk)) return true;
  return hasFreshStepUp(session, now, stepUpTtlMilliseconds);
}

export function nextIdleExpiry(now: Date, idleTtlMilliseconds: number): Date {
  if (!Number.isSafeInteger(idleTtlMilliseconds) || idleTtlMilliseconds < 1) {
    throw new Error("ADMIN_SESSION_IDLE_TTL_INVALID");
  }
  return new Date(now.getTime() + idleTtlMilliseconds);
}
