import type { FastifyInstance } from "fastify";

import {
  agentHeartbeatBodySchema,
  registerAgentBodySchema,
  reportPrinterStateBodySchema
} from "@printing-kiosk/contracts";
import type { PrismaClient } from "@printing-kiosk/database";

import type { Clock } from "../sessions/crypto.js";
import { kioskRateLimitKey, type KioskAuthenticationThrottle } from "../sessions/rate-limit.js";
import type { DeviceRegistryService } from "./service.js";

export interface DeviceRouteDependencies {
  database: PrismaClient;
  clock: Clock;
  devices: DeviceRegistryService;
  kioskAuthentication: KioskAuthenticationThrottle;
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
export function registerDeviceRoutes(
  app: FastifyInstance,
  dependencies: DeviceRouteDependencies
): void {
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
