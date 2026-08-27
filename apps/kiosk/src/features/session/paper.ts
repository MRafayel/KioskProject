import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { getKioskPaperResponseSchema, type KioskPaperEstimate } from "@printing-kiosk/contracts";

/**
 * How much paper the kiosk believes it has, and what the screen does about it.
 *
 * The estimate is software: staff record what they load, confirmed prints
 * deduct what they produced, and the difference is what is left. It is not a
 * tray sensor and it is never treated as one. Its whole job here is to stop a
 * customer paying for a job that plainly cannot come out — twenty-four sheets
 * against eighteen is not a close call, and the refusal is free before payment
 * and expensive after it.
 *
 * Not knowing is therefore never a refusal. A kiosk nobody keeps a ledger for,
 * or one whose very first read fails, prints exactly as it did before any of
 * this existed: the hard gate is still the printer's own readiness, which
 * closes the welcome screen long before here. What not knowing may not do is
 * *undo* — a shortfall the screen has already established stands until a better
 * answer arrives, which is why a failed read raises rather than answers.
 */

/** Shared by both screens, so they read one answer rather than two. */
export const KIOSK_PAPER_QUERY_KEY = ["kiosk-paper"] as const;

/**
 * Re-read while a job is being put together. Slower than the availability poll
 * because this number only moves when a print completes or somebody refills the
 * tray, and the check that matters runs again on the way to the checkout anyway.
 */
export const PAPER_POLL_MS = 20_000;

/**
 * What the screen believes before it has ever managed to ask.
 *
 * Unknown rather than empty, deliberately, and for the same reason the
 * availability poll assumes available: a wrong pessimistic answer refuses a
 * customer the machine could have served.
 */
export const UNKNOWN_PAPER: KioskPaperEstimate = { estimatedSheets: null };

export class PaperReadError extends Error {
  public constructor() {
    super("PAPER_READ_FAILED");
    this.name = "PaperReadError";
  }
}

/**
 * Raises rather than answering "unknown" when the read fails, and that
 * difference is the safety property.
 *
 * Once a kiosk is being tracked its estimate never legitimately becomes null
 * again, so an answer that did not arrive is a request that failed and not a
 * kiosk that stopped counting. Reporting it as `null` would quietly lift a
 * shortfall the screen had already earned; raising leaves the last answer that
 * actually arrived in place, which is the better evidence about the tray.
 *
 * A kiosk whose first read fails still shows unknown and still sells, because
 * there is no earlier answer to keep: `UNKNOWN_PAPER` is where the query starts.
 */
export async function readKioskPaper(signal?: AbortSignal): Promise<KioskPaperEstimate> {
  const response = await fetch("/agent/v1/paper", {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    ...(signal ? { signal } : {})
  });
  if (!response.ok) throw new PaperReadError();
  const parsed = getKioskPaperResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PaperReadError();
  return parsed.data.paper;
}

/**
 * The one query both screens share, so the number a customer is shown while
 * uploading and the number their job is checked against a minute later are the
 * same answer rather than two reads that happened to agree.
 */
export function kioskPaperQueryOptions() {
  return {
    queryKey: KIOSK_PAPER_QUERY_KEY,
    queryFn: ({ signal }: { signal: AbortSignal }) => readKioskPaper(signal),
    refetchInterval: PAPER_POLL_MS,
    initialData: UNKNOWN_PAPER
  };
}

/**
 * Take a finished print out of the estimate without waiting for the next poll.
 *
 * The control plane already deducted these sheets, in the same transaction that
 * moved the job to a confirmed completion. This is not a second opinion about
 * that: it is the same subtraction, applied locally so the screen stops showing
 * a count the kiosk stopped having up to twenty seconds ago. The next poll is
 * still the reconciliation, and it overwrites whatever this left behind.
 *
 * Applied only to a *known* estimate. A kiosk nobody tracks records the
 * completion as history with a zero delta and stays untracked, so inventing a
 * number here would be inventing the tracking too.
 *
 * A read that was already in flight was sent before the deduction was
 * committed, so landing it afterwards would put the old count back. Cancelling
 * first is what keeps the event-driven update and the poll from fighting; if
 * one slips through anyway the poll after it is correct.
 */
export async function applyPrintedSheets(
  queryClient: QueryClient,
  sheetsProduced: number
): Promise<void> {
  if (!Number.isFinite(sheetsProduced) || sheetsProduced <= 0) return;
  await queryClient.cancelQueries({ queryKey: KIOSK_PAPER_QUERY_KEY });
  queryClient.setQueryData<KioskPaperEstimate>(KIOSK_PAPER_QUERY_KEY, (current) => {
    if (!current || current.estimatedSheets === null) return current;
    // The same floor the ledger keeps: a tray cannot hold fewer than no sheets.
    return { estimatedSheets: Math.max(0, current.estimatedSheets - sheetsProduced) };
  });
}

/**
 * One early read after a kiosk that had closed opens again.
 *
 * A kiosk goes unavailable when its printer runs out. What happens next is a
 * person putting paper in it and then typing the new count into the admin
 * panel, and those two are minutes apart from the terminal's point of view: the
 * printer recovers first, the count arrives second. A screen that only asked
 * again on its ordinary interval would spend that interval offering the count
 * from before the refill.
 *
 * So the reopening schedules exactly one extra read, and then nothing. The
 * interval is unchanged, no state polls faster than any other, and a kiosk that
 * closes and reopens twenty times in an hour costs twenty reads.
 */
export const PAPER_RELOAD_REFRESH_MS = 7_000;

export function usePaperReloadRefresh(available: boolean): void {
  const queryClient = useQueryClient();
  // Seeded from the first answer, so mounting is not itself a reopening.
  const wasAvailable = useRef(available);

  useEffect(() => {
    const reopened = available && !wasAvailable.current;
    wasAvailable.current = available;
    if (!reopened) return;

    const timer = window.setTimeout(() => {
      // Prefetch rather than refetch: this runs on the welcome screen, where
      // nothing is subscribed to the estimate yet, and the point is to have the
      // new count already in hand when the next customer reaches the upload
      // screen. It swallows its own failures — the ordinary poll follows.
      void queryClient.prefetchQuery({ ...kioskPaperQueryOptions(), staleTime: 0 });
    }, PAPER_RELOAD_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [available, queryClient]);
}

/**
 * Whether this configuration asks for more sheets than the kiosk has.
 *
 * Only a known estimate can refuse. `null` is "not tracked here", and a job of
 * no sheets is not yet a job — a customer who has excluded every page is
 * already held by the pricing gate and does not need a second explanation
 * about paper.
 */
export function exceedsPaperEstimate(
  requiredSheets: number,
  estimatedSheets: number | null
): boolean {
  if (estimatedSheets === null) return false;
  if (requiredSheets <= 0) return false;
  return requiredSheets > estimatedSheets;
}
