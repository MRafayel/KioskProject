import { getKioskAvailabilityResponseSchema, type KioskAvailability } from "@printing-kiosk/contracts";

/**
 * Whether this kiosk can take a new customer, asked on a timer.
 *
 * The screen has no opinion of its own about the printer. It repeats what the
 * control plane's readiness gate says — the same gate session creation runs —
 * so the button and the refusal behind it can never disagree.
 *
 * Polled rather than pushed because the answer is only interesting while
 * somebody is standing at an idle welcome screen, and because a screen that
 * failed to receive a push would silently go on offering a printer that cannot
 * print. A poll that fails is visible on the next tick.
 */
export const AVAILABILITY_POLL_MS = 5_000;

/**
 * What the screen believes when it has not managed to ask.
 *
 * Available, deliberately. The gate still runs on session creation, so the worst
 * a wrong optimistic answer costs is the refusal the customer would have had
 * anyway — while a wrong pessimistic answer closes a working kiosk because its
 * own agent was briefly slow. Only an answer that actually arrived may shut the
 * screen.
 */
export const ASSUME_AVAILABLE: KioskAvailability = { available: true, reason: null };

export async function readKioskAvailability(signal?: AbortSignal): Promise<KioskAvailability> {
  const response = await fetch("/agent/v1/availability", {
    method: "GET",
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {})
  });
  if (!response.ok) return ASSUME_AVAILABLE;
  return getKioskAvailabilityResponseSchema.parse(await response.json()).availability;
}
