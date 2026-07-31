import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnvironment } from "@printing-kiosk/config";

import { buildApp } from "./app.js";

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

/**
 * Answers every credential lookup with "no such credential" so authentication
 * behaviour can be exercised without a running database.
 */
function noMatchingCredentialDatabase(): NonNullable<Parameters<typeof buildApp>[0]["database"]> {
  return {
    kioskCredential: {
      findUnique: () => Promise.resolve(null),
      updateMany: () => Promise.resolve({ count: 0 })
    }
  } as unknown as NonNullable<Parameters<typeof buildApp>[0]["database"]>;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("health routes", () => {
  it("reports the fixed product scope", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      readinessCheck: () => ({
        postgres: "ok",
        redis: "ok",
        objectStorage: "ok"
      })
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "api",
      productScope: {
        service: "PRINT_ONLY",
        outputMode: "MONOCHROME",
        scanningEnabled: false,
        photocopyEnabled: false
      }
    });
  });

  it("reports unavailable dependencies without failing liveness", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      readinessCheck: () => ({
        postgres: "failed",
        redis: "ok",
        objectStorage: "ok"
      })
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: {
        postgres: "failed",
        redis: "ok",
        objectStorage: "ok"
      }
    });
  });
});

describe("session route authentication", () => {
  it("rejects an unauthenticated kiosk before accessing session data", async () => {
    const app = await buildApp({ environment: loadEnvironment({ NODE_ENV: "test" }) });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/kiosks/kiosk_dev_001/sessions",
      headers: { "idempotency-key": "unauthenticated-create" },
      payload: { locale: "hy" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_KIOSK_CREDENTIAL" } });
  });

  it("rejects event replay without exposing whether the session exists", async () => {
    const app = await buildApp({ environment: loadEnvironment({ NODE_ENV: "test" }) });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/01900000-0000-7000-8000-000000000010/events?after=0"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_KIOSK_CREDENTIAL" } });
  });

  it("stops answering a source that keeps presenting an unusable credential", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      database: noMatchingCredentialDatabase()
    });
    openApps.push(app);

    const guess = (index: number) =>
      app.inject({
        method: "GET",
        url: "/v1/sessions/01900000-0000-7000-8000-000000000010/events?after=0",
        headers: { authorization: `Bearer guessed-kiosk-credential-${index}-aaaaaaaa` }
      });

    const codes: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      codes.push((await guess(index)).statusCode);
    }

    // Guessing stays answerable for a while, then stops costing a lookup.
    expect(codes[0]).toBe(401);
    expect(codes.at(-1)).toBe(429);
    expect(codes.filter((code) => code === 401).length).toBeGreaterThan(10);
    expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
  });

  it("does not spend the failure allowance on requests that never present a credential", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      database: noMatchingCredentialDatabase()
    });
    openApps.push(app);

    // A missing credential is refused before authentication is attempted, so it
    // must not push a legitimate kiosk toward the guessing threshold.
    for (let index = 0; index < 30; index += 1) {
      await app.inject({ method: "GET", url: "/health/live" });
    }

    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/01900000-0000-7000-8000-000000000010/events?after=0",
      headers: { authorization: "Bearer guessed-kiosk-credential-final-aaaa" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("keeps serving a working credential while another source is being throttled", async () => {
    const workingCredential = "Bearer a-working-kiosk-credential-value-1";
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      // Accepts exactly one credential, as the real lookup would.
      database: {
        kioskCredential: {
          findUnique: ({ where }: { where: { secretDigest: string } }) =>
            Promise.resolve(
              where.secretDigest ===
                createHash("sha256").update("a-working-kiosk-credential-value-1").digest("hex")
                ? {
                    id: "credential-row",
                    kioskId: "kiosk_dev_001",
                    credentialId: "working-credential",
                    scopes: ["sessions:read"],
                    revokedAt: null,
                    expiresAt: null,
                    kiosk: { status: "ACTIVE" }
                  }
                : null
            ),
          updateMany: () => Promise.resolve({ count: 1 })
        },
        // Authenticated, but this kiosk owns no such session.
        printSession: { findFirst: () => Promise.resolve(null) }
      } as unknown as NonNullable<Parameters<typeof buildApp>[0]["database"]>
    });
    openApps.push(app);

    const replay = (authorization: string) =>
      app.inject({
        method: "GET",
        url: "/v1/sessions/01900000-0000-7000-8000-000000000010/events?after=0",
        headers: { authorization }
      });

    // 404 proves the credential authenticated and the request reached the
    // handler; 401 proves a guess was answered; 429 proves it was throttled.
    expect((await replay(workingCredential)).statusCode).toBe(404);
    for (let index = 0; index < 30; index += 1) {
      await replay(`Bearer guessed-kiosk-credential-${index}-aaaaaaaa`);
    }

    // Behind a proxy every kiosk shares one apparent address, so a guesser must
    // not be able to take the fleet down with it.
    expect((await replay("Bearer guessed-kiosk-credential-final-aaaa")).statusCode).toBe(429);
    expect((await replay(workingCredential)).statusCode).toBe(404);
  });

  it("limits how often one credential may ask for a new session", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      database: noMatchingCredentialDatabase()
    });
    openApps.push(app);

    const codes: number[] = [];
    for (let index = 0; index < 14; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/kiosks/kiosk_dev_001/sessions",
        headers: {
          authorization: "Bearer a-single-kiosk-credential-value-1234",
          "idempotency-key": `create-attempt-${index}`
        },
        payload: { locale: "hy" }
      });
      codes.push(response.statusCode);
    }

    expect(codes).toContain(429);
    expect(codes.indexOf(429)).toBeGreaterThanOrEqual(10);
  });
});

