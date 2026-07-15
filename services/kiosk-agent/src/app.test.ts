import { afterEach, describe, expect, it } from "vitest";

import { loadEnvironment } from "@printing-kiosk/config";

import { buildAgent } from "./app.js";

const openApps: Awaited<ReturnType<typeof buildAgent>>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("kiosk agent health", () => {
  it("is print-only and monochrome", async () => {
    const app = await buildAgent(loadEnvironment({ NODE_ENV: "test" }));
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      productScope: {
        service: "PRINT_ONLY",
        outputMode: "MONOCHROME"
      }
    });
  });
});

describe("kiosk agent session facade", () => {
  it("adds the private kiosk credential when forwarding session creation", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "test",
      API_ORIGIN: "https://api.example.test",
      DEV_KIOSK_API_KEY: "test-kiosk-api-key-000000"
    });
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const app = await buildAgent(environment, {
      upstreamFetch: (input, init) => {
        requests.push({ url: String(input), init });
        return Promise.resolve(
          new Response(JSON.stringify({ session: { id: "session-id" } }), {
            status: 201,
            headers: { "content-type": "application/json", etag: '"1"' }
          })
        );
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { "idempotency-key": "create-session-test-key" },
      payload: { locale: "hy" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.example.test/v1/kiosks/kiosk_dev_001/sessions");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer test-kiosk-api-key-000000"
    );
    expect(requests[0]?.init?.body).toBe(JSON.stringify({ locale: "hy" }));
    expect(response.body).not.toContain(environment.DEV_KIOSK_API_KEY);
  });

  it("returns a controlled error when the cloud API cannot be reached", async () => {
    const app = await buildAgent(loadEnvironment({ NODE_ENV: "test" }), {
      upstreamFetch: () => Promise.reject(new Error("network unavailable"))
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/01900000-0000-7000-8000-000000000010"
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "API_UNAVAILABLE",
        message: "The session service is temporarily unavailable."
      }
    });
  });

  it("forwards cancel conditions without declaring an empty JSON body", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "test",
      API_ORIGIN: "https://api.example.test",
      DEV_KIOSK_API_KEY: "test-kiosk-api-key-000000"
    });
    let forwarded: RequestInit | undefined;
    const app = await buildAgent(environment, {
      upstreamFetch: (_input, init) => {
        forwarded = init;
        return Promise.resolve(
          new Response(JSON.stringify({ session: { state: "CANCELED", version: 2 } }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/01900000-0000-7000-8000-000000000010/cancel",
      headers: {
        "idempotency-key": "cancel-session-test-key",
        "if-match": '"1"'
      }
    });

    expect(response.statusCode).toBe(200);
    const headers = new Headers(forwarded?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-kiosk-api-key-000000");
    expect(headers.get("idempotency-key")).toBe("cancel-session-test-key");
    expect(headers.get("if-match")).toBe('"1"');
    expect(headers.get("content-type")).toBeNull();
    expect(forwarded?.body).toBeUndefined();
  });
});
