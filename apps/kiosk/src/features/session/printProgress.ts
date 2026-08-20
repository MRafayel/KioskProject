import { useEffect, useState } from "react";

import type { PrintJobSnapshot } from "@printing-kiosk/contracts";

/**
 * What the customer is told is happening, in the order it happens.
 *
 * These are a presentation of the real pipeline, not a second source of truth
 * about it. The control plane exposes three pre-terminal states — QUEUED,
 * DISPATCHED and PRINTING — and the last of them covers roughly ten seconds in
 * which the device host resolves the queue, measures the printable surface,
 * rasterises the pages, draws them through GDI and then waits for the spooler
 * to retire the job. Naming only "printing" for all of that is what made the
 * wait feel like a frozen screen.
 *
 * The ordering is the host's own: it cannot check a printer it has not resolved
 * or send pages it has not drawn.
 */
export const PRINT_STAGES = [
  "PREPARING_FILES",
  "CHECKING_PRINTER",
  "PREPARING_PAGES",
  "SENDING_PAGES",
  "PRINTING",
  "FINISHING"
] as const;

export type PrintStage = (typeof PRINT_STAGES)[number];

/**
 * The shortest time a stage may stay on screen.
 *
 * A stage the customer cannot finish reading is worse than no stage at all, so
 * nothing is shown for less than this even when the real step took 300ms. The
 * larger values are the measured cost of the corresponding device phase on the
 * reference printer, which is what keeps the sequence behind reality rather
 * than ahead of it.
 */
export const MINIMUM_HOLD_MS: Record<PrintStage, number> = {
  PREPARING_FILES: 1_200,
  CHECKING_PRINTER: 1_400,
  PREPARING_PAGES: 2_000,
  SENDING_PAGES: 2_600,
  PRINTING: 900,
  FINISHING: 900
};

/** How long a confirmed completion is shown before the receipt replaces it. */
export const FINISHING_HOLD_MS = MINIMUM_HOLD_MS.FINISHING;

export interface StagePresentation {
  stage: PrintStage;
  enteredAt: number;
}

export function stageIndex(stage: PrintStage): number {
  return PRINT_STAGES.indexOf(stage);
}

/**
 * The furthest stage the control plane's own answer justifies showing.
 *
 * This is the honesty boundary. The presentation may walk up to the ceiling on
 * its own clock, and may never pass it, so no timer can carry the screen into
 * claiming an outcome the device has not reported.
 *
 * `PRINTING` is a ceiling rather than a step: everything from checking the
 * printer to waiting for the spooler happens inside that one backend state, and
 * the screen parks on the last of those stages until a real result arrives.
 * Only a completion the device confirmed unlocks `FINISHING`.
 */
export function stageCeiling(printJob: PrintJobSnapshot | null): PrintStage {
  if (!printJob) return "PREPARING_FILES";
  if (printJob.status === "COMPLETED" && printJob.resultConfidence === "CONFIRMED") {
    return "FINISHING";
  }
  return printJob.status === "PRINTING" ? "PRINTING" : "PREPARING_FILES";
}

/**
 * One step of the presentation. Pure, so the sequencing is testable without a
 * clock or a renderer.
 *
 * Never skips a stage while work is open, never runs past the ceiling, and
 * never moves backwards — a backend that reports PRINTING and then briefly
 * reports something earlier must not rewind a customer's reading.
 *
 * `settled` collapses the walk: once the control plane has given its real
 * answer there is nothing left to narrate, so the screen goes straight there
 * instead of playing out stages for a job that already finished.
 */
export function nextPresentation(
  current: StagePresentation,
  ceiling: PrintStage,
  settled: boolean,
  now: number
): StagePresentation {
  if (current.stage === ceiling) return current;
  if (settled) return { stage: ceiling, enteredAt: now };
  if (stageIndex(current.stage) > stageIndex(ceiling)) return current;
  if (now - current.enteredAt < MINIMUM_HOLD_MS[current.stage]) return current;
  // Unreachable while a ceiling exists — the last stage is always a ceiling —
  // but staying put is the safe answer if one ever does not.
  const following = PRINT_STAGES[stageIndex(current.stage) + 1];
  return following ? { stage: following, enteredAt: now } : current;
}

/** How long until this stage may be replaced, or null when it may not be. */
export function holdRemaining(current: StagePresentation, now: number): number {
  return Math.max(0, MINIMUM_HOLD_MS[current.stage] - (now - current.enteredAt));
}

/**
 * Drive the presentation from the job the screen is already polling.
 *
 * Nothing here reaches the device or the control plane, and nothing here can
 * delay a print: the pipeline runs at its own speed and this only decides which
 * sentence is on screen while it does.
 */
export function usePrintStage(printJob: PrintJobSnapshot | null): PrintStage {
  const [presentation, setPresentation] = useState<StagePresentation>(() => ({
    stage: "PREPARING_FILES",
    enteredAt: Date.now()
  }));
  // Only ever woken by the timer below. The hold each stage is part-way through
  // is measured from its own entry time, so a poll arriving mid-hold reschedules
  // to the same instant rather than extending it.
  const [wake, setWake] = useState(0);
  const status = printJob?.status ?? null;
  const confidence = printJob?.resultConfidence ?? null;

  useEffect(() => {
    const ceiling = stageCeiling(printJob);
    const settled = status === "COMPLETED" || status === "FAILED";
    const now = Date.now();
    const next = nextPresentation(presentation, ceiling, settled, now);
    if (next.stage !== presentation.stage) {
      setPresentation(next);
      return;
    }
    // Parked on the ceiling: only the control plane can move this on.
    if (presentation.stage === ceiling) return;
    const timer = window.setTimeout(
      () => setWake((value) => value + 1),
      Math.max(holdRemaining(presentation, now), 50)
    );
    return () => window.clearTimeout(timer);
    // Every poll re-parses the job, so this re-runs roughly every 1.5s. That is
    // harmless: the replacement timer is measured from the stage's own entry
    // time, so it still fires at the same instant rather than extending a hold
    // the customer is already part-way through.
  }, [presentation, printJob, status, confidence, wake]);

  return presentation.stage;
}
