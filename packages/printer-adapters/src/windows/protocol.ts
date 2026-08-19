import {
  PrinterAdapterError,
  type PrinterAdapterErrorCode,
  type PrinterQueueDescriptor,
  type PrinterQueueState,
  type PrintFailureCode,
  type PrintOperationState,
  type PrintResultConfidence,
  type PrinterHealth,
  type PrintDeviceDiagnostics,
  type PrintDeviceJobEvidence,
  type PrintWarningCode
} from "../types.js";
import type { DeviceCapabilityDeclaration } from "../capabilities.js";

/**
 * The contract between this package and a Windows device host.
 *
 * Printing a PDF through the Windows spooler is not something a Node process
 * can do honestly. It needs the print subsystem's own APIs — enumerating
 * queues, reading a PrintTicket, rendering into the spooler, reading a job's
 * state back — and reaching them through a shell verb would give up exactly the
 * thing this phase exists to establish: an operating-system job identifier that
 * can still be asked about after a crash.
 *
 * So the platform work lives in a small host process, and this file is the only
 * thing that crosses between them: newline-delimited JSON, one request, one
 * response, no state carried in the channel. The host is treated as untrusted
 * for the same reason the device is — it is a separate program with its own
 * version and its own bugs — so nothing it returns is used before it is read
 * through the parsers below, and no string it produces is passed on unvalidated.
 *
 * The full protocol, including what the host must persist, is written down in
 * `docs/hardware/windows-device-host.md`.
 */

export const DEVICE_HOST_PROTOCOL_VERSION = 1;

export interface DeviceHostDocumentRequest {
  position: number;
  /** An absolute local path to a print-ready PDF. Never a customer filename. */
  path: string;
  copies: number;
  /** One-based inclusive ranges from the immutable paid manifest. */
  pageRanges: readonly (readonly [number, number])[];
  /** `one-sided` or `two-sided-long-edge`. */
  sides: string;
  /** The name the operating-system job is created under. */
  jobName: string;
}

/**
 * A printer/driver combination an operator certified.
 *
 * Sent on every request rather than compiled into the host, because which
 * printer models a fleet has approved is a deployment decision that changes
 * without the device host changing. The host refuses a queue matching none of
 * them; it never falls back to another queue.
 */
export interface DevicePrinterProfile {
  driverName: string;
  portPattern: string;
}

export type DeviceHostRequest = (
  | { protocol: number; op: "list-queues" }
  | { protocol: number; op: "describe"; queue: string }
  | { protocol: number; op: "capabilities"; queue: string }
  | { protocol: number; op: "health"; queue: string }
  | {
      protocol: number;
      op: "submit";
      queue: string;
      operationId: string;
      media: string;
      colorMode: string;
      documents: readonly DeviceHostDocumentRequest[];
      /**
       * How long the host may watch the queue before answering `PRINTING`.
       *
       * It is sent rather than assumed because the caller is the side that
       * knows when it will stop listening. A host waiting longer than that is
       * killed mid-answer, and a submission killed mid-answer is ambiguous —
       * which is the expensive kind of wrong. The host clamps it to its own
       * bounds; this is a budget, not an instruction.
       */
      waitSeconds: number;
    }
  | { protocol: number; op: "status"; queue: string; operationId: string }
  | { protocol: number; op: "cancel"; queue: string; operationId: string }
  | { protocol: number; op: "find"; queue: string; operationId: string }
  | { protocol: number; op: "discard"; before: string }
) & {
  /** Absent leaves the host on its built-in reference profile. */
  profiles?: readonly DevicePrinterProfile[];
};

/** How the host reports what it did with one operation. */
export interface DeviceHostOperationReport {
  state: PrintOperationState;
  confidence: PrintResultConfidence;
  failureCode: PrintFailureCode | null;
  warningCode: PrintWarningCode | null;
  sheetsProduced: number | null;
  diagnostics: PrintDeviceDiagnostics | null;
}

export interface DeviceHostBinding {
  deviceId: string | null;
  makeAndModel: string | null;
  driverName: string | null;
  driverVersion: string | null;
  firmware: string | null;
}

/**
 * Read the host's answer.
 *
 * A response is either `{ ok: true, result }` or `{ ok: false, error }`, and a
 * failure carries whether the submission it refers to may already have reached
 * the device. That flag defaults to true: a host that does not say must be
 * assumed to have left work at a printer, because the alternative is a
 * duplicate print.
 */
export function readHostResult(value: unknown): unknown {
  const response = asRecord(value);
  if (response.ok === true) return response.result;

  const error = asRecord(response.error);
  const code = typeof error.code === "string" ? error.code : "DEVICE_ERROR";
  const ambiguous = error.ambiguous === false ? false : true;
  // The stage the host refused at. A fixed internal identifier, kept because a
  // bare DEVICE_ERROR says nothing about whether a submission failed at the
  // queue, the renderer or the driver.
  throw new PrinterAdapterError(hostErrorCode(code), ambiguous, boundedString(error.stage));
}

