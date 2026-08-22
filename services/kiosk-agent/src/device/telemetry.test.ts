import { describe, expect, it, vi } from "vitest";

import type { NonAdminEnvironment } from "@printing-kiosk/config";
import type {
  PrinterFault,
  PrinterInput,
  PrinterTelemetryClient,
  PrinterTelemetrySnapshot
} from "@printing-kiosk/printer-telemetry";

import {
  applyPrinterTelemetry,
  createPrinterTelemetrySource,
  describeVerdict,
  healthSignature,
  type PrinterWarningCode,
  type TelemetryVerdict
} from "./telemetry.js";

/**
 * The rules this fold has to hold, in the order they matter:
 *
 *   1. telemetry may make a reading worse, never better;
 *   2. not knowing is never a fault;
 *   3. a transient timeout is not an outage;
 *   4. a standing condition warns the next customer, it does not fail anyone;
 *   5. engine state decides nothing.
 *
 * Every case below is one of those, against values the certified Canon really
 * produced.
 */

const READY = { health: "READY", warningCode: null } as const;

describe("telemetry may only make a reading worse", () => {
  it("leaves a healthy reading alone when the printer reports nothing wrong", () => {
    expect(applyPrinterTelemetry(READY, snapshot({ faults: [] }), { required: true })).toEqual({
      health: "READY",
      warningCode: null,
      reason: null
    });
  });

  it("cannot lift a printer the driver called offline", () => {
    const result = applyPrinterTelemetry(
      { health: "OFFLINE", warningCode: null },
      snapshot({ faults: [] }),
      { required: true }
    );
    // A telemetry link that is answering says nothing about a USB queue that is
    // not. There is no path here that reports READY.
    expect(result.health).toBe("OFFLINE");
  });

  it("puts the printer's own reading in front of the driver's guess", () => {
    // The driver's warning comes from a status string; on the certified Canon
    // that string reads `Normal` with an empty tray. This comes from the
    // printer's own supply and tray columns. When the two disagree about a
    // physical condition, the one that can actually see the paper wins — the
    // old order let an authoritative PAPER_LOW hide behind a stale TONER_LOW.
    const result = applyPrinterTelemetry(
      { health: "WARNING", warningCode: "TONER_LOW" },
      snapshot({ faults: ["LOW_PAPER"] }),
      { required: true }
    );
    expect(result.warningCode).toBe("PAPER_LOW");
    expect(result.health).toBe("WARNING");
  });

  it("still shows the driver's warning when telemetry has nothing to say", () => {
    // Authority, not erasure. A deployment with no telemetry link keeps exactly
    // the behaviour it had.
    const result = applyPrinterTelemetry(
      { health: "WARNING", warningCode: "TONER_LOW" },
      snapshot({ faults: [] }),
      { required: true }
    );
    expect(result.warningCode).toBe("TONER_LOW");
  });

  it("cannot lift health even while replacing the warning", () => {
    const result = applyPrinterTelemetry(
      { health: "OFFLINE", warningCode: "TONER_LOW" },
      snapshot({ faults: ["LOW_PAPER"] }),
      { required: true }
    );
    expect(result.health).toBe("OFFLINE");
  });
});

describe("standing conditions warn, they do not stop", () => {
  it("raises PAPER_LOW without withdrawing the printer", () => {
    const result = applyPrinterTelemetry(READY, snapshot({ faults: ["LOW_PAPER"] }), {
      required: true
    });
    // This is the case the certified Canon sits in for most of its life: the
    // tray empties on a job that printed perfectly and LOW_PAPER stays asserted
    // until somebody refills it. Selling must continue.
    expect(result).toEqual({
      health: "WARNING",
      warningCode: "PAPER_LOW",
      reason: "printer warning (LOW_PAPER)"
    });
  });

  it("keeps selling while a job that succeeded left the tray empty", () => {
    // 20:30:10 on 21 Aug: LOW_PAPER asserted mid-job, the page came out, the
    // counter advanced. Nothing about that is a reason to refuse the next
    // customer outright.
    const result = applyPrinterTelemetry(READY, snapshot({ faults: ["LOW_PAPER"], marker: 113 }), {
      required: true
    });
    expect(result.health).toBe("WARNING");
  });

  it.each<[PrinterFault, PrinterWarningCode]>([
    ["LOW_PAPER", "PAPER_LOW"],
    ["INPUT_TRAY_EMPTY", "PAPER_LOW"],
    ["LOW_TONER", "TONER_LOW"],
    ["OUTPUT_NEAR_FULL", "OUTPUT_TRAY_FULL"]
  ])("maps %s to %s", (fault, code) => {
    expect(applyPrinterTelemetry(READY, snapshot({ faults: [fault] }), { required: true })).toMatchObject(
      { health: "WARNING", warningCode: code }
    );
  });
});

