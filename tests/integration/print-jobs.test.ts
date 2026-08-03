import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import { createPaymentResponseSchema } from "../../packages/contracts/src/payments.js";
import {
  createPrintJobResponseSchema,
  getPrintJobResponseSchema,
  printJobManifestSchema
} from "../../packages/contracts/src/print-jobs.js";
import { createQuoteResponseSchema } from "../../packages/contracts/src/quotes.js";
import { createSessionResponseSchema } from "../../packages/contracts/src/sessions.js";
import { updatePrintSettingsResponseSchema } from "../../packages/contracts/src/settings.js";
import {
  mobileContextResponseSchema,
  uploadFileResponseSchema
} from "../../packages/contracts/src/uploads.js";
import { createDatabaseClient } from "../../packages/database/src/index.js";
import { MockPaymentProvider } from "../../packages/payment-adapters/src/index.js";
import {
  MockPrinterAdapter,
  type PrinterAdapter,
  type PrintSubmission
} from "../../packages/printer-adapters/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import { createS3ObjectStore } from "../../services/api/src/modules/files/object-store.js";
import { PrintCommandRunner } from "../../services/kiosk-agent/src/print/runner.js";
import {
  DocumentProcessingCoordinator,
  type DocumentProcessingCoordinatorOptions
} from "../../services/worker/src/jobs/process-document.js";
import { PrintDispatcher } from "../../services/worker/src/jobs/dispatch-print.js";
import { DocumentProcessorClient } from "../../services/worker/src/processing/processor-client.js";
import { S3DocumentStore } from "../../services/worker/src/storage/document-store.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

const kioskId = "kiosk_phase8_integration_001";
const kioskCredentialId = "phase8-integration-kiosk-credential";
const kioskApiKey = "phase8-integration-kiosk-key-000001";
const foreignKioskId = "kiosk_phase8_integration_foreign";
const foreignCredentialId = "phase8-integration-foreign-credential";
const foreignApiKey = "phase8-integration-foreign-key-000001";
const webhookSecret = "phase8-integration-payment-webhook-secret-00001";

/** Three simplex sides at 50.00 AMD with 20% tax, exactly as Phase 6 prices it. */
const expectedTotalMinor = 18_000;
const expectedSheets = 3;

let outputDirectory: string;
let spoolDirectory: string;

loadWorkspaceEnvironmentFile();
const baseEnvironment = {
  ...process.env,
  NODE_ENV: "test",
  DEV_KIOSK_ID: kioskId,
  DEV_KIOSK_API_KEY: kioskApiKey,
  PAYMENT_WEBHOOK_SECRET: webhookSecret,
  PAYMENT_TEST_OUTCOMES_ENABLED: "true",
  PRINT_TEST_OUTCOMES_ENABLED: "true",
  DOCUMENT_PROCESSOR_MEMORY_MIB: "3072",
  DOCUMENT_PROCESSOR_SCRATCH_BYTES: "2147483648",
  MALWARE_SCANNER_ADAPTER: "clamav"
};
const environment = loadEnvironment(baseEnvironment);
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
let dispatcher: PrintDispatcher;
let databaseReachable = false;

