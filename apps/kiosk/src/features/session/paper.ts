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
