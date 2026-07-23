import { createHash } from "node:crypto";

import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "../../packages/config/src/index.js";
import {
  SESSION_EVENT_SOCKET_NAME,
  sessionEventReplayResponseSchema,
  sessionEventSchema
} from "../../packages/contracts/src/events.js";
import { createSessionResponseSchema } from "../../packages/contracts/src/sessions.js";
import {
  listUploadedFilesResponseSchema,
  mobileContextResponseSchema,
  uploadFileResponseSchema
} from "../../packages/contracts/src/uploads.js";
import { createDatabaseClient } from "../../packages/database/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import { FileJanitor } from "../../services/api/src/modules/files/janitor.js";
import {
  createS3ObjectStore,
  type ObjectStore
} from "../../services/api/src/modules/files/object-store.js";
import { RealtimeGateway } from "../../services/api/src/modules/realtime/gateway.js";
import { LocalSessionEventBus } from "../../services/api/src/modules/realtime/session-event-bus.js";
import {
  CryptoRandomSource,
  SystemClock,
  digestIdempotencyKey,
  digestUploadValue
} from "../../services/api/src/modules/sessions/crypto.js";
import { OutboxPublisher } from "../../services/worker/src/jobs/publish-outbox.js";

const integrationKioskId = "kiosk_integration_001";
const integrationCredentialId = "integration-kiosk-credential";
const integrationKioskApiKey = "integration-only-kiosk-key-000001";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment({
  ...process.env,
  NODE_ENV: "test",
  DEV_KIOSK_ID: integrationKioskId,
  DEV_KIOSK_API_KEY: integrationKioskApiKey
});
const database = createDatabaseClient(environment.DATABASE_URL);
const authorization = `Bearer ${environment.DEV_KIOSK_API_KEY}`;
const objectStore = createS3ObjectStore(environment);
const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

beforeAll(async () => {
  const secretDigest = createHash("sha256").update(integrationKioskApiKey, "utf8").digest("hex");

  await database.kiosk.upsert({
    where: { id: integrationKioskId },
    create: {
      id: integrationKioskId,
      publicCode: "INTEGRATION-001",
      name: "Integration test kiosk",
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
    where: { credentialId: integrationCredentialId },
    create: {
      id: "01900000-0000-7000-8000-000000000002",
      kioskId: integrationKioskId,
      credentialId: integrationCredentialId,
      secretDigest,
      scopes: ["sessions:create", "sessions:read", "sessions:cancel", "files:read"]
    },
    update: {
      kioskId: integrationKioskId,
      secretDigest,
      scopes: ["sessions:create", "sessions:read", "sessions:cancel", "files:read"],
      revokedAt: null,
      expiresAt: null
    }
  });
});

beforeEach(async () => {
  await cleanIntegrationSessions();
});

afterAll(async () => {
  await cleanIntegrationSessions();
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await database.kioskCredential.deleteMany({
    where: { credentialId: integrationCredentialId }
  });
  await database.kiosk.deleteMany({ where: { id: integrationKioskId } });
  await database.$disconnect();
});

async function cleanIntegrationSessions(): Promise<void> {
  const sessions = await database.printSession.findMany({
    where: { kioskId: environment.DEV_KIOSK_ID },
    select: { id: true }
  });
  const sessionIds = sessions.map((session) => session.id);
  const clients = await database.mobileClient.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { id: true }
  });
  const storedObjects = await database.uploadedFile.findMany({
    where: { sessionId: { in: sessionIds }, quarantineObjectKey: { not: null } },
    select: { quarantineObjectKey: true }
  });
  await Promise.all(
    storedObjects.map(async (file) => {
      if (file.quarantineObjectKey) {
        await objectStore.deleteObject({ key: file.quarantineObjectKey });
      }
    })
  );
  await database.uploadedFile.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.sessionUploadGrant.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.mobileClient.deleteMany({ where: { sessionId: { in: sessionIds } } });
  await database.auditEvent.deleteMany({ where: { kioskId: environment.DEV_KIOSK_ID } });
  await database.printSession.deleteMany({ where: { kioskId: environment.DEV_KIOSK_ID } });
  await database.idempotencyRecord.deleteMany({
    where: {
      actorId: {
        in: [environment.DEV_KIOSK_ID, ...clients.map((client) => client.id)]
      }
    }
  });
}

