import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { clientFileIdSchema, idempotencyKeySchema } from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import {
  MOBILE_COOKIE_NAME_PREFIX,
  assertMobileOrigin,
  mobileCookieName,
  singleHeader
} from "../mobile-access/routes.js";
import type { MobileAccessService } from "../mobile-access/service.js";
import { authenticateKiosk } from "../sessions/auth.js";
import type { Clock } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import type { FileService } from "./service.js";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const fileParamsSchema = z.object({
  sessionId: z.string().uuid(),
  fileId: z.string().uuid()
});

export function registerFileRoutes(
  app: FastifyInstance,
  dependencies: {
    database: PrismaClient;
    clock: Clock;
    files: FileService;
    mobileAccess: MobileAccessService;
    uploadOrigin: string;
    maxFileBytes: number;
  }
): void {
  app.post(
    "/v1/sessions/:sessionId/files",
    {
      bodyLimit: dependencies.maxFileBytes + 1024 * 1024,
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: authenticatedRateKey }
      }
    },
    async (request, reply) => {
      const requestAbort = new AbortController();
      const abortRequest = () => {
        if (!requestAbort.signal.aborted) {
          requestAbort.abort(new Error("The upload connection closed."));
        }
      };
      const abortOnReplyClose = () => {
        if (!reply.raw.writableEnded) abortRequest();
      };
      request.raw.once("aborted", abortRequest);
      request.raw.once("error", abortRequest);
      reply.raw.once("close", abortOnReplyClose);

      try {
        assertMobileOrigin(request, dependencies.uploadOrigin);
        const params = sessionParamsSchema.parse(request.params);
        const identity = await dependencies.mobileAccess.authenticate(
          request.cookies[mobileCookieName(params.sessionId)],
          params.sessionId
        );
        dependencies.mobileAccess.assertCsrf(
          identity,
          singleHeader(request.headers["x-csrf-token"])
        );

        const clientFileId = clientFileIdSchema.parse(
          requireHeader(request, "x-client-file-id", "CLIENT_FILE_ID_REQUIRED")
        );
        const declaredBytes = parseFileSize(
          requireHeader(request, "x-file-size", "FILE_SIZE_REQUIRED")
        );
        const idempotencyKey = idempotencyKeySchema.parse(
          requireHeader(request, "idempotency-key", "IDEMPOTENCY_KEY_REQUIRED")
        );
        const parts = request.parts({
          limits: {
            fileSize: dependencies.maxFileBytes,
            files: 2,
            fields: 1,
            parts: 2
          }
        });
        const first = await parts.next();
        if (first.done || first.value.type !== "file" || first.value.fieldname !== "file") {
          if (!first.done && first.value.type === "file") first.value.file.resume();
          throw new ApiError(400, "FILE_REQUIRED", "Exactly one file is required.");
        }
        const part = first.value;

        const response = await dependencies.files.upload({
          identity,
          clientFileId,
          idempotencyKey,
          declaredBytes,
          declaredMime: part.mimetype,
          originalFilename: part.filename,
          stream: part.file,
          wasTruncated: () => part.file.truncated,
          requestId: request.id,
          signal: requestAbort.signal,
          afterStreamConsumed: async () => {
            let next: Awaited<ReturnType<typeof parts.next>>;
            try {
              next = await parts.next();
            } catch {
              throw new ApiError(400, "MULTIPLE_FILE_PARTS", "Exactly one file is required.");
            }
            if (!next.done) {
              if (next.value.type === "file") next.value.file.resume();
              throw new ApiError(400, "MULTIPLE_FILE_PARTS", "Exactly one file is required.");
            }
          }
        });
        return reply.header("cache-control", "no-store").code(202).send(response);
      } finally {
        request.raw.off("aborted", abortRequest);
        request.raw.off("error", abortRequest);
        reply.raw.off("close", abortOnReplyClose);
      }
    }
  );

  app.get(
    "/v1/sessions/:sessionId/files",
    {
      config: {
        rateLimit: { max: 90, timeWindow: "1 minute", keyGenerator: authenticatedRateKey }
      }
    },
    async (request, reply) => {
      const params = sessionParamsSchema.parse(request.params);
      if (request.headers.authorization) {
        const kiosk = await authenticateKiosk(
          request,
          dependencies.database,
          dependencies.clock,
          "files:read"
        );
        const owned = await dependencies.database.printSession.findFirst({
          where: { id: params.sessionId, kioskId: kiosk.kioskId },
          select: { id: true }
        });
        if (!owned) throw hiddenSession();
      } else {
        await dependencies.mobileAccess.authenticate(
          request.cookies[mobileCookieName(params.sessionId)],
          params.sessionId
        );
      }

      return reply
        .header("cache-control", "no-store")
        .send(await dependencies.files.list(params.sessionId));
    }
  );

  app.delete(
    "/v1/sessions/:sessionId/files/:fileId",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: authenticatedRateKey }
      }
    },
    async (request, reply) => {
      const params = fileParamsSchema.parse(request.params);
      const idempotencyKey = idempotencyKeySchema.parse(
        requireHeader(request, "idempotency-key", "IDEMPOTENCY_KEY_REQUIRED")
      );
      if (request.headers.authorization) {
        const kiosk = await authenticateKiosk(
          request,
          dependencies.database,
          dependencies.clock,
          "files:delete"
        );
        const deletion = await dependencies.files.removeForKiosk({
          kioskId: kiosk.kioskId,
          credentialId: kiosk.credentialId,
          sessionId: params.sessionId,
          fileId: params.fileId,
          idempotencyKey,
          requestId: request.id
        });
        return reply.header("cache-control", "no-store").code(deletion.statusCode).send();
      }

      assertMobileOrigin(request, dependencies.uploadOrigin);
      const identity = await dependencies.mobileAccess.authenticate(
        request.cookies[mobileCookieName(params.sessionId)],
        params.sessionId
      );
      dependencies.mobileAccess.assertCsrf(identity, singleHeader(request.headers["x-csrf-token"]));

      const deletion = await dependencies.files.remove({
        identity,
        fileId: params.fileId,
        idempotencyKey,
        requestId: request.id
      });
      return reply.header("cache-control", "no-store").code(deletion.statusCode).send();
    }
  );
}

function requireHeader(request: FastifyRequest, name: string, code: string): string {
  const value = singleHeader(request.headers[name]);
  if (!value) throw new ApiError(400, code, `The ${name} header is required.`);
  return value;
}

function parseFileSize(value: string): number {
  if (!/^\d{1,9}$/.test(value)) {
    throw new ApiError(400, "INVALID_FILE_SIZE", "The declared file size is invalid.");
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new ApiError(400, "INVALID_FILE_SIZE", "The declared file size is invalid.");
  }
  return size;
}

function hiddenSession(): ApiError {
  return new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
}

function authenticatedRateKey(request: FastifyRequest): string {
  const sessionId = getSessionIdParam(request.params);
  const mobileCookie = sessionId
    ? request.cookies[mobileCookieName(sessionId)]
    : Object.entries(request.cookies).find(([name]) =>
        name.startsWith(MOBILE_COOKIE_NAME_PREFIX)
      )?.[1];
  const credential = request.headers.authorization ?? mobileCookie ?? request.ip;
  return createHash("sha256").update(credential).digest("hex").slice(0, 32);
}

function getSessionIdParam(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || !("sessionId" in params)) return undefined;
  const value = Reflect.get(params, "sessionId");
  return typeof value === "string" ? value : undefined;
}
