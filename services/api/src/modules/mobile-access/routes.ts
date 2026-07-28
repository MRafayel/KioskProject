import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { mobileExchangeRequestSchema, publicSessionIdSchema } from "@printing-kiosk/contracts";

import type { SessionEventSource } from "../realtime/session-event-bus.js";
import { ApiError } from "../sessions/errors.js";
import type { MobileAccessService, MobileCookie } from "./service.js";

export const MOBILE_COOKIE_NAME_PREFIX = "pk_upload_";
const publicSessionParamsSchema = z.object({ publicSessionId: publicSessionIdSchema });
const MAX_STREAMS_PER_MOBILE_CLIENT = 2;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * Phone-to-session handoffs are rare per real device, so a tight per-IP
 * ceiling is the intended production behaviour. It is injectable only so an
 * automated suite driving many sessions from one loopback address is not
 * throttled by its own throughput.
 */
const MAX_MOBILE_EXCHANGES_PER_MINUTE = 8;

export function registerMobileAccessRoutes(
  app: FastifyInstance,
  dependencies: {
    mobileAccess: MobileAccessService;
    sessionEvents: SessionEventSource;
    uploadOrigin: string;
    secureCookie: boolean;
    streamLimiter?: MobileSessionStreamLimiter;
    maxExchangesPerMinute?: number;
  }
): void {
  const streamLimiter =
    dependencies.streamLimiter ?? new MobileSessionStreamLimiter(MAX_STREAMS_PER_MOBILE_CLIENT);
  const maxExchangesPerMinute =
    dependencies.maxExchangesPerMinute ?? MAX_MOBILE_EXCHANGES_PER_MINUTE;

  app.post(
    "/v1/mobile-auth/exchange",
    {
      config: { rateLimit: { max: maxExchangesPerMinute, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      assertMobileOrigin(request, dependencies.uploadOrigin);
      const input = mobileExchangeRequestSchema.parse(request.body ?? {});
      const result = await dependencies.mobileAccess.exchange({
        ...input,
        requestId: request.id
      });

      setMobileCookie(
        reply,
        mobileCookieName(result.context.session.id),
        result.cookie,
        dependencies.secureCookie
      );
      return reply.header("cache-control", "no-store").send(result.context);
    }
  );

  app.get(
    "/v1/mobile-auth/:publicSessionId/context",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      const params = publicSessionParamsSchema.parse(request.params);
      const sessionId = await dependencies.mobileAccess.resolveSessionId(params.publicSessionId);
      const identity = await dependencies.mobileAccess.authenticate(
        request.cookies[mobileCookieName(sessionId)],
        sessionId
      );
      return reply
        .header("cache-control", "no-store")
        .send(dependencies.mobileAccess.context(identity));
    }
  );

  app.get(
    "/v1/mobile-auth/:publicSessionId/events/stream",
    {
      // Public venues often place several phones behind one NAT address.
      // Per-client concurrency and credential expiry bound open resources.
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      const params = publicSessionParamsSchema.parse(request.params);
      const sessionId = await dependencies.mobileAccess.resolveSessionId(params.publicSessionId);
      const identity = await dependencies.mobileAccess.authenticate(
        request.cookies[mobileCookieName(sessionId)],
        sessionId
      );
      const releaseStream = streamLimiter.acquire(identity.clientId);

      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-store, no-cache, must-revalidate",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      reply.raw.write("retry: 5000\n: connected\n\n");

      let cleaned = false;
      let unsubscribe: () => void = () => undefined;
      const credentialExpiresIn = Math.min(
        MAX_TIMER_DELAY_MS,
        Math.max(0, identity.expiresAt.getTime() - Date.now())
      );
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
      }, 15_000);
      heartbeat.unref?.();
      const credentialExpiry = setTimeout(() => {
        cleanup();
        if (!reply.raw.destroyed) reply.raw.end();
      }, credentialExpiresIn);
      credentialExpiry.unref?.();
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        clearTimeout(credentialExpiry);
        unsubscribe();
        releaseStream();
      };

      unsubscribe = dependencies.sessionEvents.subscribe(sessionId, (event) => {
        const isFileChange =
          event.type === "file.ready" ||
          event.type === "file.rejected" ||
          event.type === "file.deleted";
        const isTerminal = event.type === "session.canceled" || event.type === "session.expired";
        if (!isFileChange && !isTerminal) return;
        if (reply.raw.destroyed) return;

        reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        if (!isTerminal) return;

        cleanup();
        reply.raw.end();
      });
      request.raw.once("close", cleanup);
      reply.raw.once("close", cleanup);
      reply.raw.once("error", cleanup);
    }
  );
}

export class MobileSessionStreamLimiter {
  private readonly activeByClient = new Map<string, number>();

  public constructor(private readonly maximumPerClient: number) {
    if (!Number.isInteger(maximumPerClient) || maximumPerClient < 1) {
      throw new Error("INVALID_MOBILE_STREAM_LIMIT");
    }
  }

  public acquire(clientId: string): () => void {
    const active = this.activeByClient.get(clientId) ?? 0;
    if (active >= this.maximumPerClient) {
      throw new ApiError(
        429,
        "MOBILE_STREAM_LIMIT_REACHED",
        "Too many realtime connections are open for this mobile session."
      );
    }
    this.activeByClient.set(clientId, active + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.activeByClient.get(clientId) ?? 1) - 1;
      if (remaining > 0) this.activeByClient.set(clientId, remaining);
      else this.activeByClient.delete(clientId);
    };
  }
}

export function assertMobileOrigin(request: FastifyRequest, expectedOrigin: string): void {
  const supplied = singleHeader(request.headers.origin);
  if (!supplied || supplied !== new URL(expectedOrigin).origin) {
    throw new ApiError(403, "INVALID_REQUEST_ORIGIN", "The request origin is not allowed.");
  }
}

export function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function mobileCookieName(sessionId: string): string {
  return `${MOBILE_COOKIE_NAME_PREFIX}${sessionId.replaceAll("-", "")}`;
}

function setMobileCookie(
  reply: FastifyReply,
  name: string,
  cookie: MobileCookie,
  secure: boolean
): void {
  const maxAge = Math.max(
    0,
    Math.floor((cookie.expiresAt.getTime() - cookie.issuedAt.getTime()) / 1_000)
  );
  reply.setCookie(name, cookie.value, {
    path: "/v1",
    httpOnly: true,
    secure,
    sameSite: "strict",
    maxAge,
    expires: cookie.expiresAt
  });
}
