import helmet from "@fastify/helmet";
import Fastify, { LogController, type FastifyInstance, type FastifyReply } from "fastify";
import { Readable } from "node:stream";

import type { Environment } from "@printing-kiosk/config";
import {
  PRODUCT_SCOPE,
  createPaymentBodySchema,
  createPrintJobBodySchema,
  healthResponseSchema,
  idempotencyKeySchema,
  simulatePaymentOutcomeBodySchema
} from "@printing-kiosk/contracts";

import type { SessionEventSource } from "./events.js";

type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
const API_FORWARD_TIMEOUT_MS = 10_000;

export interface BuildAgentOptions {
  upstreamFetch?: UpstreamFetch;
  eventSource?: SessionEventSource;
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

  app.get<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId/files", (request, reply) =>
    forwardApiResponse(
      upstreamFetch,
      environment,
      `/v1/sessions/${encodeURIComponent(request.params.sessionId)}/files`,
      { method: "GET", headers: upstreamHeaders(environment) },
      reply
    )
  );

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/print-capabilities",
    (request, reply) => {
      if (!UUID_PATTERN.test(request.params.sessionId)) return invalidSessionRequest(reply);
      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}/print-capabilities`,
        { method: "GET", headers: upstreamHeaders(environment, { accept: "application/json" }) },
        reply
      );
    }
  );

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/settings",
    (request, reply) => {
      if (!UUID_PATTERN.test(request.params.sessionId)) return invalidSessionRequest(reply);
      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}/settings`,
        { method: "GET", headers: upstreamHeaders(environment, { accept: "application/json" }) },
        reply
      );
    }
  );

  app.put<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/settings",
    (request, reply) => {
      const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
      const ifMatch = singleHeader(request.headers["if-match"]);
      if (!UUID_PATTERN.test(request.params.sessionId)) return invalidSessionRequest(reply);
      if (!idempotencyKey || !ifMatch) return conditionalHeadersRequired(reply);

      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}/settings`,
        {
          method: "PUT",
          headers: upstreamHeaders(environment, {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
            "if-match": ifMatch
          }),
          body: JSON.stringify(request.body ?? {})
        },
        reply
      );
    }
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/quotes",
    (request, reply) => {
      const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
      if (!UUID_PATTERN.test(request.params.sessionId)) return invalidSessionRequest(reply);
      if (!idempotencyKey) return conditionalHeadersRequired(reply);

      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}/quotes`,
        {
          method: "POST",
          headers: upstreamHeaders(environment, {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": idempotencyKey
          }),
          // The kiosk browser never proposes an amount. Only the settings
          // revision it wants priced reaches the control plane.
          body: JSON.stringify(request.body ?? {})
        },
        reply
      );
    }
  );

  app.get<{ Params: { sessionId: string; quoteId: string } }>(
    "/v1/sessions/:sessionId/quotes/:quoteId",
    (request, reply) => {
      if (
        !UUID_PATTERN.test(request.params.sessionId) ||
        !UUID_PATTERN.test(request.params.quoteId)
      ) {
        return invalidSessionRequest(reply);
      }
      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}` +
          `/quotes/${encodeURIComponent(request.params.quoteId)}`,
        { method: "GET", headers: upstreamHeaders(environment, { accept: "application/json" }) },
        reply
      );
    }
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/payments",
    (request, reply) => {
      const idempotencyKey = idempotencyKeySchema.safeParse(
        singleHeader(request.headers["idempotency-key"])
      );
      const body = createPaymentBodySchema.safeParse(request.body ?? {});
      if (!UUID_PATTERN.test(request.params.sessionId)) return invalidSessionRequest(reply);
      if (!idempotencyKey.success) return idempotencyKeyRequired(reply);
      if (!body.success) return invalidPaymentRequest(reply);

      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}/payments`,
        {
          method: "POST",
          headers: upstreamHeaders(environment, {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": idempotencyKey.data
          }),
          // The browser names the quote it wants to pay. It never states an
          // amount. Re-serializing the allowlisted contract also ensures an
          // unexpected field cannot be forwarded under the device credential.
          body: JSON.stringify(body.data)
        },
        reply
      );
    }
  );

  app.post<{ Params: { paymentId: string } }>(
    "/v1/payments/:paymentId/confirm",
    (request, reply) => {
      const idempotencyKey = idempotencyKeySchema.safeParse(
        singleHeader(request.headers["idempotency-key"])
      );
      if (!UUID_PATTERN.test(request.params.paymentId)) return invalidPaymentRequest(reply);
      if (!idempotencyKey.success) return idempotencyKeyRequired(reply);

      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/payments/${encodeURIComponent(request.params.paymentId)}/confirm`,
        {
          method: "POST",
          headers: upstreamHeaders(environment, {
            accept: "application/json",
            "idempotency-key": idempotencyKey.data
          })
        },
        reply
      );
    }
  );

  app.get<{ Params: { paymentId: string } }>("/v1/payments/:paymentId", (request, reply) => {
    if (!UUID_PATTERN.test(request.params.paymentId)) return invalidPaymentRequest(reply);
    return forwardApiResponse(
      upstreamFetch,
      environment,
      `/v1/payments/${encodeURIComponent(request.params.paymentId)}`,
      { method: "GET", headers: upstreamHeaders(environment, { accept: "application/json" }) },
      reply
    );
  });

  // Standing in for a payment terminal. The pilot has no card hardware, so the
  // touchscreen drives the deterministic provider scenarios instead — and only
  // where configuration has explicitly enabled them outside production, so no
  // production build of this agent can offer the route at all.
  if (environment.PAYMENT_TEST_OUTCOMES_ENABLED && environment.NODE_ENV !== "production") {
    app.post<{ Params: { paymentId: string } }>(
      "/v1/payments/:paymentId/simulate",
      (request, reply) => {
        if (!UUID_PATTERN.test(request.params.paymentId)) return invalidPaymentRequest(reply);
        const body = simulatePaymentOutcomeBodySchema.safeParse(request.body ?? {});
        if (!body.success) return invalidPaymentRequest(reply);
        return forwardApiResponse(
          upstreamFetch,
          environment,
          `/v1/test/payments/${encodeURIComponent(request.params.paymentId)}/outcomes`,
          {
            method: "POST",
            headers: upstreamHeaders(environment, {
              accept: "application/json",
              "content-type": "application/json"
            }),
            body: JSON.stringify(body.data)
          },
          reply
        );
      }
    );
  }

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/print-jobs",
    (request, reply) => {
      const idempotencyKey = idempotencyKeySchema.safeParse(
        singleHeader(request.headers["idempotency-key"])
      );
      // The browser names the capture it is printing. It cannot describe what
      // to print: re-serializing the allowlisted contract also ensures an
      // unexpected field cannot be forwarded under the device credential.
      const body = createPrintJobBodySchema.safeParse(request.body ?? {});
      if (!UUID_PATTERN.test(request.params.sessionId)) return invalidSessionRequest(reply);
      if (!idempotencyKey.success) return idempotencyKeyRequired(reply);
      if (!body.success) return invalidPrintRequest(reply);
      // The scenario control exists only where the deployment enabled it, so a
      // production agent cannot forward a request to fail a paid print.
      if (
        body.data.simulatedOutcome !== undefined &&
        !(environment.PRINT_TEST_OUTCOMES_ENABLED && environment.NODE_ENV !== "production")
      ) {
        return invalidPrintRequest(reply);
      }

      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}/print-jobs`,
        {
          method: "POST",
          headers: upstreamHeaders(environment, {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": idempotencyKey.data
          }),
          body: JSON.stringify(body.data)
        },
        reply
      );
    }
  );

  app.get<{ Params: { printJobId: string } }>("/v1/print-jobs/:printJobId", (request, reply) => {
    if (!UUID_PATTERN.test(request.params.printJobId)) return invalidPrintRequest(reply);
    return forwardApiResponse(
      upstreamFetch,
      environment,
      `/v1/print-jobs/${encodeURIComponent(request.params.printJobId)}`,
      { method: "GET", headers: upstreamHeaders(environment, { accept: "application/json" }) },
      reply
    );
  });

  app.post<{ Params: { printJobId: string } }>(
    "/v1/print-jobs/:printJobId/cancel",
    (request, reply) => {
      const idempotencyKey = idempotencyKeySchema.safeParse(
        singleHeader(request.headers["idempotency-key"])
      );
      if (!UUID_PATTERN.test(request.params.printJobId)) return invalidPrintRequest(reply);
      if (!idempotencyKey.success) return idempotencyKeyRequired(reply);

      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/print-jobs/${encodeURIComponent(request.params.printJobId)}/cancel`,
        {
          method: "POST",
          headers: upstreamHeaders(environment, {
            accept: "application/json",
            "idempotency-key": idempotencyKey.data
          })
        },
        reply
      );
    }
  );

  app.get<{ Params: { sessionId: string; fileId: string } }>(
    "/v1/sessions/:sessionId/files/:fileId/pages",
    (request, reply) => {
      if (!validFileRoute(request.params.sessionId, request.params.fileId)) {
        return invalidFileRequest(reply);
      }
      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}` +
          `/files/${encodeURIComponent(request.params.fileId)}/pages`,
        {
          method: "GET",
          headers: upstreamHeaders(environment, { accept: "application/json" })
        },
        reply
      );
    }
  );

  app.get<{
    Params: { sessionId: string; fileId: string; pageNumber: string };
    Querystring: { revision?: string };
  }>("/v1/sessions/:sessionId/files/:fileId/pages/:pageNumber/preview", async (request, reply) => {
    const pageNumber = boundedPositiveInteger(
      request.params.pageNumber,
      environment.MAX_DOCUMENT_PAGES
    );
    const revision = boundedPositiveInteger(request.query.revision, 1_000_000);
    if (
      !validFileRoute(request.params.sessionId, request.params.fileId) ||
      pageNumber === undefined ||
      revision === undefined
    ) {
      return invalidFileRequest(reply);
    }

    const path =
      `/v1/sessions/${encodeURIComponent(request.params.sessionId)}` +
      `/files/${encodeURIComponent(request.params.fileId)}/pages/${pageNumber}/preview` +
      `?revision=${revision}`;
    return forwardPreviewResponse(
      upstreamFetch,
      environment,
      path,
      environment.MAX_PREVIEW_FILE_BYTES,
      reply
    );
  });

  app.delete<{ Params: { sessionId: string; fileId: string } }>(
    "/v1/sessions/:sessionId/files/:fileId",
    (request, reply) => {
      const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
      if (
        !validFileRoute(request.params.sessionId, request.params.fileId) ||
        !idempotencyKey ||
        !/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)
      ) {
        return reply.code(400).send({
          error: {
            code: "INVALID_FILE_DELETE_REQUEST",
            message: "The file deletion request is invalid."
          }
        });
      }
      return forwardApiResponse(
        upstreamFetch,
        environment,
        `/v1/sessions/${encodeURIComponent(request.params.sessionId)}` +
          `/files/${encodeURIComponent(request.params.fileId)}`,
        {
          method: "DELETE",
          headers: upstreamHeaders(environment, {
            accept: "application/json",
            "idempotency-key": idempotencyKey
          })
        },
        reply
      );
    }
  );

  app.get<{
    Params: { sessionId: string };
    Querystring: { after?: string };
  }>("/v1/sessions/:sessionId/events/stream", (request, reply) => {
    if (!options.eventSource) {
      return reply.code(503).send({
        error: {
          code: "REALTIME_UNAVAILABLE",
          message: "Realtime session updates are temporarily unavailable."
        }
      });
    }

    const queryAfter = parseEventCursor(request.query.after);
    const lastEventId = parseEventCursor(singleHeader(request.headers["last-event-id"]));
    const after =
      queryAfter === undefined || lastEventId === undefined
        ? undefined
        : Math.max(queryAfter, lastEventId);
    if (after === undefined || !UUID_PATTERN.test(request.params.sessionId)) {
      return reply.code(400).send({
        error: { code: "INVALID_EVENT_CURSOR", message: "The event stream request is invalid." }
      });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-store, no-cache, must-revalidate",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    });
    reply.raw.write(": connected\n\n");

    const unsubscribe = options.eventSource.subscribe(request.params.sessionId, after, (event) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    });
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref?.();
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

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
    const response = await upstreamFetch(new URL(path, environment.API_ORIGIN), {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(API_FORWARD_TIMEOUT_MS)
    });
    return await sendApiResponse(response, reply);
  } catch {
    return apiUnavailable(reply);
  }
}

