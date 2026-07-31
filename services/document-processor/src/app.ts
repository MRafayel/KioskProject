import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ProcessorConfig } from "./config.js";
import { ProcessorError, safeProcessorError, type ProcessorErrorCode } from "./errors.js";
import { sendProcessedDocumentTar } from "./tar-response.js";
import { TimingCollector, type TimingReport } from "./timings.js";
import {
  DOCUMENT_KINDS,
  PROCESSOR_PROTOCOL_VERSION,
  type DocumentKind,
  type InternalDocumentProcessor
} from "./types.js";

interface RequestMetadata {
  kind: DocumentKind;
  contentLength: number;
  expectedSha256: string;
}

export interface ProcessorServerDependencies {
  config: ProcessorConfig;
  processor: InternalDocumentProcessor;
  /**
   * Receives one stage-timing report per processed request. Injected rather
   * than logged here so the server keeps no logging dependency and tests can
   * assert on the report directly.
   */
  onTiming?: (report: TimingReport, kind: DocumentKind) => void;
  /**
   * Receives the reason a readiness probe failed.
   *
   * The probe gates the whole stack: nothing that depends on this service
   * starts until it answers, so a silent refusal is indistinguishable from a
   * crash, a missing tool, and an unreachable scanner. The reason is reported
   * here rather than returned to the caller — a health probe should not
   * describe the deployment to whoever can reach it — and injected rather than
   * logged so the server keeps no logging dependency.
   */
  onReadinessFailure?: (code: ProcessorErrorCode) => void;
}

