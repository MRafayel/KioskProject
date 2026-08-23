import { describe, expect, it } from "vitest";

import type { PrintJobSnapshot } from "@printing-kiosk/contracts";

import {
  MINIMUM_HOLD_MS,
  nextPresentation,
  printProgressFraction,
  PREPARATION_CEILING,
  PRINTING_CEILING,
  MS_PER_SIDE,
  PRINT_STAGES,
  stageCeiling,
  stageIndex,
  type PrintStage,
  type StagePresentation
} from "./printProgress.js";

function job(overrides: Partial<PrintJobSnapshot>): PrintJobSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    quoteId: "00000000-0000-4000-8000-000000000003",
    paymentId: "00000000-0000-4000-8000-000000000004",
    settingsRevision: 1,
    status: "QUEUED",
    resultConfidence: "UNKNOWN",
    failureCode: null,
    warningCode: null,
    copies: 1,
    printedSides: 2,
    physicalSheets: 2,
    sheetsProduced: null,
    createdAt: "2030-01-01T00:00:00.000Z",
    deadlineAt: "2030-01-01T00:10:00.000Z",
    completedAt: null,
    ...overrides
  };
}

function at(stage: PrintStage, enteredAt = 0): StagePresentation {
  return { stage, enteredAt };
}

describe("stageCeiling", () => {
  it("keeps a job nobody has claimed yet on the first stage", () => {
    expect(stageCeiling(null)).toBe("PREPARING_FILES");
    expect(stageCeiling(job({ status: "QUEUED" }))).toBe("PREPARING_FILES");
    expect(stageCeiling(job({ status: "DISPATCHED" }))).toBe("PREPARING_FILES");
  });

  it("opens the device stages only once the work reached the device", () => {
    expect(stageCeiling(job({ status: "PRINTING" }))).toBe("PRINTING");
  });

  /**
   * The honesty boundary. A completion the device would not confirm is not a
   * completion, so it must not unlock the stage that celebrates one.
   */
  it("unlocks the finishing stage only for a confirmed completion", () => {
    expect(stageCeiling(job({ status: "COMPLETED", resultConfidence: "CONFIRMED" }))).toBe(
      "FINISHING"
    );
    expect(stageCeiling(job({ status: "COMPLETED", resultConfidence: "UNCONFIRMED" }))).not.toBe(
      "FINISHING"
    );
    expect(stageCeiling(job({ status: "RECOVERY_REQUIRED" }))).not.toBe("FINISHING");
    expect(stageCeiling(job({ status: "FAILED" }))).not.toBe("FINISHING");
  });
});