describe("blocking faults withdraw the printer", () => {
  it.each<PrinterFault>([
    "NO_PAPER",
    "JAMMED",
    "DOOR_OPEN",
    "NO_TONER",
    "SERVICE_REQUESTED",
    "INPUT_TRAY_MISSING",
    "MARKER_SUPPLY_MISSING",
    "OUTPUT_FULL"
  ])("reports OFFLINE while %s is asserted", (fault) => {
    const result = applyPrinterTelemetry(READY, snapshot({ faults: [fault] }), { required: true });
    expect(result.health).toBe("OFFLINE");
    expect(result.reason).toContain(fault);
  });

  it("recovers the moment the blocking fault clears", () => {
    // The printer asserted NO_PAPER for the 21 seconds a job was blocked and
    // dropped it the instant the job was cancelled. The withdrawal has to be
    // just as temporary, or one blocked job would take the kiosk out for good.
    const blocked = applyPrinterTelemetry(READY, snapshot({ faults: ["LOW_PAPER", "NO_PAPER"] }), {
      required: true
    });
    const cleared = applyPrinterTelemetry(READY, snapshot({ faults: ["LOW_PAPER"] }), {
      required: true
    });
    expect(blocked.health).toBe("OFFLINE");
    expect(cleared.health).toBe("WARNING");
  });

  it("still tells an operator about the standing condition underneath", () => {
    const result = applyPrinterTelemetry(READY, snapshot({ faults: ["LOW_PAPER", "NO_PAPER"] }), {
      required: true
    });
    expect(result.warningCode).toBe("PAPER_LOW");
  });
});

describe("not knowing is never a fault", () => {
  it("changes nothing on a single dropped reading", () => {
    // One in eight requests goes unanswered on this printer. Reacting to one
    // would mean a kiosk whose reported state flapped with the UDP weather.
    const result = applyPrinterTelemetry(READY, unavailable("TIMEOUT", 1), { required: true });
    expect(result).toEqual({ health: "READY", warningCode: null, reason: null });
  });

  it("changes nothing on two", () => {
    expect(applyPrinterTelemetry(READY, unavailable("TIMEOUT", 2), { required: true }).health).toBe(
      "READY"
    );
  });

  it("stops claiming the printer is well after sustained silence", () => {
    const result = applyPrinterTelemetry(READY, unavailable("TIMEOUT", 3), { required: true });
    expect(result.health).toBe("OFFLINE");
    expect(result.reason).toBe("telemetry unavailable (TIMEOUT)");
  });

  it("never turns silence into a warning code", () => {
    for (const failures of [1, 3, 50]) {
      const result = applyPrinterTelemetry(READY, unavailable("TIMEOUT", failures), {
        required: true
      });
      // OFFLINE says "we are not selling on this". PAPER_LOW would be a claim
      // about the paper, which nobody made.
      expect(result.warningCode).toBeNull();
    }
  });

  it("leaves the reading alone entirely when telemetry is advisory", () => {
    const result = applyPrinterTelemetry(READY, unavailable("TRANSPORT_ERROR", 99), {
      required: false
    });
    expect(result).toEqual({ health: "READY", warningCode: null, reason: null });
  });

  it("treats a snapshot with no fault bitmask as silence, not an all-clear", () => {
    const result = applyPrinterTelemetry(READY, snapshot({ faults: null }), { required: true });
    // It identified itself and said nothing about faults. That is not the same
    // as saying there are none, so no warning is raised either way.
    expect(result.warningCode).toBeNull();
    expect(result.reason).toBeNull();
  });

  it("does nothing at all when no telemetry is configured", () => {
    expect(
      applyPrinterTelemetry({ health: "WARNING", warningCode: "TONER_LOW" }, { kind: "DISABLED" }, {
        required: true
      })
    ).toEqual({ health: "WARNING", warningCode: "TONER_LOW", reason: null });
  });

  it("treats a stale reading like any other silence", () => {
    const result = applyPrinterTelemetry(READY, unavailable("STALE", 3), { required: true });
    expect(result.health).toBe("OFFLINE");
    expect(result.warningCode).toBeNull();
  });
});

