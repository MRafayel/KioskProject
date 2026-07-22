import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { mobileExchangeRequestSchema, publicSessionIdSchema } from "@printing-kiosk/contracts";

import { ApiError } from "../sessions/errors.js";
import type { MobileAccessService, MobileCookie } from "./service.js";

export const MOBILE_COOKIE_NAME_PREFIX = "pk_upload_";
const publicSessionParamsSchema = z.object({ publicSessionId: publicSessionIdSchema });

export function registerMobileAccessRoutes(
  app: FastifyInstance,
  dependencies: {
    mobileAccess: MobileAccessService;
    uploadOrigin: string;
    secureCookie: boolean;
  }
): void {
  app.post(
    "/v1/mobile-auth/exchange",
    {
      config: { rateLimit: { max: 8, timeWindow: "1 minute" } }
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
