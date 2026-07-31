import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { createQuoteBodySchema, idempotencyKeySchema } from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import type { Clock } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { kioskRateLimitKey, type KioskAuthenticationThrottle } from "../sessions/rate-limit.js";
import type { QuoteService } from "./service.js";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const quoteParamsSchema = z.object({
  sessionId: z.string().uuid(),
  quoteId: z.string().uuid()
});

export function registerQuoteRoutes(
  app: FastifyInstance,
  dependencies: {
    database: PrismaClient;
    clock: Clock;
    quotes: QuoteService;
    kioskAuthentication: KioskAuthenticationThrottle;
  }
): void {
  app.post(
    "/v1/sessions/:sessionId/quotes",
    {
      // One price follows each saved settings revision, so this tracks the
      // settings ceiling rather than being set independently of it.
      config: {
        rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "quotes:create"
      );
      const params = sessionParamsSchema.parse(request.params);
      // The request carries a settings revision and nothing else. A client
      // that sends an amount is sending a field this contract does not have.
      const body = createQuoteBodySchema.parse(request.body ?? {});
      const response = await dependencies.quotes.create({
        kioskId: identity.kioskId,
        credentialId: identity.credentialId,
        sessionId: params.sessionId,
        settingsRevision: body.settingsRevision,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id
      });

      return reply.header("cache-control", "no-store").code(201).send(response);
    }
  );

  app.get(
    "/v1/sessions/:sessionId/quotes/:quoteId",
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
        "quotes:read"
      );
      const params = quoteParamsSchema.parse(request.params);
      const response = await dependencies.quotes.get({
        kioskId: identity.kioskId,
        sessionId: params.sessionId,
        quoteId: params.quoteId
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

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
