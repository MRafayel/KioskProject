import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * How much paper a kiosk is believed to hold, read from its own ledger.
 *
 * `kiosk_paper_events` is the inventory: refills and corrections are human
 * facts, deductions are written beside confirmed print completions, and the
 * current estimate is the sum of the signed deltas. Two rules travel with that
 * sum and are the reason this is a function rather than a query written out at
 * each call site.
 *
 * The first is the floor. A tray cannot hold a negative number of sheets, so a
 * ledger that has drifted below reality reports zero rather than a debt.
 *
 * The second is the distinction between zero and nothing. Until somebody
 * records a refill or a correction, this kiosk is not being tracked at all, and
 * that is a different fact from an empty tray — one of them means "ask an
 * operator", the other means "do not start a job you cannot finish". Null is
 * that first case and every caller has to be able to tell them apart.
 */

/**
 * The narrowest client this needs, so the same read serves the application
 * pool, a transaction, and the control plane's deliberately narrowed
 * append-only surface without any of them widening to accommodate it.
 */
export interface KioskPaperEstimateReader {
  kioskPaperEvent: Pick<PrismaClient["kioskPaperEvent"], "findFirst" | "aggregate">;
}

export async function readKioskPaperEstimate(
  client: KioskPaperEstimateReader,
  kioskId: string
): Promise<number | null> {
  const initialized = await client.kioskPaperEvent.findFirst({
    where: { kioskId, type: { in: ["REFILL", "CORRECTION"] } },
    select: { id: true }
  });
  if (!initialized) return null;

  const total = await client.kioskPaperEvent.aggregate({
    where: { kioskId },
    _sum: { deltaSheets: true }
  });
  return Math.max(0, total._sum.deltaSheets ?? 0);
}
