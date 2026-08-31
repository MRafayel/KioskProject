import type { QueryClient } from "@tanstack/react-query";

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
 * How long an answer stands before opening a screen is a reason to ask again.
 *
 * This is the whole refresh policy now: nothing is on a timer, and the count is
 * re-read when a screen that shows or acts on it opens and the answer in hand is
 * older than this. That covers the two moments that matter — the upload screen
 * opening as a customer starts, and the configure screen opening before their
 * job is measured against the tray — while a customer stepping between the two,
 * which the "Add document" and "Back" buttons make easy, reuses the answer
 * rather than asking again for the same second.
 *
 * Short, because the only thing it buys is that step. Anything longer would let
 * the configure screen block or clear a job on a count from another customer's
 * session.
 */
export const PAPER_FRESH_MS = 10_000;

/**
 * What the screen shows before it has an answer.
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
 *
 * There is no interval here and nothing runs in the background. Opening a
 * screen is the trigger, and `staleTime` is the whole of the policy: React
 * Query refetches on mount exactly when the answer in hand has aged past
 * `PAPER_FRESH_MS`, which is the deduplication and the freshness rule in one
 * setting rather than a timer plus the bookkeeping a timer needs.
 *
 * Two details are load-bearing and neither is obvious.
 *
 * The first is `placeholderData` rather than `initialData`. `UNKNOWN_PAPER` is
 * not an answer, it is what to show before there is one, and `initialData`
 * would write it into the cache stamped with the current time — where a
 * non-zero `staleTime` then treats it as a fresh answer and asks nothing. A
 * kiosk that had only just started would tell its first customer the count was
 * unavailable while knowing perfectly well what it held. A placeholder is never
 * cached, so the first mount always asks.
 *
 * The second is that this app defaults every query to
 * `staleTime: Number.POSITIVE_INFINITY`. That suits the reads it was written
 * for — a session, a document's pages, a printer's capabilities — none of which
 * change behind the screen showing them. A sheet count does exactly that, so it
 * has to opt out, and this is where.
 */
export function kioskPaperQueryOptions() {
  return {
    queryKey: KIOSK_PAPER_QUERY_KEY,
    queryFn: ({ signal }: { signal: AbortSignal }) => readKioskPaper(signal),
    placeholderData: UNKNOWN_PAPER,
    staleTime: PAPER_FRESH_MS
  };
}

/**
 * Take a finished print out of the estimate as soon as it finishes.
 *
 * The control plane already deducted these sheets, in the same transaction that
 * moved the job to a confirmed completion. This is not a second opinion about
 * that: it is the same subtraction, applied locally.
 *
 * It matters more without a poll behind it, not less. The receipt closes after
 * five seconds, so the next customer can be on the upload screen well inside
 * the freshness window, reusing this answer rather than asking for a new one —
 * and without the deduction that answer would be the count from before their
 * predecessor's job. The next read past the window is still the reconciliation.
 *
 * Applied only to a *known* estimate. A kiosk nobody tracks records the
 * completion as history with a zero delta and stays untracked, so inventing a
 * number here would be inventing the tracking too.
 *
 * A read that was already in flight was sent before the deduction was
 * committed, so landing it afterwards would put the old count back. Cancelling
 * first is what stops that; if one slips through anyway the next read corrects
 * it.
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
