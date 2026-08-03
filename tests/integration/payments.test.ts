import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import {
  createPaymentResponseSchema,
  getPaymentResponseSchema
} from "../../packages/contracts/src/payments.js";
import { createQuoteResponseSchema } from "../../packages/contracts/src/quotes.js";
import { createSessionResponseSchema } from "../../packages/contracts/src/sessions.js";
import { updatePrintSettingsResponseSchema } from "../../packages/contracts/src/settings.js";
import {
  mobileContextResponseSchema,
  uploadFileResponseSchema
} from "../../packages/contracts/src/uploads.js";
import { createDatabaseClient } from "../../packages/database/src/index.js";
import {
  MockPaymentProvider,
  type SignedMockWebhook
} from "../../packages/payment-adapters/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import { FileJanitor } from "../../services/api/src/modules/files/janitor.js";
import { createS3ObjectStore } from "../../services/api/src/modules/files/object-store.js";
import { CryptoRandomSource, SystemClock } from "../../services/api/src/modules/sessions/crypto.js";
import {
  DocumentProcessingCoordinator,
  type DocumentProcessingCoordinatorOptions
} from "../../services/worker/src/jobs/process-document.js";
import { PaymentReconciler } from "../../services/worker/src/jobs/reconcile-payments.js";
import { DocumentProcessorClient } from "../../services/worker/src/processing/processor-client.js";
import { S3DocumentStore } from "../../services/worker/src/storage/document-store.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

const kioskId = "kiosk_phase7_integration_001";
const kioskCredentialId = "phase7-integration-kiosk-credential";
const kioskApiKey = "phase7-integration-kiosk-key-000001";
const foreignKioskId = "kiosk_phase7_integration_foreign";
const foreignCredentialId = "phase7-integration-foreign-credential";
const foreignApiKey = "phase7-integration-foreign-key-000001";
const webhookSecret = "phase7-integration-payment-webhook-secret-000001";

/**
 * The published development tariff. A three-page simplex job at 50.00 AMD per
 * printed side with 20% tax is 180.00 AMD, and every expectation below is
 * written out rather than recomputed by the code under test.
 */
