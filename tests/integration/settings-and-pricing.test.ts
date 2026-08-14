import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import {
  createQuoteResponseSchema,
  getQuoteResponseSchema
} from "../../packages/contracts/src/quotes.js";
import { createSessionResponseSchema } from "../../packages/contracts/src/sessions.js";
import {
  getPrintSettingsResponseSchema,
  printCapabilitiesResponseSchema,
  updatePrintSettingsResponseSchema
} from "../../packages/contracts/src/settings.js";
import {
  mobileContextResponseSchema,
  uploadFileResponseSchema
} from "../../packages/contracts/src/uploads.js";
import { createDatabaseClient } from "../../packages/database/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import { FileJanitor } from "../../services/api/src/modules/files/janitor.js";
import { createS3ObjectStore } from "../../services/api/src/modules/files/object-store.js";
import { CryptoRandomSource, SystemClock } from "../../services/api/src/modules/sessions/crypto.js";
import {
  DocumentProcessingCoordinator,
  type DocumentProcessingCoordinatorOptions
} from "../../services/worker/src/jobs/process-document.js";
import { DocumentProcessorClient } from "../../services/worker/src/processing/processor-client.js";
import { S3DocumentStore } from "../../services/worker/src/storage/document-store.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

const kioskId = "kiosk_phase6_integration_001";
const kioskCredentialId = "phase6-integration-kiosk-credential";
const kioskApiKey = "phase6-integration-kiosk-key-000001";
const foreignKioskId = "kiosk_phase6_integration_foreign";
const foreignCredentialId = "phase6-integration-foreign-credential";
const foreignApiKey = "phase6-integration-foreign-key-000001";

/**
 * The published development tariff, repeated here so the expected amounts in
 * this suite are written out rather than recomputed by the code under test.
 * Amounts are AMD minor units: 50.00 per printed side, no minimum transaction,
 * 20% tax, rounded half up.
 */
const developmentTariff = {
  version: "price-v2",
  unitAmountMinor: 5_000,
  serviceFeeMinor: 0,
  minimumAmountMinor: 0,
  taxBasisPoints: 2_000,
  currency: "AMD",
  currencyExponent: 2
};

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({
  ...process.env,
  NODE_ENV: "test",
  DEV_KIOSK_ID: kioskId,
  DEV_KIOSK_API_KEY: kioskApiKey,
  DOCUMENT_PROCESSOR_MEMORY_MIB: "3072",
  DOCUMENT_PROCESSOR_SCRATCH_BYTES: "2147483648",
  MALWARE_SCANNER_ADAPTER: "clamav"
});
assertSafeIntegrationEnvironment(environment);
const database = createDatabaseClient(environment.DATABASE_URL);
const serviceDatabase = database as unknown as DocumentProcessingCoordinatorOptions["database"];
const apiObjectStore = createS3ObjectStore(environment);
const workerStore = new S3DocumentStore({
  endpoint: environment.S3_ENDPOINT,
  region: environment.S3_REGION,
  bucket: environment.S3_BUCKET,
  accessKeyId: environment.S3_WORKER_ACCESS_KEY_ID,
  secretAccessKey: environment.S3_WORKER_SECRET_ACCESS_KEY,
  forcePathStyle: environment.S3_FORCE_PATH_STYLE,
  ...(environment.S3_SERVER_SIDE_ENCRYPTION
    ? { serverSideEncryption: environment.S3_SERVER_SIDE_ENCRYPTION }
    : {}),
  ...(environment.S3_KMS_KEY_ID ? { kmsKeyId: environment.S3_KMS_KEY_ID } : {})
});
const processor = new DocumentProcessorClient({
  endpoint: environment.DOCUMENT_PROCESSOR_URL,
  authToken: environment.DOCUMENT_PROCESSOR_AUTH_TOKEN,
  scratchDirectory: environment.DOCUMENT_PROCESSOR_SCRATCH_DIR,
  timeoutMilliseconds: environment.DOCUMENT_PROCESSOR_TIMEOUT_SECONDS * 1_000,
  maxResponseBytes: environment.DOCUMENT_PROCESSOR_RESPONSE_MAX_BYTES,
  maxPages: environment.MAX_DOCUMENT_PAGES,
  maxPreviewBytes: environment.MAX_PREVIEW_FILE_BYTES,
  maxNormalizedBytes: environment.MAX_NORMALIZED_FILE_BYTES
});
const authorization = `Bearer ${kioskApiKey}`;
const foreignAuthorization = `Bearer ${foreignApiKey}`;
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

let app: Awaited<ReturnType<typeof buildApp>>;
let coordinator: DocumentProcessingCoordinator;
let janitor: FileJanitor;
let databaseReachable = false;

beforeAll(async () => {
  await assertPhase6Infrastructure();
  await ensureDevelopmentTariff();
  await cleanPhase6Fixtures();
  await Promise.all([
    upsertKiosk({ id: kioskId, publicCode: "PHASE6-INTEGRATION", name: "Phase 6 kiosk" }),
    upsertKiosk({ id: foreignKioskId, publicCode: "PHASE6-FOREIGN", name: "Phase 6 foreign kiosk" })
  ]);
  await Promise.all([
    upsertCredential({
      id: "01900000-0000-7000-8000-000000000601",
      kioskId,
      credentialId: kioskCredentialId,
      rawCredential: kioskApiKey
    }),
    upsertCredential({
      id: "01900000-0000-7000-8000-000000000602",
      kioskId: foreignKioskId,
      credentialId: foreignCredentialId,
      rawCredential: foreignApiKey
    })
  ]);

  app = await buildApp({
    environment,
    database: serviceDatabase,
    objectStore: apiObjectStore,
    maxMobileExchangesPerMinute: 1_000,
    maxSessionsPerMinute: 1_000
  });
  await mkdir(environment.DOCUMENT_PROCESSOR_SCRATCH_DIR, { recursive: true, mode: 0o700 });
  coordinator = new DocumentProcessingCoordinator({
    database: serviceDatabase,
    redisUrl: environment.REDIS_URL,
    store: workerStore,
    processor,
    logger: silentLogger,
    concurrency: 1,
    leaseMilliseconds: environment.DOCUMENT_PROCESSOR_LEASE_SECONDS * 1_000,
    maximumAttempts: environment.DOCUMENT_PROCESSOR_MAX_ATTEMPTS,
    dispatchIntervalMilliseconds: 100
  });
  janitor = new FileJanitor({
    database: serviceDatabase,
    objectStore: apiObjectStore,
    clock: new SystemClock(),
    random: new CryptoRandomSource(),
    uploadTimeoutSeconds: environment.UPLOAD_TIMEOUT_SECONDS,
    retentionPolicy: {
      settledGraceMilliseconds: environment.RETENTION_SETTLED_GRACE_SECONDS * 1_000,
      recoveryGraceMilliseconds: environment.RETENTION_RECOVERY_GRACE_SECONDS * 1_000
    }
  });
  coordinator.start();
}, 180_000);