beforeAll(async () => {
  await assertInfrastructure();
  await cleanFixtures();
  await Promise.all([
    upsertKiosk({ id: kioskId, publicCode: "PHASE8-INTEGRATION" }),
    upsertKiosk({ id: foreignKioskId, publicCode: "PHASE8-FOREIGN" })
  ]);
  await Promise.all([
    upsertCredential({
      id: "01900000-0000-7000-8000-000000000801",
      kioskId,
      credentialId: kioskCredentialId,
      rawCredential: kioskApiKey
    }),
    upsertCredential({
      id: "01900000-0000-7000-8000-000000000802",
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
  dispatcher = new PrintDispatcher({
    database: serviceDatabase,
    redisUrl: environment.REDIS_URL,
    logger: silentLogger,
    leaseMilliseconds: environment.PRINT_COMMAND_LEASE_SECONDS * 1_000,
    maxCommandAttempts: environment.PRINT_COMMAND_MAX_ATTEMPTS,
    maxDispatchAttempts: environment.PRINT_DISPATCH_MAX_ATTEMPTS
  });
  coordinator.start();
}, 180_000);

afterAll(async () => {
  await coordinator?.close();
  await dispatcher?.close();
  await app?.close();
  if (databaseReachable) {
    await cleanFixtures();
    await database.kioskCredential.deleteMany({
      where: { credentialId: { in: [kioskCredentialId, foreignCredentialId] } }
    });
    await database.kiosk.deleteMany({ where: { id: { in: [kioskId, foreignKioskId] } } });
  }
  await database.$disconnect();
  await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
  await rm(spoolDirectory, { recursive: true, force: true }).catch(() => undefined);
}, 180_000);

beforeEach(async () => {
  await cleanFixtures();
  outputDirectory = await mkdtemp(join(tmpdir(), "phase8-printer-out-"));
  spoolDirectory = await mkdtemp(join(tmpdir(), "phase8-printer-spool-"));
}, 180_000);

describe.sequential("Phase 8 virtual printing", () => {
  it("prints a paid session exactly once and completes it", async () => {
    const paid = await preparePaidSession("phase8-happy-path");

    const created = await startPrintJob(paid, "phase8-print-1");
    expect(created.status).toBe("QUEUED");
    expect(created.paymentId).toBe(paid.paymentId);
    expect(created.physicalSheets).toBe(expectedSheets);
    // The manifest is locked the moment the job exists.
    await expectSessionState(paid.sessionId, "PRINTING");

    // The HTTP path only wrote a durable job. A worker turns it into work.
    expect(await database.agentCommand.count({ where: { printJobId: created.id } })).toBe(0);
    await dispatcher.dispatchOnce();
    await drainDispatchQueue();
    const command = await database.agentCommand.findUniqueOrThrow({
      where: { printJobId: created.id }
    });
    expect(command.status).toBe("PENDING");

    const printer = countingAdapter(new MockPrinterAdapter({ outputDirectory }));
    await buildRunner(printer.adapter).runOnce();

    const settled = await readPrintJob(created.id);
    expect(settled.status).toBe("COMPLETED");
    expect(settled.resultConfidence).toBe("CONFIRMED");
    expect(settled.sheetsProduced).toBe(expectedSheets);
    expect(printer.submissions).toBe(1);
    await expectSessionState(paid.sessionId, "COMPLETED");

    // One logical mock output exists, named from the operation and the
    // document's position in the job — never from a customer filename.
    const operationDirectory = resolve(outputDirectory, command.operationId);
    const written = (await readdir(operationDirectory)).sort();
    expect(written).toEqual(["document-000.pdf", "manifest.json", "operation.json"]);
    const output = await readFile(join(operationDirectory, "document-000.pdf"));
    expect(output.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // Nothing is owed back for a print that was delivered.
    expect(await database.refund.count({ where: { sessionId: paid.sessionId } })).toBe(0);

    // The customer's documents leave with the session.
    const files = await database.uploadedFile.findMany({
      where: { sessionId: paid.sessionId },
      select: { status: true }
    });
    expect(files.every((file) => file.status === "DELETE_PENDING")).toBe(true);
    const grants = await database.sessionUploadGrant.findMany({
      where: { sessionId: paid.sessionId },
      select: { status: true }
    });
    expect(grants.every((grant) => grant.status === "REVOKED")).toBe(true);

    // The events the kiosk sees are gapless and carry no document identity.
    const events = await database.outboxEvent.findMany({
      where: { aggregateId: paid.sessionId },
      orderBy: { sequence: "asc" }
    });
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index + 1));
    expect(events.map((event) => event.type)).toContain("print.started");
    expect(events.map((event) => event.type)).toContain("session.completed");
    // A print event says what the screen must show and nothing else: no object
    // key, no document identity, no device string.
    const printEvents = events.filter((event) => event.type.startsWith("print."));
    expect(printEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(printEvents)).not.toContain(paid.fileId);
    expect(JSON.stringify(events)).not.toContain("normalized/v1/");
    expect(JSON.stringify(events)).not.toContain("synthetic-phase8.pdf");
  });

  it("prints once for a repeated request and refuses a foreign kiosk", async () => {
    const paid = await preparePaidSession("phase8-idempotent");

    const first = await startPrintJob(paid, "phase8-print-repeat");
    const replay = await startPrintJob(paid, "phase8-print-repeat");
    // Even a genuinely new key cannot open a second job: a session prints once.
    const freshKey = await startPrintJob(paid, "phase8-print-repeat-2");

    expect(replay.id).toBe(first.id);
    expect(freshKey.id).toBe(first.id);
    expect(await database.printJob.count({ where: { sessionId: paid.sessionId } })).toBe(1);

    const foreign = await app.inject({
      method: "GET",
      url: `/v1/print-jobs/${first.id}`,
      headers: { authorization: foreignAuthorization }
    });
    // A foreign kiosk is told the job does not exist rather than that it
    // exists and belongs to somebody else.
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: { code: "PRINT_JOB_NOT_FOUND" } });
  });

  it("refuses to print a session that has not been paid", async () => {
    const priced = await prepareQuotedSession("phase8-unpaid");

    const response = await app.inject({
      method: "POST",
      url: `/v1/sessions/${priced.sessionId}/print-jobs`,
      headers: { authorization, "idempotency-key": "phase8-unpaid-print" },
      payload: { paymentId: "01900000-0000-7000-8000-0000000008ff" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "PRINT_PAYMENT_REQUIRED" } });
    expect(await database.printJob.count({ where: { sessionId: priced.sessionId } })).toBe(0);
    await expectSessionState(priced.sessionId, "CONFIGURING");
  });

  it("issues one command however many times the queue delivers the job", async () => {
    const paid = await preparePaidSession("phase8-duplicate-delivery");
    const created = await startPrintJob(paid, "phase8-print-duplicate");

    await dispatcher.dispatchOnce();
    await drainDispatchQueue();
    // The queue is a wake-up, not a guarantee of exactly-once delivery.
    await issueCommand(created.id, 1);
    await issueCommand(created.id, 2);

    expect(await database.agentCommand.count({ where: { printJobId: created.id } })).toBe(1);
    const ledger = await database.printJobEvent.findMany({
      where: { printJobId: created.id, type: "DISPATCHED" }
    });
    expect(ledger).toHaveLength(1);
  });

  it("records money owed back when the device proves nothing was printed", async () => {
    const paid = await preparePaidSession("phase8-offline");
    const created = await startPrintJob(paid, "phase8-print-offline", "OFFLINE");
    await dispatchAndRun();

    const settled = await readPrintJob(created.id);
    expect(settled.status).toBe("FAILED");
    expect(settled.resultConfidence).toBe("CONFIRMED");
    expect(settled.failureCode).toBe("PRINTER_OFFLINE");
    expect(settled.sheetsProduced).toBe(0);
    await expectSessionState(paid.sessionId, "FAILED");

    // A capture that bought nothing is an obligation, recorded once.
    const refunds = await database.refund.findMany({ where: { sessionId: paid.sessionId } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      reason: "PRINT_FAILED",
      amountMinor: expectedTotalMinor,
      currency: "AMD",
      status: "PENDING"
    });
    // The capture itself is untouched: money that moved stays recorded.
    const payment = await database.payment.findUniqueOrThrow({ where: { id: paid.paymentId } });
    expect(payment.status).toBe("CAPTURED");
    expect(payment.appliedToSession).toBe(true);
  });

  it("asks for an operator, and no refund, when the device cannot confirm the result", async () => {
    const paid = await preparePaidSession("phase8-unconfirmed");
    const created = await startPrintJob(paid, "phase8-print-unconfirmed", "UNKNOWN_AFTER_SUBMIT");
    await dispatchAndRun();

    const settled = await readPrintJob(created.id);
    expect(settled.status).toBe("RECOVERY_REQUIRED");
    expect(settled.resultConfidence).toBe("UNCONFIRMED");
    await expectSessionState(paid.sessionId, "RECOVERY_REQUIRED");

    // Paper may be in the customer's hand. Inventing a refund here would be as
    // wrong as ignoring a real one.
    expect(await database.refund.count({ where: { sessionId: paid.sessionId } })).toBe(0);
    const events = await database.outboxEvent.findMany({
      where: { aggregateId: paid.sessionId, type: "print.recovery_required" }
    });
    expect(events).toHaveLength(1);
  });

  it("escalates a partial jam rather than calling it a clean failure", async () => {
    const paid = await preparePaidSession("phase8-jam");
    const created = await startPrintJob(paid, "phase8-print-jam", "PAPER_JAM");
    await dispatchAndRun();

    const settled = await readPrintJob(created.id);
    expect(settled.status).toBe("RECOVERY_REQUIRED");
    expect(settled.failureCode).toBe("PAPER_JAM");
    expect(settled.sheetsProduced).toBeGreaterThan(0);
    expect(await database.refund.count({ where: { sessionId: paid.sessionId } })).toBe(0);
  });

  it("never prints a redelivered operation the device already ran", async () => {
    const paid = await preparePaidSession("phase8-redelivery");
    const created = await startPrintJob(paid, "phase8-print-redelivery");
    await dispatcher.dispatchOnce();
    await drainDispatchQueue();

    // An agent leases the work, hands it to the device, and then dies before it
    // can report anything. The device's own output is the surviving evidence.
    const claimed = await app.inject({
      method: "POST",
      url: "/v1/agent/commands/claim",
      headers: { authorization },
      payload: { max: 1 }
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    const command = await database.agentCommand.findUniqueOrThrow({
      where: { printJobId: created.id }
    });
    await writeDeviceEvidence(command.operationId);

    // The lease expires and the command is offered again, marked redelivered.
    await database.agentCommand.update({
      where: { id: command.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) }
    });
    await dispatcher.reconcileOnce();

    expect(
      (await database.agentCommand.findUniqueOrThrow({ where: { id: command.id } })).status
    ).toBe("PENDING");

    const printer = countingAdapter(new MockPrinterAdapter({ outputDirectory }));
    await buildRunner(printer.adapter).runOnce();

    // Nothing was printed a second time, and the operation identifier is the
    // same one the device already knows.
    expect(printer.submissions).toBe(0);
    const settled = await readPrintJob(created.id);
    expect(settled.status).toBe("RECOVERY_REQUIRED");
    expect(settled.resultConfidence).toBe("UNCONFIRMED");
    expect(await database.agentCommand.count({ where: { printJobId: created.id } })).toBe(1);
  });

  it("stops a job the device has not seen and records the money owed back", async () => {
    const paid = await preparePaidSession("phase8-cancel");
    const created = await startPrintJob(paid, "phase8-print-cancel");

    const canceled = await app.inject({
      method: "POST",
      url: `/v1/print-jobs/${created.id}/cancel`,
      headers: { authorization, "idempotency-key": "phase8-print-cancel-1" }
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(getPrintJobResponseSchema.parse(canceled.json()).printJob.status).toBe("CANCELED");
    await expectSessionState(paid.sessionId, "FAILED");
    expect(await database.refund.count({ where: { sessionId: paid.sessionId } })).toBe(1);

    // A settled job stays settled, and the dispatcher never hands it out.
    await dispatcher.dispatchOnce();
    await drainDispatchQueue();
    expect(
      await database.agentCommand.count({
        where: { printJobId: created.id, status: { in: ["PENDING", "CLAIMED"] } }
      })
    ).toBe(0);
    const printer = countingAdapter(new MockPrinterAdapter({ outputDirectory }));
    await buildRunner(printer.adapter).runOnce();
    expect(printer.submissions).toBe(0);
  });

  it("refuses to cancel a print that already finished", async () => {
    const paid = await preparePaidSession("phase8-cancel-late");
    const created = await startPrintJob(paid, "phase8-print-cancel-late");
    await dispatchAndRun();

    const response = await app.inject({
      method: "POST",
      url: `/v1/print-jobs/${created.id}/cancel`,
      headers: { authorization, "idempotency-key": "phase8-print-cancel-late-1" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "PRINT_ALREADY_COMPLETED" } });
  });

  it("hands the agent only the documents its own leased job names", async () => {
    const paid = await preparePaidSession("phase8-artifact-access");
    const created = await startPrintJob(paid, "phase8-print-artifact");
    await dispatcher.dispatchOnce();
    await drainDispatchQueue();

    const claimResponse = await app.inject({
      method: "POST",
      url: "/v1/agent/commands/claim",
      headers: { authorization },
      payload: { max: 1 }
    });
    const command = await database.agentCommand.findUniqueOrThrow({
      where: { printJobId: created.id }
    });
    expect(claimResponse.statusCode, claimResponse.body).toBe(200);
    const claimToken = command.claimToken ?? "";
    const manifest = printJobManifestSchema.parse(
      (await database.printJob.findUniqueOrThrow({ where: { id: created.id } })).jobManifest
    );
    const documentId = manifest.documents[0]?.documentId ?? "";

    const allowed = await app.inject({
      method: "GET",
      url: `/v1/agent/print-jobs/${created.id}/documents/${documentId}`,
      headers: { authorization, "x-print-claim-token": claimToken }
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.headers["content-type"]).toBe("application/pdf");
    expect(allowed.rawPayload.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    // The agent verifies what it received against the manifest digest before
    // anything reaches a device.
    expect(createHash("sha256").update(allowed.rawPayload).digest("hex")).toBe(
      manifest.documents[0]?.sha256
    );

    // The manifest is the allowlist: nothing outside it is readable through a
    // job's lease, and no path can be traversed into.
    const unlisted = await app.inject({
      method: "GET",
      url: `/v1/agent/print-jobs/${created.id}/documents/01900000-0000-7000-8000-0000000008fe`,
      headers: { authorization, "x-print-claim-token": claimToken }
    });
    expect(unlisted.statusCode).toBe(404);

    const withoutLease = await app.inject({
      method: "GET",
      url: `/v1/agent/print-jobs/${created.id}/documents/${documentId}`,
      headers: { authorization, "x-print-claim-token": "01900000-0000-7000-8000-0000000008fd" }
    });
    expect(withoutLease.statusCode).toBe(404);

    const traversal = await app.inject({
      method: "GET",
      url: `/v1/agent/print-jobs/${created.id}/documents/..%2F..%2Fetc%2Fpasswd`,
      headers: { authorization, "x-print-claim-token": claimToken }
    });
    expect(traversal.statusCode).toBe(400);

    const foreign = await app.inject({
      method: "GET",
      url: `/v1/agent/print-jobs/${created.id}/documents/${documentId}`,
      headers: { authorization: foreignAuthorization, "x-print-claim-token": claimToken }
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("settles a job whose device never answered without inventing an outcome", async () => {
    const paid = await preparePaidSession("phase8-deadline");
    const created = await startPrintJob(paid, "phase8-print-deadline");
    await dispatcher.dispatchOnce();
    await drainDispatchQueue();

    // The command was never claimed and the job has run out of time. The
    // deadline is part of the immutable snapshot, so time moves, not the job.
    const later = new PrintDispatcher({
      database: serviceDatabase,
      redisUrl: environment.REDIS_URL,
      logger: silentLogger,
      leaseMilliseconds: environment.PRINT_COMMAND_LEASE_SECONDS * 1_000,
      maxCommandAttempts: environment.PRINT_COMMAND_MAX_ATTEMPTS,
      maxDispatchAttempts: environment.PRINT_DISPATCH_MAX_ATTEMPTS,
      now: () => new Date(Date.now() + environment.PRINT_JOB_TIMEOUT_SECONDS * 1_000 + 1_000)
    });
    try {
      await later.reconcileOnce();
    } finally {
      await later.close();
    }

    const settled = await readPrintJob(created.id);
    expect(settled.status).toBe("FAILED");
    expect(settled.resultConfidence).toBe("CONFIRMED");
    expect(settled.failureCode).toBe("PRINTER_UNAVAILABLE");
    await expectSessionState(paid.sessionId, "FAILED");
    expect(await database.refund.count({ where: { sessionId: paid.sessionId } })).toBe(1);
  });

  it("keeps an immutable job snapshot and an append-only operation ledger", async () => {
    const paid = await preparePaidSession("phase8-snapshot");
    const created = await startPrintJob(paid, "phase8-print-snapshot");
    await dispatchAndRun();

    const stored = await database.printJob.findUniqueOrThrow({ where: { id: created.id } });
    const manifest = printJobManifestSchema.parse(stored.jobManifest);
    // The job prints exactly the settings revision the capture paid for, bound
    // to the document's own bytes rather than to its identifier alone.
    expect(manifest.settingsRevision).toBe(paid.settingsRevision);
    expect(manifest.paymentId).toBe(paid.paymentId);
    expect(stored.settingsManifestHash).toBe(
      (await database.payment.findUniqueOrThrow({ where: { id: paid.paymentId } })).manifestHash
    );
    expect(JSON.stringify(manifest)).not.toContain("synthetic-phase8.pdf");

    // The database refuses to rewrite the snapshot, whatever asks it to.
    await expect(
      database.printJob.update({ where: { id: created.id }, data: { copies: 9 } })
    ).rejects.toThrow();

    const ledger = await database.printJobEvent.findMany({
      where: { printJobId: created.id },
      orderBy: { sequence: "asc" }
    });
    expect(ledger.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: ledger.length }, (_, index) => index + 1)
    );
    expect(ledger.map((entry) => entry.type)).toEqual([
      "CREATED",
      "DISPATCHED",
      "CLAIMED",
      // The agent says it has the work before it hands it over, so an
      // interrupted print leaves evidence rather than silence.
      "PROGRESS",
      "SUBMITTED",
      "COMPLETED"
    ]);
    const first = ledger[0];
    if (!first) throw new Error("PHASE8_LEDGER_EMPTY");
    await expect(
      database.printJobEvent.update({ where: { id: first.id }, data: { status: "COMPLETED" } })
    ).rejects.toThrow();
  });
});

interface PaidSession {
  sessionId: string;
  fileId: string;
  settingsRevision: number;
  quoteId: string;
  paymentId: string;
}

interface QuotedSession {
  sessionId: string;
  sessionVersion: number;
  fileId: string;
  settingsRevision: number;
  quote: { id: string; totalMinor: number };
}

/** Drives the real Phase 3–6 path to a validated, priced document. */
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
    clientFileId: "01900000-0000-7000-8000-000000000812",
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

/** …and then all the way through a verified Phase 7 capture. */
async function preparePaidSession(idempotencyKey: string): Promise<PaidSession> {
  const priced = await prepareQuotedSession(idempotencyKey);
  expect(priced.quote.totalMinor).toBe(expectedTotalMinor);

  const createdResponse = await app.inject({
    method: "POST",
    url: `/v1/sessions/${priced.sessionId}/payments`,
    headers: { authorization, "idempotency-key": `${idempotencyKey}-payment` },
    payload: { quoteId: priced.quote.id }
  });
  expect(createdResponse.statusCode, createdResponse.body).toBe(201);
  const payment = createPaymentResponseSchema.parse(createdResponse.json()).payment;

  const signed = provider.signOutcome({
    paymentId: payment.id,
    outcome: "SUCCEEDED",
    amount: { amountMinor: expectedTotalMinor, currency: "AMD", currencyExponent: 2 },
    occurredAt: new Date()
  });
  const captured = await app.inject({
    method: "POST",
    url: "/v1/webhooks/payments/mock",
    headers: signed.headers,
    payload: signed.body
  });
  expect(captured.statusCode, captured.body).toBe(200);
  await expectSessionState(priced.sessionId, "PAID");

  return {
    sessionId: priced.sessionId,
    fileId: priced.fileId,
    settingsRevision: priced.settingsRevision,
    quoteId: priced.quote.id,
    paymentId: payment.id
  };
}

async function startPrintJob(paid: PaidSession, idempotencyKey: string, scenario?: string) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/sessions/${paid.sessionId}/print-jobs`,
    headers: { authorization, "idempotency-key": idempotencyKey },
    payload: scenario
      ? { paymentId: paid.paymentId, simulatedOutcome: scenario }
      : { paymentId: paid.paymentId }
  });
  expect(response.statusCode, response.body).toBe(201);
  return createPrintJobResponseSchema.parse(response.json()).printJob;
}

async function readPrintJob(printJobId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/v1/print-jobs/${printJobId}`,
    headers: { authorization }
  });
  expect(response.statusCode, response.body).toBe(200);
  return getPrintJobResponseSchema.parse(response.json()).printJob;
}

/** The dispatcher's queue handler, reached without a live Redis worker. */
function issueCommand(printJobId: string, attempt: number): Promise<void> {
  const handler = Reflect.get(dispatcher, "issueCommand") as (job: {
    data: { printJobId: string; attempt: number };
  }) => Promise<void>;
  return handler.call(dispatcher, { data: { printJobId, attempt } });
}

async function drainDispatchQueue(): Promise<void> {
  const queued = await database.printJob.findMany({
    where: { status: "QUEUED" },
    select: { id: true, dispatchAttempts: true }
  });
  for (const job of queued) {
    await issueCommand(job.id, Math.max(1, job.dispatchAttempts));
  }
}

async function dispatchAndRun(): Promise<void> {
  await dispatcher.dispatchOnce();
  await drainDispatchQueue();
  await buildRunner(new MockPrinterAdapter({ outputDirectory })).runOnce();
}

function buildRunner(adapter: PrinterAdapter): PrintCommandRunner {
  return new PrintCommandRunner({
    environment: loadEnvironment({
      ...baseEnvironment,
      PRINTER_SPOOL_DIR: spoolDirectory,
      PRINTER_MOCK_OUTPUT_DIR: outputDirectory
    }),
    adapter,
    logger: { info: () => undefined, warn: () => undefined },
    fetch: injectFetch
  });
}

/** Routes the agent's outbound calls into the running API. */
async function injectFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const response = await app.inject({
    method: (init?.method ?? "GET") as "GET" | "POST",
    url: `${url.pathname}${url.search}`,
    headers: init?.headers as Record<string, string> | undefined,
    ...(typeof init?.body === "string" ? { payload: init.body } : {})
  });
  return new Response(response.rawPayload, {
    status: response.statusCode,
    headers: { "content-type": String(response.headers["content-type"] ?? "application/json") }
  });
}

/** Counts submissions so a redelivery can be proven not to print twice. */
function countingAdapter(inner: PrinterAdapter) {
  const counter = { submissions: 0, adapter: inner };
  counter.adapter = {
    name: inner.name,
    getHealth: () => inner.getHealth(),
    getCapabilities: () => inner.getCapabilities(),
    getOperationStatus: (operationId: string) => inner.getOperationStatus(operationId),
    cancel: (operationId: string) => inner.cancel(operationId),
    submit: (submission: PrintSubmission) => {
      counter.submissions += 1;
      return inner.submit(submission);
    }
  };
  return counter;
}

/**
 * Stand in for a device that already ran an operation: the completion marker
 * the mock printer writes last is the evidence a restarted agent finds.
 */
async function writeDeviceEvidence(operationId: string): Promise<void> {
  const directory = resolve(outputDirectory, operationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "operation.json"), "{}", { encoding: "utf8", mode: 0o600 });
  await writeFile(join(directory, "manifest.json"), "{}", { encoding: "utf8", mode: 0o600 });
}

async function expectSessionState(sessionId: string, state: string): Promise<void> {
  const session = await database.printSession.findUniqueOrThrow({ where: { id: sessionId } });
  expect(session.state).toBe(state);
}

function settingsBody(fileId: string) {
  return {
    fileOrder: [fileId],
    fileSelections: [{ fileId, pageRanges: null }],
    copies: 1,
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
        `PHASE8_PROCESSING_TERMINATED:${file.status}:${file.rejectionCode ?? "NONE"}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PHASE8_FILE_STATUS_TIMEOUT:${status}`);
}

async function exchangeMobile(publicSessionId: string, uploadToken: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/mobile-auth/exchange",
    headers: { origin: environment.UPLOAD_ORIGIN },
    payload: {
      publicSessionId,
      uploadToken,
      clientNonce: "01900000-0000-7000-8000-000000000811"
    }
  });
  expect(response.statusCode, response.body).toBe(200);
  const context = mobileContextResponseSchema.parse(response.json());
  const setCookieHeader = response.headers["set-cookie"];
  const setCookie = Array.isArray(setCookieHeader)
    ? (setCookieHeader[0] ?? "")
    : (setCookieHeader ?? "");
  const cookieHeader = setCookie.split(";", 1)[0] ?? "";
  if (!cookieHeader) throw new Error("PHASE8_MOBILE_COOKIE_MISSING");
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
  const boundary = "phase8-synthetic-document-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="synthetic-phase8.pdf"\r\n` +
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
    const stream = `BT /F1 24 Tf 72 720 Td (Synthetic Phase 8 page ${index + 1}) Tj ET\n`;
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
  if (!token) throw new Error("PHASE8_UPLOAD_TOKEN_MISSING");
  return token;
}

async function assertInfrastructure(): Promise<void> {
  try {
    await database.$queryRaw`SELECT 1`;
    databaseReachable = true;
  } catch (error) {
    throw new Error(
      `PHASE8_DATABASE_NOT_READY: run pnpm infra:up and pnpm db:migrate (${safeMessage(error)})`
    );
  }

  const published = await database.pricingRuleSet.findFirst({
    where: { status: "PUBLISHED", scope: "GLOBAL", scopeRef: "" },
    include: { rules: true }
  });
  const printRule = published?.rules.find(
    (rule) => rule.service === "PRINT" && rule.paperSize === "A4"
  );
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
    throw new Error("PHASE8_UNEXPECTED_TARIFF: run pnpm db:seed");
  }

  try {
    await Promise.all([apiObjectStore.checkReady(), workerStore.checkReady()]);
  } catch (error) {
    throw new Error(`PHASE8_OBJECT_STORAGE_NOT_READY: run pnpm infra:up (${safeMessage(error)})`);
  }

  let response: Response;
  try {
    response = await fetch(new URL("/health/ready", environment.DOCUMENT_PROCESSOR_URL), {
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new Error(`PHASE8_PROCESSOR_UNREACHABLE: run pnpm infra:up (${safeMessage(error)})`);
  }
  if (!response.ok) {
    throw new Error(`PHASE8_PROCESSOR_NOT_READY: ${response.status}; inspect pnpm infra:logs`);
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
      name: "Phase 8 kiosk",
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
    "payments:read",
    "print-jobs:create",
    "print-jobs:read",
    "print-jobs:write",
    "print-jobs:agent"
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

  // Print jobs hold the references that keep a payment and a settings revision
  // alive, so the print lineage is cleared first — as a fixture, never as an
  // operation this system performs.
  await database.agentCommand.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.printJob.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.refund.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.paymentWebhookInbox.deleteMany({
    where: { payment: { sessionId: { in: sessionIds } } }
  });
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
    throw new Error("PHASE8_FIXTURE_OBJECT_CLEANUP_FAILED");
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
