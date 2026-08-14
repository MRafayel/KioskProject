import { release } from "node:os";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";

import { buildAgent } from "./app.js";
import { buildPrinterAdapter } from "./device/adapter.js";
import { loadAgentIdentity } from "./device/identity.js";
import { DeviceRegistryReporter } from "./device/reporter.js";
import { CloudRealtimeConnection, SessionEventRelay } from "./events.js";
import { PrintCommandRunner } from "./print/runner.js";

const AGENT_VERSION = "0.0.0";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment();
const relay = new SessionEventRelay(environment);
const app = await buildAgent(environment, { eventSource: relay });
const realtime = new CloudRealtimeConnection(environment, relay);

// The printer lives on this machine, behind the adapter contract. Which device
// it actually is — the simulated one, a network printer over IPP, or the
// Windows print subsystem through a local host — is configuration, and nothing
// below this line can tell the difference.
const printerAdapter = buildPrinterAdapter(environment);
const logger = {
  info: (fields: Record<string, unknown>, message: string) => app.log.info(fields, message),
  warn: (fields: Record<string, unknown>, message: string) => app.log.warn(fields, message)
};

const printRunner = new PrintCommandRunner({
  environment,
  adapter: printerAdapter,
  logger
});
printRunner.start();

// The device plane. It tells the control plane which machine and which printer
// this is, and republishes what the printer can do the moment that changes, so
// a customer is never offered settings the attached hardware cannot produce.
const deviceReporter = new DeviceRegistryReporter({
  environment,
  adapter: printerAdapter,
  logger,
  agentId: await loadAgentIdentity(environment.PRINTER_DEVICE_JOURNAL_DIR),
  agentVersion: AGENT_VERSION,
  platform: agentPlatform(),
  platformRelease: release() || null,
  activeOperations: () => printRunner.activeOperations
});
deviceReporter.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "stopping kiosk agent");
  deviceReporter.close();
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

/**
 * The kiosk platform, as the control plane records it. A platform this build
 * does not know about is reported as Linux rather than refused: the field is a
 * support and certification record, not a gate.
 */
function agentPlatform(): "win32" | "linux" | "darwin" {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
