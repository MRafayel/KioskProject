import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { filePagesResponseSchema } from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import type { Clock } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import type { KioskAuthenticationThrottle } from "../sessions/rate-limit.js";
import type { ObjectStore } from "./object-store.js";

const fileParamsSchema = z.object({
  sessionId: z.string().uuid(),
  fileId: z.string().uuid()
});
const previewParamsSchema = fileParamsSchema.extend({
  pageNumber: z.coerce.number().int().min(1).max(10_000)
});
const previewQuerySchema = z.object({
  revision: z.coerce.number().int().min(1).max(2_147_483_647)
});
const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_PREVIEW_ACTORS = 50_000;

export function registerDocumentPreviewRoutes(
  app: FastifyInstance,
  dependencies: {
    database: PrismaClient;
    objectStore: ObjectStore;
    clock: Clock;
    kioskAuthentication: KioskAuthenticationThrottle;
    maxPreviewBytes: number;
    actorRateLimiter?: PreviewActorRateLimiter;
  }
): void {
  const actorRateLimiter =
    dependencies.actorRateLimiter ??
    new PreviewActorRateLimiter(RATE_WINDOW_MS, MAX_TRACKED_PREVIEW_ACTORS);

  app.get(
    "/v1/sessions/:sessionId/files/:fileId/pages",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          keyGenerator: previewIpRateKey,
          groupId: "document-page-metadata"
        }
      }
    },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const kiosk = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "files:read"
      );
      actorRateLimiter.consume(
        `metadata:${kiosk.credentialId}`,
        120,
        dependencies.clock.now().getTime()
      );
      const file = await findOwnedReadyFile(
        dependencies.database,
        kiosk.kioskId,
        params.sessionId,
        params.fileId
      );
      const pages = await dependencies.database.filePage.findMany({
        where: {
          fileId: file.id,
          processingRevision: file.processingRevision
        },
        orderBy: { pageNumber: "asc" }
      });
      if (pages.length !== file.pageCount) throw previewUnavailable();

      const derivatives = await dependencies.database.fileDerivative.findMany({
        where: {
          id: { in: pages.map((page) => page.previewDerivativeId) },
          fileId: file.id,
          processingRevision: file.processingRevision,
          type: "PAGE_PREVIEW",
          status: "AVAILABLE"
        },
        select: { id: true }
      });
      const available = new Set(derivatives.map((derivative) => derivative.id));
      const response = filePagesResponseSchema.parse({
        fileId: file.id,
        processingRevision: file.processingRevision,
        pageCount: file.pageCount,
        items: pages.map((page) => ({
          pageNumber: page.pageNumber,
          widthPixels: page.widthPixels,
          heightPixels: page.heightPixels,
          previewAvailable: available.has(page.previewDerivativeId)
        }))
      });
      return reply.header("cache-control", "no-store").send(response);
    }
  );

  app.get(
    "/v1/sessions/:sessionId/files/:fileId/pages/:pageNumber/preview",
    {
      config: {
        rateLimit: {
          max: 240,
          timeWindow: "1 minute",
          keyGenerator: previewIpRateKey,
          groupId: "document-page-preview"
        }
      }
    },
    async (request, reply) => {
      const params = previewParamsSchema.parse(request.params);
      const query = previewQuerySchema.parse(request.query);
      const kiosk = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "files:read"
      );
      actorRateLimiter.consume(
        `preview:${kiosk.credentialId}`,
        240,
        dependencies.clock.now().getTime()
      );
      const file = await findOwnedReadyFile(
        dependencies.database,
        kiosk.kioskId,
        params.sessionId,
        params.fileId
      );
      if (file.processingRevision !== query.revision) throw hiddenFile();

      const page = await dependencies.database.filePage.findUnique({
        where: {
          fileId_processingRevision_pageNumber: {
            fileId: file.id,
            processingRevision: file.processingRevision,
            pageNumber: params.pageNumber
          }
        }
      });
      if (!page) throw hiddenFile();
      const derivative = await dependencies.database.fileDerivative.findFirst({
        where: {
          id: page.previewDerivativeId,
          fileId: file.id,
          processingRevision: file.processingRevision,
          pageNumber: page.pageNumber,
          type: "PAGE_PREVIEW",
          status: "AVAILABLE"
        }
      });
      if (
        !derivative ||
        derivative.mimeType !== "image/webp" ||
        !derivative.sizeBytes ||
        derivative.sizeBytes < 1 ||
        derivative.sizeBytes > dependencies.maxPreviewBytes ||
        !derivative.objectKey ||
        !derivative.objectKey.startsWith("previews/v1/")
      ) {
        throw previewUnavailable();
      }

      let object;
      try {
        object = await dependencies.objectStore.getObject({ key: derivative.objectKey });
      } catch {
        throw previewUnavailable();
      }
      if (
        object.contentLength !== derivative.sizeBytes ||
        object.contentType !== "image/webp" ||
        object.contentLength > dependencies.maxPreviewBytes
      ) {
        object.body.destroy();
        throw previewUnavailable();
      }

      let preview: Buffer;
      try {
        preview = await readVerifiedPreview({
          body: object.body,
          expectedBytes: derivative.sizeBytes,
          expectedSha256: derivative.sha256,
          maximumBytes: dependencies.maxPreviewBytes
        });
      } catch {
        object.body.destroy();
        throw previewUnavailable();
      }

      return reply
        .header("cache-control", "private, no-store, max-age=0")
        .header("content-type", "image/webp")
        .header("content-length", String(preview.byteLength))
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cross-origin-resource-policy", "same-origin")
        .header("x-content-type-options", "nosniff")
        .send(preview);
    }
  );
}

