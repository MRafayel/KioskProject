import { describe, expect, it } from "vitest";

import type { MarkerCounter, PrinterFault, PrinterTelemetrySnapshot } from "@printing-kiosk/printer-telemetry";
import type { PrintOperationStatus } from "@printing-kiosk/printer-adapters";

import {
  expectedMarkerDelta,
  observeMarkerCompletion,
  readMarkerEvidence,
  type MarkerEvidence
} from "./marker.js";
import { applyMarkerEvidence } from "./runner.js";

/**
 * The two failures this exists to prevent, both of them real:
 *
 *   19 Aug, job `01a01aef` — 1 sheet loaded, 2 requested, reported COMPLETED /
 *   CONFIRMED with `sheetsProduced: 2`.
 *   20 Aug, job `01a01e75` — 4 sheets loaded, 5 requested, same again.
 *
 * Both printed short and both were sold as successes, because every signal in
 * the system described the queue rather than the paper. The counter is the first
 * one that describes paper, and the rule for using it has exactly one direction:
 * it may take a success away and may never grant one.
 */

const JOB = { printedSides: 5, physicalSheets: 5 };

describe("what the counter should climb by", () => {
  it("counts sides when the device counts impressions", () => {
    // The certified Canon: 97 → 98 → 99 for a two-page duplex job that pulled a
    // single sheet. Sides, not sheets.
    expect(expectedMarkerDelta("IMPRESSIONS", { printedSides: 2, physicalSheets: 1 })).toBe(2);
  });

  it("counts sheets when the device counts sheets", () => {
    expect(expectedMarkerDelta("SHEETS", { printedSides: 2, physicalSheets: 1 })).toBe(1);
  });

  it("refuses to guess when the device will not say", () => {
    // Picking either column here would be wrong half the time, and wrong in the
    // direction that sends healthy duplex jobs to an operator.
    expect(expectedMarkerDelta("UNKNOWN", { printedSides: 2, physicalSheets: 1 })).toBeNull();
  });
});

describe("comparing two readings", () => {
  it("finds the 20 August shortfall", () => {
    // Four sheets in the tray, five requested. The counter is the only thing in
    // the system that ever noticed.
    expect(evidence(100, 104)).toEqual({
      kind: "SHORTFALL",
      unit: "IMPRESSIONS",
      before: 100,
      after: 104,
      expected: 5,
      observed: 4
    });
  });

  it("accepts a job whose pages all came out", () => {
    expect(evidence(100, 105)).toEqual({ kind: "SUFFICIENT", observed: 5, expected: 5 });
  });

  it("does not treat a job that printed nothing as merely unknown", () => {
    expect(readMarkerEvidence({ before: marker(100), after: marker(100), job: JOB }).kind).toBe(
      "SHORTFALL"
    );
  });

  it("says nothing when no baseline was taken", () => {
    expect(readMarkerEvidence({ before: null, after: marker(105), job: JOB })).toEqual({
      kind: "UNKNOWN",
      reason: "NO_BASELINE"
    });
  });

  it("says nothing when the counter could not be read afterwards", () => {
    expect(readMarkerEvidence({ before: marker(100), after: null, job: JOB })).toEqual({
      kind: "UNKNOWN",
      reason: "NO_FINAL_READING"
    });
  });

  it("says nothing when the counter went backwards", () => {
    // A reset, a rollover, or a different machine answering. Reading it as a
    // shortfall would send a healthy print to recovery because a technician
    // cleared a counter.
    expect(readMarkerEvidence({ before: marker(100), after: marker(4), job: JOB })).toEqual({
      kind: "UNKNOWN",
      reason: "COUNTER_REGRESSED"
    });
  });

  it("says nothing when the device changed what it counts", () => {
    expect(
      readMarkerEvidence({
        before: marker(100, "IMPRESSIONS"),
        after: marker(105, "SHEETS"),
        job: JOB
      })
    ).toEqual({ kind: "UNKNOWN", reason: "UNIT_CHANGED" });
  });

  it("says nothing when the unit is unmappable", () => {
    expect(
      readMarkerEvidence({
        before: marker(100, "UNKNOWN"),
        after: marker(105, "UNKNOWN"),
        job: JOB
      })
    ).toEqual({ kind: "UNKNOWN", reason: "UNIT_UNKNOWN" });
  });

  it("does not complain when something else printed too", () => {
    // Excess cannot be attributed to this job either — but since nothing may be
    // promoted on the strength of it, over-counting is harmless where
    // under-counting is not.
    expect(evidence(100, 112).kind).toBe("SUFFICIENT");
  });
});

