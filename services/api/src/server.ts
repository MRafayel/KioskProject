import "dotenv/config";

import { loadEnvironment } from "@printing-kiosk/config";

import { buildApp } from "./app.js";
import { checkInfrastructure } from "./readiness.js";

const environment = loadEnvironment();
const app = await buildApp({
  environment,
  logger: true,
  readinessCheck: () => checkInfrastructure(environment)
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "stopping API");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({
  host: environment.API_HOST,
  port: environment.API_PORT
});
