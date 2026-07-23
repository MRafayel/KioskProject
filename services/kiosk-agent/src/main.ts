import { loadEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";

import { buildAgent } from "./app.js";
import { CloudRealtimeConnection, SessionEventRelay } from "./events.js";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment();
const relay = new SessionEventRelay(environment);
const app = await buildAgent(environment, { eventSource: relay });
const realtime = new CloudRealtimeConnection(environment, relay);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "stopping kiosk agent");
  realtime.close();
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({
  host: environment.KIOSK_AGENT_HOST,
  port: environment.KIOSK_AGENT_PORT
});
