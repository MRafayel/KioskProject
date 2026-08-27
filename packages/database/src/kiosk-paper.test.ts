import { describe, expect, it, vi } from "vitest";

import { readKioskPaperEstimate, type KioskPaperEstimateReader } from "./kiosk-paper.js";

/**
 * The three things the ledger's sum has to get right, and one of them is not a
 * number at all: a kiosk nobody has started tracking has no estimate, which is
 * a different answer from an empty tray and has to stay distinguishable all the
 * way out to the screen a customer reads.
 */

function reader(input: {
  initialized: boolean;
  sum: number | null;
}): KioskPaperEstimateReader & { findFirst: ReturnType<typeof vi.fn> } {
  const findFirst = vi.fn().mockResolvedValue(input.initialized ? { id: "event" } : null);
  const aggregate = vi.fn().mockResolvedValue({ _sum: { deltaSheets: input.sum } });
  return { kioskPaperEvent: { findFirst, aggregate }, findFirst };
}

describe("reading a kiosk's paper estimate", () => {
  it("sums the signed deltas of the ledger", async () => {
    await expect(
      readKioskPaperEstimate(reader({ initialized: true, sum: 118 }), "kiosk_dev_001")
    ).resolves.toBe(118);
  });

  it("answers nothing at all until somebody records a refill or a correction", async () => {
    // Not zero. A kiosk nobody tracks may have a full tray, and reporting it as
    // empty would refuse every customer at a working machine.
    await expect(
      readKioskPaperEstimate(reader({ initialized: false, sum: null }), "kiosk_dev_001")
    ).resolves.toBeNull();
  });

  it("floors a ledger that has drifted below the tray at zero", async () => {
    // Deductions can outrun refills when somebody forgets to record one. A tray
    // cannot hold a negative number of sheets, and a debt would silently absorb
    // the next refill.
    await expect(
      readKioskPaperEstimate(reader({ initialized: true, sum: -40 }), "kiosk_dev_001")
    ).resolves.toBe(0);
  });

  it("treats a tracked kiosk with no deltas as zero rather than unknown", async () => {
    await expect(
      readKioskPaperEstimate(reader({ initialized: true, sum: null }), "kiosk_dev_001")
    ).resolves.toBe(0);
  });

  it("decides tracking from human events only", async () => {
    // A print deduction alone cannot start tracking: it is written beside a
    // completion whether or not anybody has ever recorded loading paper.
    const client = reader({ initialized: true, sum: 10 });
    await readKioskPaperEstimate(client, "kiosk_dev_001");

    expect(client.findFirst).toHaveBeenCalledWith({
      where: { kioskId: "kiosk_dev_001", type: { in: ["REFILL", "CORRECTION"] } },
      select: { id: true }
    });
  });
});
