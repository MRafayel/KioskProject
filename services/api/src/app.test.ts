import { afterEach, describe, expect, it } from "vitest";

import { loadEnvironment } from "@printing-kiosk/config";

import { buildApp } from "./app.js";

const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

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
