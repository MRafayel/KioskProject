import type { Prisma } from "@printing-kiosk/database";

import { ApiError } from "../sessions/errors.js";

/**
 * Whether a customer may start something new on this kiosk.
 *
 * The classification itself is not made here. The agent has already decided
 * which physical conditions mean "a job submitted now will not come out" and
 * folded them into one health value, so this reads an enum rather than
 * reasoning about paper. That is deliberate: the rule about what blocks a sale
 * and what merely warns exists in one place, beside the evidence, and cannot
 * drift between the machine that can see the printer and the service that
 * cannot.
 *
 * Everything here is about *new* work. No path in this file can reach a job
 * that has been submitted, and none of it is consulted after money has moved —
 * a printer that fails after a customer has paid is the recovery path's
 * problem, and turning it into a refusal here would strand a paid job.
 */

/** Why a customer is being turned away. Ordered most specific first. */
export type PrinterBlockReason =
  /** Offline with a paper warning standing. The one cause worth naming. */
  | "PRINTER_OUT_OF_PAPER"
  /** The device says it cannot print, for a reason not worth guessing at. */
  | "PRINTER_OFFLINE"
  /** Nothing has been heard from this kiosk's agent recently enough. */
  | "PRINTER_SILENT"
  /** The agent is reporting, but could not bind a certified printer. */
  | "PRINTER_NOT_READY";

export type PrinterReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: PrinterBlockReason };

export interface ApprovedPrinterState {
  readonly health: string;
  readonly warningCode: string | null;
  readonly lastSeenAt: Date;
}

/**
 * Reads a device record and decides whether to let a customer begin.
 *
 * A kiosk with **no printer rows at all** is treated as ready. That is not an
 * oversight: it means no agent has ever reported here, which is a provisioning
 * problem an operator sees in the fleet view, not a printer that has gone
 * wrong. Blocking on it would turn every un-provisioned environment into a dead
 * kiosk while adding nothing — a kiosk with no certified printer already cannot
 * print, and the print itself fails into recovery. Once an agent has reported
 * even once, its silence and its verdicts both count.
 */
export function classifyPrinterReadiness(input: {
  readonly approved: ApprovedPrinterState | null;
  readonly hasAnyPrinter: boolean;
  readonly now: Date;
  readonly maxSilenceMs: number;
}): PrinterReadiness {
  if (!input.approved) {
    // Rows exist but none is approved: this kiosk had a certified printer and
    // no longer does. Silence from a machine that has never spoken is a
    // different thing, and is not this gate's business.
    return input.hasAnyPrinter ? { ready: false, reason: "PRINTER_NOT_READY" } : { ready: true };
  }

  const silence = input.now.getTime() - input.approved.lastSeenAt.getTime();
  if (silence > input.maxSilenceMs) {
    // The stored verdict describes a printer nobody has heard from. It is
    // usually a healthy one, which is exactly why age has to override it.
    return { ready: false, reason: "PRINTER_SILENT" };
  }

  if (input.approved.health === "OFFLINE") {
    // `PAPER_LOW` beside an offline printer is the one cause reliable enough to
    // name to a customer: on the certified hardware it is set by the tray level
    // itself. Every other cause gets the general message rather than a guess.
    return {
      ready: false,
      reason:
        input.approved.warningCode === "PAPER_LOW" ? "PRINTER_OUT_OF_PAPER" : "PRINTER_OFFLINE"
    };
  }

  // READY and WARNING both sell. A warning is a note for whoever restocks the
  // machine — toner running down, a tray that will need paper — and turning
  // customers away for one would close the kiosk for a condition it can still
  // print through.
  return { ready: true };
}

export interface PrinterReadinessGateOptions {
  /**
   * How long a device record stays trustworthy. Derived from the heartbeat
   * interval: a couple of missed beats is a slow network, several is a machine
   * that has stopped talking.
   */
  readonly maxSilenceMs: number;
  readonly clock: { now(): Date };
  /**
   * Optional, and only ever told about the device row this gate read. A refusal
   * here closes a kiosk to customers, so the reason it decided has to be
   * recoverable afterwards from something other than a customer's account of
   * what the screen said.
   */
  readonly logger?: {
    debug(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

/**
 * The gate itself, as the customer-facing services use it.
 *
 * It throws rather than returning, because every caller wants the same thing:
 * stop here, and tell the customer why. The reason travels in the error detail
 * so the kiosk can choose its wording; the message on the error is for logs and
 * operators, never for a screen.
 */
export class PrinterReadinessGate {
  public constructor(private readonly options: PrinterReadinessGateOptions) {}

  public async assertReady(
    transaction: Prisma.TransactionClient,
    kioskId: string
  ): Promise<void> {
    const readiness = await this.read(transaction, kioskId);
    if (readiness.ready) return;
    throw new ApiError(
      409,
      "PRINTER_UNAVAILABLE",
      "The printer on this kiosk cannot accept a job right now.",
      { reason: readiness.reason }
    );
  }

  public async read(
    transaction: Prisma.TransactionClient,
    kioskId: string
  ): Promise<PrinterReadiness> {
    const approved = await transaction.printer.findFirst({
      where: { kioskId, approval: "APPROVED" },
      select: { health: true, warningCode: true, lastSeenAt: true }
    });
    // Only asked when there is no approved printer, which is the rare case.
    const hasAnyPrinter =
      approved !== null || (await transaction.printer.count({ where: { kioskId } })) > 0;

    const now = this.options.clock.now();
    const readiness = classifyPrinterReadiness({
      approved,
      hasAnyPrinter,
      now,
      maxSilenceMs: this.options.maxSilenceMs
    });

    // The whole basis of the decision, so a kiosk that turned somebody away —
    // or one that should have and did not — can be explained without a
    // reproduction. `health` here is the agent's folded verdict: if telemetry is
    // off on that machine it is the driver's opinion, and the pair of this line
    // and the agent's own telemetry line is what tells the two apart.
    const fields = {
      kioskId,
      decision: readiness.ready ? "PASS" : readiness.reason,
      approvedPrinter: approved !== null,
      hasAnyPrinter,
      health: approved?.health ?? null,
      warningCode: approved?.warningCode ?? null,
      ageMs: approved ? now.getTime() - approved.lastSeenAt.getTime() : null,
      maxSilenceMs: this.options.maxSilenceMs
    };
    if (readiness.ready) this.options.logger?.debug(fields, "printer readiness gate passed");
    else this.options.logger?.warn(fields, "printer readiness gate refused a customer");

    return readiness;
  }
}