/**
 * Which codes a device host is allowed to name.
 *
 * Written as a total map rather than a list so the compiler enforces both
 * directions. A code the host may send that the adapter does not define is
 * already impossible; this closes the other side — adding a member to
 * `PrinterAdapterErrorCode` without deciding whether a host may send it stops
 * being a silent omission that would quietly degrade to `DEVICE_ERROR`.
 */
const HOST_ERROR_CODE_MAP: Record<PrinterAdapterErrorCode, true> = {
  PRINTER_OFFLINE: true,
  OPERATION_ID_INVALID: true,
  MANIFEST_INVALID: true,
  ARTIFACT_UNAVAILABLE: true,
  OUTPUT_WRITE_FAILED: true,
  SUBMISSION_UNCONFIRMED: true,
  QUEUE_NOT_FOUND: true,
  QUEUE_NOT_APPROVED: true,
  DEVICE_UNREACHABLE: true,
  DEVICE_ERROR: true
};

const HOST_ERROR_CODES = new Set(
  Object.keys(HOST_ERROR_CODE_MAP) as PrinterAdapterErrorCode[]
);

/** A code from a newer host is a device error, never a silently ignored one. */
function hostErrorCode(code: string): PrinterAdapterErrorCode {
  return HOST_ERROR_CODES.has(code as PrinterAdapterErrorCode)
    ? (code as PrinterAdapterErrorCode)
    : "DEVICE_ERROR";
}

const QUEUE_STATES = new Set<PrinterQueueState>(["READY", "PAUSED", "OFFLINE", "ERROR"]);
const OPERATION_STATES = new Set<PrintOperationState>([
  "NOT_SUBMITTED",
  "SUBMITTED",
  "PRINTING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "UNKNOWN"
]);
const FAILURE_CODES = new Set<PrintFailureCode>([
  "PRINTER_OFFLINE",
  "PAPER_JAM",
  "OUT_OF_PAPER",
  "COVER_OPEN",
  "DEVICE_TIMEOUT",
  "CANCELED_AT_DEVICE",
  "CANCELED_BEFORE_SUBMIT",
  "SUBMISSION_UNCONFIRMED",
  "OUTPUT_WRITE_FAILED",
  "ARTIFACT_UNAVAILABLE",
  "DEVICE_ERROR"
]);
const WARNING_CODES = new Set<PrintWarningCode>(["TONER_LOW", "PAPER_LOW", "OUTPUT_TRAY_FULL"]);

/** A queue name longer than this is a driver bug or an attempt at something. */
const MAX_QUEUE_NAME_LENGTH = 220;
const MAX_QUEUES = 128;

export function readQueueList(value: unknown): PrinterQueueDescriptor[] {
  if (!Array.isArray(value)) throw new PrinterAdapterError("DEVICE_ERROR");
  const queues: PrinterQueueDescriptor[] = [];
  for (const entry of value.slice(0, MAX_QUEUES)) {
    const queue = asRecord(entry);
    const queueName = typeof queue.queueName === "string" ? queue.queueName.trim() : "";
    if (queueName.length === 0 || queueName.length > MAX_QUEUE_NAME_LENGTH) continue;
    const state = queue.state;
    queues.push({
      queueName,
      deviceUri: boundedString(queue.deviceUri),
      driverName: boundedString(queue.driverName),
      portName: boundedString(queue.portName),
      state:
        typeof state === "string" && QUEUE_STATES.has(state as PrinterQueueState)
          ? (state as PrinterQueueState)
          : // A state this side does not recognise is not a ready printer.
            "ERROR",
      isDefault: queue.isDefault === true,
      // A queue that does not say whether it is shared is treated as shared, so
      // the approval policy has to be told explicitly to accept it.
      shared: queue.shared !== false
    });
  }
  return queues;
}

export function readCapabilityDeclaration(value: unknown): DeviceCapabilityDeclaration {
  const declaration = asRecord(value);
  return {
    mediaSizes: stringList(declaration.mediaSizes),
    sides: stringList(declaration.sides),
    colorModes: stringList(declaration.colorModes),
    maxCopies:
      typeof declaration.maxCopies === "number" && Number.isSafeInteger(declaration.maxCopies)
        ? declaration.maxCopies
        : null,
    duplexSupported: declaration.duplexSupported === true
  };
}

export function readHostHealth(value: unknown): PrinterHealth {
  const health = asRecord(value);
  const warning = typeof health.warningCode === "string" ? health.warningCode : null;
  const warningCode =
    warning && WARNING_CODES.has(warning as PrintWarningCode)
      ? (warning as PrintWarningCode)
      : null;

  if (health.state === "READY")
    return warningCode ? { state: "WARNING", warningCode } : { state: "READY", warningCode: null };
  if (health.state === "WARNING") return { state: "WARNING", warningCode };
  // Anything else — `OFFLINE`, a paused queue, a value from a newer host — is
  // a printer a customer must not be sold a job on.
  return { state: "OFFLINE", warningCode: null };
}

export function readHostBinding(value: unknown): DeviceHostBinding {
  const binding = asRecord(value);
  return {
    deviceId: boundedString(binding.deviceId),
    makeAndModel: boundedString(binding.makeAndModel),
    driverName: boundedString(binding.driverName),
    driverVersion: boundedString(binding.driverVersion),
    firmware: boundedString(binding.firmware)
  };
}

