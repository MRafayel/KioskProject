import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { assertSubmittable, operationStatus as status } from "../submission.js";
import {
  canonicalPrintManifestJson,
  PRINT_CAPABILITY_SNAPSHOT_VERSION,
  PrinterAdapterError,
  type PrintOperationStatus,
  type PrinterAdapter,
  type PrinterBinding,
  type PrinterCapabilitiesSnapshot,
  type PrinterHealth,
  type PrinterQueueDescriptor,
  type PrinterQueueDiscovery,
  type PrintSubmission
} from "../types.js";

/** The deterministic device behaviours Phase 8 must be able to exercise. */
export type MockPrinterScenario =
  | "SUCCESS"
  | "WARNING"
  | "OFFLINE"
  | "PAPER_JAM"
  | "OUT_OF_PAPER"
  | "CANCELED"
  | "TIMEOUT"
  | "UNKNOWN_AFTER_SUBMIT";

export const MOCK_PRINTER_SCENARIOS: readonly MockPrinterScenario[] = [
  "SUCCESS",
  "WARNING",
  "OFFLINE",
  "PAPER_JAM",
  "OUT_OF_PAPER",
  "CANCELED",
  "TIMEOUT",
  "UNKNOWN_AFTER_SUBMIT"
];

/** Written before anything is printed: evidence that the device accepted work. */
const SUBMISSION_MARKER = "operation.json";
/** Written last: the only evidence that the operation ran to the end. */
const COMPLETION_MARKER = "manifest.json";
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface MockPrinterAdapterOptions {
  /** Where simulated output is written. Created on demand, never traversed. */
  outputDirectory: string;
  /**
   * Which deterministic behaviour to produce when a submission does not name
   * one. Nothing a customer sends can reach this.
   */
  defaultScenario?: MockPrinterScenario;
  now?: () => Date;
}

/**
 * A printer that writes files instead of moving paper.
 *
 * It is deliberately honest about what it can and cannot prove. A live
 * submission that reaches the end reports `CONFIRMED`; anything reconstructed
 * afterwards from the output directory reports `UNCONFIRMED`, because a
 * directory listing cannot tell anyone whether a sheet actually emerged. That
 * distinction is what stops an interrupted job from being reprinted or from
 * being silently called a success.
 *
 * Customer filenames never appear here. Every path is derived from the
 * operation identifier and the document's position in the job.
 */
export class MockPrinterAdapter implements PrinterAdapter, PrinterQueueDiscovery {
  public readonly name = "MOCK";
  public static readonly QUEUE_NAME = "Mock Kiosk Printer";
  private readonly outputDirectory: string;

  public constructor(private readonly options: MockPrinterAdapterOptions) {
    this.outputDirectory = resolve(options.outputDirectory);
  }

  /**
   * The simulated machine offers exactly one queue, and it is not shared. The
   * development path therefore goes through the same approval check a Windows
   * kiosk does rather than around it.
   */
  public listQueues(): Promise<readonly PrinterQueueDescriptor[]> {
    const offline = this.options.defaultScenario === "OFFLINE";
    return Promise.resolve([
      {
        queueName: MockPrinterAdapter.QUEUE_NAME,
        deviceUri: "file:" + this.outputDirectory,
        driverName: "Mock Printer Driver",
        portName: "MOCK:",
        state: offline ? "OFFLINE" : "READY",
        isDefault: true,
        shared: false
      }
    ]);
  }

  public describe(): Promise<PrinterBinding> {
    return Promise.resolve({
      adapter: this.name,
      queueName: MockPrinterAdapter.QUEUE_NAME,
      deviceId: "mock-printer",
      makeAndModel: "Printing Kiosk Mock Printer",
      driverName: "Mock Printer Driver",
      firmware: "0.0.0"
    });
  }

  public getHealth(): Promise<PrinterHealth> {
    const scenario = this.options.defaultScenario ?? "SUCCESS";
    if (scenario === "OFFLINE") {
      return Promise.resolve({ state: "OFFLINE", warningCode: null });
    }
    if (scenario === "WARNING") {
      return Promise.resolve({ state: "WARNING", warningCode: "TONER_LOW" });
    }
    return Promise.resolve({ state: "READY", warningCode: null });
  }