describe("waiting for the engine rather than the spooler", () => {
  it("does not call a job short while the paper is still coming", async () => {
    // The whole reason this loop exists. Windows retires the spool in about a
    // second; a five-page job is still fifteen seconds from finishing. Comparing
    // at the moment the host returns would fail every large healthy print.
    const result = await observe([100, 101, 102, 103, 104, 105]);
    expect(result).toEqual({ kind: "SUFFICIENT", observed: 5, expected: 5 });
  });

  it("concludes short once the engine stops advancing", async () => {
    const result = await observe([100, 101, 102, 103, 103, 103, 103]);
    expect(result.kind).toBe("SHORTFALL");
    expect(result).toMatchObject({ observed: 3, expected: 5 });
  });

  it("stops waiting immediately on an explicit fault", async () => {
    // Paper ran out four sheets in. There is no reason to keep asking a printer
    // that has told us why it stopped.
    let reads = 0;
    const result = await observeMarkerCompletion({
      before: marker(100),
      job: JOB,
      read: () => {
        reads += 1;
        return Promise.resolve(snapshot(104, ["NO_PAPER"]));
      },
      deadlineAt: 100_000,
      now: () => 0,
      delay: () => Promise.resolve(),
      pollIntervalMs: 1,
      stillReadsBeforeStopped: 3
    });
    expect(result.kind).toBe("SHORTFALL");
    expect(reads).toBe(1);
  });

  it("still needs the counter to agree before a fault means a shortfall", async () => {
    // `noPaper` on the last sheet of a job that printed in full is normal on
    // this hardware. The counter, not the fault, decides.
    const result = await observeMarkerCompletion({
      before: marker(100),
      job: JOB,
      read: () => Promise.resolve(snapshot(105, ["NO_PAPER"])),
      deadlineAt: 100_000,
      now: () => 0,
      delay: () => Promise.resolve(),
      pollIntervalMs: 1,
      stillReadsBeforeStopped: 3
    });
    expect(result.kind).toBe("SUFFICIENT");
  });

  it("never turns silence into a shortfall", async () => {
    // Unplugging the telemetry cable must not fail every job on the machine.
    let clock = 0;
    const result = await observeMarkerCompletion({
      before: marker(100),
      job: JOB,
      read: () => Promise.resolve(null),
      deadlineAt: 50,
      now: () => clock,
      delay: () => {
        clock += 10;
        return Promise.resolve();
      },
      pollIntervalMs: 10,
      stillReadsBeforeStopped: 3
    });
    expect(result).toEqual({ kind: "UNKNOWN", reason: "NO_FINAL_READING" });
  });

  it("leaves a still-printing job alone at the deadline", async () => {
    // Out of time with the counter still climbing is not evidence of failure.
    // Calling it one would send healthy large prints to an operator.
    let clock = 0;
    let count = 100;
    const result = await observeMarkerCompletion({
      before: marker(100),
      job: { printedSides: 500, physicalSheets: 500 },
      read: () => Promise.resolve(snapshot((count += 1))),
      deadlineAt: 50,
      now: () => clock,
      delay: () => {
        clock += 10;
        return Promise.resolve();
      },
      pollIntervalMs: 10,
      stillReadsBeforeStopped: 3
    });
    expect(result).toEqual({ kind: "UNKNOWN", reason: "STILL_ADVANCING" });
  });

  it("does not poll at all without a baseline", async () => {
    let reads = 0;
    const result = await observeMarkerCompletion({
      before: null,
      job: JOB,
      read: () => {
        reads += 1;
        return Promise.resolve(snapshot(105));
      },
      deadlineAt: 100_000,
      now: () => 0,
      delay: () => Promise.resolve(),
      pollIntervalMs: 1,
      stillReadsBeforeStopped: 3
    });
    expect(result).toEqual({ kind: "UNKNOWN", reason: "NO_BASELINE" });
    expect(reads).toBe(0);
  });
});