afterAll(async () => {
  await coordinator?.close();
  await app?.close();
  if (databaseReachable) {
    await cleanPhase6Fixtures();
    await database.kioskCredential.deleteMany({
      where: { credentialId: { in: [kioskCredentialId, foreignCredentialId] } }
    });
    await database.kiosk.deleteMany({ where: { id: { in: [kioskId, foreignKioskId] } } });
  }
  await database.$disconnect();
}, 180_000);

beforeEach(async () => {
  await cleanPhase6Fixtures();
}, 180_000);

describe.sequential("Phase 6 settings and server-authoritative pricing", () => {
  it("configures a validated document and prices it from the published tariff", async () => {
    const prepared = await prepareConfigurableSession("phase6-happy-path");

    // A validated document moves the session on by itself.
    expect(prepared.session.state).toBe("FILES_UPLOADED");

    const capabilitiesResponse = await app.inject({
      method: "GET",
      url: `/v1/sessions/${prepared.session.id}/print-capabilities`,
      headers: { authorization }
    });
    expect(capabilitiesResponse.statusCode, capabilitiesResponse.body).toBe(200);
    const capabilities = printCapabilitiesResponseSchema.parse(capabilitiesResponse.json());
    expect(capabilities.colorModes).toEqual(["MONOCHROME"]);
    expect(capabilities.maxCopies).toBeLessThanOrEqual(environment.MAX_COPIES);

    const savedResponse = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-settings-1",
      body: settingsBody(prepared.fileId, { pageRanges: "3,1-2,2-3", copies: 2 })
    });
    expect(savedResponse.statusCode, savedResponse.body).toBe(200);
    const saved = updatePrintSettingsResponseSchema.parse(savedResponse.json());

    // The stored selection is canonical, not the text the customer typed.
    // Copies belong to the document, and its own totals include them.
    expect(saved.settings.files[0]).toMatchObject({
      fileId: prepared.fileId,
      pageRangeText: "1-3",
      pageRanges: [[1, 3]],
      selectedPages: 3,
      copies: 2,
      duplex: "SIMPLEX",
      orientation: "AUTO",
      printedSides: 6,
      physicalSheets: 6
    });
    expect(saved.settings).toMatchObject({
      revision: 1,
      colorMode: "MONOCHROME",
      paperSize: "A4",
      selectedPages: 3,
      printedSides: 6,
      physicalSheets: 6
    });
    expect(saved).toMatchObject({ sessionState: "CONFIGURING", quoteInvalidated: false });

    const readBack = await app.inject({
      method: "GET",
      url: `/v1/sessions/${prepared.session.id}/settings`,
      headers: { authorization }
    });
    expect(getPrintSettingsResponseSchema.parse(readBack.json()).settings).toEqual(saved.settings);

    const quoteResponse = await createQuote({
      sessionId: prepared.session.id,
      settingsRevision: saved.settings.revision,
      idempotencyKey: "phase6-quote-1"
    });
    expect(quoteResponse.statusCode, quoteResponse.body).toBe(201);
    const quote = createQuoteResponseSchema.parse(quoteResponse.json()).quote;

    // Six printed sides at 50.00 plus 20% tax.
    expect(quote).toMatchObject({
      status: "ACTIVE",
      settingsRevision: 1,
      pricingVersion: developmentTariff.version,
      currency: developmentTariff.currency,
      currencyExponent: developmentTariff.currencyExponent,
      selectedPages: 3,
      printedSides: 6,
      physicalSheets: 6,
      subtotalMinor: 30_000,
      taxMinor: 6_000,
      totalMinor: 36_000
    });
    expect(quote.breakdown).toEqual({
      printAmountMinor: 30_000,
      duplexAdjustmentMinor: 0,
      serviceFeeMinor: 0,
      minimumAdjustmentMinor: 0
    });
    expect(Number.isSafeInteger(quote.totalMinor)).toBe(true);
    expect(quote.totalMinor).toBe(quote.subtotalMinor + quote.taxMinor);

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/sessions/${prepared.session.id}/quotes/${quote.id}`,
      headers: { authorization }
    });
    expect(getQuoteResponseSchema.parse(fetched.json()).quote).toEqual(quote);

    const session = await database.printSession.findUniqueOrThrow({
      where: { id: prepared.session.id }
    });
    expect(session).toMatchObject({
      state: "CONFIGURING",
      currentSettingsRevision: 1,
      activeQuoteId: quote.id
    });

    const events = await database.outboxEvent.findMany({
      where: { aggregateId: prepared.session.id },
      orderBy: { sequence: "asc" }
    });
    const types = events.map((event) => event.type);
    expect(types).toContain("settings.updated");
    expect(types).toContain("quote.created");
    // Sequences stay gapless so the kiosk never has to resynchronize.
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1).map((value) => value)
    );
    const quoteEvent = events.find((event) => event.type === "quote.created");
    expect(quoteEvent?.payload).toMatchObject({ quoteId: quote.id, totalMinor: 36_000 });
    expect(JSON.stringify(quoteEvent?.payload)).not.toContain("manifestHash");
  }, 180_000);

  it("prices duplex output by printed side and physical sheet", async () => {
    const prepared = await prepareConfigurableSession("phase6-duplex");

    const saved = updatePrintSettingsResponseSchema.parse(
      (
        await saveSettings({
          sessionId: prepared.session.id,
          version: prepared.session.version,
          idempotencyKey: "phase6-settings-duplex",
          body: settingsBody(prepared.fileId, {
            pageRanges: null,
            copies: 2,
            duplex: "LONG_EDGE"
          })
        })
      ).json()
    );

    // Three selected pages, duplex: three sides per copy on two sheets.
    expect(saved.settings).toMatchObject({
      selectedPages: 3,
      printedSides: 6,
      physicalSheets: 4
    });

    const quote = createQuoteResponseSchema.parse(
      (
        await createQuote({
          sessionId: prepared.session.id,
          settingsRevision: saved.settings.revision,
          idempotencyKey: "phase6-quote-duplex"
        })
      ).json()
    ).quote;

    expect(quote).toMatchObject({
      printedSides: 6,
      physicalSheets: 4,
      subtotalMinor: 30_000,
      taxMinor: 6_000,
      totalMinor: 36_000
    });
  }, 180_000);

  it("charges a single side exactly what it costs, with no floor", async () => {
    const prepared = await prepareConfigurableSession("phase6-minimum");

    const saved = updatePrintSettingsResponseSchema.parse(
      (
        await saveSettings({
          sessionId: prepared.session.id,
          version: prepared.session.version,
          idempotencyKey: "phase6-settings-minimum",
          body: settingsBody(prepared.fileId, { pageRanges: "1", copies: 1 })
        })
      ).json()
    );
    expect(saved.settings.printedSides).toBe(1);

    const quote = createQuoteResponseSchema.parse(
      (
        await createQuote({
          sessionId: prepared.session.id,
          settingsRevision: saved.settings.revision,
          idempotencyKey: "phase6-quote-minimum"
        })
      ).json()
    ).quote;

    // One side is 50.00 and the tariff publishes no minimum, so the smallest
    // possible job is billed at its printed side and nothing more.
    expect(quote).toMatchObject({
      subtotalMinor: developmentTariff.unitAmountMinor,
      taxMinor: 1_000,
      totalMinor: 6_000
    });
    expect(quote.breakdown.minimumAdjustmentMinor).toBe(0);
  }, 180_000);

  it("replays an identical request and refuses a reused key with a different body", async () => {
    const prepared = await prepareConfigurableSession("phase6-idempotency");
    const body = settingsBody(prepared.fileId, { pageRanges: "1-2", copies: 1 });

    const first = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-settings-replay",
      body
    });
    const replay = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-settings-replay",
      body
    });
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());

    const reused = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-settings-replay",
      body: withCopies(body, 3)
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });

    // Exactly one revision exists, so a retry never multiplies the history.
    const revisions = await database.printSettingRevision.count({
      where: { sessionId: prepared.session.id }
    });
    expect(revisions).toBe(1);

    const saved = updatePrintSettingsResponseSchema.parse(first.json());
    const quote = await createQuote({
      sessionId: prepared.session.id,
      settingsRevision: saved.settings.revision,
      idempotencyKey: "phase6-quote-replay"
    });
    const quoteReplay = await createQuote({
      sessionId: prepared.session.id,
      settingsRevision: saved.settings.revision,
      idempotencyKey: "phase6-quote-replay"
    });
    expect(quoteReplay.json()).toEqual(quote.json());
    expect(await database.priceQuote.count({ where: { sessionId: prepared.session.id } })).toBe(1);
  }, 180_000);

  it("refuses a settings key reused under a version the request no longer names", async () => {
    const prepared = await prepareConfigurableSession("phase6-key-version");
    const body = settingsBody(prepared.fileId, { pageRanges: "1-2", copies: 1 });

    const first = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-settings-version-drift",
      body
    });
    expect(first.statusCode, first.body).toBe(200);
    const saved = updatePrintSettingsResponseSchema.parse(first.json());

    // The reply above is what a flaky kiosk network loses. The kiosk then
    // learns the new session version by other means and retries the identical
    // body — but the version is part of the stored request hash, so the key it
    // derives from that body can only be refused from here on. This is the
    // trap the client has to climb out of by replacing the key, and the server
    // is expected to keep refusing rather than to relax the check.
    const reused = await saveSettings({
      sessionId: prepared.session.id,
      version: saved.sessionVersion,
      idempotencyKey: "phase6-settings-version-drift",
      body
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });

    // A fresh key carrying the same body is accepted, which is precisely the
    // recovery the kiosk performs.
    const rotated = await saveSettings({
      sessionId: prepared.session.id,
      version: saved.sessionVersion,
      idempotencyKey: "phase6-settings-version-drift-2",
      body
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
  }, 180_000);

  it("reports an unusable printer snapshot as a device fault, not a bad request", async () => {
    const prepared = await prepareConfigurableSession("phase6-capabilities");

    // A kiosk provisioned before Phase 6, or one whose snapshot promises no
    // monochrome output, cannot be sold from. The capabilities response
    // requires at least one colour mode, so the failure has to be named
    // explicitly instead of surfacing as a complaint about the request.
    await database.kiosk.update({
      where: { id: kioskId },
      data: { capabilities: { service: "PRINT_ONLY" } }
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/sessions/${prepared.session.id}/print-capabilities`,
        headers: { authorization }
      });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "PRINTER_UNAVAILABLE" } });
    } finally {
      await database.kiosk.update({
        where: { id: kioskId },
        data: { capabilities: phase6Capabilities }
      });
    }
  }, 180_000);

  it("refuses every rule write against a published tariff, including an insert", async () => {
    const published = await database.pricingRuleSet.findFirstOrThrow({
      where: { status: "PUBLISHED", scope: "GLOBAL", scopeRef: "" }
    });

    // Inserting a rule into a published set changes what that published
    // version charges just as surely as editing one, so the database refuses
    // it. Without this the immutability guarantee would only hold for the
    // shapes of change that happened to be listed on the trigger.
    await expect(
      database.pricingRule.create({
        data: {
          id: "01900000-0000-7000-8000-0000000001ff",
          ruleSetId: published.id,
          service: "PRINT",
          paperSize: "A4",
          colorMode: "MONOCHROME",
          unitAmountMinor: 1,
          duplexAdjustmentBasisPoints: 0,
          serviceFeeMinor: 0,
          minimumAmountMinor: 0,
          taxBasisPoints: 0,
          priority: 99
        }
      })
    ).rejects.toThrow(/immutable/i);

    await expect(
      database.pricingRule.updateMany({
        where: { ruleSetId: published.id },
        data: { unitAmountMinor: 1 }
      })
    ).rejects.toThrow(/immutable/i);

    // A global tariff has nothing to scope to, so it cannot carry a scope_ref
    // that would let a second published global row exist beside it.
    await expect(
      database.pricingRuleSet.create({
        data: {
          id: "01900000-0000-7000-8000-0000000001fe",
          version: "phase6-stray-global",
          scope: "GLOBAL",
          scopeRef: "stray",
          currency: developmentTariff.currency,
          currencyExponent: developmentTariff.currencyExponent,
          status: "PUBLISHED",
          rounding: "HALF_UP",
          taxMode: "EXCLUSIVE",
          minimumApplication: "BEFORE_TAX",
          validFrom: new Date("2026-01-01T00:00:00.000Z"),
          publishedAt: new Date("2026-01-01T00:00:00.000Z")
        }
      })
    ).rejects.toThrow();
  }, 180_000);

  it("resolves two simultaneous saves into one revision and one stale version", async () => {
    const prepared = await prepareConfigurableSession("phase6-concurrent");

    // A double-tapped touchscreen sends the same version twice. One save must
    // win and the other must be told its version is stale; a serialization
    // conflict raised by the session row lock is not a server error.
    const [first, second] = await Promise.all([
      saveSettings({
        sessionId: prepared.session.id,
        version: prepared.session.version,
        idempotencyKey: "phase6-race-a",
        body: settingsBody(prepared.fileId, { copies: 2 })
      }),
      saveSettings({
        sessionId: prepared.session.id,
        version: prepared.session.version,
        idempotencyKey: "phase6-race-b",
        body: settingsBody(prepared.fileId, { copies: 3 })
      })
    ]);

    const statuses = [first.statusCode, second.statusCode].sort((left, right) => left - right);
    expect(statuses, `${first.body} | ${second.body}`).toEqual([200, 412]);
    expect(
      await database.printSettingRevision.count({ where: { sessionId: prepared.session.id } })
    ).toBe(1);
  }, 180_000);

  it("invalidates the active quote as soon as the settings change", async () => {
    const prepared = await prepareConfigurableSession("phase6-invalidate");
    const first = updatePrintSettingsResponseSchema.parse(
      (
        await saveSettings({
          sessionId: prepared.session.id,
          version: prepared.session.version,
          idempotencyKey: "phase6-settings-a",
          body: settingsBody(prepared.fileId, { pageRanges: null, copies: 1 })
        })
      ).json()
    );
    const quote = createQuoteResponseSchema.parse(
      (
        await createQuote({
          sessionId: prepared.session.id,
          settingsRevision: first.settings.revision,
          idempotencyKey: "phase6-quote-a"
        })
      ).json()
    ).quote;

    const second = await saveSettings({
      sessionId: prepared.session.id,
      version: first.sessionVersion,
      idempotencyKey: "phase6-settings-b",
      body: settingsBody(prepared.fileId, { pageRanges: null, copies: 3 })
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(updatePrintSettingsResponseSchema.parse(second.json())).toMatchObject({
      quoteInvalidated: true,
      settings: { revision: 2 }
    });

    const retired = await database.priceQuote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(retired).toMatchObject({
      status: "INVALIDATED",
      invalidationReason: "SETTINGS_CHANGED"
    });
    expect(retired.invalidatedAt).not.toBeNull();
    const session = await database.printSession.findUniqueOrThrow({
      where: { id: prepared.session.id }
    });
    expect(session.activeQuoteId).toBeNull();
    expect(
      await database.outboxEvent.count({
        where: { aggregateId: prepared.session.id, type: "quote.invalidated" }
      })
    ).toBe(1);

    // The superseded revision can no longer be priced.
    const stale = await createQuote({
      sessionId: prepared.session.id,
      settingsRevision: first.settings.revision,
      idempotencyKey: "phase6-quote-stale"
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "SETTINGS_REVISION_STALE" } });
  }, 180_000);

  it("retires the price and the settings when the document is removed", async () => {
    const prepared = await prepareConfigurableSession("phase6-document-change");
    const saved = updatePrintSettingsResponseSchema.parse(
      (
        await saveSettings({
          sessionId: prepared.session.id,
          version: prepared.session.version,
          idempotencyKey: "phase6-settings-doc",
          body: settingsBody(prepared.fileId, { pageRanges: null, copies: 1 })
        })
      ).json()
    );
    const quote = createQuoteResponseSchema.parse(
      (
        await createQuote({
          sessionId: prepared.session.id,
          settingsRevision: saved.settings.revision,
          idempotencyKey: "phase6-quote-doc"
        })
      ).json()
    ).quote;

    const deletion = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${prepared.session.id}/files/${prepared.fileId}`,
      headers: { authorization, "idempotency-key": "phase6-delete-doc" }
    });
    expect([202, 204]).toContain(deletion.statusCode);
    await waitForFileStatus(prepared.fileId, "DELETED");

    const session = await database.printSession.findUniqueOrThrow({
      where: { id: prepared.session.id }
    });
    expect(session).toMatchObject({
      state: "WAITING_FOR_UPLOAD",
      currentSettingsRevision: null,
      activeQuoteId: null
    });
    expect(
      (await database.priceQuote.findUniqueOrThrow({ where: { id: quote.id } })).invalidationReason
    ).toBe("DOCUMENTS_CHANGED");

    // Without a validated document the session is back to waiting for one, and
    // a session in that state has nothing to configure.
    const refused = await saveSettings({
      sessionId: prepared.session.id,
      version: session.stateVersion,
      idempotencyKey: "phase6-settings-after-delete",
      body: settingsBody(prepared.fileId, { pageRanges: null, copies: 1 })
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { code: "INVALID_SESSION_STATE", details: { currentState: "WAITING_FOR_UPLOAD" } }
    });
  }, 180_000);

  it("refuses stale versions, unsupported settings, and browser-supplied money", async () => {
    const prepared = await prepareConfigurableSession("phase6-refusals");
    const body = settingsBody(prepared.fileId, { pageRanges: null, copies: 1 });

    const stale = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version + 5,
      idempotencyKey: "phase6-settings-stale",
      body
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ error: { code: "STALE_SESSION_VERSION" } });

    const missingVersion = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${prepared.session.id}/settings`,
      headers: { authorization, "idempotency-key": "phase6-settings-no-version" },
      payload: body
    });
    expect(missingVersion.statusCode).toBe(428);

    const tooManyCopies = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-settings-copies",
      body: withCopies(body, environment.MAX_COPIES + 1)
    });
    expect(tooManyCopies.statusCode).toBe(422);
    expect(tooManyCopies.json()).toMatchObject({ error: { code: "COPIES_OUT_OF_RANGE" } });

    const impossibleRange = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-settings-range",
      body: settingsBody(prepared.fileId, { pageRanges: "1-99" })
    });
    expect(impossibleRange.statusCode).toBe(422);
    expect(impossibleRange.json()).toMatchObject({
      error: { code: "PAGE_RANGE_OUT_OF_BOUNDS" }
    });

    const colourRequest = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-settings-colour",
      body: { ...body, colorMode: "COLOR" }
    });
    expect(colourRequest.statusCode).toBe(400);

    const saved = updatePrintSettingsResponseSchema.parse(
      (
        await saveSettings({
          sessionId: prepared.session.id,
          version: prepared.session.version,
          idempotencyKey: "phase6-settings-ok",
          body
        })
      ).json()
    );

    // A browser cannot name its own total: the field does not exist, and the
    // stored quote still comes from the published tariff.
    const manipulated = await app.inject({
      method: "POST",
      url: `/v1/sessions/${prepared.session.id}/quotes`,
      headers: { authorization, "idempotency-key": "phase6-quote-manipulated" },
      payload: { settingsRevision: saved.settings.revision, totalMinor: 1, currency: "AMD" }
    });
    expect(manipulated.statusCode).toBe(400);
    expect(manipulated.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const quote = createQuoteResponseSchema.parse(
      (
        await createQuote({
          sessionId: prepared.session.id,
          settingsRevision: saved.settings.revision,
          idempotencyKey: "phase6-quote-honest"
        })
      ).json()
    ).quote;
    expect(quote.totalMinor).toBeGreaterThan(1);
  }, 180_000);

  it("hides another kiosk's settings, capabilities and quotes", async () => {
    const prepared = await prepareConfigurableSession("phase6-isolation");
    const saved = updatePrintSettingsResponseSchema.parse(
      (
        await saveSettings({
          sessionId: prepared.session.id,
          version: prepared.session.version,
          idempotencyKey: "phase6-settings-isolation",
          body: settingsBody(prepared.fileId, { pageRanges: null, copies: 1 })
        })
      ).json()
    );
    const quote = createQuoteResponseSchema.parse(
      (
        await createQuote({
          sessionId: prepared.session.id,
          settingsRevision: saved.settings.revision,
          idempotencyKey: "phase6-quote-isolation"
        })
      ).json()
    ).quote;

    const foreignAttempts = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/sessions/${prepared.session.id}/settings`,
        headers: { authorization: foreignAuthorization }
      }),
      app.inject({
        method: "GET",
        url: `/v1/sessions/${prepared.session.id}/print-capabilities`,
        headers: { authorization: foreignAuthorization }
      }),
      app.inject({
        method: "GET",
        url: `/v1/sessions/${prepared.session.id}/quotes/${quote.id}`,
        headers: { authorization: foreignAuthorization }
      }),
      app.inject({
        method: "PUT",
        url: `/v1/sessions/${prepared.session.id}/settings`,
        headers: {
          authorization: foreignAuthorization,
          "idempotency-key": "phase6-settings-foreign",
          "if-match": '"1"'
        },
        payload: settingsBody(prepared.fileId, { pageRanges: null, copies: 1 })
      })
    ]);

    for (const attempt of foreignAttempts) {
      expect(attempt.statusCode).toBe(404);
      expect(attempt.body).not.toContain(String(quote.totalMinor));
    }
  }, 180_000);

  it("stops honouring a quote once its deadline passes", async () => {
    const prepared = await prepareConfigurableSession("phase6-expiry");
    const saved = updatePrintSettingsResponseSchema.parse(
      (
        await saveSettings({
          sessionId: prepared.session.id,
          version: prepared.session.version,
          idempotencyKey: "phase6-settings-expiry",
          body: settingsBody(prepared.fileId, { pageRanges: null, copies: 1 })
        })
      ).json()
    );
    const quote = createQuoteResponseSchema.parse(
      (
        await createQuote({
          sessionId: prepared.session.id,
          settingsRevision: saved.settings.revision,
          idempotencyKey: "phase6-quote-expiry"
        })
      ).json()
    ).quote;
    expect(new Date(quote.expiresAt).getTime()).toBeLessThanOrEqual(
      new Date(quote.createdAt).getTime() + environment.QUOTE_TTL_SECONDS * 1_000
    );

    await database.priceQuote.update({
      where: { id: quote.id },
      data: { expiresAt: new Date(Date.now() - 1_000) }
    });

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/sessions/${prepared.session.id}/quotes/${quote.id}`,
      headers: { authorization }
    });
    expect(getQuoteResponseSchema.parse(fetched.json()).quote.status).toBe("EXPIRED");

    await janitor.runOnce();
    const settled = await database.priceQuote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(settled.status).toBe("EXPIRED");
    expect(settled.invalidationReason).toBeNull();
    expect(
      (await database.printSession.findUniqueOrThrow({ where: { id: prepared.session.id } }))
        .activeQuoteId
    ).toBeNull();

    // A fresh key produces a new live price for the same unchanged settings.
    const replacement = await createQuote({
      sessionId: prepared.session.id,
      settingsRevision: saved.settings.revision,
      idempotencyKey: "phase6-quote-expiry-2"
    });
    expect(replacement.statusCode).toBe(201);
    const replacementQuote = createQuoteResponseSchema.parse(replacement.json()).quote;
    expect(replacementQuote.id).not.toBe(quote.id);
    expect(replacementQuote.totalMinor).toBe(quote.totalMinor);
  }, 180_000);

  it("keeps settings revisions and published tariffs immutable in the database", async () => {
    const prepared = await prepareConfigurableSession("phase6-immutability");
    const saved = updatePrintSettingsResponseSchema.parse(
      (
        await saveSettings({
          sessionId: prepared.session.id,
          version: prepared.session.version,
          idempotencyKey: "phase6-settings-immutable",
          body: settingsBody(prepared.fileId, { pageRanges: null, copies: 1 })
        })
      ).json()
    );

    await expect(
      database.printSettingRevision.updateMany({
        where: { sessionId: prepared.session.id, revision: saved.settings.revision },
        data: { copies: 9 }
      })
    ).rejects.toThrow();

    const published = await database.pricingRuleSet.findFirstOrThrow({
      where: { status: "PUBLISHED", scope: "GLOBAL" }
    });
    await expect(
      database.pricingRuleSet.update({
        where: { id: published.id },
        data: { currency: "USD" }
      })
    ).rejects.toThrow();
    await expect(
      database.pricingRule.updateMany({
        where: { ruleSetId: published.id },
        data: { unitAmountMinor: 1 }
      })
    ).rejects.toThrow();

    const unchanged = await database.pricingRuleSet.findUniqueOrThrow({
      where: { id: published.id },
      include: { rules: true }
    });
    expect(unchanged.currency.trim()).toBe(developmentTariff.currency);
    expect(unchanged.rules[0]?.unitAmountMinor).toBe(developmentTariff.unitAmountMinor);
  }, 180_000);

  it("prices several documents as one job, each with its own pages", async () => {
    const prepared = await prepareMultiDocumentSession("phase6-multi-1", [3, 2]);
    const [first, second] = prepared.fileIds;
    if (!first || !second) throw new Error("EXPECTED_TWO_DOCUMENTS");

    // Two of the first document's three pages, and all two of the second's.
    const saveResponse = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-multi-settings-1",
      body: {
        fileOrder: [first, second],
        fileSelections: [
          { fileId: first, pageRanges: "1-2", copies: 1, duplex: "SIMPLEX", orientation: "AUTO" },
          { fileId: second, pageRanges: null, copies: 1, duplex: "SIMPLEX", orientation: "AUTO" }
        ],
        paperSize: "A4",
        scaling: "FIT",
        collate: true
      }
    });
    expect(saveResponse.statusCode, saveResponse.body).toBe(200);
    const saved = updatePrintSettingsResponseSchema.parse(saveResponse.json());

    // The snapshot keeps each document's own selection, in print order.
    expect(saved.settings.files).toMatchObject([
      { fileId: first, position: 0, pageCount: 3, pageRangeText: "1-2", selectedPages: 2 },
      { fileId: second, position: 1, pageCount: 2, pageRangeText: "1-2", selectedPages: 2 }
    ]);
    expect(saved.settings).toMatchObject({
      selectedPages: 4,
      printedSides: 4,
      physicalSheets: 4
    });

    const quote = createQuoteResponseSchema.parse(
      (
        await createQuote({
          sessionId: prepared.session.id,
          settingsRevision: saved.settings.revision,
          idempotencyKey: "phase6-multi-quote-1"
        })
      ).json()
    ).quote;

    // Four printed sides at 50.00 plus 20% tax.
    expect(quote).toMatchObject({
      status: "ACTIVE",
      selectedPages: 4,
      printedSides: 4,
      physicalSheets: 4,
      subtotalMinor: 20_000,
      taxMinor: 4_000,
      totalMinor: 24_000
    });
  }, 180_000);

  it("refuses a job that leaves one of its documents out", async () => {
    const prepared = await prepareMultiDocumentSession("phase6-multi-2", [2, 2]);
    const [first, second] = prepared.fileIds;
    if (!first || !second) throw new Error("EXPECTED_TWO_DOCUMENTS");

    // Naming only one of two validated documents would print a job the
    // customer never configured, so the control plane refuses it outright
    // rather than quietly printing whichever it was told about.
    const partial = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-multi-settings-2",
      body: {
        fileOrder: [first],
        fileSelections: [
          { fileId: first, pageRanges: null, copies: 1, duplex: "SIMPLEX", orientation: "AUTO" }
        ],
        paperSize: "A4",
        scaling: "FIT",
        collate: true
      }
    });
    expect(partial.statusCode).toBe(422);
    expect(partial.json()).toMatchObject({ error: { code: "FILE_ORDER_INVALID" } });
  }, 180_000);

  it("prints and prices each document as its own settings ask", async () => {
    const prepared = await prepareMultiDocumentSession("phase6-mixed-1", [3, 2]);
    const [first, second] = prepared.fileIds;
    if (!first || !second) throw new Error("EXPECTED_TWO_DOCUMENTS");

    // Two double-sided copies of a three-page document, and one single-sided
    // landscape copy of a two-page document.
    const saveResponse = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-mixed-settings-1",
      body: {
        fileOrder: [first, second],
        fileSelections: [
          { fileId: first, pageRanges: null, copies: 2, duplex: "LONG_EDGE", orientation: "AUTO" },
          {
            fileId: second,
            pageRanges: null,
            copies: 1,
            duplex: "SIMPLEX",
            orientation: "LANDSCAPE"
          }
        ],
        paperSize: "A4",
        scaling: "FIT",
        collate: true
      }
    });
    expect(saveResponse.statusCode, saveResponse.body).toBe(200);
    const saved = updatePrintSettingsResponseSchema.parse(saveResponse.json());

    expect(saved.settings.files).toMatchObject([
      {
        fileId: first,
        copies: 2,
        duplex: "LONG_EDGE",
        orientation: "AUTO",
        selectedPages: 3,
        // Three pages duplex is two sheets a copy, so six sides on four sheets.
        printedSides: 6,
        physicalSheets: 4
      },
      {
        fileId: second,
        copies: 1,
        duplex: "SIMPLEX",
        orientation: "LANDSCAPE",
        selectedPages: 2,
        printedSides: 2,
        physicalSheets: 2
      }
    ]);
    // The job totals are the sum of what each document produces.
    expect(saved.settings).toMatchObject({
      selectedPages: 5,
      printedSides: 8,
      physicalSheets: 6
    });

    const quote = createQuoteResponseSchema.parse(
      (
        await createQuote({
          sessionId: prepared.session.id,
          settingsRevision: saved.settings.revision,
          idempotencyKey: "phase6-mixed-quote-1"
        })
      ).json()
    ).quote;

    // Eight printed sides at 50.00 plus 20% tax. The development tariff has no
    // duplex adjustment, so a mixed job is charged per side either way.
    expect(quote).toMatchObject({
      status: "ACTIVE",
      selectedPages: 5,
      printedSides: 8,
      physicalSheets: 6,
      subtotalMinor: 40_000,
      taxMinor: 8_000,
      totalMinor: 48_000
    });
    expect(quote.breakdown.duplexAdjustmentMinor).toBe(0);
  }, 180_000);

  it("counts duplex sheets per document rather than across the job", async () => {
    const prepared = await prepareMultiDocumentSession("phase6-multi-3", [3, 3]);
    const [first, second] = prepared.fileIds;
    if (!first || !second) throw new Error("EXPECTED_TWO_DOCUMENTS");

    const saveResponse = await saveSettings({
      sessionId: prepared.session.id,
      version: prepared.session.version,
      idempotencyKey: "phase6-multi-settings-3",
      body: {
        fileOrder: [first, second],
        fileSelections: [
          {
            fileId: first,
            pageRanges: null,
            copies: 1,
            duplex: "LONG_EDGE",
            orientation: "AUTO"
          },
          {
            fileId: second,
            pageRanges: null,
            copies: 1,
            duplex: "LONG_EDGE",
            orientation: "AUTO"
          }
        ],
        paperSize: "A4",
        scaling: "FIT",
        collate: true
      }
    });
    expect(saveResponse.statusCode, saveResponse.body).toBe(200);
    const saved = updatePrintSettingsResponseSchema.parse(saveResponse.json());

    // Two three-page documents duplex: two sheets each, never three for the
    // six sides together. A sheet is never shared between two documents.
    expect(saved.settings).toMatchObject({
      selectedPages: 6,
      printedSides: 6,
      physicalSheets: 4
    });
  }, 180_000);
});

