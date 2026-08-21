import { describe, expect, it } from "vitest";

import { TELEMETRY_COLUMNS, type TelemetryColumn } from "./oids.js";
import { buildSnapshot, type ColumnReadings } from "./snapshot.js";
import type { PinnedIdentity, PrinterTelemetrySnapshot, SnmpVarbind } from "./types.js";

/**
 * The values here are the ones the certified Canon LBP361 actually returned on
 * 20–21 Aug 2026, not invented ones. `C0 00` is the bitmask it reported with a
 * job blocked and the tray pulled; `80 00` is what remained after the job was
 * cancelled; `-3` is the sentinel it gives for a loaded tray, having no sheet
 * count to offer. Anchoring on real captures is what stops the parser being
 * correct only about a device nobody owns.
 */

const SERIAL = "PKQA002495";
const MAC = "00:1e:8f:aa:bb:cc";
const IDENTITY: PinnedIdentity = { serialNumber: SERIAL, macAddress: "" };

describe("identity", () => {
  it("discards a reply from a printer that is not the pinned one", () => {
    const result = buildSnapshot({
      readAt: new Date(),
      readings: readings({ serialNumber: [text(1, "SOMEBODY-ELSE")], engine: [int(1, 4)] }),
      identity: IDENTITY
    });
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "IDENTITY_MISMATCH" });
  });

  it("refuses a reply it cannot attribute at all", () => {
    const result = buildSnapshot({
      readAt: new Date(),
      readings: readings({ engine: [int(1, 4)], errorState: [octets(1, [0x00, 0x00])] }),
      identity: IDENTITY
    });
    // Plenty of usable telemetry, and no way to know whose it is.
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "IDENTITY_UNREADABLE" });
  });

  it("matches the pinned serial regardless of case and surrounding space", () => {
    const result = buildSnapshot({
      readAt: new Date(),
      readings: readings({ serialNumber: [text(1, `  ${SERIAL.toLowerCase()}  `)], engine: [int(1, 3)] }),
      identity: IDENTITY
    });
    expect(result.outcome).toBe("OK");
  });

  it("accepts the pinned MAC on any interface the device reports", () => {
    const result = buildSnapshot({
      readAt: new Date(),
      readings: readings({
        serialNumber: [text(1, SERIAL)],
        physicalAddress: [octets(1, [0, 0, 0, 0, 0, 0]), octets(2, [0x00, 0x1e, 0x8f, 0xaa, 0xbb, 0xcc])],
        engine: [int(1, 3)]
      }),
      identity: { serialNumber: SERIAL, macAddress: MAC }
    });
    expect(result.outcome).toBe("OK");
  });

  it("fails a pinned MAC the device does not have", () => {
    const result = buildSnapshot({
      readAt: new Date(),
      readings: readings({
        serialNumber: [text(1, SERIAL)],
        physicalAddress: [octets(1, [0x11, 0x22, 0x33, 0x44, 0x55, 0x66])],
        engine: [int(1, 3)]
      }),
      identity: { serialNumber: SERIAL, macAddress: MAC }
    });
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "IDENTITY_MISMATCH" });
  });

  it("treats an unanswerable MAC check as a failed one, not a skipped one", () => {
    const result = buildSnapshot({
      readAt: new Date(),
      readings: readings({ serialNumber: [text(1, SERIAL)], engine: [int(1, 3)] }),
      identity: { serialNumber: SERIAL, macAddress: MAC }
    });
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "IDENTITY_UNREADABLE" });
  });
});

describe("fault bitmask", () => {
  it("decodes the blocked-and-empty state the printer really sent", () => {
    expect(faultsFrom([0xc0, 0x00])).toEqual(["LOW_PAPER", "NO_PAPER"]);
  });

  it("decodes the standing tray condition left after the job was cancelled", () => {
    expect(faultsFrom([0x80, 0x00])).toEqual(["LOW_PAPER"]);
  });

  it("reports an explicit all-clear as no faults, not as unknown", () => {
    expect(faultsFrom([0x00, 0x00])).toEqual([]);
  });

  it("reads the second octet's bits", () => {
    expect(faultsFrom([0x00, 0x0c])).toEqual(["OUTPUT_FULL", "INPUT_TRAY_EMPTY"]);
  });

  it("does not invent bits from octets the device did not send", () => {
    expect(faultsFrom([0x40])).toEqual(["NO_PAPER"]);
  });

  it("distinguishes a column that was never read from one that said all-clear", () => {
    const snapshot = ok(readings({ serialNumber: [text(1, SERIAL)], engine: [int(1, 4)] }));
    // `null`, not `[]`. A caller gating a sale on this must refuse, and `[]`
    // would tell it the printer is fine.
    expect(snapshot.faults).toBeNull();
  });
});

