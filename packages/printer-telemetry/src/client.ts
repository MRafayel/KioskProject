import { MAX_ROWS_PER_COLUMN, TELEMETRY_COLUMNS, type TelemetryColumn } from "./oids.js";
import { buildSnapshot } from "./snapshot.js";
import type {
  PinnedIdentity,
  SnmpTransport,
  SnmpVarbind,
  TelemetryReadResult
} from "./types.js";

/**
 * The transport could not get an answer in time. Separate from every other
 * failure because it is the one that happens routinely: this printer drops
 * roughly one request in eight, and sleeps. Neither is a fault, and neither may
 * ever be reported as one.
 */
export class SnmpTimeoutError extends Error {
  public constructor(message = "SNMP request timed out") {
    super(message);
    this.name = "SnmpTimeoutError";
  }
}

export interface TelemetryClock {
  now(): Date;
}

export interface PrinterTelemetryClientOptions {
  readonly transport: SnmpTransport;
  readonly identity: PinnedIdentity;
  readonly clock: TelemetryClock;
  /** Wall-clock ceiling for a whole reading, across every column and retry. */
  readonly budgetMs: number;
  /** Attempts per column, including the first. */
  readonly attemptsPerColumn: number;
}

export interface PrinterTelemetryClient {
  read(): Promise<TelemetryReadResult>;
  close(): void;
}

/**
 * Columns in the order they are worth having.
 *
 * Identity comes first so that a reading cut short by the budget is still
 * attributable — a partial snapshot from the right printer is useful, and one
 * from an unverified device is not usable at all. Faults come next because they
 * are what gates a sale, then the marker counter, then the levels that only
 * decorate an operator console.
 */
const COLUMN_ORDER: readonly TelemetryColumn[] = [
  "serialNumber",
  "physicalAddress",
  "errorState",
  "engine",
  "markerLifeCount",
  "markerCounterUnit",
  "inputCurrentLevel",
  "suppliesLevel",
  "suppliesMaxCapacity"
];

/**
 * Reads the pinned printer, within a fixed budget, and never invents an answer.
 *
 * This is deliberately not on the path of a print in flight. It gates whether a
 * *new* job may be accepted and it feeds an operator console; a printer that has
 * stopped answering must never be able to stall a job somebody has already paid
 * for. The budget is the mechanism: the reading ends when the clock says so,
 * with whatever it has, and a reading that has nothing is unavailable rather
 * than empty.
 */
export function createPrinterTelemetryClient(
  options: PrinterTelemetryClientOptions
): PrinterTelemetryClient {
  const attempts = Math.max(1, Math.trunc(options.attemptsPerColumn));
  const pinsMac = options.identity.macAddress.trim().length > 0;

  return {
    async read(): Promise<TelemetryReadResult> {
      const startedAt = options.clock.now().getTime();
      const readings = new Map<TelemetryColumn, readonly SnmpVarbind[]>();
      let sawTransportError = false;

      const spent = () => options.clock.now().getTime() - startedAt;

      for (const column of COLUMN_ORDER) {
        // Nothing checks the MAC when none is pinned, so asking for it would be
        // a round trip spent on a value that will be discarded.
        if (column === "physicalAddress" && !pinsMac) continue;
        if (spent() >= options.budgetMs) break;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (spent() >= options.budgetMs) break;
          try {
            readings.set(
              column,
              await options.transport.walkColumn(TELEMETRY_COLUMNS[column], MAX_ROWS_PER_COLUMN)
            );
            break;
          } catch (error) {
            if (!(error instanceof SnmpTimeoutError)) sawTransportError = true;
          }
        }
      }

      if (readings.size === 0) {
        // Both mean the same thing to a caller — we do not know — but they are
        // reported apart because a timeout is the expected case on a printer
        // that sleeps, and an operator should not be shown an error for it.
        // A budget spent before the first reply lands here too, as a timeout.
        return unavailable(sawTransportError ? "TRANSPORT_ERROR" : "TIMEOUT");
      }

      return buildSnapshot({
        readAt: options.clock.now(),
        readings,
        identity: options.identity
      });
    },
    close(): void {
      options.transport.close();
    }
  };
}

function unavailable(reason: Extract<TelemetryReadResult, { outcome: "UNAVAILABLE" }>["reason"]) {
  return { outcome: "UNAVAILABLE", reason } as const;
}