interface PreparedSession {
  session: { id: string; version: number; state: string };
  fileId: string;
}

interface PreparedMultiDocumentSession {
  session: { id: string; version: number; state: string };
  fileIds: string[];
}

/**
 * Drive the same path until two documents are validated in one session, which
 * is what a customer who sends more than one file from their phone produces.
 */
async function prepareMultiDocumentSession(
  idempotencyKey: string,
  pageCounts: readonly number[]
): Promise<PreparedMultiDocumentSession> {
  const createdResponse = await app.inject({
    method: "POST",
    url: `/v1/kiosks/${kioskId}/sessions`,
    headers: { authorization, "idempotency-key": idempotencyKey },
    payload: { locale: "hy" }
  });
  expect(createdResponse.statusCode, createdResponse.body).toBe(201);
  const created = createSessionResponseSchema.parse(createdResponse.json());
  const mobile = await exchangeMobile(
    created.session.publicId,
    requireUploadToken(created.upload.qrUrl)
  );

  const fileIds: string[] = [];
  for (const [index, pageCount] of pageCounts.entries()) {
    const uploadResponse = await uploadDocument({
      sessionId: created.session.id,
      cookieHeader: mobile.cookieHeader,
      csrfToken: mobile.csrfToken,
      clientFileId: `01900000-0000-7000-8000-00000000062${index}`,
      idempotencyKey: `${idempotencyKey}-upload-${index}`,
      contents: createMultiPagePdf(pageCount)
    });
    expect(uploadResponse.statusCode, uploadResponse.body).toBe(202);
    const uploaded = uploadFileResponseSchema.parse(uploadResponse.json());
    await coordinator.dispatchOnce();
    await waitForFileStatus(uploaded.file.id, "READY");
    fileIds.push(uploaded.file.id);
  }

  const session = await database.printSession.findUniqueOrThrow({
    where: { id: created.session.id }
  });

  return {
    session: { id: session.id, version: session.stateVersion, state: session.state },
    fileIds
  };
}

