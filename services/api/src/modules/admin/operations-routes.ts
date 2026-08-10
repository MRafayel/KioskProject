import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  acknowledgeIncidentBodySchema,
  acknowledgeIncidentResponseSchema,
  resolveRecoveryBodySchema,
  resolveRecoveryResponseSchema
} from "@printing-kiosk/admin-access";

import { authorizeAdmin, type AdminAuthorizationDependencies } from "./authorize.js";
import { adminNamespacedRateKey, createAdminAccountThrottle, sendNoStore } from "./http.js";
import type { AdminOperationsService } from "./operations.js";

/**
 * Everything the control plane can change.
 *
 * Two routes. That is the entire mutating surface of the admin panel, and
 * keeping it in one short file is deliberate: a reviewer should be able to see
 * the whole of what a dashboard account can do without reading anything else.
 *
 * Neither route moves money. `refund.authorize` has no endpoint at all — not a
 * disabled one, not a guarded one — because the phase that introduces it is the
 * phase that should be reviewed for it. An Operator can record that a print
 * appears to owe a refund; turning that into a payment is a different
 * capability, held by different people, and it does not exist here yet.
 *
 * Authorization, CSRF and step-up are all `authorizeAdmin`'s job, in that
 * order, and a route cannot perform three of the four checks because there is
 * no way to ask for a subset. `print.recovery.resolve` is R2, so a fresh
 * WebAuthn assertion is required before it will run; `incident.acknowledge` is
 * R1 and is not, because it changes nothing.
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