describe.sequential("authoritative print sessions", () => {
  it("creates, safely replays, reads, and cancels a private session", async () => {
    const app = await createTestApp();
    const created = await createSession(app, "phase2-create-replay");
    const replayed = await createSession(app, "phase2-create-replay");

    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toEqual(created.json());
    expect(created.headers["cache-control"]).toBe("no-store");

    const mismatchedReplay = await createSession(app, "phase2-create-replay", "ru");
    expect(mismatchedReplay.statusCode).toBe(409);
    expect(mismatchedReplay.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_REUSED" }
    });

    const result = createSessionResponseSchema.parse(created.json());
    const uploadUrl = new URL(result.upload.qrUrl);
    const rawUploadToken = new URLSearchParams(uploadUrl.hash.slice(1)).get("t");
    if (!rawUploadToken) throw new Error("TEST_UPLOAD_TOKEN_MISSING");
    const grant = await database.sessionUploadGrant.findFirstOrThrow({
      where: { sessionId: result.session.id }
    });
    const idempotency = await database.idempotencyRecord.findFirstOrThrow({
      where: {
        actorId: environment.DEV_KIOSK_ID,
        action: "sessions.create",
        resourceId: result.session.id
      }
    });

    expect(rawUploadToken).toMatch(/^u_/);
    expect(grant.tokenDigest).toHaveLength(64);
    expect(grant.shortCodeDigest).toHaveLength(64);
    expect(grant.tokenDigest).toBe(
      digestUploadValue(rawUploadToken, environment.UPLOAD_TOKEN_PEPPER)
    );
    expect(grant.shortCodeDigest).toBe(
      digestUploadValue(result.upload.shortCode, environment.UPLOAD_TOKEN_PEPPER)
    );
    expect(JSON.stringify(grant)).not.toContain(result.upload.shortCode);
    expect(idempotency.keyDigest).toBe(
      digestIdempotencyKey(
        environment.DEV_KIOSK_ID,
        "sessions.create",
        "phase2-create-replay",
        environment.UPLOAD_TOKEN_PEPPER
      )
    );
    expect(idempotency.keyDigest).not.toBe("phase2-create-replay");
    expect(idempotency.responseBody).toEqual({ session: result.session });
    expect(JSON.stringify(idempotency)).not.toContain(rawUploadToken);
    expect(JSON.stringify(idempotency)).not.toContain(result.upload.shortCode);
    expect(JSON.stringify(idempotency)).not.toContain(result.upload.qrUrl);

    const read = await app.inject({
      method: "GET",
      url: `/v1/sessions/${result.session.id}`,
      headers: { authorization }
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ session: result.session });
    expect(read.body).not.toContain(rawUploadToken ?? "u_");

    const secondActive = await createSession(app, "phase2-second-active");
    expect(secondActive.statusCode).toBe(409);
    expect(secondActive.json()).toMatchObject({ error: { code: "ACTIVE_SESSION_EXISTS" } });

    const canceled = await cancelSession(app, result.session.id, 1, "phase2-cancel-replay");
    const cancelReplay = await cancelSession(app, result.session.id, 1, "phase2-cancel-replay");
    expect(canceled.statusCode).toBe(200);
    expect(cancelReplay.json()).toEqual(canceled.json());
    expect(canceled.json()).toMatchObject({
      session: { state: "CANCELED", version: 2 }
    });

    const replacement = await createSession(app, "phase2-replacement");
    expect(replacement.statusCode).toBe(201);
  });

  it("serializes concurrent identical creates into one durable action", async () => {
    const app = await createTestApp();
    const responses = await Promise.all([
      createSession(app, "phase2-identical-concurrent"),
      createSession(app, "phase2-identical-concurrent")
    ]);

    expect(
      responses.map((response) => response.statusCode),
      JSON.stringify(responses.map((response) => response.json()))
    ).toEqual([201, 201]);
    expect(responses[1]?.json()).toEqual(responses[0]?.json());
    const created = createSessionResponseSchema.parse(responses[0]?.json());
    expect(
      await database.printSession.count({ where: { kioskId: environment.DEV_KIOSK_ID } })
    ).toBe(1);
    expect(
      await database.sessionUploadGrant.count({ where: { sessionId: created.session.id } })
    ).toBe(1);
    expect(
      await database.auditEvent.count({
        where: { kioskId: environment.DEV_KIOSK_ID, action: "session.created" }
      })
    ).toBe(1);
    expect(
      await database.outboxEvent.count({
        where: { aggregateId: created.session.id, type: "session.created" }
      })
    ).toBe(1);
    expect(
      await database.idempotencyRecord.count({
        where: { actorId: environment.DEV_KIOSK_ID, action: "sessions.create" }
      })
    ).toBe(1);
  });

  it.each(["tokenDigest", "shortCodeDigest"] as const)(
    "fails closed when the stored %s does not match",
    async (digestField) => {
      const app = await createTestApp();
      const created = createSessionResponseSchema.parse(
        (await createSession(app, `phase2-${digestField}-mismatch`)).json()
      );
      await database.sessionUploadGrant.updateMany({
        where: { sessionId: created.session.id },
        data: { [digestField]: "0".repeat(64) }
      });

      const replay = await createSession(app, `phase2-${digestField}-mismatch`);
      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toMatchObject({
        error: { code: "SESSION_UPLOAD_GRANT_REPLAY_UNAVAILABLE" }
      });
      expect(replay.body).not.toContain(created.upload.shortCode);
      expect(replay.body).not.toContain(created.upload.qrUrl);
    }
  );

  it("does not reissue upload credentials after the session advances", async () => {
    const app = await createTestApp();
    const idempotencyKey = "phase2-advanced-session-replay";
    const created = createSessionResponseSchema.parse(
      (await createSession(app, idempotencyKey)).json()
    );
    const rawUploadToken = new URLSearchParams(new URL(created.upload.qrUrl).hash.slice(1)).get(
      "t"
    );
    if (!rawUploadToken) throw new Error("TEST_UPLOAD_TOKEN_MISSING");

    await database.printSession.update({
      where: { id: created.session.id },
      data: { state: "FILES_UPLOADED", stateVersion: 2 }
    });

    const replay = await createSession(app, idempotencyKey);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: { code: "SESSION_UPLOAD_GRANT_REPLAY_UNAVAILABLE" }
    });
    expect(replay.body).not.toContain(rawUploadToken);
    expect(replay.body).not.toContain(created.upload.shortCode);
  });

  it("removes an expired idempotency row before safely reusing its key", async () => {
    const app = await createTestApp();
    const first = createSessionResponseSchema.parse(
      (await createSession(app, "phase2-expired-key")).json()
    );
    await cancelSession(app, first.session.id, 1, "phase2-expired-key-cancel");
    await database.idempotencyRecord.updateMany({
      where: { action: "sessions.create", resourceId: first.session.id },
      data: { expiresAt: new Date("2000-01-01T00:00:00.000Z") }
    });

    const replacementResponse = await createSession(app, "phase2-expired-key");
    expect(replacementResponse.statusCode).toBe(201);
    const replacement = createSessionResponseSchema.parse(replacementResponse.json());
    expect(replacement.session.id).not.toBe(first.session.id);
  });

  it("allows exactly one concurrent versioned cancellation", async () => {
    const app = await createTestApp();
    const created = createSessionResponseSchema.parse(
      (await createSession(app, "phase2-concurrent-create")).json()
    );

    const responses = await Promise.all([
      cancelSession(app, created.session.id, 1, "phase2-concurrent-cancel-a"),
      cancelSession(app, created.session.id, 1, "phase2-concurrent-cancel-b")
    ]);

    expect(
      responses.map((response) => response.statusCode).sort(),
      JSON.stringify(responses.map((response) => response.json()))
    ).toEqual([200, 412]);
    expect(responses.find((response) => response.statusCode === 412)?.json()).toMatchObject({
      error: { code: "STALE_SESSION_VERSION" }
    });
  });

  it("does not lock or disclose a session owned by another kiosk", async () => {
    const app = await createTestApp();
    const foreignKioskId = "kiosk_security_test_foreign";
    const foreignSessionId = "01900000-0000-7000-8000-000000000997";
    const now = new Date();

    await database.kiosk.create({
      data: {
        id: foreignKioskId,
        publicCode: "SECURITY-FOREIGN",
        name: "Security boundary test kiosk",
        capabilities: {}
      }
    });
    await database.printSession.create({
      data: {
        id: foreignSessionId,
        publicId: `ps_${"f".repeat(16)}`,
        kioskId: foreignKioskId,
        locale: "hy",
        state: "WAITING_FOR_UPLOAD",
        stateVersion: 1,
        idleExpiresAt: new Date(now.getTime() + 10 * 60_000),
        hardExpiresAt: new Date(now.getTime() + 30 * 60_000)
      }
    });

    try {
      const response = await cancelSession(app, foreignSessionId, 1, "foreign-session-cancel");
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "SESSION_NOT_FOUND" } });
      await expect(
        database.printSession.findUniqueOrThrow({ where: { id: foreignSessionId } })
      ).resolves.toMatchObject({ state: "WAITING_FOR_UPLOAD", stateVersion: 1 });
    } finally {
      await database.printSession.deleteMany({ where: { kioskId: foreignKioskId } });
      await database.kiosk.deleteMany({ where: { id: foreignKioskId } });
    }
  });

  it("expires at the exact boundary and permits a replacement session", async () => {
    const clock = new MutableClock(new Date("2030-01-01T00:00:00.000Z"));
    const app = await createTestApp(clock);
    const created = createSessionResponseSchema.parse(
      (await createSession(app, "phase2-expiry-create")).json()
    );

    clock.current = new Date(created.session.expiresAt);
    const expiredRead = await app.inject({
      method: "GET",
      url: `/v1/sessions/${created.session.id}`,
      headers: { authorization }
    });
    expect(expiredRead.statusCode).toBe(410);
    expect(expiredRead.json()).toMatchObject({ error: { code: "SESSION_EXPIRED" } });

    const replacement = await createSession(app, "phase2-after-expiry");
    expect(replacement.statusCode).toBe(201);
    await expect(
      database.printSession.findUniqueOrThrow({ where: { id: created.session.id } })
    ).resolves.toMatchObject({ state: "EXPIRED", stateVersion: 2 });
  });

  it("retries allocation when a generated public session identifier collides", async () => {
    const now = new Date();
    await database.printSession.create({
      data: {
        id: "01900000-0000-7000-8000-000000000999",
        publicId: `ps_${"a".repeat(16)}`,
        kioskId: environment.DEV_KIOSK_ID,
        locale: "hy",
        state: "CANCELED",
        stateVersion: 2,
        idleExpiresAt: new Date(now.getTime() + 10 * 60_000),
        hardExpiresAt: new Date(now.getTime() + 30 * 60_000),
        canceledAt: now
      }
    });

    const app = await buildApp({
      environment,
      database,
      random: new CollisionThenUniqueRandom()
    });
    openApps.push(app);

    const created = createSessionResponseSchema.parse(
      (await createSession(app, "phase2-collision-retry")).json()
    );
    expect(created.session.publicId).toBe(`ps_${"b".repeat(16)}`);
  });

  it("exchanges a one-time QR grant and completes a private upload/list/delete lifecycle", async () => {
    const app = await createTestApp();
    const created = createSessionResponseSchema.parse(
      (await createSession(app, "phase3-private-upload")).json()
    );
    const uploadToken = requireUploadToken(created.upload.qrUrl);
    const clientNonce = "01900000-0000-7000-8000-000000000031";
    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/v1/mobile-auth/exchange",
      headers: { origin: "https://attacker.example.test" },
      payload: { publicSessionId: created.session.publicId, uploadToken, clientNonce }
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json()).toMatchObject({ error: { code: "INVALID_REQUEST_ORIGIN" } });

    const exchange = await exchangeMobile(app, created.session.publicId, uploadToken, clientNonce);

    expect(exchange.response.statusCode).toBe(200);
    expect(exchange.response.headers["cache-control"]).toBe("no-store");
    expect(exchange.setCookie).toContain("HttpOnly");
    expect(exchange.setCookie).toContain("SameSite=Strict");
    expect(exchange.setCookie).toContain("Path=/v1");
    expect(exchange.response.body).not.toContain(uploadToken);

    const claimedGrant = await database.sessionUploadGrant.findFirstOrThrow({
      where: { sessionId: created.session.id }
    });
    const mobileClient = await database.mobileClient.findUniqueOrThrow({
      where: { id: claimedGrant.claimedClientId ?? "missing" }
    });
    expect(claimedGrant.status).toBe("CLAIMED");
    expect(mobileClient.cookieDigest).toHaveLength(64);
    expect(JSON.stringify(mobileClient)).not.toContain(exchange.rawCookie);

    const secondPhone = await exchangeMobile(
      app,
      created.session.publicId,
      uploadToken,
      "01900000-0000-7000-8000-000000000032"
    );
    expect(secondPhone.response.statusCode).toBe(409);
    expect(secondPhone.response.json()).toMatchObject({
      error: { code: "UPLOAD_GRANT_ALREADY_CLAIMED" }
    });

    const safeReplay = await exchangeMobile(
      app,
      created.session.publicId,
      uploadToken,
      clientNonce
    );
    expect(safeReplay.response.statusCode).toBe(200);
    expect(safeReplay.rawCookie).toBe(exchange.rawCookie);

    const refreshed = await app.inject({
      method: "GET",
      url: `/v1/mobile-auth/${created.session.publicId}/context`,
      headers: { cookie: exchange.cookieHeader }
    });
    expect(refreshed.statusCode).toBe(200);
    expect(mobileContextResponseSchema.parse(refreshed.json()).session.id).toBe(created.session.id);

    const privateFilename = "customer-tax-record-private.pdf";
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "utf8");
    const uploaded = await uploadMultipart(app, {
      sessionId: created.session.id,
      cookieHeader: exchange.cookieHeader,
      csrfToken: exchange.context.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000041",
      idempotencyKey: "phase3-file-upload-1",
      filename: privateFilename,
      mime: "application/pdf",
      contents: pdf
    });
    expect(uploaded.statusCode).toBe(202);
    const uploadResult = uploadFileResponseSchema.parse(uploaded.json());
    expect(uploadResult.file).toMatchObject({
      ordinal: 0,
      status: "QUARANTINED",
      kind: "PDF",
      sizeBytes: pdf.byteLength
    });
    expect(uploaded.body).not.toContain(privateFilename);

    const storedFile = await database.uploadedFile.findUniqueOrThrow({
      where: { id: uploadResult.file.id }
    });
    expect(storedFile.displayName).toBe("Document 1");
    expect(storedFile.quarantineObjectKey).toMatch(
      new RegExp(`^quarantine/v1/${created.session.id}/${storedFile.id}/`)
    );
    expect(JSON.stringify(storedFile)).not.toContain(privateFilename);
    if (!storedFile.quarantineObjectKey) throw new Error("EXPECTED_PRIVATE_OBJECT_KEY");

    const anonymousObjectRead = await fetch(
      new URL(
        `/${environment.S3_BUCKET}/${storedFile.quarantineObjectKey}`,
        environment.S3_ENDPOINT
      )
    );
    expect(anonymousObjectRead.status).toBe(403);

    const replayedUpload = await uploadMultipart(app, {
      sessionId: created.session.id,
      cookieHeader: exchange.cookieHeader,
      csrfToken: exchange.context.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000041",
      idempotencyKey: "phase3-file-upload-1",
      filename: privateFilename,
      mime: "application/pdf",
      contents: pdf
    });
    expect(replayedUpload.statusCode).toBe(202);
    expect(replayedUpload.json()).toEqual(uploaded.json());
    expect(await database.uploadedFile.count({ where: { sessionId: created.session.id } })).toBe(1);

    const mobileList = await app.inject({
      method: "GET",
      url: `/v1/sessions/${created.session.id}/files`,
      headers: { cookie: exchange.cookieHeader }
    });
    const kioskList = await app.inject({
      method: "GET",
      url: `/v1/sessions/${created.session.id}/files`,
      headers: { authorization }
    });
    expect(mobileList.statusCode).toBe(200);
    expect(kioskList.statusCode).toBe(200);
    expect(listUploadedFilesResponseSchema.parse(mobileList.json())).toEqual(
      listUploadedFilesResponseSchema.parse(kioskList.json())
    );
    expect(mobileList.body).not.toContain(privateFilename);

    const overCount = await uploadMultipart(app, {
      sessionId: created.session.id,
      cookieHeader: exchange.cookieHeader,
      csrfToken: exchange.context.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000042",
      idempotencyKey: "phase3-file-upload-2",
      filename: "second.pdf",
      mime: "application/pdf",
      contents: pdf
    });
    expect(overCount.statusCode).toBe(409);
    expect(overCount.json()).toMatchObject({ error: { code: "FILE_LIMIT_REACHED" } });

    const badCsrfDelete = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${created.session.id}/files/${storedFile.id}`,
      headers: {
        origin: environment.UPLOAD_ORIGIN,
        cookie: exchange.cookieHeader,
        "x-csrf-token": `c_${"x".repeat(43)}`,
        "idempotency-key": "phase3-delete-file-1"
      }
    });
    expect(badCsrfDelete.statusCode).toBe(403);

    const deleted = await deleteMobileFile(
      app,
      created.session.id,
      storedFile.id,
      exchange.cookieHeader,
      exchange.context.csrfToken,
      "phase3-delete-file-1"
    );
    const deleteReplay = await deleteMobileFile(
      app,
      created.session.id,
      storedFile.id,
      exchange.cookieHeader,
      exchange.context.csrfToken,
      "phase3-delete-file-1"
    );
    expect(deleted.statusCode).toBe(204);
    expect(deleteReplay.statusCode).toBe(204);
    await expect(
      database.uploadedFile.findUniqueOrThrow({ where: { id: storedFile.id } })
    ).resolves.toMatchObject({
      status: "DELETED",
      quarantineObjectKey: null,
      contentSha256: null
    });

    const replacementUpload = await uploadMultipart(app, {
      sessionId: created.session.id,
      cookieHeader: exchange.cookieHeader,
      csrfToken: exchange.context.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000043",
      idempotencyKey: "phase3-file-replacement",
      filename: "replacement.pdf",
      mime: "application/pdf",
      contents: pdf
    });
    expect(replacementUpload.statusCode).toBe(202);
    const replacement = uploadFileResponseSchema.parse(replacementUpload.json());
    expect(replacement.file.ordinal).toBe(1);
    expect(
      (
        await deleteMobileFile(
          app,
          created.session.id,
          replacement.file.id,
          exchange.cookieHeader,
          exchange.context.csrfToken,
          "phase3-delete-replacement"
        )
      ).statusCode
    ).toBe(204);

    const canceled = await cancelSession(
      app,
      created.session.id,
      created.session.version,
      "phase3-cancel-after-delete"
    );
    expect(canceled.statusCode).toBe(200);
    const eventSequences = (
      await database.outboxEvent.findMany({
        where: { aggregateId: created.session.id },
        orderBy: { sequence: "asc" },
        select: { sequence: true }
      })
    ).map((event) => event.sequence);
    expect(eventSequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("records exactly one durable rejection event when janitors recover an interrupted upload", async () => {
    const clock = new MutableClock(new Date("2030-01-01T00:00:00.000Z"));
    const app = await createTestApp(clock);
    const created = createSessionResponseSchema.parse(
      (await createSession(app, "phase4-interrupted-upload")).json()
    );
    const exchange = await exchangeMobile(
      app,
      created.session.publicId,
      requireUploadToken(created.upload.qrUrl),
      "01900000-0000-7000-8000-000000000061"
    );
    expect(exchange.response.statusCode).toBe(200);
    const client = await database.mobileClient.findFirstOrThrow({
      where: { sessionId: created.session.id }
    });
    const fileId = "01900000-0000-7000-8000-000000000062";
    const objectKey = `quarantine/v1/${created.session.id}/${fileId}/interrupted-recovery-token`;
    await database.uploadedFile.create({
      data: {
        id: fileId,
        sessionId: created.session.id,
        uploadedByClientId: client.id,
        clientFileId: "01900000-0000-7000-8000-000000000063",
        ordinal: 0,
        displayName: "Document 1",
        status: "UPLOADING",
        declaredMime: "application/pdf",
        reservedBytes: 16,
        quarantineObjectKey: objectKey,
        createdAt: clock.current,
        updatedAt: clock.current
      }
    });

    clock.current = new Date(
      clock.current.getTime() + (environment.UPLOAD_TIMEOUT_SECONDS + 31) * 1_000
    );
    const cleanupStore = new ControlledObjectStore();
    const errors: Array<{ error: unknown; operation: string }> = [];
    const janitors = [
      createFileJanitor(clock, cleanupStore, errors),
      createFileJanitor(clock, cleanupStore, errors)
    ];
    await Promise.all(janitors.map(async (janitor) => janitor.runOnce()));
    await Promise.all(janitors.map(async (janitor) => janitor.runOnce()));

    const rejected = await database.uploadedFile.findUniqueOrThrow({ where: { id: fileId } });
    expect(rejected).toMatchObject({
      status: "REJECTED",
      rejectionCode: "UPLOAD_INTERRUPTED",
      quarantineObjectKey: null,
      contentSha256: null
    });
    const events = await database.outboxEvent.findMany({
      where: { aggregateId: created.session.id, type: "file.rejected" }
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 3,
      payload: {
        sessionId: created.session.id,
        file: {
          id: fileId,
          ordinal: 0,
          status: "REJECTED",
          kind: null,
          sizeBytes: null,
          createdAt: "2030-01-01T00:00:00.000Z"
        }
      }
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(objectKey);
    await expect(
      database.printSession.findUniqueOrThrow({ where: { id: created.session.id } })
    ).resolves.toMatchObject({ eventSequence: 3 });
    expect(errors).toEqual([]);
  });

  it("records one durable deletion event after deferred object cleanup and preserves delete replay", async () => {
    const clock = new MutableClock(new Date("2030-01-01T00:00:00.000Z"));
    const cleanupStore = new ControlledObjectStore();
    const app = await buildApp({ environment, database, objectStore: cleanupStore, clock });
    openApps.push(app);
    const created = createSessionResponseSchema.parse(
      (await createSession(app, "phase4-deferred-deletion")).json()
    );
    const exchange = await exchangeMobile(
      app,
      created.session.publicId,
      requireUploadToken(created.upload.qrUrl),
      "01900000-0000-7000-8000-000000000071"
    );
    expect(exchange.response.statusCode).toBe(200);
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n", "utf8");
    const uploaded = uploadFileResponseSchema.parse(
      (
        await uploadMultipart(app, {
          sessionId: created.session.id,
          cookieHeader: exchange.cookieHeader,
          csrfToken: exchange.context.csrfToken,
          clientFileId: "01900000-0000-7000-8000-000000000072",
          idempotencyKey: "phase4-deferred-upload",
          filename: "private-customer-name.pdf",
          mime: "application/pdf",
          contents: pdf
        })
      ).json()
    );
    const stored = await database.uploadedFile.findUniqueOrThrow({
      where: { id: uploaded.file.id }
    });
    if (!stored.quarantineObjectKey) throw new Error("EXPECTED_PRIVATE_OBJECT_KEY");
    cleanupStore.failNextDeletes(1);

    const idempotencyKey = "phase4-deferred-delete";
    const deferred = await deleteMobileFile(
      app,
      created.session.id,
      stored.id,
      exchange.cookieHeader,
      exchange.context.csrfToken,
      idempotencyKey
    );
    expect(deferred.statusCode).toBe(503);
    expect(deferred.json()).toMatchObject({ error: { code: "FILE_DELETE_DEFERRED" } });
    await expect(
      database.uploadedFile.findUniqueOrThrow({ where: { id: stored.id } })
    ).resolves.toMatchObject({
      status: "DELETE_PENDING",
      quarantineObjectKey: stored.quarantineObjectKey
    });

    clock.current = new Date(clock.current.getTime() + 16_000);
    const errors: Array<{ error: unknown; operation: string }> = [];
    const janitors = [
      createFileJanitor(clock, cleanupStore, errors),
      createFileJanitor(clock, cleanupStore, errors)
    ];
    await Promise.all(janitors.map(async (janitor) => janitor.runOnce()));
    await Promise.all(janitors.map(async (janitor) => janitor.runOnce()));

    await expect(
      database.uploadedFile.findUniqueOrThrow({ where: { id: stored.id } })
    ).resolves.toMatchObject({
      status: "DELETED",
      quarantineObjectKey: null,
      contentSha256: null
    });
    const events = await database.outboxEvent.findMany({
      where: { aggregateId: created.session.id, type: "file.deleted" }
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 5,
      payload: { sessionId: created.session.id, fileId: stored.id }
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(stored.quarantineObjectKey);
    expect(cleanupStore.hasObject(stored.quarantineObjectKey)).toBe(false);
    expect(
      (
        await deleteMobileFile(
          app,
          created.session.id,
          stored.id,
          exchange.cookieHeader,
          exchange.context.csrfToken,
          idempotencyKey
        )
      ).statusCode
    ).toBe(204);
    expect(
      (
        await deleteMobileFile(
          app,
          created.session.id,
          stored.id,
          exchange.cookieHeader,
          exchange.context.csrfToken,
          idempotencyKey
        )
      ).statusCode
    ).toBe(204);
    await expect(
      database.outboxEvent.count({
        where: { aggregateId: created.session.id, type: "file.deleted" }
      })
    ).resolves.toBe(1);
    await expect(
      database.printSession.findUniqueOrThrow({ where: { id: created.session.id } })
    ).resolves.toMatchObject({ eventSequence: 5 });
    expect(errors).toEqual([]);
  });

  it("rejects a spoofed file, removes its bytes, and revokes mobile access on cancel", async () => {
    const app = await createTestApp();
    const created = createSessionResponseSchema.parse(
      (await createSession(app, "phase3-spoofed-upload")).json()
    );
    const uploadToken = requireUploadToken(created.upload.qrUrl);
    const exchange = await exchangeMobile(
      app,
      created.session.publicId,
      uploadToken,
      "01900000-0000-7000-8000-000000000051"
    );
    expect(exchange.response.statusCode).toBe(200);

    const spoofed = await uploadMultipart(app, {
      sessionId: created.session.id,
      cookieHeader: exchange.cookieHeader,
      csrfToken: exchange.context.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000052",
      idempotencyKey: "phase3-spoofed-file",
      filename: "private-name.pdf",
      mime: "application/pdf",
      contents: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    });
    expect(spoofed.statusCode).toBe(415);
    expect(spoofed.json()).toMatchObject({ error: { code: "FILE_SIGNATURE_MISMATCH" } });
    await expect(
      database.uploadedFile.findFirstOrThrow({ where: { sessionId: created.session.id } })
    ).resolves.toMatchObject({
      status: "REJECTED",
      rejectionCode: "FILE_SIGNATURE_MISMATCH",
      quarantineObjectKey: null,
      contentSha256: null
    });

    const rejectedList = listUploadedFilesResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/v1/sessions/${created.session.id}/files`,
          headers: { cookie: exchange.cookieHeader }
        })
      ).json()
    );
    expect(rejectedList.items).toHaveLength(1);
    const rejectedFile = rejectedList.items[0];
    if (!rejectedFile) throw new Error("EXPECTED_REJECTED_FILE");
    expect(rejectedFile).toMatchObject({ status: "REJECTED", ordinal: 0 });

    const multipleParts = await uploadMultipart(app, {
      sessionId: created.session.id,
      cookieHeader: exchange.cookieHeader,
      csrfToken: exchange.context.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000053",
      idempotencyKey: "phase3-multiple-parts",
      filename: "first.pdf",
      mime: "application/pdf",
      contents: Buffer.from("%PDF-1.4\n%%EOF\n", "utf8"),
      extraPart: Buffer.from("%PDF-1.4\n%%EOF\n", "utf8")
    });
    expect(multipleParts.statusCode).toBe(400);
    expect(multipleParts.json()).toMatchObject({ error: { code: "MULTIPLE_FILE_PARTS" } });

    const replacement = await uploadMultipart(app, {
      sessionId: created.session.id,
      cookieHeader: exchange.cookieHeader,
      csrfToken: exchange.context.csrfToken,
      clientFileId: "01900000-0000-7000-8000-000000000054",
      idempotencyKey: "phase3-replacement-after-rejection",
      filename: "replacement.pdf",
      mime: "application/pdf",
      contents: Buffer.from("%PDF-1.4\n%%EOF\n", "utf8")
    });
    expect(replacement.statusCode).toBe(202);
    expect(uploadFileResponseSchema.parse(replacement.json()).file.ordinal).toBe(2);

    const removedRejected = await deleteMobileFile(
      app,
      created.session.id,
      rejectedFile.id,
      exchange.cookieHeader,
      exchange.context.csrfToken,
      "phase3-delete-rejected"
    );
    expect(removedRejected.statusCode).toBe(204);
    await expect(
      database.uploadedFile.findUniqueOrThrow({ where: { id: rejectedFile.id } })
    ).resolves.toMatchObject({ status: "DELETED", quarantineObjectKey: null });

    const canceled = await cancelSession(
      app,
      created.session.id,
      created.session.version,
      "phase3-cancel-revokes-mobile"
    );
    expect(canceled.statusCode).toBe(200);

    const filesAtCancellation = await database.uploadedFile.findMany({
      where: { sessionId: created.session.id },
      orderBy: { id: "asc" },
      select: {
        id: true,
        clientFileId: true,
        status: true,
        quarantineObjectKey: true
      }
    });
    const canceledUploadClientFileId = "01900000-0000-7000-8000-000000000055";
    const uploadAfterCancel = await uploadMultipart(app, {
      sessionId: created.session.id,
      cookieHeader: exchange.cookieHeader,
      csrfToken: exchange.context.csrfToken,
      clientFileId: canceledUploadClientFileId,
      idempotencyKey: "phase3-upload-after-cancel",
      filename: "must-not-be-accepted.pdf",
      mime: "application/pdf",
      contents: Buffer.from("%PDF-1.4\n%%EOF\n", "utf8")
    });
    expect(uploadAfterCancel.statusCode).toBe(401);
    expect(uploadAfterCancel.json()).toMatchObject({
      error: { code: "INVALID_MOBILE_SESSION" }
    });
    await expect(
      database.uploadedFile.findUnique({
        where: {
          sessionId_clientFileId: {
            sessionId: created.session.id,
            clientFileId: canceledUploadClientFileId
          }
        }
      })
    ).resolves.toBeNull();
    await expect(
      database.uploadedFile.findMany({
        where: { sessionId: created.session.id },
        orderBy: { id: "asc" },
        select: {
          id: true,
          clientFileId: true,
          status: true,
          quarantineObjectKey: true
        }
      })
    ).resolves.toEqual(filesAtCancellation);

    const revokedContext = await app.inject({
      method: "GET",
      url: `/v1/mobile-auth/${created.session.publicId}/context`,
      headers: { cookie: exchange.cookieHeader }
    });
    expect(revokedContext.statusCode).toBe(401);
    const revokedGrant = await exchangeMobile(
      app,
      created.session.publicId,
      uploadToken,
      "01900000-0000-7000-8000-000000000051"
    );
    expect(revokedGrant.response.statusCode).toBe(401);
  });

  it("rejects a create idempotency response that contains upload data", async () => {
    await expect(
      database.idempotencyRecord.create({
        data: {
          id: "01900000-0000-7000-8000-000000000998",
          actorId: environment.DEV_KIOSK_ID,
          action: "sessions.create",
          keyDigest: "f".repeat(64),
          requestHash: "e".repeat(64),
          responseStatus: 201,
          responseBody: { session: {}, upload: { shortCode: "12345678" } },
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000)
        }
      })
    ).rejects.toThrow();
  });

  it("rejects upload data hidden inside a stored session snapshot", async () => {
    await expect(
      database.idempotencyRecord.create({
        data: {
          id: "01900000-0000-7000-8000-000000000996",
          actorId: environment.DEV_KIOSK_ID,
          action: "sessions.create",
          keyDigest: "d".repeat(64),
          requestHash: "c".repeat(64),
          responseStatus: 201,
          responseBody: {
            session: {
              id: "01900000-0000-7000-8000-000000000996",
              publicId: `ps_${"n".repeat(16)}`,
              kioskId: environment.DEV_KIOSK_ID,
              locale: "hy",
              state: "WAITING_FOR_UPLOAD",
              version: 1,
              expiresAt: "2030-01-01T00:10:00.000Z",
              hardExpiresAt: "2030-01-01T00:30:00.000Z",
              createdAt: "2030-01-01T00:00:00.000Z",
              canceledAt: null,
              upload: { shortCode: "12345678" }
            }
          },
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000)
        }
      })
    ).rejects.toThrow();
  });

  it("delivers a committed event and replays the same event after reconnect", async () => {
    const sessionEvents = new LocalSessionEventBus();
    const app = await buildApp({ environment, database, objectStore, sessionEvents });
    const gateway = new RealtimeGateway(
      app.server,
      database,
      new SystemClock(),
      environment,
      silentRealtimeLogger,
      sessionEvents
    );
    const publisher = new OutboxPublisher(database, environment, silentRealtimeLogger, 10);
    let socket: Socket | undefined;
    let unauthorizedSocket: Socket | undefined;

    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      socket = io(address, {
        path: "/socket.io",
        transports: ["websocket"],
        auth: {
          kioskId: environment.DEV_KIOSK_ID,
          credential: environment.DEV_KIOSK_API_KEY
        }
      });
      await waitForSocketConnect(socket);

      unauthorizedSocket = io(address, {
        path: "/socket.io",
        transports: ["websocket"],
        reconnection: false,
        auth: {
          kioskId: environment.DEV_KIOSK_ID,
          credential: "invalid-kiosk-credential-000000"
        }
      });
      await expect(waitForConnectError(unauthorizedSocket)).resolves.toBe("AUTHENTICATION_FAILED");

      const created = createSessionResponseSchema.parse(
        (await createSession(app, "phase4-realtime-delivery")).json()
      );
      const delivery = waitForSessionEvent(socket, created.session.id);
      const mobileDelivery = waitForLocalSessionEvent(sessionEvents, created.session.id);

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const target = await database.outboxEvent.findUnique({
          where: {
            aggregateId_sequence: {
              aggregateId: created.session.id,
              sequence: 1
            }
          },
          select: { status: true }
        });
        if (target?.status === "PUBLISHED") break;
        if (!(await publisher.publishNext()))
          await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const received = await delivery;
      await expect(mobileDelivery.promise).resolves.toEqual(received);
      mobileDelivery.unsubscribe();
      expect(received).toMatchObject({
        sessionId: created.session.id,
        sequence: 1,
        type: "session.created"
      });

      socket.close();
      socket = undefined;
      const replayResponse = await app.inject({
        method: "GET",
        url: `/v1/sessions/${created.session.id}/events?after=0`,
        headers: { authorization }
      });
      expect(replayResponse.statusCode).toBe(200);
      const replay = sessionEventReplayResponseSchema.parse(replayResponse.json());
      expect(replay.events).toEqual([received]);
      expect(replay.latestSequence).toBe(1);
      expect(replay.hasMore).toBe(false);
      expect(replayResponse.body).not.toContain(environment.DEV_KIOSK_API_KEY);
      expect(replayResponse.body).not.toContain(created.upload.qrUrl);
    } finally {
      socket?.close();
      unauthorizedSocket?.close();
      await publisher.close();
      await gateway.close();
      await app.close();
    }
  });
});

