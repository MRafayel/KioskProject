import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { Environment } from "@printing-kiosk/config";
import { PRODUCT_SCOPE, healthResponseSchema } from "@printing-kiosk/contracts";

export interface BuildAppOptions {
  environment: Environment;
  logger?: boolean;
  readinessCheck?: () => Record<string, "ok" | "failed"> | Promise<Record<string, "ok" | "failed">>;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({
      disableRequestLogging: true
    })
  });

  await app.register(helmet);
  await app.register(cors, {
    credentials: true,
    origin: [options.environment.KIOSK_ORIGIN, options.environment.UPLOAD_ORIGIN]
  });

  app.get("/health/live", () =>
    healthResponseSchema.parse({
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
      productScope: PRODUCT_SCOPE
    })
  );

  app.get("/health/ready", async (_request, reply) => {
    const checks = await (options.readinessCheck ?? defaultReadinessCheck)();
    const ready = Object.values(checks).every((status) => status === "ok");
    const response = healthResponseSchema.parse({
      status: ready ? "ready" : "not_ready",
      service: "api",
      timestamp: new Date().toISOString(),
      productScope: PRODUCT_SCOPE,
      checks
    });

    return reply.code(ready ? 200 : 503).send(response);
  });

  return app;
}

function defaultReadinessCheck(): Record<string, "ok"> {
  return { configuration: "ok" };
}
