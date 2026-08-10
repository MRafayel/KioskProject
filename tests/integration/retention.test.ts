import { createHash, randomUUID } from "node:crypto";

import {
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import { createSessionResponseSchema } from "../../packages/contracts/src/sessions.js";
import { createDatabaseClient } from "../../packages/database/src/index.js";
import { SESSION_OBJECT_ROOTS } from "../../packages/domain/src/retention.js";
import { buildApp } from "../../services/api/src/app.js";
import {
  SessionCleanupRunner,
  type CleanupLogger
} from "../../services/worker/src/jobs/cleanup-session.js";
import { StorageReconciler } from "../../services/worker/src/jobs/reconcile-storage.js";
import {
  S3DocumentStore,
  type RetentionStore
} from "../../services/worker/src/storage/document-store.js";
import { assertSafeIntegrationEnvironment } from "./safety.js";

const kioskId = "kiosk_retention_001";
const credentialId = "retention-kiosk-credential";
const kioskApiKey = "integration-only-retention-key-0001";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({
  ...process.env,
  NODE_ENV: "test",
  DEV_KIOSK_ID: kioskId,
  DEV_KIOSK_API_KEY: kioskApiKey
});
assertSafeIntegrationEnvironment(environment);

const database = createDatabaseClient(environment.DATABASE_URL);
const authorization = `Bearer ${kioskApiKey}`;
const documentStore = new S3DocumentStore({
  endpoint: environment.S3_ENDPOINT,
  region: environment.S3_REGION,
  bucket: environment.S3_BUCKET,
  accessKeyId: environment.S3_WORKER_ACCESS_KEY_ID,
  secretAccessKey: environment.S3_WORKER_SECRET_ACCESS_KEY,
  forcePathStyle: environment.S3_FORCE_PATH_STYLE
});
// The tests inspect and seed the bucket directly: the store contract
// deliberately exposes no way to write a quarantine object or list a prefix.
// Two clients, because the two credentials are deliberately not
// interchangeable — the API may write an upload and never a derivative, and
// the worker may write a derivative and never an upload.
const s3 = new S3Client({
  endpoint: environment.S3_ENDPOINT,
  region: environment.S3_REGION,
  forcePathStyle: environment.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: environment.S3_ACCESS_KEY_ID,
    secretAccessKey: environment.S3_SECRET_ACCESS_KEY
  }
});
const workerS3 = new S3Client({
  endpoint: environment.S3_ENDPOINT,
  region: environment.S3_REGION,
  forcePathStyle: environment.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: environment.S3_WORKER_ACCESS_KEY_ID,
    secretAccessKey: environment.S3_WORKER_SECRET_ACCESS_KEY
  }
});

/** The credential allowed to write this key, mirroring the bucket policy. */
function writerFor(key: string): S3Client {
  return key.startsWith("quarantine/v1/") ? s3 : workerS3;
}

const silentLogger: CleanupLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
const createdSessionIds = new Set<string>();

function createRunner(store: RetentionStore = documentStore, logger = silentLogger) {
  return new SessionCleanupRunner({
    database,
    store,
    logger,
    leaseMilliseconds: 30_000,
    maximumAttempts: 3,
    batchSize: 5
  });
}

async function buildTestApp() {
  const app = await buildApp({ environment, database, startBackgroundJobs: false });
  openApps.push(app);
  return app;
}

beforeAll(async () => {
  await database.kiosk.upsert({
    where: { id: kioskId },
    create: {
      id: kioskId,
      publicCode: "RETENTION-001",
      name: "Retention test kiosk",
      status: "ACTIVE",
      timezone: "Asia/Yerevan",
      capabilities: {
        service: "PRINT_ONLY",
        outputMode: "MONOCHROME",
        paperSizes: ["A4"],
        duplex: true,
        scanningEnabled: false,
        photocopyEnabled: false
      }
    },
    update: { status: "ACTIVE" }
  });
  await database.kioskCredential.upsert({
    where: { credentialId },
    create: {
      id: "01900000-0000-7000-8000-000000000f01",
      kioskId,
      credentialId,
      secretDigest: createHash("sha256").update(kioskApiKey, "utf8").digest("hex"),
      scopes: ["sessions:create", "sessions:read", "sessions:cancel", "files:read", "files:delete"]
    },
    update: {
      kioskId,
      secretDigest: createHash("sha256").update(kioskApiKey, "utf8").digest("hex"),
      scopes: ["sessions:create", "sessions:read", "sessions:cancel", "files:read", "files:delete"],
      revokedAt: null,
      expiresAt: null
    }
  });
});

