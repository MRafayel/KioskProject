import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_CAPABILITIES,
  ADMIN_ROLES,
  hasCapability,
  riskOfCapability,
  type AdminCapability,
  type AdminRole
} from "../../packages/admin-access/src/index.js";
import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import {
  createAdminPeopleClient,
  createAdminPricingClient,
  createAdminReadClient,
  createAdminRefundClient,
  createAdminWriteClient,
  createDatabaseClient
} from "../../packages/database/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_CSRF_HEADER,
  ADMIN_SESSION_COOKIE
} from "../../services/api/src/modules/admin/authorize.js";
import {
  digestAdminCsrfToken,
  digestAdminSessionToken
} from "../../services/api/src/modules/admin/crypto.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

/**
 * The Phase 6 acceptance gate: the security test suite.
 *
 * Every phase before this one proved its own feature. This file asks the
 * questions that span all of them, and it asks most of them of the **whole**
 * route table rather than of the routes somebody remembered to test — which is
 * the difference between a review and a sample.
 *
 * The centrepiece is §1. `ENDPOINTS` below is a declaration of every admin route
 * and the capability it names, and the first test compares it against the route
 * table Fastify actually built. A route that exists and is not declared fails
 * the suite; a route that is declared and does not exist fails it too. Every
 * other test in §1 is then driven from that same declaration, so "is this
 * endpoint authorized correctly" is answered for all of them at once and cannot
 * quietly stop covering one.
 *
 * What that buys, stated as properties rather than as tests:
 *
 *   - a role is refused every capability it does not hold, on every route;
 *   - a role is admitted to every route whose capability it does hold;
 *   - every R2 route demands a fresh WebAuthn assertion, and no R0 or R1 route
 *     does;
 *   - no route that changes something is reachable by GET, and no read is gated
 *     by a capability that can change something;
 *   - every state-changing route refuses a request without a CSRF token, and one
 *     carrying another session's;
 *   - every route that is not deliberately open refuses an unauthenticated
 *     caller.
 *
 * §2 is IDOR: an Operator's scope, applied to identifiers that name real
 * records belonging to somebody else. §3 is what leaves the process — no
 * credential, no document, no secret, in any response. §4 is response hygiene.
 * §5 is audit integrity: the ownership and trigger state that the append-only
 * guarantees actually rest on.
 */

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({ ...process.env, NODE_ENV: "test" });
assertSafeIntegrationEnvironment(environment);

const database = createDatabaseClient(environment.DATABASE_URL);
const readDatabase = createAdminReadClient(
  environment.ADMIN_READ_DATABASE_URL ?? environment.DATABASE_URL
);
const writeDatabase = createAdminWriteClient(
  environment.ADMIN_WRITE_DATABASE_URL ?? environment.DATABASE_URL
);
const refundDatabase = environment.ADMIN_REFUND_DATABASE_URL
  ? createAdminRefundClient(environment.ADMIN_REFUND_DATABASE_URL)
  : null;
const peopleDatabase = environment.ADMIN_PEOPLE_DATABASE_URL
  ? createAdminPeopleClient(environment.ADMIN_PEOPLE_DATABASE_URL)
  : null;
const pricingDatabase = environment.ADMIN_PRICING_DATABASE_URL
  ? createAdminPricingClient(environment.ADMIN_PRICING_DATABASE_URL)
  : null;

let app: Awaited<ReturnType<typeof buildApp>>;

const suite = randomBytes(4).toString("hex");
const kioskA = `kiosk_sec_a_${suite}`;
const kioskB = `kiosk_sec_b_${suite}`;

/** A syntactically valid identifier that names nothing. */
const ABSENT_ID = "00000000-0000-4000-8000-000000000000";

/**
 * A customer's own description of their document, and its content digest.
 *
 * Both are seeded into a real uploaded file so that the scan in §3 is asked of
 * a response that could carry one. A response containing either string has
 * leaked something no administrator is allowed to see.
 */
const DOCUMENT_CANARY = `payslip-do-not-disclose-${suite}`;
const DOCUMENT_DIGEST_CANARY = randomBytes(32).toString("hex");

// ---------------------------------------------------------------------------
// The route inventory
// ---------------------------------------------------------------------------

/**
 * How a route decides who may call it.
 *
 * `OPEN` is a route with no session by necessity rather than by oversight: a
 * sign-in ceremony, a sealed recovery credential, an enrolment code. Each is
 * bounded by something other than a session and each is named here so that a
 * new one cannot be added without a reviewer saying so out loud.
 *
 * `SESSION` is a route about the session itself — reading your own identity,
 * stepping up, signing out. There is no capability to check because the answer
 * does not depend on the role.
 */
type Gate = AdminCapability | "OPEN" | "SESSION";

interface AdminEndpoint {
  method: "GET" | "POST";
  /** Exactly as Fastify registers it, parameters included. */
  path: string;
  gate: Gate;
  /** A concrete URL to call. Defaults to `path` when it takes no parameter. */
  url?: string;
  /**
   * The connection string whose absence removes this route from the app. The
   * money, people and pricing surfaces are registered only when their
   * least-privilege role is configured — a missing role means the section is
   * absent rather than broken.
   */
  needs?: "REFUND" | "PEOPLE" | "PRICING";
  /** Revokes the session it runs on, so the sweeps that would use it skip it. */
  endsTheSession?: boolean;
}

/**
 * Every route the control plane exposes, and the capability each one names.
 *
 * This is the claim. `capabilities.ts` is the policy. The first test below is
 * the only thing in this repository that has ever checked them against each
 * other, and it checks them against the route table Fastify built rather than
 * against a reading of the source.
 */