describe("marker counter", () => {
  it("reads the count and the unit that decides what it means", () => {
    const snapshot = ok(
      readings({
        serialNumber: [text(1, SERIAL)],
        markerLifeCount: [int(1, 96)],
        markerCounterUnit: [int(1, 7)]
      })
    );
    expect(snapshot.marker).toEqual({ lifeCount: 96, unit: "IMPRESSIONS" });
  });

  it("reports the unit as unknown rather than guessing when the device omits it", () => {
    const snapshot = ok(
      readings({ serialNumber: [text(1, SERIAL)], markerLifeCount: [int(1, 96)] })
    );
    // A duplex comparison against an unknown unit would be wrong half the time,
    // so the caller must be able to see that it cannot be made.
    expect(snapshot.marker).toEqual({ lifeCount: 96, unit: "UNKNOWN" });
  });

  it("takes the lowest marker row so the choice does not depend on walk order", () => {
    const snapshot = ok(
      readings({
        serialNumber: [text(1, SERIAL)],
        markerLifeCount: [int(10, 5_000), int(2, 96)],
        markerCounterUnit: [int(2, 8), int(10, 7)]
      })
    );
    expect(snapshot.marker).toEqual({ lifeCount: 96, unit: "SHEETS" });
  });

  it("rejects a count outside the range a Counter32 can hold", () => {
    const snapshot = ok(
      readings({
        serialNumber: [text(1, SERIAL)],
        engine: [int(1, 3)],
        markerLifeCount: [int(1, -1), int(2, 2 ** 33)]
      })
    );
    expect(snapshot.marker).toBeNull();
  });
});

describe("input trays", () => {
  it("reads presence without inventing a sheet count", () => {
    const snapshot = ok(
      readings({ serialNumber: [text(1, SERIAL)], inputCurrentLevel: [int(1, 0), int(2, -3)] })
    );
    expect(snapshot.inputs).toEqual([
      { index: 1, presence: "EMPTY", sheets: 0 },
      // -3 is "some remaining". The kiosk therefore cannot know before payment
      // whether fifty sheets are available, only that paper is present.
      { index: 2, presence: "PRESENT", sheets: null }
    ]);
  });

  it("passes through a real sheet count from a printer that gives one", () => {
    const snapshot = ok(
      readings({ serialNumber: [text(1, SERIAL)], inputCurrentLevel: [int(1, 250)] })
    );
    expect(snapshot.inputs).toEqual([{ index: 1, presence: "PRESENT", sheets: 250 }]);
  });

  it("maps the other and unknown sentinels to unknown, never to empty", () => {
    const snapshot = ok(
      readings({ serialNumber: [text(1, SERIAL)], inputCurrentLevel: [int(1, -1), int(2, -2)] })
    );
    expect(snapshot.inputs?.map((tray) => tray.presence)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });
});

describe("supplies", () => {
  it("computes a proportion only when both numbers are real", () => {
    const snapshot = ok(
      readings({
        serialNumber: [text(1, SERIAL)],
        suppliesLevel: [int("1.1", 40), int("1.2", 30), int("1.3", -3)],
        suppliesMaxCapacity: [int("1.1", 80), int("1.2", -2)]
      })
    );
    expect(snapshot.supplies).toEqual([
      { index: 1, percentRemaining: 50 },
      // Capacity is the "unknown" sentinel, so there is no proportion to show.
      { index: 2, percentRemaining: null },
      { index: 3, percentRemaining: null }
    ]);
  });

  it("refuses a level larger than the capacity it is measured against", () => {
    const snapshot = ok(
      readings({
        serialNumber: [text(1, SERIAL)],
        suppliesLevel: [int("1.1", 900)],
        suppliesMaxCapacity: [int("1.1", 100)]
      })
    );
    expect(snapshot.supplies).toEqual([{ index: 1, percentRemaining: null }]);
  });
});

describe("hostile and malformed replies", () => {
  it("ignores bindings for OIDs nobody asked for", () => {
    const stray: SnmpVarbind = { oid: "1.3.6.1.4.1.9999.1.0", integer: 4, bytes: null };
    const result = buildSnapshot({
      readAt: new Date(),
      readings: new Map<TelemetryColumn, readonly SnmpVarbind[]>([
        ["serialNumber", [text(`${TELEMETRY_COLUMNS.serialNumber}.1`, SERIAL, "oid")]],
        ["engine", [stray]]
      ]),
      identity: IDENTITY
    });
    // The stray binding was in the engine column's reply but is not in the
    // column, so it decides nothing — including whether there is a snapshot.
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "NO_USABLE_VALUES" });
  });

  it("drops a value whose type contradicts the column", () => {
    const snapshot = ok(
      readings({
        serialNumber: [text(1, SERIAL)],
        engine: [text(1, "printing")],
        errorState: [int(1, 0xc0)],
        markerLifeCount: [text(1, "96")],
        // One well-formed value, so the reply is a snapshot rather than a
        // wholesale rejection and the discarded fields can be inspected.
        inputCurrentLevel: [int(1, -3)]
      })
    );
    expect(snapshot.engine).toBe("UNKNOWN");
    expect(snapshot.faults).toBeNull();
    expect(snapshot.marker).toBeNull();
    expect(snapshot.inputs).toEqual([{ index: 1, presence: "PRESENT", sheets: null }]);
  });

  it("refuses an oversized serial rather than truncating it", () => {
    const result = buildSnapshot({
      readAt: new Date(),
      readings: readings({ serialNumber: [text(1, "P".repeat(4_096))], engine: [int(1, 4)] }),
      identity: IDENTITY
    });
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "IDENTITY_UNREADABLE" });
  });

  it("refuses a serial carrying bytes a printed label cannot", () => {
    const result = buildSnapshot({
      readAt: new Date(),
      readings: readings({
        serialNumber: [{ oid: `${TELEMETRY_COLUMNS.serialNumber}.1`, integer: null, bytes: new Uint8Array([0x50, 0x00, 0x1b, 0x5b]) }],
        engine: [int(1, 4)]
      }),
      identity: IDENTITY
    });
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "IDENTITY_UNREADABLE" });
  });

  it("keeps the first answer when a device repeats a row", () => {
    const snapshot = ok(
      readings({
        serialNumber: [text(1, SERIAL)],
        markerLifeCount: [int(1, 96), int(1, 999_999)],
        markerCounterUnit: [int(1, 7)]
      })
    );
    expect(snapshot.marker?.lifeCount).toBe(96);
  });

  it("survives a truncated reply, keeping whatever was readable", () => {
    const snapshot = ok(
      readings({
        serialNumber: [text(1, SERIAL)],
        errorState: [octets(1, [0xc0, 0x00])],
        inputCurrentLevel: [{ oid: `${TELEMETRY_COLUMNS.inputCurrentLevel}.1`, integer: null, bytes: null }]
      })
    );
    expect(snapshot.faults).toEqual(["LOW_PAPER", "NO_PAPER"]);
    expect(snapshot.inputs).toBeNull();
  });

  it("reports nothing usable rather than a healthy-looking empty snapshot", () => {
    const result = buildSnapshot({
      readAt: new Date(),
      readings: readings({ serialNumber: [text(1, SERIAL)] }),
      identity: IDENTITY
    });
    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "NO_USABLE_VALUES" });
  });
});

