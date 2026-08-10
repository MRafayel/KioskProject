import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "./authorize.js";
import { registerAdminRoutes } from "./routes.js";
import type { AdminService, AuthenticatedAdmin } from "./service.js";

const ADMIN_ORIGIN = "https://admin.example.test";
const CUSTOMER_ORIGIN = "https://kiosk.example.test";
const NOW = new Date("2026-08-10T12:00:00.000Z");
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("admin browser-origin boundary", () => {
  it("rejects a credentialed customer-origin read before resolving the admin session", async () => {
    const { app, admin } = await buildAdminApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { origin: CUSTOMER_ORIGIN, cookie: sessionCookies() }
    });

    expect(response.statusCode).toBe(403);
    expect(admin.resolveSession).not.toHaveBeenCalled();
  });

  it("rejects a customer-origin mutation before revoking anything", async () => {
    const { app, admin } = await buildAdminApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: {
        origin: CUSTOMER_ORIGIN,
        cookie: sessionCookies(),
        "x-csrf-token": "csrf-token"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(admin.revokeSession).not.toHaveBeenCalled();
  });

  it("accepts the exact admin origin and non-browser requests without an Origin header", async () => {
    const { app } = await buildAdminApp();
    const browser = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { origin: ADMIN_ORIGIN, cookie: sessionCookies() }
    });
    const nonBrowser = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { cookie: sessionCookies() }
    });

    expect(browser.statusCode).toBe(200);
    expect(nonBrowser.statusCode).toBe(200);
  });

  it("rejects an opaque browser origin", async () => {
    const { app } = await buildAdminApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: { origin: "null", cookie: sessionCookies() }
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects an Origin-less browser request forwarded by a customer app", async () => {
    const { app, admin } = await buildAdminApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: {
        host: "kiosk.example.test",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        cookie: sessionCookies()
      }
    });

    expect(response.statusCode).toBe(403);
    expect(admin.resolveSession).not.toHaveBeenCalled();
  });

  it("accepts an Origin-less same-origin browser request through the admin host", async () => {
    const { app } = await buildAdminApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: {
        host: "admin.example.test",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        cookie: sessionCookies()
      }
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects a legacy browser with no Origin or Fetch Metadata on a customer host", async () => {
    const { app, admin } = await buildAdminApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/me",
      headers: {
        host: "upload.example.test",
        "user-agent": "Mozilla/5.0 ExampleBrowser/1.0",
        cookie: sessionCookies()
      }
    });

    expect(response.statusCode).toBe(403);
    expect(admin.resolveSession).not.toHaveBeenCalled();
  });
});

describe("admin session cookies", () => {
  it("emits valid Secure __Host cookies on login, including local HTTP development", async () => {
    const { app } = await buildAdminApp("http://localhost:5175");
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/authentication/verify",
      payload: {
        ceremonyId: "00000000-0000-7000-8000-000000000010",
        credential: {
          id: "credential-id",
          rawId: "credential-id",
          type: "public-key",
          response: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const setCookies = asHeaderList(response.headers["set-cookie"]);
    const session = setCookies.find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE}=`));
    const csrf = setCookies.find((value) => value.startsWith(`${ADMIN_CSRF_COOKIE}=`));

    expect(session).toContain("Secure");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Path=/");
    expect(csrf).toContain("Secure");
    expect(csrf).toContain("Path=/");
    expect(csrf).not.toContain("HttpOnly");
  });

  it("uses matching Secure __Host attributes when clearing cookies", async () => {
    const { app } = await buildAdminApp("http://localhost:5175");
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/logout",
      headers: { cookie: sessionCookies(), "x-csrf-token": "csrf-token" }
    });

    expect(response.statusCode).toBe(204);
    const setCookies = asHeaderList(response.headers["set-cookie"]);
    expect(setCookies).toHaveLength(2);
    for (const value of setCookies) {
      expect(value).toContain("Secure");
      expect(value).toContain("Path=/");
      expect(value).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    }
  });
});

async function buildAdminApp(adminOrigin = ADMIN_ORIGIN) {
  const identity = authenticatedAdmin();
  const admin = {
    beginAuthentication: vi.fn().mockResolvedValue({ ceremonyId: "unused", options: {} }),
    completeAuthentication: vi.fn().mockResolvedValue({
      admin: identity,
      cookies: {
        sessionToken: "session-token",
        csrfToken: "csrf-token",
        idleExpiresAt: identity.idleExpiresAt,
        hardExpiresAt: identity.hardExpiresAt
      }
    }),
    resolveSession: vi.fn().mockResolvedValue(identity),
    verifyCsrf: vi.fn().mockResolvedValue(true),
    revokeSession: vi.fn().mockResolvedValue(undefined)
  };
  const app = Fastify();
  openApps.push(app);
  await app.register(cookie);
  registerAdminRoutes(app, {
    admin: admin as unknown as AdminService,
    adminOrigin,
    clock: { now: () => NOW },
    stepUpTtlMilliseconds: 5 * 60_000
  });
  return { app, admin };
}

function authenticatedAdmin(): AuthenticatedAdmin {
  return {
    adminUserId: "00000000-0000-7000-8000-000000000001",
    displayName: "Test Admin",
    role: "ADMIN",
    sessionId: "00000000-0000-7000-8000-000000000002",
    idleExpiresAt: new Date(NOW.getTime() + 15 * 60_000),
    hardExpiresAt: new Date(NOW.getTime() + 4 * 60 * 60_000),
    lastStepUpAt: NOW,
    kioskScopes: []
  };
}

function sessionCookies(): string {
  return `${ADMIN_SESSION_COOKIE}=session-token; ${ADMIN_CSRF_COOKIE}=csrf-token`;
}

function asHeaderList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
