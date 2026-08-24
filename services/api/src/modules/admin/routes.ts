import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  adminAuthenticatorsResponseSchema,
  adminBoundWebAuthnOptionsResponseSchema,
  adminHealthResponseSchema,
  adminIdentityResponseSchema,
  adminInvitationsResponseSchema,
  adminLockedIdentityResponseSchema,
  adminOwnSessionsResponseSchema,
  beginBreakGlassBodySchema,
  capabilitiesForRole,
  changePasswordBodySchema,
  changePasswordResponseSchema,
  completePasswordResetBodySchema,
  completePasswordResetResponseSchema,
  createInvitationBodySchema,
  createInvitationResponseSchema,
  hasFreshStepUp,
  invitationCodeBodySchema,
  invitationPasswordBodySchema,
  invitationPreviewResponseSchema,
  invitationProgressResponseSchema,
  invitationRegistrationBodySchema,
  issuePasswordResetBodySchema,
  issuePasswordResetResponseSchema,
  passwordLoginBodySchema,
  passwordLoginResponseSchema,
  passwordProofBodySchema,
  revokeAuthenticatorBodySchema,
  revokeOwnSessionsResponseSchema,
  strongAuthMethodForRole,
  verifyAuthenticationBodySchema,
  verifyRegistrationBodySchema,
  webAuthnOptionsResponseSchema
} from "@printing-kiosk/admin-access";

import { ApiError } from "../sessions/errors.js";
import { adminNamespacedRateKey, adminRateKey, sendNoStore } from "./http.js";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  authorizeAdmin,
  clientContext,
  describeAdminSession,
  requireAdminPresence,
  requireAdminSession,
  type AdminAuthorizationDependencies
} from "./authorize.js";
import type { AdminService, AdminSessionCookiePair, AuthenticatedAdmin } from "./service.js";

/**
 * The admin control plane's identity surface.
 *
 * Everything here is about who somebody is: proving it (a password for
 * everybody, a key on top for privileged roles), re-proving it at unlock and
 * step-up, managing sessions, passwords and keys, and the two code-authorised
 * ways in — invitations and password resets — plus sealed break-glass
 * recovery. No route in this file reads a customer session, document, payment
 * or print row.
 *
 * There is deliberately no route that reports whether an account exists: every
 * login, invitation and reset failure is one generic refusal.
 */

const authenticatorParamsSchema = z.object({ authenticatorId: z.string().uuid() });
const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const invitationParamsSchema = z.object({ invitationId: z.string().uuid() });
const resetParamsSchema = z.object({ resetId: z.string().uuid() });
const personParamsSchema = z.object({ adminUserId: z.string().uuid() });
const reasonBodySchema = z.object({ reason: z.string().trim().min(3).max(280) }).strict();

/** Ceremonies are cheap to start and expensive to brute-force; still, bound them. */
const CEREMONY_RATE = { max: 30, timeWindow: "1 minute" } as const;
const VERIFY_RATE = { max: 20, timeWindow: "1 minute" } as const;
/**
 * Password guessing gets a tighter bucket than ceremony traffic: a login
 * attempt is a human typing, and ten a minute from one address is already
 * somebody having a very bad day. The real defence is Argon2id and 256-bit
 * codes; this bound just makes the log quieter.
 */
const LOGIN_RATE = { max: 10, timeWindow: "1 minute" } as const;
/**
 * Recovery is rare and alarming; provisioning is routine. Both consume 256-bit
 * codes, which no rate below makes guessable — these bounds exist so the
 * endpoints are not a place to grind.
 */
