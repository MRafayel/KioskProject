import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  adminAuditResponseSchema,
  adminDocumentsResponseSchema,
  adminErrorsResponseSchema,
  adminKiosksResponseSchema,
  adminOverviewResponseSchema,
  adminPaymentsResponseSchema,
  adminPeopleResponseSchema,
  adminPrintJobDetailResponseSchema,
  adminPrintJobsResponseSchema,
  adminRefundQueueResponseSchema,
  adminRefundsResponseSchema,
  adminRetentionResponseSchema,
  adminSessionDetailResponseSchema,
  adminSessionStateSchema,
  adminSessionsResponseSchema,
  adminTimelineResponseSchema,
  hasCapability
} from "@printing-kiosk/admin-access";

import { authorizeAdmin, type AdminAuthorizationDependencies } from "./authorize.js";
import {
  adminNamespacedRateKey,
  adminNotFound,
  createAdminAccountThrottle,
  sendNoStore
} from "./http.js";
import { scopeForAdmin, type AdminObservabilityService } from "./observability.js";

/**
 * The control plane's operational read surface.
 *
 * Every route in this file is a GET, and it stays that way. The two routes that
 * change something live in `operations-routes.ts` with their step-up,
 * eligibility revalidation and audit events, and keeping them apart means each
 * surface can be reviewed as a closed set — this one for what it discloses,
 * that one for what it permits.
 *
 * Each route names one capability and hands the result to a schema that decides
 * what may leave the process. Where a role difference changes the *content*
 * rather than the access — a provider reference, a device ledger — it is a
 * second `hasCapability` check inside the handler rather than a separate
 * endpoint, so the shape of the answer stays one thing.
 *
 * A record the caller may not see is a 404, never a 403. A 403 on an
 * out-of-scope identifier confirms that the identifier names something real,
 * which is the entire mechanism of an enumeration attack.
 */

const sessionParams = z.object({ sessionId: z.string().uuid() });
const printJobParams = z.object({ printJobId: z.string().uuid() });

/** A cursor is validated again by the decoder; this only bounds its size. */
const cursorSchema = z.string().max(120).optional();
const kioskIdSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/u)
  .optional();
/** Statuses are closed vocabularies written by this system, never free text. */
const statusSchema = z
  .string()
  .max(48)
  .regex(/^[A-Z_]+$/u)
  .optional();

const listQuerySchema = z.object({
  kioskId: kioskIdSchema,
  cursor: cursorSchema
});

const sessionsQuerySchema = listQuerySchema.extend({
  state: adminSessionStateSchema.optional()
});

const printJobsQuerySchema = listQuerySchema.extend({ status: statusSchema });
const paymentsQuerySchema = listQuerySchema.extend({ status: statusSchema });

const refundsQuerySchema = z.object({
  cursor: cursorSchema,
  /** Defaults to the obligations that still need settling — the reason to look. */
  unsettledOnly: z.enum(["true", "false"]).default("true")
});

/** The refund queue takes no filter: everything on it is waiting for somebody. */
const cursorQuerySchema = z.object({ cursor: cursorSchema });

const retentionQuerySchema = z.object({
  cursor: cursorSchema,
  problemsOnly: z.enum(["true", "false"]).default("false")
});

const errorsQuerySchema = z.object({
  /** One week is the longest window an incident review needs from a dashboard. */
  windowHours: z.coerce.number().int().min(1).max(168).default(24)
});

const auditQuerySchema = z.object({
  cursor: cursorSchema,
  kioskId: kioskIdSchema,
  sessionId: z.string().uuid().optional(),
  action: z
    .string()
    .max(100)
    .regex(/^[a-z0-9_.]+$/u)
    .optional()
});

/**
 * A ceiling on reads, keyed by source address.
 *
 * Generous, because a dashboard polls and several operators can share one
 * address behind a router. Its job is not to shape normal use but to stop an
 * anonymous flood from reaching the database at all.
 */
const READ_RATE = { max: 300, timeWindow: "1 minute" } as const;

/**
 * And a ceiling per signed-in session, applied once the session is known.
 *
 * The address limit cannot tell a stolen session from the colleagues sharing
 * its network. This one can: paging the entire operational history out of the
 * system costs the account doing it, not the office it is sitting in.
 */
const READ_ACCOUNT_RATE = { max: 240, timeWindow: "1 minute" } as const;

export interface AdminObservabilityRouteDependencies extends AdminAuthorizationDependencies {
  observability: AdminObservabilityService;
}