function ok(readingsMap: ColumnReadings): PrinterTelemetrySnapshot {
  const result = buildSnapshot({ readAt: new Date(), readings: readingsMap, identity: IDENTITY });
  if (result.outcome !== "OK") throw new Error(`expected a snapshot, got ${result.reason}`);
  return result.snapshot;
}

function faultsFrom(bytes: readonly number[]): readonly string[] | null {
  return ok(readings({ serialNumber: [text(1, SERIAL)], errorState: [octets(1, bytes)] })).faults;
}

/**
 * Files bindings under the column they came from, stamping each one with that
 * column's real OID. Bindings built with an explicit OID are left alone, which
 * is how a test puts something in a reply that does not belong in it.
 */
function readings(entries: Partial<Record<TelemetryColumn, readonly SnmpVarbind[]>>): ColumnReadings {
  const map = new Map<TelemetryColumn, readonly SnmpVarbind[]>();
  for (const [name, bindings] of Object.entries(entries)) {
    if (!bindings) continue;
    const column = name as TelemetryColumn;
    map.set(
      column,
      bindings.map((binding) => ({
        ...binding,
        oid: binding.oid.replace(PLACEHOLDER, TELEMETRY_COLUMNS[column])
      }))
    );
  }
  return map;
}

const PLACEHOLDER = "PLACEHOLDER";

/**
 * Builders that place a binding at a row of *some* column. The column each one
 * belongs to is decided by the key it is filed under above, exactly as a real
 * walk does — which is what lets a test file a binding under the wrong column
 * and watch it be ignored.
 */
function int(row: number | string, value: number): SnmpVarbind {
  return { oid: `PLACEHOLDER.${String(row)}`, integer: value, bytes: null };
}

/** Pass `"oid"` to give the binding a literal OID instead of a column row. */
function text(row: number | string, value: string, literal?: "oid"): SnmpVarbind {
  return {
    oid: literal === "oid" ? String(row) : `${PLACEHOLDER}.${String(row)}`,
    integer: null,
    bytes: new TextEncoder().encode(value)
  };
}

function octets(row: number | string, bytes: readonly number[]): SnmpVarbind {
  return { oid: `PLACEHOLDER.${String(row)}`, integer: null, bytes: new Uint8Array(bytes) };
}
