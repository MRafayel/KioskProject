import { MockPrinterAdapter, type MockPrinterScenario } from "./mock/adapter.js";
import { PrinterAdapterError, type PrinterAdapter } from "./types.js";
import { WindowsPrinterAdapter } from "./windows/adapter.js";
import { ChildProcessDeviceHost } from "./windows/child-process-host.js";
import type { DevicePrinterProfile } from "./windows/protocol.js";

export const PRINTER_ADAPTER_KINDS = ["mock", "windows"] as const;
export type PrinterAdapterKind = (typeof PRINTER_ADAPTER_KINDS)[number];

export interface PrinterAdapterFactoryOptions {
  adapter: PrinterAdapterKind;
  /** The deployment's copy ceiling. No device may raise it. */
  maxCopies: number;
  /** Where the local record of what was handed to a device is kept. */
  journalDirectory: string;
  /** How long a submission may take at the device before it is called unknown. */
  jobTimeoutMilliseconds?: number;
  mock?: {
    outputDirectory: string;
    defaultScenario?: MockPrinterScenario;
  };
  windows?: {
    hostExecutablePath: string;
    queueName: string;
    approvedQueues: readonly string[];
    /** Certified printer/driver combinations. Empty keeps the host's default. */
    approvedProfiles?: readonly DevicePrinterProfile[];
  };
}

/**
 * Build the adapter a deployment configured.
 *
 * The kiosk is the same program whichever printer it drives. Choosing here
 * rather than at each call site is what keeps that true: the runner, the
 * retention sweep and the capability reporter all hold a `PrinterAdapter` and
 * none of them can tell which one it is.
 *
 * A selection whose settings are missing is a startup failure. A kiosk that
 * silently fell back to the simulated printer would take a customer's money
 * and write their document to a folder.
 */
export function createPrinterAdapter(options: PrinterAdapterFactoryOptions): PrinterAdapter {
  if (options.adapter === "mock") {
    if (!options.mock) throw new PrinterAdapterError("DEVICE_ERROR");
    return new MockPrinterAdapter({
      outputDirectory: options.mock.outputDirectory,
      ...(options.mock.defaultScenario ? { defaultScenario: options.mock.defaultScenario } : {})
    });
  }

  if (!options.windows) throw new PrinterAdapterError("DEVICE_ERROR");
  return new WindowsPrinterAdapter({
    transport: new ChildProcessDeviceHost({
      executablePath: options.windows.hostExecutablePath
    }),
    queueName: options.windows.queueName,
    approvedQueues: options.windows.approvedQueues,
    ...(options.windows.approvedProfiles
      ? { approvedProfiles: options.windows.approvedProfiles }
      : {}),
    journalDirectory: options.journalDirectory,
    maxCopies: options.maxCopies,
    ...(options.jobTimeoutMilliseconds
      ? { submitTimeoutMilliseconds: options.jobTimeoutMilliseconds }
      : {})
  });
}
