import type { FastifyRequest } from "fastify";

import {
  hasCapability,
  hasFreshStepUp,
  requiresStepUp,
  riskOfCapability,
  type AdminCapability
} from "@printing-kiosk/admin-access";

import { ApiError } from "../sessions/errors.js";
import type {
  AdminClientContext,
  AdminService,
  AdminSessionResolution,
  AuthenticatedAdmin,
  LockedAdmin
} from "./service.js";

/**
 * The single gate every privileged admin request passes through.
 *
 * There is one exported function and it does all four checks in a fixed order:
 * a live session, a mutating request that proves it came from the admin UI, the
 * capability the endpoint names, and — for anything that changes something —
 * a recent strong reauthentication. A route cannot accidentally perform three
 * of the four, because there is no way to ask for a subset.
 *
 * A locked session — idle window passed, absolute window not — refuses
 * everything here with its own error code, so the UI can draw a lock screen
 * instead of a sign-in screen. Only the unlock and logout routes accept one,
 * through `requireAdminPresence` below.
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
  const admin = await requireActiveSession(request, dependencies);
  await requireCsrf(request, dependencies, admin.sessionId, false);

  if (!hasCapability(admin.role, capability)) {
    if (onRefused) await onRefused(admin);
    throw new ApiError(403, "ADMIN_FORBIDDEN", "This action is not available to your role.");
  }

  const risk = riskOfCapability(capability);

  // R3 cannot be authorised by any single request: it means "no one account may
  // do this alone", and this is one account. Nothing is classified R3 today, and
  // this stays as the backstop that makes the class safe to use: a capability
  // promoted to R3 later refuses here rather than silently running as a
  // single-account action on whichever endpoint names it.
  if (risk === "R3") {
    throw new ApiError(
      403,
      "ADMIN_APPROVAL_REQUIRED",
      "This action cannot be performed by one account on its own."
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
    throw new ApiError(401, "ADMIN_STEP_UP_REQUIRED", "Confirm it is you to continue.");
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
  const admin = await requireActiveSession(request, dependencies);
  await requireCsrf(request, dependencies, admin.sessionId, false);
  return admin;
}

/**
 * A session that may be locked, for the two routes a locked session is
 * entitled to: unlocking, and logging out. Everything else refuses a locked
 * session at `requireActiveSession`.
 */
export async function requireAdminPresence(
  request: FastifyRequest,
  dependencies: AdminAuthorizationDependencies
): Promise<
  { state: "ACTIVE"; admin: AuthenticatedAdmin } | { state: "LOCKED"; locked: LockedAdmin }
> {
  const resolution = await resolveRequestSession(request, dependencies);
  if (!resolution) throw unauthenticated();
  const sessionId =
    resolution.state === "ACTIVE" ? resolution.admin.sessionId : resolution.locked.sessionId;
  await requireCsrf(request, dependencies, sessionId, true);
  return resolution;
}

/**
 * The current session for `/me`, locked included, with no CSRF: it is a GET,
 * and the lock screen needs to know it is a lock screen before any mutating
 * request exists to protect.
 */
export async function describeAdminSession(
  request: FastifyRequest,
  dependencies: AdminAuthorizationDependencies
): Promise<AdminSessionResolution> {
  return resolveRequestSession(request, dependencies);
}

async function requireActiveSession(
  request: FastifyRequest,
  dependencies: AdminAuthorizationDependencies
): Promise<AuthenticatedAdmin> {
  const resolution = await resolveRequestSession(request, dependencies);
  // A revoked, expired, or disabled-account session is indistinguishable from
  // no session at all. There is nothing useful to tell the caller. A locked
  // one is different: its holder proved themselves once and the row still
  // stands, so it earns the code the lock screen listens for.
  if (!resolution) throw unauthenticated();
  if (resolution.state === "LOCKED") {
    throw new ApiError(401, "ADMIN_SESSION_LOCKED", "Unlock your session to continue.");
  }
  return resolution.admin;
}

async function resolveRequestSession(
  request: FastifyRequest,
  dependencies: AdminAuthorizationDependencies
): Promise<AdminSessionResolution> {
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!token) return null;
  return dependencies.admin.resolveSession(token, clientContext(request));
}

/** Where a request came from, recorded on the session for its owner to read. */
export function clientContext(request: FastifyRequest): AdminClientContext {
  const userAgent = request.headers["user-agent"];
  return {
    ipAddress: typeof request.ip === "string" && request.ip.length > 0 ? request.ip : null,
    userAgent: typeof userAgent === "string" && userAgent.length > 0 ? userAgent : null
  };
}

/**
 * Double-submit CSRF on every state-changing request.
 *
 * The session cookie is `SameSite=Strict`, which already blocks the ordinary
 * cross-site form post. This is the second layer: the token is bound to this
 * session in the database, so a token lifted from a different session — or
 * guessed — does not satisfy it. Safe methods are exempt because they change
 * nothing. The unlock and logout paths verify against a locked session,
 * because those are the two requests a locked session is allowed to make.
 */
async function requireCsrf(
  request: FastifyRequest,
  dependencies: AdminAuthorizationDependencies,
  sessionId: string,
  allowLocked: boolean
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

  if (!(await dependencies.admin.verifyCsrf(sessionId, presented, { allowLocked }))) {
    throw csrfFailed();
  }
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
