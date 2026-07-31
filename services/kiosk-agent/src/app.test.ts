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

  it("forwards the kiosk-owned file snapshot without exposing the device credential", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "test",
      API_ORIGIN: "https://api.example.test",
      DEV_KIOSK_API_KEY: "test-kiosk-api-key-000000"
    });
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const upstreamBody = {
      items: [
        {
          id: "01900000-0000-7000-8000-000000000011",
          ordinal: 0,
          status: "QUARANTINED",
          kind: "PDF",
          pageCount: null,
          processingRevision: 1,
          rejectionCode: null,
          sizeBytes: 2048,
          createdAt: "2030-01-01T00:00:00.000Z"
        }
      ]
    };
    const app = await buildAgent(environment, {
      upstreamFetch: (input, init) => {
        requests.push({ url: String(input), init });
        return Promise.resolve(
          new Response(JSON.stringify(upstreamBody), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/sessions/01900000-0000-7000-8000-000000000010/files"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(upstreamBody);
    expect(requests[0]?.url).toBe(
      "https://api.example.test/v1/sessions/01900000-0000-7000-8000-000000000010/files"
    );
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer test-kiosk-api-key-000000"
    );
    expect(response.body).not.toContain(environment.DEV_KIOSK_API_KEY);
  });

  it("proxies page metadata and an idempotent kiosk-owned delete", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "test",
      API_ORIGIN: "https://api.example.test",
      DEV_KIOSK_API_KEY: "test-kiosk-api-key-000000"
    });
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const app = await buildAgent(environment, {
      upstreamFetch: (input, init) => {
        requests.push({ url: String(input), init });
        if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              fileId: "01900000-0000-7000-8000-000000000011",
              processingRevision: 1,
              pageCount: 1,
              items: [
                {
                  pageNumber: 1,
                  widthPixels: 850,
                  heightPixels: 1200,
                  previewAvailable: true
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }
    });
    openApps.push(app);

    const pages = await app.inject({
      method: "GET",
      url:
        "/v1/sessions/01900000-0000-7000-8000-000000000010" +
        "/files/01900000-0000-7000-8000-000000000011/pages"
    });
    const deleted = await app.inject({
      method: "DELETE",
      url:
        "/v1/sessions/01900000-0000-7000-8000-000000000010" +
        "/files/01900000-0000-7000-8000-000000000011",
      headers: { "idempotency-key": "kiosk-delete-01900000-0000-7000-8000-000000000011" }
    });

    expect(pages.statusCode).toBe(200);
    expect(pages.headers["cache-control"]).toBe("no-store");
    expect(deleted.statusCode).toBe(204);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.example.test/v1/sessions/01900000-0000-7000-8000-000000000010/files/01900000-0000-7000-8000-000000000011/pages",
      "https://api.example.test/v1/sessions/01900000-0000-7000-8000-000000000010/files/01900000-0000-7000-8000-000000000011"
    ]);
    for (const request of requests) {
      expect(new Headers(request.init?.headers).get("authorization")).toBe(
        "Bearer test-kiosk-api-key-000000"
      );
    }
    expect(new Headers(requests[1]?.init?.headers).get("idempotency-key")).toBe(
      "kiosk-delete-01900000-0000-7000-8000-000000000011"
    );
  });

  it("streams only bounded WebP previews with private response headers", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "test",
      API_ORIGIN: "https://api.example.test",
      DEV_KIOSK_API_KEY: "test-kiosk-api-key-000000"
    });
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x57, 0x45, 0x42, 0x50]);
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const app = await buildAgent(environment, {
      upstreamFetch: (input, init) => {
        request = { url: String(input), init };
        return Promise.resolve(
          new Response(webp, {
            status: 200,
            headers: {
              "content-length": String(webp.byteLength),
              "content-type": "image/webp"
            }
          })
        );
      }
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url:
        "/v1/sessions/01900000-0000-7000-8000-000000000010" +
        "/files/01900000-0000-7000-8000-000000000011/pages/1/preview?revision=1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.headers["content-length"]).toBe(String(webp.byteLength));
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.rawPayload).toEqual(Buffer.from(webp));
    expect(request?.url).toBe(
      "https://api.example.test/v1/sessions/01900000-0000-7000-8000-000000000010/files/01900000-0000-7000-8000-000000000011/pages/1/preview?revision=1"
    );
    expect(new Headers(request?.init?.headers).get("authorization")).toBe(
      "Bearer test-kiosk-api-key-000000"
    );
    expect(new Headers(request?.init?.headers).get("accept")).toBe("image/webp");
  });

  it("uses the configured document page limit when validating preview routes", async () => {
    const environment = loadEnvironment({
      NODE_ENV: "test",
      API_ORIGIN: "https://api.example.test",
      DEV_KIOSK_API_KEY: "test-kiosk-api-key-000000",
      MAX_DOCUMENT_PAGES: "250",
      MAX_PREVIEW_FILE_BYTES: "1048576"
    });
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x57, 0x45, 0x42, 0x50]);
    const requests: string[] = [];
    const app = await buildAgent(environment, {
      upstreamFetch: (input) => {
        requests.push(String(input));
        return Promise.resolve(
          new Response(webp, {
            status: 200,
            headers: {
              "content-length": String(webp.byteLength),
              "content-type": "image/webp"
            }
          })
        );
      }
    });
    openApps.push(app);

    const accepted = await app.inject({
      method: "GET",
      url:
        "/v1/sessions/01900000-0000-7000-8000-000000000010" +
        "/files/01900000-0000-7000-8000-000000000011/pages/201/preview?revision=1"
    });
    const rejected = await app.inject({
      method: "GET",
      url:
        "/v1/sessions/01900000-0000-7000-8000-000000000010" +
        "/files/01900000-0000-7000-8000-000000000011/pages/251/preview?revision=1"
    });

    expect(accepted.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: "INVALID_FILE_REQUEST" } });
    expect(requests).toEqual([
      "https://api.example.test/v1/sessions/01900000-0000-7000-8000-000000000010/files/01900000-0000-7000-8000-000000000011/pages/201/preview?revision=1"
    ]);
  });

  it("rejects an upstream preview with an unsafe media type", async () => {
    const app = await buildAgent(
      loadEnvironment({
        NODE_ENV: "test",
        API_ORIGIN: "https://api.example.test",
        DEV_KIOSK_API_KEY: "test-kiosk-api-key-000000"
      }),
      {
        upstreamFetch: () =>
          Promise.resolve(
            new Response("<svg/>", {
              status: 200,
              headers: { "content-length": "6", "content-type": "image/svg+xml" }
            })
          )
      }
    );
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url:
        "/v1/sessions/01900000-0000-7000-8000-000000000010" +
        "/files/01900000-0000-7000-8000-000000000011/pages/1/preview?revision=1"
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_PREVIEW_RESPONSE" } });
    expect(response.body).not.toContain("<svg");
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

describe("kiosk agent settings and pricing facade", () => {
  const sessionId = "01900000-0000-7000-8000-000000000010";

  function agentWithUpstream(status = 200, body: unknown = { ok: true }) {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const environment = loadEnvironment({
      NODE_ENV: "test",
      API_ORIGIN: "https://api.example.test",
      DEV_KIOSK_API_KEY: "test-kiosk-api-key-000000"
    });
    return {
      environment,
      requests,
      build: () =>
        buildAgent(environment, {
          upstreamFetch: (input, init) => {
            requests.push({ url: String(input), init });
            return Promise.resolve(
              new Response(JSON.stringify(body), {
                status,
                headers: { "content-type": "application/json", etag: '"9"' }
              })
            );
          }
        })
    };
  }

  it("forwards a settings write with the kiosk credential and both preconditions", async () => {
    const upstream = agentWithUpstream();
    const app = await upstream.build();
    openApps.push(app);
    const payload = {
      fileOrder: ["01900000-0000-7000-8000-000000000011"],
      fileSelections: [{ fileId: "01900000-0000-7000-8000-000000000011", pageRanges: "1-3" }],
      copies: 2,
      duplex: "LONG_EDGE",
      paperSize: "A4",
      orientation: "AUTO",
      scaling: "FIT",
      collate: true
    };

    const response = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/settings`,
      headers: { "idempotency-key": "settings-key-000001", "if-match": '"8"' },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(upstream.requests[0]?.url).toBe(
      `https://api.example.test/v1/sessions/${sessionId}/settings`
    );
    const headers = new Headers(upstream.requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-kiosk-api-key-000000");
    expect(headers.get("if-match")).toBe('"8"');
    expect(headers.get("idempotency-key")).toBe("settings-key-000001");
    expect(upstream.requests[0]?.init?.body).toBe(JSON.stringify(payload));
    expect(response.body).not.toContain(upstream.environment.DEV_KIOSK_API_KEY);
  });

  it("refuses a settings write that would lose the optimistic version", async () => {
    const upstream = agentWithUpstream();
    const app = await upstream.build();
    openApps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: `/v1/sessions/${sessionId}/settings`,
      headers: { "idempotency-key": "settings-key-000002" },
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "CONDITIONAL_REQUEST_HEADERS_REQUIRED" }
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it("forwards a quote request and refuses one without an idempotency key", async () => {
    const upstream = agentWithUpstream(201, { quote: { id: "quote-id" } });
    const app = await upstream.build();
    openApps.push(app);

    const created = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/quotes`,
      headers: { "idempotency-key": "quote-key-000001" },
      payload: { settingsRevision: 3 }
    });
    const unkeyed = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/quotes`,
      payload: { settingsRevision: 3 }
    });

    expect(created.statusCode).toBe(201);
    expect(upstream.requests[0]?.init?.body).toBe(JSON.stringify({ settingsRevision: 3 }));
    expect(unkeyed.statusCode).toBe(400);
    expect(upstream.requests).toHaveLength(1);
  });

  it("rejects malformed session and quote identifiers before reaching the API", async () => {
    const upstream = agentWithUpstream();
    const app = await upstream.build();
    openApps.push(app);

    const badSession = await app.inject({
      method: "GET",
      url: "/v1/sessions/not-a-uuid/print-capabilities"
    });
    const badQuote = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/quotes/not-a-uuid`
    });

    expect(badSession.statusCode).toBe(400);
    expect(badQuote.statusCode).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });
});
