import { loadEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";
import { createDatabaseClient } from "@printing-kiosk/database";

import { buildApp } from "./app.js";
import { createS3ObjectStore } from "./modules/files/object-store.js";
import { RealtimeGateway } from "./modules/realtime/gateway.js";
import { LocalSessionEventBus } from "./modules/realtime/session-event-bus.js";
import { SystemClock } from "./modules/sessions/crypto.js";
import { checkInfrastructure } from "./readiness.js";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment();
const objectStore = createS3ObjectStore(environment);
const database = createDatabaseClient(environment.DATABASE_URL);
const clock = new SystemClock();
const sessionEvents = new LocalSessionEventBus();
// The gateway needs the HTTP server that buildApp creates, and readiness needs
// the gateway's Redis connection. Readiness only runs once the server is
// listening, by which point this holder is populated.
const realtime: { gateway?: RealtimeGateway } = {};
const app = await buildApp({
  environment,
  logger: true,
  objectStore,
  database,
  clock,
  sessionEvents,
  readinessCheck: () =>
    checkInfrastructure({
      database,
      objectStore,
      redis: () =>
        realtime.gateway?.checkRedis() ?? Promise.reject(new Error("REALTIME_GATEWAY_NOT_STARTED"))
    })
});
realtime.gateway = new RealtimeGateway(
  app.server,
  database,
  clock,
  environment,
  app.log,
  sessionEvents
);
app.addHook("onClose", async () => {
  await realtime.gateway?.close();
  await database.$disconnect();
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
