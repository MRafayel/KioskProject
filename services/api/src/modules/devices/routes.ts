import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  agentHeartbeatBodySchema,
  registerAgentBodySchema,
  reportPrinterStateBodySchema
} from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import { ApiError } from "../sessions/errors.js";

import type { Clock } from "../sessions/crypto.js";
import { kioskRateLimitKey, type KioskAuthenticationThrottle } from "../sessions/rate-limit.js";
import type { PrinterReadinessGate } from "./readiness.js";
import type { DeviceRegistryService } from "./service.js";

export interface DeviceRouteDependencies {
  database: PrismaClient;
  clock: Clock;
  devices: DeviceRegistryService;
  kioskAuthentication: KioskAuthenticationThrottle;
  printerReadiness: PrinterReadinessGate;
}

/**
 * The kiosk agent's device plane.
 *
 * These are not customer routes. They require the device credential and the
 * same `print-jobs:agent` scope the command channel uses, so a compromised
 * touchscreen credential cannot describe a printer, and the kiosk in the
 * credential is the only kiosk a caller can write to — none of these routes
 * takes a kiosk identifier from the request at all.
 */
const kioskAvailabilityParamsSchema = z.object({ kioskId: z.string().min(1).max(64) });

export function registerDeviceRoutes(
  app: FastifyInstance,
  dependencies: DeviceRouteDependencies
): void {
  /**
   * Whether this kiosk can take a new customer.
   *
   * The one route here a touchscreen may call, and the only one that does not
   * need the agent scope. It exists so the welcome screen can close itself
   * before somebody starts a session it would only have to refuse — a customer
   * who has chosen files and reached a checkout has already lost more than the
   * refusal costs to prevent.
   *
   * It answers from the same gate session creation uses, deliberately: a screen
   * that decided availability for itself would be a second opinion about the
   * printer, and the two would drift. Non-strict, like session start — payment
   * is where freshness is enforced, and refusing here over a poll that is merely
   * due would close a working kiosk.
   */
  app.get(
    "/v1/kiosks/:kioskId/availability",
    {
      // Polled by every idle screen in the fleet, so it is cheap by design: one
      // indexed row, no writes, and a ceiling that leaves room for a few seconds
      // between asks without letting a stuck client hammer the database.
      config: { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey } }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "sessions:create"
      );
      const params = kioskAvailabilityParamsSchema.parse(request.params);
      // A credential may only ask about its own kiosk, and is told nothing about
      // whether another one exists.
      if (params.kioskId !== identity.kioskId) {
        throw new ApiError(404, "KIOSK_NOT_FOUND", "No such kiosk.");
      }

      const readiness = await dependencies.printerReadiness.read(
        dependencies.database,
        identity.kioskId
      );

      return reply.header("cache-control", "no-store").send({
        availability: readiness.ready
          ? { available: true, reason: null }
          : { available: false, reason: readiness.reason }
      });
    }
  );

  app.post(
    "/v1/agent/register",
    {
      // Registration happens at startup. A kiosk that restarts in a loop is a
      // problem to see in the logs, not one to let hammer the database.
      config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey } }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "print-jobs:agent"
      );
      const body = registerAgentBodySchema.parse(request.body ?? {});
      const response = await dependencies.devices.register({ kioskId: identity.kioskId, body });

      return reply.header("cache-control", "no-store").code(201).send(response);
    }
  );

  app.post(
    "/v1/agent/heartbeat",
    {
      // One kiosk beats on a schedule measured in tens of seconds. This
      // tolerates that plus a restart storm without becoming a way in.
      config: { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey } }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "print-jobs:agent"
      );
      const body = agentHeartbeatBodySchema.parse(request.body ?? {});
      const response = await dependencies.devices.heartbeat({ kioskId: identity.kioskId, body });

      return reply.header("cache-control", "no-store").send(response);
    }
  );

  app.put(
    "/v1/agent/printers",
    {
      // A capability report changes what customers are offered, so it is the
      // narrowest allowance here: it is sent on a change, not on a schedule.
      config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: kioskRateLimitKey } }
    },
    async (request, reply) => {
      const identity = await dependencies.kioskAuthentication.authenticate(
        request,
        dependencies.database,
        dependencies.clock,
        "print-jobs:agent"
      );
      const body = reportPrinterStateBodySchema.parse(request.body ?? {});
      const response = await dependencies.devices.reportPrinters({
        kioskId: identity.kioskId,
        body
      });

      return reply.header("cache-control", "no-store").send(response);
    }
  );
}
