import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  adminAuthenticatorsResponseSchema,
  adminHealthResponseSchema,
  adminIdentityResponseSchema,
  beginBreakGlassBodySchema,
  capabilitiesForRole,
  hasFreshStepUp,
  revokeAuthenticatorBodySchema,
  verifyAuthenticationBodySchema,
  verifyRegistrationBodySchema,
  webAuthnOptionsResponseSchema
} from "@printing-kiosk/admin-access";

import { ApiError } from "../sessions/errors.js";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  authorizeAdmin,
  requireAdminSession,
  type AdminAuthorizationDependencies
} from "./authorize.js";
import type { AdminService, AdminSessionCookiePair, AuthenticatedAdmin } from "./service.js";

/**
 * The admin control plane's HTTP surface for Phase 1.
 *
 * Everything here is about identity: proving it, re-proving it, and managing
 * the keys that prove it. No route in this file reads a session, document,
 * payment or print row — that is Phase 2, and keeping the split sharp means the
 * authorization foundation can be reviewed on its own.
 *
 * There is deliberately no route to enumerate accounts, no route that accepts a
 * username, and no route that reports whether an account exists.
 */

const authenticatorParamsSchema = z.object({ authenticatorId: z.string().uuid() });

/** Ceremonies are cheap to start and expensive to brute-force; still, bound them. */
const CEREMONY_RATE = { max: 30, timeWindow: "1 minute" } as const;
const VERIFY_RATE = { max: 20, timeWindow: "1 minute" } as const;
/** Recovery is a rare, alarming event. A tight ceiling makes guessing useless. */
const BREAK_GLASS_RATE = { max: 5, timeWindow: "1 hour" } as const;

