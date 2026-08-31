import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

/**
 * How much paper a kiosk is believed to hold.
 *
 * One row per kiosk, holding one number. A refill adds to it, a confirmed print
 * subtracts from it, a correction sets it, and reading it is a primary-key
 * lookup — there is no history to replay and nothing to sum.
 *
 * Two rules travel with that number and are why this is a module rather than a
 * query written out at each call site.
 *
 * The first is the floor. A tray cannot hold a negative number of sheets, so an
 * estimate that has drifted below reality reports zero rather than a debt. It
 * is enforced in the arithmetic *and* by a check constraint, because the two
 * catch different mistakes.
 *
 * The second is the distinction between zero and nothing. Until somebody
 * records a refill or a correction there is no row, this kiosk is not being
 * tracked at all, and that is a different fact from an empty tray — one of them
 * means "ask an operator", the other means "do not start a job you cannot
 * finish". Null is that first case and every caller has to tell them apart.
 */

/** The ceiling the check constraint also enforces. */
export const PAPER_INVENTORY_MAX_SHEETS = 100_000;

/**
 * The narrowest client this needs, so the same read serves the application
 * pool, a transaction, and the control plane's deliberately narrowed surface
 * without any of them widening to accommodate it.
 */
export interface KioskPaperEstimateReader {
  kioskPaperInventory: Pick<PrismaClient["kioskPaperInventory"], "findUnique">;
}

export async function readKioskPaperEstimate(
  client: KioskPaperEstimateReader,
  kioskId: string
): Promise<number | null> {
  const inventory = await client.kioskPaperInventory.findUnique({
    where: { kioskId },
    select: { estimatedSheets: true }
  });
  // No row is "nobody tracks this kiosk", which is not the same as an empty
  // tray and must never be reported as zero.
  return inventory?.estimatedSheets ?? null;
}

/**
 * Take the inventory row's own lock and read the count under it.
 *
 * This is what the ledger's per-kiosk advisory lock was for, done by the row
 * the number now lives on. Two prints completing at one kiosk, or a refill
 * racing a completion, queue here instead of both calculating from the same old
 * balance and one of them overwriting the other.
 *
 * Returns null for an untracked kiosk, having locked nothing — there is no row
 * to contend for.
 */
export async function lockKioskPaperEstimate(
  transaction: Prisma.TransactionClient,
  kioskId: string
): Promise<number | null> {
  const locked = await transaction.$queryRaw<{ estimated_sheets: number }[]>`
    SELECT "estimated_sheets"
      FROM "kiosk_paper_inventory"
     WHERE "kiosk_id" = ${kioskId}
       FOR UPDATE
  `;
  return locked[0]?.estimated_sheets ?? null;
}

export interface KioskPaperDeduction {
  /** What the device reported producing, whether or not it was all deducted. */
  consumedSheets: number;
  /** The signed change actually applied. Zero when the kiosk is untracked. */
  estimateDeltaSheets: number;
  estimateAffected: boolean;
  /** The count after this deduction, or null when the kiosk is untracked. */
  estimatedSheets: number | null;
}

/**
 * Take confirmed physical output out of the estimate.
 *
 * Lock the row, subtract, floor at zero, write it back. The floor is the reason
 * the subtraction is not a bare atomic decrement: a count that has drifted
 * below what actually came out of the tray must land on zero rather than on a
 * debt, and the next refill then adds what staff really loaded.
 *
 * A kiosk with no row is untracked and stays untracked. The completion is real,
 * but inventing a starting balance from it would invent the tracking too.
 */
export async function applyKioskPaperDeduction(
  transaction: Prisma.TransactionClient,
  input: { kioskId: string; sheetsProduced: number; now: Date }
): Promise<KioskPaperDeduction> {
  const current = await lockKioskPaperEstimate(transaction, input.kioskId);
  if (current === null) {
    return {
      consumedSheets: input.sheetsProduced,
      estimateDeltaSheets: 0,
      estimateAffected: false,
      estimatedSheets: null
    };
  }

  const applied = Math.min(current, Math.max(0, input.sheetsProduced));
  const remaining = current - applied;
  await transaction.kioskPaperInventory.update({
    where: { kioskId: input.kioskId },
    data: { estimatedSheets: remaining, updatedAt: input.now }
  });

  return {
    consumedSheets: input.sheetsProduced,
    estimateDeltaSheets: -applied,
    estimateAffected: true,
    estimatedSheets: remaining
  };
}
