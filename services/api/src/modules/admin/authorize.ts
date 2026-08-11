import type { FastifyRequest } from "fastify";

import {
  hasCapability,
  hasFreshStepUp,
  requiresStepUp,
  riskOfCapability,
  type AdminCapability
} from "@printing-kiosk/admin-access";

import { ApiError } from "../sessions/errors.js";
import type { AdminService, AuthenticatedAdmin } from "./service.js";

/**
 * The single gate every privileged admin request passes through.
 *
 * There is one exported function and it does all four checks in a fixed order:
 * a live session, a mutating request that proves it came from the admin UI, the
 * capability the endpoint names, and — for anything that changes something —
 * a recent touch of a security key. A route cannot accidentally perform three
 * of the four, because there is no way to ask for a subset.
 *
 * Frontend visibility is never authorization. The admin UI hides controls the
 * signed-in role lacks, and this function refuses them again regardless.
 */

export const ADMIN_SESSION_COOKIE = "__Host-admin_session";
export const ADMIN_CSRF_COOKIE = "__Host-admin_csrf";
export const ADMIN_CSRF_HEADER = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AdminAuthorizationDependencies {
  admin: AdminService;
  stepUpTtlMilliseconds: number;
  clock: { now(): Date };
}

/**
 * Authorize a request for one capability.
 *
 * Returns the identity so a route never has to look it up a second time and
 * cannot end up authorizing one account while acting on another.
 */
export async function authorizeAdmin(
  request: FastifyRequest,
  dependencies: AdminAuthorizationDependencies,
  capability: AdminCapability,
  /**
   * Called when an authenticated account is refused the capability, before the
   * refusal is thrown.
   *
   * Optional because most refusals here are uninteresting: a role that cannot
   * see a screen will be refused its endpoints all day, and recording each one
   * would bury the log. The money route passes a recorder anyway — somebody
   * without `refund.authorize` asking to authorize a payout is worth a
   * permanent row whatever else it is — and it is a hook rather than a rule so
   * that the choice stays visible at the route that made it.
   *
   * A failure here must not turn a 403 into a 500, so it is awaited defensively
   * by the caller rather than trusted.
   */
  onRefused?: (admin: AuthenticatedAdmin) => Promise<void>
): Promise<AuthenticatedAdmin> {
  const admin = await requireSession(request, dependencies);
  await requireCsrf(request, dependencies, admin);

  if (!hasCapability(admin.role, capability)) {
    if (onRefused) await onRefused(admin);
    throw new ApiError(403, "ADMIN_FORBIDDEN", "This action is not available to your role.");
  }

  const risk = riskOfCapability(capability);

  // R3 cannot be authorised by any single request: it needs a second Technical
  // Admin and an Admin. Until the approval workflow exists there is no path
  // that can satisfy it, and pretending otherwise would be the bug.
  if (risk === "R3") {
    throw new ApiError(
      403,
      "ADMIN_APPROVAL_REQUIRED",
      "This change requires a second Technical Admin and an Admin approval."
    );
  }

  if (
    requiresStepUp(risk) &&
    !hasFreshStepUp(
      {
        idleExpiresAt: admin.idleExpiresAt,
        hardExpiresAt: admin.hardExpiresAt,
        revokedAt: null,
        lastStepUpAt: admin.lastStepUpAt
      },
      dependencies.clock.now(),
      dependencies.stepUpTtlMilliseconds
    )
  ) {
    throw new ApiError(
      401,
      "ADMIN_STEP_UP_REQUIRED",
      "Confirm with your security key to continue."
    );
  }

  return admin;
}

/**
 * A live session with no capability check, for the few routes that are about
 * the session itself: reading your own identity, stepping up, logging out.
 */
export async function requireAdminSession(
  request: FastifyRequest,
  dependencies: AdminAuthorizationDependencies
): Promise<AuthenticatedAdmin> {
  const admin = await requireSession(request, dependencies);
  await requireCsrf(request, dependencies, admin);
  return admin;
}

async function requireSession(
  request: FastifyRequest,
  dependencies: AdminAuthorizationDependencies
): Promise<AuthenticatedAdmin> {
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!token) throw unauthenticated();

  const admin = await dependencies.admin.resolveSession(token);
  // A revoked, expired, or disabled-account session is indistinguishable from
  // no session at all. There is nothing useful to tell the caller.
  if (!admin) throw unauthenticated();
  return admin;
}

/**
 * Double-submit CSRF on every state-changing request.
 *
 * The session cookie is `SameSite=Strict`, which already blocks the ordinary
 * cross-site form post. This is the second layer: the token is bound to this
 * session in the database, so a token lifted from a different session — or
 * guessed — does not satisfy it. Safe methods are exempt because they change
 * nothing.
 */
async function requireCsrf(
  request: FastifyRequest,
  dependencies: AdminAuthorizationDependencies,
  admin: AuthenticatedAdmin
): Promise<void> {
  if (SAFE_METHODS.has(request.method)) return;

  const header = request.headers[ADMIN_CSRF_HEADER];
  // Ambiguous duplicate security headers can be interpreted differently by a
  // proxy and the application. Reject them instead of selecting one value.
  if (Array.isArray(header)) throw csrfFailed();
  const presented = header;
  if (!presented) throw csrfFailed();

  const cookie = readCookie(request, ADMIN_CSRF_COOKIE);
  // Both halves of the double submit must be present and identical before the
  // stored digest is consulted.
  if (!cookie || cookie !== presented) throw csrfFailed();

  if (!(await dependencies.admin.verifyCsrf(admin.sessionId, presented))) throw csrfFailed();
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const value = request.cookies[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unauthenticated(): ApiError {
  return new ApiError(401, "ADMIN_AUTHENTICATION_REQUIRED", "Sign in to continue.");
}

function csrfFailed(): ApiError {
  return new ApiError(403, "ADMIN_CSRF_FAILED", "The request could not be verified.");
}
