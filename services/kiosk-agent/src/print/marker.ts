import type { MarkerCounter, PrinterFault, PrinterTelemetrySnapshot } from "@printing-kiosk/printer-telemetry";

/**
 * The printer's own page counter, as evidence about a job that just ran.
 *
 * This is the only signal in the system that comes from the print engine rather
 * than from the queue that feeds it. Windows retires a spooled job when the data
 * has been handed over — flat at ~1.3 s whether the job is one page or fifty —
 * so every existing completion signal describes a successful *hand-off* and
 * calls it a successful print. `prtMarkerLifeCount` counts marks actually put on
 * paper, which is a different claim entirely.
 *
 * It is used in exactly one direction. A counter that fell short of what the job
 * needed removes a success claim; a counter that reached the expected figure
 * adds nothing at all. That asymmetry is the whole safety property, and it is
 * not a matter of taste:
 *
 *   - under-reporting sends a paid job to operator recovery, where a human looks
 *     at the machine. Costly, recoverable, and never silent.
 *   - over-reporting tells a customer their documents printed when they did not.
 *     Nothing downstream can detect that, and nobody is told.
 *
 * A device that lies — or is impersonated, or simply resets its counter — can
 * therefore cause unnecessary recovery and can never manufacture a success.
 */

/** How many marks the device counts per unit. Decided by `prtMarkerCounterUnit`. */
export type MarkerUnit = MarkerCounter["unit"];

export interface MarkerExpectation {
  /** One per side marked. A duplex sheet is two. */
  readonly printedSides: number;
  /** One per physical piece of paper pulled from a tray. */
  readonly physicalSheets: number;
}

export type MarkerEvidence =
  /**
   * The engine marked fewer pages than the job needed. The only verdict here
   * that changes a result, and it only ever makes it worse.
   */
  | {
      readonly kind: "SHORTFALL";
      readonly unit: MarkerUnit;
      readonly before: number;
      readonly after: number;
      readonly expected: number;
      readonly observed: number;
    }
  /**
   * The counter moved by at least what the job needed. Deliberately not called
   * "success": it is the absence of contrary evidence, nothing more, and no
   * caller may promote it into a confirmation.
   */
  | { readonly kind: "SUFFICIENT"; readonly observed: number; readonly expected: number }
  /**
   * No usable comparison. A timeout, a device that would not report its counter,
   * a unit nobody can map, a counter that went backwards. Every one of these
   * means the result stands exactly as the device host described it.
   */
  | { readonly kind: "UNKNOWN"; readonly reason: MarkerUnknownReason };

export type MarkerUnknownReason =
  /** No baseline was taken, so there is nothing to compare against. */
  | "NO_BASELINE"
  /** The counter could not be read after the job. */
  | "NO_FINAL_READING"
  /** The device reported a unit that cannot be mapped onto a job's page counts. */
  | "UNIT_UNKNOWN"
  /** The unit changed between the two readings, so they do not describe one scale. */
  | "UNIT_CHANGED"
  /** The counter went backwards: a reset, a rollover, or a different device. */
  | "COUNTER_REGRESSED"
  /** The engine was still marking when the job's deadline arrived. */
  | "STILL_ADVANCING"
  /** The result claimed no success, so there was nothing for the counter to take away. */
  | "NOT_A_SUCCESS_CLAIM";

/**
 * What the counter should climb by if every page comes out.
 *
 * The unit decides which of the job's two counts applies, and the difference is
 * duplex. A two-page duplex job is one sheet and two sides — the certified Canon
 * counts it as **two**, which is what proved the unit is impressions there:
 * `97 → 98 → 99` across one physical sheet, with the tray level moving once.
 *
 * Reading the wrong column would be quietly wrong rather than loudly wrong: on a
 * simplex job the two counts are equal and every test would pass, and the error
 * would only appear the first time a customer chose double-sided — as a healthy
 * job sent to recovery for a shortfall that was really a unit mismatch.
 */