export function registerAdminObservabilityRoutes(
  app: FastifyInstance,
  dependencies: AdminObservabilityRouteDependencies
): void {
  const readRoute = {
    config: { rateLimit: { ...READ_RATE, keyGenerator: adminNamespacedRateKey("read") } }
  };
  const throttleAccount = createAdminAccountThrottle(app, {
    namespace: "read",
    ...READ_ACCOUNT_RATE
  });

  app.get("/v1/admin/overview", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "dashboard.read");
    await throttleAccount(request, admin.sessionId);
    const overview = await dependencies.observability.overview(scopeForAdmin(admin));
    return sendNoStore(reply, adminOverviewResponseSchema.parse(overview));
  });

  app.get("/v1/admin/kiosks", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "kiosk.read");
    await throttleAccount(request, admin.sessionId);
    const kiosks = await dependencies.observability.kiosks(scopeForAdmin(admin));
    return sendNoStore(reply, adminKiosksResponseSchema.parse(kiosks));
  });

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  app.get("/v1/admin/sessions", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "session.read");
    await throttleAccount(request, admin.sessionId);
    const query = sessionsQuerySchema.parse(request.query ?? {});
    const sessions = await dependencies.observability.sessions(scopeForAdmin(admin), query);
    return sendNoStore(reply, adminSessionsResponseSchema.parse(sessions));
  });

  app.get("/v1/admin/sessions/:sessionId", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "session.read");
    await throttleAccount(request, admin.sessionId);
    const params = sessionParams.parse(request.params);
    const detail = await dependencies.observability.session(scopeForAdmin(admin), params.sessionId);
    if (!detail) throw adminNotFound();
    return sendNoStore(reply, adminSessionDetailResponseSchema.parse(detail));
  });

  app.get("/v1/admin/sessions/:sessionId/timeline", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "session.timeline.read");
    await throttleAccount(request, admin.sessionId);
    const params = sessionParams.parse(request.params);
    const query = z.object({ cursor: cursorSchema }).parse(request.query ?? {});
    const timeline = await dependencies.observability.timeline(
      scopeForAdmin(admin),
      params.sessionId,
      query.cursor
    );
    if (!timeline) throw adminNotFound();
    return sendNoStore(reply, adminTimelineResponseSchema.parse(timeline));
  });

  /**
   * What a customer uploaded, described without describing it.
   *
   * There is no sibling route that returns a preview, a download, a storage URL
   * or a filename, and there is not going to be one: `docs/adr/0001` and the
   * build plan both say administrators see operational metadata only, and the
   * reader role holds no grant that would make a different answer possible.
   */
  app.get("/v1/admin/sessions/:sessionId/documents", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "document.metadata.read");
    await throttleAccount(request, admin.sessionId);
    const params = sessionParams.parse(request.params);
    const documents = await dependencies.observability.documents(
      scopeForAdmin(admin),
      params.sessionId
    );
    if (!documents) throw adminNotFound();
    return sendNoStore(reply, adminDocumentsResponseSchema.parse(documents));
  });

  // ---------------------------------------------------------------------------
  // Printing
  // ---------------------------------------------------------------------------

  app.get("/v1/admin/print-jobs", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "print.read");
    await throttleAccount(request, admin.sessionId);
    const query = printJobsQuerySchema.parse(request.query ?? {});
    const jobs = await dependencies.observability.printJobs(scopeForAdmin(admin), query);
    return sendNoStore(reply, adminPrintJobsResponseSchema.parse(jobs));
  });

  app.get("/v1/admin/print-jobs/:printJobId", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "print.read");
    await throttleAccount(request, admin.sessionId);
    const params = printJobParams.parse(request.params);
    // The device ledger is a deeper answer than the job's own state, so it is
    // the deeper capability. Everyone who may see the job still sees whether it
    // printed; only a Technical Admin sees every attempt that got it there.
    const detail = await dependencies.observability.printJob(
      scopeForAdmin(admin),
      params.printJobId,
      hasCapability(admin.role, "print.diagnostics.read")
    );
    if (!detail) throw adminNotFound();
    return sendNoStore(reply, adminPrintJobDetailResponseSchema.parse(detail));
  });

  // ---------------------------------------------------------------------------
  // Money
  // ---------------------------------------------------------------------------

  app.get("/v1/admin/payments", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "payment.read");
    await throttleAccount(request, admin.sessionId);
    const query = paymentsQuerySchema.parse(request.query ?? {});
    const payments = await dependencies.observability.payments(scopeForAdmin(admin), {
      ...query,
      // The provider's own identifier is what makes a row reconcilable against
      // the provider's ledger, and is therefore the reconciliation capability
      // rather than part of "this session was paid for".
      includeProviderReference: hasCapability(admin.role, "payment.reconcile.read")
    });
    return sendNoStore(reply, adminPaymentsResponseSchema.parse(payments));
  });

  /**
   * Money owed back, and how long it has been owed.
   *
   * Reading an obligation is not authorising one, and neither is settling it.
   * Authorizing is `refund.authorize` on its own route and its own connection;
   * settling belongs to an executor holding a provider credential, which no
   * part of the control plane has.
   */
  app.get("/v1/admin/refunds", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "refund.obligation.read");
    await throttleAccount(request, admin.sessionId);
    const query = refundsQuerySchema.parse(request.query ?? {});
    const refunds = await dependencies.observability.refunds(scopeForAdmin(admin), {
      unsettledOnly: query.unsettledOnly === "true",
      cursor: query.cursor
    });
    return sendNoStore(reply, adminRefundsResponseSchema.parse(refunds));
  });

  /**
   * The prints waiting for somebody who can decide about money.
   *
   * Read under `refund.obligation.read` rather than under `refund.authorize`:
   * seeing that a decision is outstanding is not the same as being able to make
   * it, and the queue is worth reading for anybody who can see the obligations
   * it turns into.
   *
   * Every row states the money in full — captured, already owed, and therefore
   * the most that may still be authorized — because the alternative is an Admin
   * doing that arithmetic from three screens.
   */
  app.get("/v1/admin/refund-queue", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "refund.obligation.read");
    await throttleAccount(request, admin.sessionId);
    const query = cursorQuerySchema.parse(request.query ?? {});
    const queue = await dependencies.observability.refundQueue(scopeForAdmin(admin), {
      cursor: query.cursor
    });
    return sendNoStore(reply, adminRefundQueueResponseSchema.parse(queue));
  });

  // ---------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------

  /**
   * Whether customer documents have actually been destroyed.
   *
   * This is the most important read in the panel. A dead-lettered cleanup means
   * documents that should not exist still do, and nothing else in the system
   * will say so on its own.
   */
  app.get("/v1/admin/retention", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "document.retention.read");
    await throttleAccount(request, admin.sessionId);
    const query = retentionQuerySchema.parse(request.query ?? {});
    const retention = await dependencies.observability.retention(scopeForAdmin(admin), {
      problemsOnly: query.problemsOnly === "true",
      cursor: query.cursor
    });
    return sendNoStore(reply, adminRetentionResponseSchema.parse(retention));
  });

  // ---------------------------------------------------------------------------
  // Errors and audit
  // ---------------------------------------------------------------------------

  app.get("/v1/admin/errors", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "error.read");
    await throttleAccount(request, admin.sessionId);
    const query = errorsQuerySchema.parse(request.query ?? {});
    const errors = await dependencies.observability.errors(scopeForAdmin(admin), query.windowHours);
    return sendNoStore(reply, adminErrorsResponseSchema.parse(errors));
  });

  /**
   * The append-only log.
   *
   * Authorised against `audit.read.self`, which every role holds, and then
   * widened to the whole log only for a role that also holds `audit.read`.
   * Doing it in that order means the narrower capability is the one that gates
   * the endpoint, so a role that lost `audit.read` would fall back to seeing
   * its own actions rather than failing open.
   */
  app.get("/v1/admin/audit", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "audit.read.self");
    await throttleAccount(request, admin.sessionId);
    const query = auditQuerySchema.parse(request.query ?? {});
    const audit = await dependencies.observability.audit(scopeForAdmin(admin), {
      selfActorId: hasCapability(admin.role, "audit.read") ? null : admin.adminUserId,
      cursor: query.cursor,
      kioskId: query.kioskId,
      sessionId: query.sessionId,
      action: query.action
    });
    return sendNoStore(reply, adminAuditResponseSchema.parse(audit));
  });

  /**
   * The Operators, and enough about each to decide what to do about them.
   *
   * Gated on `authenticator.manage.operator` rather than on `operator.manage`,
   * which is the looser of the two on purpose: a Technical Admin can issue an
   * enrolment ticket and retire a key, so it has to be able to see who it would
   * be doing that to. An Admin holds both and sees the same rows with more
   * controls beside them — the panel decides which to draw, and every one of
   * them is refused again by its own route.
   *
   * A read, so it runs on the read pool like every other list. The connection
   * that changes people is a different one and appears nowhere in this file.
   */
  app.get("/v1/admin/people", readRoute, async (request, reply) => {
    const admin = await authorizeAdmin(request, dependencies, "authenticator.manage.operator");
    await throttleAccount(request, admin.sessionId);
    const people = await dependencies.observability.people(dependencies.clock.now());
    return sendNoStore(reply, adminPeopleResponseSchema.parse(people));
  });
}
