import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  acknowledgeIncidentBodySchema,
  acknowledgeIncidentResponseSchema,
  correctRecoveryBodySchema,
  correctRecoveryResponseSchema,
  resolveRecoveryBodySchema,
  resolveRecoveryResponseSchema,
  retryRetentionBodySchema,
  retryRetentionResponseSchema
} from "@printing-kiosk/admin-access";

import { authorizeAdmin, type AdminAuthorizationDependencies } from "./authorize.js";
import { adminNamespacedRateKey, createAdminAccountThrottle, sendNoStore } from "./http.js";
import type { AdminOperationsService } from "./operations.js";

/**
 * Everything the control plane can change that does not cost money.
 *
 * Four routes, and none of them can cause a payout: they record what a person
 * saw at a tray, correct such a record, ask retention to retry a run that gave
 * up, and note that somebody is looking at a failure. The connection they run
 * on holds no grant on `refunds` at all.
 *
 * `refund.authorize` is deliberately not here. It lives in `refund-routes.ts`,
 * on its own pool as its own database role, because the Phase 4 gate is that
 * the money path is structurally separate from the operator observation path —
 * and a separation that amounts to two handlers in one file is not one. Both
 * files are short for the same reason: a reviewer should be able to read the
 * whole of what a dashboard account can do.
 *
 * Authorization, CSRF and step-up are all `authorizeAdmin`'s job, in that
 * order, and a route cannot perform three of the four checks because there is
 * no way to ask for a subset. The two R2 routes require a fresh WebAuthn
 * assertion before they will run; the two R1 ones do not, because acknowledging
 * a failure changes nothing and asking retention to retry changes nothing the
 * worker was not already going to do.
 */

const printJobParams = z.object({ printJobId: z.string().uuid() });

/**
 * A ceiling on actions by source address.
 *
 * Much tighter than the read limit next door. Operator actions are typed by a
 * person after walking to a machine and looking at a tray, so anything
 * approaching this rate is not somebody doing their job.
 */
const ACTION_RATE = { max: 60, timeWindow: "1 minute" } as const;

/**
 * And a tighter one per signed-in session, applied after the session is known.
 *
 * This is what stops a stolen session from spending an honest operator's
 * allowance from behind the same office router.
 */
const ACTION_ACCOUNT_RATE = { max: 20, timeWindow: "1 minute" } as const;

export interface AdminOperationsRouteDependencies extends AdminAuthorizationDependencies {
  operations: AdminOperationsService;
}

export function registerAdminOperationsRoutes(
  app: FastifyInstance,
  dependencies: AdminOperationsRouteDependencies
): void {
  const actionRoute = {
    config: { rateLimit: { ...ACTION_RATE, keyGenerator: adminNamespacedRateKey("action") } }
  };
  const throttleAccount = createAdminAccountThrottle(app, {
    namespace: "action",
    ...ACTION_ACCOUNT_RATE
  });

  /**
   * Record what a person saw at the tray.
   *
   * The job identifier is the idempotency key, so a double-submitted form or a
   * retried request cannot produce two conflicting accounts of the same print.
   * There is no `Idempotency-Key` header to get wrong: the thing being resolved
   * is the thing that can only be resolved once.
   */
  app.post(
    "/v1/admin/print-jobs/:printJobId/recovery-resolution",
    actionRoute,
    async (request, reply) => {
      const admin = await authorizeAdmin(request, dependencies, "print.recovery.resolve");
      await throttleAccount(request, admin.sessionId);

      const params = printJobParams.parse(request.params);
      const body = resolveRecoveryBodySchema.parse(request.body ?? {});
      const result = await dependencies.operations.resolvePrintRecovery(
        admin,
        params.printJobId,
        body,
        request.id
      );

      // A replay reports 200 and a first recording reports 201, so a client can
      // tell "you did this" from "this was already done" without reading a flag
      // it might forget to check.
      return sendNoStore(
        reply.code(result.replayed ? 200 : 201),
        resolveRecoveryResponseSchema.parse(result)
      );
    }
  );

  /**
   * Correct an account of a print that turned out to be wrong.
   *
   * The record being superseded is named in the body rather than inferred from
   * the job, so correcting a record somebody has already superseded is a
   * conflict rather than a silent overwrite. `print.recovery.correct` is R2 and
   * is held by nobody who records observations.
   */
  app.post(
    "/v1/admin/print-jobs/:printJobId/recovery-correction",
    actionRoute,
    async (request, reply) => {
      const admin = await authorizeAdmin(request, dependencies, "print.recovery.correct");
      await throttleAccount(request, admin.sessionId);

      const params = printJobParams.parse(request.params);
      const body = correctRecoveryBodySchema.parse(request.body ?? {});
      const result = await dependencies.operations.correctPrintRecovery(
        admin,
        params.printJobId,
        body,
        request.id
      );

      return sendNoStore(
        reply.code(result.replayed ? 200 : 201),
        correctRecoveryResponseSchema.parse(result)
      );
    }
  );

  /**
   * Ask retention to try a dead-lettered cleanup run again.
   *
   * R1, and no step-up: a dead-lettered run means a customer's documents are
   * still there after this system promised they would be gone, and putting an
   * extra ceremony between a person and "try again" would be protecting the
   * wrong thing. It appends a request; the worker re-arms its own run.
   */
  app.post("/v1/admin/retention/retry", actionRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "document.retention.retry");
    await throttleAccount(request, admin.sessionId);

    const body = retryRetentionBodySchema.parse(request.body ?? {});
    const result = await dependencies.operations.retryRetention(admin, body, request.id);

    return sendNoStore(
      reply.code(result.replayed ? 200 : 201),
      retryRetentionResponseSchema.parse(result)
    );
  });

  /**
   * Say that somebody is looking at a failure group.
   *
   * The group has to exist before this is recorded. Without that check the
   * endpoint would be a way to write caller-chosen text into a permanent,
   * append-only log that operators read back.
   */
  app.post("/v1/admin/incidents/acknowledge", actionRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "incident.acknowledge");
    await throttleAccount(request, admin.sessionId);

    const body = acknowledgeIncidentBodySchema.parse(request.body ?? {});
    const acknowledgement = await dependencies.operations.acknowledgeIncident(
      admin,
      body,
      request.id
    );

    return sendNoStore(
      reply.code(201),
      acknowledgeIncidentResponseSchema.parse({ acknowledgement })
    );
  });
}