describe("nextPresentation", () => {
  /**
   * The regression this exists to prevent: fetching two small documents takes
   * about 300ms, and a stage nobody can finish reading is worse than no stage.
   */
  it("holds a stage that would otherwise flash past", () => {
    const current = at("PREPARING_FILES", 0);
    const early = nextPresentation(current, "PRINTING", false, 300);

    expect(early.stage).toBe("PREPARING_FILES");
    expect(early.enteredAt).toBe(0);

    const late = nextPresentation(current, "PRINTING", false, MINIMUM_HOLD_MS.PREPARING_FILES);
    expect(late.stage).toBe("CHECKING_PRINTER");
    expect(late.enteredAt).toBe(MINIMUM_HOLD_MS.PREPARING_FILES);
  });

  it("advances one stage at a time and never skips ahead to the ceiling", () => {
    let current = at("PREPARING_FILES", 0);
    const seen: PrintStage[] = [current.stage];
    let now = 0;

    for (let step = 0; step < 10 && current.stage !== "PRINTING"; step += 1) {
      now += MINIMUM_HOLD_MS[current.stage];
      const next = nextPresentation(current, "PRINTING", false, now);
      if (next.stage !== current.stage) seen.push(next.stage);
      current = next;
    }

    expect(seen).toEqual([
      "PREPARING_FILES",
      "CHECKING_PRINTER",
      "PREPARING_PAGES",
      "SENDING_PAGES",
      "PRINTING"
    ]);
  });

  /**
   * The whole guarantee of the presentation layer: no amount of elapsed time
   * carries the screen past what the control plane has actually reported.
   */
  it("never runs past the ceiling however long it waits", () => {
    let current = at("PREPARING_FILES", 0);
    for (let step = 0; step < 50; step += 1) {
      current = nextPresentation(current, "PREPARING_FILES", false, step * 10_000);
    }
    expect(current.stage).toBe("PREPARING_FILES");
  });

  it("parks on the last device stage while the job is still open", () => {
    let current = at("PRINTING", 0);
    for (let step = 1; step <= 30; step += 1) {
      current = nextPresentation(current, "PRINTING", false, step * 5_000);
    }
    expect(current.stage).toBe("PRINTING");
    // Parked, not restarted: the entry time must not creep forward or the
    // animation would retrigger on every poll.
    expect(current.enteredAt).toBe(0);
  });

  it("never moves backwards when a later poll reports an earlier state", () => {
    const current = at("SENDING_PAGES", 0);
    const next = nextPresentation(current, "PREPARING_FILES", false, 60_000);
    expect(next.stage).toBe("SENDING_PAGES");
  });

  /**
   * Once the real answer exists there is nothing left to narrate. Without this
   * a job that finished in two seconds would still be walked through six
   * stages, holding the customer on a screen describing work that is over.
   */
  it("collapses straight to the answer once the job has settled", () => {
    const next = nextPresentation(at("PREPARING_FILES", 0), "FINISHING", true, 500);
    expect(next.stage).toBe("FINISHING");
    expect(next.enteredAt).toBe(500);
  });

  it("does not empty the bar when a job settles into something other than success", () => {
    // A recovery or a failure has no ceiling above the first stage, so
    // collapsing to it would run a nearly full bar back to nothing in the
    // instant before the screen changes. The customer's pages may well be in
    // the tray; the machine must not appear to take them back.
    const current = at("PRINTING", 0);
    expect(nextPresentation(current, "PREPARING_FILES", true, 500).stage).toBe("PRINTING");
  });

  it("holds the finishing stage long enough to be read", () => {
    const current = at("FINISHING", 0);
    expect(MINIMUM_HOLD_MS.FINISHING).toBeGreaterThanOrEqual(500);
    // Nothing follows it, so it stays put whatever the clock does.
    expect(nextPresentation(current, "FINISHING", true, 10_000).stage).toBe("FINISHING");
  });
});

describe("stage ordering", () => {
  it("matches the order the device host actually works in", () => {
    expect(PRINT_STAGES).toEqual([
      "PREPARING_FILES",
      "CHECKING_PRINTER",
      "PREPARING_PAGES",
      "SENDING_PAGES",
      "PRINTING",
      "FINISHING"
    ]);
    expect(stageIndex("PREPARING_FILES")).toBeLessThan(stageIndex("PRINTING"));
    expect(stageIndex("PRINTING")).toBeLessThan(stageIndex("FINISHING"));
  });

  /**
   * The walk from the first device stage to the last must stay shorter than the
   * device phase it narrates, or the screen would arrive at "printing" before
   * the printer does.
   */
  it("reaches the printing stage sooner than the device typically finishes", () => {
    const walk =
      MINIMUM_HOLD_MS.CHECKING_PRINTER +
      MINIMUM_HOLD_MS.PREPARING_PAGES +
      MINIMUM_HOLD_MS.SENDING_PAGES;
    // Measured on the reference printer: ~10s between the agent handing over
    // the work and the spooler retiring the last job.
    expect(walk).toBeLessThan(10_000);
  });
});

/**
 * The bar, which is allowed to guess and never allowed to promise.
 *
 * Two rules carry the whole thing. It may narrate the backend's preparation
 * freely, because being wrong about work nobody can see costs nothing. It may
 * not fill, because a full bar is a claim that paper came out — the exact claim
 * the telemetry work exists to stop the kiosk making on its own authority.
 */
