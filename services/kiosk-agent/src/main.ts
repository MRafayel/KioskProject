import { loadEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";
import { MockPrinterAdapter } from "@printing-kiosk/printer-adapters";

import { buildAgent } from "./app.js";
import { CloudRealtimeConnection, SessionEventRelay } from "./events.js";
import { PrintCommandRunner } from "./print/runner.js";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment();
const relay = new SessionEventRelay(environment);
const app = await buildAgent(environment, { eventSource: relay });
const realtime = new CloudRealtimeConnection(environment, relay);

// The printer lives on this machine, behind the adapter contract. The pilot
// device writes files; a Windows spooler implementation replaces it later
// without any control-plane change.
const printRunner = new PrintCommandRunner({
  environment,
  adapter: new MockPrinterAdapter({ outputDirectory: environment.PRINTER_MOCK_OUTPUT_DIR }),
  logger: {
    info: (fields, message) => app.log.info(fields, message),
    warn: (fields, message) => app.log.warn(fields, message)
  }
});
printRunner.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "stopping kiosk agent");
  printRunner.close();
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