const expectedTotalMinor = 18_000;

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({
  ...process.env,
  NODE_ENV: "test",
  DEV_KIOSK_ID: kioskId,
  DEV_KIOSK_API_KEY: kioskApiKey,
  PAYMENT_WEBHOOK_SECRET: webhookSecret,
  PAYMENT_TEST_OUTCOMES_ENABLED: "true",
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
const provider = new MockPaymentProvider({ webhookSecret });
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
  await assertInfrastructure();
  await cleanFixtures();
  await Promise.all([
    upsertKiosk({ id: kioskId, publicCode: "PHASE7-INTEGRATION" }),
    upsertKiosk({ id: foreignKioskId, publicCode: "PHASE7-FOREIGN" })
  ]);
  await Promise.all([
    upsertCredential({
      id: "01900000-0000-7000-8000-000000000701",
      kioskId,
      credentialId: kioskCredentialId,
      rawCredential: kioskApiKey
    }),
    upsertCredential({
      id: "01900000-0000-7000-8000-000000000702",
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
    uploadTimeoutSeconds: environment.UPLOAD_TIMEOUT_SECONDS
  });
  coordinator.start();
}, 180_000);

afterAll(async () => {
  await coordinator?.close();
  await app?.close();
  if (databaseReachable) {
    await cleanFixtures();
    await database.kioskCredential.deleteMany({
      where: { credentialId: { in: [kioskCredentialId, foreignCredentialId] } }
    });
    await database.kiosk.deleteMany({ where: { id: { in: [kioskId, foreignKioskId] } } });
  }
  await database.$disconnect();
}, 180_000);

beforeEach(async () => {
  await cleanFixtures();
}, 180_000);

describe.sequential("Phase 7 simulated payment", () => {
  it("captures a quote exactly once and moves the session to PAID", async () => {
    const priced = await prepareQuotedSession("phase7-happy-path");
    expect(priced.quote.totalMinor).toBe(expectedTotalMinor);

    const createdResponse = await startPayment({
      sessionId: priced.sessionId,
      quoteId: priced.quote.id,
      idempotencyKey: "phase7-payment-1"
    });
    expect(createdResponse.statusCode, createdResponse.body).toBe(201);
    const created = createPaymentResponseSchema.parse(createdResponse.json());
    expect(created.payment).toMatchObject({
      status: "PENDING",
      amountMinor: expectedTotalMinor,
      currency: "AMD",
      quoteId: priced.quote.id,
      failureCode: null,
      capturedAt: null
    });
    // The manifest is locked the moment a payment opens.
    await expectSessionState(priced.sessionId, "AWAITING_PAYMENT");

    const confirmed = await confirmPayment(created.payment.id, "phase7-confirm-1");
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    // Confirmation is never a capture. Only a verified callback moves money.
    expect(getPaymentResponseSchema.parse(confirmed.json()).payment.status).toBe("PENDING");

    const captured = await deliverOutcome(created.payment.id, "SUCCEEDED");
    expect(captured.statusCode, captured.body).toBe(200);

    const payment = await database.payment.findUniqueOrThrow({
      where: { id: created.payment.id }
    });
    expect(payment.status).toBe("CAPTURED");
    expect(payment.capturedAt).not.toBeNull();
    expect(payment.amountMinor).toBe(expectedTotalMinor);

    const session = await database.printSession.findUniqueOrThrow({
      where: { id: priced.sessionId }
    });
    expect(session.state).toBe("PAID");

    const quote = await database.priceQuote.findUniqueOrThrow({ where: { id: priced.quote.id } });
    expect(quote.status).toBe("CONSUMED");

    // The events the kiosk sees are gapless and carry no provider reference.
    const events = await database.outboxEvent.findMany({
      where: { aggregateId: priced.sessionId },
      orderBy: { sequence: "asc" }
    });
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index + 1));
    expect(events.map((event) => event.type)).toContain("payment.pending");
    expect(events.map((event) => event.type)).toContain("payment.succeeded");
    expect(JSON.stringify(events)).not.toContain("mock_pi_");
  });

  it("replays one payment for a repeated key and refuses the key for another quote", async () => {
    const priced = await prepareQuotedSession("phase7-idempotent");

    const first = await startPayment({
      sessionId: priced.sessionId,
      quoteId: priced.quote.id,
      idempotencyKey: "phase7-payment-repeat"
    });
    const replay = await startPayment({
      sessionId: priced.sessionId,
      quoteId: priced.quote.id,
      idempotencyKey: "phase7-payment-repeat"
    });
    const reused = await startPayment({
      sessionId: priced.sessionId,
      quoteId: "01900000-0000-7000-8000-0000000009ff",
      idempotencyKey: "phase7-payment-repeat"
    });

    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(createPaymentResponseSchema.parse(replay.json()).payment.id).toBe(
      createPaymentResponseSchema.parse(first.json()).payment.id
    );
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });

    const payments = await database.payment.count({ where: { sessionId: priced.sessionId } });
    expect(payments).toBe(1);
  });

  it("treats a duplicate callback as a no-op and refuses a late decline", async () => {
    const priced = await prepareQuotedSession("phase7-duplicate");
    const payment = await openPayment(priced, "phase7-payment-duplicate");

    const signed = provider.signOutcome({
      paymentId: payment.id,
      outcome: "SUCCEEDED",
      amount: { amountMinor: expectedTotalMinor, currency: "AMD", currencyExponent: 2 },
      occurredAt: new Date()
    });
    const first = await deliverWebhook(signed);
    const duplicate = await deliverWebhook(signed);

    expect(first.statusCode, first.body).toBe(200);
    // A repeated delivery is acknowledged rather than acted on a second time.
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(await database.paymentWebhookInbox.count({ where: { paymentId: payment.id } })).toBe(1);

    const declined = await deliverWebhook(
      provider.signOutcome({
        paymentId: payment.id,
        outcome: "DECLINED",
        amount: { amountMinor: expectedTotalMinor, currency: "AMD", currencyExponent: 2 },
        occurredAt: new Date()
      })
    );
    expect(declined.statusCode).toBe(200);

    // Payment state is monotonic: nothing overwrites a capture.
    const stored = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stored.status).toBe("CAPTURED");
    const late = await database.paymentWebhookInbox.findFirst({
      where: { paymentId: payment.id, eventType: "PAYMENT_DECLINED" }
    });
    expect(late?.result).toBe("IGNORED_TERMINAL_PAYMENT");
    await expectSessionState(priced.sessionId, "PAID");
  });

  it("refuses a callback that is not signed by the provider", async () => {
    const priced = await prepareQuotedSession("phase7-bad-signature");
    const payment = await openPayment(priced, "phase7-payment-signature");
    const signed = provider.signOutcome({
      paymentId: payment.id,
      outcome: "SUCCEEDED",
      amount: { amountMinor: expectedTotalMinor, currency: "AMD", currencyExponent: 2 },
      occurredAt: new Date()
    });

    const tampered = await deliverWebhook({
      body: signed.body.replace(String(expectedTotalMinor), "1"),
      headers: signed.headers
    });
    const unsigned = await deliverWebhook({
      body: signed.body,
      headers: { "content-type": "application/json" }
    });

    expect(tampered.statusCode).toBe(401);
    expect(unsigned.statusCode).toBe(401);
    expect(await database.paymentWebhookInbox.count({ where: { paymentId: payment.id } })).toBe(0);
    const stored = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stored.status).toBe("PENDING");
  });

  it("refuses to capture an amount that is not the quoted total, and records what is owed", async () => {
    const priced = await prepareQuotedSession("phase7-amount");
    const payment = await openPayment(priced, "phase7-payment-amount");

    const response = await deliverWebhook(
      provider.signOutcome({
        paymentId: payment.id,
        outcome: "SUCCEEDED",
        amount: { amountMinor: expectedTotalMinor + 100, currency: "AMD", currencyExponent: 2 },
        occurredAt: new Date()
      })
    );

    // The callback is acknowledged — a provider must not retry forever — but
    // nothing is captured on a total the control plane never issued.
    expect(response.statusCode, response.body).toBe(200);
    const stored = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stored.status).toBe("PENDING");
    await expectSessionState(priced.sessionId, "AWAITING_PAYMENT");

    const inbox = await database.paymentWebhookInbox.findFirstOrThrow({
      where: { paymentId: payment.id }
    });
    expect(inbox.result).toBe("AMOUNT_MISMATCH");
    const compensation = await database.refund.findFirstOrThrow({
      where: { paymentId: payment.id }
    });
    expect(compensation).toMatchObject({ reason: "AMOUNT_MISMATCH", status: "PENDING" });
  });

  it("releases the session after a decline and lets the same price be paid again", async () => {
    const priced = await prepareQuotedSession("phase7-decline");
    const declinedPayment = await openPayment(priced, "phase7-payment-declined");

    const declined = await deliverOutcome(declinedPayment.id, "DECLINED");
    expect(declined.statusCode, declined.body).toBe(200);

    const settled = await database.payment.findUniqueOrThrow({
      where: { id: declinedPayment.id }
    });
    expect(settled.status).toBe("DECLINED");
    expect(settled.failureCode).toBe("CARD_DECLINED");
    // The manifest lock is released and the price stays live, so a second
    // attempt costs exactly the same.
    await expectSessionState(priced.sessionId, "CONFIGURING");
    const quote = await database.priceQuote.findUniqueOrThrow({ where: { id: priced.quote.id } });
    expect(quote.status).toBe("ACTIVE");

    const retried = await startPayment({
      sessionId: priced.sessionId,
      quoteId: priced.quote.id,
      idempotencyKey: "phase7-payment-retry"
    });
    expect(retried.statusCode, retried.body).toBe(201);
    const retriedPayment = createPaymentResponseSchema.parse(retried.json()).payment;
    expect(retriedPayment.amountMinor).toBe(expectedTotalMinor);

    await deliverOutcome(retriedPayment.id, "SUCCEEDED");
    await expectSessionState(priced.sessionId, "PAID");
    expect(
      await database.payment.count({ where: { sessionId: priced.sessionId, status: "CAPTURED" } })
    ).toBe(1);
  });

  it("locks settings and pricing while a payment is in progress", async () => {
    const priced = await prepareQuotedSession("phase7-lock");
    await openPayment(priced, "phase7-payment-lock");

    const settings = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${priced.sessionId}/settings`,
      headers: {
        authorization,
        "idempotency-key": "phase7-locked-settings",
        "if-match": `"${priced.sessionVersion + 1}"`
      },
      payload: settingsBody(priced.fileId, { copies: 3 })
    });
    const quote = await app.inject({
      method: "POST",
      url: `/v1/sessions/${priced.sessionId}/quotes`,
      headers: { authorization, "idempotency-key": "phase7-locked-quote" },
      payload: { settingsRevision: priced.settingsRevision }
    });

    expect(settings.statusCode).toBe(423);
    expect(settings.json()).toMatchObject({ error: { code: "SETTINGS_LOCKED" } });
    expect(quote.statusCode).toBe(423);
    expect(quote.json()).toMatchObject({ error: { code: "QUOTE_LOCKED" } });
  });

  it("cancels an in-flight payment with its session and refuses to cancel a paid one", async () => {
    const priced = await prepareQuotedSession("phase7-cancel");
    const payment = await openPayment(priced, "phase7-payment-cancel");
    const locked = await database.printSession.findUniqueOrThrow({
      where: { id: priced.sessionId }
    });

    const canceled = await app.inject({
      method: "POST",
      url: `/v1/sessions/${priced.sessionId}/cancel`,
      headers: {
        authorization,
        "idempotency-key": "phase7-cancel-1",
        "if-match": `"${locked.stateVersion}"`
      }
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    const closed = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(closed.status).toBe("CANCELED");
    expect(closed.failureCode).toBe("SESSION_TERMINAL");

    // Money that arrives after that cancellation is not lost or ignored: the
    // capture is recorded and so is the obligation to give it back.
    const late = await deliverOutcome(payment.id, "SUCCEEDED");
    expect(late.statusCode).toBe(200);
    const lateCapture = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(lateCapture.status).toBe("CAPTURED");
    const compensation = await database.refund.findFirstOrThrow({
      where: { paymentId: payment.id }
    });
    expect(compensation.reason).toBe("LATE_CAPTURE");
    await expectSessionState(priced.sessionId, "CANCELED");
  });

  it("refuses to cancel a session whose payment already captured", async () => {
    const priced = await prepareQuotedSession("phase7-paid-cancel");
    const payment = await openPayment(priced, "phase7-payment-paid");
    await deliverOutcome(payment.id, "SUCCEEDED");
    const paid = await database.printSession.findUniqueOrThrow({ where: { id: priced.sessionId } });

    const canceled = await app.inject({
      method: "POST",
      url: `/v1/sessions/${priced.sessionId}/cancel`,
      headers: {
        authorization,
        "idempotency-key": "phase7-cancel-paid",
        "if-match": `"${paid.stateVersion}"`
      }
    });

    expect(canceled.statusCode).toBe(409);
    expect(canceled.json()).toMatchObject({ error: { code: "PAYMENT_ALREADY_CAPTURED" } });
    await expectSessionState(priced.sessionId, "PAID");
  });

  it("times out an abandoned payment and returns the session to configuring", async () => {
    const priced = await prepareQuotedSession("phase7-timeout");
    const payment = await openPayment(priced, "phase7-payment-timeout");

    // The customer walked away. The window closes on the database clock, not
    // on anything the browser says.
    // The window is moved wholesale into the past: a payment can never be
    // stored with a deadline before its own creation.
    await database.payment.update({
      where: { id: payment.id },
      data: {
        createdAt: new Date(Date.now() - 600_000),
        expiresAt: new Date(Date.now() - 1_000)
      }
    });
    const reconciler = new PaymentReconciler({
      database: serviceDatabase as never,
      provider,
      logger: silentLogger
    });
    const settled = await reconciler.runOnce();
    await reconciler.close();

    expect(settled).toBe(1);
    const stored = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stored.status).toBe("TIMED_OUT");
    expect(stored.failureCode).toBe("PROVIDER_TIMEOUT");
    await expectSessionState(priced.sessionId, "CONFIGURING");

    const failure = await database.outboxEvent.findFirst({
      where: { aggregateId: priced.sessionId, type: "payment.failed" }
    });
    expect(failure).not.toBeNull();
  });

  it("keeps one session's payment invisible to another kiosk", async () => {
    const priced = await prepareQuotedSession("phase7-isolation");
    const payment = await openPayment(priced, "phase7-payment-isolation");

    const foreignRead = await app.inject({
      method: "GET",
      url: `/v1/payments/${payment.id}`,
      headers: { authorization: foreignAuthorization }
    });
    const foreignStart = await app.inject({
      method: "POST",
      url: `/v1/sessions/${priced.sessionId}/payments`,
      headers: { authorization: foreignAuthorization, "idempotency-key": "phase7-foreign" },
      payload: { quoteId: priced.quote.id }
    });
    const foreignOutcome = await app.inject({
      method: "POST",
      url: `/v1/test/payments/${payment.id}/outcomes`,
      headers: { authorization: foreignAuthorization },
      payload: { outcome: "SUCCEEDED" }
    });

    // A foreign kiosk is told the resource does not exist rather than that it
    // exists and belongs to somebody else.
    expect(foreignRead.statusCode).toBe(404);
    expect(foreignStart.statusCode).toBe(404);
    expect(foreignOutcome.statusCode).toBe(404);
    const stored = await database.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stored.status).toBe("PENDING");
  });

  it("refuses a payment request that carries its own amount", async () => {
    const priced = await prepareQuotedSession("phase7-amount-proposal");

    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${priced.sessionId}/payments`,
      headers: { authorization, "idempotency-key": "phase7-proposed-amount" },
      payload: { quoteId: priced.quote.id, amountMinor: 1 }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(await database.payment.count({ where: { sessionId: priced.sessionId } })).toBe(0);
    await expectSessionState(priced.sessionId, "CONFIGURING");
  });

  it("refuses a payment for a price that is no longer the session's own", async () => {
    const priced = await prepareQuotedSession("phase7-stale-quote");

    // Saving settings again retires the price that was quoted.
    const resaved = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${priced.sessionId}/settings`,
      headers: {
        authorization,
        "idempotency-key": "phase7-stale-settings",
        "if-match": `"${priced.sessionVersion + 1}"`
      },
      payload: settingsBody(priced.fileId, { copies: 2 })
    });
    expect(resaved.statusCode, resaved.body).toBe(200);

    const response = await startPayment({
      sessionId: priced.sessionId,
      quoteId: priced.quote.id,
      idempotencyKey: "phase7-stale-payment"
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "QUOTE_STALE" } });
    expect(await database.payment.count({ where: { sessionId: priced.sessionId } })).toBe(0);
  });

  it("refuses a payment window too short to be worth opening", async () => {
    const priced = await prepareQuotedSession("phase7-short-window");
    await database.priceQuote.update({
      where: { id: priced.quote.id },
      data: { expiresAt: new Date(Date.now() + 5_000) }
    });

    const response = await startPayment({
      sessionId: priced.sessionId,
      quoteId: priced.quote.id,
      idempotencyKey: "phase7-short-window-payment"
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "QUOTE_EXPIRED" } });
  });

  it("reports an unavailable provider as a service fault and starts nothing", async () => {
    const priced = await prepareQuotedSession("phase7-unavailable");
    const unavailableApp = await buildApp({
      environment,
      database: serviceDatabase,
      objectStore: apiObjectStore,
      paymentProvider: new MockPaymentProvider({ webhookSecret, unavailable: true }),
      maxMobileExchangesPerMinute: 1_000,
      maxSessionsPerMinute: 1_000
    });

    try {
      const response = await unavailableApp.inject({
        method: "POST",
        url: `/v1/sessions/${priced.sessionId}/payments`,
        headers: { authorization, "idempotency-key": "phase7-unavailable-payment" },
        payload: { quoteId: priced.quote.id }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "PAYMENT_UNAVAILABLE" } });
      // No provider detail crosses the boundary, and no half-open payment is
      // left behind.
      expect(response.body).not.toContain("PROVIDER_UNAVAILABLE");
      expect(await database.payment.count({ where: { sessionId: priced.sessionId } })).toBe(0);
      await expectSessionState(priced.sessionId, "CONFIGURING");
    } finally {
      await unavailableApp.close();
    }
  });

  it("drives duplicate deliveries through the outcome control without capturing twice", async () => {
    const priced = await prepareQuotedSession("phase7-outcome-route");
    const payment = await openPayment(priced, "phase7-payment-outcome");

    const response = await app.inject({
      method: "POST",
      url: `/v1/test/payments/${payment.id}/outcomes`,
      headers: { authorization },
      payload: { outcome: "SUCCEEDED", deliveries: 3 }
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ delivered: 3, payment: { status: "CAPTURED" } });
    expect(await database.paymentWebhookInbox.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(
      await database.payment.count({ where: { sessionId: priced.sessionId, status: "CAPTURED" } })
    ).toBe(1);
  });
});

interface QuotedSession {
  sessionId: string;
  sessionVersion: number;
  fileId: string;
  settingsRevision: number;
  quote: { id: string; totalMinor: number };
}

/**
 * Drives the real Phase 3–6 path: a session, a phone upload, the document
 * worker validating it, saved settings, and a server-issued price.
 */
async function prepareQuotedSession(idempotencyKey: string): Promise<QuotedSession> {
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
    clientFileId: "01900000-0000-7000-8000-000000000712",
    idempotencyKey: `${idempotencyKey}-upload`,
    contents: createMultiPagePdf(3)
  });
  expect(uploadResponse.statusCode, uploadResponse.body).toBe(202);
  const uploaded = uploadFileResponseSchema.parse(uploadResponse.json());

  await coordinator.dispatchOnce();
  await waitForFileStatus(uploaded.file.id, "READY");
  const validated = await database.printSession.findUniqueOrThrow({
    where: { id: created.session.id }
  });

  const savedResponse = await app.inject({
    method: "PUT",
    url: `/v1/sessions/${created.session.id}/settings`,
    headers: {
      authorization,
      "idempotency-key": `${idempotencyKey}-settings`,
      "if-match": `"${validated.stateVersion}"`
    },
    payload: settingsBody(uploaded.file.id)
  });
  expect(savedResponse.statusCode, savedResponse.body).toBe(200);
  const saved = updatePrintSettingsResponseSchema.parse(savedResponse.json());

  const quoteResponse = await app.inject({
    method: "POST",
    url: `/v1/sessions/${created.session.id}/quotes`,
    headers: { authorization, "idempotency-key": `${idempotencyKey}-quote` },
    payload: { settingsRevision: saved.settings.revision }
  });
  expect(quoteResponse.statusCode, quoteResponse.body).toBe(201);
  const quote = createQuoteResponseSchema.parse(quoteResponse.json()).quote;

  return {
    sessionId: created.session.id,
    sessionVersion: validated.stateVersion,
    fileId: uploaded.file.id,
    settingsRevision: saved.settings.revision,
    quote: { id: quote.id, totalMinor: quote.totalMinor }
  };
}

async function openPayment(priced: QuotedSession, idempotencyKey: string) {
  const response = await startPayment({
    sessionId: priced.sessionId,
    quoteId: priced.quote.id,
    idempotencyKey
  });
  expect(response.statusCode, response.body).toBe(201);
  return createPaymentResponseSchema.parse(response.json()).payment;
}

function startPayment(input: { sessionId: string; quoteId: string; idempotencyKey: string }) {
  return app.inject({
    method: "POST",
    url: `/v1/sessions/${input.sessionId}/payments`,
    headers: { authorization, "idempotency-key": input.idempotencyKey },
    payload: { quoteId: input.quoteId }
  });
}

function confirmPayment(paymentId: string, idempotencyKey: string) {
  return app.inject({
    method: "POST",
    url: `/v1/payments/${paymentId}/confirm`,
    headers: { authorization, "idempotency-key": idempotencyKey }
  });
}

function deliverWebhook(signed: SignedMockWebhook) {
  return app.inject({
    method: "POST",
    url: "/v1/webhooks/payments/mock",
    headers: signed.headers,
    payload: signed.body
  });
}

function deliverOutcome(paymentId: string, outcome: "SUCCEEDED" | "DECLINED") {
  return deliverWebhook(
    provider.signOutcome({
      paymentId,
      outcome,
      amount: { amountMinor: expectedTotalMinor, currency: "AMD", currencyExponent: 2 },
      occurredAt: new Date()
    })
  );
}

async function expectSessionState(sessionId: string, state: string): Promise<void> {
  const session = await database.printSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(session.state).toBe(state);
}

function settingsBody(fileId: string, overrides: { copies?: number } = {}) {
  return {
    fileOrder: [fileId],
    fileSelections: [{ fileId, pageRanges: null }],
    copies: overrides.copies ?? 1,
    duplex: "SIMPLEX",
    paperSize: "A4",
    orientation: "AUTO",
    scaling: "FIT",
    collate: true
  };
}

async function waitForFileStatus(fileId: string, status: string) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const file = await database.uploadedFile.findUnique({ where: { id: fileId } });
    if (file?.status === status) return file;
    if (file && status === "READY" && ["REJECTED", "DELETED"].includes(file.status)) {
      throw new Error(
        `PHASE7_PROCESSING_TERMINATED:${file.status}:${file.rejectionCode ?? "NONE"}`
      );
    }
    if (status === "DELETED") await janitor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PHASE7_FILE_STATUS_TIMEOUT:${status}`);
}