const BREAK_GLASS_RATE = { max: 30, timeWindow: "1 hour" } as const;
const ONE_TIME_CODE_RATE = { max: 60, timeWindow: "1 hour" } as const;

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
  // Login
  // -------------------------------------------------------------------------

  app.post(
    "/v1/admin/auth/login",
    {
      config: {
        rateLimit: { ...LOGIN_RATE, keyGenerator: adminNamespacedRateKey("login") }
      }
    },
    async (request, reply) => {
      const body = passwordLoginBodySchema.parse(request.body ?? {});
      const result = await dependencies.admin.loginWithPassword({
        username: body.username,
        password: body.password,
        requestId: request.id,
        client: clientContext(request)
      });

      if (result.state === "WEBAUTHN_REQUIRED") {
        return sendNoStore(
          reply,
          passwordLoginResponseSchema.parse({
            state: "WEBAUTHN_REQUIRED",
            ceremonyId: result.ceremonyId,
            options: result.options
          })
        );
      }

      setSessionCookies(reply, result.cookies);
      return sendNoStore(
        reply,
        passwordLoginResponseSchema.parse({
          state: "AUTHENTICATED",
          identity: identityResponse(
            result.admin,
            dependencies.stepUpTtlMilliseconds,
            dependencies.clock.now()
          )
        })
      );
    }
  );

  app.post(
    "/v1/admin/auth/login/webauthn",
    { config: { rateLimit: { ...VERIFY_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const body = verifyAuthenticationBodySchema.parse(request.body ?? {});
      const { admin, cookies } = await dependencies.admin.completeLoginWebAuthn({
        ceremonyId: body.ceremonyId,
        credential: body.credential,
        requestId: request.id,
        client: clientContext(request)
      });

      setSessionCookies(reply, cookies);
      return sendNoStore(
        reply,
        identityResponse(admin, dependencies.stepUpTtlMilliseconds, dependencies.clock.now())
      );
    }
  );

  app.post("/v1/admin/auth/logout", async (request, reply) => {
    // A locked session may log out: walking away and then choosing "not me,
    // sign out" must not require reauthenticating first.
    const presence = await requireAdminPresence(request, dependencies);
    const subject =
      presence.state === "ACTIVE"
        ? {
            adminUserId: presence.admin.adminUserId,
            sessionId: presence.admin.sessionId,
            role: presence.admin.role
          }
        : {
            adminUserId: presence.locked.adminUserId,
            sessionId: presence.locked.sessionId,
            role: presence.locked.role
          };
    await dependencies.admin.revokeSession({
      ...subject,
      reason: "USER_LOGOUT",
      requestId: request.id
    });
    clearSessionCookies(reply);
    return reply.header("cache-control", "no-store").code(204).send();
  });

  // -------------------------------------------------------------------------
  // Unlock
  // -------------------------------------------------------------------------

  app.post(
    "/v1/admin/auth/unlock/options",
    { config: { rateLimit: { ...CEREMONY_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const presence = await requireAdminPresence(request, dependencies);
      if (presence.state !== "LOCKED") {
        throw new ApiError(409, "ADMIN_SESSION_NOT_LOCKED", "This session is not locked.");
      }
      const ceremony = await dependencies.admin.beginUnlock(presence.locked);
      return sendNoStore(
        reply,
        adminBoundWebAuthnOptionsResponseSchema.parse({
          ...ceremony,
          adminUserId: presence.locked.adminUserId
        })
      );
    }
  );

  app.post(
    "/v1/admin/auth/unlock/verify",
    { config: { rateLimit: { ...VERIFY_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const presence = await requireAdminPresence(request, dependencies);
      if (presence.state !== "LOCKED") {
        throw new ApiError(409, "ADMIN_SESSION_NOT_LOCKED", "This session is not locked.");
      }
      const body = verifyAuthenticationBodySchema.parse(request.body ?? {});
      const admin = await dependencies.admin.completeUnlock({
        locked: presence.locked,
        ceremonyId: body.ceremonyId,
        credential: body.credential,
        requestId: request.id
      });
      return sendNoStore(
        reply,
        identityResponse(admin, dependencies.stepUpTtlMilliseconds, dependencies.clock.now())
      );
    }
  );

  app.post(
    "/v1/admin/auth/unlock/password",
    { config: { rateLimit: { ...LOGIN_RATE, keyGenerator: adminNamespacedRateKey("unlock") } } },
    async (request, reply) => {
      const presence = await requireAdminPresence(request, dependencies);
      if (presence.state !== "LOCKED") {
        throw new ApiError(409, "ADMIN_SESSION_NOT_LOCKED", "This session is not locked.");
      }
      const body = passwordProofBodySchema.parse(request.body ?? {});
      const admin = await dependencies.admin.unlockWithPassword({
        locked: presence.locked,
        password: body.password,
        requestId: request.id
      });
      return sendNoStore(
        reply,
        identityResponse(admin, dependencies.stepUpTtlMilliseconds, dependencies.clock.now())
      );
    }
  );

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

  app.post(
    "/v1/admin/auth/step-up/password",
    { config: { rateLimit: { ...LOGIN_RATE, keyGenerator: adminNamespacedRateKey("step-up") } } },
    async (request, reply) => {
      const admin = await requireAdminSession(request, dependencies);
      const body = passwordProofBodySchema.parse(request.body ?? {});
      const steppedUpAt = await dependencies.admin.stepUpWithPassword({
        admin,
        password: body.password,
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
    const resolution = await describeAdminSession(request, dependencies);
    if (!resolution) {
      throw new ApiError(401, "ADMIN_AUTHENTICATION_REQUIRED", "Sign in to continue.");
    }
    if (resolution.state === "LOCKED") {
      return sendNoStore(
        reply,
        adminLockedIdentityResponseSchema.parse({
          state: "LOCKED",
          displayName: resolution.locked.displayName,
          strongAuthMethod: strongAuthMethodForRole(resolution.locked.role)
        })
      );
    }
    return sendNoStore(
      reply,
      identityResponse(
        resolution.admin,
        dependencies.stepUpTtlMilliseconds,
        dependencies.clock.now()
      )
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
  // One's own sessions and password
  // -------------------------------------------------------------------------

  app.get("/v1/admin/account/sessions", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "account.sessions.read");
    const sessions = await dependencies.admin.listOwnSessions(admin);
    return sendNoStore(
      reply,
      adminOwnSessionsResponseSchema.parse({
        items: sessions.map((session) => ({
          sessionId: session.sessionId,
          createdAt: session.createdAt.toISOString(),
          lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
          state: session.state,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          current: session.current
        }))
      })
    );
  });

  app.post("/v1/admin/account/sessions/:sessionId/revoke", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "account.sessions.revoke");
    const params = sessionParamsSchema.parse(request.params);
    if (params.sessionId === admin.sessionId) {
      throw new ApiError(
        409,
        "ADMIN_SESSION_IS_CURRENT",
        "This is the session you are using. Log out instead."
      );
    }
    await dependencies.admin.revokeOwnSession({
      admin,
      sessionId: params.sessionId,
      requestId: request.id
    });
    return reply.header("cache-control", "no-store").code(204).send();
  });

  app.post("/v1/admin/account/sessions/revoke-others", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "account.sessions.revoke");
    const result = await dependencies.admin.revokeOtherSessions({
      admin,
      requestId: request.id
    });
    return sendNoStore(reply, revokeOwnSessionsResponseSchema.parse(result));
  });

  app.post("/v1/admin/account/password", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "account.password.change");
    const body = changePasswordBodySchema.parse(request.body ?? {});
    const result = await dependencies.admin.changeOwnPassword({
      admin,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      requestId: request.id
    });
    return sendNoStore(reply, changePasswordResponseSchema.parse(result));
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
      // Enrolling onto your own account. Retiring somebody else's is the
      // people module's separate capability.
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
  // Invitations — the authorized side
  // -------------------------------------------------------------------------

  app.post("/v1/admin/invitations", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "invitation.manage");
    const body = createInvitationBodySchema.parse(request.body ?? {});
    const invitation = await dependencies.admin.createInvitation({
      actor: admin,
      username: body.username,
      displayName: body.displayName,
      role: body.role,
      reason: body.reason,
      requestId: request.id
    });
    return sendNoStore(
      reply,
      createInvitationResponseSchema.parse({
        invitationId: invitation.invitationId,
        adminUserId: invitation.adminUserId,
        username: body.username,
        role: body.role,
        invitationCode: invitation.invitationCode,
        expiresAt: invitation.expiresAt.toISOString()
      })
    );
  });

  app.get("/v1/admin/invitations", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "invitation.read");
    const invitations = await dependencies.admin.listInvitations(admin);
    return sendNoStore(
      reply,
      adminInvitationsResponseSchema.parse({
        items: invitations.map((invitation) => ({
          invitationId: invitation.invitationId,
          adminUserId: invitation.adminUserId,
          username: invitation.username,
          displayName: invitation.displayName,
          role: invitation.role,
          issuedByDisplayName: invitation.issuedByDisplayName,
          createdAt: invitation.createdAt.toISOString(),
          expiresAt: invitation.expiresAt.toISOString(),
          status: invitation.status
        }))
      })
    );
  });

  app.post("/v1/admin/invitations/:invitationId/revoke", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "invitation.manage");
    const params = invitationParamsSchema.parse(request.params);
    await dependencies.admin.revokeInvitation({
      actor: admin,
      invitationId: params.invitationId,
      requestId: request.id
    });
    return reply.header("cache-control", "no-store").code(204).send();
  });

  app.post("/v1/admin/people/:adminUserId/invitation", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "invitation.manage");
    const params = personParamsSchema.parse(request.params);
    const body = reasonBodySchema.parse(request.body ?? {});
    const invitation = await dependencies.admin.reissueInvitation({
      actor: admin,
      targetAdminUserId: params.adminUserId,
      reason: body.reason,
      requestId: request.id
    });
    return sendNoStore(reply, {
      invitationId: invitation.invitationId,
      invitationCode: invitation.invitationCode,
      expiresAt: invitation.expiresAt.toISOString()
    });
  });

  // -------------------------------------------------------------------------
  // Password recovery — the authorized side
  // -------------------------------------------------------------------------

  app.post("/v1/admin/people/:adminUserId/password-reset", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "recovery.manage");
    const params = personParamsSchema.parse(request.params);
    const body = issuePasswordResetBodySchema.parse(request.body ?? {});
    const reset = await dependencies.admin.issuePasswordReset({
      actor: admin,
      targetAdminUserId: params.adminUserId,
      reason: body.reason,
      requestId: request.id
    });
    return sendNoStore(
      reply,
      issuePasswordResetResponseSchema.parse({
        resetId: reset.resetId,
        targetAdminUserId: params.adminUserId,
        targetDisplayName: reset.targetDisplayName,
        resetCode: reset.resetCode,
        expiresAt: reset.expiresAt.toISOString()
      })
    );
  });

  app.post("/v1/admin/password-resets/:resetId/revoke", async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "recovery.manage");
    const params = resetParamsSchema.parse(request.params);
    await dependencies.admin.revokePasswordReset({
      actor: admin,
      resetId: params.resetId,
      requestId: request.id
    });
    return reply.header("cache-control", "no-store").code(204).send();
  });

  // -------------------------------------------------------------------------
  // Invitation acceptance — the unauthenticated side
  // -------------------------------------------------------------------------

  // Necessarily unauthenticated: the person accepting cannot sign in yet,
  // which is the entire problem an invitation solves. What bounds each request
  // is the 256-bit code — single-use in effect (it dies when the account
  // activates), expiring, revocable, and matched only as a digest.

  app.post(
    "/v1/admin/auth/invitation/preview",
    { config: { rateLimit: { ...ONE_TIME_CODE_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const body = invitationCodeBodySchema.parse(request.body ?? {});
      const preview = await dependencies.admin.previewInvitation({
        code: body.code,
        requestId: request.id
      });
      return sendNoStore(reply, invitationPreviewResponseSchema.parse(preview));
    }
  );

  app.post(
    "/v1/admin/auth/invitation/password",
    { config: { rateLimit: { ...ONE_TIME_CODE_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const body = invitationPasswordBodySchema.parse(request.body ?? {});
      const progress = await dependencies.admin.setInvitationPassword({
        code: body.code,
        password: body.password,
        requestId: request.id
      });
      return sendNoStore(reply, invitationProgressResponseSchema.parse(progress));
    }
  );

  app.post(
    "/v1/admin/auth/invitation/registration/options",
    { config: { rateLimit: { ...ONE_TIME_CODE_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const body = invitationCodeBodySchema.parse(request.body ?? {});
      const ceremony = await dependencies.admin.beginInvitationRegistration({
        code: body.code,
        requestId: request.id
      });
      request.log.info(
        { adminUserId: ceremony.adminUserId, requestId: request.id },
        "admin invitation key enrolment started"
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
    "/v1/admin/auth/invitation/registration/verify",
    { config: { rateLimit: { ...ONE_TIME_CODE_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const body = invitationRegistrationBodySchema.parse(request.body ?? {});
      const target = await dependencies.admin.resolveInvitationCeremonyTarget(
        body.ceremonyId,
        body.code
      );
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
        purpose: "INVITATION_REGISTRATION"
      });

      // No session here on purpose. Accepting an invitation makes signing in
      // possible; it is not itself a sign-in.
      return sendNoStore(reply, {
        authenticatorId: result.authenticatorId,
        activated: result.activated
      });
    }
  );

  // -------------------------------------------------------------------------
  // Password reset completion — the unauthenticated side
  // -------------------------------------------------------------------------

  app.post(
    "/v1/admin/auth/password-reset/complete",
    { config: { rateLimit: { ...ONE_TIME_CODE_RATE, keyGenerator: adminRateKey } } },
    async (request, reply) => {
      const body = completePasswordResetBodySchema.parse(request.body ?? {});
      const result = await dependencies.admin.completePasswordReset({
        code: body.code,
        newPassword: body.newPassword,
        requestId: request.id
      });
      // No session: the person signs in with the password only they now know.
      return sendNoStore(reply, completePasswordResetResponseSchema.parse(result));
    }
  );

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
    state: "ACTIVE",
    adminUserId: admin.adminUserId,
    username: admin.username,
    displayName: admin.displayName,
    role: admin.role,
    capabilities: capabilitiesForRole(admin.role),
    kioskScopes: admin.kioskScopes,
    strongAuthMethod: strongAuthMethodForRole(admin.role),
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
  //
  // `expires` is the session's absolute limit, so the cookie survives browser
  // restarts for exactly as long as the server-side session could still be
  // valid. What the cookie's lifetime does NOT decide is whether the session
  // is usable: the server's own idle and absolute windows do that on every
  // request.
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