describe("what the evidence is allowed to do to a result", () => {
  const claimed: PrintOperationStatus = {
    operationId: "op",
    state: "COMPLETED",
    confidence: "CONFIRMED",
    failureCode: null,
    warningCode: null,
    sheetsProduced: 5
  };

  it("takes the success away on a shortfall", () => {
    const result = applyMarkerEvidence(claimed, evidence(100, 104));
    // COMPLETED with an unconfirmed result is the existing route to
    // RECOVERY_REQUIRED with no refund owed. The pages may be in the tray; a
    // person has to look.
    expect(result.state).toBe("COMPLETED");
    expect(result.confidence).toBe("UNCONFIRMED");
    expect(result.sheetsProduced).toBeNull();
    expect(result.deviceDiagnostics?.marker).toMatchObject({
      outcome: "SHORTFALL",
      expected: 5,
      observed: 4
    });
  });

  it("leaves a healthy result exactly as it was", () => {
    const result = applyMarkerEvidence(claimed, evidence(100, 105));
    expect(result.state).toBe("COMPLETED");
    expect(result.confidence).toBe("CONFIRMED");
    expect(result.sheetsProduced).toBe(5);
  });

  it("cannot promote a result the device would not confirm", () => {
    // The one direction that must not exist. A printer whose counter looks
    // healthy has not thereby proved a customer's pages came out, and if this
    // could say otherwise, a compromised device could manufacture a success.
    const unconfirmed: PrintOperationStatus = {
      ...claimed,
      confidence: "UNCONFIRMED",
      sheetsProduced: null
    };
    const result = applyMarkerEvidence(unconfirmed, evidence(100, 105));
    expect(result.confidence).toBe("UNCONFIRMED");
    expect(result.sheetsProduced).toBeNull();
  });

  it("cannot rescue a failure", () => {
    const failed: PrintOperationStatus = {
      ...claimed,
      state: "FAILED",
      confidence: "CONFIRMED",
      failureCode: "DEVICE_ERROR",
      sheetsProduced: 0
    };
    const result = applyMarkerEvidence(failed, evidence(100, 105));
    expect(result.state).toBe("FAILED");
    expect(result.failureCode).toBe("DEVICE_ERROR");
  });

  it("records an inconclusive measurement without acting on it", () => {
    // A printer whose counter went backwards is worth an operator's attention
    // even though it changes nothing about this job.
    const result = applyMarkerEvidence(claimed, { kind: "UNKNOWN", reason: "COUNTER_REGRESSED" });
    expect(result.deviceDiagnostics?.marker).toEqual({
      outcome: "UNKNOWN",
      reason: "COUNTER_REGRESSED"
    });
    expect(result.confidence).toBe("CONFIRMED");
  });

  it("says nothing at all on a kiosk with no telemetry link", () => {
    // Otherwise every job on every non-telemetry deployment carries an empty
    // finding, and the readings that mean something get buried.
    const result = applyMarkerEvidence(claimed, { kind: "UNKNOWN", reason: "NO_BASELINE" });
    expect(result).toBe(claimed);
  });

  it("keeps diagnostics the device host already gathered", () => {
    const withStage: PrintOperationStatus = {
      ...claimed,
      deviceDiagnostics: { queueName: "CanonLBP361_UFR_II", pollCount: 4 }
    };
    const result = applyMarkerEvidence(withStage, evidence(100, 104));
    expect(result.deviceDiagnostics).toMatchObject({
      queueName: "CanonLBP361_UFR_II",
      pollCount: 4,
      marker: { outcome: "SHORTFALL" }
    });
  });
});

function marker(lifeCount: number, unit: MarkerCounter["unit"] = "IMPRESSIONS"): MarkerCounter {
  return { lifeCount, unit };
}

function evidence(before: number, after: number): MarkerEvidence {
  return readMarkerEvidence({ before: marker(before), after: marker(after), job: JOB });
}

function snapshot(lifeCount: number, faults: PrinterFault[] = []): PrinterTelemetrySnapshot {
  return {
    readAt: new Date("2026-08-22T10:00:00.000Z"),
    serialNumber: "SERIAL",
    engine: "PRINTING",
    faults,
    marker: marker(lifeCount),
    inputs: null,
    supplies: null
  };
}

/** Drives the watch over a fixed sequence of counter readings. */
async function observe(counts: number[]): Promise<MarkerEvidence> {
  let index = 0;
  let clock = 0;
  return observeMarkerCompletion({
    before: marker(counts[0] ?? 0),
    job: JOB,
    read: () => Promise.resolve(snapshot(counts[Math.min(index, counts.length - 1)] ?? 0)),
    deadlineAt: 10_000,
    now: () => clock,
    delay: () => {
      index += 1;
      clock += 10;
      return Promise.resolve();
    },
    pollIntervalMs: 10,
    stillReadsBeforeStopped: 3
  });
}
