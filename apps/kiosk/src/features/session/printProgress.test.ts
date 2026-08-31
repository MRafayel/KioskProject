import { describe, expect, it } from "vitest";

import type { PrintJobSnapshot } from "@printing-kiosk/contracts";

import {
  MINIMUM_HOLD_MS,
  nextPresentation,
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

  it("does not rewind the message when a job settles without success", () => {
    // A recovery or failure has no ceiling above the first stage. Keep the
    // current message stable during the route transition instead of briefly
    // narrating an earlier part of the pipeline.
    const current = at("PRINTING", 0);
    expect(nextPresentation(current, "PREPARING_FILES", true, 500).stage).toBe("PRINTING");
  });

  it("parks on the finishing stage rather than holding it", () => {
    // It is a ceiling, not a step somebody reads: the screen leaves for the
    // receipt as soon as the device confirms the print, so nothing waits here.
    const current = at("FINISHING", 0);
    expect(MINIMUM_HOLD_MS.FINISHING).toBe(0);
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
