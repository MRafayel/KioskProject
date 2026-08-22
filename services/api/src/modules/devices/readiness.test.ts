import { describe, expect, it } from "vitest";

import { ApiError } from "../sessions/errors.js";
import {
  PrinterReadinessGate,
  classifyPrinterReadiness,
  type ApprovedPrinterState
} from "./readiness.js";

/**
 * The gate that would have stopped the 20 August incident.
 *
 * Four sheets in the tray, five pages requested, the customer paid, four came
 * out and the kiosk reported success. Nothing in the flow ever asked whether
 * the printer could do the job — because nothing could see the paper. Now the
 * agent can, and this is where the answer is used.
 *
 * The rule it has to hold is narrow and easy to break: block **new** work on a
 * printer that cannot finish a job, and never turn a customer away for a
 * condition it can still print through.
 */

const NOW = new Date("2026-08-22T10:00:00.000Z");
const MAX_SILENCE_MS = 90_000;

function classify(
  approved: ApprovedPrinterState | null,
  options: { hasAnyPrinter?: boolean; now?: Date } = {}
) {
  return classifyPrinterReadiness({
    approved,
    hasAnyPrinter: options.hasAnyPrinter ?? approved !== null,
    now: options.now ?? NOW,
    maxSilenceMs: MAX_SILENCE_MS
  });
}

function printer(overrides: Partial<ApprovedPrinterState> = {}): ApprovedPrinterState {
  return { health: "READY", warningCode: null, lastSeenAt: NOW, ...overrides };
}

describe("a healthy printer lets a customer start", () => {
  it("passes a printer that is ready", () => {
    expect(classify(printer())).toEqual({ ready: true });
  });

  it("passes a printer that is merely warning", () => {
    // Toner running down, a tray that will need paper soon. The machine can
    // still print, so closing the kiosk for it would cost real customers real
    // prints for a condition nobody is blocked by.
    expect(classify(printer({ health: "WARNING", warningCode: "TONER_LOW" }))).toEqual({
      ready: true
    });
  });

  it("passes a printer warning specifically about paper", () => {
    // PAPER_LOW on its own is advisory even on the certified Canon, because the
    // tray levels are what decide whether it is actually out — and while it is
    // only warning, the agent reports WARNING rather than OFFLINE.
    expect(classify(printer({ health: "WARNING", warningCode: "PAPER_LOW" }))).toEqual({
      ready: true
    });
  });

  it("passes just inside the silence window", () => {
    const lastSeenAt = new Date(NOW.getTime() - MAX_SILENCE_MS);
    expect(classify(printer({ lastSeenAt }))).toEqual({ ready: true });
  });
});

describe("a printer that cannot finish a job turns a customer away", () => {
  it("blocks an offline printer", () => {
    // OFFLINE is the agent's verdict, and it already means one of: every tray
    // empty, noPaper, jam, no toner, output full, a tray or supply missing, or
    // sustained telemetry silence. The gate does not re-derive that list.
    expect(classify(printer({ health: "OFFLINE" }))).toEqual({
      ready: false,
      reason: "PRINTER_OFFLINE"
    });
  });

  it("names the one cause worth naming", () => {
    // Offline *and* a standing paper warning is the out-of-paper case, and it
    // is set from the printer's own tray level rather than inferred.
    expect(classify(printer({ health: "OFFLINE", warningCode: "PAPER_LOW" }))).toEqual({
      ready: false,
      reason: "PRINTER_OUT_OF_PAPER"
    });
  });

  it("does not guess at a cause it cannot vouch for", () => {
    expect(classify(printer({ health: "OFFLINE", warningCode: "TONER_LOW" })).ready).toBe(false);
    expect(classify(printer({ health: "OFFLINE", warningCode: "TONER_LOW" }))).toEqual({
      ready: false,
      reason: "PRINTER_OFFLINE"
    });
  });

  it("blocks a printer nobody has heard from", () => {
    const lastSeenAt = new Date(NOW.getTime() - MAX_SILENCE_MS - 1);
    // The stored verdict is usually a healthy one, which is exactly why its age
    // has to override it. A kiosk whose agent died mid-shift would otherwise go
    // on selling against a reading from before it stopped.
    expect(classify(printer({ lastSeenAt }))).toEqual({
      ready: false,
      reason: "PRINTER_SILENT"
    });
  });

  it("blocks a stale reading even when it says the printer is fine", () => {
    const lastSeenAt = new Date(NOW.getTime() - 10 * MAX_SILENCE_MS);
    expect(classify(printer({ health: "READY", lastSeenAt })).ready).toBe(false);
  });

  it("blocks when a certified printer has been withdrawn", () => {
    // Rows exist, none approved: this kiosk had a printer and no longer does.
    expect(classify(null, { hasAnyPrinter: true })).toEqual({
      ready: false,
      reason: "PRINTER_NOT_READY"
    });
  });
});

