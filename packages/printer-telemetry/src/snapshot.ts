import {
  MAX_SERIAL_LENGTH,
  TELEMETRY_COLUMNS,
  decodeCounterUnit,
  decodeEngineState,
  decodeErrorState,
  decodeLevel,
  rowIndexOf,
  type TelemetryColumn
} from "./oids.js";
import type {
  MarkerCounter,
  PinnedIdentity,
  PrinterFault,
  PrinterInput,
  PrinterSupply,
  SnmpVarbind,
  TelemetryReadResult
} from "./types.js";

/** What a walk of each column returned. A column absent from the map was not read. */
export type ColumnReadings = ReadonlyMap<TelemetryColumn, readonly SnmpVarbind[]>;

/** Counter32 is unsigned 32-bit; anything outside it did not come from a counter. */
const MAX_COUNTER32 = 0xff_ff_ff_ff;

/**
 * Turn what came back off the wire into a snapshot, or refuse.
 *
 * Every value here arrived from a device on a cable, so none of it is trusted
 * further than its own field: a malformed tray row costs the tray row, not the
 * fault bitmask beside it. The single exception is identity, which is checked
 * before anything else is read and discards the whole reply on failure — a
 * snapshot that cannot be attributed to the pinned printer is not partial data,
 * it is somebody else's data.
 */
export function buildSnapshot(input: {
  readonly readAt: Date;
  readonly readings: ColumnReadings;
  readonly identity: PinnedIdentity;
}): TelemetryReadResult {
  const serialNumber = readSerialNumber(input.readings);
  if (serialNumber === null) return unavailable("IDENTITY_UNREADABLE");
  if (!matchesPinned(serialNumber, input.identity.serialNumber)) {
    return unavailable("IDENTITY_MISMATCH");
  }

  const pinnedMac = input.identity.macAddress.trim().toLowerCase();
  if (pinnedMac.length > 0) {
    const reported = readPhysicalAddresses(input.readings);
    // Pinning a MAC and then not being able to read one is not a pass. The
    // check was configured; a device that will not answer it has failed it.
    if (reported === null) return unavailable("IDENTITY_UNREADABLE");
    if (!reported.includes(pinnedMac)) return unavailable("IDENTITY_MISMATCH");
  }

  const engine = readEngineState(input.readings);
  const faults = readFaults(input.readings);
  const marker = readMarker(input.readings);
  const inputs = readInputs(input.readings);
  const supplies = readSupplies(input.readings);

  // It identified itself and said nothing else. Reporting that as a snapshot of
  // a healthy printer is the exact mistake this package exists to prevent.
  if (engine === "UNKNOWN" && faults === null && marker === null && inputs === null && supplies === null) {
    return unavailable("NO_USABLE_VALUES");
  }

  return {
    outcome: "OK",
    snapshot: { readAt: input.readAt, serialNumber, engine, faults, marker, inputs, supplies }
  };
}

function unavailable(reason: Extract<TelemetryReadResult, { outcome: "UNAVAILABLE" }>["reason"]) {
  return { outcome: "UNAVAILABLE", reason } as const;
}

function matchesPinned(reported: string, pinned: string): boolean {
  return reported.toLowerCase() === pinned.trim().toLowerCase();
}

/**
 * Serial numbers are printed on a label and typed into a config file, so the
 * only bytes worth accepting are the ones that survive that journey. Control
 * characters and anything above ASCII are rejected rather than stripped: a
 * serial that needed cleaning up is not the serial on the label.
 */