export async function readVerifiedPreview(input: {
  body: Readable;
  expectedBytes: number;
  expectedSha256: string;
  maximumBytes: number;
}): Promise<Buffer> {
  if (
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes < 1 ||
    input.expectedBytes > input.maximumBytes ||
    !/^[0-9a-f]{64}$/u.test(input.expectedSha256)
  ) {
    throw new Error("PREVIEW_METADATA_INVALID");
  }

  const chunks: Buffer[] = [];
  const digest = createHash("sha256");
  let receivedBytes = 0;
  for await (const value of input.body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    receivedBytes += chunk.byteLength;
    if (receivedBytes > input.expectedBytes || receivedBytes > input.maximumBytes) {
      throw new Error("PREVIEW_SIZE_MISMATCH");
    }
    chunks.push(chunk);
    digest.update(chunk);
  }
  if (receivedBytes !== input.expectedBytes || digest.digest("hex") !== input.expectedSha256) {
    throw new Error("PREVIEW_INTEGRITY_MISMATCH");
  }

  const preview = Buffer.concat(chunks, receivedBytes);
  if (
    preview.byteLength < 12 ||
    preview.subarray(0, 4).toString("ascii") !== "RIFF" ||
    preview.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    throw new Error("PREVIEW_SIGNATURE_INVALID");
  }
  return preview;
}

async function findOwnedReadyFile(
  database: PrismaClient,
  kioskId: string,
  sessionId: string,
  fileId: string
) {
  const file = await database.uploadedFile.findFirst({
    where: {
      id: fileId,
      sessionId,
      status: "READY",
      session: { kioskId }
    }
  });
  if (!file?.pageCount || file.pageCount < 1) throw hiddenFile();
  return file;
}

function hiddenFile(): ApiError {
  return new ApiError(404, "FILE_NOT_FOUND", "File not found.");
}

function previewUnavailable(): ApiError {
  return new ApiError(503, "PREVIEW_UNAVAILABLE", "The document preview is unavailable.");
}

/**
 * This limiter runs before authentication, so its key must not be controlled
 * by an arbitrary Authorization header. Otherwise an attacker could rotate
 * invalid bearer values to bypass the database-work limiter.
 */
export function previewIpRateKey(request: FastifyRequest): string {
  return createHash("sha256").update(request.ip).digest("hex").slice(0, 32);
}

export class PreviewActorRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();
  private lastSweepAt = 0;

  public constructor(
    private readonly windowMilliseconds: number,
    private readonly maximumTrackedActors: number
  ) {
    if (
      !Number.isSafeInteger(windowMilliseconds) ||
      windowMilliseconds < 1 ||
      !Number.isSafeInteger(maximumTrackedActors) ||
      maximumTrackedActors < 1
    ) {
      throw new Error("INVALID_PREVIEW_RATE_LIMITER");
    }
  }

  public consume(actor: string, maximum: number, now: number): void {
    if (!actor || !Number.isSafeInteger(maximum) || maximum < 1 || !Number.isFinite(now)) {
      throw new Error("INVALID_PREVIEW_RATE_LIMIT_INPUT");
    }
    this.sweepExpired(now);

    const current = this.windows.get(actor);
    if (!current || now - current.startedAt >= this.windowMilliseconds) {
      if (!current && this.windows.size >= this.maximumTrackedActors) {
        throw rateLimitExceeded();
      }
      this.windows.set(actor, { startedAt: now, count: 1 });
      return;
    }
    if (current.count >= maximum) throw rateLimitExceeded();
    current.count += 1;
  }

  private sweepExpired(now: number): void {
    if (now - this.lastSweepAt < this.windowMilliseconds) return;
    this.lastSweepAt = now;
    for (const [actor, window] of this.windows) {
      if (now - window.startedAt >= this.windowMilliseconds) this.windows.delete(actor);
    }
  }
}

function rateLimitExceeded(): ApiError {
  return new ApiError(429, "PREVIEW_RATE_LIMIT_REACHED", "Too many preview requests.");
}