  public getCapabilities(): Promise<PrinterCapabilitiesSnapshot> {
    return Promise.resolve({
      version: PRINT_CAPABILITY_SNAPSHOT_VERSION,
      paperSizes: ["A4"],
      duplexModes: ["SIMPLEX", "LONG_EDGE"],
      colorModes: ["MONOCHROME"],
      orientations: ["AUTO"],
      scalingModes: ["FIT"],
      maxCopies: 10
    });
  }

  public async submit(submission: PrintSubmission): Promise<PrintOperationStatus> {
    const directory = this.operationDirectory(submission.operationId);
    assertSubmittable(submission);
    const behaviour = resolveScenario(submission.deviceScenario, this.options.defaultScenario);

    // An offline device refuses before any evidence exists, so the caller can
    // safely conclude that nothing was printed.
    if (behaviour === "OFFLINE") throw new PrinterAdapterError("PRINTER_OFFLINE");

    await this.recordSubmission(directory, submission);

    if (behaviour === "OUT_OF_PAPER") {
      return status(submission.operationId, {
        state: "FAILED",
        confidence: "CONFIRMED",
        failureCode: "OUT_OF_PAPER",
        sheetsProduced: 0
      });
    }
    if (behaviour === "CANCELED") {
      return status(submission.operationId, {
        state: "CANCELED",
        confidence: "UNCONFIRMED",
        failureCode: "CANCELED_AT_DEVICE",
        sheetsProduced: 0
      });
    }
    if (behaviour === "TIMEOUT") {
      // The device stopped answering. It may or may not have printed, and
      // saying so plainly is the only safe response.
      return status(submission.operationId, {
        state: "UNKNOWN",
        confidence: "UNCONFIRMED",
        failureCode: "DEVICE_TIMEOUT",
        sheetsProduced: null
      });
    }

    if (behaviour === "PAPER_JAM") {
      await this.writeArtifacts(directory, submission, 1);
      return status(submission.operationId, {
        state: "FAILED",
        confidence: "UNCONFIRMED",
        failureCode: "PAPER_JAM",
        sheetsProduced: Math.floor(submission.manifest.physicalSheets / 2)
      });
    }

    await this.writeArtifacts(directory, submission, submission.artifacts.length);
    await this.writeJson(
      resolve(directory, COMPLETION_MARKER),
      canonicalPrintManifestJson(submission.manifest)
    );

    if (behaviour === "UNKNOWN_AFTER_SUBMIT") {
      // The output exists but the acknowledgement was lost. This is exactly the
      // case a blind retry would turn into two printed jobs.
      throw new PrinterAdapterError("SUBMISSION_UNCONFIRMED", true);
    }

    return status(submission.operationId, {
      state: "COMPLETED",
      confidence: "CONFIRMED",
      failureCode: null,
      warningCode: behaviour === "WARNING" ? "TONER_LOW" : null,
      sheetsProduced: submission.manifest.physicalSheets
    });
  }

  public async getOperationStatus(operationId: string): Promise<PrintOperationStatus> {
    const directory = this.operationDirectory(operationId);
    if (await exists(resolve(directory, COMPLETION_MARKER))) {
      // The operation ran to the end, but nobody watched the paper tray. The
      // caller keeps that ambiguity rather than recording a clean success.
      return status(operationId, {
        state: "COMPLETED",
        confidence: "UNCONFIRMED",
        failureCode: null,
        sheetsProduced: null
      });
    }
    if (await exists(resolve(directory, SUBMISSION_MARKER))) {
      return status(operationId, {
        state: "UNKNOWN",
        confidence: "UNCONFIRMED",
        failureCode: "SUBMISSION_UNCONFIRMED",
        sheetsProduced: null
      });
    }
    return status(operationId, {
      state: "NOT_SUBMITTED",
      confidence: "CONFIRMED",
      failureCode: null,
      sheetsProduced: 0
    });
  }

  public async cancel(operationId: string): Promise<PrintOperationStatus> {
    const current = await this.getOperationStatus(operationId);
    if (current.state === "COMPLETED") return current;
    if (current.state === "NOT_SUBMITTED") {
      return status(operationId, {
        state: "CANCELED",
        confidence: "CONFIRMED",
        failureCode: "CANCELED_BEFORE_SUBMIT",
        sheetsProduced: 0
      });
    }
    // Work already at the device may have put ink on paper before the stop
    // took effect, so cancellation cannot claim otherwise.
    return status(operationId, {
      state: "CANCELED",
      confidence: "UNCONFIRMED",
      failureCode: "CANCELED_AT_DEVICE",
      sheetsProduced: null
    });
  }

