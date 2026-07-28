import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { createSessionBodySchema, idempotencyKeySchema } from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import type { Clock } from "./crypto.js";
import { ApiError } from "./errors.js";
import { kioskRateLimitKey, type KioskAuthenticationThrottle } from "./rate-limit.js";
import type { SessionService } from "./service.js";

const kioskParamsSchema = z.object({ kioskId: z.string().min(1).max(64) });
const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });

export function registerSessionRoutes(
  app: FastifyInstance,
  dependencies: {
    database: PrismaClient;
    clock: Clock;
    sessions: SessionService;
    kioskAuthentication: KioskAuthenticationThrottle;
    maxSessionsPerMinute?: number;
  }
): void {
  const maxSessionsPerMinute = dependencies.maxSessionsPerMinute ?? 10;

  app.post(
    "/v1/kiosks/:kioskId/sessions",
    {
      config: {
        rateLimit: {
          max: maxSessionsPerMinute,
          timeWindow: "1 minute",
          keyGenerator: kioskRateLimitKey
        }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "sessions:create"
      );
      const params = kioskParamsSchema.parse(request.params);
      if (params.kioskId !== identity.kioskId) throw hiddenKiosk();

      const body = createSessionBodySchema.parse(request.body ?? {});
      const response = await dependencies.sessions.create({
        kioskId: identity.kioskId,
        credentialId: identity.credentialId,
        locale: body.locale,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id
      });

      return reply
        .header("cache-control", "no-store")
        .header("etag", `"${response.session.version}"`)
        .code(201)
        .send(response);
    }
  );

  app.get(
    "/v1/sessions/:sessionId",
    {
      config: {
        rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "sessions:read"
      );
      const params = sessionParamsSchema.parse(request.params);
      const response = await dependencies.sessions.get({
        kioskId: identity.kioskId,
        sessionId: params.sessionId
      });

      return reply
        .header("cache-control", "no-store")
        .header("etag", `"${response.session.version}"`)
        .send(response);
    }
  );

  app.post(
    "/v1/sessions/:sessionId/cancel",
    {
      // The kiosk deliberately retries cancellation until cleanup is confirmed,
      // so this allowance stays above that recovery loop.
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "sessions:cancel"
      );
      const params = sessionParamsSchema.parse(request.params);
      const response = await dependencies.sessions.cancel({
        kioskId: identity.kioskId,
        credentialId: identity.credentialId,
        sessionId: params.sessionId,
        expectedVersion: requireSessionVersion(request),
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id
      });

      return reply
        .header("cache-control", "no-store")
        .header("etag", `"${response.session.version}"`)
        .send(response);
    }
  );
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = singleHeader(request.headers["idempotency-key"]);
  if (!value) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "An Idempotency-Key header is required.");
  }
  return idempotencyKeySchema.parse(value);
}

function requireSessionVersion(request: FastifyRequest): number {
  const value = singleHeader(request.headers["if-match"]);
  const match = value?.match(/^"?(\d+)"?$/);
  if (!match) {
    throw new ApiError(428, "SESSION_VERSION_REQUIRED", "A valid If-Match header is required.");
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(400, "INVALID_SESSION_VERSION", "The session version is invalid.");
  }
  return version;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hiddenKiosk(): ApiError {
  return new ApiError(404, "KIOSK_NOT_FOUND", "Kiosk not found.");
}
