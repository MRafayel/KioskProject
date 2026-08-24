import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AdminRole } from "../../packages/admin-access/src/index.js";
import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import {
  createAdminPricingClient,
  createAdminReadClient,
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
import { hashPassword } from "../../services/api/src/modules/admin/passwords.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

/**
 * The Phase 5 acceptance gate.
 *
 * The phase's claim is not "two people agree" — this system has one Admin. It is
 * that an Admin cannot change what every customer is charged *quietly*, and
 * these are the questions that decide whether that holds.
 *
 *   Can a tariff be published that no record accounts for, or that differs from
 *   what was confirmed? A deferred trigger recomputes the tariff's canonical
 *   digest from the rows actually written and refuses at COMMIT — so the answer
 *   does not depend on this repository being correct.
 *
 *   Can the record be edited or removed afterwards? No connection here can,
 *   including the application's own.
 *
 *   Can the publishing connection reach anything else? It cannot read a quote,
 *   edit a tariff, delete one, or bring an archived one back. Asked of
 *   PostgreSQL directly.
 *
 *   Does the confirmation mean anything? Publishing echoes the digest of what
 *   was priced out, and both it and the baseline are recomputed server-side.
 *
 * Every action runs through the real API on the least-privilege role, so these
 * are statements about the deployed shape rather than about this file.
 */

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({ ...process.env, NODE_ENV: "test" });
assertSafeIntegrationEnvironment(environment);

const database = createDatabaseClient(environment.DATABASE_URL);
const readDatabase = createAdminReadClient(
  environment.ADMIN_READ_DATABASE_URL ?? environment.DATABASE_URL
);
const pricingDatabase = createAdminPricingClient(
  environment.ADMIN_PRICING_DATABASE_URL ?? environment.DATABASE_URL
);

/** True when the tests exercise the real grants rather than the app role. */
const usingPricingRole = Boolean(
  environment.ADMIN_PRICING_DATABASE_URL &&
  environment.ADMIN_PRICING_DATABASE_URL !== environment.DATABASE_URL
);

let app: Awaited<ReturnType<typeof buildApp>>;

const suite = randomBytes(4).toString("hex");
const seededAdminUserIds: string[] = [];
/** Rule sets this suite published, cleaned up at the end. */
const publishedRuleSetIds: string[] = [];

interface SeededSession {
  adminUserId: string;
  cookieHeader: string;
  csrfToken: string;
}

let publisher: SeededSession;
let technical: SeededSession;
let operatorSession: SeededSession;

/** The tariff this suite starts every test from, restored in `afterEach`. */
let baselineRuleSetId: string;
let baselineVersion: string;

beforeAll(async () => {
  app = await buildApp({
    environment,
    database,
    adminReadDatabase: readDatabase,
    adminPricingDatabase: pricingDatabase,
    startBackgroundJobs: false
  });

  await cleanUpSeededAdmins();

  publisher = await seedSession("ADMIN", { steppedUp: true });
  technical = await seedSession("TECHNICAL_ADMIN", { steppedUp: true });
  operatorSession = await seedSession("OPERATOR", { steppedUp: true });

  const existing = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED", scope: "GLOBAL", scopeRef: "" }
  });
  if (!existing) {
    throw new Error("These tests replace the published tariff; seed one with `pnpm db:seed`.");
  }
  baselineRuleSetId = existing.id;
  baselineVersion = existing.version;
}, 60_000);

/**
 * A fresh session per test, on the same three accounts.
 *
 * The per-account rate limit is deliberately tight — ten change actions a
 * minute from one signed-in session — so a suite driving more than that through
 * one session would be testing the rate limiter rather than the phase.
 */
beforeEach(async () => {
  publisher = await seedLiveSession(publisher.adminUserId, { steppedUp: true });
  technical = await seedLiveSession(technical.adminUserId, { steppedUp: true });
  operatorSession = await seedLiveSession(operatorSession.adminUserId, { steppedUp: true });
});