/**
 * Drive the real Phase 3–5 path until one three-page document is validated,
 * which is the only state in which Phase 6 settings exist at all.
 */
async function prepareConfigurableSession(idempotencyKey: string): Promise<PreparedSession> {
  const createdResponse = await app.inject({
    method: "POST",
    url: `/v1/kiosks/${kioskId}/sessions`,
    headers: { authorization, "idempotency-key": idempotencyKey },
    payload: { locale: "hy" }
  });
  expect(createdResponse.statusCode, createdResponse.body).toBe(201);
  const created = createSessionResponseSchema.parse(createdResponse.json());
  const mobile = await exchangeMobile(
    created.session.publicId,
    requireUploadToken(created.upload.qrUrl)
  );

  const uploadResponse = await uploadDocument({
    sessionId: created.session.id,
    cookieHeader: mobile.cookieHeader,
    csrfToken: mobile.csrfToken,
    clientFileId: "01900000-0000-7000-8000-000000000612",
    idempotencyKey: `${idempotencyKey}-upload`,
    contents: createMultiPagePdf(3)
  });
  expect(uploadResponse.statusCode, uploadResponse.body).toBe(202);
  const uploaded = uploadFileResponseSchema.parse(uploadResponse.json());

  await coordinator.dispatchOnce();
  await waitForFileStatus(uploaded.file.id, "READY");
  const session = await database.printSession.findUniqueOrThrow({
    where: { id: created.session.id }
  });

  return {
    session: { id: session.id, version: session.stateVersion, state: session.state },
    fileId: uploaded.file.id
  };
}

