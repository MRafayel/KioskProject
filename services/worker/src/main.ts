import pino from "pino";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";
import { PRODUCT_SCOPE } from "@printing-kiosk/contracts";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment();
const logger = pino({ level: environment.LOG_LEVEL });

logger.info({ productScope: PRODUCT_SCOPE }, "worker started");

const shutdown = (signal: string) => {
  logger.info({ signal }, "worker stopped");
  process.exit(0);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

setInterval(() => undefined, 60_000);
