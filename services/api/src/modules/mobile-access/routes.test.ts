import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@printing-kiosk/contracts";

import type { SessionEventSource } from "../realtime/session-event-bus.js";
import { ApiError } from "../sessions/errors.js";
import {
  MobileSessionStreamLimiter,
  registerMobileAccessRoutes,
  mobileCookieName
} from "./routes.js";
import type { MobileAccessService } from "./service.js";

const publicSessionId = "ps_1234567890abcdef";
const sessionId = "01900000-0000-7000-8000-000000000091";
const mobileCookie = `m_${"C".repeat(43)}`;
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("mobile session event stream", () => {
  it("emits authorized file changes and closes only after a terminal event", async () => {
    const authenticate = vi.fn().mockResolvedValue({
      clientId: "01900000-0000-7000-8000-000000000093",
      sessionId,
      expiresAt: new Date(Date.now() + 60_000)
    });
    const unsubscribe = vi.fn();
    const fileEvent = deletedEvent();
    const terminalEvent = canceledEvent();
    const sessionEvents: SessionEventSource = {
      subscribe: (subscribedSessionId, listener) => {
        expect(subscribedSessionId).toBe(sessionId);
        queueMicrotask(() => {
          listener(fileEvent);
          listener(terminalEvent);
        });
        return unsubscribe;
      }
    };
    const mobileAccess = {
      resolveSessionId: vi.fn().mockResolvedValue(sessionId),
      authenticate
    } as unknown as MobileAccessService;
    const app = Fastify();
    openApps.push(app);
    await app.register(cookie);
    registerMobileAccessRoutes(app, {
      mobileAccess,
      sessionEvents,
      uploadOrigin: "https://upload.example.test",
      secureCookie: true
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/mobile-auth/${publicSessionId}/events/stream`,
      headers: { cookie: `${mobileCookieName(sessionId)}=${mobileCookie}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(authenticate).toHaveBeenCalledWith(mobileCookie, sessionId);
    expect(response.body).toContain(`id: ${fileEvent.sequence}`);
    expect(response.body).toContain(`"type":"file.deleted"`);
    expect(response.body).toContain(`id: ${terminalEvent.sequence}`);
    expect(response.body).toContain(`"type":"session.canceled"`);
    expect(response.body).not.toContain(mobileCookie);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("bounds concurrent streams per authenticated mobile client", () => {
    const limiter = new MobileSessionStreamLimiter(2);
    const releaseFirst = limiter.acquire("mobile-client-1");
    const releaseSecond = limiter.acquire("mobile-client-1");

    expect(() => limiter.acquire("mobile-client-1")).toThrow(
      expect.objectContaining({
        statusCode: 429,
        code: "MOBILE_STREAM_LIMIT_REACHED"
      })
    );

    releaseFirst();
    const releaseThird = limiter.acquire("mobile-client-1");
    releaseFirst();
    releaseSecond();
    releaseThird();
  });

  it("closes and unsubscribes when the scoped mobile credential expires", async () => {
    const unsubscribe = vi.fn();
    const mobileAccess = {
      resolveSessionId: vi.fn().mockResolvedValue(sessionId),
      authenticate: vi.fn().mockResolvedValue({
        clientId: "01900000-0000-7000-8000-000000000094",
        sessionId,
        expiresAt: new Date(Date.now() + 20)
      })
    } as unknown as MobileAccessService;
    const app = Fastify();
    openApps.push(app);
    await app.register(cookie);
    registerMobileAccessRoutes(app, {
      mobileAccess,
      sessionEvents: { subscribe: () => unsubscribe },
      uploadOrigin: "https://upload.example.test",
      secureCookie: true
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/mobile-auth/${publicSessionId}/events/stream`,
      headers: { cookie: `${mobileCookieName(sessionId)}=${mobileCookie}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(": connected");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects an invalid scoped cookie before subscribing", async () => {
    const subscribe = vi.fn();
    const mobileAccess = {
      resolveSessionId: vi.fn().mockResolvedValue(sessionId),
      authenticate: vi
        .fn()
        .mockRejectedValue(
          new ApiError(401, "INVALID_MOBILE_SESSION", "Mobile authentication failed.")
        )
    } as unknown as MobileAccessService;
    const app = Fastify();
    openApps.push(app);
    await app.register(cookie);
    registerMobileAccessRoutes(app, {
      mobileAccess,
      sessionEvents: { subscribe },
      uploadOrigin: "https://upload.example.test",
      secureCookie: true
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/mobile-auth/${publicSessionId}/events/stream`
    });

    expect(response.statusCode).toBe(401);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

function canceledEvent(): SessionEvent {
  return {
    id: "01900000-0000-7000-8000-000000000092",
    sessionId,
    sequence: 3,
    type: "session.canceled",
    payload: { sessionId, state: "CANCELED", version: 2 },
    occurredAt: "2030-01-01T00:00:03.000Z"
  };
}

function deletedEvent(): SessionEvent {
  return {
    id: "01900000-0000-7000-8000-000000000095",
    sessionId,
    sequence: 2,
    type: "file.deleted",
    payload: {
      sessionId,
      fileId: "01900000-0000-7000-8000-000000000096"
    },
    occurredAt: "2030-01-01T00:00:02.000Z"
  };
}
