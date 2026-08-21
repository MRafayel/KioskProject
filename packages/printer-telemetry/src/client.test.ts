import { describe, expect, it } from "vitest";

import { SnmpTimeoutError, createPrinterTelemetryClient } from "./client.js";
import { TELEMETRY_COLUMNS } from "./oids.js";
import type { PinnedIdentity, SnmpTransport, SnmpVarbind } from "./types.js";

const SERIAL = "PKQA002495";
const IDENTITY: PinnedIdentity = { serialNumber: SERIAL, macAddress: "" };

/**
 * The printer these tests stand in for drops roughly one request in eight and
 * sleeps between jobs, so silence is the normal case rather than the exceptional
 * one. What matters is not that the client copes with it, but *how*: a reading
 * that got no answer must be unavailable, never a snapshot showing a healthy
 * printer with nothing wrong.
 */

describe("silence is never a fault", () => {
  it("reports a timeout as unavailable rather than as an empty fault list", async () => {
    const client = createPrinterTelemetryClient({
      transport: transport(() => new SnmpTimeoutError()),
      identity: IDENTITY,
      clock: clock().source,
      budgetMs: 5_000,
      attemptsPerColumn: 2
    });

    const result = await client.read();

    expect(result).toEqual({ outcome: "UNAVAILABLE", reason: "TIMEOUT" });
    // There is no snapshot to misread. A caller cannot reach `faults` at all,
    // which is the point: an unanswered printer must not look like a well one.
    expect(result).not.toHaveProperty("snapshot");
  });

  it("distinguishes a broken session from a printer that is merely asleep", async () => {
    const client = createPrinterTelemetryClient({
      transport: transport(() => new Error("EHOSTUNREACH")),
      identity: IDENTITY,
      clock: clock().source,
      budgetMs: 5_000,
      attemptsPerColumn: 1
    });

    expect(await client.read()).toEqual({ outcome: "UNAVAILABLE", reason: "TRANSPORT_ERROR" });
  });

  it("never produces a snapshot from a device that answered nothing", async () => {
    for (const failure of [new SnmpTimeoutError(), new Error("refused")]) {
      const client = createPrinterTelemetryClient({
        transport: transport(() => failure),
        identity: IDENTITY,
        clock: clock().source,
        budgetMs: 5_000,
        attemptsPerColumn: 1
      });
      expect((await client.read()).outcome).toBe("UNAVAILABLE");
    }
  });
});

describe("retries", () => {
  it("re-asks a column that dropped, within the attempt limit", async () => {
    const attempts = new Map<string, number>();
    const client = createPrinterTelemetryClient({
      transport: transport((column) => {
        const seen = (attempts.get(column) ?? 0) + 1;
        attempts.set(column, seen);
        // Every column fails once, exactly as a one-in-eight drop rate does.
        return seen === 1 ? new SnmpTimeoutError() : rowsFor(column);
      }),
      identity: IDENTITY,
      clock: clock().source,
      budgetMs: 60_000,
      attemptsPerColumn: 2
    });

    const result = await client.read();

    expect(result.outcome).toBe("OK");
    if (result.outcome !== "OK") return;
    expect(result.snapshot.marker).toEqual({ lifeCount: 96, unit: "IMPRESSIONS" });
    expect(attempts.get(TELEMETRY_COLUMNS.engine)).toBe(2);
  });

  it("gives up on a column after the last attempt instead of looping", async () => {
    let calls = 0;
    const client = createPrinterTelemetryClient({
      transport: transport((column) => {
        calls += 1;
        return column === TELEMETRY_COLUMNS.engine ? new SnmpTimeoutError() : rowsFor(column);
      }),
      identity: IDENTITY,
      clock: clock().source,
      budgetMs: 60_000,
      attemptsPerColumn: 3
    });

    const result = await client.read();

    expect(result.outcome).toBe("OK");
    // Seven other columns read once each, plus three attempts at the bad one.
    expect(calls).toBe(10);
  });
});

describe("the budget", () => {
  it("stops asking once it is spent", async () => {
    const time = clock();
    let calls = 0;
    const client = createPrinterTelemetryClient({
      transport: transport((column) => {
        calls += 1;
        time.advance(1_000);
        return rowsFor(column);
      }),
      identity: IDENTITY,
      clock: time.source,
      budgetMs: 3_000,
      attemptsPerColumn: 2
    });

    await client.read();

    // Three requests fit in three seconds. The fourth is not sent, because a
    // reading that overruns its budget is a reading that can stall a sale.
    expect(calls).toBe(3);
  });

  it("still returns an attributable snapshot when cut short", async () => {
    const time = clock();
    const client = createPrinterTelemetryClient({
      transport: transport((column) => {
        time.advance(1_000);
        return rowsFor(column);
      }),
      identity: IDENTITY,
      clock: time.source,
      budgetMs: 3_000,
      attemptsPerColumn: 1
    });

    const result = await client.read();

    expect(result.outcome).toBe("OK");
    if (result.outcome !== "OK") return;
    // Identity is read first precisely so this is possible: partial telemetry
    // from the pinned printer is useful, and unattributed telemetry is not.
    expect(result.snapshot.serialNumber).toBe(SERIAL);
    expect(result.snapshot.faults).toEqual(["LOW_PAPER", "NO_PAPER"]);
    // The columns that did not fit are unknown, not absent-and-therefore-fine.
    expect(result.snapshot.marker).toBeNull();
  });

  it("reports unavailable when the budget is gone before anything was read", async () => {
    const time = clock();
    const client = createPrinterTelemetryClient({
      transport: transport((column) => {
        time.advance(5_000);
        return rowsFor(column);
      }),
      identity: IDENTITY,
      clock: time.source,
      budgetMs: 1_000,
      attemptsPerColumn: 1
    });

    // One request is always allowed, so this exercises the case where the reply
    // itself outlived the budget and nothing further was attempted.
    const result = await client.read();
    expect(result.outcome).toBe("UNAVAILABLE");
  });
});

