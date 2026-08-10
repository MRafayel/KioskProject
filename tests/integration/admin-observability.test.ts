import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AdminRole } from "../../packages/admin-access/src/index.js";
import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import { createAdminReadClient, createDatabaseClient } from "../../packages/database/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE
} from "../../services/api/src/modules/admin/authorize.js";
import {
  digestAdminCsrfToken,
  digestAdminSessionToken
} from "../../services/api/src/modules/admin/crypto.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

/**
 * The Phase 2 acceptance gate.
 *
 * Phase 2 gave the control plane its first sight of production data, so these
 * tests are about what it must NOT be able to see or do. Three questions run
 * through the file:
 *
 *   Can any role, through any endpoint, obtain something about a customer's
 *   documents beyond metadata? Every response is searched for a canary planted
 *   in the filename, the content digest, the object key, the print manifest and
 *   the event payloads.
 *
 *   Does an Operator's kiosk assignment actually bound what they read? Not just
 *   the list they are shown, but the counts, the detail pages and the audit log.
 *
 *   Can anything here write? The read pool is probed directly, and every read
 *   path is probed with a mutating method.
 *
 * Admin sessions are inserted rather than earned through a WebAuthn ceremony:
 * the question under test is what a valid session may reach, not how one is
 * obtained, which Phase 1 covers.
 */

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({ ...process.env, NODE_ENV: "test" });
assertSafeIntegrationEnvironment(environment);

const database = createDatabaseClient(environment.DATABASE_URL);
const readDatabase = createAdminReadClient(
  environment.ADMIN_READ_DATABASE_URL ?? environment.DATABASE_URL
);
let app: Awaited<ReturnType<typeof buildApp>>;

/**
 * The string that must never leave the process.
 *
 * It is planted everywhere a document could be described: the customer's own
 * filename, the storage key, the print manifest, and both free-form event
 * payloads. Any response containing it is a leak, whatever produced it.
 */
const canary = `leakcanary${randomBytes(8).toString("hex")}`;
/** The same idea for a content digest, which must be 64 hex characters. */
const canaryDigest = `beefcafe${"0".repeat(56)}`;

const suite = randomBytes(4).toString("hex");
const kioskA = `kiosk_obs_a_${suite}`;
const kioskB = `kiosk_obs_b_${suite}`;

interface SeededSession {
  adminUserId: string;
  cookieHeader: string;
}

const seededAdminUserIds: string[] = [];
let operatorOnA: SeededSession;
let operatorWithoutScope: SeededSession;
let admin: SeededSession;
let technicalAdmin: SeededSession;

interface SeededWorld {
  sessionId: string;
  printJobId: string;
  paymentId: string;
}
let worldA: SeededWorld;
let worldB: SeededWorld;

beforeAll(async () => {
  app = await buildApp({
    environment,
    database,
    adminReadDatabase: readDatabase,
    startBackgroundJobs: false
  });

  await cleanUpOperationalData();
  await seedPricing();
  worldA = await seedKioskWorld(kioskA, true);
  worldB = await seedKioskWorld(kioskB, false);

  operatorOnA = await seedAdminWithSession("OPERATOR", [kioskA]);
  operatorWithoutScope = await seedAdminWithSession("OPERATOR", []);
  admin = await seedAdminWithSession("ADMIN");
  technicalAdmin = await seedAdminWithSession("TECHNICAL_ADMIN");
}, 60_000);

afterAll(async () => {
  await cleanUpSeededAdmins();
  await cleanUpOperationalData();
  await app.close();
  await database.$disconnect();
  await readDatabase.$disconnect();
});

// ---------------------------------------------------------------------------
// The read surface
// ---------------------------------------------------------------------------

/** Every operational read, with the least-privileged role that may call it. */
const READ_ROUTES = [
  "/v1/admin/overview",
  "/v1/admin/kiosks",
  "/v1/admin/sessions",
  "/v1/admin/print-jobs",
  "/v1/admin/payments",
  "/v1/admin/refunds",
  "/v1/admin/retention",
  "/v1/admin/errors",
  "/v1/admin/audit"
] as const;