async function sendApiResponse(response: Response, reply: FastifyReply) {
  const etag = response.headers.get("etag");
  if (etag) reply.header("etag", etag);
  reply.header("cache-control", "no-store");

  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "application/json";
  const body: unknown =
    contentType.includes("application/json") && text ? (JSON.parse(text) as unknown) : text;
  return reply.code(response.status).send(body);
}

async function forwardPreviewResponse(
  upstreamFetch: UpstreamFetch,
  environment: Environment,
  path: string,
  maximumBytes: number,
  reply: FastifyReply
) {
  let response: Response;
  try {
    response = await upstreamFetch(new URL(path, environment.API_ORIGIN), {
      method: "GET",
      headers: upstreamHeaders(environment, { accept: "image/webp" })
    });
  } catch {
    return apiUnavailable(reply);
  }

  if (!response.ok) return sendApiResponse(response, reply);

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentLength = boundedPositiveInteger(
    response.headers.get("content-length") ?? undefined,
    maximumBytes
  );
  if (contentType !== "image/webp" || contentLength === undefined || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return reply.code(502).send({
      error: {
        code: "INVALID_PREVIEW_RESPONSE",
        message: "The document preview is temporarily unavailable."
      }
    });
  }

  reply
    .code(200)
    .header("cache-control", "private, no-store")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("content-disposition", "inline")
    .header("content-length", String(contentLength))
    .header("content-type", "image/webp")
    .header("cross-origin-resource-policy", "same-origin")
    .header("x-content-type-options", "nosniff");
  return reply.send(Readable.from(readBoundedPreview(response.body, contentLength, maximumBytes)));
}

