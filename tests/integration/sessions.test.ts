import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadEnvironment } from "../../packages/config/src/index.js";
import { createSessionResponseSchema } from "../../packages/contracts/src/sessions.js";
import { createDatabaseClient } from "../../packages/database/src/index.js";
import { buildApp } from "../../services/api/src/app.js";
import {
  digestIdempotencyKey,
  digestUploadValue
} from "../../services/api/src/modules/sessions/crypto.js";

const environment = loadEnvironment({ NODE_ENV: "test" });
const database = createDatabaseClient(environment.DATABASE_URL);
const authorization = `Bearer ${environment.DEV_KIOSK_API_KEY}`;
const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

beforeEach(async () => {
  await cleanDevelopmentSessions();
});

afterAll(async () => {
  await cleanDevelopmentSessions();
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await database.$disconnect();
});

async function cleanDevelopmentSessions(): Promise<void> {
  await database.auditEvent.deleteMany({ where: { kioskId: environment.DEV_KIOSK_ID } });
  await database.printSession.deleteMany({ where: { kioskId: environment.DEV_KIOSK_ID } });
  await database.idempotencyRecord.deleteMany({ where: { actorId: environment.DEV_KIOSK_ID } });
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
    const grant = await database.sessionUploadGrant.findUniqueOrThrow({
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
    expect(
      await database.printSession.count({ where: { kioskId: environment.DEV_KIOSK_ID } })
    ).toBe(1);
    expect(await database.sessionUploadGrant.count()).toBe(1);
    expect(await database.auditEvent.count({ where: { action: "session.created" } })).toBe(1);
    expect(await database.outboxEvent.count({ where: { type: "session.created" } })).toBe(1);
    expect(await database.idempotencyRecord.count({ where: { action: "sessions.create" } })).toBe(
      1
    );
  });

  it.each(["tokenDigest", "shortCodeDigest"] as const)(
    "fails closed when the stored %s does not match",
    async (digestField) => {
      const app = await createTestApp();
      const created = createSessionResponseSchema.parse(
        (await createSession(app, `phase2-${digestField}-mismatch`)).json()
      );
      await database.sessionUploadGrant.update({
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