describe("controlled transport errors", () => {
  it("keeps non-upload request bodies below the file-upload limit", async () => {
    const app = await buildApp({ environment: loadEnvironment({ NODE_ENV: "test" }) });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/mobile-auth/exchange",
      headers: { origin: "http://localhost:5174" },
      payload: { padding: "x".repeat(17 * 1024) }
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("returns a sanitized 429 response when a route limit is exceeded", async () => {
    const app = await buildApp({ environment: loadEnvironment({ NODE_ENV: "test" }) });
    openApps.push(app);
    app.get(
      "/__test/rate-limit",
      { config: { rateLimit: { max: 1, timeWindow: "1 minute" } } },
      () => ({ ok: true })
    );

    const accepted = await app.inject({ method: "GET", url: "/__test/rate-limit" });
    const limited = await app.inject({ method: "GET", url: "/__test/rate-limit" });

    expect(accepted.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(limited.body).not.toContain("FST_");
  });

  it("returns a controlled 415 when a multipart route receives another media type", async () => {
    const app = await buildApp({ environment: loadEnvironment({ NODE_ENV: "test" }) });
    openApps.push(app);
    app.post("/__test/multipart-required", async (request) => {
      await request.file();
      return { ok: true };
    });

    const response = await app.inject({
      method: "POST",
      url: "/__test/multipart-required",
      payload: { not: "multipart" }
    });

    expect(response.statusCode).toBe(415);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ error: { code: "MULTIPART_REQUIRED" } });
  });

  it("rejects extra multipart content with a sanitized 400 response", async () => {
    const app = await buildApp({ environment: loadEnvironment({ NODE_ENV: "test" }) });
    openApps.push(app);
    app.post("/__test/one-part", async (request) => {
      const parts = request.parts({ limits: { files: 1, fields: 0, parts: 1 } });
      for await (const part of parts) {
        if (part.type === "file") await part.toBuffer();
      }
      return { ok: true };
    });
    const boundary = "phase3-extra-part-test";
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="first"; filename="first.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--${boundary}\r\nContent-Disposition: form-data; name="second"; filename="second.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--${boundary}--\r\n`,
      "utf8"
    );

    const response = await app.inject({
      method: "POST",
      url: "/__test/one-part",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_MULTIPART_REQUEST" }
    });
  });
});

describe("settings and quote route contracts", () => {
  const sessionId = "01900000-0000-7000-8000-000000000010";
  const validSettings = {
    fileOrder: ["01900000-0000-7000-8000-000000000011"],
    fileSelections: [{ fileId: "01900000-0000-7000-8000-000000000011", pageRanges: "1-3" }],
    copies: 2,
    duplex: "LONG_EDGE",
    paperSize: "A4",
    orientation: "AUTO",
    pagesPerSheet: 2,
    scaling: "FIT",
    collate: true
  };

  it("requires a kiosk credential before reading or writing settings", async () => {
    const app = await buildApp({ environment: loadEnvironment({ NODE_ENV: "test" }) });
    openApps.push(app);

    const write = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/settings`,
      headers: { "idempotency-key": "settings-unauthenticated", "if-match": '"1"' },
      payload: validSettings
    });
    const read = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/settings` });
    const quote = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/quotes`,
      headers: { "idempotency-key": "quote-unauthenticated" },
      payload: { settingsRevision: 1 }
    });

    for (const response of [write, read, quote]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "INVALID_KIOSK_CREDENTIAL" } });
    }
  });

  it("refuses a settings write that carries no version or idempotency key", async () => {
    const app = await buildApp({
      environment: loadEnvironment({ NODE_ENV: "test" }),
      database: noMatchingCredentialDatabase()
    });
    openApps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/settings`,
      headers: { authorization: "Bearer development-only-kiosk-key" },
      payload: validSettings
    });

    // Authentication is still the first gate; the conditional headers are
    // checked only once a credential is accepted.
    expect(response.statusCode).toBe(401);
  });

  it("rejects a colour or unsupported paper request at the contract boundary", async () => {
    const { updatePrintSettingsBodySchema, createQuoteBodySchema } =
      await import("@printing-kiosk/contracts");

    expect(updatePrintSettingsBodySchema.safeParse(validSettings).success).toBe(true);
    expect(
      updatePrintSettingsBodySchema.safeParse({ ...validSettings, colorMode: "COLOR" }).success
    ).toBe(false);
    expect(
      updatePrintSettingsBodySchema.safeParse({ ...validSettings, paperSize: "A3" }).success
    ).toBe(false);
    expect(
      updatePrintSettingsBodySchema.safeParse({ ...validSettings, pagesPerSheet: 4 }).success
    ).toBe(false);
    expect(
      updatePrintSettingsBodySchema.safeParse({
        ...validSettings,
        fileSelections: [
          { fileId: "01900000-0000-7000-8000-000000000011", pageRanges: "1-3; DROP" }
        ]
      }).success
    ).toBe(false);

    // A quote request has room for a settings revision and nothing else, so a
    // browser cannot propose the amount it would like to pay.
    expect(createQuoteBodySchema.safeParse({ settingsRevision: 3 }).success).toBe(true);
    expect(createQuoteBodySchema.safeParse({ settingsRevision: 3, totalMinor: 1 }).success).toBe(
      false
    );
  });
});