async function* readBoundedPreview(
  body: ReadableStream<Uint8Array>,
  declaredLength: number,
  maximumBytes: number
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      received += chunk.value.byteLength;
      if (received > declaredLength || received > maximumBytes) {
        throw new Error("PREVIEW_SIZE_LIMIT_EXCEEDED");
      }
      yield chunk.value;
    }
    if (received !== declaredLength) throw new Error("PREVIEW_LENGTH_MISMATCH");
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function apiUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: "API_UNAVAILABLE",
      message: "The session service is temporarily unavailable."
    }
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validFileRoute(sessionId: string, fileId: string): boolean {
  return UUID_PATTERN.test(sessionId) && UUID_PATTERN.test(fileId);
}

function boundedPositiveInteger(value: string | undefined, maximum: number): number | undefined {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : undefined;
}

function invalidFileRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_FILE_REQUEST", message: "The file request is invalid." }
  });
}

function idempotencyKeyRequired(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key is required." }
  });
}

function invalidPaymentRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_PAYMENT_REQUEST", message: "The payment request is invalid." }
  });
}

function invalidPrintRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_PRINT_REQUEST", message: "The print request is invalid." }
  });
}

function invalidSessionRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_SESSION_REQUEST", message: "The session request is invalid." }
  });
}

function conditionalHeadersRequired(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      code: "CONDITIONAL_REQUEST_HEADERS_REQUIRED",
      message: "Idempotency-Key and If-Match are required."
    }
  });
}

function parseEventCursor(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return 0;
  if (!/^\d{1,10}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 1_000_000_000 ? parsed : undefined;
}