describe("authentication", () => {
  it("refuses every operational read without a session", async () => {
    for (const url of READ_ROUTES) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error.code).toBe("ADMIN_AUTHENTICATION_REQUIRED");
    }
  });

  it("refuses a revoked session immediately", async () => {
    const doomed = await seedAdminWithSession("ADMIN");
    await database.adminSession.updateMany({
      where: { adminUserId: doomed.adminUserId },
      data: { revokedAt: new Date() }
    });

    const response = await get("/v1/admin/overview", doomed);
    expect(response.statusCode).toBe(401);
  });
});

describe("document privacy", () => {
  it("returns no filename, digest, object key, manifest or payload anywhere", async () => {
    // Every read, at the highest-privileged role, searched for the canary. This
    // is the test that has to keep passing when a later phase adds a field.
    const urls = [
      ...READ_ROUTES,
      `/v1/admin/sessions/${worldA.sessionId}`,
      `/v1/admin/sessions/${worldA.sessionId}/timeline`,
      `/v1/admin/sessions/${worldA.sessionId}/documents`,
      `/v1/admin/print-jobs/${worldA.printJobId}`
    ];

    for (const url of urls) {
      const response = await get(url, technicalAdmin);
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain(canary);
      expect(response.body, url).not.toContain(canaryDigest);
      expect(response.body.toLowerCase(), url).not.toContain("quarantine/v1");
      expect(response.body, url).not.toContain("displayName");
    }
  });

  it("describes a document without describing its contents", async () => {
    const response = await get(`/v1/admin/sessions/${worldA.sessionId}/documents`, admin);
    expect(response.statusCode).toBe(200);
    const [file] = response.json().items;

    // What an operator needs to answer "did their upload work".
    expect(file).toMatchObject({
      status: "READY",
      detectedMime: "application/pdf",
      sizeBytes: 2048,
      pageCount: 3,
      malwareScanStatus: "CLEAN"
    });
    // What they do not.
    expect(Object.keys(file)).not.toContain("displayName");
    expect(Object.keys(file)).not.toContain("contentSha256");
    expect(Object.keys(file)).not.toContain("quarantineObjectKey");
  });

  it("has no route that serves a document, a preview or a storage URL", async () => {
    for (const url of [
      `/v1/admin/sessions/${worldA.sessionId}/documents/download`,
      `/v1/admin/sessions/${worldA.sessionId}/files`,
      `/v1/admin/documents/${worldA.sessionId}/preview`,
      `/v1/admin/print-jobs/${worldA.printJobId}/manifest`,
      `/v1/admin/print-jobs/${worldA.printJobId}/documents`
    ]) {
      const response = await get(url, technicalAdmin);
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("refuses the columns behind those fields at the database itself", async () => {
    // The response schemas are the second layer. This is the first: the
    // control plane's role holds no grant, so the query never returns.
    if (!environment.ADMIN_READ_DATABASE_URL) {
      // Development may share the application role; the read-only setting still
      // applies but the column grants do not exist to be tested.
      return;
    }

    for (const column of ["display_name", "content_sha256", "quarantine_object_key"]) {
      await expect(
        readDatabase.$queryRawUnsafe(`SELECT "${column}" FROM "uploaded_files" LIMIT 1`)
      ).rejects.toThrow(/permission denied/iu);
    }
    await expect(
      readDatabase.$queryRawUnsafe(`SELECT "object_key" FROM "file_derivatives" LIMIT 1`)
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      readDatabase.$queryRawUnsafe(`SELECT "job_manifest" FROM "print_jobs" LIMIT 1`)
    ).rejects.toThrow(/permission denied/iu);
    await expect(
      readDatabase.$queryRawUnsafe(`SELECT "secret_digest" FROM "kiosk_credentials" LIMIT 1`)
    ).rejects.toThrow(/permission denied/iu);
  });
});

describe("no mutations exist", () => {
  it("refuses a write on the control plane's own connection", async () => {
    // Not "no endpoint calls update" — the connection itself cannot.
    await expect(
      readDatabase.$executeRawUnsafe(`UPDATE "kiosks" SET "name" = 'x' WHERE false`)
    ).rejects.toThrow(/read-only transaction/iu);
    await expect(
      readDatabase.$executeRawUnsafe(`DELETE FROM "print_sessions" WHERE false`)
    ).rejects.toThrow(/read-only transaction/iu);
  });

  it("exposes no mutating method on any read path", async () => {
    for (const url of READ_ROUTES) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await app.inject({
          method,
          url,
          headers: { cookie: technicalAdmin.cookieHeader }
        });
        // 404 (no such route) or 405 (wrong method) — never a success and never
        // an authorization failure, which would imply the route exists.
        expect([404, 405], `${method} ${url} -> ${response.statusCode}`).toContain(
          response.statusCode
        );
      }
    }
  });
});

describe("capability enforcement", () => {
  it("withholds the device ledger from everyone but a Technical Admin", async () => {
    const forTechnical = await get(`/v1/admin/print-jobs/${worldA.printJobId}`, technicalAdmin);
    expect(forTechnical.json().ledger).not.toBeNull();
    expect(forTechnical.json().ledger.length).toBeGreaterThan(0);

    for (const caller of [admin, operatorOnA]) {
      const response = await get(`/v1/admin/print-jobs/${worldA.printJobId}`, caller);
      expect(response.statusCode).toBe(200);
      // The job's own outcome is visible; every attempt that produced it is not.
      expect(response.json().job.status).toBe("RECOVERY_REQUIRED");
      expect(response.json().ledger).toBeNull();
    }
  });

  it("withholds the provider reference from a role without reconciliation", async () => {
    const forAdmin = await get("/v1/admin/payments", admin);
    expect(forAdmin.json().items[0].providerIntentId).toBeTypeOf("string");

    const forOperator = await get("/v1/admin/payments", operatorOnA);
    expect(forOperator.statusCode).toBe(200);
    expect(forOperator.json().items[0].providerIntentId).toBeNull();
  });

  it("gives an Operator only their own audit history", async () => {
    const forOperator = await get("/v1/admin/audit", operatorOnA);
    expect(forOperator.statusCode).toBe(200);
    expect(forOperator.json().scope).toBe("SELF");
    for (const entry of forOperator.json().items) {
      expect(entry.actorType).toBe("ADMIN_USER");
      expect(entry.actorId).toBe(operatorOnA.adminUserId);
    }

    const forAdmin = await get("/v1/admin/audit", admin);
    expect(forAdmin.json().scope).toBe("ALL");
  });

  it("redacts an unrecognised audit metadata key rather than showing it", async () => {
    const response = await get(`/v1/admin/audit?sessionId=${worldA.sessionId}`, admin);
    expect(response.statusCode).toBe(200);
    const planted = response
      .json()
      .items.find((entry: { action: string }) => entry.action === "test.canary");

    expect(planted).toBeDefined();
    expect(planted.metadata.fileId).toBe("019f0000-0000-7000-8000-000000000001");
    expect(planted.metadata).not.toHaveProperty("customerFileName");
    expect(planted.redactedKeys).toContain("customerFileName");
    expect(response.body).not.toContain(canary);
  });
});

describe("operator kiosk scoping", () => {
  it("shows an Operator only their assigned kiosks", async () => {
    const response = await get("/v1/admin/kiosks", operatorOnA);
    expect(response.statusCode).toBe(200);
    expect(response.json().scoped).toBe(true);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([kioskA]);

    const unrestricted = await get("/v1/admin/kiosks", admin);
    expect(unrestricted.json().scoped).toBe(false);
    expect(unrestricted.json().items.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([kioskA, kioskB])
    );
  });

  it("bounds every list an Operator can page through", async () => {
    for (const [url, field] of [
      ["/v1/admin/sessions", "kioskId"],
      ["/v1/admin/print-jobs", "kioskId"],
      ["/v1/admin/payments", "kioskId"]
    ] as const) {
      const response = await get(url, operatorOnA);
      expect(response.statusCode, url).toBe(200);
      expect(response.json().items.length, url).toBeGreaterThan(0);
      for (const item of response.json().items) {
        expect(item[field], url).toBe(kioskA);
      }
    }
  });

  it("answers 404 — not 403 — for a record on someone else's kiosk", async () => {
    // A 403 would confirm the identifier names something real, which is the
    // whole mechanism of an enumeration attack.
    for (const url of [
      `/v1/admin/sessions/${worldB.sessionId}`,
      `/v1/admin/sessions/${worldB.sessionId}/timeline`,
      `/v1/admin/sessions/${worldB.sessionId}/documents`,
      `/v1/admin/print-jobs/${worldB.printJobId}`
    ]) {
      const denied = await get(url, operatorOnA);
      expect(denied.statusCode, url).toBe(404);
      expect(denied.json().error.code).toBe("ADMIN_NOT_FOUND");

      // The same identifier, for somebody unrestricted, is a real record — so
      // the 404 above is the scope talking, not a broken fixture.
      const allowed = await get(url, admin);
      expect(allowed.statusCode, url).toBe(200);
    }
  });

  it("returns the same 404 for a session that does not exist at all", async () => {
    const missing = await get(`/v1/admin/sessions/${randomUUID()}`, admin);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("ADMIN_NOT_FOUND");
  });

  it("ignores a kiosk filter naming a kiosk outside the scope", async () => {
    const response = await get(`/v1/admin/sessions?kioskId=${kioskB}`, operatorOnA);
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("shows an Operator with no assignment nothing at all", async () => {
    // The safe default for a newly created account: no kiosk, no data.
    const kiosks = await get("/v1/admin/kiosks", operatorWithoutScope);
    expect(kiosks.json().items).toEqual([]);

    const sessions = await get("/v1/admin/sessions", operatorWithoutScope);
    expect(sessions.json().items).toEqual([]);

    const overview = await get("/v1/admin/overview", operatorWithoutScope);
    expect(overview.json().kiosks.total).toBe(0);
    expect(overview.json().sessions.live).toBe(0);
  });

  it("scopes the overview counts as well as the lists", async () => {
    const scoped = await get("/v1/admin/overview", operatorOnA);
    const unrestricted = await get("/v1/admin/overview", admin);

    expect(scoped.json().scoped).toBe(true);
    expect(scoped.json().kiosks.total).toBe(1);
    expect(unrestricted.json().scoped).toBe(false);
    expect(unrestricted.json().kiosks.total).toBeGreaterThanOrEqual(2);
  });
});

describe("operational answers", () => {
  it("reports the retention alarm that nothing else would surface", async () => {
    const response = await get("/v1/admin/retention?problemsOnly=true", admin);
    expect(response.statusCode).toBe(200);

    const run = response
      .json()
      .items.find((item: { sessionId: string }) => item.sessionId === worldA.sessionId);
    expect(run).toBeDefined();
    expect(run.deadLetteredAt).not.toBeNull();
    expect(run.overdue).toBe(true);
    expect(response.json().totals.deadLettered).toBeGreaterThan(0);
  });

  it("puts undeleted documents at the top of the worklist", async () => {
    const response = await get("/v1/admin/overview", admin);
    const attention = response.json().attention;
    expect(attention.length).toBeGreaterThan(0);
    expect(attention[0].severity).toBe("CRITICAL");
    expect(attention.map((item: { code: string }) => item.code)).toContain(
      "RETENTION_DEAD_LETTERED"
    );
  });

  it("reports an unsettled refund obligation and how long it has been owed", async () => {
    const response = await get("/v1/admin/refunds", admin);
    expect(response.statusCode).toBe(200);
    expect(response.json().unsettledCount).toBeGreaterThan(0);

    const refund = response.json().items[0];
    expect(refund.completedAt).toBeNull();
    expect(refund.outstandingHours).toBeGreaterThanOrEqual(2);
  });

  it("groups failures by subsystem and code", async () => {
    const response = await get("/v1/admin/errors?windowHours=24", admin);
    expect(response.statusCode).toBe(200);

    const retention = response
      .json()
      .groups.find(
        (group: { subsystem: string; code: string }) =>
          group.subsystem === "RETENTION" && group.code === "OBJECT_STORE_UNAVAILABLE"
      );
    expect(retention).toBeDefined();
    expect(retention.count).toBeGreaterThan(0);
  });

  it("builds a timeline from ordering and time, with no payload", async () => {
    const response = await get(`/v1/admin/sessions/${worldA.sessionId}/timeline`, admin);
    expect(response.statusCode).toBe(200);

    const items = response.json().items;
    expect(items.length).toBe(3);
    expect(items[0].sincePreviousMilliseconds).toBeNull();
    expect(items[1].sincePreviousMilliseconds).toBe(60_000);
    for (const item of items) {
      expect(Object.keys(item)).toEqual([
        "sequence",
        "type",
        "occurredAt",
        "sincePreviousMilliseconds"
      ]);
    }
  });

  it("classifies kiosk liveness from the heartbeat", async () => {
    const response = await get("/v1/admin/kiosks", admin);
    const a = response.json().items.find((item: { id: string }) => item.id === kioskA);
    const b = response.json().items.find((item: { id: string }) => item.id === kioskB);

    expect(a.liveness).toBe("ONLINE");
    // Seeded as never having checked in, which is a different problem from a
    // kiosk that stopped.
    expect(b.liveness).toBe("NEVER_SEEN");
  });
});

describe("bounded queries", () => {
  it("pages without skipping or repeating a row", async () => {
    // Sessions are keyset-paged. Walk every page and check the union is exactly
    // the seeded set, with nothing seen twice.
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const url: string = cursor
        ? `/v1/admin/sessions?cursor=${encodeURIComponent(cursor)}`
        : "/v1/admin/sessions";
      const response = await get(url, admin);
      expect(response.statusCode).toBe(200);
      seen.push(...response.json().items.map((item: { id: string }) => item.id));
      cursor = response.json().nextCursor;
      if (!cursor) break;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([worldA.sessionId, worldB.sessionId]));
  });

  it("treats a malformed cursor as the first page rather than an error", async () => {
    for (const cursor of ["nonsense", "' OR 1=1--", "999999999999999999.abc"]) {
      const response = await get(`/v1/admin/sessions?cursor=${encodeURIComponent(cursor)}`, admin);
      expect(response.statusCode, cursor).toBe(200);
    }
  });

  it("rejects a filter value that is not a closed vocabulary", async () => {
    for (const url of [
      "/v1/admin/sessions?state=NOT_A_STATE",
      "/v1/admin/print-jobs?status=not lower case",
      "/v1/admin/errors?windowHours=100000",
      `/v1/admin/sessions/not-a-uuid`
    ]) {
      const response = await get(url, admin);
      expect([400, 404], `${url} -> ${response.statusCode}`).toContain(response.statusCode);
    }
  });

  it("filters sessions by state", async () => {
    const response = await get("/v1/admin/sessions?state=RECOVERY_REQUIRED", admin);
    expect(response.statusCode).toBe(200);
    for (const item of response.json().items) {
      expect(item.state).toBe("RECOVERY_REQUIRED");
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function get(url: string, session: SeededSession) {
  return app.inject({ method: "GET", url, headers: { cookie: session.cookieHeader } });
}

async function seedAdminWithSession(
  role: AdminRole,
  kioskScopes: readonly string[] = []
): Promise<SeededSession> {
  const now = Date.now();
  const adminUserId = randomUUID();
  seededAdminUserIds.push(adminUserId);

  await database.adminUser.create({
    data: {
      id: adminUserId,
      userHandle: randomBytes(32),
      displayName: `Observability ${role}`,
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
        credentialId: `obs-credential-${adminUserId}-${index}`,
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
      idleExpiresAt: new Date(now + 600_000),
      hardExpiresAt: new Date(now + 3_600_000)
    }
  });

  return {
    adminUserId,
    cookieHeader: `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`
  };
}

let ruleSetId: string;
let pricingVersion: string;
let seededRuleSet = false;

/**
 * Quotes need a published tariff to point at.
 *
 * Only one may be published per scope, so this reuses the development seed's
 * rule set when there is one and creates its own — scoped to this suite's
 * kiosk, so it cannot collide with a global one — when there is not.
 */
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
  pricingVersion = `obs-${suite}`;
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

/**
 * One kiosk's worth of realistic history.
 *
 * Built through the same invariants production uses — a quote a payment must
 * match exactly, a capture a print job cannot exist without — so the rows these
 * tests read are shaped like real ones rather than like whatever was convenient.
 */
async function seedKioskWorld(kioskId: string, alive: boolean): Promise<SeededWorld> {
  const now = Date.now();
  const sessionId = randomUUID();
  const quoteId = randomUUID();
  const paymentId = randomUUID();
  const printJobId = randomUUID();
  const fileId = randomUUID();
  const clientId = randomUUID();
  const manifestHash = randomBytes(32).toString("hex");

  await database.kiosk.create({
    data: {
      id: kioskId,
      publicCode: kioskId.toUpperCase(),
      name: `Observability ${kioskId}`,
      capabilities: { paperSizes: ["A4"] },
      ...(alive ? { lastSeenAt: new Date(now - 30_000) } : {})
    }
  });

  await database.printSession.create({
    data: {
      id: sessionId,
      publicId: `ps_obs_${randomBytes(8).toString("hex")}`,
      kioskId,
      locale: "en",
      state: "RECOVERY_REQUIRED",
      currentSettingsRevision: 1,
      idleExpiresAt: new Date(now - 3_600_000),
      hardExpiresAt: new Date(now - 3_600_000),
      terminalReason: "PRINT_UNCONFIRMED",
      createdAt: new Date(now - 7_200_000),
      // Overdue by design: this is the alarm the panel exists to raise.
      cleanupStatus: "DEAD_LETTER",
      cleanupDueAt: new Date(now - 5_400_000)
    }
  });

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
      // The canary. A response containing this has leaked a customer's own
      // description of their document.
      displayName: `${canary}.pdf`,
      status: "READY",
      kind: "PDF",
      declaredMime: "application/pdf",
      detectedMime: "application/pdf",
      extension: "pdf",
      reservedBytes: 4096,
      sizeBytes: 2048,
      contentSha256: canaryDigest,
      quarantineObjectKey: `quarantine/v1/${sessionId}/${fileId}/${canary}${randomBytes(4).toString("hex")}`,
      processingGeneration: 1,
      processingAttempts: 1,
      processingStartedAt: new Date(now - 7_000_000),
      malwareScanStatus: "CLEAN",
      pageCount: 3,
      quarantinedAt: new Date(now - 7_100_000),
      readyAt: new Date(now - 6_900_000)
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
      selections: [{ fileId, contentSha256: canaryDigest, pages: "1-3" }],
      selectedPages: 3,
      printedSides: 3,
      physicalSheets: 3,
      capabilityVersion: 1,
      manifestHash,
      createdByActorType: "KIOSK",
      createdByActorId: kioskId
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
      providerIntentId: `intent_obs_${randomBytes(8).toString("hex")}`,
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
      authorizedAt: new Date(now - 6_950_000),
      capturedAt: new Date(now - 6_900_000)
    }
  });

  await database.paymentAttempt.create({
    data: { id: randomUUID(), paymentId, attempt: 1, action: "CAPTURE", status: "CAPTURED" }
  });

  // A print job may only be created for a paid session, so the state moves
  // through PAID exactly as production does before settling.
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
      // The canary again: the manifest names the documents that were printed.
      jobManifest: { documents: [{ fileId, marker: canary }] },
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

  await database.printJob.update({
    where: { id: printJobId },
    // Settled as RECOVERY_REQUIRED: the device never confirmed, the system
    // refuses to guess, and a person has to decide. It is the state the whole
    // control plane exists to surface.
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
    data: { state: "PRINTING" }
  });
  await database.printSession.update({
    where: { id: sessionId },
    data: { state: "RECOVERY_REQUIRED" }
  });

  for (const [index, type] of ["CREATED", "DISPATCHED", "SUBMITTED"].entries()) {
    await database.printJobEvent.create({
      data: {
        id: randomUUID(),
        printJobId,
        sequence: index + 1,
        type,
        status: index === 2 ? "RECOVERY_REQUIRED" : "QUEUED",
        detail: { marker: canary }
      }
    });
  }

  await database.agentCommand.create({
    data: {
      id: randomUUID(),
      kioskId,
      sessionId,
      printJobId,
      operationId: randomUUID(),
      type: "PRINT",
      status: "COMPLETED",
      // The canary a third time: this payload tells a kiosk where to fetch the
      // documents from.
      payload: { documents: [{ url: `https://storage.invalid/${canary}` }] },
      expiresAt: new Date(now - 6_000_000),
      resultCode: "OK",
      completedAt: new Date(now - 6_500_000)
    }
  });

  await database.refund.create({
    data: {
      id: randomUUID(),
      paymentId,
      sessionId,
      provider: "MOCK",
      reason: "PRINT_FAILED",
      amountMinor: 18_000,
      currency: "AMD",
      currencyExponent: 2,
      status: "PENDING",
      createdAt: new Date(now - 7_200_000)
    }
  });

  await database.cleanupRun.create({
    data: {
      id: randomUUID(),
      sessionId,
      // The reason a cleanup run records is the terminal state that scheduled it.
      reason: "RECOVERY_REQUIRED",
      status: "DEAD_LETTER",
      checkpoint: "ARTIFACTS_DELETED",
      attempts: 5,
      lastErrorCode: "OBJECT_STORE_UNAVAILABLE",
      availableAt: new Date(now - 3_600_000),
      deadLetteredAt: new Date(now - 1_800_000),
      createdAt: new Date(now - 5_400_000)
    }
  });

  for (const [index, type] of ["session.created", "file.uploaded", "print.completed"].entries()) {
    await database.sessionEvent.create({
      data: {
        id: randomUUID(),
        sessionId,
        kioskId,
        sequence: index + 1,
        type,
        // The canary a fourth time: the timeline must not return this.
        payload: { file: { displayName: `${canary}.pdf` } },
        occurredAt: new Date(now - 7_200_000 + index * 60_000)
      }
    });
  }

  await database.auditEvent.create({
    data: {
      id: randomUUID(),
      actorType: "KIOSK",
      actorId: kioskId,
      kioskId,
      sessionId,
      action: "test.canary",
      outcome: "SUCCESS",
      // A recognised key beside an unrecognised one holding a filename. The
      // viewer must show the first and withhold the second.
      metadata: {
        fileId: "019f0000-0000-7000-8000-000000000001",
        customerFileName: `${canary}.pdf`
      }
    }
  });

  return { sessionId, printJobId, paymentId };
}

async function cleanUpSeededAdmins(): Promise<void> {
  const ids = seededAdminUserIds.splice(0);
  if (ids.length === 0) return;
  await database.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminKioskScope.deleteMany({ where: { adminUserId: { in: ids } } });
  // Suspend first: the "keep a spare" trigger refuses to strip an ACTIVE
  // account, which is exactly the invariant Phase 1 relies on.
  await database.adminUser.updateMany({
    where: { id: { in: ids } },
    data: { status: "SUSPENDED" }
  });
  await database.adminAuthenticator.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminUser.deleteMany({ where: { id: { in: ids } } });
}

/**
 * Remove this suite's kiosks and everything that hangs off them.
 *
 * Audit events are append-only and are deliberately not cleaned up: the log
 * outlives the rows it describes, which is the point of it.
 */
async function cleanUpOperationalData(): Promise<void> {
  const kioskIds = [kioskA, kioskB];
  const sessions = await database.printSession.findMany({
    where: { kioskId: { in: kioskIds } },
    select: { id: true }
  });
  const sessionIds = sessions.map((session) => session.id);

  if (sessionIds.length > 0) {
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