/** The same body with the first document asking for a different copy count. */
function withCopies(body: ReturnType<typeof settingsBody>, copies: number) {
  return {
    ...body,
    fileSelections: body.fileSelections.map((selection, index) =>
      index === 0 ? { ...selection, copies } : selection
    )
  };
}

function settingsBody(
  fileId: string,
  overrides: {
    pageRanges?: string | null;
    copies?: number;
    duplex?: "SIMPLEX" | "LONG_EDGE" | "SHORT_EDGE";
  } = {}
) {
  return {
    fileOrder: [fileId],
    fileSelections: [
      {
        fileId,
        pageRanges: overrides.pageRanges ?? null,
        copies: overrides.copies ?? 1,
        duplex: overrides.duplex ?? "SIMPLEX",
        orientation: "AUTO"
      }
    ],
    paperSize: "A4",
    scaling: "FIT",
    collate: true
  };
}

function saveSettings(input: {
  sessionId: string;
  version: number;
  idempotencyKey: string;
  body: unknown;
}) {
  return app.inject({
    method: "PUT",
    url: `/v1/sessions/${input.sessionId}/settings`,
    headers: {
      authorization,
      "idempotency-key": input.idempotencyKey,
      "if-match": `"${input.version}"`
    },
    payload: input.body as Record<string, unknown>
  });
}