async function createTestApp(clock?: MutableClock) {
  const app = await buildApp({
    environment,
    database,
    ...(clock ? { clock } : {})
  });
  openApps.push(app);
  return app;
}

function createSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  idempotencyKey: string,
  locale: "en" | "ru" | "hy" = "hy"
) {
  return app.inject({
    method: "POST",
    url: `/v1/kiosks/${environment.DEV_KIOSK_ID}/sessions`,
    headers: { authorization, "idempotency-key": idempotencyKey },
    payload: { locale }
  });
}

function cancelSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
  version: number,
  idempotencyKey: string
) {
  return app.inject({
    method: "POST",
    url: `/v1/sessions/${sessionId}/cancel`,
    headers: {
      authorization,
      "idempotency-key": idempotencyKey,
      "if-match": `"${version}"`
    }
  });
}

async function exchangeMobile(
  app: Awaited<ReturnType<typeof buildApp>>,
  publicSessionId: string,
  uploadToken: string,
  clientNonce: string
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/mobile-auth/exchange",
    headers: { origin: environment.UPLOAD_ORIGIN },
    payload: { publicSessionId, uploadToken, clientNonce }
  });
  if (response.statusCode !== 200) {
    return {
      response,
      setCookie: "",
      rawCookie: "",
      cookieHeader: "",
      context: null as never
    };
  }

  const context = mobileContextResponseSchema.parse(response.json());
  const rawSetCookie = response.headers["set-cookie"];
  const setCookie = Array.isArray(rawSetCookie) ? (rawSetCookie[0] ?? "") : (rawSetCookie ?? "");
  const cookieName = `pk_upload_${context.session.id.replaceAll("-", "")}`;
  const cookiePair = setCookie.split(";", 1)[0] ?? "";
  const cookiePrefix = `${cookieName}=`;
  if (!cookiePair.startsWith(cookiePrefix)) throw new Error("EXPECTED_MOBILE_COOKIE");
  const rawCookie = decodeURIComponent(cookiePair.slice(cookiePrefix.length));
  return {
    response,
    setCookie,
    rawCookie,
    cookieHeader: `${cookieName}=${rawCookie}`,
    context
  };
}