export function createProcessorServer(dependencies: ProcessorServerDependencies): Server {
  let processing = false;
  const server = createServer();

  server.on("request", (request, response) => {
    void handleRequest(request, response, false).catch(() => {
      if (!response.headersSent) {
        sendError(response, new ProcessorError("INTERNAL_ERROR", 500, true));
      } else {
        response.destroy();
      }
    });
  });
  server.on("checkContinue", (request, response) => {
    void handleRequest(request, response, true).catch(() => {
      if (!response.headersSent) {
        sendError(response, new ProcessorError("INTERNAL_ERROR", 500, true));
      } else {
        response.destroy();
      }
    });
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = dependencies.config.processTimeoutMilliseconds + 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;

  return server;

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    expectsContinue: boolean
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://processor.internal");
    if (request.method === "GET" && url.pathname === "/health/live" && !url.search) {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/health/ready" && !url.search) {
      const readinessDeadline = AbortSignal.timeout(
        Math.min(10_000, dependencies.config.scannerTimeoutMilliseconds)
      );
      try {
        await dependencies.processor.checkReady(readinessDeadline);
        sendJson(response, 200, { status: "ready" });
      } catch (error) {
        // Reporting must never be able to change what the probe answers.
        try {
          dependencies.onReadinessFailure?.(safeProcessorError(error).code);
        } catch {
          /* ignore */
        }
        sendJson(response, 503, { status: "not_ready" });
      }
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/internal/v1/process" || url.search) {
      request.resume();
      sendError(response, new ProcessorError("INVALID_REQUEST", 404));
      return;
    }

    let metadata: RequestMetadata;
    try {
      metadata = validateRequest(request, dependencies.config);
    } catch (error) {
      request.resume();
      sendError(response, safeProcessorError(error));
      return;
    }
    if (processing) {
      request.resume();
      sendError(response, new ProcessorError("PROCESSOR_BUSY", 503, true));
      return;
    }

    processing = true;
    if (expectsContinue) response.writeContinue();
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(dependencies.config.processTimeoutMilliseconds);
    const signal = AbortSignal.any([controller.signal, deadline]);
    const abortRequest = () => {
      if (!controller.signal.aborted) controller.abort(new Error("REQUEST_ABORTED"));
    };
    const abortResponse = () => {
      if (!response.writableFinished) abortRequest();
    };
    request.once("aborted", abortRequest);
    response.once("close", abortResponse);

    // Collect even when reporting is disabled: the cost is a handful of
    // integer adds, and a request that fails still reports where its time went.
    const timings = new TimingCollector(dependencies.config.timingDetail);

    let processed: Awaited<ReturnType<InternalDocumentProcessor["process"]>> | undefined;
    try {
      processed = await dependencies.processor.process({
        ...metadata,
        body: request,
        signal,
        timings
      });
      await timings.measure("tar", () =>
        sendProcessedDocumentTar({
          response,
          document: processed as NonNullable<typeof processed>,
          maximumBytes: dependencies.config.maxResponseBytes,
          scratchDirectory: dependencies.config.scratchDirectory,
          signal
        })
      );
    } catch (error) {
      const safe = safeProcessorError(error);
      if (!response.headersSent && !response.destroyed) sendError(response, safe);
      else if (!response.writableFinished) response.destroy();
    } finally {
      request.off("aborted", abortRequest);
      response.off("close", abortResponse);
      await processed?.cleanup().catch(() => undefined);
      processing = false;
      // Reporting must never be able to fail a request that already succeeded.
      try {
        dependencies.onTiming?.(timings.report(), metadata.kind);
      } catch {
        /* ignore */
      }
    }
  }
}

function validateRequest(request: IncomingMessage, config: ProcessorConfig): RequestMetadata {
  assertAuthenticated(request.headers.authorization, config.authToken);
  if (request.headers["transfer-encoding"] !== undefined) {
    throw new ProcessorError("INVALID_CONTENT_LENGTH", 400);
  }
  if (singleHeader(request.headers["content-type"]) !== "application/octet-stream") {
    throw new ProcessorError("INVALID_CONTENT_TYPE", 415);
  }
  const protocolVersion = singleHeader(request.headers["x-processor-protocol-version"]);
  if (protocolVersion !== undefined && protocolVersion !== String(PROCESSOR_PROTOCOL_VERSION)) {
    throw new ProcessorError("INVALID_PROTOCOL_VERSION", 400);
  }

  const kind = singleHeader(request.headers["x-document-kind"]);
  if (!kind || !DOCUMENT_KINDS.includes(kind as DocumentKind)) {
    throw new ProcessorError("INVALID_DOCUMENT_KIND", 400);
  }
  const contentLengthText = singleHeader(request.headers["content-length"]);
  if (!contentLengthText || !/^[1-9]\d{0,9}$/u.test(contentLengthText)) {
    throw new ProcessorError("INVALID_CONTENT_LENGTH", 400);
  }
  const contentLength = Number(contentLengthText);
  if (!Number.isSafeInteger(contentLength)) {
    throw new ProcessorError("INVALID_CONTENT_LENGTH", 400);
  }
  if (contentLength > config.maxInputBytes) {
    throw new ProcessorError("REQUEST_TOO_LARGE", 413);
  }
  const expectedSha256 = singleHeader(request.headers["x-content-sha256"]);
  if (!expectedSha256 || !/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    throw new ProcessorError("INVALID_REQUEST", 400);
  }
  return { kind: kind as DocumentKind, contentLength, expectedSha256 };
}

function assertAuthenticated(header: string | undefined, expectedToken: string): void {
  if (!header?.startsWith("Bearer ")) {
    throw new ProcessorError("AUTHENTICATION_REQUIRED", 401);
  }
  const supplied = header.slice("Bearer ".length);
  const expectedDigest = createHash("sha256").update(expectedToken, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) {
    throw new ProcessorError("INVALID_AUTHENTICATION", 401);
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function sendError(response: ServerResponse, error: ProcessorError): void {
  sendJson(response, error.statusCode, {
    error: {
      code: error.code,
      retryable: error.retryable
    }
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(encoded.byteLength),
    "content-type": "application/json",
    "x-content-type-options": "nosniff"
  });
  response.end(encoded);
}