function createQuote(input: {
  sessionId: string;
  settingsRevision: number;
  idempotencyKey: string;
}) {
  return app.inject({
    method: "POST",
    url: `/v1/sessions/${input.sessionId}/quotes`,
    headers: { authorization, "idempotency-key": input.idempotencyKey },
    payload: { settingsRevision: input.settingsRevision }
  });
}

async function waitForFileStatus(fileId: string, status: string) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const file = await database.uploadedFile.findUnique({ where: { id: fileId } });
    if (file?.status === status) return file;
    if (file && status === "READY" && ["REJECTED", "DELETED"].includes(file.status)) {
      throw new Error(
        `PHASE6_PROCESSING_TERMINATED:${file.status}:${file.rejectionCode ?? "NONE"}`
      );
    }
    if (status === "DELETED") await janitor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PHASE6_FILE_STATUS_TIMEOUT:${status}`);
}

async function exchangeMobile(publicSessionId: string, uploadToken: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/mobile-auth/exchange",
    headers: { origin: environment.UPLOAD_ORIGIN },
    payload: {
      publicSessionId,
      uploadToken,
      clientNonce: "01900000-0000-7000-8000-000000000611"
    }
  });
  expect(response.statusCode, response.body).toBe(200);
  const context = mobileContextResponseSchema.parse(response.json());
  const setCookieHeader = response.headers["set-cookie"];
  const setCookie = Array.isArray(setCookieHeader)
    ? (setCookieHeader[0] ?? "")
    : (setCookieHeader ?? "");
  const cookieHeader = setCookie.split(";", 1)[0] ?? "";
  if (!cookieHeader) throw new Error("PHASE6_MOBILE_COOKIE_MISSING");
  return { cookieHeader, csrfToken: context.csrfToken };
}

function uploadDocument(input: {
  sessionId: string;
  cookieHeader: string;
  csrfToken: string;
  clientFileId: string;
  idempotencyKey: string;
  contents: Buffer;
}) {
  const boundary = "phase6-synthetic-document-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="synthetic-phase6.pdf"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`,
      "utf8"
    ),
    input.contents,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
  ]);
  return app.inject({
    method: "POST",
    url: `/v1/sessions/${input.sessionId}/files`,
    headers: {
      origin: environment.UPLOAD_ORIGIN,
      cookie: input.cookieHeader,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "x-csrf-token": input.csrfToken,
      "x-client-file-id": input.clientFileId,
      "x-file-size": String(input.contents.byteLength),
      "idempotency-key": input.idempotencyKey
    },
    payload
  });
}

