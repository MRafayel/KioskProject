import type { FastifyInstance } from "fastify";

import {
  adminChangesResponseSchema,
  previewChangeBodySchema,
  previewChangeResponseSchema,
  publishChangeBodySchema,
  publishChangeResponseSchema
} from "@printing-kiosk/admin-access";

import { authorizeAdmin, type AdminAuthorizationDependencies } from "./authorize.js";
import { adminNamespacedRateKey, createAdminAccountThrottle, sendNoStore } from "./http.js";
import type { AdminChangeService } from "./changes.js";

/**
 * Changing the prices: three routes, one of which changes anything.
 *
 *   GET  /v1/admin/changes           the change log, and the tariff in force   change.read
 *   POST /v1/admin/changes/preview   price a change out; writes nothing        change.read
 *   POST /v1/admin/changes           publish it                                pricing.publish
 *
 * Reading is Admin and Technical Admin: what the prices did, and when, is a
 * diagnostic question as much as an operational one. The preview is on the same
 * capability deliberately — it writes nothing, discloses nothing that
 * `pricing.read` does not already, and a support role modelling "what would this
 * do" is diagnostics. Publishing is Admin only, at R2, so it goes through the
 * ordinary `authorizeAdmin` door with a fresh assertion, exactly like
 * authorizing a refund.
 */

/**
 * A ceiling on change actions by source address.
 *
 * Lower than the people limit and much lower than the operator ones, because
 * this is the rarest thing anybody does here: a tariff changes a few times a
 * year. Behind a reverse proxy every Admin still shares one address, so the
 * meaningful bound is the per-session one below.
 */
const CHANGE_RATE = { max: 30, timeWindow: "1 minute" } as const;

/**
 * And a much tighter one per signed-in session.
 *
 * This is what a single stolen session can spend. Ten in a minute is already far
 * more than anybody making a considered change to every price in the estate
 * would need.
 */
const CHANGE_ACCOUNT_RATE = { max: 10, timeWindow: "1 minute" } as const;

export interface AdminChangeRouteDependencies extends AdminAuthorizationDependencies {
  changes: AdminChangeService;
}

export function registerAdminChangeRoutes(
  app: FastifyInstance,
  dependencies: AdminChangeRouteDependencies
): void {
  const changeRoute = {
    config: { rateLimit: { ...CHANGE_RATE, keyGenerator: adminNamespacedRateKey("changes") } }
  };
  const throttleAccount = createAdminAccountThrottle(app, {
    namespace: "changes",
    ...CHANGE_ACCOUNT_RATE
  });

  /** Every published change, newest first, beside the tariff in force. */
  app.get("/v1/admin/changes", changeRoute, async (request, reply) => {
    await authorizeAdmin(request, dependencies, "change.read");
    const result = await dependencies.changes.list();
    return sendNoStore(reply, adminChangesResponseSchema.parse(result));
  });

  /**
   * What these numbers would do to real prices.
   *
   * Writes nothing. The response says so through a Zod literal
   * (`published: false`), in the same way Phase 3's resolution response carries
   * `refundAuthorized: false` and Phase 4's carries `settled: false` — and it
   * carries the two digests the publish call has to echo back.
   */
  app.post("/v1/admin/changes/preview", changeRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "change.read");
    await throttleAccount(request, admin.sessionId);

    const body = previewChangeBodySchema.parse(request.body ?? {});
    const result = await dependencies.changes.preview(body);
    return sendNoStore(reply, previewChangeResponseSchema.parse(result));
  });

  /**
   * Publish the tariff.
   *
   * The one endpoint in the control plane whose response says something is now
   * in force. By the time it returns, kiosks are quoting the new prices — so the
   * body carries both versions, the one now live and the one it replaced, and a
   * `published: true` literal that no other code path can produce.
   */
  app.post("/v1/admin/changes", changeRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "pricing.publish", (refused) =>
      dependencies.changes.recordForbiddenAttempt(
        refused,
        "pricing.publish",
        "admin.change.publish",
        request.id
      )
    );
    await throttleAccount(request, admin.sessionId);

    const body = publishChangeBodySchema.parse(request.body ?? {});
    const result = await dependencies.changes.publish(admin, body, request.id);
    return sendNoStore(reply, publishChangeResponseSchema.parse(result));
  });
}
