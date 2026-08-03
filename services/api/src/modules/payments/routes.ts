import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  createPaymentBodySchema,
  idempotencyKeySchema,
  paymentWebhookAckSchema,
  simulatePaymentOutcomeBodySchema,
  simulatePaymentOutcomeResponseSchema
} from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";
import type { MockPaymentProvider } from "@printing-kiosk/payment-adapters";

import type { Clock } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { kioskRateLimitKey, type KioskAuthenticationThrottle } from "../sessions/rate-limit.js";
import type { PaymentService } from "./service.js";

const WEBHOOK_BODY_LIMIT_BYTES = 8 * 1024;

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const paymentParamsSchema = z.object({ paymentId: z.string().uuid() });

export interface PaymentRouteDependencies {
  database: PrismaClient;
  clock: Clock;
  payments: PaymentService;
  kioskAuthentication: KioskAuthenticationThrottle;
}

export function registerPaymentRoutes(
  app: FastifyInstance,
  dependencies: PaymentRouteDependencies
): void {
  app.post(
    "/v1/sessions/:sessionId/payments",
    {
      // Starting a payment is a rare, deliberate act. A ceiling this low still
      // covers a customer retrying after every possible decline.
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "payments:create"
      );
      const params = sessionParamsSchema.parse(request.params);
      // The body names the quote to pay and nothing else. There is no field
      // for an amount, so a client cannot propose one.
      const body = createPaymentBodySchema.parse(request.body ?? {});
      const response = await dependencies.payments.create({
        kioskId: identity.kioskId,
        credentialId: identity.credentialId,
        sessionId: params.sessionId,
        quoteId: body.quoteId,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id
      });

      return reply.header("cache-control", "no-store").code(201).send(response);
    }
  );

  app.post(
    "/v1/payments/:paymentId/confirm",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "payments:write"
      );
      const params = paymentParamsSchema.parse(request.params);
      const response = await dependencies.payments.confirm({
        kioskId: identity.kioskId,
        credentialId: identity.credentialId,
        paymentId: params.paymentId,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id
      });

      return reply.header("cache-control", "no-store").send(response);
    }
  );

  app.get(
    "/v1/payments/:paymentId",
    {
      // The kiosk watches a pending payment while the customer stands at the
      // terminal, so this allowance is the one that has to tolerate polling.
      config: {
        rateLimit: { max: 180, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "payments:read"
      );
      const params = paymentParamsSchema.parse(request.params);
      const response = await dependencies.payments.get({
        kioskId: identity.kioskId,
        paymentId: params.paymentId
      });

      return reply.header("cache-control", "no-store").send(response);
    }
  );
}

/**
 * The provider callback endpoint.
 *
 * It is registered in its own plugin scope so the raw bytes survive: a
 * signature covers what the provider sent, and re-serializing parsed JSON
 * would verify a different document. Nothing here trusts the caller — the
 * signature decides, and an unverified body is answered with 401 and no
 * explanation of which check failed.
 */
export async function registerPaymentWebhookRoutes(
  app: FastifyInstance,
  dependencies: { payments: PaymentService }
): Promise<void> {
  await app.register((scope, _options, done) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
      (_request, body, next) => next(null, body)
    );

    scope.post(
      "/v1/webhooks/payments/mock",
      {
        bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
        config: {
          rateLimit: {
            max: 240,
            timeWindow: "1 minute",
            keyGenerator: (request: FastifyRequest) => `payment-webhook:${request.ip}`
          }
        }
      },
      async (request, reply) => {
        await dependencies.payments.handleWebhook({
          rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
          headers: request.headers,
          requestId: request.id
        });

        return reply
          .header("cache-control", "no-store")
          .send(paymentWebhookAckSchema.parse({ received: true }));
      }
    );

    done();
  });
}

/**
 * The deterministic outcome control for the mock provider.
 *
 * It exists so payment behaviour can be exercised without card hardware, and
 * it is registered only when configuration explicitly enables it outside
 * production. It does not decide anything itself: it signs the callback the
 * provider would have sent and feeds it through the same verification path, so
 * what is under test is the real reducer rather than a shortcut around it.
 */
export function registerPaymentOutcomeTestRoutes(
  app: FastifyInstance,
  dependencies: PaymentRouteDependencies & { mockProvider: MockPaymentProvider; clock: Clock }
): void {
  const pending = new Set<NodeJS.Timeout>();
  app.addHook("onClose", () => {
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
  });

  app.post(
    "/v1/test/payments/:paymentId/outcomes",
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
        "payments:write"
      );
      const params = paymentParamsSchema.parse(request.params);
      const body = simulatePaymentOutcomeBodySchema.parse(request.body ?? {});

      // Ownership is checked before anything is signed: one kiosk must not be
      // able to drive another kiosk's payment, even in development.
      const current = await dependencies.payments.get({
        kioskId: identity.kioskId,
        paymentId: params.paymentId
      });
      const signed = dependencies.mockProvider.signOutcome({
        paymentId: current.payment.id,
        outcome: body.outcome,
        amount: {
          amountMinor: current.payment.amountMinor,
          currency: current.payment.currency,
          currencyExponent: current.payment.currencyExponent
        },
        occurredAt: dependencies.clock.now()
      });

      const deliver = async (): Promise<void> => {
        for (let delivery = 0; delivery < body.deliveries; delivery += 1) {
          await dependencies.payments.handleWebhook({
            rawBody: Buffer.from(signed.body, "utf8"),
            headers: signed.headers,
            requestId: request.id
          });
        }
      };

      if (body.delayMilliseconds > 0) {
        const timer = setTimeout(() => {
          pending.delete(timer);
          void deliver().catch(() => undefined);
        }, body.delayMilliseconds);
        timer.unref?.();
        pending.add(timer);

        return reply
          .header("cache-control", "no-store")
          .code(202)
          .send(
            simulatePaymentOutcomeResponseSchema.parse({
              payment: current.payment,
              delivered: 0,
              scheduled: true
            })
          );
      }

      await deliver();
      const settled = await dependencies.payments.get({
        kioskId: identity.kioskId,
        paymentId: params.paymentId
      });

      return reply.header("cache-control", "no-store").send(
        simulatePaymentOutcomeResponseSchema.parse({
          payment: settled.payment,
          delivered: body.deliveries,
          scheduled: false
        })
      );
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