describe("how full the bar is", () => {
  const at = (stage: Parameters<typeof printProgressFraction>[0]["stage"], stageElapsedMs: number) =>
    printProgressFraction({ stage, stageElapsedMs, printedSides: 2, confirmed: false });

  it("starts empty and moves straight away", () => {
    expect(at("PREPARING_FILES", 0)).toBe(0);
    expect(at("PREPARING_FILES", 300)).toBeGreaterThan(0);
  });

  it("never runs backwards across the preparation stages", () => {
    let previous = 0;
    for (const stage of ["PREPARING_FILES", "CHECKING_PRINTER", "PREPARING_PAGES", "SENDING_PAGES"] as const) {
      for (const elapsed of [0, 500, 1_500, 30_000]) {
        const fraction = at(stage, elapsed);
        expect(fraction).toBeGreaterThanOrEqual(previous);
        previous = fraction;
      }
    }
  });

  it("stops at the preparation ceiling however long the backend takes", () => {
    // A stage that overruns its estimate keeps easing towards its own end and
    // can never borrow from the segment that belongs to paper.
    expect(at("SENDING_PAGES", 10 * 60_000)).toBeLessThanOrEqual(PREPARATION_CEILING);
    expect(at("SENDING_PAGES", 10 * 60_000)).toBeCloseTo(PREPARATION_CEILING, 2);
  });

  it("hands over to the physical segment at that ceiling", () => {
    expect(at("PRINTING", 0)).toBeCloseTo(PREPARATION_CEILING, 5);
  });

  it("paces the physical segment by the job's own size", () => {
    // Half a page in, a one-page job is further along than a fifty-page job.
    const short = printProgressFraction({
      stage: "PRINTING",
      stageElapsedMs: MS_PER_SIDE,
      printedSides: 1,
      confirmed: false
    });
    const long = printProgressFraction({
      stage: "PRINTING",
      stageElapsedMs: MS_PER_SIDE,
      printedSides: 50,
      confirmed: false
    });
    expect(short).toBeGreaterThan(long);
  });

  it("never reaches the end before the device has confirmed anything", () => {
    // The rule the whole telemetry effort exists for, in one assertion: no
    // amount of waiting fills this bar. It parks visibly short of the end and
    // stays there — an hour in, the easing has flattened onto the ceiling, and
    // the ceiling is still not a completion.
    for (const elapsed of [MS_PER_SIDE, 60_000, 60 * 60_000]) {
      const fraction = printProgressFraction({
        stage: "PRINTING",
        stageElapsedMs: elapsed,
        printedSides: 2,
        confirmed: false
      });
      expect(fraction).toBeLessThanOrEqual(PRINTING_CEILING);
      expect(fraction).toBeLessThan(1);
    }
  });

  it("keeps moving while it waits, rather than sitting dead", () => {
    const early = at("PRINTING", 30_000);
    const later = at("PRINTING", 90_000);
    expect(later).toBeGreaterThan(early);
  });

  it("fills only on a confirmed completion", () => {
    expect(
      printProgressFraction({
        stage: "PRINTING",
        stageElapsedMs: 0,
        printedSides: 2,
        confirmed: true
      })
    ).toBe(1);
    expect(at("FINISHING", 0)).toBe(1);
  });

  it("paces a job that never said how big it was", () => {
    // A missing side count is a pacing question, not a correctness one: the bar
    // still moves and still cannot fill.
    const fraction = printProgressFraction({
      stage: "PRINTING",
      stageElapsedMs: 5_000,
      printedSides: null,
      confirmed: false
    });
    expect(fraction).toBeGreaterThan(PREPARATION_CEILING);
    expect(fraction).toBeLessThan(PRINTING_CEILING);
  });

  it("stays inside 0 and 1 for anything it is handed", () => {
    for (const elapsed of [-5_000, 0, 1, 10 ** 9]) {
      for (const sides of [null, 0, -3, 1, 10_000]) {
        const fraction = printProgressFraction({
          stage: "PRINTING",
          stageElapsedMs: elapsed,
          printedSides: sides,
          confirmed: false
        });
        expect(fraction).toBeGreaterThanOrEqual(0);
        expect(fraction).toBeLessThanOrEqual(1);
      }
    }
  });
});
