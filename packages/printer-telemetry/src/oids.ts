import type { MarkerCounterUnit, PrinterEngineState, PrinterFault } from "./types.js";

/**
 * The columns this kiosk reads, and nothing else.
 *
 * Every one is a table column rather than a scalar, so each is walked and the
 * row index is the trailing arc. The set is fixed at build time: there is no
 * discovery, no configurable OID, and no way for a response to make the kiosk
 * ask for something it was not compiled to ask for.
 */
export const TELEMETRY_COLUMNS = {
  /** hrPrinterStatus — RFC 2790. */
  engine: "1.3.6.1.2.1.25.3.5.1.1",
  /** hrPrinterDetectedErrorState — RFC 2790, bits defined by RFC 3805. */
  errorState: "1.3.6.1.2.1.25.3.5.1.2",
  /** prtMarkerLifeCount — the only signal that can evidence physical output. */
  markerLifeCount: "1.3.6.1.2.1.43.10.2.1.4",
  /** prtMarkerCounterUnit — what one unit of the above actually means. */
  markerCounterUnit: "1.3.6.1.2.1.43.10.2.1.3",
  /** prtInputCurrentLevel — sheets, or a sentinel meaning it will not say. */
  inputCurrentLevel: "1.3.6.1.2.1.43.8.2.1.10",
  /** prtMarkerSuppliesLevel. */
  suppliesLevel: "1.3.6.1.2.1.43.11.1.1.9",
  /** prtMarkerSuppliesMaxCapacity, to turn a level into a proportion. */
  suppliesMaxCapacity: "1.3.6.1.2.1.43.11.1.1.8",
  /** prtGeneralSerialNumber — pinned identity. */
  serialNumber: "1.3.6.1.2.1.43.5.1.1.17",
  /** ifPhysAddress — pinned identity. */
  physicalAddress: "1.3.6.1.2.1.2.2.1.6"
} as const;

export type TelemetryColumn = keyof typeof TELEMETRY_COLUMNS;

/**
 * Row caps, applied per column.
 *
 * A walk is a loop driven by what the far end returns, so the far end decides
 * when it stops unless something else does. These are that something else. They
 * are set well above any real printer: a device with more than sixteen input
 * trays is not a device this kiosk is certified against, and refusing to read
 * the seventeenth costs nothing.
 */
export const MAX_ROWS_PER_COLUMN = 16;

/** A serial longer than this is not a serial number, it is a payload. */
export const MAX_SERIAL_LENGTH = 64;

/**
 * `prtInputCurrentLevel` and `prtMarkerSuppliesLevel` sentinels (RFC 3805).
 * Negative values are not quantities and must never be arithmetic.
 */
const LEVEL_OTHER = -1;
const LEVEL_UNKNOWN = -2;
/** "At least one unit remains", with no count. All the certified Canon gives. */
const LEVEL_SOME_REMAINING = -3;

/**
 * hrPrinterDetectedErrorState, most significant bit first.
 *
 * Bit 0 is `0x80` of the first octet, not `0x01` — the numbering in RFC 2790 is
 * the opposite way round from the one most people reach for, and reading it the
 * intuitive way turns "out of paper" into "output tray missing". Confirmed
 * against the certified Canon: `0xC0 0x00` while a job was blocked with the tray
 * empty, decoding to lowPaper + noPaper, and `0x80 0x00` once the job was
 * cancelled and only the standing tray condition remained.
 */
const ERROR_STATE_BITS: readonly (readonly PrinterFault[])[] = [
  ["LOW_PAPER", "NO_PAPER", "LOW_TONER", "NO_TONER", "DOOR_OPEN", "JAMMED", "OFFLINE", "SERVICE_REQUESTED"],
  [
    "INPUT_TRAY_MISSING",
    "OUTPUT_TRAY_MISSING",
    "MARKER_SUPPLY_MISSING",
    "OUTPUT_NEAR_FULL",
    "OUTPUT_FULL",
    "INPUT_TRAY_EMPTY",
    "OVERDUE_PREVENTIVE_MAINTENANCE"
  ]
];

export function decodeEngineState(value: number): PrinterEngineState {
  switch (value) {
    case 1:
      return "OTHER";
    case 3:
      return "IDLE";
    case 4:
      return "PRINTING";
    case 5:
      return "WARMUP";
    default:
      // unknown(2), and anything the device invented.
      return "UNKNOWN";
  }
}

export function decodeErrorState(octets: Uint8Array): PrinterFault[] {
  const faults: PrinterFault[] = [];
  for (const [octetIndex, names] of ERROR_STATE_BITS.entries()) {
    const octet = octets[octetIndex];
    if (octet === undefined) break;
    for (const [bitIndex, name] of names.entries()) {
      if ((octet & (0x80 >> bitIndex)) !== 0) faults.push(name);
    }
  }
  return faults;
}

/** `PrtMarkerCounterUnitTC` — impressions(7), sheets(8). */
export function decodeCounterUnit(value: number): MarkerCounterUnit {
  if (value === 7) return "IMPRESSIONS";
  if (value === 8) return "SHEETS";
  return "UNKNOWN";
}

/**
 * A level column reading. Returns the sheet count only when the device gives a
 * real one, so a sentinel can never be mistaken for a quantity.
 */
export function decodeLevel(value: number): { present: boolean | null; count: number | null } {
  if (value === LEVEL_SOME_REMAINING) return { present: true, count: null };
  if (value === LEVEL_OTHER || value === LEVEL_UNKNOWN) return { present: null, count: null };
  if (value < 0) return { present: null, count: null };
  if (value === 0) return { present: false, count: 0 };
  return { present: true, count: value };
}

/**
 * The row index of a binding within its column, or `null` if the binding is not
 * in the column at all — which is how a walk that ran past the end of the table,
 * or a device answering with an OID nobody asked for, is discarded.
 *
 * Only single-arc indices are accepted. `prtMarkerSuppliesLevel` is indexed by
 * two arcs (device, supply), so its rows are keyed on the pair; the caller that
 * needs that passes the joined remainder instead.
 */
export function rowIndexOf(oid: string, columnOid: string): string | null {
  const prefix = `${columnOid}.`;
  if (!oid.startsWith(prefix)) return null;
  const remainder = oid.slice(prefix.length);
  if (remainder.length === 0) return null;
  // Arcs are unsigned decimal. Anything else is not an index we will index by.
  return /^\d+(\.\d+)*$/.test(remainder) ? remainder : null;
}
