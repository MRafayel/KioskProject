import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "./generated/prisma/client.js";
import {
  applyKioskPaperDeduction,
  readKioskPaperEstimate,
  type KioskPaperEstimateReader
} from "./kiosk-paper.js";

/**
 * The estimate is one number on one row now, so most of what the ledger's sum
 * had to get right is gone with it. What survives is the part that was never
 * arithmetic: a kiosk nobody has started tracking has no estimate, which is a
 * different answer from an empty tray and has to stay distinguishable all the
 * way out to the screen a customer reads.
 */

const kioskId = "kiosk_dev_001";
const now = new Date("2030-01-01T00:00:00.000Z");

function reader(
  estimatedSheets: number | null
): KioskPaperEstimateReader & { findUnique: ReturnType<typeof vi.fn> } {
  const findUnique = vi
    .fn()
    .mockResolvedValue(estimatedSheets === null ? null : { estimatedSheets });
  return { kioskPaperInventory: { findUnique }, findUnique };
}

/**
 * A transaction whose inventory row is whatever the test says it is. The lock
 * and the read are one raw statement, so that is what gets stubbed.
 */
function transactionHolding(estimatedSheets: number | null) {
  const update = vi.fn().mockResolvedValue({});
  const queryRaw = vi
    .fn()
    .mockResolvedValue(estimatedSheets === null ? [] : [{ estimated_sheets: estimatedSheets }]);
  const transaction = {
    $queryRaw: queryRaw,
    kioskPaperInventory: { update }
  } as unknown as Prisma.TransactionClient;
  return { transaction, update, queryRaw };
}

describe("reading a kiosk's paper estimate", () => {
  it("answers with the count on the row", async () => {
    await expect(readKioskPaperEstimate(reader(118), kioskId)).resolves.toBe(118);
  });

  it("reads it by primary key rather than reconstructing it", async () => {
    // The point of the whole refactor: one lookup, no aggregate, no history.
    const client = reader(118);
    await readKioskPaperEstimate(client, kioskId);

    expect(client.findUnique).toHaveBeenCalledTimes(1);
    expect(client.findUnique).toHaveBeenCalledWith({
      where: { kioskId },
      select: { estimatedSheets: true }
    });
  });

  it("answers nothing at all until somebody records a refill or a correction", async () => {
    // Not zero. A kiosk nobody tracks may have a full tray, and reporting it as
    // empty would refuse every customer at a working machine.
    await expect(readKioskPaperEstimate(reader(null), kioskId)).resolves.toBeNull();
  });

  it("keeps zero and nothing apart", async () => {
    // A tracked kiosk that has genuinely run out reads zero, and zero refuses.
    await expect(readKioskPaperEstimate(reader(0), kioskId)).resolves.toBe(0);
  });
});

describe("deducting a confirmed print", () => {
  it("subtracts the physical sheets the device produced", async () => {
    // Four printed sides in duplex were already resolved by the agent to two
    // physical sheets. Inventory consumes this value, not document pages.
    const { transaction, update } = transactionHolding(500);

    const result = await applyKioskPaperDeduction(transaction, {
      kioskId,
      sheetsProduced: 2,
      now
    });

    expect(update).toHaveBeenCalledWith({
      where: { kioskId },
      data: { estimatedSheets: 498, updatedAt: now }
    });
    expect(result).toEqual({
      consumedSheets: 2,
      estimateDeltaSheets: -2,
      estimateAffected: true,
      estimatedSheets: 498
    });
  });

  it("takes the row's lock before deciding what to write", async () => {
    // Two prints completing at one kiosk, or a refill racing a completion, must
    // not both calculate from the same old balance. This is what the ledger's
    // advisory lock did; the row it now lives on does it instead.
    const { transaction, queryRaw } = transactionHolding(500);

    await applyKioskPaperDeduction(transaction, { kioskId, sheetsProduced: 2, now });

    const statement = (queryRaw.mock.calls[0]?.[0] as { join(separator: string): string })
      .join("?")
      .toUpperCase();
    expect(statement).toContain("FOR UPDATE");
  });

  it("stops at zero rather than recording a debt", async () => {
    // Deductions outrun refills when somebody forgets to record one. A tray
    // cannot hold fewer than no sheets, and a negative balance would silently
    // absorb the next refill.
    const { transaction, update } = transactionHolding(3);

    const result = await applyKioskPaperDeduction(transaction, {
      kioskId,
      sheetsProduced: 10,
      now
    });

    expect(update).toHaveBeenCalledWith({
      where: { kioskId },
      data: { estimatedSheets: 0, updatedAt: now }
    });
    // The estimate only lost what it had. The job still produced ten sheets and
    // says so, because that is what the audit record is for.
    expect(result).toEqual({
      consumedSheets: 10,
      estimateDeltaSheets: -3,
      estimateAffected: true,
      estimatedSheets: 0
    });
  });

  it("leaves a kiosk nobody tracks untracked", async () => {
    // The completion is real. Inventing a starting balance from it would invent
    // the tracking with it, and start refusing jobs this kiosk can print.
    const { transaction, update } = transactionHolding(null);

    const result = await applyKioskPaperDeduction(transaction, {
      kioskId,
      sheetsProduced: 3,
      now
    });

    expect(update).not.toHaveBeenCalled();
    expect(result).toEqual({
      consumedSheets: 3,
      estimateDeltaSheets: 0,
      estimateAffected: false,
      estimatedSheets: null
    });
  });
});