function uploadMultipart(
  app: Awaited<ReturnType<typeof buildApp>>,
  input: {
    sessionId: string;
    cookieHeader: string;
    csrfToken: string;
    clientFileId: string;
    idempotencyKey: string;
    filename: string;
    mime: string;
    contents: Buffer;
    extraPart?: Buffer;
  }
) {
  const boundary = `phase3-${input.clientFileId.replaceAll("-", "")}`;
  const closingParts = input.extraPart
    ? Buffer.concat([
        Buffer.from(
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="extra"; filename="extra.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          "utf8"
        ),
        input.extraPart,
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
      ])
    : Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename}"\r\nContent-Type: ${input.mime}\r\n\r\n`,
      "utf8"
    ),
    input.contents,
    closingParts
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

function deleteMobileFile(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
  fileId: string,
  cookieHeader: string,
  csrfToken: string,
  idempotencyKey: string
) {
  return app.inject({
    method: "DELETE",
    url: `/v1/sessions/${sessionId}/files/${fileId}`,
    headers: {
      origin: environment.UPLOAD_ORIGIN,
      cookie: cookieHeader,
      "x-csrf-token": csrfToken,
      "idempotency-key": idempotencyKey
    }
  });
}

function requireUploadToken(qrUrl: string): string {
  const token = new URLSearchParams(new URL(qrUrl).hash.slice(1)).get("t");
  if (!token) throw new Error("TEST_UPLOAD_TOKEN_MISSING");
  return token;
}