  /** Remove one operation's simulated output. Used by local cleanup only. */
  public async discardOutput(operationId: string): Promise<void> {
    await rm(this.operationDirectory(operationId), { recursive: true, force: true });
  }

  /**
   * Remove the output of every operation untouched since a cutoff.
   *
   * This sweeps by age rather than wholesale, for the same reason the agent's
   * spool does: one kiosk may be served by more than one agent instance sharing
   * this directory, and clearing it outright would take a peer's evidence out
   * from under a print it is still resolving. Nothing a live job owns can be
   * older than the job's own deadline.
   *
   * An entry that is not a well-formed operation directory is left alone. This
   * directory is private and only ever written here, so an unexpected name is
   * something to leave for a person rather than delete on a guess.
   */
  public async discardOutputsBefore(cutoff: Date): Promise<number> {
    let entries;
    try {
      entries = await readdir(this.outputDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) {
        // Nothing has been printed on this machine yet.
        return 0;
      }
      // Permission and I/O failures must reach the runner so retention emits a
      // warning instead of silently claiming there was nothing to remove.
      throw error;
    }

    let discarded = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !OPERATION_ID_PATTERN.test(entry.name)) continue;
      const path = this.childPath(this.outputDirectory, entry.name);
      const stats = await stat(path).catch((error: unknown) => {
        if (isMissingPath(error)) return null;
        throw error;
      });
      if (!stats || stats.mtimeMs >= cutoff.getTime()) continue;
      await rm(path, { recursive: true, force: true });
      discarded += 1;
    }
    return discarded;
  }

  private async recordSubmission(directory: string, submission: PrintSubmission): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.writeJson(
      resolve(directory, SUBMISSION_MARKER),
      JSON.stringify({
        operationId: submission.operationId,
        printJobId: submission.manifest.printJobId,
        submittedAt: (this.options.now?.() ?? new Date()).toISOString(),
        documents: submission.artifacts.length
      })
    );
  }

  private async writeArtifacts(
    directory: string,
    submission: PrintSubmission,
    count: number
  ): Promise<void> {
    for (const artifact of submission.artifacts.slice(0, count)) {
      // The output name is derived from the document's position in the job.
      // A customer filename never reaches a path.
      const destination = this.childPath(
        directory,
        `document-${padPosition(artifact.position)}.pdf`
      );
      try {
        await copyFile(artifact.path, destination);
      } catch {
        throw new PrinterAdapterError("OUTPUT_WRITE_FAILED", true);
      }
    }
  }

  private async writeJson(path: string, contents: string): Promise<void> {
    try {
      await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
    } catch {
      throw new PrinterAdapterError("OUTPUT_WRITE_FAILED", true);
    }
  }

  private operationDirectory(operationId: string): string {
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      throw new PrinterAdapterError("OPERATION_ID_INVALID");
    }
    return this.childPath(this.outputDirectory, operationId);
  }

  /**
   * Join a validated segment and prove the result stayed inside its parent.
   * The pattern checks above already exclude separators, but the containment
   * check is what makes that a property of the filesystem rather than of a
   * regular expression somebody may later relax.
   */
  private childPath(parent: string, segment: string): string {
    const candidate = resolve(parent, segment);
    if (!candidate.startsWith(parent + sep) || candidate === parent) {
      throw new PrinterAdapterError("OPERATION_ID_INVALID");
    }
    return candidate;
  }
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT");
}

/**
 * A scenario name is only honoured when it is one this adapter knows. An
 * unrecognised value falls back to the configured behaviour rather than
 * becoming an error a customer could trigger.
 */
function resolveScenario(
  requested: string | null | undefined,
  fallback: MockPrinterScenario | undefined
): MockPrinterScenario {
  const known = MOCK_PRINTER_SCENARIOS.find((scenario) => scenario === requested);
  return known ?? fallback ?? "SUCCESS";
}

function padPosition(position: number): string {
  return String(position).padStart(3, "0");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
