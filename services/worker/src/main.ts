import pino from "pino";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";
import { PRODUCT_SCOPE } from "@printing-kiosk/contracts";
import { createDatabaseClient } from "@printing-kiosk/database";
import { MockPaymentProvider } from "@printing-kiosk/payment-adapters";

import { PaymentReconciler } from "./jobs/reconcile-payments.js";
import { OutboxPublisher } from "./jobs/publish-outbox.js";
import { DocumentProcessingCoordinator } from "./jobs/process-document.js";
import { DocumentProcessorClient } from "./processing/processor-client.js";
import { ProcessorScratchJanitor } from "./processing/scratch-cleanup.js";
import { S3DocumentStore } from "./storage/document-store.js";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment();
const logger = pino({ level: environment.LOG_LEVEL });
const database = createDatabaseClient(environment.DATABASE_URL);
const publisher = new OutboxPublisher(database, environment, logger);
const processorScratch = new ProcessorScratchJanitor({
  directory: environment.DOCUMENT_PROCESSOR_SCRATCH_DIR,
  staleAfterMilliseconds:
    Math.max(
      environment.DOCUMENT_PROCESSOR_TIMEOUT_SECONDS,
      environment.DOCUMENT_PROCESSOR_LEASE_SECONDS
    ) *
    2 *
    1_000,
  intervalMilliseconds: Math.max(60_000, environment.DOCUMENT_PROCESSOR_TIMEOUT_SECONDS * 1_000),
  onError: () => logger.warn("processor response scratch cleanup failed")
});
await processorScratch.start();
const documentStore = new S3DocumentStore({
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
const processorClient = new DocumentProcessorClient({
  endpoint: environment.DOCUMENT_PROCESSOR_URL,
  authToken: environment.DOCUMENT_PROCESSOR_AUTH_TOKEN,
  scratchDirectory: environment.DOCUMENT_PROCESSOR_SCRATCH_DIR,
  timeoutMilliseconds: environment.DOCUMENT_PROCESSOR_TIMEOUT_SECONDS * 1_000,
  maxResponseBytes: environment.DOCUMENT_PROCESSOR_RESPONSE_MAX_BYTES,
  maxPages: environment.MAX_DOCUMENT_PAGES,
  maxPreviewBytes: environment.MAX_PREVIEW_FILE_BYTES,
  maxNormalizedBytes: environment.MAX_NORMALIZED_FILE_BYTES
});
const documentProcessing = new DocumentProcessingCoordinator({
  database,
  redisUrl: environment.REDIS_URL,
  store: documentStore,
  processor: processorClient,
  logger,
  concurrency: environment.DOCUMENT_PROCESSING_CONCURRENCY,
  leaseMilliseconds: environment.DOCUMENT_PROCESSOR_LEASE_SECONDS * 1_000,
  maximumAttempts: environment.DOCUMENT_PROCESSOR_MAX_ATTEMPTS
});

const paymentReconciler = new PaymentReconciler({
  database,
  provider: new MockPaymentProvider({
    webhookSecret: environment.PAYMENT_WEBHOOK_SECRET,
    signatureToleranceSeconds: environment.PAYMENT_WEBHOOK_TOLERANCE_SECONDS
  }),
  logger
});

logger.info({ productScope: PRODUCT_SCOPE }, "worker started");
publisher.start();
documentProcessing.start();
paymentReconciler.start();

const shutdown = async (signal: string) => {
  logger.info({ signal }, "worker stopped");
  await Promise.all([
    publisher.close(),
    documentProcessing.close(),
    processorScratch.close(),
    paymentReconciler.close()
  ]);
  await database.$disconnect();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