describe("engine state decides nothing", () => {
  it.each<PrinterTelemetrySnapshot["engine"]>(["IDLE", "OTHER", "PRINTING", "WARMUP", "UNKNOWN"])(
    "reports the same health whatever the engine says (%s)",
    (engine) => {
      const result = applyPrinterTelemetry(READY, snapshot({ faults: [], engine }), {
        required: true
      });
      // `other(1)` held for 50 seconds after a successful print with no fault
      // at all, and faults have been observed while the engine read `idle(3)`.
      // It is neither necessary nor sufficient, so it is not consulted.
      expect(result).toEqual({ health: "READY", warningCode: null, reason: null });
    }
  );

  it("does not withdraw a printer that is merely asleep", () => {
    const result = applyPrinterTelemetry(READY, snapshot({ faults: [], engine: "OTHER" }), {
      required: true
    });
    expect(result.health).toBe("READY");
  });

  it("withdraws on the fault bit even when the engine looks idle", () => {
    const result = applyPrinterTelemetry(READY, snapshot({ faults: ["NO_PAPER"], engine: "IDLE" }), {
      required: true
    });
    expect(result.health).toBe("OFFLINE");
  });
});

describe("the log line", () => {
  it("summarises a reading without naming the device or the customer", () => {
    const line = describeVerdict(snapshot({ faults: ["LOW_PAPER"], marker: 113, engine: "IDLE" }));
    expect(line).toBe("IDLE faults=LOW_PAPER marker=113");
    expect(line).not.toContain("PKQA002495");
  });

  it("distinguishes an all-clear from an unreported bitmask", () => {
    expect(describeVerdict(snapshot({ faults: [] }))).toContain("faults=none");
    expect(describeVerdict(snapshot({ faults: null }))).toContain("faults=unreported");
  });

  it("counts the failures behind an unavailable reading", () => {
    expect(describeVerdict(unavailable("TIMEOUT", 2))).toBe("unavailable:TIMEOUT:2");
  });
});

/** The certified Canon: an empty multi-purpose slot beside a loaded cassette. */
const LOADED: PrinterInput[] = [
  { index: 1, presence: "EMPTY", sheets: 0 },
  { index: 2, presence: "PRESENT", sheets: null }
];

/** The same machine with the cassette run out. */
const OUT_OF_PAPER: PrinterInput[] = [
  { index: 1, presence: "EMPTY", sheets: 0 },
  { index: 2, presence: "EMPTY", sheets: 0 }
];

function snapshot(input: {
  faults: PrinterFault[] | null;
  marker?: number;
  engine?: PrinterTelemetrySnapshot["engine"];
  inputs?: PrinterInput[] | null;
}): TelemetryVerdict {
  return {
    kind: "SNAPSHOT",
    snapshot: {
      readAt: new Date("2026-08-21T20:30:11.000Z"),
      serialNumber: "PKQA002495",
      engine: input.engine ?? "IDLE",
      faults: input.faults,
      marker: input.marker === undefined ? null : { lifeCount: input.marker, unit: "IMPRESSIONS" },
      inputs: input.inputs === undefined ? null : input.inputs,
      supplies: null
    }
  };
}

function unavailable(
  reason: Extract<TelemetryVerdict, { kind: "UNAVAILABLE" }>["reason"],
  consecutiveFailures: number
): TelemetryVerdict {
  return { kind: "UNAVAILABLE", reason, consecutiveFailures };
}

/**
 * On the certified Canon there is no level sensor: paper is present or it is
 * not, and `lowPaper` asserts on empty rather than on low. That makes the bit
 * unsafe to read literally — a printer that can count sheets sets the same bit
 * with paper still in it — so presence is decided by the tray levels, which
 * mean the same thing on both kinds of device.
 */
