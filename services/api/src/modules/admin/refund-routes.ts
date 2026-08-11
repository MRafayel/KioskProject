import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  authorizeRefundBodySchema,
  authorizeRefundResponseSchema
} from "@printing-kiosk/admin-access";

import { authorizeAdmin, type AdminAuthorizationDependencies } from "./authorize.js";
import { adminNamespacedRateKey, createAdminAccountThrottle } from "./http.js";
import { sendNoStore } from "./http.js";
import type { AdminRefundService } from "./refunds.js";

/**
 * The money route. One endpoint, in a file of its own.
 *
 * `operations-routes.ts` used to say that `refund.authorize` had no endpoint at
 * all — "not a disabled one, not a guarded one" — because the phase that
 * introduced it should be the phase reviewed for it. This is that phase, and
 * this is that review: the entire mutating surface that can cost money is one
 * handler, and it is not in the same file as the four that cannot.
 *
 * It runs on its own pool as its own database role, is rate-limited an order of
 * magnitude below the ordinary action limit, and requires a fresh WebAuthn
 * assertion because `refund.authorize` is R2. The authorization it writes is an
 * obligation, not a payment: no provider credential exists in this process.
 */

const printJobParams = z.object({ printJobId: z.string().uuid() });

/**
 * A ceiling on authorizations by source address, and a much lower one by
 * account.
 *
 * Deliberately far below the operator action limits next door. Authorizing a
 * refund is a considered act performed a handful of times a day at most, so a
 * rate anywhere near this is not somebody doing their job — and unlike a
 * recovery observation, each one of these costs real money.
 */
const REFUND_RATE = { max: 20, timeWindow: "1 minute" } as const;
const REFUND_ACCOUNT_RATE = { max: 10, timeWindow: "1 minute" } as const;

export interface AdminRefundRouteDependencies extends AdminAuthorizationDependencies {
  refunds: AdminRefundService;
}

export function registerAdminRefundRoutes(
  app: FastifyInstance,
  dependencies: AdminRefundRouteDependencies
): void {
  const throttleAccount = createAdminAccountThrottle(app, {
    namespace: "refund",
    ...REFUND_ACCOUNT_RATE
  });

  /**
   * Authorize a refund for a print that did not come out.
   *
   * The print job is the idempotency key, as it is for the observation this
   * decision rests on: a double-submitted form or a retried request cannot
   * produce two obligations against one print, and the unique index that
   * guarantees it is in the database rather than in this process.
   */
  app.post(
    "/v1/admin/print-jobs/:printJobId/refund-authorization",
    {
      config: { rateLimit: { ...REFUND_RATE, keyGenerator: adminNamespacedRateKey("refund") } }
    },
    async (request, reply) => {
      const admin = await authorizeAdmin(request, dependencies, "refund.authorize", (refused) =>
        dependencies.refunds.recordForbiddenAttempt(refused, request.id)
      );
      await throttleAccount(request, admin.sessionId);

      const params = printJobParams.parse(request.params);
      const body = authorizeRefundBodySchema.parse(request.body ?? {});
      const result = await dependencies.refunds.authorizeRefund(
        admin,
        params.printJobId,
        body,
        request.id
      );

      // 201 for a decision recorded, 200 for one that was already made, so a
      // client can tell "you did this" from "this was already done" without
      // reading a flag it might forget to check.
      return sendNoStore(
        reply.code(result.replayed ? 200 : 201),
        authorizeRefundResponseSchema.parse(result)
      );
    }
  );
}
