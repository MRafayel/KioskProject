import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  changeAdminStatusBodySchema,
  changeAdminStatusResponseSchema,
  enrollmentTicketResponseSchema,
  issueEnrollmentTicketBodySchema,
  kioskAssignmentBodySchema,
  kioskAssignmentResponseSchema,
  revokeAdminSessionsBodySchema,
  revokeAdminSessionsResponseSchema,
  revokeOperatorAuthenticatorBodySchema,
  revokeOperatorAuthenticatorResponseSchema
} from "@printing-kiosk/admin-access";

import { authorizeAdmin, type AdminAuthorizationDependencies } from "./authorize.js";
import { adminNamespacedRateKey, createAdminAccountThrottle, sendNoStore } from "./http.js";
import type { AdminPeopleService } from "./people.js";

/**
 * Everything the control plane can change about a person.
 *
 * Five routes, on their own pool as their own database role, for the reason the
 * money route is on its own: this is the first surface that changes a row
 * somebody's access depends on, and a separation that amounts to two handlers in
 * one file is not one.
 *
 * They split across two capabilities, and the split is the phase's authorization
 * decision rather than a filing one:
 *
 *   `operator.manage`               status, kiosk assignment, ending sessions
 *   `authenticator.manage.operator` retiring a key, issuing an enrolment ticket
 *
 * An Admin holds both. A Technical Admin holds only the second, so it can get an
 * Operator onto a key at three in the morning and still cannot decide whether
 * that Operator may work, or where. Neither capability can change anybody's
 * role: no route here accepts one, and the connection they run on has no grant
 * on that column.
 *
 * Every route is R2, so every one of them needs a fresh WebAuthn assertion.
 * There is no R1 people action — the cheapest thing on this page still ends
 * somebody's ability to do their job.
 */

const personParams = z.object({ adminUserId: z.string().uuid() });
const authenticatorParams = personParams.extend({ authenticatorId: z.string().uuid() });

/**
 * A ceiling on people actions by source address.
 *
 * Deliberately not the tightest number available. Behind a reverse proxy every
 * Admin shares one source address, and onboarding a shift of new Operators is a
 * legitimate burst — the same argument the break-glass limit in `routes.ts`
 * makes. Rationing that by IP would ration colleagues against each other, so the
 * per-address bound is generous and the meaningful one is below.
 */
const PEOPLE_RATE = { max: 120, timeWindow: "1 minute" } as const;

/**
 * And a much tighter one per signed-in session, applied once the session is
 * known.
 *
 * This is the bound that matters: it is what a single stolen session can spend,
 * and administering people is rare enough that twenty in a minute from one
 * account is not somebody doing their job.
 */
const PEOPLE_ACCOUNT_RATE = { max: 20, timeWindow: "1 minute" } as const;

export interface AdminPeopleRouteDependencies extends AdminAuthorizationDependencies {
  people: AdminPeopleService;
}