describe("a kiosk that has never had an agent is not this gate's problem", () => {
  it("passes when no device has ever reported", () => {
    // Not an oversight. No rows at all means nobody has provisioned this kiosk,
    // which an operator sees in the fleet view; it is not a printer that has
    // gone wrong. Blocking here would kill every un-provisioned environment
    // while adding nothing — the print itself already fails into recovery.
    expect(classify(null, { hasAnyPrinter: false })).toEqual({ ready: true });
  });
});

describe("recovery", () => {
  it("lets customers straight back in once the tray is refilled", () => {
    const blocked = classify(printer({ health: "OFFLINE", warningCode: "PAPER_LOW" }));
    const refilled = classify(printer({ health: "READY" }));
    // The agent drops OFFLINE on the next beat after somebody restocks, so the
    // kiosk reopens on its own. Nothing here latches.
    expect(blocked.ready).toBe(false);
    expect(refilled.ready).toBe(true);
  });

  it("lets customers back in when a jam is cleared", () => {
    expect(classify(printer({ health: "OFFLINE" })).ready).toBe(false);
    expect(classify(printer({ health: "WARNING", warningCode: "PAPER_LOW" })).ready).toBe(true);
  });

  it("lets customers back in when the agent starts reporting again", () => {
    const silent = classify(printer({ lastSeenAt: new Date(NOW.getTime() - 10 * MAX_SILENCE_MS) }));
    expect(silent.ready).toBe(false);
    expect(classify(printer({ lastSeenAt: NOW })).ready).toBe(true);
  });
});

describe("the gate as the services use it", () => {
  it("refuses with a reason the kiosk can turn into words", async () => {
    const gate = new PrinterReadinessGate({
      clock: { now: () => NOW },
      maxSilenceMs: MAX_SILENCE_MS
    });

    const error = await gate
      .assertReady(database(printer({ health: "OFFLINE", warningCode: "PAPER_LOW" })), "kiosk-1")
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      statusCode: 409,
      code: "PRINTER_UNAVAILABLE",
      details: { reason: "PRINTER_OUT_OF_PAPER" }
    });
  });

  it("says nothing and returns when the printer is fine", async () => {
    const gate = new PrinterReadinessGate({
      clock: { now: () => NOW },
      maxSilenceMs: MAX_SILENCE_MS
    });
    await expect(gate.assertReady(database(printer()), "kiosk-1")).resolves.toBeUndefined();
  });

  it("does not count printers when it already found an approved one", async () => {
    let counted = 0;
    const gate = new PrinterReadinessGate({
      clock: { now: () => NOW },
      maxSilenceMs: MAX_SILENCE_MS
    });
    await gate.assertReady(database(printer(), () => (counted += 1)), "kiosk-1");
    // The count is the rare path. Session creation runs this on every customer.
    expect(counted).toBe(0);
  });
});

function database(approved: ApprovedPrinterState | null, onCount?: () => void) {
  return {
    printer: {
      findFirst: () => Promise.resolve(approved),
      count: () => {
        onCount?.();
        return Promise.resolve(approved === null ? 0 : 1);
      }
    }
  } as unknown as Parameters<PrinterReadinessGate["assertReady"]>[0];
}
