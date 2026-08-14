import { describe, expect, it } from "vitest";

import { isApprovedQueueName, parseQueueAllowlist, selectApprovedQueue } from "./queues.js";
import type { PrinterQueueDescriptor } from "./types.js";

function queue(overrides: Partial<PrinterQueueDescriptor> = {}): PrinterQueueDescriptor {
  return {
    queueName: "Kiosk A4",
    deviceUri: "ipp://printer.local/ipp/print",
    driverName: "Generic PCL6",
    portName: "IP_10.0.0.9",
    state: "READY",
    isDefault: true,
    shared: false,
    ...overrides
  };
}

describe("selectApprovedQueue", () => {
  it("selects the single approved queue on the machine", () => {
    const selection = selectApprovedQueue(
      [queue(), queue({ queueName: "Microsoft Print to PDF" })],
      {
        allowlist: ["Kiosk A4"]
      }
    );

    expect(selection).toEqual({ approved: true, queue: queue() });
  });

  it("compares names the way the operating system does", () => {
    const selection = selectApprovedQueue([queue({ queueName: " KIOSK a4 " })], {
      allowlist: ["kiosk A4"]
    });

    expect(selection.approved).toBe(true);
  });

  /**
   * The default has to be refusal. An allowlist that has not been configured
   * yet is a kiosk nobody has certified a printer for, and the alternative
   * reading — approve everything — prints a paid job to whatever queue a driver
   * installer happened to leave behind.
   */
  it("approves nothing when the allowlist is empty", () => {
    expect(selectApprovedQueue([queue()], { allowlist: [] })).toEqual({
      approved: false,
      reason: "NOT_APPROVED"
    });
    expect(selectApprovedQueue([queue()], { allowlist: ["  ", ""] })).toEqual({
      approved: false,
      reason: "NOT_APPROVED"
    });
  });

  it("refuses a queue published to other machines unless told otherwise", () => {
    const queues = [queue({ shared: true })];

    expect(selectApprovedQueue(queues, { allowlist: ["Kiosk A4"] })).toEqual({
      approved: false,
      reason: "SHARED"
    });
    expect(
      selectApprovedQueue(queues, { allowlist: ["Kiosk A4"], allowShared: true }).approved
    ).toBe(true);
  });

  /**
   * Two certified printers and no stated preference is a configuration that has
   * not decided. Picking one would put a customer's job in another room half
   * the time, and nothing about which one was chosen would be visible.
   */
  it("refuses to guess between two approved queues", () => {
    const queues = [queue(), queue({ queueName: "Kiosk A4 Spare", isDefault: false })];

    expect(selectApprovedQueue(queues, { allowlist: ["Kiosk A4", "Kiosk A4 Spare"] })).toEqual({
      approved: false,
      reason: "AMBIGUOUS"
    });
    expect(
      selectApprovedQueue(queues, {
        allowlist: ["Kiosk A4", "Kiosk A4 Spare"],
        preferred: "Kiosk A4 Spare"
      })
    ).toEqual({ approved: true, queue: queues[1] });
  });

  it("refuses a preference that names a queue this machine does not offer", () => {
    expect(
      selectApprovedQueue([queue()], { allowlist: ["Kiosk A4"], preferred: "Kiosk A4 Spare" })
    ).toEqual({ approved: false, reason: "NOT_APPROVED" });
  });

  /**
   * A paused or offline printer is still the approved printer. Selecting it is
   * what lets the kiosk report that the certified device is offline rather than
   * quietly failing over to one nobody certified.
   */
  it("selects an approved queue that is not ready", () => {
    const paused = queue({ state: "PAUSED" });

    expect(selectApprovedQueue([paused], { allowlist: ["Kiosk A4"] })).toEqual({
      approved: true,
      queue: paused
    });
  });

  it("reports a machine with no queues distinctly from one with no approved queue", () => {
    expect(selectApprovedQueue([], { allowlist: ["Kiosk A4"] })).toEqual({
      approved: false,
      reason: "NO_QUEUES"
    });
    expect(
      selectApprovedQueue([queue({ queueName: "OneNote" })], { allowlist: ["Kiosk A4"] })
    ).toEqual({ approved: false, reason: "NOT_APPROVED" });
  });
});

describe("isApprovedQueueName", () => {
  it("holds an already bound adapter to the same allowlist", () => {
    expect(isApprovedQueueName("Kiosk A4", ["kiosk a4"])).toBe(true);
    expect(isApprovedQueueName("Kiosk A4", [])).toBe(false);
    expect(isApprovedQueueName("   ", ["   "])).toBe(false);
  });
});

describe("parseQueueAllowlist", () => {
  it("reads a comma separated list and drops blanks", () => {
    expect(parseQueueAllowlist(" Kiosk A4 , ,Kiosk A4 Spare ")).toEqual([
      "Kiosk A4",
      "Kiosk A4 Spare"
    ]);
    expect(parseQueueAllowlist(undefined)).toEqual([]);
    expect(parseQueueAllowlist("")).toEqual([]);
  });
});