describe("paper presence comes from the trays, not the bit", () => {
  it("keeps selling with an empty manual slot beside a loaded cassette", () => {
    // 0/-3 — the state this printer is in for every job it has ever printed.
    const result = applyPrinterTelemetry(READY, snapshot({ faults: [], inputs: LOADED }), {
      required: true
    });
    expect(result.health).toBe("READY");
  });

  it("stops selling once every tray is empty", () => {
    const result = applyPrinterTelemetry(READY, snapshot({ faults: [], inputs: OUT_OF_PAPER }), {
      required: true
    });
    expect(result).toEqual({
      health: "OFFLINE",
      warningCode: "PAPER_LOW",
      reason: "printer blocked (no paper in any tray)"
    });
  });

  it("stops selling on an empty tray even before any fault bit is set", () => {
    // The levels moved two seconds before the error state did on 20 Aug, so the
    // trays are the earlier signal as well as the more portable one.
    const result = applyPrinterTelemetry(READY, snapshot({ faults: [], inputs: OUT_OF_PAPER }), {
      required: true
    });
    expect(result.health).toBe("OFFLINE");
  });

  it("does not refuse a printer that can still count its sheets", () => {
    // A different device reporting genuine "running low" with paper left. The
    // bit says LOW_PAPER, the tray says 40 sheets; it sells, with a warning.
    const result = applyPrinterTelemetry(
      READY,
      snapshot({ faults: ["LOW_PAPER"], inputs: [{ index: 1, presence: "PRESENT", sheets: 40 }] }),
      { required: true }
    );
    expect(result).toMatchObject({ health: "WARNING", warningCode: "PAPER_LOW" });
  });

  it("does not conclude empty from a tray that would not answer", () => {
    const result = applyPrinterTelemetry(
      READY,
      snapshot({
        faults: [],
        inputs: [
          { index: 1, presence: "EMPTY", sheets: 0 },
          { index: 2, presence: "UNKNOWN", sheets: null }
        ]
      }),
      { required: true }
    );
    // One tray silent is not evidence the machine is out of paper.
    expect(result.health).toBe("READY");
  });

  it("does not conclude empty when the device reported no trays at all", () => {
    const result = applyPrinterTelemetry(READY, snapshot({ faults: [], inputs: null }), {
      required: true
    });
    expect(result.health).toBe("READY");
  });

  it("recovers as soon as somebody refills the cassette", () => {
    const empty = applyPrinterTelemetry(READY, snapshot({ faults: ["LOW_PAPER"], inputs: OUT_OF_PAPER }), {
      required: true
    });
    const refilled = applyPrinterTelemetry(READY, snapshot({ faults: [], inputs: LOADED }), {
      required: true
    });
    expect(empty.health).toBe("OFFLINE");
    expect(refilled.health).toBe("READY");
  });

  it("still never reaches back into a job that already printed", () => {
    // 20:30:11 on 21 Aug: the last sheet was pulled in, the tray read empty,
    // the counter advanced and the page came out. The kiosk stops selling; the
    // job that just succeeded is not touched, because health is only ever a
    // statement about the next customer.
    const result = applyPrinterTelemetry(
      READY,
      snapshot({ faults: ["LOW_PAPER"], inputs: OUT_OF_PAPER, marker: 113 }),
      { required: true }
    );
    expect(result.health).toBe("OFFLINE");
    expect(result.reason).not.toContain("113");
  });
});

/**
 * Whether telemetry is running at all, as something a kiosk can be asked.
 *
 * This is the gap that produced the 22 August no-paper session. The agent was
 * built, wired and correct, and `PRINTER_TELEMETRY_ENABLED` was simply never set
 * on the machine — so the fold was a no-op, the driver's `Normal` stood, and the
 * kiosk sold a print against an empty tray. Nothing in any log distinguished
 * that kiosk from one whose telemetry was working perfectly.
 */
describe("a kiosk can tell whether telemetry is actually on", () => {
  it("says out loud that health is driver-only when telemetry is off", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const source = createPrinterTelemetrySource({
      environment: environmentWith({ PRINTER_TELEMETRY_ENABLED: false }),
      logger
    });

    source.start();

    expect(source.current()).toEqual({ kind: "DISABLED" });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[1]).toContain("driver-reported only");
  });

  it("says where it is polling, and never what it polls with", () => {
    const logger = { info: vi.fn<LogLine>(), warn: vi.fn<LogLine>() };
    const source = createPrinterTelemetrySource({
      environment: environmentWith({
        PRINTER_TELEMETRY_ENABLED: true,
        PRINTER_TELEMETRY_HOST: "192.168.253.2",
        PRINTER_TELEMETRY_SNMP_AUTH_KEY: "auth-passphrase",
        PRINTER_TELEMETRY_SNMP_PRIV_KEY: "priv-passphrase",
        PRINTER_TELEMETRY_SERIAL: "ABC12345"
      }),
      logger,
      client: silentClient()
    });

    source.start();
    source.close();

    expect(logger.warn).not.toHaveBeenCalled();
    const [fields, message] = logger.info.mock.calls[0] ?? [];
    expect(message).toBe("printer telemetry polling");
    expect(fields).toMatchObject({ telemetry: "enabled", host: "192.168.253.2", required: true });
    // The kiosk is a public machine; its logs are not a place to keep the keys
    // to the device it prints with.
    const written = JSON.stringify(fields);
    expect(written).not.toContain("auth-passphrase");
    expect(written).not.toContain("priv-passphrase");
    expect(written).not.toContain("ABC12345");
  });
});