export interface AdminRouteDependencies extends AdminAuthorizationDependencies {
  admin: AdminService;
  /** HTTPS in production; false only for local development over http. */
  secureCookies: boolean;
  idleTtlMilliseconds: number;
  stepUpTtlMilliseconds: number;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteDependencies
): void {
  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  app.post(
    "/v1/admin/auth/authentication/options",
    { config: { rateLimit: { ...CEREMONY_RATE, keyGenerator: adminRateKey } } },
    async (_request, reply) => {
      const ceremony = await dependencies.admin.beginAuthentication();
      return sendNoStore(reply, webAuthnOptionsResponseSchema.parse(ceremony));
    }
  );

  app.post(
    "/v1/admin/auth/authentication/verify",
    { config: { rateLimit: { ...VERIFY_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const body = verifyAuthenticationBodySchema.parse(request.body ?? {});
      const { admin, cookies } = await dependencies.admin.completeAuthentication({
        ceremonyId: body.ceremonyId,
        credential: body.credential,
        requestId: request.id
      });

      setSessionCookies(reply, cookies, dependencies.secureCookies);
      return sendNoStore(
        reply,
        identityResponse(admin, dependencies.stepUpTtlMilliseconds, dependencies.clock.now())
      );
    }
  );

  app.post("/v1/admin/auth/logout", async (request, reply) => {
    const admin = await requireAdminSession(request, dependencies);
    await dependencies.admin.revokeSession({
      admin,
      reason: "USER_LOGOUT",
      requestId: request.id
    });
    clearSessionCookies(reply, dependencies.secureCookies);
    return reply.header("cache-control", "no-store").code(204).send();
  });

  // -------------------------------------------------------------------------
  // Step-up
  // -------------------------------------------------------------------------

  app.post(
    "/v1/admin/auth/step-up/options",
    { config: { rateLimit: { ...CEREMONY_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const admin = await requireAdminSession(request, dependencies);
      const ceremony = await dependencies.admin.beginStepUp(admin.adminUserId);
      return sendNoStore(reply, webAuthnOptionsResponseSchema.parse(ceremony));
    }
  );

  app.post(
    "/v1/admin/auth/step-up/verify",
    { config: { rateLimit: { ...VERIFY_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const admin = await requireAdminSession(request, dependencies);
      const body = verifyAuthenticationBodySchema.parse(request.body ?? {});
      const steppedUpAt = await dependencies.admin.completeStepUp({
        admin,
        ceremonyId: body.ceremonyId,
        credential: body.credential,
        requestId: request.id
      });

      return sendNoStore(
        reply,
        identityResponse(
          { ...admin, lastStepUpAt: steppedUpAt },
          dependencies.stepUpTtlMilliseconds,
          dependencies.clock.now()
        )
      );
    }
  );

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  app.get("/v1/admin/me", async (request, reply) => {
    const admin = await requireAdminSession(request, dependencies);
    return sendNoStore(
      reply,
      identityResponse(admin, dependencies.stepUpTtlMilliseconds, dependencies.clock.now())
    );
  });

  /**
   * The one operational page in Phase 1. It exists to prove end to end that
   * enforcement is live, and returns nothing about the printing system.
   */
  app.get("/v1/admin/health", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "dashboard.read");
    return sendNoStore(
      reply,
      adminHealthResponseSchema.parse({
        service: "admin",
        timestamp: dependencies.clock.now().toISOString(),
        authenticated: true,
        role: admin.role
      })
    );
  });

  // -------------------------------------------------------------------------
  // Authenticators
  // -------------------------------------------------------------------------

  app.get("/v1/admin/authenticators", async (request, reply) => {
    const admin = await requireAdminSession(request, dependencies);
    const listing = await dependencies.admin.listAuthenticators(admin.adminUserId, admin.role);
    return sendNoStore(
      reply,
      adminAuthenticatorsResponseSchema.parse({
        items: listing.items.map((item) => ({
          id: item.id,
          label: item.label,
          attachment: item.attachment,
          backupEligible: item.backupEligible,
          createdAt: item.createdAt.toISOString(),
          lastUsedAt: item.lastUsedAt?.toISOString() ?? null
        })),
        minimumRequired: listing.minimumRequired,
        usableCount: listing.usableCount
      })
    );
  });

  app.post(
    "/v1/admin/authenticators/registration/options",
    { config: { rateLimit: { ...CEREMONY_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      // Enrolling onto your own account. Managing someone else's is a separate
      // capability and arrives with Operator administration in Phase 4.
      const admin = await authorizeAdmin(request, dependencies, "authenticator.manage.self");
      const ceremony = await dependencies.admin.beginRegistration(admin.adminUserId);
      return sendNoStore(reply, webAuthnOptionsResponseSchema.parse(ceremony));
    }
  );

  app.post(
    "/v1/admin/authenticators/registration/verify",
    { config: { rateLimit: { ...VERIFY_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const admin = await authorizeAdmin(request, dependencies, "authenticator.manage.self");
      const body = verifyRegistrationBodySchema.parse(request.body ?? {});
      const result = await dependencies.admin.completeRegistration({
        targetAdminUserId: admin.adminUserId,
        actorAdminUserId: admin.adminUserId,
        ceremonyId: body.ceremonyId,
        credential: body.credential,
        label: body.label,
        requestId: request.id
      });
      return sendNoStore(reply, { authenticatorId: result.authenticatorId });
    }
  );

  app.post("/v1/admin/authenticators/:authenticatorId/revoke", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "authenticator.manage.self");
    const params = authenticatorParamsSchema.parse(request.params);
    const body = revokeAuthenticatorBodySchema.parse(request.body ?? {});
    await dependencies.admin.revokeAuthenticator({
      admin,
      targetAdminUserId: admin.adminUserId,
      authenticatorId: params.authenticatorId,
      reason: body.reason,
      requestId: request.id
    });
    return reply.header("cache-control", "no-store").code(204).send();
  });

  // -------------------------------------------------------------------------
  // Break-glass
  // -------------------------------------------------------------------------

  /**
   * The sealed way back in. It authorises exactly one enrolment ceremony on one
   * named account and nothing else: no session is issued, no capability is
   * granted, and the credential is burned whether or not the ceremony that
   * follows succeeds.
   */
  app.post(
    "/v1/admin/auth/break-glass/registration/options",
    { config: { rateLimit: { ...BREAK_GLASS_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const body = beginBreakGlassBodySchema.parse(request.body ?? {});
      const ceremony = await dependencies.admin.beginBreakGlassRegistration({
        recoveryCode: body.recoveryCode,
        requestId: request.id
      });

      request.log.error(
        { adminUserId: ceremony.adminUserId, requestId: request.id },
        "admin break-glass recovery credential consumed"
      );

      return sendNoStore(
        reply,
        webAuthnOptionsResponseSchema.parse({
          ceremonyId: ceremony.ceremonyId,
          options: ceremony.options
        })
      );
    }
  );

  app.post(
    "/v1/admin/auth/break-glass/registration/verify",
    { config: { rateLimit: { ...BREAK_GLASS_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const body = verifyRegistrationBodySchema.parse(request.body ?? {});
      const target = await dependencies.admin.resolveBreakGlassCeremonyTarget(body.ceremonyId);
      if (!target) {
        throw new ApiError(
          400,
          "ADMIN_CEREMONY_EXPIRED",
          "This request expired. Please try again."
        );
      }

      const result = await dependencies.admin.completeRegistration({
        targetAdminUserId: target,
        actorAdminUserId: target,
        ceremonyId: body.ceremonyId,
        credential: body.credential,
        label: body.label,
        requestId: request.id,
        purpose: "BREAK_GLASS_REGISTRATION"
      });

      // No session is issued here on purpose. Recovery restores the ability to
      // sign in; it is not itself a sign-in.
      return sendNoStore(reply, { authenticatorId: result.authenticatorId });
    }
  );
}

function identityResponse(admin: AuthenticatedAdmin, stepUpTtlMilliseconds: number, now: Date) {
  // Reported so the UI can prompt before an action rather than after a refusal.
  // It is a hint: the server re-checks freshness on every sensitive request.
  const isFresh = hasFreshStepUp(
    {
      idleExpiresAt: admin.idleExpiresAt,
      hardExpiresAt: admin.hardExpiresAt,
      revokedAt: null,
      lastStepUpAt: admin.lastStepUpAt
    },
    now,
    stepUpTtlMilliseconds
  );
  const stepUpFresh =
    isFresh && admin.lastStepUpAt
      ? new Date(admin.lastStepUpAt.getTime() + stepUpTtlMilliseconds)
      : null;

  return adminIdentityResponseSchema.parse({
    adminUserId: admin.adminUserId,
    displayName: admin.displayName,
    role: admin.role,
    capabilities: capabilitiesForRole(admin.role),
    kioskScopes: admin.kioskScopes,
    session: {
      idleExpiresAt: admin.idleExpiresAt.toISOString(),
      hardExpiresAt: admin.hardExpiresAt.toISOString(),
      stepUpFreshUntil: stepUpFresh?.toISOString() ?? null
    }
  });
}

function setSessionCookies(
  reply: FastifyReply,
  cookies: AdminSessionCookiePair,
  secure: boolean
): void {
  // `__Host-` binds the cookie to this exact origin with no Domain attribute,
  // so a compromised sibling subdomain cannot set or read it. It requires
  // Secure and Path=/, which is why the admin origin must be HTTPS.
  reply.setCookie(ADMIN_SESSION_COOKIE, cookies.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    expires: cookies.hardExpiresAt
  });
  // Readable by the admin UI on purpose: it is the half of the double submit
  // the page echoes back in a header. It is not a credential on its own.
  reply.setCookie(ADMIN_CSRF_COOKIE, cookies.csrfToken, {
    httpOnly: false,
    secure,
    sameSite: "strict",
    path: "/",
    expires: cookies.hardExpiresAt
  });
}

function clearSessionCookies(reply: FastifyReply, secure: boolean): void {
  for (const name of [ADMIN_SESSION_COOKIE, ADMIN_CSRF_COOKIE]) {
    reply.setCookie(name, "", {
      httpOnly: name === ADMIN_SESSION_COOKIE,
      secure,
      sameSite: "strict",
      path: "/",
      expires: new Date(0)
    });
  }
}

function sendNoStore(reply: FastifyReply, payload: unknown) {
  return reply.header("cache-control", "no-store").send(payload);
}

/**
 * Buckets by source address. Admin routes run before a session exists on the
 * login path, so there is no account to bucket by, and hashing keeps the raw
 * address out of the limiter's key space.
 */
function adminRateKey(request: FastifyRequest): string {
  return `admin:${createHash("sha256").update(request.ip).digest("hex").slice(0, 32)}`;
}