describe("what gets asked for", () => {
  it("does not spend a round trip on a MAC nobody pinned", async () => {
    const asked: string[] = [];
    const client = createPrinterTelemetryClient({
      transport: transport((column) => {
        asked.push(column);
        return rowsFor(column);
      }),
      identity: IDENTITY,
      clock: clock().source,
      budgetMs: 60_000,
      attemptsPerColumn: 1
    });

    await client.read();

    expect(asked).not.toContain(TELEMETRY_COLUMNS.physicalAddress);
    expect(asked[0]).toBe(TELEMETRY_COLUMNS.serialNumber);
  });

  it("asks for the MAC when one is pinned, and checks it", async () => {
    const asked: string[] = [];
    const client = createPrinterTelemetryClient({
      transport: transport((column) => {
        asked.push(column);
        return rowsFor(column);
      }),
      identity: { serialNumber: SERIAL, macAddress: "00:1e:8f:aa:bb:cc" },
      clock: clock().source,
      budgetMs: 60_000,
      attemptsPerColumn: 1
    });

    const result = await client.read();

    expect(asked).toContain(TELEMETRY_COLUMNS.physicalAddress);
    expect(result.outcome).toBe("OK");
  });

  it("asks only for the columns it was compiled with", async () => {
    const asked: string[] = [];
    const client = createPrinterTelemetryClient({
      transport: transport((column) => {
        asked.push(column);
        return rowsFor(column);
      }),
      identity: IDENTITY,
      clock: clock().source,
      budgetMs: 60_000,
      attemptsPerColumn: 1
    });

    await client.read();

    // No discovery, and nothing in a reply can widen this set.
    expect(new Set(asked).size).toBe(asked.length);
    for (const oid of asked) {
      expect(Object.values(TELEMETRY_COLUMNS)).toContain(oid);
    }
  });
});

it("closes the session it was given", () => {
  let closed = false;
  const client = createPrinterTelemetryClient({
    transport: {
      walkColumn: () => Promise.resolve([]),
      close: () => {
        closed = true;
      }
    },
    identity: IDENTITY,
    clock: clock().source,
    budgetMs: 1_000,
    attemptsPerColumn: 1
  });

  client.close();

  expect(closed).toBe(true);
});

function clock() {
  let current = Date.parse("2026-08-21T09:00:00.000Z");
  return {
    source: { now: () => new Date(current) },
    advance(ms: number) {
      current += ms;
    }
  };
}

function transport(
  respond: (columnOid: string) => readonly SnmpVarbind[] | Error
): SnmpTransport {
  return {
    walkColumn(columnOid: string): Promise<readonly SnmpVarbind[]> {
      const answer = respond(columnOid);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    close: () => undefined
  };
}

/** What the certified Canon returns, keyed by the column being asked for. */
function rowsFor(columnOid: string): readonly SnmpVarbind[] {
  switch (columnOid) {
    case TELEMETRY_COLUMNS.serialNumber:
      return [bytes(columnOid, 1, [...new TextEncoder().encode(SERIAL)])];
    case TELEMETRY_COLUMNS.physicalAddress:
      return [bytes(columnOid, 1, [0x00, 0x1e, 0x8f, 0xaa, 0xbb, 0xcc])];
    case TELEMETRY_COLUMNS.errorState:
      return [bytes(columnOid, 1, [0xc0, 0x00])];
    case TELEMETRY_COLUMNS.engine:
      return [number(columnOid, 1, 4)];
    case TELEMETRY_COLUMNS.markerLifeCount:
      return [number(columnOid, 1, 96)];
    case TELEMETRY_COLUMNS.markerCounterUnit:
      return [number(columnOid, 1, 7)];
    case TELEMETRY_COLUMNS.inputCurrentLevel:
      return [number(columnOid, "1.1", 0), number(columnOid, "1.2", -3)];
    case TELEMETRY_COLUMNS.suppliesLevel:
      return [number(columnOid, "1.1", 40)];
    case TELEMETRY_COLUMNS.suppliesMaxCapacity:
      return [number(columnOid, "1.1", 80)];
    default:
      return [];
  }
}

function number(columnOid: string, row: number | string, value: number): SnmpVarbind {
  return { oid: `${columnOid}.${String(row)}`, integer: value, bytes: null };
}

function bytes(columnOid: string, row: number, value: readonly number[]): SnmpVarbind {
  return { oid: `${columnOid}.${String(row)}`, integer: null, bytes: new Uint8Array(value) };
}