type LogLine = (fields: Record<string, unknown>, message: string) => void;

/** Only the keys this source reads; the rest of the environment is not its business. */
function environmentWith(overrides: Partial<NonAdminEnvironment>): NonAdminEnvironment {
  return {
    PRINTER_TELEMETRY_ENABLED: false,
    PRINTER_TELEMETRY_HOST: "",
    PRINTER_TELEMETRY_PORT: 161,
    PRINTER_TELEMETRY_POLL_SECONDS: 30,
    PRINTER_TELEMETRY_REQUIRED: true,
    PRINTER_TELEMETRY_SERIAL: "",
    PRINTER_TELEMETRY_MAC: "",
    PRINTER_TELEMETRY_SNMP_USER: "",
    PRINTER_TELEMETRY_SNMP_AUTH_KEY: "",
    PRINTER_TELEMETRY_SNMP_PRIV_KEY: "",
    ...overrides
  } as NonAdminEnvironment;
}

function silentClient(): PrinterTelemetryClient {
  return {
    read: () => Promise.resolve({ outcome: "UNAVAILABLE", reason: "TIMEOUT" } as const),
    close: () => undefined
  };
}

/**
 * Telling the control plane *now* rather than at the next scheduled beat.
 *
 * The 22 August payment race was a minute wide because the agent learned on one
 * schedule and reported on another. Closing it means waking the reporter when a
 * reading changes — but only when it changes something the fold actually
 * decides on, or a fifty-page job would send a beat per page.
 */
describe("what counts as a change worth reporting", () => {
  it("ignores the counter climbing through a job", () => {
    const before = healthSignature(snapshot({ faults: [], marker: 100 }));
    const after = healthSignature(snapshot({ faults: [], marker: 150 }));
    expect(after).toBe(before);
  });

  it("ignores the engine waking and sleeping", () => {
    const idle = healthSignature(snapshot({ faults: [], engine: "IDLE" }));
    const other = healthSignature(snapshot({ faults: [], engine: "OTHER" }));
    const printing = healthSignature(snapshot({ faults: [], engine: "PRINTING" }));
    expect(new Set([idle, other, printing]).size).toBe(1);
  });

  it("notices a tray running out", () => {
    const loaded = healthSignature(snapshot({ faults: [], inputs: LOADED }));
    const empty = healthSignature(snapshot({ faults: [], inputs: OUT_OF_PAPER }));
    expect(empty).not.toBe(loaded);
  });

  it("notices a fault appearing and clearing", () => {
    const well = healthSignature(snapshot({ faults: [] }));
    const jammed = healthSignature(snapshot({ faults: ["JAMMED"] }));
    expect(jammed).not.toBe(well);
    expect(healthSignature(snapshot({ faults: [] }))).toBe(well);
  });

  it("does not care what order the printer lists its faults in", () => {
    const one = healthSignature(snapshot({ faults: ["LOW_PAPER", "LOW_TONER"] }));
    const other = healthSignature(snapshot({ faults: ["LOW_TONER", "LOW_PAPER"] }));
    expect(other).toBe(one);
  });

  it("stays quiet through the timeouts that change nothing", () => {
    // One and two dropped readings leave the fold alone, so they are not worth
    // a beat. The third withdraws the printer, and that is.
    const first = healthSignature(unavailable("TIMEOUT", 1));
    expect(healthSignature(unavailable("TIMEOUT", 2))).toBe(first);
    expect(healthSignature(unavailable("TIMEOUT", 3))).not.toBe(first);
  });

  it("separates a reading from the absence of one", () => {
    expect(healthSignature({ kind: "DISABLED" })).not.toBe(healthSignature(unavailable("TIMEOUT", 1)));
  });
});