export function expectedMarkerDelta(unit: MarkerUnit, job: MarkerExpectation): number | null {
  if (unit === "IMPRESSIONS") return job.printedSides;
  if (unit === "SHEETS") return job.physicalSheets;
  return null;
}

/**
 * Compare two readings of the counter around one job.
 *
 * Every failure to compare returns `UNKNOWN`, and `UNKNOWN` changes nothing. The
 * rule is that this function may only ever remove confidence, so the safe answer
 * whenever the evidence is not clean is to say nothing at all.
 */
export function readMarkerEvidence(input: {
  readonly before: MarkerCounter | null;
  readonly after: MarkerCounter | null;
  readonly job: MarkerExpectation;
}): MarkerEvidence {
  const { before, after } = input;
  if (!before) return { kind: "UNKNOWN", reason: "NO_BASELINE" };
  if (!after) return { kind: "UNKNOWN", reason: "NO_FINAL_READING" };
  // A device that changed its mind about what it counts has not given us two
  // readings on one scale, and subtracting them would produce a number that
  // means nothing.
  if (before.unit !== after.unit) return { kind: "UNKNOWN", reason: "UNIT_CHANGED" };

  const expected = expectedMarkerDelta(before.unit, input.job);
  if (expected === null) return { kind: "UNKNOWN", reason: "UNIT_UNKNOWN" };

  const observed = after.lifeCount - before.lifeCount;
  // Backwards means a reset, a rollover, or a different machine answering. None
  // of them is evidence about this job, and treating a negative delta as a
  // shortfall would send a healthy print to recovery because a technician
  // cleared a counter.
  if (observed < 0) return { kind: "UNKNOWN", reason: "COUNTER_REGRESSED" };

  if (observed < expected) {
    return {
      kind: "SHORTFALL",
      unit: before.unit,
      before: before.lifeCount,
      after: after.lifeCount,
      expected,
      observed
    };
  }

  // At or above expected. Above can happen when something else printed on the
  // same device — which a USB-only kiosk with every network print protocol
  // disabled should never see, and which is accepted here rather than guarded
  // against: excess cannot be attributed to this job either way, and since
  // nothing may be promoted on the strength of it, the worst it can do is mask
  // a shortfall that a foreign job happened to make up for.
  return { kind: "SUFFICIENT", observed, expected };
}

/**
 * Faults that mean the engine has stopped for a reason, so waiting longer for
 * the counter to climb is waiting for something that will not happen.
 *
 * Used only to stop waiting early. A fault never decides the outcome on its own
 * — the counter does — because a printer can assert `noPaper` at the very end of
 * a job whose pages all came out, and on the certified Canon it routinely does.
 */
const ENGINE_STOPPED_FAULTS: ReadonlySet<PrinterFault> = new Set([
  "NO_PAPER",
  "JAMMED",
  "DOOR_OPEN",
  "NO_TONER",
  "OFFLINE",
  "SERVICE_REQUESTED",
  "INPUT_TRAY_MISSING",
  "OUTPUT_TRAY_MISSING",
  "MARKER_SUPPLY_MISSING",
  "OUTPUT_FULL"
]);

export function engineHasStopped(snapshot: PrinterTelemetrySnapshot): boolean {
  return snapshot.faults?.some((fault) => ENGINE_STOPPED_FAULTS.has(fault)) ?? false;
}

/** A compact phrase for the local log. Numbers about paper, nothing about a customer. */
export function describeMarkerEvidence(evidence: MarkerEvidence): string {
  if (evidence.kind === "UNKNOWN") return `unknown:${evidence.reason}`;
  if (evidence.kind === "SUFFICIENT") return `sufficient:${evidence.observed}/${evidence.expected}`;
  return `shortfall:${evidence.observed}/${evidence.expected}`;
}