function createMultiPagePdf(pageCount: number): Buffer {
  const fontObjectNumber = 3 + pageCount * 2;
  const pageObjectNumbers = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  const pageObjects = pageObjectNumbers.flatMap((pageObjectNumber, index) => {
    const stream = `BT /F1 24 Tf 72 720 Td (Synthetic Phase 6 page ${index + 1}) Tj ET\n`;
    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> ` +
        `/Contents ${pageObjectNumber + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`
    ];
  });

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] ` +
      `/Count ${pageCount} >>`,
    ...pageObjects,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

function requireUploadToken(qrUrl: string): string {
  const token = new URLSearchParams(new URL(qrUrl).hash.slice(1)).get("t");
  if (!token) throw new Error("PHASE6_UPLOAD_TOKEN_MISSING");
  return token;
}

async function assertPhase6Infrastructure(): Promise<void> {
  try {
    await database.$queryRaw`SELECT 1`;
    databaseReachable = true;
  } catch (error) {
    throw new Error(
      `PHASE6_DATABASE_NOT_READY: run pnpm infra:up and pnpm db:migrate (${safeMessage(error)})`
    );
  }

  try {
    await Promise.all([apiObjectStore.checkReady(), workerStore.checkReady()]);
  } catch (error) {
    throw new Error(`PHASE6_OBJECT_STORAGE_NOT_READY: run pnpm infra:up (${safeMessage(error)})`);
  }

  let response: Response;
  try {
    response = await fetch(new URL("/health/ready", environment.DOCUMENT_PROCESSOR_URL), {
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new Error(`PHASE6_PROCESSOR_UNREACHABLE: run pnpm infra:up (${safeMessage(error)})`);
  }
  if (!response.ok) {
    throw new Error(`PHASE6_PROCESSOR_NOT_READY: ${response.status}; inspect pnpm infra:logs`);
  }
}

/**
 * The suite asserts exact amounts, so it insists on the development tariff. It
 * creates that tariff when a database has never been seeded, and refuses to
 * silently reprice a deployment that publishes something else.
 */
async function ensureDevelopmentTariff(): Promise<void> {
  const published = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED", scope: "GLOBAL", scopeRef: "" },
    include: { rules: true }
  });

  if (published) {
    if (published.version !== developmentTariff.version) {
      throw new Error(
        `PHASE6_UNEXPECTED_TARIFF:${published.version}: this suite expects the development tariff`
      );
    }
    // The version string alone is not the tariff. A database still holding the
    // amounts of an earlier publication would reprice every expectation below,
    // so the amounts this suite writes out are checked against what is actually
    // published rather than assumed from the name.
    const printRule = published.rules.find(
      (rule) => rule.service === "PRINT" && rule.paperSize === "A4"
    );
    const mismatch =
      !printRule ||
      printRule.unitAmountMinor !== developmentTariff.unitAmountMinor ||
      printRule.serviceFeeMinor !== developmentTariff.serviceFeeMinor ||
      printRule.minimumAmountMinor !== developmentTariff.minimumAmountMinor ||
      printRule.taxBasisPoints !== developmentTariff.taxBasisPoints ||
      published.currency !== developmentTariff.currency ||
      published.currencyExponent !== developmentTariff.currencyExponent;
    if (mismatch) {
      throw new Error(
        `PHASE6_STALE_TARIFF:${published.version}: the published amounts differ from this suite; run pnpm db:seed`
      );
    }
    return;
  }

  await database.$transaction(async (transaction) => {
    // Draft, then rules, then publish: a published rule set takes no rule
    // writes of any kind, so it is published last.
    const ruleSet = await transaction.pricingRuleSet.create({
      data: {
        id: "01900000-0000-7000-8000-000000000103",
        version: developmentTariff.version,
        scope: "GLOBAL",
        scopeRef: "",
        currency: developmentTariff.currency,
        currencyExponent: developmentTariff.currencyExponent,
        status: "DRAFT",
        rounding: "HALF_UP",
        taxMode: "EXCLUSIVE",
        minimumApplication: "BEFORE_TAX",
        validFrom: new Date("2026-01-01T00:00:00.000Z")
      }
    });
    await transaction.pricingRule.create({
      data: {
        id: "01900000-0000-7000-8000-000000000104",
        ruleSetId: ruleSet.id,
        service: "PRINT",
        paperSize: "A4",
        colorMode: "MONOCHROME",
        unitAmountMinor: developmentTariff.unitAmountMinor,
        duplexAdjustmentBasisPoints: 0,
        serviceFeeMinor: developmentTariff.serviceFeeMinor,
        minimumAmountMinor: developmentTariff.minimumAmountMinor,
        taxBasisPoints: developmentTariff.taxBasisPoints,
        priority: 0
      }
    });
    await transaction.pricingRuleSet.update({
      where: { id: ruleSet.id },
      data: { status: "PUBLISHED", publishedAt: new Date("2026-01-01T00:00:00.000Z") }
    });
  });
}

async function upsertKiosk(input: { id: string; publicCode: string; name: string }): Promise<void> {
  await database.kiosk.upsert({
    where: { id: input.id },
    create: {
      ...input,
      status: "ACTIVE",
      timezone: "Asia/Yerevan",
      capabilitiesVersion: 2,
      capabilities: phase6Capabilities
    },
    update: { status: "ACTIVE", capabilitiesVersion: 2, capabilities: phase6Capabilities }
  });
}

const phase6Capabilities = {
  service: "PRINT_ONLY",
  outputMode: "MONOCHROME",
  colorModes: ["MONOCHROME"],
  paperSizes: ["A4"],
  duplex: true,
  duplexModes: ["SIMPLEX", "LONG_EDGE"],
  orientations: ["AUTO", "PORTRAIT", "LANDSCAPE"],
  scalingModes: ["FIT", "ACTUAL_SIZE"],
  maxCopies: 20,
  scanningEnabled: false,
  photocopyEnabled: false
};

async function upsertCredential(input: {
  id: string;
  kioskId: string;
  credentialId: string;
  rawCredential: string;
}): Promise<void> {
  const secretDigest = createHash("sha256").update(input.rawCredential, "utf8").digest("hex");
  const scopes = [
    "sessions:create",
    "sessions:read",
    "sessions:cancel",
    "files:read",
    "files:delete",
    "settings:write",
    "quotes:create",
    "quotes:read"
  ];
  await database.kioskCredential.upsert({
    where: { credentialId: input.credentialId },
    create: {
      id: input.id,
      kioskId: input.kioskId,
      credentialId: input.credentialId,
      secretDigest,
      scopes
    },
    update: {
      kioskId: input.kioskId,
      secretDigest,
      scopes,
      revokedAt: null,
      expiresAt: null
    }
  });
}

async function cleanPhase6Fixtures(): Promise<void> {
  await database.idempotencyRecord.deleteMany({
    where: { actorId: { in: [kioskId, foreignKioskId, kioskCredentialId, foreignCredentialId] } }
  });
  const sessions = await database.printSession.findMany({
    where: { kioskId: { in: [kioskId, foreignKioskId] } },
    select: { id: true }
  });
  const sessionIds = sessions.map((session) => session.id);
  if (sessionIds.length === 0) return;

  const clients = await database.mobileClient.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { id: true }
  });
  const files = await database.uploadedFile.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { quarantineObjectKey: true }
  });
  const derivatives = await database.fileDerivative.findMany({
    where: { file: { sessionId: { in: sessionIds } } },
    select: { objectKey: true }
  });
  const objectKeys = [
    ...files.map((file) => file.quarantineObjectKey),
    ...derivatives.map((item) => item.objectKey)
  ].filter((key): key is string => Boolean(key));
  const objectCleanup = await Promise.allSettled(
    objectKeys.map(async (key) => apiObjectStore.deleteObject({ key }))
  );

  await database.printSession.updateMany({
    where: { id: { in: sessionIds } },
    data: { activeQuoteId: null }
  });
  await database.priceQuote.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.printSettingRevision.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.filePage.deleteMany({ where: { file: { sessionId: { in: sessionIds } } } });
  await database.fileDerivative.deleteMany({ where: { file: { sessionId: { in: sessionIds } } } });
  await database.uploadedFile.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.sessionUploadGrant.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.mobileClient.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.auditEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.idempotencyRecord.deleteMany({
    where: { actorId: { in: clients.map((client) => client.id) } }
  });
  await database.printSession.deleteMany({ where: { id: { in: sessionIds } } });

  if (objectCleanup.some((result) => result.status === "rejected")) {
    throw new Error("PHASE6_FIXTURE_OBJECT_CLEANUP_FAILED");
  }
}

function safeMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string") return code;
  }
  if (error instanceof Error && error.message) return error.message;
  return "unknown error";
}