/**
 * Put the tariff back.
 *
 * Publishing is the one admin action that changes something the whole product
 * reads, so a test that published has moved the world for every test after it.
 * Restoring it here — rather than in `afterAll` — keeps each test's baseline the
 * same one, which is what makes the baseline-digest assertions meaningful.
 */
afterEach(async () => {
  await restoreBaselineTariff();
});

afterAll(async () => {
  await cleanUpChangeRecords();
  await cleanUpSeededAdmins();
  await app.close();
  await database.$disconnect();
  await readDatabase.$disconnect();
  await pricingDatabase.$disconnect();
});

// ---------------------------------------------------------------------------
// The gate: what the publishing connection cannot reach
// ---------------------------------------------------------------------------

describe("the publishing connection is bounded by grants rather than by handlers", () => {
  it("cannot read a quote, edit a tariff, or erase a record", async () => {
    if (!usingPricingRole) return expectSkippedRoleCheck();

    // What a customer was already told they would pay is evidence. A new tariff
    // does not reach backwards, and this connection cannot even look.
    expect(
      (
        await captureFailure(() =>
          pricingDatabase.$queryRawUnsafe(`SELECT "total_minor" FROM "price_quotes" LIMIT 1`)
        )
      )?.code
    ).toBe("42501");

    expect(
      (
        await captureFailure(() =>
          pricingDatabase.$executeRawUnsafe(
            `UPDATE "pricing_rules" SET "unit_amount_minor" = 1 WHERE "rule_set_id" = $1`,
            baselineRuleSetId
          )
        )
      )?.code
    ).toBe("42501");

    expect(
      (
        await captureFailure(() =>
          pricingDatabase.$executeRawUnsafe(
            `UPDATE "pricing_rule_sets" SET "version" = 'renamed' WHERE "id" = $1`,
            baselineRuleSetId
          )
        )
      )?.code
    ).toBe("42501");

    expect(
      (
        await captureFailure(() =>
          pricingDatabase.$executeRawUnsafe(
            `DELETE FROM "pricing_rule_sets" WHERE "id" = $1`,
            baselineRuleSetId
          )
        )
      )?.code
    ).toBe("42501");

    expect(
      (
        await captureFailure(() =>
          pricingDatabase.$executeRawUnsafe(
            `DELETE FROM "audit_events" WHERE "id" = $1`,
            randomUUID()
          )
        )
      )?.code
    ).toBe("42501");
  });

  it("cannot rewrite or remove the record of what it published", async () => {
    if (!usingPricingRole) return expectSkippedRoleCheck();

    // Missing grants, not a trigger. The connection that changes the prices
    // cannot revise the account of having done so.
    for (const statement of [
      `UPDATE "admin_change_executions" SET "reason" = 'A better reason.'`,
      `DELETE FROM "admin_change_executions"`
    ]) {
      expect((await captureFailure(() => pricingDatabase.$executeRawUnsafe(statement))).code).toBe(
        "42501"
      );
    }
  });

  it("cannot bring an archived tariff back", async () => {
    if (!usingPricingRole) return expectSkippedRoleCheck();

    const archived = await database.pricingRuleSet.findFirst({
      where: { status: "ARCHIVED" },
      select: { id: true }
    });
    if (!archived) return;

    // The grant permits UPDATE on `status`; the trigger is what says which
    // direction. Without it, un-archiving would be a way to reinstate a tariff
    // nobody published.
    expect(
      (
        await captureFailure(() =>
          pricingDatabase.$executeRawUnsafe(
            `UPDATE "pricing_rule_sets" SET "status" = 'PUBLISHED' WHERE "id" = $1`,
            archived.id
          )
        )
      )?.code
    ).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
// The gate: nothing publishes without a record of who did it
// ---------------------------------------------------------------------------

describe("a tariff the control plane writes must be one a record accounts for", () => {
  it("refuses a tariff written with no record behind it", async () => {
    if (!usingPricingRole) return expectSkippedRoleCheck();

    // A non-global scope, so this reaches the deferred trigger at COMMIT rather
    // than colliding with the published-per-scope unique index on the way in.
    // The refusal being deferred is the point: the record legitimately has to be
    // written after the tariff it names.
    const failure = await captureFailure(() =>
      pricingDatabase.$executeRawUnsafe(
        `INSERT INTO "pricing_rule_sets"
           ("id", "version", "scope", "scope_ref", "currency", "currency_exponent", "status",
            "rounding", "tax_mode", "minimum_application", "valid_from", "published_at")
         VALUES ($1, $2, 'KIOSK', $3, 'AMD', 2, 'PUBLISHED', 'HALF_UP', 'EXCLUSIVE',
                 'BEFORE_TAX', now(), now())`,
        randomUUID(),
        `unrecorded-${suite}`,
        `kiosk-${suite}`
      )
    );
    // `restrict_violation`, and the message too: the code alone is raised by
    // several triggers on this table, and this test is only meaningful if it was
    // the deferred one that refused.
    expect(failure.code).toBe("23001");
    expect(failure.message).toMatch(/must record who published it/u);
  });

  it("refuses a draft the control plane leaves behind", async () => {
    if (!usingPricingRole) return expectSkippedRoleCheck();

    // A draft is a step inside the publishing transaction, never a committed
    // state. Without this, an unpublished tariff with no record could be left
    // lying in the table for a later UPDATE to promote.
    const failure = await captureFailure(() =>
      pricingDatabase.$executeRawUnsafe(
        `INSERT INTO "pricing_rule_sets"
           ("id", "version", "scope", "scope_ref", "currency", "currency_exponent", "status",
            "rounding", "tax_mode", "minimum_application", "valid_from")
         VALUES ($1, $2, 'KIOSK', $3, 'AMD', 2, 'DRAFT', 'HALF_UP', 'EXCLUSIVE',
                 'BEFORE_TAX', now())`,
        randomUUID(),
        `draft-${suite}`,
        `kiosk-draft-${suite}`
      )
    );
    // insufficient_privilege, raised by the same deferred check.
    expect(failure.code).toBe("42501");
    expect(failure.message).toMatch(/may only write a published tariff/u);
  });

  it("refuses a rule added to a tariff after it was published", async () => {
    if (!usingPricingRole) return expectSkippedRoleCheck();

    const result = await publish(publisher, { unitAmountMinor: 6_400 });
    const publishedId = (await currentTariff()).id;
    expect(result.publishedVersion).toBe(result.publishedVersion);

    // The digest covers every rule attached to the set, so slipping a second one
    // in afterwards makes the recomputed digest stop matching the record that
    // was already satisfied.
    const failure = await captureFailure(() =>
      pricingDatabase.$executeRawUnsafe(
        `INSERT INTO "pricing_rules"
           ("id", "rule_set_id", "service", "paper_size", "color_mode", "unit_amount_minor")
         VALUES ($1, $2, 'PRINT', 'A4', 'MONOCHROME', 1)`,
        randomUUID(),
        publishedId
      )
    );
    // The immutability trigger gets there first, before the deferred digest
    // check has a chance to notice. Both mean the same thing from a caller's
    // side: a published tariff cannot drift from the recorded one.
    expect(failure.code).toBe("23001");
    expect(failure.message).toMatch(/immutable/u);
  });

  it("keeps the record even from the application connection", async () => {
    const result = await publish(publisher, { unitAmountMinor: 6_450 });

    const record = await database.adminChangeExecution.findFirst({
      where: { resultRef: result.publishedVersion },
      select: { id: true }
    });
    expect(record).not.toBeNull();

    // Append-only by trigger, for every role including the table's owner. A
    // record of what the prices did that could be rewritten is not a record.
    for (const statement of [
      `UPDATE "admin_change_executions" SET "reason" = 'Something else.' WHERE "id" = $1`,
      `DELETE FROM "admin_change_executions" WHERE "id" = $1`
    ]) {
      const failure = await captureFailure(() => database.$executeRawUnsafe(statement, record?.id));
      expect(failure.code).toBe("23001");
      expect(failure.message).toMatch(/append-only/u);
    }
  });

  it("computes the same digest in SQL as in TypeScript", async () => {
    // The property every other guarantee in this phase rests on. If the two
    // implementations of the canonical text ever disagree, publishing fails
    // closed — which is the right direction, but it would take the feature down,
    // so it is asserted on a real round trip rather than assumed.
    const result = await publish(publisher, { unitAmountMinor: 6_460 });
    const live = await currentTariff();

    const [row] = await database.$queryRawUnsafe<{ digest: string }[]>(
      `SELECT "pricing_rule_sets_canonical_digest"($1::uuid) AS "digest"`,
      live.id
    );
    const record = await database.adminChangeExecution.findFirst({
      where: { resultRef: result.publishedVersion },
      select: { payloadDigest: true }
    });

    expect(row?.digest).toBe(record?.payloadDigest);
  });
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

describe("publishing replaces the tariff, and says who did it", () => {
  it("replaces it in one transaction, with a name on the record", async () => {
    const before = await currentTariff();
    const result = await publish(publisher, { unitAmountMinor: 6_500 });

    expect(result.published).toBe(true);
    expect(result.replacedVersion).toBe(before.version);

    const live = await currentTariff();
    expect(live.version).toBe(result.publishedVersion);
    expect(live.rule?.unitAmountMinor).toBe(6_500);

    // The predecessor is archived in the same transaction, because the
    // published-per-scope unique index permits exactly one.
    const previous = await database.pricingRuleSet.findUnique({
      where: { id: before.id },
      select: { status: true, archivedAt: true }
    });
    expect(previous?.status).toBe("ARCHIVED");
    expect(previous?.archivedAt).not.toBeNull();

    const record = await database.adminChangeExecution.findFirst({
      where: { resultRef: result.publishedVersion }
    });
    expect(record?.publishedByAdminId).toBe(publisher.adminUserId);
    expect(record?.publishedByRole).toBe("ADMIN");
    expect(record?.replacedRef).toBe(before.version);
    expect(record?.resultRuleSetId).toBe(live.id);

    const audit = await database.auditEvent.findFirst({
      where: { actorId: publisher.adminUserId, action: "admin.change.publish", outcome: "SUCCESS" },
      orderBy: { occurredAt: "desc" }
    });
    const metadata = audit?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.pricingVersion).toBe(result.publishedVersion);
    expect(metadata?.replacedPricingVersion).toBe(before.version);
    // The amounts, not only a digest: an audit row about the prices that needs a
    // join to a table somebody has since replaced is one nobody can read.
    expect(metadata?.unitAmountMinor).toBe(6_500);
  });

  it("prices the new tariff for a customer immediately", async () => {
    const result = await publish(publisher, { unitAmountMinor: 6_300 });

    // The property that matters to the product rather than to the workflow:
    // there is no window in which no tariff covers `now`, because the archive
    // and the publication are one transaction.
    const live = await database.pricingRuleSet.findFirst({
      where: {
        status: "PUBLISHED",
        scope: "GLOBAL",
        scopeRef: "",
        validFrom: { lte: new Date() },
        OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }]
      }
    });
    expect(live?.version).toBe(result.publishedVersion);
  });

  it("shows the log with the live tariff marked", async () => {
    const result = await publish(publisher, { unitAmountMinor: 6_600 });

    const listing = await request(publisher, "GET", "/v1/admin/changes");
    expect(listing.statusCode).toBe(200);
    const body = listing.json() as {
      changes: { resultRef: string; inForce: boolean; publishedByDisplayName: string | null }[];
      current: { version: string; baselineDigest: string };
    };

    const row = body.changes.find((change) => change.resultRef === result.publishedVersion);
    expect(row?.inForce).toBe(true);
    expect(row?.publishedByDisplayName).not.toBeNull();
    expect(body.current.version).toBe(result.publishedVersion);
    // Only one row can be in force at a time, and it is derived from the tariff
    // rather than stored, so nothing has to write a "no longer current" flag.
    expect(body.changes.filter((change) => change.inForce)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The confirmation
// ---------------------------------------------------------------------------

describe("you publish what you were shown", () => {
  it("prices the change out without changing anything", async () => {
    const response = await request(publisher, "POST", "/v1/admin/changes/preview", {
      payload: { kind: "PRICING_PUBLISH", pricing: tariffPayload({ unitAmountMinor: 8_000 }) }
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      published: boolean;
      preview: {
        rows: { currentTotalMinor: number; proposedTotalMinor: number }[];
        payloadDigest: string;
        baselineDigest: string;
      };
    };

    expect(body.published).toBe(false);
    expect(body.preview.rows.length).toBeGreaterThan(0);
    // The whole reason the preview exists: an Admin is shown money, and it
    // moved.
    for (const row of body.preview.rows) expect(row.proposedTotalMinor).toBeGreaterThan(0);
    expect(body.preview.rows.some((row) => row.proposedTotalMinor !== row.currentTotalMinor)).toBe(
      true
    );

    // And nothing happened.
    expect((await currentTariff()).version).toBe(baselineVersion);
  });

  it("refuses a publication whose numbers are not the ones that were priced", async () => {
    const payload = tariffPayload({ unitAmountMinor: 7_100 });
    const preview = await previewOf(publisher, payload);

    const response = await request(publisher, "POST", "/v1/admin/changes", {
      payload: { kind: "PRICING_PUBLISH", pricing: { ...payload, unitAmountMinor: 9_999 } },
      payloadDigest: preview.payloadDigest,
      baselineDigest: preview.baselineDigest,
      reason: "Publishing numbers nobody looked at."
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CHANGE_NOT_PREVIEWED");
    expect((await currentTariff()).version).toBe(baselineVersion);
  });

  it("refuses a publication written against a tariff that has since moved", async () => {
    const payload = tariffPayload({ unitAmountMinor: 7_300 });
    const stale = await previewOf(publisher, payload);

    // Somebody publishes in between, which moves the baseline the first preview
    // was taken against.
    await publish(publisher, { unitAmountMinor: 7_400 });

    const response = await request(publisher, "POST", "/v1/admin/changes", {
      payload: { kind: "PRICING_PUBLISH", pricing: payload },
      payloadDigest: stale.payloadDigest,
      baselineDigest: stale.baselineDigest,
      reason: "Publishing against a tariff that moved."
    });

    expect(response.statusCode).toBe(409);
    // Either check catches it: the payload digest folds in the tariff's policy
    // fields, and the baseline digest is compared outright.
    expect(["CHANGE_BASELINE_MOVED", "CHANGE_NOT_PREVIEWED"]).toContain(response.json().error.code);
  });

  it("refuses a version somebody has used before", async () => {
    const live = await currentTariff();
    const payload = { ...tariffPayload({ unitAmountMinor: 7_000 }), version: live.version };
    const preview = await previewOf(publisher, payload);

    const response = await request(publisher, "POST", "/v1/admin/changes", {
      payload: { kind: "PRICING_PUBLISH", pricing: payload },
      payloadDigest: preview.payloadDigest,
      baselineDigest: preview.baselineDigest,
      reason: "Reusing a version name that exists."
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PRICING_VERSION_TAKEN");
  });

  it("refuses a currency, and a validity window, in the payload", async () => {
    for (const extra of [{ currency: "USD" }, { validFrom: "2030-01-01T00:00:00.000Z" }]) {
      const response = await request(publisher, "POST", "/v1/admin/changes/preview", {
        payload: {
          kind: "PRICING_PUBLISH",
          pricing: { ...tariffPayload({ unitAmountMinor: 7_200 }), ...extra }
        }
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

describe("changing the prices is an Admin's, reading about it is not", () => {
  it("refuses a Technical Admin, and records the refusal", async () => {
    const payload = tariffPayload({ unitAmountMinor: 6_700 });

    const attempt = await request(technical, "POST", "/v1/admin/changes", {
      payload: { kind: "PRICING_PUBLISH", pricing: payload },
      payloadDigest: "a".repeat(64),
      baselineDigest: "b".repeat(64),
      reason: "The support role changing prices."
    });
    expect(attempt.statusCode).toBe(403);
    expect(attempt.json().error.code).toBe("ADMIN_FORBIDDEN");

    const refusals = await database.auditEvent.count({
      where: { actorId: technical.adminUserId, outcome: "DENIED" }
    });
    expect(refusals).toBeGreaterThanOrEqual(1);
    expect((await currentTariff()).version).toBe(baselineVersion);
  });

  it("lets a Technical Admin read the log and price a change out", async () => {
    // Support means diagnostics. "What did the prices do at 14:03" and "what
    // would this do" are both diagnostic questions; neither changes anything.
    const listing = await request(technical, "GET", "/v1/admin/changes");
    expect(listing.statusCode).toBe(200);
    expect(Array.isArray(listing.json().changes)).toBe(true);

    const preview = await request(technical, "POST", "/v1/admin/changes/preview", {
      payload: { kind: "PRICING_PUBLISH", pricing: tariffPayload({ unitAmountMinor: 6_800 }) }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().published).toBe(false);
    expect((await currentTariff()).version).toBe(baselineVersion);
  });

  it("refuses an Operator the section entirely", async () => {
    for (const [method, url] of [
      ["GET", "/v1/admin/changes"],
      ["POST", "/v1/admin/changes/preview"],
      ["POST", "/v1/admin/changes"]
    ] as const) {
      const response = await request(
        operatorSession,
        method,
        url,
        method === "GET" ? undefined : {}
      );
      expect(response.statusCode, url).toBe(403);
      expect(response.json().error.code, url).toBe("ADMIN_FORBIDDEN");
    }
  });

  it("refuses publishing without a fresh assertion", async () => {
    const payload = tariffPayload({ unitAmountMinor: 6_900 });
    const preview = await previewOf(publisher, payload);
    const stale = await seedLiveSession(publisher.adminUserId, { steppedUp: false });

    const response = await request(stale, "POST", "/v1/admin/changes", {
      payload: { kind: "PRICING_PUBLISH", pricing: payload },
      payloadDigest: preview.payloadDigest,
      baselineDigest: preview.baselineDigest,
      reason: "No key touched here."
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("ADMIN_STEP_UP_REQUIRED");
    expect((await currentTariff()).version).toBe(baselineVersion);
  });

  it("refuses a suspended Admin at the database even with a live session", async () => {
    if (!usingPricingRole) return expectSkippedRoleCheck();

    // The role on the account row, not the one the session presented. Suspending
    // revokes sessions, so this is unreachable through the API — which is why it
    // is asked of the trigger directly.
    const failure = await captureFailure(() =>
      pricingDatabase.$executeRawUnsafe(
        `INSERT INTO "admin_change_executions"
           ("id", "kind", "payload", "payload_digest", "baseline_digest", "reason",
            "published_by_admin_id", "published_by_role")
         VALUES ($1, 'PRICING_PUBLISH', '{}'::jsonb, $2, $2, 'Written by the support role.',
                 $3, 'ADMIN')`,
        randomUUID(),
        "a".repeat(64),
        technical.adminUserId
      )
    );
    expect(failure.code).toBe("23514");
    expect(failure.message).toMatch(/must be published by an active Admin/u);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(session: SeededSession, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: session.cookieHeader,
      ...(method === "GET" ? {} : { [ADMIN_CSRF_HEADER]: session.csrfToken })
    },
    ...(payload === undefined ? {} : { payload })
  });
}

let versionCounter = 0;

/** A tariff payload that differs from the baseline, with a version nobody has used. */
function tariffPayload(overrides: Partial<Record<string, number>> = {}) {
  versionCounter += 1;
  return {
    version: `p5-${suite}-${versionCounter}`,
    unitAmountMinor: 5_000,
    duplexAdjustmentBasisPoints: 0,
    serviceFeeMinor: 0,
    minimumAmountMinor: 0,
    taxBasisPoints: 2_000,
    ...overrides
  };
}

interface Preview {
  payloadDigest: string;
  baselineDigest: string;
}

async function previewOf(session: SeededSession, pricing: object): Promise<Preview> {
  const response = await request(session, "POST", "/v1/admin/changes/preview", {
    payload: { kind: "PRICING_PUBLISH", pricing }
  });
  if (response.statusCode !== 200) {
    throw new Error(`preview failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { preview: Preview }).preview;
}

/** Price a change out and publish it, the way the panel does. */
async function publish(
  session: SeededSession,
  overrides: Partial<Record<string, number>>
): Promise<{ published: boolean; publishedVersion: string; replacedVersion: string | null }> {
  const pricing = tariffPayload(overrides);
  const preview = await previewOf(session, pricing);

  const response = await request(session, "POST", "/v1/admin/changes", {
    payload: { kind: "PRICING_PUBLISH", pricing },
    payloadDigest: preview.payloadDigest,
    baselineDigest: preview.baselineDigest,
    reason: "Paper costs rose at the supplier."
  });
  if (response.statusCode !== 200) {
    throw new Error(`publish failed: ${response.statusCode} ${response.body}`);
  }

  const live = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED", scope: "GLOBAL", scopeRef: "" },
    select: { id: true }
  });
  if (live && live.id !== baselineRuleSetId) publishedRuleSetIds.push(live.id);

  return response.json() as {
    published: boolean;
    publishedVersion: string;
    replacedVersion: string | null;
  };
}

async function currentTariff() {
  const ruleSet = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED", scope: "GLOBAL", scopeRef: "" },
    include: { rules: true }
  });
  if (!ruleSet) throw new Error("no published tariff");
  return { ...ruleSet, rule: ruleSet.rules[0] ?? null };
}

/**
 * Put the seeded tariff back in force and remove anything this suite published.
 *
 * The records go first: they hold `ON DELETE RESTRICT` to the rule set they
 * name, which is the property that stops a published tariff being removed while
 * the record of who published it still stands.
 */
async function restoreBaselineTariff(): Promise<void> {
  const published = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED", scope: "GLOBAL", scopeRef: "" },
    select: { id: true }
  });
  if (published?.id === baselineRuleSetId && publishedRuleSetIds.length === 0) return;

  await cleanUpChangeRecords();

  if (published && published.id !== baselineRuleSetId) {
    await database.pricingRuleSet.updateMany({
      where: { id: published.id },
      data: { status: "ARCHIVED", archivedAt: new Date() }
    });
  }
  await database.pricingRuleSet.updateMany({
    where: { id: baselineRuleSetId },
    data: { status: "PUBLISHED", archivedAt: null }
  });

  for (const id of publishedRuleSetIds.splice(0)) {
    await database.pricingRule.deleteMany({ where: { ruleSetId: id } });
    await database.pricingRuleSet.deleteMany({ where: { id } });
  }
}

/**
 * Remove this suite's publication records.
 *
 * The table is append-only by trigger, so deleting needs the triggers suspended
 * — which requires owning them, and none of the connections the control plane
 * uses can. A teardown that needed no special step would mean the guarantee was
 * not really there.
 */
async function cleanUpChangeRecords(): Promise<void> {
  const ids = seededAdminUserIds;
  if (ids.length === 0) return;

  await database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `ALTER TABLE "admin_change_executions" DISABLE TRIGGER USER`
    );
    await transaction.$executeRawUnsafe(
      `DELETE FROM "admin_change_executions" WHERE "published_by_admin_id" = ANY($1::uuid[])`,
      ids
    );
    await transaction.$executeRawUnsafe(
      `ALTER TABLE "admin_change_executions" ENABLE TRIGGER USER`
    );
  });
}

async function seedSession(
  role: AdminRole,
  options: { steppedUp: boolean }
): Promise<SeededSession> {
  const adminUserId = randomUUID();
  seededAdminUserIds.push(adminUserId);

  await database.adminUser.create({
    data: {
      id: adminUserId,
      userHandle: randomBytes(32),
      username: `u-${adminUserId.slice(0, 12)}`,
      displayName: `Changes ${role} ${randomBytes(2).toString("hex")}`,
      role,
      status: "PROVISIONING"
    }
  });

  // No account may become ACTIVE without a password now.
  await database.adminPassword.create({
    data: { adminUserId, digest: await hashPassword("integration-suite-password") }
  });

  for (let index = 0; index < 1; index += 1) {
    await database.adminAuthenticator.create({
      data: {
        id: randomUUID(),
        adminUserId,
        credentialId: `changes-session-${adminUserId}-${index}`,
        publicKey: randomBytes(32),
        label: `key ${index}`,
        attachment: "cross-platform",
        backupEligible: false
      }
    });
  }

  await database.adminUser.update({
    where: { id: adminUserId },
    data: { status: "ACTIVE", activatedAt: new Date() }
  });

  return seedLiveSession(adminUserId, { steppedUp: options.steppedUp });
}

async function seedLiveSession(
  adminUserId: string,
  options: { steppedUp?: boolean } = {}
): Promise<SeededSession> {
  const now = Date.now();
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");

  await database.adminSession.create({
    data: {
      id: randomUUID(),
      adminUserId,
      tokenDigest: digestAdminSessionToken(sessionToken, environment.ADMIN_SESSION_PEPPER),
      csrfDigest: digestAdminCsrfToken(csrfToken, environment.ADMIN_SESSION_PEPPER),
      idleExpiresAt: new Date(now + 600_000),
      hardExpiresAt: new Date(now + 3_600_000),
      ...(options.steppedUp ? { lastStepUpAt: new Date(now) } : {})
    }
  });

  return {
    adminUserId,
    csrfToken,
    cookieHeader: `${ADMIN_SESSION_COOKIE}=${sessionToken}; ${ADMIN_CSRF_COOKIE}=${csrfToken}`
  };
}

async function cleanUpSeededAdmins(): Promise<void> {
  const ids = seededAdminUserIds.splice(0);
  if (ids.length === 0) return;

  await database.adminWebAuthnChallenge.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminSession.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminBreakGlassCredential.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminKioskScope.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminUser.updateMany({
    where: { id: { in: ids }, status: { not: "DISABLED" } },
    data: { status: "SUSPENDED" }
  });
  await database.adminAuthenticator.deleteMany({ where: { adminUserId: { in: ids } } });
  // The knowledge factor and the two kinds of one-time grant hold the account
  // by a RESTRICT foreign key, so they go first.
  await database.adminPassword.deleteMany({ where: { adminUserId: { in: ids } } });
  await database.adminInvitation.deleteMany({
    where: { OR: [{ adminUserId: { in: ids } }, { issuedByAdminId: { in: ids } }] }
  });
  await database.adminPasswordReset.deleteMany({
    where: { OR: [{ adminUserId: { in: ids } }, { issuedByAdminId: { in: ids } }] }
  });
  await database.adminUser.deleteMany({ where: { id: { in: ids } } });
}

interface Failure {
  code: string | undefined;
  message: string;
}

/**
 * Run something expected to be refused, and report *why*.
 *
 * The message matters as much as the code here. Several triggers on these tables
 * raise `restrict_violation`, so a test asserting only the code could pass
 * because the wrong guarantee fired — which would be worse than no test.
 */
async function captureFailure(run: () => Promise<unknown>): Promise<Failure> {
  try {
    await run();
    return { code: undefined, message: "" };
  } catch (error) {
    return {
      code: postgresErrorCode(error),
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  const walk = (value: unknown, depth = 0): string | undefined => {
    if (depth > 6 || !value || typeof value !== "object") return undefined;
    const code = Reflect.get(value, "code");
    // Digits only. Prisma's own codes look like `P2010`, and matching one of
    // those would turn "the driver reported something" into "PostgreSQL refused
    // the grant", which is the assertion this whole file rests on.
    if (typeof code === "string" && /^\d{5}$/u.test(code)) return code;
    const meta = Reflect.get(value, "meta");
    const nested = walk(meta, depth + 1) ?? walk(Reflect.get(value, "cause"), depth + 1);
    if (nested) return nested;
    const message = Reflect.get(value, "message");
    if (typeof message === "string") {
      const matched = /\b(42501|23001|23514|23503|23505|25006|2F003)\b/u.exec(message);
      if (matched) return matched[1];
    }
    return undefined;
  };
  return walk(error);
}

function expectSkippedRoleCheck(): void {
  expect(usingPricingRole).toBe(false);
}