export interface MarkerObservation {
  /** The counter as it stood before the device was given the work. */
  readonly before: MarkerCounter | null;
  readonly job: MarkerExpectation;
  /** One direct reading. Returns null when the printer could not be reached. */
  readonly read: () => Promise<PrinterTelemetrySnapshot | null>;
  /** Epoch milliseconds past which the job is no longer worth waiting for. */
  readonly deadlineAt: number;
  readonly now: () => number;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs: number;
  /**
   * How many consecutive readings may show no movement before the engine is
   * taken to have stopped. More than one, because a printer pauses mid-job to
   * pull a sheet and a single flat reading is not a stalled engine.
   */
  readonly stillReadsBeforeStopped: number;
  /**
   * The same allowance, before the job's *first* impression lands.
   *
   * It has to be larger, and the reason is mechanical: the print host returns
   * when the spooler retires the job — when the data arrived — which is a second
   * or so after submission and well before any ink reaches paper. A printer
   * waking from sleep can take considerably longer than that to produce its
   * first page, and during the whole of that window the counter reads exactly
   * what it read before the job started. Judging a job on the gap before it has
   * begun is judging it on nothing.
   */
  readonly startupReadsBeforeStopped: number;
}

/**
 * Watch the counter until the job is accounted for, the engine stops, or time
 * runs out.
 *
 * This exists because the moment the print host returns is not the moment the
 * paper stops. Retirement measures the hand-off; on the certified hardware a
 * fifty-page job would report "completed" a minute or more before the last sheet
 * lands. Comparing the counter at that instant would call every large healthy
 * job a shortfall, so the counter is followed until it settles instead.
 *
 * Silence is never evidence. A reading that cannot be taken does not count
 * towards the engine having stopped, and a watch that never managed a single
 * reading returns `UNKNOWN` rather than a shortfall — otherwise unplugging the
 * telemetry cable would fail every job on the machine.
 */
export async function observeMarkerCompletion(input: MarkerObservation): Promise<MarkerEvidence> {
  const { before, job } = input;
  if (!before) return { kind: "UNKNOWN", reason: "NO_BASELINE" };

  const expected = expectedMarkerDelta(before.unit, job);
  if (expected === null) return { kind: "UNKNOWN", reason: "UNIT_UNKNOWN" };

  let latest: MarkerCounter | null = null;
  let highest = before.lifeCount;
  let stillReads = 0;

  while (input.now() < input.deadlineAt) {
    const snapshot = await input.read();
    const marker = snapshot?.marker ?? null;

    if (marker) {
      latest = marker;
      const evidence = readMarkerEvidence({ before, after: marker, job });
      // Enough marks, or a comparison that cannot be trusted. Either way there
      // is nothing further to learn by waiting.
      if (evidence.kind !== "SHORTFALL") return evidence;

      if (marker.lifeCount > highest) {
        // Still working through the job. Whatever it has produced so far says
        // nothing about what it will have produced when it stops.
        highest = marker.lifeCount;
        stillReads = 0;
      } else {
        stillReads += 1;
      }

      // Whether this job has put anything on paper yet. Everything below turns
      // on it, because a flat counter means two completely different things
      // either side of the first impression: not started, or stopped.
      const started = highest > before.lifeCount;

      // A fault may end the watch early, but only once the engine has actually
      // produced something and then stopped.
      //
      // Not before. An empty tray asserts `noPaper` the instant its last sheet
      // is pulled — while that sheet is still in the paper path, still being
      // marked, and on a duplex job still waiting for its second side. Trusting
      // the fault at that moment is what turned a two-page duplex job that
      // printed perfectly into a shortfall of `observed: 0`: the first reading
      // landed before any ink, saw an empty tray, and concluded the engine had
      // stopped when it had not yet begun.
      if (started && stillReads > 0 && snapshot && engineHasStopped(snapshot)) return evidence;
      if (stillReads >= (started ? input.stillReadsBeforeStopped : input.startupReadsBeforeStopped)) {
        return evidence;
      }
    }

    await input.delay(input.pollIntervalMs);
  }

  // Out of time. If the engine was still marking, that is genuinely unknown
  // rather than short — a slow job is not a failed one, and calling it one would
  // send healthy large prints to an operator.
  if (!latest) return { kind: "UNKNOWN", reason: "NO_FINAL_READING" };
  return { kind: "UNKNOWN", reason: "STILL_ADVANCING" };
}