class MutableClock {
  public constructor(public current: Date) {}

  public now(): Date {
    return new Date(this.current);
  }
}

class CollisionThenUniqueRandom {
  private uuidCounter = 0;
  private tokenCounter = 0;
  private integerCounter = 0;

  public uuid(_now: Date): string {
    this.uuidCounter += 1;
    return `01900000-0000-7000-8000-${String(this.uuidCounter).padStart(12, "0")}`;
  }

  public token(bytes: number): string {
    this.tokenCounter += 1;
    const values = ["a", "b", "c", "d"];
    return (values[this.tokenCounter - 1] ?? "z").repeat(bytes);
  }

  public integer(_maxExclusive: number): number {
    this.integerCounter += 1;
    return this.integerCounter === 1 ? 11_111_111 : 22_222_222;
  }
}

function createFileJanitor(
  clock: MutableClock,
  controlledObjectStore: ObjectStore,
  errors: Array<{ error: unknown; operation: string }>
): FileJanitor {
  return new FileJanitor({
    database,
    objectStore: controlledObjectStore,
    clock,
    random: new CryptoRandomSource(),
    uploadTimeoutSeconds: environment.UPLOAD_TIMEOUT_SECONDS,
    onError: (error, operation) => errors.push({ error, operation })
  });
}