async function exchangeMobile(publicSessionId: string, uploadToken: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/mobile-auth/exchange",
    headers: { origin: environment.UPLOAD_ORIGIN },
    payload: {
      publicSessionId,
      uploadToken,
      clientNonce: "01900000-0000-7000-8000-000000000711"
    }
  });
  expect(response.statusCode, response.body).toBe(200);
  const context = mobileContextResponseSchema.parse(response.json());
  const setCookieHeader = response.headers["set-cookie"];
  const setCookie = Array.isArray(setCookieHeader)
    ? (setCookieHeader[0] ?? "")
    : (setCookieHeader ?? "");
  const cookieHeader = setCookie.split(";", 1)[0] ?? "";
  if (!cookieHeader) throw new Error("PHASE7_MOBILE_COOKIE_MISSING");
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
  const boundary = "phase7-synthetic-document-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="synthetic-phase7.pdf"\r\n` +
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
    const stream = `BT /F1 24 Tf 72 720 Td (Synthetic Phase 7 page ${index + 1}) Tj ET\n`;
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
  if (!token) throw new Error("PHASE7_UPLOAD_TOKEN_MISSING");
  return token;
}

async function assertInfrastructure(): Promise<void> {
  try {
    await database.$queryRaw`SELECT 1`;
    databaseReachable = true;
  } catch (error) {
    throw new Error(
      `PHASE7_DATABASE_NOT_READY: run pnpm infra:up and pnpm db:migrate (${safeMessage(error)})`
    );
  }

  const published = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED", scope: "GLOBAL", scopeRef: "" },
    include: { rules: true }
  });
  const printRule = published?.rules.find(
    (rule) => rule.service === "PRINT" && rule.paperSize === "A4"
  );
  // This suite asserts an exact captured amount, so it insists on the seeded
  // development tariff rather than repricing itself from whatever is published.
  if (
    !published ||
    !printRule ||
    published.currency !== "AMD" ||
    published.currencyExponent !== 2 ||
    printRule.unitAmountMinor !== 5_000 ||
    printRule.serviceFeeMinor !== 0 ||
    printRule.minimumAmountMinor !== 0 ||
    printRule.taxBasisPoints !== 2_000
  ) {
    throw new Error("PHASE7_UNEXPECTED_TARIFF: run pnpm db:seed");
  }

  try {
    await Promise.all([apiObjectStore.checkReady(), workerStore.checkReady()]);
  } catch (error) {
    throw new Error(`PHASE7_OBJECT_STORAGE_NOT_READY: run pnpm infra:up (${safeMessage(error)})`);
  }

  let response: Response;
  try {
    response = await fetch(new URL("/health/ready", environment.DOCUMENT_PROCESSOR_URL), {
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new Error(`PHASE7_PROCESSOR_UNREACHABLE: run pnpm infra:up (${safeMessage(error)})`);
  }
  if (!response.ok) {
    throw new Error(`PHASE7_PROCESSOR_NOT_READY: ${response.status}; inspect pnpm infra:logs`);
  }
}

async function upsertKiosk(input: { id: string; publicCode: string }): Promise<void> {
  const capabilities = {
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
  await database.kiosk.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      publicCode: input.publicCode,
      name: "Phase 7 kiosk",
      status: "ACTIVE",
      timezone: "Asia/Yerevan",
      capabilitiesVersion: 2,
      capabilities
    },
    update: { status: "ACTIVE", capabilitiesVersion: 2, capabilities }
  });
}

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
    "quotes:read",
    "payments:create",
    "payments:write",
    "payments:read"
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
    update: { kioskId: input.kioskId, secretDigest, scopes, revokedAt: null, expiresAt: null }
  });
}

async function cleanFixtures(): Promise<void> {
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

  // The payment ledger holds the references that keep a quote alive, so it is
  // cleared first — as a fixture, never as an operation this system performs.
  await database.refund.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.paymentWebhookInbox.deleteMany({
    where: { payment: { sessionId: { in: sessionIds } } }
  });
  // Attempts follow their payment through the foreign key; they are immutable
  // rather than undeletable, so a lineage removed by retention takes its own
  // evidence with it.
  await database.payment.deleteMany({ where: { sessionId: { in: sessionIds } } });
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
    throw new Error("PHASE7_FIXTURE_OBJECT_CLEANUP_FAILED");
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
