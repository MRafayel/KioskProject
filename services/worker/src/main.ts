import pino from "pino";

import { loadEnvironment, loadWorkspaceEnvironmentFile } from "@printing-kiosk/config";
import { PRODUCT_SCOPE } from "@printing-kiosk/contracts";
import { createDatabaseClient } from "@printing-kiosk/database";

import { OutboxPublisher } from "./jobs/publish-outbox.js";

loadWorkspaceEnvironmentFile();
const environment = loadEnvironment();
const logger = pino({ level: environment.LOG_LEVEL });
const database = createDatabaseClient(environment.DATABASE_URL);
const publisher = new OutboxPublisher(database, environment, logger);

logger.info({ productScope: PRODUCT_SCOPE }, "worker started");
publisher.start();

const shutdown = async (signal: string) => {
  logger.info({ signal }, "worker stopped");
  await publisher.close();
  await database.$disconnect();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
