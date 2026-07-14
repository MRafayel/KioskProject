import helmet from "@fastify/helmet";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { Environment } from "@printing-kiosk/config";
import { PRODUCT_SCOPE, healthResponseSchema } from "@printing-kiosk/contracts";

export async function buildAgent(environment: Environment): Promise<FastifyInstance> {
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

  void environment;
  return app;
}