/**
 * A host is a separate program with its own version and its own bugs, so
 * nothing it reports here is taken on trust: every field is re-typed and every
 * collection is capped before it can reach the control plane.
 */
const MAX_DIAGNOSTIC_JOBS = 16;
const MAX_DIAGNOSTIC_PHASES = 40;
const MAX_PHASE_NAME_LENGTH = 64;

export function readDiagnostics(value: unknown): PrintDeviceDiagnostics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const diagnostics = value as Record<string, unknown>;

  const phaseMs: Record<string, number> = {};
  const phases = diagnostics.phaseMs;
  if (phases && typeof phases === "object" && !Array.isArray(phases)) {
    for (const [name, elapsed] of Object.entries(phases).slice(0, MAX_DIAGNOSTIC_PHASES)) {
      if (typeof elapsed === "number" && Number.isSafeInteger(elapsed) && elapsed >= 0) {
        phaseMs[name.slice(0, MAX_PHASE_NAME_LENGTH)] = elapsed;
      }
    }
  }

  const jobs: PrintDeviceJobEvidence[] = [];
  if (Array.isArray(diagnostics.jobs)) {
    for (const entry of diagnostics.jobs.slice(0, MAX_DIAGNOSTIC_JOBS)) {
      const job = asRecord(entry);
      jobs.push({
        position: boundedCount(job.position) ?? 0,
        jobId: boundedCount(job.jobId) ?? 0,
        present: job.present === true,
        observed: job.observed === true,
        completed: job.completed === true,
        faulted: job.faulted === true,
        // The raw Windows status, verbatim, so one nobody has seen is legible.
        status: boundedString(job.status),
        pagesPrinted: boundedCount(job.pagesPrinted) ?? 0,
        expectedPages: boundedCount(job.expectedPages) ?? 0,
        expectedSheets: boundedCount(job.expectedSheets) ?? 0
      });
    }
  }

  return {
    queueName: boundedString(diagnostics.queue),
    pollCount: boundedCount(diagnostics.pollCount),
    processStartMs: boundedCount(diagnostics.processStartMs),
    phaseMs,
    jobs,
    stage: boundedString(diagnostics.stage)
  };
}

export function readOperationReport(value: unknown): DeviceHostOperationReport {
  const report = asRecord(value);
  const state = report.state;
  if (typeof state !== "string" || !OPERATION_STATES.has(state as PrintOperationState)) {
    // A host that cannot name a state has not told anybody anything, and the
    // only safe reading of that is that the outcome is unknown.
    throw new PrinterAdapterError("DEVICE_ERROR", true);
  }

  const failureCode =
    typeof report.failureCode === "string" &&
    FAILURE_CODES.has(report.failureCode as PrintFailureCode)
      ? (report.failureCode as PrintFailureCode)
      : null;
  const warningCode =
    typeof report.warningCode === "string" &&
    WARNING_CODES.has(report.warningCode as PrintWarningCode)
      ? (report.warningCode as PrintWarningCode)
      : null;
  const sheets = report.sheetsProduced;

  return {
    state: state as PrintOperationState,
    confidence: report.confidence === "CONFIRMED" ? "CONFIRMED" : "UNCONFIRMED",
    failureCode,
    warningCode,
    sheetsProduced:
      typeof sheets === "number" && Number.isSafeInteger(sheets) && sheets >= 0 ? sheets : null,
    diagnostics: readDiagnostics(report.diagnostics)
  };
}

/** One queue entry the host matched to an operation by its job name. */
export interface DeviceHostFoundJob {
  position: number;
  jobId: number;
  status: string | null;
  faulted: boolean;
}

/**
 * Queue entries still carrying an operation's name.
 *
 * Bounded like every other host answer: this is a separate program's account of
 * what it saw, and a malformed one may narrow what the caller believes but must
 * never be able to widen it.
 */
export function readFoundJobs(value: unknown): DeviceHostFoundJob[] {
  const result = asRecord(value);
  if (!Array.isArray(result.jobs)) return [];
  const jobs: DeviceHostFoundJob[] = [];
  for (const entry of result.jobs.slice(0, MAX_DIAGNOSTIC_JOBS)) {
    const job = asRecord(entry);
    jobs.push({
      position: boundedCount(job.position) ?? 0,
      jobId: boundedCount(job.jobId) ?? 0,
      status: boundedString(job.status),
      faulted: job.faulted === true
    });
  }
  return jobs;
}

export function readDiscardCount(value: unknown): number {
  const result = asRecord(value);
  const discarded = result.discarded;
  return typeof discarded === "number" && Number.isSafeInteger(discarded) && discarded >= 0
    ? discarded
    : 0;
}

const MAX_FIELD_LENGTH = 400;

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_FIELD_LENGTH);
}

/** A count from the host. Negative or nonsensical values become unknown. */
function boundedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, 256)
    .map((entry) => entry.slice(0, MAX_FIELD_LENGTH));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
