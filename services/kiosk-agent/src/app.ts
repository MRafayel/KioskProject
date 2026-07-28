import helmet from "@fastify/helmet";
import Fastify, { LogController, type FastifyInstance, type FastifyReply } from "fastify";
import { Readable } from "node:stream";

import type { Environment } from "@printing-kiosk/config";
import { PRODUCT_SCOPE, healthResponseSchema } from "@printing-kiosk/contracts";

import type { SessionEventSource } from "./events.js";

type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
    const response = await upstreamFetch(new URL(path, environment.API_ORIGIN), init);
    return sendApiResponse(response, reply);
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

function parseEventCursor(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return 0;
  if (!/^\d{1,10}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 1_000_000_000 ? parsed : undefined;
}