function readSerialNumber(readings: ColumnReadings): string | null {
  for (const binding of readings.get("serialNumber") ?? []) {
    if (rowIndexOf(binding.oid, TELEMETRY_COLUMNS.serialNumber) === null) continue;
    if (binding.bytes === null) continue;
    if (binding.bytes.length > MAX_SERIAL_LENGTH) continue;
    let text = "";
    let printable = true;
    for (const byte of binding.bytes) {
      if (byte < 0x20 || byte > 0x7e) {
        printable = false;
        break;
      }
      text += String.fromCharCode(byte);
    }
    if (!printable) continue;
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Every interface MAC the device admits to, lower-cased and colon-separated.
 * `null` distinguishes "the column was not readable" from "it has interfaces
 * but none of them is yours", which are answered differently above.
 */
function readPhysicalAddresses(readings: ColumnReadings): string[] | null {
  const column = readings.get("physicalAddress");
  if (column === undefined) return null;
  const addresses: string[] = [];
  for (const binding of column) {
    if (rowIndexOf(binding.oid, TELEMETRY_COLUMNS.physicalAddress) === null) continue;
    if (binding.bytes === null || binding.bytes.length !== 6) continue;
    // A loopback or unnumbered interface reports all zeroes. Matching on it
    // would make the pin meaningless for any device that has one.
    if (binding.bytes.every((byte) => byte === 0)) continue;
    addresses.push(
      [...binding.bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(":")
    );
  }
  return addresses.length > 0 ? addresses : null;
}

function readEngineState(readings: ColumnReadings) {
  const value = firstInteger(readings, "engine");
  return value === null ? ("UNKNOWN" as const) : decodeEngineState(value);
}

function readFaults(readings: ColumnReadings): PrinterFault[] | null {
  for (const binding of readings.get("errorState") ?? []) {
    if (rowIndexOf(binding.oid, TELEMETRY_COLUMNS.errorState) === null) continue;
    if (binding.bytes === null) continue;
    // An all-clear is a zero-length or all-zero string, and both are meaningful
    // answers — unlike an absent column, which is silence.
    return decodeErrorState(binding.bytes);
  }
  return null;
}

function readMarker(readings: ColumnReadings): MarkerCounter | null {
  const counts = indexed(readings, "markerLifeCount");
  const units = indexed(readings, "markerCounterUnit");
  // Lowest row index wins. A mono laser has one marker; ordering makes the
  // choice deterministic rather than dependent on walk order.
  const rows = [...counts.keys()].sort(compareRowIndex);
  for (const row of rows) {
    const lifeCount = counts.get(row);
    if (lifeCount === undefined) continue;
    if (!Number.isSafeInteger(lifeCount) || lifeCount < 0 || lifeCount > MAX_COUNTER32) continue;
    const unit = units.get(row);
    return { lifeCount, unit: unit === undefined ? "UNKNOWN" : decodeCounterUnit(unit) };
  }
  return null;
}

function readInputs(readings: ColumnReadings): PrinterInput[] | null {
  const levels = indexed(readings, "inputCurrentLevel");
  if (levels.size === 0) return null;
  const inputs: PrinterInput[] = [];
  for (const row of [...levels.keys()].sort(compareRowIndex)) {
    const raw = levels.get(row);
    if (raw === undefined || !Number.isSafeInteger(raw)) continue;
    const index = componentIndexOf(row);
    if (index === null) continue;
    const level = decodeLevel(raw);
    inputs.push({
      index,
      presence: level.present === null ? "UNKNOWN" : level.present ? "PRESENT" : "EMPTY",
      sheets: level.count
    });
  }
  return inputs.length > 0 ? inputs : null;
}

function readSupplies(readings: ColumnReadings): PrinterSupply[] | null {
  const levels = indexed(readings, "suppliesLevel");
  const capacities = indexed(readings, "suppliesMaxCapacity");
  if (levels.size === 0) return null;
  const supplies: PrinterSupply[] = [];
  for (const row of [...levels.keys()].sort(compareRowIndex)) {
    const raw = levels.get(row);
    if (raw === undefined || !Number.isSafeInteger(raw)) continue;
    const index = componentIndexOf(row);
    if (index === null) continue;
    supplies.push({ index, percentRemaining: percentOf(raw, capacities.get(row)) });
  }
  return supplies.length > 0 ? supplies : null;
}

/**
 * A proportion, only where the device gave two real numbers to make one from.
 * Sentinels are negative and capacities can be zero, so this refuses far more
 * often than it answers — which is correct for a number that would otherwise be
 * shown to an operator as a toner percentage.
 */
function percentOf(level: number, capacity: number | undefined): number | null {
  if (level < 0) return null;
  if (capacity === undefined || !Number.isSafeInteger(capacity) || capacity <= 0) return null;
  if (level > capacity) return null;
  return Math.round((level / capacity) * 100);
}

function firstInteger(readings: ColumnReadings, column: TelemetryColumn): number | null {
  for (const binding of readings.get(column) ?? []) {
    if (rowIndexOf(binding.oid, TELEMETRY_COLUMNS[column]) === null) continue;
    if (binding.integer !== null && Number.isSafeInteger(binding.integer)) return binding.integer;
  }
  return null;
}

/** Integer rows of a column, keyed by row index. Non-integer rows are dropped. */
function indexed(readings: ColumnReadings, column: TelemetryColumn): Map<string, number> {
  const rows = new Map<string, number>();
  for (const binding of readings.get(column) ?? []) {
    const row = rowIndexOf(binding.oid, TELEMETRY_COLUMNS[column]);
    if (row === null) continue;
    if (binding.integer === null || !Number.isSafeInteger(binding.integer)) continue;
    // First writer wins, so a device repeating a row cannot overwrite what it
    // already said with something more convenient.
    if (!rows.has(row)) rows.set(row, binding.integer);
  }
  return rows;
}

/**
 * Which tray, or which cartridge — the part of a row index an operator would
 * recognise.
 *
 * Both `prtInputTable` and `prtMarkerSuppliesTable` are indexed by
 * `{ hrDeviceIndex, prtXxxIndex }`, so a row arrives as two arcs and the second
 * is the component. `Number.parseInt` on the whole thing silently stops at the
 * dot and answers with the *device* index instead, which is the same for every
 * row — that is how a printer with two trays came back reporting tray 1 twice.
 * Both callers go through here so they cannot drift apart again.
 */
function componentIndexOf(row: string): number | null {
  const arcs = row.split(".");
  const parsed = Number.parseInt(arcs[arcs.length - 1] ?? "", 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Numeric arc order, so row 10 sorts after row 9 rather than after row 1. */
function compareRowIndex(left: string, right: string): number {
  const leftArcs = left.split(".");
  const rightArcs = right.split(".");
  for (let position = 0; position < Math.max(leftArcs.length, rightArcs.length); position += 1) {
    const a = Number.parseInt(leftArcs[position] ?? "-1", 10);
    const b = Number.parseInt(rightArcs[position] ?? "-1", 10);
    if (a !== b) return a - b;
  }
  return 0;
}
