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

/**
 * How far the bar may travel on presentation pacing alone.
 *
 * Everything up to here is the backend preparing, rendering and submitting —
 * work the customer cannot see and the screen cannot measure. The bar is allowed
 * to narrate that because being wrong about it costs nothing: no claim is being
 * made about paper.
 */
export const PREPARATION_CEILING = 0.68;

/**
 * How far it may travel while paper is coming out, and no further.
 *
 * The last three percent belong to the control plane. A bar that reaches the end
 * before the device has confirmed anything is making the same promise the whole
 * telemetry effort exists to stop the kiosk making — so it asymptotes here and
 * waits, however long the printer takes.
 */
export const PRINTING_CEILING = 0.97;

/**
 * Measured on the reference printer: about three seconds an impression, and flat
 * across page counts. It paces the physical segment so a fifty-page job crawls
 * and a one-page job does not, which is the difference between a bar that looks
 * like the machine and one that looks like a timer.
 */
export const MS_PER_SIDE = 3_100;

/** A job with no side count still needs a pace. One sheet is the common case. */
const ASSUMED_SIDES = 1;

/** Where each preparation stage starts, as a share of `PREPARATION_CEILING`. */
const PREPARATION_STAGES = PRINT_STAGES.slice(0, stageIndexOf("PRINTING"));
const PREPARATION_TOTAL_MS = PREPARATION_STAGES.reduce(
  (total, stage) => total + MINIMUM_HOLD_MS[stage],
  0
);

function stageIndexOf(stage: PrintStage): number {
  return PRINT_STAGES.indexOf(stage);
}

function preparationSpan(stage: PrintStage): { start: number; end: number } {
  let elapsed = 0;
  for (const candidate of PREPARATION_STAGES) {
    const share = MINIMUM_HOLD_MS[candidate] / PREPARATION_TOTAL_MS;
    if (candidate === stage) {
      const start = (elapsed / PREPARATION_TOTAL_MS) * PREPARATION_CEILING;
      return { start, end: start + share * PREPARATION_CEILING };
    }
    elapsed += MINIMUM_HOLD_MS[candidate];
  }
  return { start: PREPARATION_CEILING, end: PREPARATION_CEILING };
}

/**
 * Approach a target without ever arriving.
 *
 * Every segment of this bar eases rather than marches, for the same reason: the
 * durations behind it are estimates, and an estimate that runs out leaves a
 * linear bar sitting dead at a round number. This one keeps moving, slower and
 * slower, which reads as "still working" rather than "stuck" — and it can never
 * overshoot into a claim the backend has not made.
 */
function approach(start: number, end: number, elapsedMs: number, expectedMs: number): number {
  if (expectedMs <= 0) return end;
  return start + (end - start) * (1 - Math.exp(-Math.max(0, elapsedMs) / expectedMs));
}

/**
 * How full the bar is, from nothing this screen can influence.
 *
 * Strictly observational, in both directions: it reads the job the screen is
 * already polling and the stage the presentation has already reached, and
 * nothing it returns is sent anywhere. A wrong answer here makes a bar look odd;
 * it cannot delay a print, change an outcome, or reach a printer.
 *
 * The physical segment is paced from the job's own side count rather than from
 * the printer's page counter. Reading the counter live would mean reporting it
 * from inside the marker watch, which runs *after* the agent releases its
 * command lease — so the only channel available there is one whose semantics
 * exist to prevent duplicate printing. A progress bar is not worth entangling
 * with that, and the side count paces the segment about as well.
 */
export function printProgressFraction(input: {
  readonly stage: PrintStage;
  readonly stageElapsedMs: number;
  readonly printedSides: number | null;
  readonly confirmed: boolean;
}): number {
  // Only a completion the device confirmed fills the bar. Nothing else may.
  if (input.confirmed) return 1;
  if (input.stage === "FINISHING") return 1;

  if (input.stage === "PRINTING") {
    const sides = input.printedSides && input.printedSides > 0 ? input.printedSides : ASSUMED_SIDES;
    return approach(
      PREPARATION_CEILING,
      PRINTING_CEILING,
      input.stageElapsedMs,
      sides * MS_PER_SIDE
    );
  }

  const span = preparationSpan(input.stage);
  return approach(span.start, span.end, input.stageElapsedMs, MINIMUM_HOLD_MS[input.stage]);
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
 * instead of playing out stages for a job that already finished. It collapses
 * forwards only. A job that settles into anything other than a confirmed
 * success has no ceiling above `PREPARING_FILES`, and jumping to it would empty
 * a nearly full bar in the instant before the screen changes — a customer whose
 * pages are in the tray watching the machine appear to undo them.
 */
export function nextPresentation(
  current: StagePresentation,
  ceiling: PrintStage,
  settled: boolean,
  now: number
): StagePresentation {
  if (current.stage === ceiling) return current;
  if (stageIndex(current.stage) > stageIndex(ceiling)) return current;
  if (settled) return { stage: ceiling, enteredAt: now };
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
/**
 * How often the bar is redrawn while a stage is held.
 *
 * Slow enough to be nothing on kiosk hardware that is simultaneously rasterising
 * a PDF, fast enough that the movement reads as continuous rather than as a
 * sequence of jumps.
 */
const PROGRESS_TICK_MS = 250;

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

/**
 * The stage, and how full the bar is with it.
 *
 * Wraps `usePrintStage` rather than replacing it, so the sequencing rules — the
 * ceiling, the minimum holds, the refusal to rewind — stay in one place and this
 * only adds a number derived from them.
 */
export function usePrintProgress(printJob: PrintJobSnapshot | null): {
  stage: PrintStage;
  fraction: number;
} {
  const stage = usePrintStage(printJob);
  const [enteredAt, setEnteredAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // A new stage restarts the easing, so each segment fills across its own
    // span rather than inheriting the previous one's elapsed time.
    const at = Date.now();
    setEnteredAt(at);
    setNow(at);
  }, [stage]);

  const confirmed = printJob?.status === "COMPLETED" && printJob.resultConfidence === "CONFIRMED";

  useEffect(() => {
    if (confirmed) return;
    const timer = window.setInterval(() => setNow(Date.now()), PROGRESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, [confirmed]);

  return {
    stage,
    fraction: printProgressFraction({
      stage,
      stageElapsedMs: now - enteredAt,
      printedSides: printJob?.printedSides ?? null,
      confirmed
    })
  };
}
