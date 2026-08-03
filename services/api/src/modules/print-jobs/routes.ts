import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  claimAgentCommandsBodySchema,
  createPrintJobBodySchema,
  idempotencyKeySchema,
  printJobManifestSchema,
  reportAgentCommandProgressBodySchema,
  reportAgentCommandResultBodySchema
} from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import type { ObjectStore } from "../files/object-store.js";
import type { Clock } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { kioskRateLimitKey, type KioskAuthenticationThrottle } from "../sessions/rate-limit.js";
import type { AgentCommandService } from "./agent-service.js";
import type { PrintJobService } from "./service.js";

const CLAIM_TOKEN_HEADER = "x-print-claim-token";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const printJobParamsSchema = z.object({ printJobId: z.string().uuid() });
const operationParamsSchema = z.object({ operationId: z.string().uuid() });
const documentParamsSchema = z.object({
  printJobId: z.string().uuid(),
  documentId: z.string().uuid()
});
const claimTokenSchema = z.string().uuid();

export interface PrintJobRouteDependencies {
  database: PrismaClient;
  clock: Clock;
  printJobs: PrintJobService;
  kioskAuthentication: KioskAuthenticationThrottle;
  /** Development scenarios. A production configuration cannot enable this. */
  testOutcomesEnabled: boolean;
}

export function registerPrintJobRoutes(
  app: FastifyInstance,
  dependencies: PrintJobRouteDependencies
): void {
  app.post(
    "/v1/sessions/:sessionId/print-jobs",
    {
      // Printing is a rare, deliberate act, and a session prints once. This
      // ceiling still covers a customer retrying after every refusal.
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "print-jobs:create"
      );
      const params = sessionParamsSchema.parse(request.params);
      const body = createPrintJobBodySchema.parse(request.body ?? {});
      // The scenario control is refused outright rather than ignored, so a
      // deployment that has it disabled cannot be probed for its presence by
      // watching whether the field changes anything.
      if (body.simulatedOutcome !== undefined && !dependencies.testOutcomesEnabled) {
        throw new ApiError(400, "INVALID_REQUEST", "The request is invalid.");
      }

      const response = await dependencies.printJobs.create({
        kioskId: identity.kioskId,
        credentialId: identity.credentialId,
        sessionId: params.sessionId,
        paymentId: body.paymentId,
        ...(body.simulatedOutcome === undefined ? {} : { simulatedOutcome: body.simulatedOutcome }),
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id
      });

      return reply.header("cache-control", "no-store").code(201).send(response);
    }
  );

  app.get(
    "/v1/print-jobs/:printJobId",
    {
      // The kiosk watches a running job while the customer waits at the
      // printer, so this allowance has to tolerate polling.
      config: {
        rateLimit: { max: 180, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "print-jobs:read"
      );
      const params = printJobParamsSchema.parse(request.params);
      const response = await dependencies.printJobs.get({
        kioskId: identity.kioskId,
        printJobId: params.printJobId
      });

      return reply.header("cache-control", "no-store").send(response);
    }
  );

  app.post(
    "/v1/print-jobs/:printJobId/cancel",
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
        "print-jobs:write"
      );
      const params = printJobParamsSchema.parse(request.params);
      const response = await dependencies.printJobs.cancel({
        kioskId: identity.kioskId,
        credentialId: identity.credentialId,
        printJobId: params.printJobId,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id
      });

      return reply.header("cache-control", "no-store").send(response);
    }
  );
}

export interface AgentCommandRouteDependencies {
  database: PrismaClient;
  clock: Clock;
  objectStore: ObjectStore;
  commands: AgentCommandService;
  kioskAuthentication: KioskAuthenticationThrottle;
  maxDocumentBytes: number;
}

/**
 * The kiosk agent's own operations.
 *
 * These are not customer routes. They require the device credential and the
 * `print-jobs:agent` scope, and every one of them proves that the caller still
 * holds the lease it was given before it is allowed to change anything or to
 * read a print-ready document.
 */