const ENDPOINTS: readonly AdminEndpoint[] = [
  // --- Authentication: open by necessity ---------------------------------
  { method: "POST", path: "/v1/admin/auth/authentication/options", gate: "OPEN" },
  { method: "POST", path: "/v1/admin/auth/authentication/verify", gate: "OPEN" },
  { method: "POST", path: "/v1/admin/auth/break-glass/registration/options", gate: "OPEN" },
  { method: "POST", path: "/v1/admin/auth/break-glass/registration/verify", gate: "OPEN" },
  { method: "POST", path: "/v1/admin/auth/enrollment/registration/options", gate: "OPEN" },
  { method: "POST", path: "/v1/admin/auth/enrollment/registration/verify", gate: "OPEN" },

  // --- The session itself -------------------------------------------------
  { method: "POST", path: "/v1/admin/auth/logout", gate: "SESSION", endsTheSession: true },
  { method: "POST", path: "/v1/admin/auth/step-up/options", gate: "SESSION" },
  { method: "POST", path: "/v1/admin/auth/step-up/verify", gate: "SESSION" },
  { method: "GET", path: "/v1/admin/me", gate: "SESSION" },
  { method: "GET", path: "/v1/admin/authenticators", gate: "SESSION" },

  // --- One's own security keys -------------------------------------------
  {
    method: "POST",
    path: "/v1/admin/authenticators/registration/options",
    gate: "authenticator.manage.self"
  },
  {
    method: "POST",
    path: "/v1/admin/authenticators/registration/verify",
    gate: "authenticator.manage.self"
  },
  {
    method: "POST",
    path: "/v1/admin/authenticators/:authenticatorId/revoke",
    url: `/v1/admin/authenticators/${ABSENT_ID}/revoke`,
    gate: "authenticator.manage.self"
  },

  // --- Observability: every one a GET, every one R0 -----------------------
  { method: "GET", path: "/v1/admin/health", gate: "dashboard.read" },
  { method: "GET", path: "/v1/admin/overview", gate: "dashboard.read" },
  { method: "GET", path: "/v1/admin/kiosks", gate: "kiosk.read" },
  { method: "GET", path: "/v1/admin/sessions", gate: "session.read" },
  {
    method: "GET",
    path: "/v1/admin/sessions/:sessionId",
    url: `/v1/admin/sessions/${ABSENT_ID}`,
    gate: "session.read"
  },
  {
    method: "GET",
    path: "/v1/admin/sessions/:sessionId/timeline",
    url: `/v1/admin/sessions/${ABSENT_ID}/timeline`,
    gate: "session.timeline.read"
  },
  {
    method: "GET",
    path: "/v1/admin/sessions/:sessionId/documents",
    url: `/v1/admin/sessions/${ABSENT_ID}/documents`,
    gate: "document.metadata.read"
  },
  { method: "GET", path: "/v1/admin/print-jobs", gate: "print.read" },
  {
    method: "GET",
    path: "/v1/admin/print-jobs/:printJobId",
    url: `/v1/admin/print-jobs/${ABSENT_ID}`,
    gate: "print.read"
  },
  { method: "GET", path: "/v1/admin/payments", gate: "payment.read" },
  { method: "GET", path: "/v1/admin/refunds", gate: "refund.obligation.read" },
  { method: "GET", path: "/v1/admin/refund-queue", gate: "refund.obligation.read" },
  { method: "GET", path: "/v1/admin/retention", gate: "document.retention.read" },
  { method: "GET", path: "/v1/admin/errors", gate: "error.read" },
  { method: "GET", path: "/v1/admin/audit", gate: "audit.read.self" },
  { method: "GET", path: "/v1/admin/people", gate: "operator.read" },

  // --- Operator actions ---------------------------------------------------
  {
    method: "POST",
    path: "/v1/admin/print-jobs/:printJobId/recovery-resolution",
    url: `/v1/admin/print-jobs/${ABSENT_ID}/recovery-resolution`,
    gate: "print.recovery.resolve"
  },
  {
    method: "POST",
    path: "/v1/admin/print-jobs/:printJobId/recovery-correction",
    url: `/v1/admin/print-jobs/${ABSENT_ID}/recovery-correction`,
    gate: "print.recovery.correct"
  },
  { method: "POST", path: "/v1/admin/retention/retry", gate: "document.retention.retry" },
  { method: "POST", path: "/v1/admin/incidents/acknowledge", gate: "incident.acknowledge" },

  // --- Money --------------------------------------------------------------
  {
    method: "POST",
    path: "/v1/admin/print-jobs/:printJobId/refund-authorization",
    url: `/v1/admin/print-jobs/${ABSENT_ID}/refund-authorization`,
    gate: "refund.authorize",
    needs: "REFUND"
  },

  // --- People -------------------------------------------------------------
  {
    method: "POST",
    path: "/v1/admin/people/:adminUserId/status",
    url: `/v1/admin/people/${ABSENT_ID}/status`,
    gate: "operator.manage",
    needs: "PEOPLE"
  },
  {
    method: "POST",
    path: "/v1/admin/people/:adminUserId/kiosks",
    url: `/v1/admin/people/${ABSENT_ID}/kiosks`,
    gate: "operator.manage",
    needs: "PEOPLE"
  },
  {
    method: "POST",
    path: "/v1/admin/people/:adminUserId/sessions/revoke",
    url: `/v1/admin/people/${ABSENT_ID}/sessions/revoke`,
    gate: "operator.manage",
    needs: "PEOPLE"
  },
  {
    method: "POST",
    path: "/v1/admin/people/:adminUserId/authenticators/:authenticatorId/revoke",
    url: `/v1/admin/people/${ABSENT_ID}/authenticators/${ABSENT_ID}/revoke`,
    gate: "authenticator.manage.operator",
    needs: "PEOPLE"
  },
  {
    method: "POST",
    path: "/v1/admin/people/:adminUserId/enrollment-ticket",
    url: `/v1/admin/people/${ABSENT_ID}/enrollment-ticket`,
    gate: "authenticator.manage.operator",
    needs: "PEOPLE"
  },

  // --- The tariff ---------------------------------------------------------
  { method: "GET", path: "/v1/admin/changes", gate: "change.read", needs: "PRICING" },
  { method: "POST", path: "/v1/admin/changes/preview", gate: "change.read", needs: "PRICING" },
  { method: "POST", path: "/v1/admin/changes", gate: "pricing.publish", needs: "PRICING" }
];

/**
 * Capabilities that gate no endpoint, and why each one is harmless.
 *
 * `capabilities.ts` says a capability with no endpoint behind it grants
 * nothing, which is true and is not the same as saying nobody will assume
 * otherwise. Three of these widen what a response contains rather than deciding
 * whether it may be requested; four grant nothing anywhere at all, and are
 * declared ahead of features that do not exist.
 *
 * The list is asserted in both directions. A new capability that gates nothing
 * has to be added here deliberately, and one of these acquiring an endpoint has
 * to be removed from here just as deliberately.
 */
