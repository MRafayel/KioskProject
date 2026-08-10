import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  adminAuthenticatorsResponseSchema,
  adminBoundWebAuthnOptionsResponseSchema,
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
import { adminRateKey, sendNoStore } from "./http.js";
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
/**
 * Recovery is rare and alarming, but initial provisioning needs two one-use
 * ceremonies per account. Thirty per hour supports a ten-admin rollout (and
 * retries) even when a reverse proxy makes everyone share one source address;
 * the sealed code itself has 256 bits and is not made guessable by this bound.
 */
const BREAK_GLASS_RATE = { max: 30, timeWindow: "1 hour" } as const;

export interface AdminRouteDependencies extends AdminAuthorizationDependencies {
  admin: AdminService;
  /** The only browser origin allowed to reach the admin control plane. */
  adminOrigin: string;
  stepUpTtlMilliseconds: number;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteDependencies
): void {
  const adminHost = new URL(dependencies.adminOrigin).host.toLowerCase();
  // CORS is necessarily shared by the kiosk, upload and admin applications at
  // the API boundary. Narrow it again here: an XSS in either customer-facing
  // application must not be able to make credentialed admin requests.
  // Non-browser clients with no browser metadata remain available for operator
  // tooling; browser requests also have to arrive through the configured host.
  app.addHook("onRequest", (request) => {
    if (!request.url.startsWith("/v1/admin/")) return Promise.resolve();
    const origin = request.headers.origin;
    const hasFetchMetadata = Object.keys(request.headers).some((name) =>
      name.startsWith("sec-fetch-")
    );
    const browserUserAgent = request.headers["user-agent"]?.toLowerCase().includes("mozilla/");
    const host = request.headers.host?.toLowerCase();
    const wrongExplicitOrigin =
      origin !== undefined && (Array.isArray(origin) || origin !== dependencies.adminOrigin);
    const wrongFetchContext =
      hasFetchMetadata &&
      (request.headers["sec-fetch-site"] !== "same-origin" || host !== adminHost);
    // Older browsers may omit Fetch Metadata on a same-origin GET, and such a
    // request also omits Origin. Their browser-only User-Agent is the remaining
    // signal that prevents a customer application's same-host dev proxy from
    // becoming an admin proxy. Non-browser clients may omit all three headers.
    const wrongLegacyBrowserHost = browserUserAgent === true && host !== adminHost;

    if (wrongExplicitOrigin || wrongFetchContext || wrongLegacyBrowserHost) {
      throw new ApiError(
        403,
        "ADMIN_ORIGIN_FORBIDDEN",
        "This origin cannot access the admin control plane."
      );
    }
    return Promise.resolve();
  });

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

      setSessionCookies(reply, cookies);
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
    clearSessionCookies(reply);
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
      return sendNoStore(
        reply,
        adminBoundWebAuthnOptionsResponseSchema.parse({
          ...ceremony,
          adminUserId: admin.adminUserId
        })
      );
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
      return sendNoStore(
        reply,
        adminBoundWebAuthnOptionsResponseSchema.parse({
          ...ceremony,
          adminUserId: admin.adminUserId
        })
      );
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
        actorSessionId: admin.sessionId,
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

function setSessionCookies(reply: FastifyReply, cookies: AdminSessionCookiePair): void {
  // `__Host-` binds the cookie to this exact host with no Domain attribute,
  // so a compromised sibling subdomain cannot set or read it. It requires
  // Secure and Path=/. Production therefore uses HTTPS; browsers also treat
  // localhost as a trustworthy context for the loopback-only development UI.
  reply.setCookie(ADMIN_SESSION_COOKIE, cookies.sessionToken, {
    httpOnly: true,
    // The Secure attribute is mandatory for the `__Host-` prefix. Browsers
    // treat localhost as a trustworthy context, so development must keep it
    // too; omitting it causes the cookie to be rejected rather than weakened.
    secure: true,
    sameSite: "strict",
    path: "/",
    expires: cookies.hardExpiresAt
  });
  // Readable by the admin UI on purpose: it is the half of the double submit
  // the page echoes back in a header. It is not a credential on its own.
  reply.setCookie(ADMIN_CSRF_COOKIE, cookies.csrfToken, {
    httpOnly: false,
    secure: true,
    sameSite: "strict",
    path: "/",
    expires: cookies.hardExpiresAt
  });
}

function clearSessionCookies(reply: FastifyReply): void {
  for (const name of [ADMIN_SESSION_COOKIE, ADMIN_CSRF_COOKIE]) {
    reply.setCookie(name, "", {
      httpOnly: name === ADMIN_SESSION_COOKIE,
      secure: true,
      sameSite: "strict",
      path: "/",
      expires: new Date(0)
    });
  }
}
