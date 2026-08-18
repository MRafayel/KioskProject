import { release } from "node:os";

import { loadNonAdminEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";

import { buildAgent } from "./app.js";
import { buildPrinterAdapter } from "./device/adapter.js";
import { WindowsEventLog } from "./device/event-log.js";
import { loadAgentIdentity } from "./device/identity.js";
import { DeviceRegistryReporter } from "./device/reporter.js";
import { CloudRealtimeConnection, SessionEventRelay } from "./events.js";
import { PrintCommandRunner } from "./print/runner.js";

const AGENT_VERSION = "0.0.0";

loadWorkspaceEnvironmentFile();
const environment = loadNonAdminEnvironment();
const relay = new SessionEventRelay(environment);
const app = await buildAgent(environment, { eventSource: relay, logger: true });
const realtime = new CloudRealtimeConnection(environment, relay);

// The printer lives on this machine, behind the adapter contract. Which device
// it actually is — the simulated development device or the local Windows USB
// print subsystem — is configuration, and nothing below this line can tell the
// difference.
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

// Installed as a Windows service, this process has no console and its standard
// output goes nowhere. These few events are the only trace a technician can
// find on a kiosk that will not start or has stopped talking to the control
// plane; everything else belongs in the ledger, not on the machine.
const eventLog = new WindowsEventLog();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "stopping kiosk agent");
  await eventLog.write("stopping", `Kiosk agent stopping on ${signal}.`);
  deviceReporter.close();
  printRunner.close();
  realtime.close();
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

// A kiosk that dies without saying why is one somebody has to drive to. The
// process is still allowed to fall over — the service manager restarts it —
// but not silently.
const reportFatal = (reason: string, error: unknown) => {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "";
  app.log.error({ reason, errorName: name }, "kiosk agent fatal error");
  void eventLog.write("fatal", `Kiosk agent ${reason}: ${name} ${message}`);
};
process.on("uncaughtException", (error) => reportFatal("uncaught exception", error));
process.on("unhandledRejection", (reason) => reportFatal("unhandled rejection", reason));

try {
  await app.listen({
    host: environment.KIOSK_AGENT_HOST,
    port: environment.KIOSK_AGENT_PORT
  });
} catch (error) {
  reportFatal("could not start", error);
  throw error;
}

await eventLog.write(
  "started",
  `Kiosk agent started on ${environment.KIOSK_AGENT_HOST}:${environment.KIOSK_AGENT_PORT} ` +
    `using the ${environment.PRINTER_ADAPTER} printer adapter.`
);

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
