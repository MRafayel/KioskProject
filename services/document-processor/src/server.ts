import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { createProcessorServer } from "./app.js";
import { ClamAvClient } from "./clamav.js";
import { loadProcessorConfig } from "./config.js";
import { DocumentProcessor } from "./document-processor.js";
import { QpdfPopplerTools, SpawnCommandExecutor } from "./native-tools.js";
import { formatTimingReport, type TimingReport } from "./timings.js";

const config = loadProcessorConfig();
await mkdir(config.scratchDirectory, { recursive: true, mode: 0o700 });
await cleanupStaleScratch(config.scratchDirectory);

const scannerEndpoint = config.clamavSocketPath
  ? { socketPath: config.clamavSocketPath }
  : {
      host: config.clamavHost ?? "127.0.0.1",
      port: config.clamavPort ?? 3310
    };
const scanner = new ClamAvClient({
  ...scannerEndpoint,
  timeoutMilliseconds: config.scannerTimeoutMilliseconds,
  definitionMaxAgeMilliseconds: config.scannerDefinitionMaxAgeMilliseconds,
  maxStreamBytes: config.maxInputBytes
});
const executor = new SpawnCommandExecutor({
  timeoutMilliseconds: config.toolTimeoutMilliseconds
});
const tools = new QpdfPopplerTools(executor, config.maxPages);
const processor = new DocumentProcessor(config, scanner, tools);
const server = createProcessorServer({
  config,
  processor,
  // One line per request, and only when enabled. The report carries stage
  // names, counts and durations — never a path, digest or filename.
  ...(config.timingLog
    ? {
        onTiming: (report: TimingReport, kind: string) => {
          process.stdout.write(`${formatTimingReport(report, kind)}\n`);
        }
      }
    : {})
});

const shutdown = (signal: string) => {
  process.stdout.write(`${JSON.stringify({ level: "info", event: "shutdown", signal })}\n`);
  server.close(() => process.exit(0));
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      event: "listening",
      host: config.host,
      port: config.port
    })}\n`
  );
});

async function cleanupStaleScratch(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && /^(?:job|response)-[A-Za-z0-9_-]{6,64}$/u.test(entry.name)
      )
      .map((entry) => rm(join(directory, entry.name), { recursive: true, force: true }))
  );
}
