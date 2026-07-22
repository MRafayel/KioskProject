import { loadEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";

import { buildApp } from "./app.js";
import { createS3ObjectStore } from "./modules/files/object-store.js";
import { checkInfrastructure } from "./readiness.js";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment();
const objectStore = createS3ObjectStore(environment);
const app = await buildApp({
  environment,
  logger: true,
  objectStore,
  readinessCheck: () => checkInfrastructure(environment, objectStore)
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