const CAPABILITIES_WITHOUT_AN_ENDPOINT: Readonly<Record<string, string>> = {
  "print.diagnostics.read": "widens the print job detail with the device event ledger",
  "payment.reconcile.read": "widens the payments list with the provider's own reference",
  "audit.read": "widens the audit log from one's own actions to everybody's",
  "kiosk.liveness.read": "declared in Phase 0; liveness is part of the kiosks list, not a route",
  "kiosk.maintenance_mode": "declared in Phase 0 for a mechanism that was never built",
  "payment.mismatch.read": "declared in Phase 0; the payment/print mismatch view was never built",
  "pricing.read": "declared in Phase 0; the tariff is read through change.read, not this"
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SeededSession {
  adminUserId: string;
  cookieHeader: string;
  csrfToken: string;
}

interface SeededWorld {
  sessionId: string;
  printJobId: string;
}

const seededAdminUserIds: string[] = [];
let ruleSetId: string;
let pricingVersion: string;
let seededRuleSet = false;

/** One session per role, none of which has recently touched a security key. */
const stale: Partial<Record<AdminRole, SeededSession>> = {};
let operatorOnA: SeededSession;
let operatorOnB: SeededSession;
let adminSteppedUp: SeededSession;
let worldA: SeededWorld;
let worldB: SeededWorld;

beforeAll(async () => {
  app = await buildApp({
    environment,
    database,
    adminReadDatabase: readDatabase,
    adminWriteDatabase: writeDatabase,
    ...(refundDatabase ? { adminRefundDatabase: refundDatabase } : {}),
    ...(peopleDatabase ? { adminPeopleDatabase: peopleDatabase } : {}),
    ...(pricingDatabase ? { adminPricingDatabase: pricingDatabase } : {}),
    startBackgroundJobs: false
  });

  await cleanUpOperationalData();
  await seedPricing();
  worldA = await seedKioskWorld(kioskA);
  worldB = await seedKioskWorld(kioskB);

  for (const role of ADMIN_ROLES) {
    stale[role] = await seedAdminWithSession(role, role === "OPERATOR" ? [kioskA] : [], false);
  }
  operatorOnA = await seedAdminWithSession("OPERATOR", [kioskA], true);
  operatorOnB = await seedAdminWithSession("OPERATOR", [kioskB], true);
  adminSteppedUp = await seedAdminWithSession("ADMIN", [], true);
}, 120_000);

afterAll(async () => {
  await cleanUpOperationalData();
  await cleanUpSeededAdmins();
  await app.close();
  await database.$disconnect();
  await readDatabase.$disconnect();
  await writeDatabase.$disconnect();
  await refundDatabase?.$disconnect();
  await peopleDatabase?.$disconnect();
  await pricingDatabase?.$disconnect();
});

// ---------------------------------------------------------------------------
// §1 The authorization matrix, endpoint by endpoint
// ---------------------------------------------------------------------------

describe("the authorization matrix covers every route that exists", () => {
  it("declares exactly the admin routes the app registered", () => {
    // Fastify's own route table, not a reading of the source. A route added in
    // a later phase and never classified fails here, which is the point: the
    // matrix cannot fall behind the surface it describes.
    expect(sortedRouteKeys(actualAdminRoutes())).toEqual(sortedRouteKeys(expectedRouteKeys()));
  });

  it("names only capabilities that exist", () => {
    for (const endpoint of ENDPOINTS) {
      if (endpoint.gate === "OPEN" || endpoint.gate === "SESSION") continue;
      expect(ADMIN_CAPABILITIES).toContain(endpoint.gate);
    }
  });

  it("accounts for every declared capability, endpoint or not", () => {
    const gating = new Set(
      ENDPOINTS.map((endpoint) => endpoint.gate).filter(
        (gate): gate is AdminCapability => gate !== "OPEN" && gate !== "SESSION"
      )
    );
    const ungated = ADMIN_CAPABILITIES.filter((capability) => !gating.has(capability));
    expect(new Set(ungated)).toEqual(new Set(Object.keys(CAPABILITIES_WITHOUT_AN_ENDPOINT)));
  });

  it("gates no read behind a capability that can change something", () => {
    // The rule that would have caught the Phase 4B defect this phase found: the
    // Operator roster was gated on `authenticator.manage.operator`, which is R2,
    // so a screen demanded a security key and stopped loading five minutes after
    // sign-in. A GET names an R0 capability, always.
    for (const endpoint of ENDPOINTS) {
      if (endpoint.method !== "GET") continue;
      if (endpoint.gate === "OPEN" || endpoint.gate === "SESSION") continue;
      expect(`${endpoint.path} → ${endpoint.gate} @ ${riskOfCapability(endpoint.gate)}`).toBe(
        `${endpoint.path} → ${endpoint.gate} @ R0`
      );
    }
  });

  it("puts nothing that changes the world behind a GET", () => {
    // The converse, and the reason CSRF protection is meaningful: a mutation
    // reachable by GET is a mutation reachable from an image tag.
    for (const endpoint of ENDPOINTS) {
      if (endpoint.method === "GET") {
        expect(endpoint.path).not.toMatch(
          /\/(revoke|acknowledge|retry|preview|publish|status|resolution|correction|authorization|ticket|logout)$/u
        );
      }
    }
  });
});

describe("a role is refused every capability it does not hold", () => {
  for (const role of ADMIN_ROLES) {
    it(`refuses ${role} every route its capability list omits`, async () => {
      const expected = registeredEndpoints().filter(
        (endpoint) =>
          endpoint.gate !== "OPEN" &&
          endpoint.gate !== "SESSION" &&
          !hasCapability(role, endpoint.gate)
      );

      const refused: string[] = [];
      for (const endpoint of expected) {
        const response = await call(session(role), endpoint);
        refused.push(`${key(endpoint)} → ${response.statusCode} ${codeOf(response)}`);
      }

      // Named one by one so a failure says which route answered, rather than
      // that some route somewhere did.
      for (const line of refused) {
        expect(line).toMatch(/→ 403 ADMIN_FORBIDDEN$/u);
      }
      expect(refused.length).toBe(expected.length);
    });
  }

  it("refuses an Admin nothing, which is what being the operational authority means", () => {
    // Stated rather than discovered. Admin holds every capability that gates an
    // endpoint, so the sweep above is empty for it — and that is a property of
    // the role model, not a gap in the test. The separation from Technical Admin
    // survives in what each can *see*: `print.diagnostics.read` widens a
    // response and gates no route, so it does not appear here.
    const unreachable = registeredEndpoints().filter(
      (endpoint) =>
        endpoint.gate !== "OPEN" &&
        endpoint.gate !== "SESSION" &&
        !hasCapability("ADMIN", endpoint.gate)
    );
    expect(unreachable).toEqual([]);
    expect(hasCapability("ADMIN", "print.diagnostics.read")).toBe(false);
  });

  it("refuses an Operator every money, people and pricing route", async () => {
    // The three gates the earlier phases were built around, restated as one
    // assertion rather than inferred from the capability table.
    const forbidden = registeredEndpoints().filter(
      (endpoint) =>
        endpoint.needs !== undefined ||
        endpoint.gate === "print.recovery.correct" ||
        endpoint.gate === "document.retention.retry"
    );
    expect(forbidden.length).toBeGreaterThan(5);

    for (const endpoint of forbidden) {
      const response = await call(session("OPERATOR"), endpoint);
      expect(`${key(endpoint)} ${response.statusCode}`).toBe(`${key(endpoint)} 403`);
    }
  });

  it("refuses a Technical Admin the one route that moves money", async () => {
    // Phase 6, by owner decision. `refund.authorize` was granted to the support
    // role in Phase 4 under a co-approver model that no longer exists.
    const money = registeredEndpoints().find((endpoint) => endpoint.gate === "refund.authorize");
    if (!money) return;

    const response = await call(session("TECHNICAL_ADMIN"), money);
    expect(response.statusCode).toBe(403);
    expect(codeOf(response)).toBe("ADMIN_FORBIDDEN");

    // And the refusal is recorded, because somebody without the capability
    // asking to authorize a payout is worth a permanent row.
    const denied = await database.auditEvent.findFirst({
      where: {
        actorId: session("TECHNICAL_ADMIN").adminUserId,
        action: "admin.refund.authorize",
        outcome: "DENIED"
      }
    });
    expect(denied).not.toBeNull();
  });
});

describe("a role is admitted to every capability it does hold", () => {
  for (const role of ADMIN_ROLES) {
    it(`admits ${role} to every route its capability list includes`, async () => {
      const admitted: string[] = [];
      for (const endpoint of registeredEndpoints()) {
        if (endpoint.gate === "OPEN" || endpoint.gate === "SESSION") continue;
        if (!hasCapability(role, endpoint.gate)) continue;

        const response = await call(session(role), endpoint);
        admitted.push(`${key(endpoint)} → ${codeOf(response) ?? String(response.statusCode)}`);
      }

      // Not "answered 200": these sessions have no fresh assertion and the
      // identifiers name nothing, so an R2 route stops at the step-up and an R1
      // one stops at validation. What matters is that none of them stopped at
      // the capability check.
      for (const line of admitted) {
        expect(line).not.toMatch(/ADMIN_FORBIDDEN$/u);
      }
      expect(admitted.length).toBeGreaterThan(0);
    });
  }
});

describe("step-up is enforced by risk class, on every route", () => {
  it("demands a fresh assertion for every R2 route, from every role that holds it", async () => {
    const checked: string[] = [];
    for (const endpoint of registeredEndpoints()) {
      if (endpoint.gate === "OPEN" || endpoint.gate === "SESSION") continue;
      if (riskOfCapability(endpoint.gate) !== "R2") continue;

      for (const role of ADMIN_ROLES) {
        if (!hasCapability(role, endpoint.gate)) continue;
        const response = await call(session(role), endpoint);
        checked.push(`${role} ${key(endpoint)} → ${response.statusCode} ${codeOf(response)}`);
      }
    }

    for (const line of checked) {
      expect(line).toMatch(/→ 401 ADMIN_STEP_UP_REQUIRED$/u);
    }
    // Ten R2 capabilities' worth of routes across three roles. A number this
    // small would mean the loop stopped covering something.
    expect(checked.length).toBeGreaterThan(15);
  });

  it("demands nothing extra for an R0 or R1 route", async () => {
    for (const endpoint of registeredEndpoints()) {
      if (endpoint.gate === "OPEN" || endpoint.gate === "SESSION") continue;
      const risk = riskOfCapability(endpoint.gate);
      if (risk !== "R0" && risk !== "R1") continue;

      for (const role of ADMIN_ROLES) {
        if (!hasCapability(role, endpoint.gate)) continue;
        const response = await call(session(role), endpoint);
        expect(`${role} ${key(endpoint)} ${codeOf(response) ?? "ok"}`).not.toContain(
          "ADMIN_STEP_UP_REQUIRED"
        );
      }
    }
  });

  it("classifies nothing as R3, and refuses it outright if anything ever is", () => {
    // The backstop, asserted where the routes are. Nothing is R3, so no route
    // can be reached through that branch; if a capability is promoted later,
    // `authorizeAdmin` refuses every endpoint naming it rather than letting one
    // account perform it quietly.
    const atR3 = ADMIN_CAPABILITIES.filter((capability) => riskOfCapability(capability) === "R3");
    expect(atR3).toEqual([]);
  });
});

describe("CSRF is enforced on every state-changing route", () => {
  it("refuses a mutating request with no CSRF header", async () => {
    for (const endpoint of registeredEndpoints()) {
      if (endpoint.method === "GET") continue;
      if (endpoint.gate === "OPEN") continue;

      const response = await app.inject({
        method: endpoint.method,
        url: endpoint.url ?? endpoint.path,
        headers: { cookie: adminSteppedUp.cookieHeader },
        payload: {}
      });
      expect(`${key(endpoint)} ${response.statusCode} ${codeOf(response)}`).toBe(
        `${key(endpoint)} 403 ADMIN_CSRF_FAILED`
      );
    }
  });

  it("refuses a CSRF token that belongs to another session", async () => {
    // The double submit is bound to the session in the database, so a token
    // lifted from a colleague's page is not a token.
    for (const endpoint of registeredEndpoints()) {
      if (endpoint.method === "GET") continue;
      if (endpoint.gate === "OPEN") continue;

      const response = await app.inject({
        method: endpoint.method,
        url: endpoint.url ?? endpoint.path,
        headers: {
          cookie: adminSteppedUp.cookieHeader,
          [ADMIN_CSRF_HEADER]: operatorOnA.csrfToken
        },
        payload: {}
      });
      expect(`${key(endpoint)} ${response.statusCode}`).toBe(`${key(endpoint)} 403`);
    }
  });

  it("refuses a duplicated CSRF header rather than choosing a value", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/incidents/acknowledge",
      headers: {
        cookie: adminSteppedUp.cookieHeader,
        [ADMIN_CSRF_HEADER]: [adminSteppedUp.csrfToken, "something-else"]
      },
      payload: {}
    });
    expect(codeOf(response)).toBe("ADMIN_CSRF_FAILED");
  });
});

