import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { idempotencyKeySchema, updatePrintSettingsBodySchema } from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import type { Clock } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { kioskRateLimitKey, type KioskAuthenticationThrottle } from "../sessions/rate-limit.js";
import type { PrintSettingsService } from "./service.js";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });

export function registerSettingsRoutes(
  app: FastifyInstance,
  dependencies: {
    database: PrismaClient;
    clock: Clock;
    settings: PrintSettingsService;
    kioskAuthentication: KioskAuthenticationThrottle;
  }
): void {
  app.put(
    "/v1/sessions/:sessionId/settings",
    {
      // The touchscreen debounces edits to at most one save every 400 ms, so a
      // customer who keeps adjusting copies and page ranges for a full minute
      // can legitimately reach roughly two saves a second. The ceiling sits at
      // that rate: lower would refuse ordinary configuring, higher would stop
      // bounding the revision history a single credential can create.
      config: {
        rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "settings:write"
      );
      const params = sessionParamsSchema.parse(request.params);
      const body = updatePrintSettingsBodySchema.parse(request.body ?? {});
      const response = await dependencies.settings.update({
        kioskId: identity.kioskId,
        credentialId: identity.credentialId,
        sessionId: params.sessionId,
        body,
        expectedVersion: requireSessionVersion(request),
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id
      });

      return reply
        .header("cache-control", "no-store")
        .header("etag", `"${response.sessionVersion}"`)
        .send(response);
    }
  );

  app.get(
    "/v1/sessions/:sessionId/settings",
    {
      config: {
        rateLimit: { max: 90, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
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
      const response = await dependencies.settings.get({
        kioskId: identity.kioskId,
        sessionId: params.sessionId
      });

      return reply.header("cache-control", "no-store").send(response);
    }
  );

  app.get(
    "/v1/sessions/:sessionId/print-capabilities",
    {
      config: {
        rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
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
      const response = await dependencies.settings.capabilities({
        kioskId: identity.kioskId,
        sessionId: params.sessionId
      });

      return reply.header("cache-control", "no-store").send(response);
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
