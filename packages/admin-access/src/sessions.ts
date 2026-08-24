/**
 * When an admin session is still usable, when it is merely locked, and when a
 * sensitive action still needs the person to prove themselves again.
 *
 * Pure: the caller supplies the clock. The API applies this on every admin
 * request, so a revoked or aged session stops being answered without waiting
 * for a sweep to notice it.
 *
 * Inactivity locks; it does not destroy. A session whose idle window has passed
 * is a locked door, not a demolished one: the row survives, the cookie
 * survives, and a quick reauthentication — one touch of a key, or the password
 * — reopens the same session where the person left it. What actually ends a
 * session is revocation (logout, an administrator, a reset) or the absolute
 * limit, which no amount of activity extends.
 */

import type { ActionRisk } from "./capabilities.js";
import { requiresStepUp } from "./capabilities.js";

export interface AdminSessionWindow {
  /** Rolls forward while the session is used. Passing it locks the session. */
  idleExpiresAt: Date;
  /** Never extends. A session cannot outlive this whatever the operator does. */
  hardExpiresAt: Date;
  revokedAt: Date | null;
  /** When this session last completed a strong reauthentication. */
  lastStepUpAt: Date | null;
}

export type SessionRejectionReason = "REVOKED" | "ABSOLUTE_EXPIRED";

export type SessionEvaluation =
  | { state: "ACTIVE" }
  /** Reauthenticate to continue; the session itself still stands. */
  | { state: "LOCKED" }
  | { state: "INVALID"; reason: SessionRejectionReason };

export function evaluateSession(session: AdminSessionWindow, now: Date): SessionEvaluation {
  if (session.revokedAt) return { state: "INVALID", reason: "REVOKED" };
  const current = now.getTime();
  // The absolute limit wins over the idle one, so a session past both reports
  // the thing an unlock cannot fix.
  if (current >= session.hardExpiresAt.getTime()) {
    return { state: "INVALID", reason: "ABSOLUTE_EXPIRED" };
  }
  if (current >= session.idleExpiresAt.getTime()) {
    return { state: "LOCKED" };
  }
  return { state: "ACTIVE" };
}

/**
 * A session's step-up is fresh for a short window after the reauthentication.
 * It is deliberately short: it exists so that confirming three related jobs
 * does not require three touches, not so that one morning assertion authorises
 * a day of changes.
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
 * A locked session may perform nothing: unlocking is itself a
 * reauthentication, so there is no action cheap enough to allow through a
 * locked door. R3 is never authorised by a session alone — it means "no single
 * account may do this alone", which no one request can prove — so this returns
 * false and the endpoint refuses.
 */
export function canPerform(
  session: AdminSessionWindow,
  risk: ActionRisk,
  now: Date,
  stepUpTtlMilliseconds: number
): boolean {
  if (evaluateSession(session, now).state !== "ACTIVE") return false;
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
