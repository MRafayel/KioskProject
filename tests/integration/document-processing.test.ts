import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { Readable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import { createSessionResponseSchema } from "../../packages/contracts/src/sessions.js";
import {
  filePagesResponseSchema,
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

const kioskId = "kiosk_phase5_integration_001";
const kioskCredentialId = "phase5-integration-kiosk-credential";
const kioskApiKey = "phase5-integration-kiosk-key-000001";
const foreignKioskId = "kiosk_phase5_integration_foreign";
const foreignCredentialId = "phase5-integration-foreign-credential";
const foreignApiKey = "phase5-integration-foreign-key-000001";
const syntheticJpeg = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYn" +
    "KSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAGAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAA" +
    "AAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAA" +
    "AAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJwDAl//2Q==",
  "base64"
);
const syntheticPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAYAAAD+Bd/7AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklE" +
    "QVQImWNIaFjwHx9mGAoKACkwd9GtdPlGAAAAAElFTkSuQmCC",
  "base64"
);

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
// Integration tests import workspace source directly, while services resolve
// the built database package. Both clients are generated from the same schema.
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
const processingLogs: Array<Record<string, string | number | boolean>> = [];
const logger = {
  info: (fields: Record<string, unknown>, message: string) =>
    recordProcessingLog("info", fields, message),
  warn: (fields: Record<string, unknown>, message: string) =>
    recordProcessingLog("warn", fields, message),
  error: (fields: Record<string, unknown>, message: string) =>
    recordProcessingLog("error", fields, message)
};

let app: Awaited<ReturnType<typeof buildApp>>;
let coordinator: DocumentProcessingCoordinator;
let janitor: FileJanitor;
let databaseReachable = false;