beforeEach(async () => {
  await resetFixtures();
});

afterAll(async () => {
  await resetFixtures();
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await database.kioskCredential.deleteMany({ where: { credentialId } });
  await database.kiosk.deleteMany({ where: { id: kioskId } });
  await database.$disconnect();
});

describe("Phase 9 retention", () => {
  it("removes every object a canceled session left and records that it did", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);

    await cancelSession(app, fixture.sessionId, fixture.version);
    const scheduled = await database.printSession.findUniqueOrThrow({
      where: { id: fixture.sessionId }
    });
    // A customer who walked away waits for nothing.
    expect(scheduled.cleanupStatus).toBe("PENDING");
    expect(scheduled.cleanupDueAt?.getTime()).toBeLessThanOrEqual(Date.now());

    await createRunner().runOnce();

    expect(await listSessionObjects(fixture.sessionId)).toEqual([]);
    const cleaned = await database.printSession.findUniqueOrThrow({
      where: { id: fixture.sessionId }
    });
    expect(cleaned.cleanupStatus).toBe("DONE");
    expect(cleaned.filesDeletedAt).not.toBeNull();

    const run = await database.cleanupRun.findUniqueOrThrow({
      where: { sessionId: fixture.sessionId }
    });
    expect(run).toMatchObject({ status: "DONE", checkpoint: "COMPLETED", attempts: 0 });
    expect(run.completedAt).not.toBeNull();
    expect(run.leaseToken).toBeNull();
  });

  it("leaves a redacted tombstone rather than an absence", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    await cancelSession(app, fixture.sessionId, fixture.version);
    await createRunner().runOnce();

    const file = await database.uploadedFile.findUniqueOrThrow({ where: { id: fixture.fileId } });
    expect(file).toMatchObject({
      status: "DELETED",
      quarantineObjectKey: null,
      contentSha256: null,
      pageCount: null,
      detectedMime: null,
      declaredMime: null,
      extension: null,
      processingErrorCode: null
    });
    // The shape of what happened survives; what it was does not.
    expect(file.ordinal).toBe(0);
    expect(file.sizeBytes).toBeGreaterThan(0);
    expect(file.deletedAt).not.toBeNull();

    expect(await database.filePage.count({ where: { fileId: fixture.fileId } })).toBe(0);
    expect(await database.fileDerivative.count({ where: { fileId: fixture.fileId } })).toBe(0);
    // The grant rows exist to be checked against a presented secret; once
    // nothing may be presented, their digests are all that is left in them.
    expect(
      await database.sessionUploadGrant.count({ where: { sessionId: fixture.sessionId } })
    ).toBe(0);
  });

  it("removes document fingerprints from retained print settings", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    const revisionId = randomUUID();
    const digest = createHash("sha256").update("retention-fixture").digest("hex");
    await database.printSettingRevision.create({
      data: {
        id: revisionId,
        sessionId: fixture.sessionId,
        revision: 1,
        copies: 2,
        duplex: "LONG_EDGE",
        paperSize: "A4",
        orientation: "PORTRAIT",
        scaling: "FIT",
        collate: true,
        colorMode: "MONOCHROME",
        selections: [
          {
            fileId: fixture.fileId,
            position: 0,
            pageCount: 1,
            processingRevision: 1,
            contentSha256: digest,
            pageRanges: [[1, 1]],
            pageRangeText: "1",
            selectedPages: 1
          }
        ],
        selectedPages: 1,
        printedSides: 2,
        physicalSheets: 2,
        capabilityVersion: 1,
        manifestHash: "f".repeat(64),
        createdByActorType: "KIOSK",
        createdByActorId: credentialId
      }
    });
    await database.printSession.update({
      where: { id: fixture.sessionId },
      data: { currentSettingsRevision: 1 }
    });

    await cancelSession(app, fixture.sessionId, fixture.version);
    await createRunner().runOnce();

    const revision = await database.printSettingRevision.findUniqueOrThrow({
      where: { id: revisionId }
    });
    expect(revision.selectionsRedactedAt).not.toBeNull();
    expect(revision).toMatchObject({ copies: 2, selectedPages: 1, printedSides: 2 });
    const serialized = JSON.stringify(revision.selections);
    expect(serialized).not.toContain("contentSha256");
    expect(serialized).not.toContain(digest);
    expect(serialized).toContain(fixture.fileId);

    // Redaction removes an internal fingerprint, not the customer-visible
    // record of the ranges and counts that were configured.
    const readable = await app.inject({
      method: "GET",
      url: `/v1/sessions/${fixture.sessionId}/settings`,
      headers: { authorization }
    });
    expect(readable.statusCode, readable.body).toBe(200);
    expect(readable.json()).toMatchObject({
      settings: {
        revision: 1,
        copies: 2,
        files: [{ fileId: fixture.fileId, pageRanges: [[1, 1]] }]
      }
    });
  });

  it("keeps the audit trail and the money the session generated", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    await cancelSession(app, fixture.sessionId, fixture.version);
    await createRunner().runOnce();

    const audits = await database.auditEvent.findMany({
      where: { sessionId: fixture.sessionId },
      select: { action: true }
    });
    expect(audits.map((audit) => audit.action)).toContain("session.cleanup.completed");
    expect(audits.map((audit) => audit.action)).toContain("session.canceled");
    // Nothing in the audit trail may name what was printed.
    expect(JSON.stringify(audits)).not.toContain("quarantine/v1/");

    const published = await database.outboxEvent.findMany({
      where: { aggregateId: fixture.sessionId, type: "cleanup.completed" }
    });
    expect(published).toHaveLength(1);
    expect(Object.keys(published[0]?.payload as object).sort()).toEqual([
      "filesDeletedAt",
      "sessionId"
    ]);
  });

  it("repeats safely: three further passes change nothing", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    await cancelSession(app, fixture.sessionId, fixture.version);

    const runner = createRunner();
    await runner.runOnce();
    const first = await database.printSession.findUniqueOrThrow({
      where: { id: fixture.sessionId }
    });

    await runner.runOnce();
    await runner.runOnce();
    await runner.runOnce();

    const after = await database.printSession.findUniqueOrThrow({
      where: { id: fixture.sessionId }
    });
    expect(after.filesDeletedAt).toEqual(first.filesDeletedAt);
    expect(await listSessionObjects(fixture.sessionId)).toEqual([]);
    expect(
      await database.outboxEvent.count({
        where: { aggregateId: fixture.sessionId, type: "cleanup.completed" }
      })
    ).toBe(1);
  });

  it("resumes from the checkpoint it reached when a step fails", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    await cancelSession(app, fixture.sessionId, fixture.version);

    let failPurge = true;
    const flaky: RetentionStore = {
      deleteObjects: (keys) => documentStore.deleteObjects(keys),
      purgePrefix: async (prefix) => {
        if (failPurge) throw new Error("OBJECT_PREFIX_PURGE_EXHAUSTED");
        return documentStore.purgePrefix(prefix);
      },
      abortMultipartUploads: (prefixes, startedBefore) =>
        documentStore.abortMultipartUploads(prefixes, startedBefore),
      listObjectsOlderThan: (prefix, cutoff, limit) =>
        documentStore.listObjectsOlderThan(prefix, cutoff, limit)
    };

    await createRunner(flaky).runOnce();
    const failed = await database.cleanupRun.findUniqueOrThrow({
      where: { sessionId: fixture.sessionId }
    });
    expect(failed).toMatchObject({
      status: "PENDING",
      checkpoint: "ARTIFACTS_DELETED",
      attempts: 1,
      lastErrorCode: "OBJECT_PREFIX_PURGE_EXHAUSTED"
    });
    expect(failed.leaseToken).toBeNull();
    // The bytes the failing step had already deleted stay deleted.
    const session = await database.printSession.findUniqueOrThrow({
      where: { id: fixture.sessionId }
    });
    expect(session.filesDeletedAt).toBeNull();

    failPurge = false;
    await database.cleanupRun.update({
      where: { sessionId: fixture.sessionId },
      data: { availableAt: new Date(Date.now() - 1_000) }
    });
    await createRunner(flaky).runOnce();

    const finished = await database.cleanupRun.findUniqueOrThrow({
      where: { sessionId: fixture.sessionId }
    });
    expect(finished).toMatchObject({ status: "DONE", checkpoint: "COMPLETED", attempts: 1 });
    expect(await listSessionObjects(fixture.sessionId)).toEqual([]);
  });

  it("dead-letters a run that cannot finish instead of closing it", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    await cancelSession(app, fixture.sessionId, fixture.version);

    const alerts: string[] = [];
    const broken: RetentionStore = {
      deleteObjects: () => Promise.reject(new Error("OBJECT_BATCH_DELETE_FAILED")),
      purgePrefix: () => Promise.reject(new Error("OBJECT_BATCH_DELETE_FAILED")),
      abortMultipartUploads: () => Promise.resolve(0),
      listObjectsOlderThan: () => Promise.resolve({ objects: [], acknowledge: () => undefined })
    };
    const logger: CleanupLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: (_fields, message) => alerts.push(message)
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await createRunner(broken, logger).runOnce();
      await database.cleanupRun.updateMany({
        where: { sessionId: fixture.sessionId, status: "PENDING" },
        data: { availableAt: new Date(Date.now() - 1_000) }
      });
    }

    const run = await database.cleanupRun.findUniqueOrThrow({
      where: { sessionId: fixture.sessionId }
    });
    expect(run.status).toBe("DEAD_LETTER");
    expect(run.deadLetteredAt).not.toBeNull();
    expect(alerts).toContain("session cleanup dead-lettered with documents remaining");
    const session = await database.printSession.findUniqueOrThrow({
      where: { id: fixture.sessionId }
    });
    // The documents are still there, so nothing may claim they are gone.
    expect(session.cleanupStatus).toBe("DEAD_LETTER");
    expect(session.filesDeletedAt).toBeNull();
  });

  it("aborts an unfinished multipart upload the listing would never show", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: environment.S3_BUCKET,
        Key: `quarantine/v1/${fixture.sessionId}/${randomUUID()}/abandoned-upload-part-key`
      })
    );

    await cancelSession(app, fixture.sessionId, fixture.version);
    await createRunner().runOnce();

    const uploads = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: environment.S3_BUCKET,
        Prefix: `quarantine/v1/${fixture.sessionId}/`
      })
    );
    expect(uploads.Uploads ?? []).toHaveLength(0);
    const run = await database.cleanupRun.findUniqueOrThrow({
      where: { sessionId: fixture.sessionId }
    });
    expect(run.multipartUploadsAborted).toBeGreaterThanOrEqual(1);
  });

  it("finds an object the artifact ledger never knew about", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    // An artifact written by a worker whose claim had already been revoked:
    // real bytes under the session prefix that no row points at.
    const strayKey = `previews/v1/${fixture.sessionId}/${randomUUID()}/r1/g1/page-1.webp`;
    await workerS3.send(
      new PutObjectCommand({
        Bucket: environment.S3_BUCKET,
        Key: strayKey,
        Body: Buffer.from("RIFF0000WEBPstray"),
        ContentType: "image/webp"
      })
    );

    await cancelSession(app, fixture.sessionId, fixture.version);
    await createRunner().runOnce();

    expect(await listSessionObjects(fixture.sessionId)).toEqual([]);
    const run = await database.cleanupRun.findUniqueOrThrow({
      where: { sessionId: fixture.sessionId }
    });
    expect(run.orphanObjectsDeleted).toBeGreaterThanOrEqual(1);
  });

  it("answers 410 for documents it has deleted", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);

    const before = await app.inject({
      method: "GET",
      url: `/v1/sessions/${fixture.sessionId}/files`,
      headers: { authorization }
    });
    expect(before.statusCode).toBe(200);

    await cancelSession(app, fixture.sessionId, fixture.version);
    await createRunner().runOnce();

    const listed = await app.inject({
      method: "GET",
      url: `/v1/sessions/${fixture.sessionId}/files`,
      headers: { authorization }
    });
    expect(listed.statusCode).toBe(410);
    expect(listed.json().error.code).toBe("SESSION_FILES_DELETED");

    const preview = await app.inject({
      method: "GET",
      url: `/v1/sessions/${fixture.sessionId}/files/${fixture.fileId}/pages`,
      headers: { authorization }
    });
    expect(preview.statusCode).toBe(410);
    expect(preview.json().error.code).toBe("SESSION_FILES_DELETED");
  });

  it("refuses to record a deletion that did not happen", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    await cancelSession(app, fixture.sessionId, fixture.version);

    // The session still holds documents. The claim is refused in the database,
    // whatever application code believes.
    await expect(
      database.$executeRaw`
        UPDATE "print_sessions"
          SET "cleanup_status" = 'DONE', "files_deleted_at" = now()
          WHERE "id" = ${fixture.sessionId}::uuid
      `
    ).rejects.toThrow();
  });

  it("refuses another document on a session it has already emptied", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    await cancelSession(app, fixture.sessionId, fixture.version);
    await createRunner().runOnce();

    await expect(
      database.uploadedFile.create({
        data: {
          id: randomUUID(),
          sessionId: fixture.sessionId,
          uploadedByClientId: fixture.clientId,
          clientFileId: randomUUID(),
          ordinal: 5,
          displayName: "Document 6",
          status: "UPLOADING",
          reservedBytes: 1_024,
          quarantineObjectKey: `quarantine/v1/${fixture.sessionId}/${randomUUID()}/afterCleanupToken`
        }
      })
    ).rejects.toThrow();
  });

  it("sweeps an object whose session has already been cleaned", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);
    await cancelSession(app, fixture.sessionId, fixture.version);
    await createRunner().runOnce();

    const strayKey = `normalized/v1/${fixture.sessionId}/${randomUUID()}/r1/g1/document.pdf`;
    await workerS3.send(
      new PutObjectCommand({
        Bucket: environment.S3_BUCKET,
        Key: strayKey,
        Body: Buffer.from("%PDF-1.7 stray"),
        ContentType: "application/pdf"
      })
    );

    const reconciler = new StorageReconciler({
      database,
      store: documentStore,
      logger: silentLogger,
      // The object was written seconds ago; a zero grace is what makes this
      // deterministic without waiting out a real retention window.
      orphanGraceMilliseconds: 0,
      now: () => new Date(Date.now() + 1_000)
    });
    await reconciler.runOnce();

    expect(await listSessionObjects(fixture.sessionId)).toEqual([]);
  });

  it("leaves an object alone while its session is still live", async () => {
    const app = await buildTestApp();
    const fixture = await seedSessionWithDocuments(app);

    const reconciler = new StorageReconciler({
      database,
      store: documentStore,
      logger: silentLogger,
      orphanGraceMilliseconds: 0,
      now: () => new Date(Date.now() + 1_000)
    });
    await reconciler.runOnce();

    expect((await listSessionObjects(fixture.sessionId)).length).toBeGreaterThan(0);
  });
});

