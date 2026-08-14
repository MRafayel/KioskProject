import { resolve } from "node:path";

import type { NonAdminEnvironment } from "@printing-kiosk/config";
import {
  createPrinterAdapter,
  parseQueueAllowlist,
  type PrinterAdapter
} from "@printing-kiosk/printer-adapters";

/**
 * Build the printer this kiosk drives.
 *
 * The kiosk is the same program whichever device it is attached to, so this is
 * the single place that knows which one it is. Everything downstream — the
 * print runner, the retention watchdog, the capability reporter — holds a
 * `PrinterAdapter` and cannot tell.
 *
 * The queue name is resolved here rather than at discovery time for the
 * adapters that need one up front. A configuration that names no preference and
 * certifies exactly one queue uses that queue; anything more ambiguous is left
 * for discovery to refuse, because guessing at this point would bind the kiosk
 * to a printer nobody chose.
 */
export function buildPrinterAdapter(environment: NonAdminEnvironment): PrinterAdapter {
  const approvedQueues = parseQueueAllowlist(environment.PRINTER_QUEUE_ALLOWLIST);
  const queueName =
    environment.PRINTER_QUEUE_NAME || (approvedQueues.length === 1 ? approvedQueues[0]! : "");

  return createPrinterAdapter({
    adapter: environment.PRINTER_ADAPTER,
    maxCopies: environment.MAX_COPIES,
    journalDirectory: resolve(environment.PRINTER_DEVICE_JOURNAL_DIR, "operations"),
    jobTimeoutMilliseconds: environment.PRINT_JOB_TIMEOUT_SECONDS * 1_000,
    mock: { outputDirectory: environment.PRINTER_MOCK_OUTPUT_DIR },
    windows: {
      hostExecutablePath: environment.PRINTER_WINDOWS_HOST_PATH,
      queueName,
      approvedQueues
    }
  });
}