export function registerAgentCommandRoutes(
  app: FastifyInstance,
  dependencies: AgentCommandRouteDependencies
): void {
  app.post(
    "/v1/agent/commands/claim",
    {
      // The agent polls for work. This is the one route that has to tolerate a
      // steady heartbeat from every kiosk.
      config: {
        rateLimit: { max: 240, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "print-jobs:agent"
      );
      const body = claimAgentCommandsBodySchema.parse(request.body ?? {});
      const response = await dependencies.commands.claim({
        kioskId: identity.kioskId,
        max: body.max
      });

      return reply.header("cache-control", "no-store").send(response);
    }
  );

  app.post(
    "/v1/agent/commands/:operationId/progress",
    {
      config: {
        rateLimit: { max: 240, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey }
      }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "print-jobs:agent"
      );
      const params = operationParamsSchema.parse(request.params);
      const body = reportAgentCommandProgressBodySchema.parse(request.body ?? {});
      const response = await dependencies.commands.reportProgress({
        kioskId: identity.kioskId,
        operationId: params.operationId,
        body
      });

      return reply.header("cache-control", "no-store").send(response);
    }
  );

  app.post(
    "/v1/agent/commands/:operationId/result",
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
        "print-jobs:agent"
      );
      const params = operationParamsSchema.parse(request.params);
      const body = reportAgentCommandResultBodySchema.parse(request.body ?? {});
      const response = await dependencies.commands.reportResult({
        kioskId: identity.kioskId,
        credentialId: identity.credentialId,
        operationId: params.operationId,
        requestId: request.id,
        body
      });

      return reply.header("cache-control", "no-store").send(response);
    }
  );

  app.get(
    "/v1/agent/print-jobs/:printJobId/documents/:documentId",
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
        "print-jobs:agent"
      );
      const params = documentParamsSchema.parse(request.params);
      const claimToken = claimTokenSchema.parse(singleHeader(request.headers[CLAIM_TOKEN_HEADER]));

      // Reading a print-ready document requires a live lease on this exact
      // job. A credential alone is not enough: the agent may read only what it
      // is currently printing.
      const command = await dependencies.database.agentCommand.findFirst({
        where: {
          printJobId: params.printJobId,
          kioskId: identity.kioskId,
          status: "CLAIMED",
          claimToken,
          leaseExpiresAt: { gt: dependencies.clock.now() }
        },
        select: { id: true }
      });
      if (!command) throw documentNotFound();

      const printJob = await dependencies.database.printJob.findFirst({
        where: { id: params.printJobId, kioskId: identity.kioskId },
        select: { jobManifest: true, sessionId: true }
      });
      const manifest = printJob
        ? printJobManifestSchema.safeParse(printJob.jobManifest)
        : undefined;
      const document = manifest?.success
        ? manifest.data.documents.find((entry) => entry.documentId === params.documentId)
        : undefined;
      // The manifest is the allowlist. A document identifier that is not in
      // the job cannot be read through a job's lease.
      if (!printJob || !document) throw documentNotFound();

      const derivative = await dependencies.database.fileDerivative.findFirst({
        where: {
          fileId: document.documentId,
          type: "NORMALIZED_PDF",
          status: "AVAILABLE",
          sha256: document.sha256,
          file: { sessionId: printJob.sessionId }
        },
        select: { objectKey: true, sizeBytes: true, mimeType: true, sha256: true }
      });
      if (
        !derivative ||
        derivative.sizeBytes !== document.sizeBytes ||
        derivative.mimeType !== "application/pdf" ||
        derivative.sizeBytes > dependencies.maxDocumentBytes ||
        !derivative.objectKey.startsWith("normalized/v1/")
      ) {
        throw documentUnavailable();
      }

      let object;
      try {
        object = await dependencies.objectStore.getObject({ key: derivative.objectKey });
      } catch {
        throw documentUnavailable();
      }
      if (object.contentLength !== derivative.sizeBytes) {
        object.body.destroy();
        throw documentUnavailable();
      }

      return (
        reply
          .header("cache-control", "private, no-store")
          .header("content-type", "application/pdf")
          .header("content-length", String(derivative.sizeBytes))
          .header("content-disposition", "attachment")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .header("cross-origin-resource-policy", "same-origin")
          .header("x-content-type-options", "nosniff")
          // The agent verifies the bytes it received against this digest before
          // anything is handed to a device.
          .header("x-document-sha256", derivative.sha256)
          .send(object.body)
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

function documentNotFound(): ApiError {
  return new ApiError(404, "PRINT_DOCUMENT_NOT_FOUND", "Print document not found.");
}

function documentUnavailable(): ApiError {
  return new ApiError(503, "PRINT_DOCUMENT_UNAVAILABLE", "The print document is unavailable.");
}