interface SessionFixture {
  sessionId: string;
  clientId: string;
  fileId: string;
  version: number;
}

/**
 * A session that has reached READY with a real original, a normalized artifact
 * and a page preview in the bucket. The upload path itself is covered by the
 * Phase 3 and Phase 5 suites; what matters here is that the bytes exist in
 * every root a customer's document can reach.
 */
async function seedSessionWithDocuments(
  app: Awaited<ReturnType<typeof buildApp>>
): Promise<SessionFixture> {
  const created = await app.inject({
    method: "POST",
    url: `/v1/kiosks/${kioskId}/sessions`,
    headers: { authorization, "idempotency-key": randomUUID() },
    payload: { locale: "en" }
  });
  expect(created.statusCode).toBe(201);
  const session = createSessionResponseSchema.parse(created.json()).session;
  createdSessionIds.add(session.id);

  const clientId = randomUUID();
  await database.mobileClient.create({
    data: {
      id: clientId,
      sessionId: session.id,
      cookieDigest: createHash("sha256").update(`cookie-${clientId}`).digest("hex"),
      clientNonceDigest: createHash("sha256").update(`nonce-${clientId}`).digest("hex"),
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 600_000)
    }
  });

  const fileId = randomUUID();
  const quarantineKey = `quarantine/v1/${session.id}/${fileId}/retentionFixtureToken01`;
  const normalizedKey = `normalized/v1/${session.id}/${fileId}/r1/g1/document.pdf`;
  const previewKey = `previews/v1/${session.id}/${fileId}/r1/g1/page-1.webp`;
  const digest = createHash("sha256").update("retention-fixture").digest("hex");

  await database.uploadedFile.create({
    data: {
      id: fileId,
      sessionId: session.id,
      uploadedByClientId: clientId,
      clientFileId: randomUUID(),
      ordinal: 0,
      displayName: "Document 1",
      status: "READY",
      kind: "PDF",
      declaredMime: "application/pdf",
      detectedMime: "application/pdf",
      extension: "pdf",
      reservedBytes: 4_096,
      sizeBytes: 2_048,
      contentSha256: digest,
      quarantineObjectKey: quarantineKey,
      quarantinedAt: new Date(),
      processingRevision: 1,
      processingGeneration: 1,
      processingAttempts: 1,
      processingStartedAt: new Date(),
      malwareScanStatus: "CLEAN",
      pageCount: 1,
      readyAt: new Date()
    }
  });

  const normalizedId = randomUUID();
  const previewId = randomUUID();
  await database.fileDerivative.createMany({
    data: [
      {
        id: normalizedId,
        fileId,
        processingRevision: 1,
        type: "NORMALIZED_PDF",
        status: "AVAILABLE",
        pageNumber: 0,
        objectKey: normalizedKey,
        mimeType: "application/pdf",
        sizeBytes: 2_048,
        sha256: digest
      },
      {
        id: previewId,
        fileId,
        processingRevision: 1,
        type: "PAGE_PREVIEW",
        status: "AVAILABLE",
        pageNumber: 1,
        objectKey: previewKey,
        mimeType: "image/webp",
        sizeBytes: 512,
        sha256: digest,
        widthPixels: 800,
        heightPixels: 1_120
      }
    ]
  });
  await database.filePage.create({
    data: {
      id: randomUUID(),
      fileId,
      processingRevision: 1,
      pageNumber: 1,
      widthPixels: 800,
      heightPixels: 1_120,
      previewDerivativeId: previewId
    }
  });

  for (const [key, body, contentType] of [
    [quarantineKey, "%PDF-1.7 original", "application/pdf"],
    [normalizedKey, "%PDF-1.7 normalized", "application/pdf"],
    [previewKey, "RIFF0000WEBPpreview", "image/webp"]
  ] as const) {
    await writerFor(key).send(
      new PutObjectCommand({
        Bucket: environment.S3_BUCKET,
        Key: key,
        Body: Buffer.from(body),
        ContentType: contentType
      })
    );
  }

  return { sessionId: session.id, clientId, fileId, version: session.version };
}

