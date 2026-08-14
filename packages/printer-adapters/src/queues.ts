import type { PrinterQueueDescriptor } from "./types.js";

/**
 * Which queue a kiosk is allowed to print to.
 *
 * A kiosk machine sees every queue its operating system knows about: a PDF
 * writer, a queue somebody shared from a laptop, whatever a driver installer
 * added. Printing to an arbitrary one is how a paid job ends up in a file nobody
 * collects, or on a printer in another room. So approval is by name and by
 * operator, it is checked on this side rather than trusted from the device, and
 * an empty allowlist approves nothing at all.
 */
export interface QueueApprovalPolicy {
  /** Queue names an operator certified for this kiosk. Empty approves none. */
  allowlist: readonly string[];
  /** Which approved queue to prefer when the machine offers more than one. */
  preferred?: string | null;
  /**
   * Whether a queue published to other machines may be used. False by default:
   * a shared queue is an inbound path onto a kiosk that opens no other one.
   */
  allowShared?: boolean;
}

export type QueueRejectionReason =
  /** The machine offers no print queues at all. */
  | "NO_QUEUES"
  /** No queue on this machine carries an approved name. */
  | "NOT_APPROVED"
  /** The only approved match is published to other machines. */
  | "SHARED"
  /** More than one approved queue matched and configuration named no preference. */
  | "AMBIGUOUS";

export type QueueSelection =
  | { readonly approved: true; readonly queue: PrinterQueueDescriptor }
  | { readonly approved: false; readonly reason: QueueRejectionReason };

/**
 * Pick the one queue this kiosk may print to, or explain why there is none.
 *
 * Nothing here looks at whether the queue is ready. A paused or offline printer
 * is still the approved printer, and saying so is what lets the kiosk report
 * `PRINTER_OFFLINE` for the right device instead of quietly failing over to
 * another one.
 */
export function selectApprovedQueue(
  queues: readonly PrinterQueueDescriptor[],
  policy: QueueApprovalPolicy
): QueueSelection {
  if (queues.length === 0) return { approved: false, reason: "NO_QUEUES" };

  const allowed = new Set(
    policy.allowlist.map(normalizeQueueName).filter((name) => name.length > 0)
  );
  if (allowed.size === 0) return { approved: false, reason: "NOT_APPROVED" };

  const matches = queues.filter((queue) => allowed.has(normalizeQueueName(queue.queueName)));
  if (matches.length === 0) return { approved: false, reason: "NOT_APPROVED" };

  const usable = policy.allowShared === true ? matches : matches.filter((queue) => !queue.shared);
  if (usable.length === 0) return { approved: false, reason: "SHARED" };

  const preferred = normalizeQueueName(policy.preferred ?? "");
  if (preferred.length > 0) {
    const chosen = usable.find((queue) => normalizeQueueName(queue.queueName) === preferred);
    // A preference naming a queue that is not approved and present is a
    // configuration error, not a reason to print somewhere else.
    return chosen ? { approved: true, queue: chosen } : { approved: false, reason: "NOT_APPROVED" };
  }

  if (usable.length > 1) return { approved: false, reason: "AMBIGUOUS" };
  return { approved: true, queue: usable[0]! };
}

/** Whether one queue name is on an allowlist, for a bound adapter's own check. */
export function isApprovedQueueName(queueName: string, allowlist: readonly string[]): boolean {
  const normalized = normalizeQueueName(queueName);
  if (normalized.length === 0) return false;
  return allowlist.some((entry) => normalizeQueueName(entry) === normalized);
}

/**
 * Queue names are compared case-insensitively with surrounding space removed.
 * Windows treats printer names that way, and an allowlist that disagreed with
 * the operating system about what counts as the same name would fail open on
 * one platform or closed on the other.
 */
export function normalizeQueueName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

/** Parse the configured allowlist. Separator is a comma; blanks are dropped. */
export function parseQueueAllowlist(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