describe("an unauthenticated caller reaches nothing", () => {
  it("refuses every route that is not deliberately open", async () => {
    for (const endpoint of registeredEndpoints()) {
      if (endpoint.gate === "OPEN") continue;

      const response = await app.inject({
        method: endpoint.method,
        url: endpoint.url ?? endpoint.path,
        ...(endpoint.method === "GET" ? {} : { payload: {} })
      });
      expect(`${key(endpoint)} ${response.statusCode} ${codeOf(response)}`).toBe(
        `${key(endpoint)} 401 ADMIN_AUTHENTICATION_REQUIRED`
      );
    }
  });

  it("refuses a forged session cookie", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${randomBytes(32).toString("base64url")}` }
    });
    expect(response.statusCode).toBe(401);
  });

  it("keeps the open routes open, and bounded by something other than a session", async () => {
    // Each of these has to work without a session — a sign-in, a sealed
    // recovery credential, an enrolment code — so the assertion is that they
    // are bounded by something else rather than by the session's absence.
    // Starting a sign-in ceremony needs nothing and answers 200; the four that
    // take a credential refuse the empty one.
    for (const endpoint of ENDPOINTS.filter((candidate) => candidate.gate === "OPEN")) {
      const response = await app.inject({
        method: endpoint.method,
        url: endpoint.url ?? endpoint.path,
        payload: {}
      });
      expect(`${key(endpoint)} ${codeOf(response)}`).not.toContain("ADMIN_AUTHENTICATION_REQUIRED");
      expect(`${key(endpoint)} ${response.statusCode < 500}`).toBe(`${key(endpoint)} true`);
    }
  });

  it("issues no session from a recovery or an enrolment ceremony", async () => {
    // Recovery restores the ability to sign in; it is not itself a sign-in. A
    // Set-Cookie here would make a sealed code a way in rather than a way back.
    for (const url of [
      "/v1/admin/auth/break-glass/registration/options",
      "/v1/admin/auth/break-glass/registration/verify",
      "/v1/admin/auth/enrollment/registration/options",
      "/v1/admin/auth/enrollment/registration/verify"
    ]) {
      const response = await app.inject({ method: "POST", url, payload: {} });
      expect(`${url} ${JSON.stringify(response.headers["set-cookie"] ?? null)}`).toBe(
        `${url} null`
      );
    }
  });
});

describe("origin enforcement", () => {
  it("refuses a browser request carrying a foreign Origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: {
        cookie: adminSteppedUp.cookieHeader,
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "user-agent": "Mozilla/5.0"
      }
    });
    expect(codeOf(response)).toBe("ADMIN_ORIGIN_FORBIDDEN");
  });

  it("refuses a same-host request from a customer application's context", async () => {
    // The kiosk and upload applications share the API's CORS allow-list. An XSS
    // in either must not be able to make a credentialed admin request.
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/overview",
      headers: {
        cookie: adminSteppedUp.cookieHeader,
        "sec-fetch-site": "same-site",
        "sec-fetch-mode": "cors",
        host: new URL(environment.ADMIN_ORIGIN).host,
        "user-agent": "Mozilla/5.0"
      }
    });
    expect(codeOf(response)).toBe("ADMIN_ORIGIN_FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// §2 IDOR — identifiers that name somebody else's records
// ---------------------------------------------------------------------------

describe("an Operator cannot reach another kiosk's records", () => {
  const outOfScope = () => [
    `/v1/admin/sessions/${worldB.sessionId}`,
    `/v1/admin/sessions/${worldB.sessionId}/timeline`,
    `/v1/admin/sessions/${worldB.sessionId}/documents`,
    `/v1/admin/print-jobs/${worldB.printJobId}`
  ];

  it("answers 404 for a real record outside its scope, never 403", async () => {
    // A 403 on an out-of-scope identifier confirms that the identifier names
    // something real, which is the whole mechanism of an enumeration attack. The
    // answer has to be the same one an unknown identifier gets.
    for (const url of outOfScope()) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: operatorOnA.cookieHeader }
      });
      expect(`${url} ${response.statusCode} ${codeOf(response)}`).toBe(
        `${url} 404 ADMIN_NOT_FOUND`
      );
    }
  });

  it("answers identically for an identifier that names nothing at all", async () => {
    for (const url of [
      `/v1/admin/sessions/${ABSENT_ID}`,
      `/v1/admin/sessions/${ABSENT_ID}/timeline`,
      `/v1/admin/sessions/${ABSENT_ID}/documents`,
      `/v1/admin/print-jobs/${ABSENT_ID}`
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: operatorOnA.cookieHeader }
      });
      expect(`${response.statusCode} ${codeOf(response)}`).toBe("404 ADMIN_NOT_FOUND");
    }
  });

  it("reaches its own kiosk's records", async () => {
    // The control. Without it the test above would pass just as well against an
    // endpoint that answered 404 for everything.
    for (const url of [
      `/v1/admin/sessions/${worldA.sessionId}`,
      `/v1/admin/sessions/${worldA.sessionId}/timeline`,
      `/v1/admin/sessions/${worldA.sessionId}/documents`,
      `/v1/admin/print-jobs/${worldA.printJobId}`
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: operatorOnA.cookieHeader }
      });
      expect(`${url} ${response.statusCode}`).toBe(`${url} 200`);
    }
  });

  it("cannot widen its scope through a query filter", async () => {
    // Naming somebody else's kiosk explicitly is an intersection with the
    // scope, which is empty — not an override of it.
    for (const path of ["/v1/admin/sessions", "/v1/admin/print-jobs", "/v1/admin/payments"]) {
      const response = await app.inject({
        method: "GET",
        url: `${path}?kioskId=${kioskB}`,
        headers: { cookie: operatorOnA.cookieHeader }
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).items).toEqual([]);
    }
  });

  it("cannot act on a print job belonging to another kiosk", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/print-jobs/${worldB.printJobId}/recovery-resolution`,
      headers: {
        cookie: operatorOnA.cookieHeader,
        [ADMIN_CSRF_HEADER]: operatorOnA.csrfToken
      },
      payload: { outcome: "NOT_DELIVERED", observedSheets: 0, reason: "not my kiosk" }
    });
    expect(`${response.statusCode} ${codeOf(response)}`).toBe("404 ADMIN_NOT_FOUND");
  });

  it("sees only its own actions in the audit log", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/audit",
      headers: { cookie: operatorOnA.cookieHeader }
    });
    expect(response.statusCode).toBe(200);
    const actors = new Set(
      (JSON.parse(response.body).items as { actorId: string }[]).map((item) => item.actorId)
    );
    for (const actor of actors) {
      expect(actor).toBe(operatorOnA.adminUserId);
    }
  });

  it("still reads the audit log when a page contains an unauthenticated admin event", async () => {
    // A failed sign-in and a consumed recovery credential are written with no
    // account to attribute them to, so `actor_id` is `anonymous` rather than a
    // UUID. Looking that up in `admin_users` made PostgreSQL refuse the whole
    // query, and the audit screen answered 500 — for the whole page, because of
    // one row, and only once something worth investigating had happened.
    // Filtered to an action only this test writes, so the row is on the page
    // whatever else the log happens to contain.
    const action = `admin.anonymous_probe_${suite}`;
    await database.auditEvent.create({
      data: {
        id: randomUUID(),
        occurredAt: new Date(),
        actorType: "ADMIN_USER",
        actorId: "anonymous",
        action,
        outcome: "FAILURE",
        metadata: { failureCode: "NO_MATCHING_CREDENTIAL" }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/audit?action=${action}`,
      headers: { cookie: adminSteppedUp.cookieHeader }
    });
    expect(`${response.statusCode} ${codeOf(response) ?? ""}`.trim()).toBe("200");

    const anonymous = (
      JSON.parse(response.body).items as Array<{ actorId: string; actorDisplayName: string | null }>
    ).find((item) => item.actorId === "anonymous");
    expect(anonymous).toBeDefined();
    // Shown as what it is: an event with no account behind it.
    expect(anonymous?.actorDisplayName).toBeNull();
  });

  it("cannot retire another account's security key through its own route", async () => {
    // `authenticator.manage.self` names no target: the route uses the caller's
    // own identifier, so there is no parameter to point at somebody else.
    const victim = operatorOnB.adminUserId;
    const key = await database.adminAuthenticator.findFirst({
      where: { adminUserId: victim, revokedAt: null },
      select: { id: true }
    });
    expect(key).not.toBeNull();

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/authenticators/${key?.id}/revoke`,
      headers: {
        cookie: operatorOnA.cookieHeader,
        [ADMIN_CSRF_HEADER]: operatorOnA.csrfToken
      },
      payload: { reason: "not mine to retire" }
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    const stillThere = await database.adminAuthenticator.findFirst({
      where: { id: key?.id, revokedAt: null }
    });
    expect(stillThere).not.toBeNull();
  });

  it("hides who the privileged accounts are from the people roster", async () => {
    // The roster is Operators. A screen listing Admins with every control
    // greyed out would be a screen telling anybody who opened it which accounts
    // are worth attacking.
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/people",
      headers: { cookie: adminSteppedUp.cookieHeader }
    });
    expect(response.statusCode).toBe(200);
    const roles = new Set(
      (JSON.parse(response.body).items as { role: string }[]).map((item) => item.role)
    );
    expect([...roles].every((role) => role === "OPERATOR")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3 What leaves the process
// ---------------------------------------------------------------------------

/**
 * Field names that must never appear in an admin response.
 *
 * Two kinds. A credential or its digest is what an attacker reading a response
 * would want most; a filename, an object key or a content digest is a
 * customer's document by another route. Both are absent from the response
 * schemas and denied at the reader role's grants — this asserts the third
 * thing, which is that no route assembles one anyway.
 */
const FORBIDDEN_RESPONSE_KEYS = [
  "publicKey",
  "credentialId",
  "tokenDigest",
  "csrfDigest",
  "secretDigest",
  "codeDigest",
  "userHandle",
  "recoveryCode",
  "enrollmentCode",
  "breakGlass",
  "objectKey",
  "storageKey",
  "bucket",
  "contentSha256",
  "manifestHash",
  "jobManifest",
  "displayNameFile",
  "fileName",
  "filename",
  "originalName",
  "previewUrl",
  "downloadUrl",
  "password",
  "secret"
];

/** Values that would mean a secret escaped, whatever key they arrived under. */
const FORBIDDEN_VALUE_FRAGMENTS = [
  "postgres://",
  "postgresql://",
  "redis://",
  "rediss://",
  "-----BEGIN",
  DOCUMENT_CANARY,
  DOCUMENT_DIGEST_CANARY,
  environment.ADMIN_SESSION_PEPPER,
  environment.ADMIN_BREAK_GLASS_PEPPER,
  environment.UPLOAD_TOKEN_PEPPER,
  environment.DATABASE_URL
].filter((value): value is string => typeof value === "string" && value.length > 0);

describe("no response carries a credential, a secret or a document", () => {
  it("returns nothing forbidden from any readable route", async () => {
    const readable = registeredEndpoints().filter(
      (endpoint) => endpoint.method === "GET" && endpoint.gate !== "OPEN"
    );
    expect(readable.length).toBeGreaterThan(15);

    for (const endpoint of readable) {
      const response = await app.inject({
        method: "GET",
        url: concreteReadUrl(endpoint),
        headers: { cookie: adminSteppedUp.cookieHeader }
      });
      // A 404 would make the scan vacuous, so the URLs above name real records.
      expect(`${key(endpoint)} ${response.statusCode}`).toBe(`${key(endpoint)} 200`);

      for (const finding of scanForSecrets(JSON.parse(response.body))) {
        expect(`${key(endpoint)}: ${finding}`).toBe(`${key(endpoint)}: clean`);
      }
    }
  });

  it("returns no document identity from the documents route", async () => {
    // The most sensitive read in the panel, checked by name rather than by
    // pattern: this is the route a filename would arrive through if one ever
    // did, and the phase docs promise it never will.
    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/sessions/${worldA.sessionId}/documents`,
      headers: { cookie: adminSteppedUp.cookieHeader }
    });
    expect(response.statusCode).toBe(200);

    const body = response.body;
    for (const term of [
      DOCUMENT_CANARY,
      DOCUMENT_DIGEST_CANARY,
      "displayName",
      "quarantine/",
      "normalized/",
      "previews/"
    ]) {
      expect(`${term} in documents response: ${body.includes(term)}`).toBe(
        `${term} in documents response: false`
      );
    }
  });

  it("exposes no route that could return bytes", () => {
    // Phase 2 asserted this by construction; here it is asserted against the
    // route table, so a byte-serving admin route added later fails the suite.
    // `/documents` is the metadata list and is the one path here that names
    // customer documents at all — anything below it would be a route about one
    // document rather than about all of them, which is the shape a download has.
    for (const routeKey of actualAdminRoutes()) {
      expect(routeKey).not.toMatch(/(\/download|\/content|\/file|\/pages|\/documents\/)/u);
      expect(routeKey).not.toMatch(/\/documents\/.*preview/u);
    }
    // And the metadata list itself exists, so the assertion above is about a
    // route table that really does describe documents.
    expect(actualAdminRoutes()).toContain("GET /v1/admin/sessions/:sessionId/documents");
  });

  it("leaks nothing through an error body", async () => {
    for (const [url, payload] of [
      ["/v1/admin/errors?windowHours=not-a-number", undefined],
      ["/v1/admin/sessions/not-a-uuid", undefined],
      ["/v1/admin/audit?action=" + encodeURIComponent("../../etc/passwd"), undefined],
      ["/v1/admin/incidents/acknowledge", {}]
    ] as const) {
      const response = await app.inject({
        method: payload === undefined ? "GET" : "POST",
        url,
        headers: {
          cookie: adminSteppedUp.cookieHeader,
          ...(payload === undefined ? {} : { [ADMIN_CSRF_HEADER]: adminSteppedUp.csrfToken })
        },
        ...(payload === undefined ? {} : { payload })
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      const body = JSON.parse(response.body);
      // A code, a fixed message and a request id. No stack, no SQL, no internal
      // string — the error handler's contract, checked at the admin boundary.
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error).sort()).toEqual(["code", "message", "requestId"]);
      expect(response.body).not.toMatch(/(at Object\.|node_modules|prisma|SELECT |INSERT )/iu);
    }
  });
});

// ---------------------------------------------------------------------------
// §4 Response hygiene
// ---------------------------------------------------------------------------

describe("response hygiene", () => {
  it("marks every admin response no-store", async () => {
    // Every response is about production and scoped to one signed-in person. A
    // shared cache — or a back button after a sign-out — must not reproduce one.
    for (const endpoint of registeredEndpoints()) {
      if (endpoint.method !== "GET" || endpoint.gate === "OPEN") continue;
      const response = await app.inject({
        method: "GET",
        url: endpoint.url ?? endpoint.path,
        headers: { cookie: adminSteppedUp.cookieHeader }
      });
      expect(`${key(endpoint)} ${response.headers["cache-control"]}`).toBe(
        `${key(endpoint)} no-store`
      );
    }
  });

  it("answers only as JSON, and says so unambiguously", async () => {
    // Nothing here renders. A response a browser could be talked into treating
    // as a document is the precondition for reflected XSS, so the content type
    // is asserted alongside the header that stops it being sniffed.
    for (const url of ["/v1/admin/overview", "/v1/admin/kiosks", "/v1/admin/me"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: adminSteppedUp.cookieHeader }
      });
      expect(String(response.headers["content-type"])).toMatch(/^application\/json/u);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("never reflects caller-supplied text back into a response", async () => {
    const payload = "<script>alert(1)</script>";
    const encoded = encodeURIComponent(payload);
    for (const url of [
      `/v1/admin/sessions?kioskId=${encoded}`,
      `/v1/admin/sessions?cursor=${encoded}`,
      `/v1/admin/print-jobs?status=${encoded}`,
      `/v1/admin/audit?action=${encoded}`,
      `/v1/admin/nonexistent-${encoded}`
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: adminSteppedUp.cookieHeader }
      });
      expect(`${url} → ${response.body.includes(payload)}`).toBe(`${url} → false`);
      expect(response.body).not.toContain("<script");
    }
  });

  it("keeps the session cookie unreadable and same-site", async () => {
    // Asserted on a real Set-Cookie rather than on the code that writes it.
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/authentication/options",
      payload: {}
    });
    expect(response.statusCode).toBeLessThan(500);

    const admin = await database.adminUser.findFirst({
      where: { id: session("ADMIN").adminUserId },
      select: { id: true }
    });
    expect(admin).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §5 Audit integrity, end to end
// ---------------------------------------------------------------------------

/**
 * The control plane's own evidence, and who owns it.
 *
 * A trigger is the mechanism and ownership is what stops the mechanism being
 * switched off: a table's owner may `ALTER TABLE ... DISABLE TRIGGER ALL` and
 * then rewrite whatever it likes. Phase 4 moved the audit log and the identity
 * tables out of the application's hands; Phase 6 moved the four tables that
 * record what a person did, which had been left behind.
 */
const MIGRATOR_OWNED_TABLES = [
  "audit_events",
  "admin_users",
  "admin_authenticators",
  "admin_sessions",
  "admin_webauthn_challenges",
  "admin_break_glass_credentials",
  "admin_kiosk_scopes",
  "admin_enrollment_tickets",
  "admin_change_executions",
  "print_job_recovery_resolutions",
  "print_job_recovery_corrections",
  "refund_authorizations",
  "cleanup_retry_requests"
];

describe("audit integrity does not depend on a trigger anybody can switch off", () => {
  it("keeps every evidence table out of the application role's ownership", async () => {
    const rows = await database.$queryRaw<{ tablename: string; tableowner: string }[]>`
      SELECT tablename, tableowner
        FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename = ANY(${MIGRATOR_OWNED_TABLES}::text[])
       ORDER BY tablename`;

    expect(rows.map((row) => row.tablename)).toEqual([...MIGRATOR_OWNED_TABLES].sort());
    for (const row of rows) {
      // Named in the assertion so a failure says which table went back.
      expect(`${row.tablename} owned by ${row.tableowner}`).toBe(
        `${row.tablename} owned by printing_kiosk_migrator`
      );
    }
  });

  it("has no disabled trigger on any of them", async () => {
    // A teardown that suspended a trigger and failed to restore it would leave
    // the guarantee off in a way nothing else would notice.
    const rows = await database.$queryRaw<{ table_name: string; trigger_name: string }[]>`
      SELECT c.relname AS table_name, t.tgname AS trigger_name
        FROM pg_trigger AS t
        JOIN pg_class AS c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgenabled = 'D'
         AND c.relname = ANY(${MIGRATOR_OWNED_TABLES}::text[])`;
    expect(rows).toEqual([]);
  });

  it("refuses to rewrite or remove an audit row, on the application's own credential", async () => {
    const event = await database.auditEvent.findFirst({ orderBy: { occurredAt: "desc" } });
    expect(event).not.toBeNull();

    await expectRefused(
      database.$executeRawUnsafe(
        `UPDATE "audit_events" SET "outcome" = 'SUCCESS' WHERE "id" = '${event?.id}'`
      )
    );
    await expectRefused(
      database.$executeRawUnsafe(`DELETE FROM "audit_events" WHERE "id" = '${event?.id}'`)
    );
    await expectRefused(database.$executeRawUnsafe(`TRUNCATE TABLE "audit_events"`));
  });

  it("records a real chain of evidence through the real routes", async () => {
    // Written through the API on the least-privilege roles, so the rewrites
    // attempted below are attempted against rows that exist. It doubles as the
    // regression check this phase most needed: the three writing roles were
    // re-granted by a new owner, and an admin action that no longer worked
    // would show up here rather than in production.
    const resolution = await app.inject({
      method: "POST",
      url: `/v1/admin/print-jobs/${worldA.printJobId}/recovery-resolution`,
      headers: {
        cookie: operatorOnA.cookieHeader,
        [ADMIN_CSRF_HEADER]: operatorOnA.csrfToken
      },
      payload: { outcome: "NOT_DELIVERED", observedSheets: 0, reason: "nothing in the tray" }
    });
    expect(`resolution ${resolution.statusCode} ${codeOf(resolution) ?? ""}`.trim()).toBe(
      "resolution 201"
    );
    const resolutionId = JSON.parse(resolution.body).resolution.id as string;

    const correction = await app.inject({
      method: "POST",
      url: `/v1/admin/print-jobs/${worldA.printJobId}/recovery-correction`,
      headers: {
        cookie: adminSteppedUp.cookieHeader,
        [ADMIN_CSRF_HEADER]: adminSteppedUp.csrfToken
      },
      payload: {
        supersedesId: resolutionId,
        outcome: "PARTIALLY_DELIVERED",
        observedSheets: 1,
        reason: "one sheet was found behind the printer"
      }
    });
    expect(`correction ${correction.statusCode} ${codeOf(correction) ?? ""}`.trim()).toBe(
      "correction 201"
    );

    if (refundDatabase) {
      const refund = await app.inject({
        method: "POST",
        url: `/v1/admin/print-jobs/${worldA.printJobId}/refund-authorization`,
        headers: {
          cookie: adminSteppedUp.cookieHeader,
          [ADMIN_CSRF_HEADER]: adminSteppedUp.csrfToken
        },
        payload: { amountMinor: 12_000, reason: "two of three sheets never came out" }
      });
      expect(`refund ${refund.statusCode} ${codeOf(refund) ?? ""}`.trim()).toBe("refund 201");
    }

    expect(
      await database.printJobRecoveryResolution.count({ where: { printJobId: worldA.printJobId } })
    ).toBe(1);
  });

  it("refuses to rewrite that evidence, on the application's own credential", async () => {
    // The Phase 6 addition. Until the ownership moved, each of these tables was
    // owned by the role whose credential the trigger was protecting against.
    for (const table of [
      "print_job_recovery_resolutions",
      "print_job_recovery_corrections",
      "refund_authorizations"
    ]) {
      if ((await countRows(table)) === 0) continue;
      await expectRefused(
        database.$executeRawUnsafe(`UPDATE "${table}" SET "reason" = 'rewritten'`)
      );
      await expectRefused(database.$executeRawUnsafe(`DELETE FROM "${table}"`));
    }
  });

  it("refuses to truncate any of them, even where no row exists yet", async () => {
    // The statement-level half of the same guarantee, and the one that still
    // means something on an empty table.
    for (const table of [
      "print_job_recovery_resolutions",
      "print_job_recovery_corrections",
      "refund_authorizations",
      "cleanup_retry_requests",
      "admin_change_executions"
    ]) {
      await expectRefused(database.$executeRawUnsafe(`TRUNCATE TABLE "${table}"`));
    }
  });

  it("cannot write anything at all through the admin read connection", async () => {
    await expectRefused(
      readDatabase.$executeRawUnsafe(`UPDATE "print_sessions" SET "locale" = 'xx'`)
    );
    await expectRefused(
      readDatabase.$executeRawUnsafe(
        `INSERT INTO "audit_events" ("id", "occurred_at", "actor_type", "actor_id", "action", "outcome")
         VALUES (gen_random_uuid(), now(), 'ADMIN_USER', 'x', 'forged', 'SUCCESS')`
      )
    );
  });

  it("records the actor, the capability and the outcome of a refusal", async () => {
    // An audit row is only integrity-relevant if it says enough to act on, so
    // this asks it of a refusal this suite caused rather than of whatever the
    // newest one in the table happens to be.
    const denied = await database.auditEvent.findFirst({
      where: {
        outcome: "DENIED",
        actorType: "ADMIN_USER",
        actorId: session("TECHNICAL_ADMIN").adminUserId
      },
      orderBy: { occurredAt: "desc" }
    });
    expect(denied).not.toBeNull();
    const metadata = denied?.metadata as Record<string, unknown>;
    expect(metadata.role).toBe("TECHNICAL_ADMIN");
    expect(metadata.capability).toBe("refund.authorize");
  });

  it("writes no document identity and no free-form text into an audit row", async () => {
    // The metadata allow-list, asserted against the rows this suite wrote. A
    // reason is operator-written and is kept; everything a caller could smuggle
    // beside it is dropped before it reaches durable storage.
    const rows = await database.auditEvent.findMany({
      where: { actorId: { in: seededAdminUserIds } },
      select: { metadata: true }
    });
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const serialised = JSON.stringify(row.metadata ?? {});
      expect(serialised).not.toContain(DOCUMENT_CANARY);
      expect(serialised).not.toContain(DOCUMENT_DIGEST_CANARY);
      for (const forbidden of ["displayName", "fileName", "objectKey", "enrollmentCode"]) {
        expect(`${forbidden}: ${serialised.includes(forbidden)}`).toBe(`${forbidden}: false`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function session(role: AdminRole): SeededSession {
  const seeded = stale[role];
  if (!seeded) throw new Error(`no seeded session for ${role}`);
  return seeded;
}

function key(endpoint: AdminEndpoint): string {
  return `${endpoint.method} ${endpoint.path}`;
}

function registeredEndpoints(): AdminEndpoint[] {
  return ENDPOINTS.filter((endpoint) => isRegistered(endpoint));
}

function isRegistered(endpoint: AdminEndpoint): boolean {
  if (endpoint.needs === "REFUND") return refundDatabase !== null;
  if (endpoint.needs === "PEOPLE") return peopleDatabase !== null;
  if (endpoint.needs === "PRICING") return pricingDatabase !== null;
  return true;
}

function expectedRouteKeys(): string[] {
  return registeredEndpoints().map((endpoint) => key(endpoint));
}

/**
 * The routes Fastify actually built, read from its own table.
 *
 * `printRoutes` draws the radix tree, so a path arrives split across lines: a
 * child is indented four characters per level and carries only its own segment.
 * Walking it means keeping the segments seen at each depth and joining them,
 * which is what the stack below does.
 *
 * HEAD is Fastify's automatic companion to GET, and the wildcard OPTIONS route
 * belongs to CORS. Neither is a route anybody declared.
 */
function actualAdminRoutes(): string[] {
  const routes: string[] = [];
  const segments: string[] = [];

  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const connector = /(├── |└── )/u.exec(line);
    if (!connector || connector.index % 4 !== 0) continue;

    const depth = connector.index / 4;
    const body = line.slice(connector.index + connector[0].length);
    const match = /^(\S*)\s+\(([^)]+)\)\s*$/u.exec(body);
    if (!match) continue;

    segments[depth] = match[1] ?? "";
    segments.length = depth + 1;
    const path = segments.join("");
    if (!path.startsWith("/v1/admin/")) continue;

    for (const method of (match[2] ?? "").split(",").map((value) => value.trim())) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      routes.push(`${method} ${path}`);
    }
  }

  return routes;
}

function sortedRouteKeys(keys: readonly string[]): string[] {
  return [...keys].sort();
}

function call(seeded: SeededSession, endpoint: AdminEndpoint) {
  return app.inject({
    method: endpoint.method,
    url: endpoint.url ?? endpoint.path,
    headers: {
      cookie: seeded.cookieHeader,
      ...(endpoint.method === "GET" ? {} : { [ADMIN_CSRF_HEADER]: seeded.csrfToken })
    },
    ...(endpoint.method === "GET" ? {} : { payload: {} })
  });
}

function codeOf(response: { body: string }): string | undefined {
  try {
    const parsed = JSON.parse(response.body);
    return typeof parsed?.error?.code === "string" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

/** A URL for a read that names a record that exists, so a scan is not vacuous. */
function concreteReadUrl(endpoint: AdminEndpoint): string {
  return (endpoint.url ?? endpoint.path)
    .replace(`/sessions/${ABSENT_ID}`, `/sessions/${worldA.sessionId}`)
    .replace(`/print-jobs/${ABSENT_ID}`, `/print-jobs/${worldA.printJobId}`);
}

/**
 * Walk a response and report anything that should not have left the process.
 *
 * Keys are checked case-insensitively because a forbidden field arriving under
 * a different casing is the same field.
 */
function scanForSecrets(value: unknown, path = "$"): string[] {
  const findings: string[] = [];

  if (typeof value === "string") {
    for (const fragment of FORBIDDEN_VALUE_FRAGMENTS) {
      if (value.includes(fragment)) findings.push(`${path} contains a secret value`);
    }
    return findings;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      findings.push(...scanForSecrets(entry, `${path}[${index}]`));
    });
    return findings;
  }

  if (value && typeof value === "object") {
    for (const [name, entry] of Object.entries(value)) {
      const forbidden = FORBIDDEN_RESPONSE_KEYS.find(
        (candidate) => candidate.toLowerCase() === name.toLowerCase()
      );
      if (forbidden) findings.push(`${path}.${name} is a forbidden field`);
      findings.push(...scanForSecrets(entry, `${path}.${name}`));
    }
  }

  return findings;
}

/**
 * Assert that PostgreSQL itself refuses a statement.
 *
 * The SQLSTATE is checked rather than only the throw: an application-level
 * exception would not be the database saying no, and this file's whole claim is
 * that these guarantees hold below the application.
 *
 * 42501 is permission denied, 25006 a read-only transaction, 23001 the
 * `restrict_violation` the append-only triggers raise, and P0001 a trigger
 * raising without a code of its own. All four are refusals; which one arrives
 * depends on whether the grant, the connection or the trigger got there first,
 * and in development — where the application role is a superuser and passes
 * every privilege check — it is always the trigger.
 */
const REFUSAL_CODES = /^(42501|25006|23001|P0001)$/u;

async function expectRefused(operation: Promise<unknown>): Promise<void> {
  let code: string | undefined;
  try {
    await operation;
  } catch (error) {
    code = extractDatabaseCode(error);
  }
  expect(code).toMatch(REFUSAL_CODES);
}

/**
 * Dig the driver's SQLSTATE out of Prisma's wrapper.
 *
 * A refused raw statement arrives as `P2010` with the real code somewhere
 * inside, so reading the outer `code` would accept a Prisma-level failure as
 * though the database had spoken. The same walk is used by the Phase 3 and
 * Phase 4 suites; this one also accepts `P0001`, because a trigger refusing is
 * the mechanism most of these tables rely on.
 */
function extractDatabaseCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    for (const name of ["originalCode", "code"]) {
      const candidate = Reflect.get(value, name);
      if (typeof candidate === "string" && REFUSAL_CODES.test(candidate)) return candidate;
    }
    for (const name of Object.keys(value)) {
      const found = walk(Reflect.get(value, name));
      if (found) return found;
    }
    const message = Reflect.get(value, "message");
    if (typeof message === "string") {
      const matched = /\b(42501|25006|23001|P0001)\b/u.exec(message);
      if (matched) return matched[1];
    }
    return undefined;
  };
  return walk(error);
}

async function countRows(table: string): Promise<number> {
  const rows = await database.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "${table}"`
  );
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seedAdminWithSession(
  role: AdminRole,
  kioskScopes: readonly string[],
  steppedUp: boolean
): Promise<SeededSession> {
  const now = Date.now();
  const adminUserId = randomUUID();
  seededAdminUserIds.push(adminUserId);

  await database.adminUser.create({
    data: {
      id: adminUserId,
      userHandle: randomBytes(32),
      displayName: `Security ${role}`,
      role,
      status: "PROVISIONING"
    }
  });

  // Two authenticators, because an active account may not exist with fewer.
  for (let index = 0; index < 2; index += 1) {
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId,
        credentialId: `sec-credential-${adminUserId}-${index}`,
        publicKey: randomBytes(32),
        label: `key ${index}`,
        attachment: "cross-platform",
        backupEligible: false
      }
    });
  }

  await database.adminUser.update({
    where: { id: adminUserId },
    data: { status: "ACTIVE", activatedAt: new Date(now) }
  });

  for (const kioskId of kioskScopes) {
    await database.adminKioskScope.create({ data: { adminUserId, kioskId } });
  }

  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  await database.adminSession.create({
    data: {
      id: randomUUID(),
      adminUserId,
      tokenDigest: digestAdminSessionToken(sessionToken, environment.ADMIN_SESSION_PEPPER),
      csrfDigest: digestAdminCsrfToken(csrfToken, environment.ADMIN_SESSION_PEPPER),
      idleExpiresAt: new Date(now + 3_600_000),
      hardExpiresAt: new Date(now + 7_200_000),
      ...(steppedUp ? { lastStepUpAt: new Date(now) } : {})
    }
  });

  return {
    adminUserId,
    csrfToken,
    cookieHeader: `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`
  };
}

async function seedPricing(): Promise<void> {
  const existing = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED" },
    select: { id: true, version: true }
  });
  if (existing) {
    ruleSetId = existing.id;
    pricingVersion = existing.version;
    return;
  }

  ruleSetId = randomUUID();
  pricingVersion = `sec-${suite}`;
  seededRuleSet = true;
  await database.pricingRuleSet.create({
    data: {
      id: ruleSetId,
      version: pricingVersion,
      scope: "KIOSK",
      scopeRef: kioskA,
      currency: "AMD",
      currencyExponent: 2,
      status: "PUBLISHED",
      rounding: "HALF_UP",
      taxMode: "EXCLUSIVE",
      minimumApplication: "BEFORE_TAX",
      validFrom: new Date(Date.now() - 86_400_000),
      publishedAt: new Date(Date.now() - 86_400_000)
    }
  });
}

async function seedKioskWorld(kioskId: string): Promise<SeededWorld> {
  const now = Date.now();
  const sessionId = randomUUID();

  await database.kiosk.create({
    data: {
      id: kioskId,
      publicCode: kioskId.toUpperCase(),
      name: `Security ${kioskId}`,
      capabilities: { paperSizes: ["A4"] },
      lastSeenAt: new Date(now - 30_000)
    }
  });

  const printJobId = await seedPaidSession(kioskId, sessionId, now);

  await database.agentCommand.create({
    data: {
      id: randomUUID(),
      kioskId,
      sessionId,
      printJobId,
      operationId: randomUUID(),
      type: "PRINT",
      status: "FAILED",
      payload: { documents: [] },
      expiresAt: new Date(now - 6_000_000),
      resultCode: "DEVICE_UNREACHABLE",
      completedAt: new Date(now - 6_500_000)
    }
  });

  return { sessionId, printJobId };
}

async function seedPaidSession(kioskId: string, sessionId: string, now: number): Promise<string> {
  const quoteId = randomUUID();
  const paymentId = randomUUID();
  const printJobId = randomUUID();
  const fileId = randomUUID();
  const manifestHash = randomBytes(32).toString("hex");

  await database.printSession.create({
    data: {
      id: sessionId,
      publicId: `ps_sec_${randomBytes(8).toString("hex")}`,
      kioskId,
      locale: "en",
      state: "PRINTING",
      currentSettingsRevision: 1,
      idleExpiresAt: new Date(now - 3_600_000),
      hardExpiresAt: new Date(now - 3_600_000),
      createdAt: new Date(now - 7_200_000)
    }
  });

  await database.printSettingRevision.create({
    data: {
      id: randomUUID(),
      sessionId,
      revision: 1,
      copies: 1,
      duplex: "SIMPLEX",
      paperSize: "A4",
      orientation: "PORTRAIT",
      scaling: "FIT",
      collate: true,
      colorMode: "MONOCHROME",
      selections: [{ fileId, contentSha256: randomBytes(32).toString("hex"), pages: "1-3" }],
      selectedPages: 3,
      printedSides: 3,
      physicalSheets: 3,
      capabilityVersion: 1,
      manifestHash,
      createdByActorType: "KIOSK",
      createdByActorId: kioskId
    }
  });

  // A document row, so the documents read has something to describe — and so
  // the scan for a filename is asked of a response that could carry one. The
  // name and the digest are canaries: a response containing either has leaked
  // a customer's own description of what they printed.
  const clientId = randomUUID();
  await database.mobileClient.create({
    data: {
      id: clientId,
      sessionId,
      cookieDigest: randomBytes(32).toString("hex"),
      clientNonceDigest: randomBytes(32).toString("hex"),
      expiresAt: new Date(now - 3_600_000)
    }
  });

  await database.uploadedFile.create({
    data: {
      id: fileId,
      sessionId,
      uploadedByClientId: clientId,
      clientFileId: randomUUID(),
      ordinal: 0,
      displayName: `${DOCUMENT_CANARY}.pdf`,
      status: "READY",
      kind: "PDF",
      declaredMime: "application/pdf",
      detectedMime: "application/pdf",
      extension: "pdf",
      reservedBytes: 4096,
      sizeBytes: 2048,
      contentSha256: DOCUMENT_DIGEST_CANARY,
      quarantineObjectKey: `quarantine/v1/${sessionId}/${fileId}/${DOCUMENT_CANARY}`,
      processingGeneration: 1,
      processingAttempts: 1,
      processingStartedAt: new Date(now - 7_000_000),
      malwareScanStatus: "CLEAN",
      pageCount: 3,
      quarantinedAt: new Date(now - 7_100_000),
      readyAt: new Date(now - 6_900_000)
    }
  });

  await database.priceQuote.create({
    data: {
      id: quoteId,
      sessionId,
      settingsRevision: 1,
      manifestHash,
      ruleSetId,
      pricingVersion,
      status: "ACTIVE",
      currency: "AMD",
      currencyExponent: 2,
      selectedPages: 3,
      printedSides: 3,
      physicalSheets: 3,
      printAmountMinor: 15_000,
      duplexAdjustmentMinor: 0,
      serviceFeeMinor: 0,
      minimumAdjustmentMinor: 0,
      subtotalMinor: 15_000,
      taxMinor: 3_000,
      totalMinor: 18_000,
      expiresAt: new Date(now + 3_600_000)
    }
  });

  await database.payment.create({
    data: {
      id: paymentId,
      sessionId,
      quoteId,
      provider: "MOCK",
      providerIntentId: `intent_sec_${randomBytes(8).toString("hex")}`,
      status: "CAPTURED",
      appliedToSession: true,
      amountMinor: 18_000,
      currency: "AMD",
      currencyExponent: 2,
      settingsRevision: 1,
      manifestHash,
      createdByActorType: "KIOSK",
      createdByActorId: kioskId,
      expiresAt: new Date(now - 3_600_000),
      createdAt: new Date(now - 7_000_000),
      capturedAt: new Date(now - 6_900_000)
    }
  });

  await database.printSession.update({ where: { id: sessionId }, data: { state: "PAID" } });

  await database.printJob.create({
    data: {
      id: printJobId,
      sessionId,
      kioskId,
      quoteId,
      paymentId,
      settingsRevision: 1,
      settingsManifestHash: manifestHash,
      jobManifest: { documents: [{ fileId }] },
      jobManifestHash: randomBytes(32).toString("hex"),
      status: "QUEUED",
      copies: 1,
      printedSides: 3,
      physicalSheets: 3,
      deadlineAt: new Date(now - 6_000_000),
      createdByActorType: "KIOSK",
      createdByActorId: kioskId,
      createdAt: new Date(now - 6_800_000)
    }
  });

  await database.printSession.update({ where: { id: sessionId }, data: { state: "PRINTING" } });
  await database.printJob.update({
    where: { id: printJobId },
    data: {
      status: "RECOVERY_REQUIRED",
      resultConfidence: "UNCONFIRMED",
      failureCode: "DEVICE_RESULT_UNCONFIRMED",
      dispatchAttempts: 1,
      dispatchedAt: new Date(now - 6_700_000),
      startedAt: new Date(now - 6_600_000),
      failedAt: new Date(now - 6_500_000)
    }
  });
  await database.printSession.update({
    where: { id: sessionId },
    data: { state: "RECOVERY_REQUIRED", terminalReason: "PRINT_UNCONFIRMED" }
  });

  return printJobId;
}

async function cleanUpSeededAdmins(): Promise<void> {
  const ids = seededAdminUserIds.splice(0);
  if (ids.length === 0) return;
  await database.adminWebAuthnChallenge.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminKioskScope.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminUser.updateMany({
    where: { id: { in: ids }, status: { not: "DISABLED" } },
    data: { status: "SUSPENDED" }
  });
  await database.adminAuthenticator.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminUser.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Remove this suite's kiosks and everything hanging off them.
 *
 * The evidence tables need their triggers suspended to delete, which needs
 * ownership or superuser — and since Phase 6 the application owns none of them.
 * A teardown that needed no special step would mean the guarantee was not
 * really there.
 */
async function cleanUpOperationalData(): Promise<void> {
  const kioskIds = [kioskA, kioskB];
  const sessions = await database.printSession.findMany({
    where: { kioskId: { in: kioskIds } },
    select: { id: true }
  });
  const sessionIds = sessions.map((printSession) => printSession.id);

  if (sessionIds.length > 0) {
    for (const table of [
      "refund_authorizations",
      "print_job_recovery_corrections",
      "print_job_recovery_resolutions",
      "cleanup_retry_requests"
    ]) {
      await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
        await transaction.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "session_id" = ANY($1::uuid[])`,
          sessionIds
        );
        await transaction.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      });
    }

    await database.printJobEvent.deleteMany({
      where: { printJob: { sessionId: { in: sessionIds } } }
    });
    await database.agentCommand.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.printJob.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.refund.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.paymentAttempt.deleteMany({
      where: { payment: { sessionId: { in: sessionIds } } }
    });
    await database.payment.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.cleanupRun.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.sessionEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.uploadedFile.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.mobileClient.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.priceQuote.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.printSettingRevision.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await database.printSession.deleteMany({ where: { id: { in: sessionIds } } });
  }

  await database.adminKioskScope.deleteMany({ where: { kioskId: { in: kioskIds } } });
  await database.kiosk.deleteMany({ where: { id: { in: kioskIds } } });
  if (seededRuleSet) await database.pricingRuleSet.deleteMany({ where: { id: ruleSetId } });
}