async function cancelSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
  version: number
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/sessions/${sessionId}/cancel`,
    headers: {
      authorization,
      "idempotency-key": randomUUID(),
      "if-match": `"${version}"`
    },
    payload: { reason: "CUSTOMER_CANCELED" }
  });
  expect(response.statusCode).toBe(200);
}

async function listSessionObjects(sessionId: string): Promise<string[]> {
  const keys: string[] = [];
  for (const root of SESSION_OBJECT_ROOTS) {
    let continuationToken: string | undefined;
    do {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: environment.S3_BUCKET,
          Prefix: `${root}${sessionId}/`,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {})
        })
      );
      for (const object of listed.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }
  return keys.sort();
}

async function resetFixtures(): Promise<void> {
  const sessions = await database.printSession.findMany({
    where: { kioskId },
    select: { id: true }
  });
  const sessionIds = sessions.map((session) => session.id);
  for (const sessionId of sessionIds) createdSessionIds.add(sessionId);
  if (createdSessionIds.size === 0) return;

  const ids = [...createdSessionIds];
  for (const sessionId of ids) {
    for (const root of SESSION_OBJECT_ROOTS) {
      await documentStore.purgePrefix(`${root}${sessionId}/`).catch(() => undefined);
      await documentStore.abortMultipartUploads([`${root}${sessionId}/`]).catch(() => undefined);
    }
  }

  await database.cleanupRun.deleteMany({ where: { sessionId: { in: ids } } });
  await database.filePage.deleteMany({ where: { file: { sessionId: { in: ids } } } });
  await database.fileDerivative.deleteMany({ where: { file: { sessionId: { in: ids } } } });
  await database.uploadedFile.deleteMany({ where: { sessionId: { in: ids } } });
  await database.sessionUploadGrant.deleteMany({ where: { sessionId: { in: ids } } });
  await database.mobileClient.deleteMany({ where: { sessionId: { in: ids } } });
  // Audit events are append-only and are deliberately not cleaned up: the
  // log outlives the rows it describes, which is the point of it.
  await database.sessionEvent.deleteMany({ where: { sessionId: { in: ids } } });
  await database.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await database.printSession.deleteMany({ where: { id: { in: ids } } });
  await database.idempotencyRecord.deleteMany({ where: { actorId: kioskId } });
  createdSessionIds.clear();
}