class ControlledObjectStore implements ObjectStore {
  private readonly objects = new Set<string>();
  private remainingDeleteFailures = 0;

  public async putObject(
    input: Parameters<ObjectStore["putObject"]>[0]
  ): Promise<Awaited<ReturnType<ObjectStore["putObject"]>>> {
    for await (const _chunk of input.body) {
      input.signal?.throwIfAborted();
    }
    this.objects.add(input.key);
    return {};
  }

  public async deleteObject(input: Parameters<ObjectStore["deleteObject"]>[0]): Promise<void> {
    input.signal?.throwIfAborted();
    if (this.remainingDeleteFailures > 0) {
      this.remainingDeleteFailures -= 1;
      throw new Error("SIMULATED_OBJECT_DELETE_FAILURE");
    }
    this.objects.delete(input.key);
  }

  public checkReady(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return Promise.resolve();
  }

  public failNextDeletes(count: number): void {
    this.remainingDeleteFailures = count;
  }

  public hasObject(key: string): boolean {
    return this.objects.has(key);
  }
}

const silentRealtimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function waitForSocketConnect(socket: Socket): Promise<void> {
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    })
  );
}

function waitForConnectError(socket: Socket): Promise<string> {
  return withTimeout(
    new Promise((resolve) => {
      socket.once("connect_error", (error) => resolve(error.message));
    })
  );
}

function waitForSessionEvent(socket: Socket, expectedSessionId: string) {
  return withTimeout(
    new Promise<ReturnType<typeof sessionEventSchema.parse>>((resolve) => {
      socket.on(SESSION_EVENT_SOCKET_NAME, (input: unknown) => {
        const event = sessionEventSchema.safeParse(input);
        if (event.success && event.data.sessionId === expectedSessionId) resolve(event.data);
      });
    })
  );
}

function waitForLocalSessionEvent(
  events: LocalSessionEventBus,
  expectedSessionId: string
): {
  promise: Promise<ReturnType<typeof sessionEventSchema.parse>>;
  unsubscribe: () => void;
} {
  let unsubscribe = () => undefined;
  const promise = withTimeout(
    new Promise<ReturnType<typeof sessionEventSchema.parse>>((resolve) => {
      unsubscribe = events.subscribe(expectedSessionId, (event) => resolve(event));
    })
  );
  return { promise, unsubscribe: () => unsubscribe() };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SOCKET_TEST_TIMEOUT")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