beforeAll(async () => {
  await assertPhase5Infrastructure();
  await cleanPhase5Fixtures();
  await Promise.all([
    upsertKiosk({
      id: kioskId,
      publicCode: "PHASE5-INTEGRATION",
      name: "Phase 5 integration kiosk"
    }),
    upsertKiosk({
      id: foreignKioskId,
      publicCode: "PHASE5-FOREIGN",
      name: "Phase 5 foreign kiosk"
    })
  ]);
  await Promise.all([
    upsertCredential({
      id: "01900000-0000-7000-8000-000000000501",
      kioskId,
      credentialId: kioskCredentialId,
      rawCredential: kioskApiKey
    }),
    upsertCredential({
      id: "01900000-0000-7000-8000-000000000502",
      kioskId: foreignKioskId,
      credentialId: foreignCredentialId,
      rawCredential: foreignApiKey
    })
  ]);

  app = await buildApp({
    environment,
    database: serviceDatabase,
    objectStore: apiObjectStore,
    // Every scenario performs a phone handoff from the same loopback address,
    // so the production per-IP ceiling of 8 per minute throttles the suite
    // rather than the code under test. This only became visible once document
    // processing got fast enough to run the whole file inside one window.
    maxMobileExchangesPerMinute: 1_000,
    // Same reasoning one step earlier: every scenario opens its session through
    // the one integration credential, and this file shares a single app, so the
    // per-credential ceiling counts the whole suite against one allowance.
    maxSessionsPerMinute: 1_000
  });
  await mkdir(environment.DOCUMENT_PROCESSOR_SCRATCH_DIR, {
    recursive: true,
    mode: 0o700
  });
  coordinator = new DocumentProcessingCoordinator({
    database: serviceDatabase,
    redisUrl: environment.REDIS_URL,
    store: workerStore,
    processor,
    logger,
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
    await cleanPhase5Fixtures();
    await database.kioskCredential.deleteMany({
      where: { credentialId: { in: [kioskCredentialId, foreignCredentialId] } }
    });
    await database.kiosk.deleteMany({ where: { id: { in: [kioskId, foreignKioskId] } } });
  }
  await database.$disconnect();
}, 180_000);

beforeEach(async () => {
  processingLogs.length = 0;
  await cleanPhase5Fixtures();
}, 180_000);

describe.sequential("Phase 5 real document-processing pipeline", () => {
  it("uploads, validates, previews with ownership checks, and securely deletes a synthetic PDF", async () => {
    const { created, mobile } = await createMobileSession("phase5-create-session");

    const uploadedResponse = await uploadPdf({
      sessionId: created.session.id,
      cookieHeader: mobile.cookieHeader,
      csrfToken: mobile.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000512",
      idempotencyKey: "phase5-upload-synthetic-pdf",
      contents: createSyntheticPdf()
    });
    expect(uploadedResponse.statusCode, uploadedResponse.body).toBe(202);
    const uploaded = uploadFileResponseSchema.parse(uploadedResponse.json());
    expect(uploaded.file).toMatchObject({
      status: "QUARANTINED",
      processingRevision: 1,
      pageCount: null,
      rejectionCode: null
    });

    await coordinator.dispatchOnce();
    const ready = await waitForReadyFile(uploaded.file.id);
    expect(ready).toMatchObject({
      status: "READY",
      pageCount: 1,
      malwareScanStatus: "CLEAN",
      processingRevision: 1,
      rejectionCode: null,
      processingClaimToken: null,
      processingLeaseExpiresAt: null,
      processingErrorCode: null
    });
    const readyEvents = await database.outboxEvent.findMany({
      where: {
        aggregateId: created.session.id,
        type: "file.ready"
      }
    });
    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0]?.payload).toMatchObject({
      sessionId: created.session.id,
      file: {
        id: ready.id,
        status: "READY",
        pageCount: 1,
        processingRevision: 1
      }
    });
    expect(JSON.stringify(readyEvents[0]?.payload)).not.toContain("objectKey");
    expect(JSON.stringify(readyEvents[0]?.payload)).not.toContain(ready.contentSha256 ?? "absent");

    const derivatives = await database.fileDerivative.findMany({
      where: { fileId: ready.id },
      orderBy: [{ pageNumber: "asc" }, { type: "asc" }]
    });
    expect(derivatives).toHaveLength(3);
    expect(derivatives.every((derivative) => derivative.status === "AVAILABLE")).toBe(true);
    expect(derivatives.map((derivative) => derivative.type).sort()).toEqual([
      "NORMALIZED_PDF",
      "ORIGINAL",
      "PAGE_PREVIEW"
    ]);
    const previewDerivative = derivatives.find((derivative) => derivative.type === "PAGE_PREVIEW");
    if (!previewDerivative) throw new Error("PHASE5_PREVIEW_DERIVATIVE_MISSING");
    const storedObjectKeys = [
      ...new Set([
        ...(ready.quarantineObjectKey ? [ready.quarantineObjectKey] : []),
        ...derivatives.map((derivative) => derivative.objectKey)
      ])
    ];
    expect(storedObjectKeys).toHaveLength(3);
    for (const objectKey of storedObjectKeys) {
      await expect(workerStore.hasObject(objectKey)).resolves.toBe(true);
    }

    const pagesResponse = await app.inject({
      method: "GET",
      url: `/v1/sessions/${created.session.id}/files/${ready.id}/pages`,
      headers: { authorization }
    });
    expect(pagesResponse.statusCode).toBe(200);
    expect(pagesResponse.headers["cache-control"]).toBe("no-store");
    expect(filePagesResponseSchema.parse(pagesResponse.json())).toEqual({
      fileId: ready.id,
      processingRevision: 1,
      pageCount: 1,
      items: [
        {
          pageNumber: 1,
          widthPixels: expect.any(Number),
          heightPixels: expect.any(Number),
          previewAvailable: true
        }
      ]
    });
    const unauthenticatedPages = await app.inject({
      method: "GET",
      url: `/v1/sessions/${created.session.id}/files/${ready.id}/pages`
    });
    expect(unauthenticatedPages.statusCode).toBe(401);
    const foreignPages = await app.inject({
      method: "GET",
      url: `/v1/sessions/${created.session.id}/files/${ready.id}/pages`,
      headers: { authorization: foreignAuthorization }
    });
    expect(foreignPages.statusCode).toBe(404);
    expect(foreignPages.json()).toMatchObject({ error: { code: "FILE_NOT_FOUND" } });

    const previewUrl =
      `/v1/sessions/${created.session.id}/files/${ready.id}` +
      `/pages/1/preview?revision=${ready.processingRevision}`;
    const previewResponse = await app.inject({
      method: "GET",
      url: previewUrl,
      headers: { authorization }
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers["content-type"]).toBe("image/webp");
    expect(previewResponse.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(previewResponse.headers["x-content-type-options"]).toBe("nosniff");
    expect(previewResponse.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(previewResponse.rawPayload.subarray(8, 12).toString("ascii")).toBe("WEBP");

    const unauthenticatedPreview = await app.inject({ method: "GET", url: previewUrl });
    expect(unauthenticatedPreview.statusCode).toBe(401);
    expect(unauthenticatedPreview.json()).toMatchObject({
      error: { code: "INVALID_KIOSK_CREDENTIAL" }
    });

    const mobileOnlyPreview = await app.inject({
      method: "GET",
      url: previewUrl,
      headers: { cookie: mobile.cookieHeader }
    });
    expect(mobileOnlyPreview.statusCode).toBe(401);

    const foreignPreview = await app.inject({
      method: "GET",
      url: previewUrl,
      headers: { authorization: foreignAuthorization }
    });
    expect(foreignPreview.statusCode).toBe(404);
    expect(foreignPreview.json()).toMatchObject({ error: { code: "FILE_NOT_FOUND" } });

    const staleRevisionPreview = await app.inject({
      method: "GET",
      url: previewUrl.replace("revision=1", "revision=2"),
      headers: { authorization }
    });
    expect(staleRevisionPreview.statusCode).toBe(404);

    const originalPreview = Buffer.from(previewResponse.rawPayload);
    const replacedPreview = Buffer.from(originalPreview);
    replacedPreview.writeUInt8((replacedPreview.at(-1) ?? 0) ^ 0xff, replacedPreview.length - 1);
    await workerStore.putArtifact({
      key: previewDerivative.objectKey,
      body: Readable.from([replacedPreview]),
      contentLength: replacedPreview.byteLength,
      contentType: "image/webp"
    });
    try {
      const corruptedPreview = await app.inject({
        method: "GET",
        url: previewUrl,
        headers: { authorization }
      });
      expect(corruptedPreview.statusCode).toBe(503);
      expect(corruptedPreview.json()).toMatchObject({
        error: { code: "PREVIEW_UNAVAILABLE" }
      });
    } finally {
      await workerStore.putArtifact({
        key: previewDerivative.objectKey,
        body: Readable.from([originalPreview]),
        contentLength: originalPreview.byteLength,
        contentType: "image/webp"
      });
    }

    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${created.session.id}/files/${ready.id}`,
      headers: {
        authorization,
        "idempotency-key": "phase5-delete-ready-file"
      }
    });
    expect(deleted.statusCode).toBe(204);
    await expect(
      database.uploadedFile.findUniqueOrThrow({ where: { id: ready.id } })
    ).resolves.toMatchObject({
      status: "DELETED",
      quarantineObjectKey: null,
      contentSha256: null,
      pageCount: null
    });
    await expect(database.filePage.count({ where: { fileId: ready.id } })).resolves.toBe(0);
    await expect(database.fileDerivative.count({ where: { fileId: ready.id } })).resolves.toBe(0);
    expect(
      (
        await app.inject({
          method: "GET",
          url: previewUrl,
          headers: { authorization }
        })
      ).statusCode
    ).toBe(404);
    for (const objectKey of storedObjectKeys) {
      await expect(workerStore.hasObject(objectKey)).resolves.toBe(false);
    }

    const deleteReplay = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${created.session.id}/files/${ready.id}`,
      headers: {
        authorization,
        "idempotency-key": "phase5-delete-ready-file"
      }
    });
    expect(deleteReplay.statusCode).toBe(204);
    await expect(
      database.outboxEvent.count({
        where: {
          aggregateId: created.session.id,
          type: "file.deleted"
        }
      })
    ).resolves.toBe(1);
  }, 180_000);

  it.each([
    {
      kind: "JPEG" as const,
      mime: "image/jpeg",
      filename: "receipt;$(touch-pwned)&private.jpeg",
      contents: syntheticJpeg,
      clientFileId: "01900000-0000-7000-8000-000000000515",
      idempotencyKey: "phase5-upload-real-jpeg"
    },
    {
      kind: "PNG" as const,
      mime: "image/png",
      filename: "diagram [private] & draft.png",
      contents: syntheticPng,
      clientFileId: "01900000-0000-7000-8000-000000000516",
      idempotencyKey: "phase5-upload-real-png"
    }
  ])(
    "normalizes real $kind bytes without persisting or executing the customer filename",
    async (fixture) => {
      const { created, mobile } = await createMobileSession(
        `phase5-create-${fixture.kind.toLowerCase()}-session`
      );
      const response = await uploadDocument({
        sessionId: created.session.id,
        cookieHeader: mobile.cookieHeader,
        csrfToken: mobile.csrfToken,
        clientFileId: fixture.clientFileId,
        idempotencyKey: fixture.idempotencyKey,
        filename: fixture.filename,
        mime: fixture.mime,
        contents: fixture.contents
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.body).not.toContain(fixture.filename);
      const upload = uploadFileResponseSchema.parse(response.json());
      expect(upload.file).toMatchObject({
        status: "QUARANTINED",
        kind: fixture.kind,
        sizeBytes: fixture.contents.byteLength
      });

      await coordinator.dispatchOnce();
      const ready = await waitForReadyFile(upload.file.id);
      expect(ready).toMatchObject({
        status: "READY",
        kind: fixture.kind,
        pageCount: 1,
        malwareScanStatus: "CLEAN"
      });
      expect(JSON.stringify(ready)).not.toContain(fixture.filename);
      expect(JSON.stringify(processingLogs)).not.toContain(fixture.filename);
      await expect(
        database.fileDerivative.count({
          where: { fileId: ready.id, status: "AVAILABLE" }
        })
      ).resolves.toBe(3);
      await expect(database.filePage.count({ where: { fileId: ready.id } })).resolves.toBe(1);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/v1/sessions/${created.session.id}/files/${ready.id}`,
        headers: {
          authorization,
          "idempotency-key": `phase5-delete-${fixture.kind.toLowerCase()}`
        }
      });
      expect(deleted.statusCode).toBe(204);
    },
    180_000
  );

  it.each([
    {
      label: "two-page PDF",
      pageCount: 2,
      contents: createMultiPagePdf(2),
      clientFileId: "01900000-0000-7000-8000-000000000521",
      idempotencyKey: "phase5-upload-two-page-pdf"
    },
    {
      label: "five-page PDF",
      pageCount: 5,
      contents: createMultiPagePdf(5),
      clientFileId: "01900000-0000-7000-8000-000000000522",
      idempotencyKey: "phase5-upload-five-page-pdf"
    },
    {
      label: "twelve-page PDF",
      pageCount: 12,
      contents: createMultiPagePdf(12),
      clientFileId: "01900000-0000-7000-8000-000000000523",
      idempotencyKey: "phase5-upload-twelve-page-pdf"
    },
    {
      label: "three-page PDF whose cross-reference table qpdf must rebuild",
      pageCount: 3,
      contents: createRecoverableXrefPdf(3),
      clientFileId: "01900000-0000-7000-8000-000000000524",
      idempotencyKey: "phase5-upload-recoverable-xref-pdf"
    }
  ])(
    "accepts a real $label and produces one preview per page",
    async (fixture) => {
      const { created, mobile } = await createMobileSession(`${fixture.idempotencyKey}-session`);
      const response = await uploadPdf({
        sessionId: created.session.id,
        cookieHeader: mobile.cookieHeader,
        csrfToken: mobile.csrfToken,
        clientFileId: fixture.clientFileId,
        idempotencyKey: fixture.idempotencyKey,
        contents: fixture.contents
      });
      expect(response.statusCode, response.body).toBe(202);
      const upload = uploadFileResponseSchema.parse(response.json());

      await coordinator.dispatchOnce();
      const ready = await waitForReadyFile(upload.file.id);
      expect(ready).toMatchObject({
        status: "READY",
        kind: "PDF",
        pageCount: fixture.pageCount,
        malwareScanStatus: "CLEAN",
        rejectionCode: null,
        processingErrorCode: null
      });

      const derivatives = await database.fileDerivative.findMany({
        where: { fileId: ready.id },
        orderBy: [{ type: "asc" }, { pageNumber: "asc" }]
      });
      expect(derivatives).toHaveLength(fixture.pageCount + 2);
      expect(derivatives.every((derivative) => derivative.status === "AVAILABLE")).toBe(true);
      expect(
        derivatives
          .filter((derivative) => derivative.type === "PAGE_PREVIEW")
          .map((derivative) => derivative.pageNumber)
      ).toEqual(Array.from({ length: fixture.pageCount }, (_, index) => index + 1));
      for (const derivative of derivatives) {
        await expect(workerStore.hasObject(derivative.objectKey)).resolves.toBe(true);
      }

      const pages = await database.filePage.findMany({
        where: { fileId: ready.id },
        orderBy: { pageNumber: "asc" }
      });
      expect(pages.map((page) => page.pageNumber)).toEqual(
        Array.from({ length: fixture.pageCount }, (_, index) => index + 1)
      );

      const pagesResponse = await app.inject({
        method: "GET",
        url: `/v1/sessions/${created.session.id}/files/${ready.id}/pages`,
        headers: { authorization }
      });
      expect(pagesResponse.statusCode, pagesResponse.body).toBe(200);
      const metadata = filePagesResponseSchema.parse(pagesResponse.json());
      expect(metadata.pageCount).toBe(fixture.pageCount);
      expect(metadata.items.every((page) => page.previewAvailable)).toBe(true);

      for (let pageNumber = 1; pageNumber <= fixture.pageCount; pageNumber += 1) {
        const preview = await app.inject({
          method: "GET",
          url:
            `/v1/sessions/${created.session.id}/files/${ready.id}` +
            `/pages/${pageNumber}/preview?revision=${ready.processingRevision}`,
          headers: { authorization }
        });
        expect(preview.statusCode, `page ${pageNumber}`).toBe(200);
        expect(preview.headers["content-type"]).toBe("image/webp");
        expect(preview.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF");
        expect(preview.rawPayload.subarray(8, 12).toString("ascii")).toBe("WEBP");
      }

      await expect(listWorkerScratchDirectories()).resolves.toEqual([]);
    },
    180_000
  );

  it("keeps concurrent same-filename uploads on separate object keys", async () => {
    const contents = createMultiPagePdf(2);
    const first = await createMobileSession("phase5-concurrent-first-session");
    const second = await createMobileSession("phase5-concurrent-second-session", foreignKioskId);

    const [firstResponse, secondResponse] = await Promise.all([
      uploadPdf({
        sessionId: first.created.session.id,
        cookieHeader: first.mobile.cookieHeader,
        csrfToken: first.mobile.csrfToken,
        clientFileId: "01900000-0000-7000-8000-000000000531",
        idempotencyKey: "phase5-concurrent-first-upload",
        contents
      }),
      uploadPdf({
        sessionId: second.created.session.id,
        cookieHeader: second.mobile.cookieHeader,
        csrfToken: second.mobile.csrfToken,
        clientFileId: "01900000-0000-7000-8000-000000000532",
        idempotencyKey: "phase5-concurrent-second-upload",
        contents
      })
    ]);
    expect(firstResponse.statusCode, firstResponse.body).toBe(202);
    expect(secondResponse.statusCode, secondResponse.body).toBe(202);
    const uploads = [
      uploadFileResponseSchema.parse(firstResponse.json()).file,
      uploadFileResponseSchema.parse(secondResponse.json()).file
    ];

    await coordinator.dispatchOnce();
    const readyFiles = [];
    for (const upload of uploads) {
      await coordinator.dispatchOnce();
      readyFiles.push(await waitForReadyFile(upload.id));
    }
    expect(readyFiles.every((file) => file.pageCount === 2)).toBe(true);

    const objectKeys = await database.fileDerivative.findMany({
      where: { fileId: { in: uploads.map((upload) => upload.id) } },
      select: { objectKey: true }
    });
    expect(new Set(objectKeys.map((entry) => entry.objectKey)).size).toBe(objectKeys.length);
    expect(objectKeys).toHaveLength(8);
    await expect(listWorkerScratchDirectories()).resolves.toEqual([]);
  }, 180_000);

  it.each([
    {
      label: "password-protected PDF",
      contents: createEncryptedPdf(),
      expectedRejection: "DOCUMENT_ENCRYPTED",
      clientFileId: "01900000-0000-7000-8000-000000000517",
      idempotencyKey: "phase5-upload-encrypted-pdf"
    },
    {
      label: "truncated PDF",
      contents: createTruncatedPdf(),
      expectedRejection: "DOCUMENT_MALFORMED",
      clientFileId: "01900000-0000-7000-8000-000000000518",
      idempotencyKey: "phase5-upload-truncated-pdf"
    },
    {
      label: "PDF exceeding the page limit",
      contents: createManyPagePdf(environment.MAX_DOCUMENT_PAGES + 1),
      expectedRejection: "PAGE_LIMIT_EXCEEDED",
      clientFileId: "01900000-0000-7000-8000-000000000519",
      idempotencyKey: "phase5-upload-page-limit-pdf"
    }
  ])(
    "rejects a real $label and deletes all quarantined bytes",
    async (fixture) => {
      const { created, mobile } = await createMobileSession(fixture.idempotencyKey + "-session");
      const response = await uploadPdf({
        sessionId: created.session.id,
        cookieHeader: mobile.cookieHeader,
        csrfToken: mobile.csrfToken,
        clientFileId: fixture.clientFileId,
        idempotencyKey: fixture.idempotencyKey,
        contents: fixture.contents
      });
      expect(response.statusCode, response.body).toBe(202);
      const upload = uploadFileResponseSchema.parse(response.json());
      const stored = await database.uploadedFile.findUniqueOrThrow({
        where: { id: upload.file.id }
      });
      if (!stored.quarantineObjectKey) throw new Error("PHASE5_REJECTION_OBJECT_KEY_MISSING");

      await coordinator.dispatchOnce();
      await waitForCleanupPendingFile(stored.id);
      await janitor.runOnce();
      const rejected = await waitForRejectedFile(stored.id);
      expect(rejected).toMatchObject({
        status: "REJECTED",
        rejectionCode: fixture.expectedRejection,
        quarantineObjectKey: null,
        contentSha256: null,
        pageCount: null
      });
      await expect(workerStore.hasObject(stored.quarantineObjectKey)).resolves.toBe(false);
      await expect(database.fileDerivative.count({ where: { fileId: stored.id } })).resolves.toBe(
        0
      );
      await expect(listWorkerScratchDirectories()).resolves.toEqual([]);
    },
    180_000
  );

  it.each([
    {
      label: "empty file",
      filename: "empty.pdf",
      mime: "application/pdf",
      contents: Buffer.alloc(0),
      expectedStatus: 400,
      expectedCode: "EMPTY_FILE",
      clientFileId: "01900000-0000-7000-8000-000000000541",
      idempotencyKey: "phase5-upload-empty-file"
    },
    {
      label: "executable renamed with a .pdf extension",
      filename: "payload.pdf",
      mime: "application/pdf",
      contents: Buffer.from("MZ not a document at all", "latin1"),
      expectedStatus: 415,
      expectedCode: "FILE_SIGNATURE_MISMATCH",
      clientFileId: "01900000-0000-7000-8000-000000000542",
      idempotencyKey: "phase5-upload-renamed-executable"
    },
    {
      label: "PDF body declared as an unsupported media type",
      filename: "document.pdf",
      mime: "application/x-pdf",
      contents: createMultiPagePdf(2),
      expectedStatus: 415,
      expectedCode: "UNSUPPORTED_MEDIA_TYPE",
      clientFileId: "01900000-0000-7000-8000-000000000543",
      idempotencyKey: "phase5-upload-wrong-mime"
    },
    {
      label: "PDF body declared as a PNG",
      filename: "document.png",
      mime: "image/png",
      contents: createMultiPagePdf(2),
      expectedStatus: 415,
      expectedCode: "FILE_SIGNATURE_MISMATCH",
      clientFileId: "01900000-0000-7000-8000-000000000544",
      idempotencyKey: "phase5-upload-mismatched-signature"
    }
  ])(
    "refuses a $label at the upload boundary without creating a stored object",
    async (fixture) => {
      const { created, mobile } = await createMobileSession(`${fixture.idempotencyKey}-session`);
      const response = await uploadDocument({
        sessionId: created.session.id,
        cookieHeader: mobile.cookieHeader,
        csrfToken: mobile.csrfToken,
        clientFileId: fixture.clientFileId,
        idempotencyKey: fixture.idempotencyKey,
        filename: fixture.filename,
        mime: fixture.mime,
        contents: fixture.contents
      });
      expect(response.statusCode, response.body).toBe(fixture.expectedStatus);
      expect(response.json()).toMatchObject({ error: { code: fixture.expectedCode } });
      expect(response.body).not.toContain(fixture.filename);

      const readyFiles = await database.uploadedFile.count({
        where: { sessionId: created.session.id, status: "READY" }
      });
      expect(readyFiles).toBe(0);
    },
    180_000
  );

  it("rejects a malformed PDF only after its quarantined bytes are removed", async () => {
    const { created, mobile } = await createMobileSession("phase5-create-malformed-session");
    const malformedUploadResponse = await uploadPdf({
      sessionId: created.session.id,
      cookieHeader: mobile.cookieHeader,
      csrfToken: mobile.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000513",
      idempotencyKey: "phase5-upload-malformed-pdf",
      contents: Buffer.from("%PDF-1.4\nsynthetic malformed document\n%%EOF\n", "ascii")
    });
    expect(malformedUploadResponse.statusCode).toBe(202);
    const malformedUpload = uploadFileResponseSchema.parse(malformedUploadResponse.json());
    const malformedBeforeCleanup = await database.uploadedFile.findUniqueOrThrow({
      where: { id: malformedUpload.file.id }
    });
    const malformedObjectKey = malformedBeforeCleanup.quarantineObjectKey;
    if (!malformedObjectKey) throw new Error("PHASE5_MALFORMED_OBJECT_KEY_MISSING");

    await coordinator.dispatchOnce();
    await waitForCleanupPendingFile(malformedUpload.file.id);
    await janitor.runOnce();
    const rejected = await waitForRejectedFile(malformedUpload.file.id);
    expect(rejected).toMatchObject({
      status: "REJECTED",
      rejectionCode: "DOCUMENT_MALFORMED",
      quarantineObjectKey: null,
      contentSha256: null,
      pageCount: null
    });
    await expect(
      database.fileDerivative.count({ where: { fileId: malformedUpload.file.id } })
    ).resolves.toBe(0);
    await expect(workerStore.hasObject(malformedObjectKey)).resolves.toBe(false);
    await expect(
      database.outboxEvent.count({
        where: {
          aggregateId: created.session.id,
          type: "file.rejected"
        }
      })
    ).resolves.toBe(1);
  }, 180_000);

  it("detects an embedded antivirus fixture before parsing and removes its bytes", async () => {
    const { created, mobile } = await createMobileSession("phase5-create-malware-session");
    const malwareUploadResponse = await uploadPdf({
      sessionId: created.session.id,
      cookieHeader: mobile.cookieHeader,
      csrfToken: mobile.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000514",
      idempotencyKey: "phase5-upload-eicar-pdf",
      contents: createEicarTestPdf()
    });
    expect(malwareUploadResponse.statusCode).toBe(202);
    const malwareUpload = uploadFileResponseSchema.parse(malwareUploadResponse.json());
    const malwareBeforeCleanup = await database.uploadedFile.findUniqueOrThrow({
      where: { id: malwareUpload.file.id }
    });
    const malwareObjectKey = malwareBeforeCleanup.quarantineObjectKey;
    if (!malwareObjectKey) throw new Error("PHASE5_MALWARE_OBJECT_KEY_MISSING");

    await coordinator.dispatchOnce();
    await waitForCleanupPendingFile(malwareUpload.file.id);
    await janitor.runOnce();
    const malwareRejected = await waitForRejectedFile(malwareUpload.file.id);
    expect(malwareRejected).toMatchObject({
      status: "REJECTED",
      rejectionCode: "MALWARE_DETECTED",
      malwareScanStatus: "INFECTED",
      quarantineObjectKey: null,
      contentSha256: null,
      pageCount: null
    });
    await expect(workerStore.hasObject(malwareObjectKey)).resolves.toBe(false);
    await expect(
      database.fileDerivative.count({ where: { fileId: malwareUpload.file.id } })
    ).resolves.toBe(0);
    await expect(
      database.outboxEvent.count({
        where: {
          aggregateId: created.session.id,
          type: "file.rejected"
        }
      })
    ).resolves.toBe(1);
  }, 180_000);
});

async function createMobileSession(idempotencyKey: string, targetKioskId: string = kioskId) {
  const createdResponse = await app.inject({
    method: "POST",
    url: `/v1/kiosks/${targetKioskId}/sessions`,
    headers: {
      authorization: targetKioskId === kioskId ? authorization : foreignAuthorization,
      "idempotency-key": idempotencyKey
    },
    payload: { locale: "hy" }
  });
  expect(createdResponse.statusCode, createdResponse.body).toBe(201);
  const created = createSessionResponseSchema.parse(createdResponse.json());
  const mobile = await exchangeMobile(
    created.session.publicId,
    requireUploadToken(created.upload.qrUrl)
  );
  return { created, mobile };
}

/**
 * Response archives are staged in this directory and must be removed on both
 * the success and the failure path. A leftover directory means a customer
 * document survived in worker scratch space.
 */
async function listWorkerScratchDirectories(): Promise<string[]> {
  const entries = await readdir(environment.DOCUMENT_PROCESSOR_SCRATCH_DIR, {
    withFileTypes: true
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("processor-response-"))
    .map((entry) => entry.name);
}

async function assertPhase5Infrastructure(): Promise<void> {
  try {
    await database.$queryRaw`SELECT 1`;
    databaseReachable = true;
  } catch (error) {
    throw new Error(
      `PHASE5_DATABASE_NOT_READY: run pnpm infra:up and pnpm db:migrate (${safeMessage(error)})`
    );
  }

  try {
    await Promise.all([apiObjectStore.checkReady(), workerStore.checkReady()]);
  } catch (error) {
    throw new Error(
      `PHASE5_OBJECT_STORAGE_NOT_READY: run pnpm infra:up and wait for minio-init (${safeMessage(error)})`
    );
  }

  let response: Response;
  try {
    response = await fetch(new URL("/health/ready", environment.DOCUMENT_PROCESSOR_URL), {
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new Error(
      `PHASE5_PROCESSOR_UNREACHABLE: run pnpm infra:up and wait for ClamAV/document-processor (${safeMessage(error)})`
    );
  }
  if (!response.ok) {
    throw new Error(`PHASE5_PROCESSOR_NOT_READY: ${response.status}; inspect pnpm infra:logs`);
  }
}

async function upsertKiosk(input: { id: string; publicCode: string; name: string }): Promise<void> {
  await database.kiosk.upsert({
    where: { id: input.id },
    create: {
      ...input,
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
    "files:delete"
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

async function exchangeMobile(publicSessionId: string, uploadToken: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/mobile-auth/exchange",
    headers: { origin: environment.UPLOAD_ORIGIN },
    payload: {
      publicSessionId,
      uploadToken,
      clientNonce: "01900000-0000-7000-8000-000000000511"
    }
  });
  expect(response.statusCode).toBe(200);
  const context = mobileContextResponseSchema.parse(response.json());
  const setCookieHeader = response.headers["set-cookie"];
  const setCookie = Array.isArray(setCookieHeader)
    ? (setCookieHeader[0] ?? "")
    : (setCookieHeader ?? "");
  const cookieHeader = setCookie.split(";", 1)[0] ?? "";
  if (!cookieHeader) throw new Error("PHASE5_MOBILE_COOKIE_MISSING");
  return {
    cookieHeader,
    csrfToken: context.csrfToken
  };
}

function uploadPdf(input: {
  sessionId: string;
  cookieHeader: string;
  csrfToken: string;
  clientFileId: string;
  idempotencyKey: string;
  contents: Buffer;
}) {
  return uploadDocument({
    ...input,
    filename: "synthetic-phase5.pdf",
    mime: "application/pdf"
  });
}

function uploadDocument(input: {
  sessionId: string;
  cookieHeader: string;
  csrfToken: string;
  clientFileId: string;
  idempotencyKey: string;
  filename: string;
  mime: string;
  contents: Buffer;
}) {
  const boundary = "phase5-synthetic-document-boundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${input.filename}"\r\n` +
        `Content-Type: ${input.mime}\r\n\r\n`,
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

function createSyntheticPdf(): Buffer {
  const stream = "BT /F1 20 Tf 72 720 Td (Synthetic Phase 5 document) Tj ET\n";
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`
  ]);
}

function createTruncatedPdf(): Buffer {
  const complete = createSyntheticPdf();
  return complete.subarray(0, complete.byteLength - 48);
}

function createManyPagePdf(pageCount: number): Buffer {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error("PHASE5_INVALID_SYNTHETIC_PAGE_COUNT");
  }
  const firstPageObjectNumber = 3;
  const pageObjectNumbers = Array.from(
    { length: pageCount },
    (_, index) => firstPageObjectNumber + index
  );
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] ` +
      `/Count ${pageCount} >>`,
    ...pageObjectNumbers.map(() => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>")
  ]);
}

/**
 * Every page carries real content so the rasterize, normalize, preview and
 * canonical-append loop runs once per page instead of short-circuiting on an
 * empty page tree.
 */
function createMultiPagePdf(pageCount: number, options?: { corruptXrefOffsets: boolean }): Buffer {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error("PHASE5_INVALID_SYNTHETIC_PAGE_COUNT");
  }
  const fontObjectNumber = 3 + pageCount * 2;
  const pageObjectNumbers = Array.from({ length: pageCount }, (_, index) => 3 + index * 2);
  const pageObjects = pageObjectNumbers.flatMap((pageObjectNumber, index) => {
    const stream = `BT /F1 24 Tf 72 720 Td (Synthetic Phase 5 page ${index + 1}) Tj ET\n`;
    return [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> ` +
        `/Contents ${pageObjectNumber + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`
    ];
  });
  return buildPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] ` +
        `/Count ${pageCount} >>`,
      ...pageObjects,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ],
    options
  );
}

/**
 * A readable document whose cross-reference offsets are all wrong. qpdf rebuilds
 * the table and exits 3 (warnings); Poppler renders every page. Treating that
 * exit code as corruption used to reject valid multi-page documents.
 */
function createRecoverableXrefPdf(pageCount: number): Buffer {
  return createMultiPagePdf(pageCount, { corruptXrefOffsets: true });
}

function createEncryptedPdf(): Buffer {
  // Generated from a three-object synthetic PDF with qpdf 11 using AES-256.
  // The password is deliberately non-secret; this fixture tests rejection only.
  return Buffer.from(
    "JVBERi0xLjcKJb/3ov4KMSAwIG9iago8PCAvRXh0ZW5zaW9ucyA8PCAvQURCRSA8PCAvQmFzZVZlcnNpb24gLzEuNyAvRXh0ZW5zaW9uTGV2ZWwgOCA+PiA+PiAvUGFnZXMgMiAwIFIgL1R5cGUgL0NhdGFsb2cgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcyA+PgplbmRvYmoKMyAwIG9iago8PCAvTWVkaWFCb3ggWyAwIDAgNTk1IDg0MiBdIC9QYXJlbnQgMiAwIFIgL1R5cGUgL1BhZ2UgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0NGIDw8IC9TdGRDRiA8PCAvQXV0aEV2ZW50IC9Eb2NPcGVuIC9DRk0gL0FFU1YzIC9MZW5ndGggMzIgPj4gPj4gL0ZpbHRlciAvU3RhbmRhcmQgL0xlbmd0aCAyNTYgL08gPDcyMzAyMGNlMzgxZTExN2ZiMDJhNTc1ZWY3YzljNzgwMDE2MzJhMGY4YTQxZDQ5NTZmYjI4NTJlNjg0MWU4ODdjNWY2MmMxOWUyMjkzNzI3YzI1OTdmNzQzNjc5Njc3Yj4gL09FIDw3Y2U3NWE4NGUzMjE1MzkwNWE3ZjA2MzRjMTg0OWQ4ZGI0OTY5YmE3NDZhNmM1YTI0Y2M3MThiNzdlMDA0OTM0PiAvUCAtNCAvUGVybXMgPDcyNDhhZmY1MGU4YTJlYWQ5MTY3NTIxOTc2OTJmM2Q5PiAvUiA2IC9TdG1GIC9TdGRDRiAvU3RyRiAvU3RkQ0YgL1UgPDg2OTIyMzc5MjVjZjBkOTg2NTg5MzY4ZWY2NGM5M2JmMjQ1YjkyMmZjMDA3YjdhMmVjMzhkMTA2ZGVmNjRjOWY4ZTZmNDQ4ZmI1NDhkMmQ3ZTRjNDYwMzZmNjE2Yjg5Nj4gL1VFIDw5MmE3ZjkxMzdjNjY5ZDI1MDg5NTExZjYxY2RhODNjMmMzMTMxYjUwYWVlNWE3OGQ5OTUwNGE0Mjk1OTNmYzc1PiAvViA1ID4+CmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDEzMCAwMDAwMCBuIAowMDAwMDAwMTg5IDAwMDAwIG4gCjAwMDAwMDAyNjIgMDAwMDAgbiAKdHJhaWxlciA8PCAvUm9vdCAxIDAgUiAvU2l6ZSA1IC9JRCBbPDc2OTgwZTg2ZDlhY2E2MTViNThmN2MyOWI0ZjRiMzlmPjw3Njk4MGU4NmQ5YWNhNjE1YjU4ZjdjMjliNGY0YjM5Zj5dIC9FbmNyeXB0IDQgMCBSID4+CnN0YXJ0eHJlZgo4MDkKJSVFT0YK",
    "base64"
  );
}

function buildPdf(objects: readonly string[], options?: { corruptXrefOffsets: boolean }): Buffer {
  const header = "%PDF-1.4\n";
  let body = header;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets
    .map((offset) => {
      const written = options?.corruptXrefOffsets ? offset + 3 : offset;
      return `${String(written).padStart(10, "0")} 00000 n \n`;
    })
    .join("");
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

function createEicarTestPdf(): Buffer {
  // Assemble the public antivirus test marker at runtime so source checkout
  // scanners do not quarantine this test file. No live malware is involved.
  const marker = [
    "X5O!P%@AP[4",
    "\\PZX54(P^)7CC)7}$EICAR-STANDARD-",
    "ANTIVIRUS-TEST-FILE!$H+H*"
  ].join("");
  const pageStream = "BT /F1 20 Tf 72 720 Td (Antivirus integration fixture) Tj ET\n";
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R " +
      "/Names << /EmbeddedFiles << /Names [(eicar.com) 7 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(pageStream, "ascii")} >>\n` + `stream\n${pageStream}endstream`,
    `<< /Type /EmbeddedFile /Length ${Buffer.byteLength(marker, "ascii")} >>\n` +
      `stream\n${marker}\nendstream`,
    "<< /Type /Filespec /F (eicar.com) /EF << /F 6 0 R >> >>"
  ]);
}

async function waitForReadyFile(fileId: string) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const file = await database.uploadedFile.findUniqueOrThrow({ where: { id: fileId } });
    if (file.status === "READY") return file;
    if (["REJECTED", "DELETE_PENDING", "DELETING", "DELETED"].includes(file.status)) {
      throw new Error(
        `PHASE5_PROCESSING_TERMINATED:${file.status}:${file.rejectionCode ?? "NONE"}:` +
          `${file.processingErrorCode ?? "NONE"}:${processingDiagnostic()}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PHASE5_PROCESSING_TIMEOUT:${processingDiagnostic()}`);
}

async function waitForRejectedFile(fileId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const file = await database.uploadedFile.findUniqueOrThrow({ where: { id: fileId } });
    if (file.status === "REJECTED") return file;
    if (file.status === "READY" || file.status === "DELETED") {
      throw new Error(
        `PHASE5_REJECTION_UNEXPECTED_STATE:${file.status}:${file.rejectionCode ?? "NONE"}:` +
          processingDiagnostic()
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PHASE5_REJECTION_TIMEOUT:${processingDiagnostic()}`);
}

async function waitForCleanupPendingFile(fileId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const file = await database.uploadedFile.findUniqueOrThrow({ where: { id: fileId } });
    if (file.status === "DELETE_PENDING") return file;
    if (file.status === "REJECTED") return file;
    if (file.status === "READY" || file.status === "DELETED") {
      throw new Error(
        `PHASE5_CLEANUP_UNEXPECTED_STATE:${file.status}:${file.rejectionCode ?? "NONE"}:` +
          processingDiagnostic()
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PHASE5_CLEANUP_PENDING_TIMEOUT:${processingDiagnostic()}`);
}

function requireUploadToken(qrUrl: string): string {
  const token = new URLSearchParams(new URL(qrUrl).hash.slice(1)).get("t");
  if (!token) throw new Error("PHASE5_UPLOAD_TOKEN_MISSING");
  return token;
}

async function cleanPhase5Fixtures(): Promise<void> {
  await database.idempotencyRecord.deleteMany({
    where: {
      actorId: {
        in: [kioskId, foreignKioskId, kioskCredentialId, foreignCredentialId]
      }
    }
  });
  // Ownership scenarios open a session on the foreign kiosk too. Leaving those
  // behind blocks the kiosk deletion in `afterAll` on its session foreign key,
  // so the stale session survives to refuse the next run with
  // ACTIVE_SESSION_EXISTS.
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
  const objectCleanupFailures = objectCleanup.filter((result) => result.status === "rejected");
  await database.filePage.deleteMany({ where: { file: { sessionId: { in: sessionIds } } } });
  await database.fileDerivative.deleteMany({
    where: { file: { sessionId: { in: sessionIds } } }
  });
  await database.uploadedFile.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.sessionUploadGrant.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.mobileClient.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.auditEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.idempotencyRecord.deleteMany({
    where: {
      actorId: { in: clients.map((client) => client.id) }
    }
  });
  await database.printSession.deleteMany({ where: { id: { in: sessionIds } } });
  if (objectCleanupFailures.length > 0) {
    throw new Error(`PHASE5_FIXTURE_OBJECT_CLEANUP_FAILED:${objectCleanupFailures.length}`);
  }
}

function recordProcessingLog(
  level: "info" | "warn" | "error",
  fields: Record<string, unknown>,
  message: string
): void {
  const entry: Record<string, string | number | boolean> = { level, message };
  for (const name of [
    "fileId",
    "sessionId",
    "generation",
    "attempt",
    "pageCount",
    "errorCode",
    "terminal"
  ]) {
    const value = fields[name];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      entry[name] = value;
    }
  }
  processingLogs.push(entry);
}

function processingDiagnostic(): string {
  return JSON.stringify(processingLogs.slice(-10));
}

function safeMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string") return code;
  }
  if (error instanceof Error && error.message) return error.message;
  return "unknown error";
}