/**
 * The readings taken while a job is marking are the freshest view of the printer
 * anybody has, and the job that empties the tray is exactly the one being
 * watched. Letting them sit unread meant the next customer could start on a
 * machine that ran out half a minute earlier.
 */
describe("readings taken during a print reach the same cache", () => {
  it("wakes the reporter the moment the last sheet leaves the tray", async () => {
    const beats: string[] = [];
    const source = createPrinterTelemetrySource({
      environment: environmentWith({ PRINTER_TELEMETRY_ENABLED: true }),
      logger: { info: vi.fn(), warn: vi.fn() },
      client: scriptedClient([loadedSnapshot(), emptySnapshot()])
    });
    source.onChange(() => beats.push("beat"));

    // The first reading is itself a change — from having heard nothing to
    // having heard something — so prime past it before counting.
    await source.readNow();
    const primed = beats.length;

    await source.readNow();

    // One further beat, on the reading where the tray actually emptied.
    expect(beats).toHaveLength(primed + 1);
    expect(source.current()).toMatchObject({ kind: "SNAPSHOT" });
  });

  it("leaves the cached verdict describing the printer, not the job", async () => {
    const source = createPrinterTelemetrySource({
      environment: environmentWith({ PRINTER_TELEMETRY_ENABLED: true }),
      logger: { info: vi.fn(), warn: vi.fn() },
      client: scriptedClient([emptySnapshot()])
    });

    await source.readNow();
    const verdict = source.current();

    // The fold decides, not this call: an empty tray is OFFLINE for whoever
    // comes next, which is the same answer the poller would have reached.
    expect(applyPrinterTelemetry(READY, verdict, { required: true })).toMatchObject({
      health: "OFFLINE",
      warningCode: "PAPER_LOW"
    });
  });

  it("does not let a dropped reading during a print count as silence", async () => {
    // At this loop's cadence three unlucky packets would otherwise withdraw the
    // printer inside ten seconds, on a threshold tuned for the poller's minute.
    const source = createPrinterTelemetrySource({
      environment: environmentWith({ PRINTER_TELEMETRY_ENABLED: true }),
      logger: { info: vi.fn(), warn: vi.fn() },
      client: {
        read: () => Promise.resolve({ outcome: "UNAVAILABLE", reason: "TIMEOUT" } as const),
        close: () => undefined
      }
    });

    for (let attempt = 0; attempt < 5; attempt += 1) await source.readNow();

    expect(source.current()).toEqual({
      kind: "UNAVAILABLE",
      reason: "TIMEOUT",
      consecutiveFailures: 0
    });
  });

  it("refreshes how recently the printer was heard from", async () => {
    const source = createPrinterTelemetrySource({
      environment: environmentWith({ PRINTER_TELEMETRY_ENABLED: true }),
      logger: { info: vi.fn(), warn: vi.fn() },
      client: scriptedClient([loadedSnapshot()])
    });

    expect(source.observedAt()).toBeNull();
    await source.readNow();
    // Payment reads this age. A print is the one moment the printer is being
    // asked constantly, so it should count as having been heard from.
    expect(source.observedAt()).toEqual(loadedSnapshot().readAt);
  });
});

function scriptedClient(snapshots: PrinterTelemetrySnapshot[]): PrinterTelemetryClient {
  let index = 0;
  return {
    read: () => {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return Promise.resolve(
        snapshot
          ? ({ outcome: "OK", snapshot } as const)
          : ({ outcome: "UNAVAILABLE", reason: "TIMEOUT" } as const)
      );
    },
    close: () => undefined
  };
}

function baseSnapshot(): PrinterTelemetrySnapshot {
  return {
    readAt: new Date("2026-08-22T12:00:00.000Z"),
    serialNumber: "SERIAL",
    engine: "PRINTING",
    faults: [],
    marker: { lifeCount: 100, unit: "IMPRESSIONS" },
    inputs: null,
    supplies: null
  };
}

function loadedSnapshot(): PrinterTelemetrySnapshot {
  return { ...baseSnapshot(), inputs: LOADED };
}

function emptySnapshot(): PrinterTelemetrySnapshot {
  return { ...baseSnapshot(), faults: ["LOW_PAPER"], inputs: OUT_OF_PAPER };
}