export function registerAdminPeopleRoutes(
  app: FastifyInstance,
  dependencies: AdminPeopleRouteDependencies
): void {
  const peopleRoute = {
    config: { rateLimit: { ...PEOPLE_RATE, keyGenerator: adminNamespacedRateKey("people") } }
  };
  const throttleAccount = createAdminAccountThrottle(app, {
    namespace: "people",
    ...PEOPLE_ACCOUNT_RATE
  });

  /**
   * Suspend, resume or disable an Operator.
   *
   * Anything but resuming ends every session the account holds, in the same
   * transaction. The response says how many, because "suspended" and
   * "suspended, and the two browsers that were signed in are now signed out"
   * are different pieces of news to whoever just did it.
   */
  app.post("/v1/admin/people/:adminUserId/status", peopleRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "operator.manage", (refused) =>
      dependencies.people.recordForbiddenAttempt(
        refused,
        "operator.manage",
        "admin.people.status",
        request.id
      )
    );
    await throttleAccount(request, admin.sessionId);

    const params = personParams.parse(request.params);
    const body = changeAdminStatusBodySchema.parse(request.body ?? {});
    const result = await dependencies.people.changeStatus(
      admin,
      params.adminUserId,
      body,
      request.id
    );
    return sendNoStore(reply, changeAdminStatusResponseSchema.parse(result));
  });

  /**
   * Give an Operator a kiosk, or take one back.
   *
   * Both directions go through one route with a boolean, rather than two routes,
   * because they are one decision with one audit vocabulary — and because a
   * reviewer comparing "what does granting do" with "what does revoking do"
   * should not have to hold two handlers in their head.
   */
  app.post("/v1/admin/people/:adminUserId/kiosks", peopleRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "operator.manage", (refused) =>
      dependencies.people.recordForbiddenAttempt(
        refused,
        "operator.manage",
        "admin.people.kiosk",
        request.id
      )
    );
    await throttleAccount(request, admin.sessionId);

    const params = personParams.parse(request.params);
    const body = kioskAssignmentBodySchema.parse(request.body ?? {});
    const result = await dependencies.people.assignKiosk(
      admin,
      params.adminUserId,
      body,
      request.id
    );
    return sendNoStore(reply, kioskAssignmentResponseSchema.parse(result));
  });

  /**
   * Sign an Operator out everywhere, leaving the account alone.
   *
   * The reversible one: they sign back in with a key they still hold. It exists
   * for the case that is not yet a suspension, where waiting to be sure is the
   * expensive option.
   */
  app.post("/v1/admin/people/:adminUserId/sessions/revoke", peopleRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "operator.manage", (refused) =>
      dependencies.people.recordForbiddenAttempt(
        refused,
        "operator.manage",
        "admin.people.sessions.revoke",
        request.id
      )
    );
    await throttleAccount(request, admin.sessionId);

    const params = personParams.parse(request.params);
    const body = revokeAdminSessionsBodySchema.parse(request.body ?? {});
    const result = await dependencies.people.revokeSessions(
      admin,
      params.adminUserId,
      body,
      request.id
    );
    return sendNoStore(reply, revokeAdminSessionsResponseSchema.parse(result));
  });

  /**
   * Retire one of an Operator's security keys.
   *
   * Refused when it would take an active account below its minimum. There is no
   * password to fall back on in this system, so a revocation that leaves nothing
   * behind is a lockout rather than a cleanup.
   */
  app.post(
    "/v1/admin/people/:adminUserId/authenticators/:authenticatorId/revoke",
    peopleRoute,
    async (request, reply) => {
      const admin = await authorizeAdmin(
        request,
        dependencies,
        "authenticator.manage.operator",
        (refused) =>
          dependencies.people.recordForbiddenAttempt(
            refused,
            "authenticator.manage.operator",
            "admin.people.authenticator.revoke",
            request.id
          )
      );
      await throttleAccount(request, admin.sessionId);

      const params = authenticatorParams.parse(request.params);
      const body = revokeOperatorAuthenticatorBodySchema.parse(request.body ?? {});
      const result = await dependencies.people.revokeAuthenticator(
        admin,
        params.adminUserId,
        params.authenticatorId,
        body,
        request.id
      );
      return sendNoStore(reply, revokeOperatorAuthenticatorResponseSchema.parse(result));
    }
  );

  /**
   * Authorise one enrolment ceremony for an Operator who has no key yet.
   *
   * The response carries the code, once. It is not stored in readable form, not
   * logged, and not written into the audit event — so an Admin who loses it
   * issues another rather than looking it up. `sendNoStore` is doing real work
   * here rather than being applied by habit: this is the only response in the
   * control plane that contains a credential.
   */
  app.post(
    "/v1/admin/people/:adminUserId/enrollment-ticket",
    peopleRoute,
    async (request, reply) => {
      const admin = await authorizeAdmin(
        request,
        dependencies,
        "authenticator.manage.operator",
        (refused) =>
          dependencies.people.recordForbiddenAttempt(
            refused,
            "authenticator.manage.operator",
            "admin.people.enrollment.issue",
            request.id
          )
      );
      await throttleAccount(request, admin.sessionId);

      const params = personParams.parse(request.params);
      const body = issueEnrollmentTicketBodySchema.parse(request.body ?? {});
      const ticket = await dependencies.people.issueEnrollmentTicket(
        admin,
        params.adminUserId,
        body,
        request.id
      );
      return sendNoStore(reply, enrollmentTicketResponseSchema.parse(ticket));
    }
  );
}
