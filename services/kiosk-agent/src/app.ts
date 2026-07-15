import helmet from "@fastify/helmet";
import Fastify, { LogController, type FastifyInstance, type FastifyReply } from "fastify";

import type { Environment } from "@printing-kiosk/config";
import { PRODUCT_SCOPE, healthResponseSchema } from "@printing-kiosk/contracts";

type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface BuildAgentOptions {
  upstreamFetch?: UpstreamFetch;
}

export async function buildAgent(
  environment: Environment,
  options: BuildAgentOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    logController: new LogController({
      disableRequestLogging: true
    })
  });

  await app.register(helmet);

  app.addHook("onRequest", async (request, reply) => {
    if (!request.ip.startsWith("127.") && request.ip !== "::1") {
      await reply.code(403).send({ error: { code: "LOOPBACK_ONLY" } });
    }
  });

  app.get("/health/live", () =>
    healthResponseSchema.parse({
      status: "ok",
      service: "kiosk-agent",
      timestamp: new Date().toISOString(),
      productScope: PRODUCT_SCOPE
    })
  );

  app.get("/health/ready", () =>
    healthResponseSchema.parse({
      status: "ready",
      service: "kiosk-agent",
      timestamp: new Date().toISOString(),
      productScope: PRODUCT_SCOPE
    })
  );

  const upstreamFetch = options.upstreamFetch ?? globalThis.fetch;

  app.post("/v1/sessions", async (request, reply) => {
    const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
    if (!idempotencyKey) {
      return reply.code(400).send({
        error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key is required." }
      });
    }

    return forwardApiResponse(
      upstreamFetch,
      environment,
      `/v1/kiosks/${encodeURIComponent(environment.DEV_KIOSK_ID)}/sessions`,
      {
        method: "POST",
        headers: upstreamHeaders(environment, {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        }),
        body: JSON.stringify(request.body ?? {})
      },
      reply
    );
  });

  app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId", (request, reply) =>
    forwardApiResponse(
      upstreamFetch,
      environment,
      `/v1/sessions/${encodeURIComponent(request.params.sessionId)}`,
      { method: "GET", headers: upstreamHeaders(environment) },
      reply
    )
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/cancel",
    async (request, reply) => {
      const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
      const ifMatch = singleHeader(request.headers["if-match"]);
      if (!idempotencyKey || !ifMatch) {
        return reply.code(400).send({
          error: {
            code: "CONDITIONAL_REQUEST_HEADERS_REQUIRED",
            message: "Idempotency-Key and If-Match are required."
          }
        });
      }

      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}/cancel`,
        {
          method: "POST",
          headers: upstreamHeaders(environment, {
            "idempotency-key": idempotencyKey,
            "if-match": ifMatch
          })
        },
        reply
      );
    }
  );

  return app;
}

function upstreamHeaders(
  environment: Environment,
  additional: Readonly<Record<string, string>> = {}
): Record<string, string> {
  return {
    authorization: `Bearer ${environment.DEV_KIOSK_API_KEY}`,
    ...additional
  };
}

async function forwardApiResponse(
  upstreamFetch: UpstreamFetch,
  environment: Environment,
  path: string,
  init: RequestInit,
  reply: FastifyReply
) {
  try {
    const response = await upstreamFetch(new URL(path, environment.API_ORIGIN), init);
    const etag = response.headers.get("etag");
    if (etag) reply.header("etag", etag);
    reply.header("cache-control", "no-store");

    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "application/json";
    const body: unknown =
      contentType.includes("application/json") && text ? (JSON.parse(text) as unknown) : text;
    return reply.code(response.status).send(body);
  } catch {
    return reply.code(503).send({
      error: {
        code: "API_UNAVAILABLE",
        message: "The session service is temporarily unavailable."
      }
    });
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
