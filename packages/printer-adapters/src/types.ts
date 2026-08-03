/**
 * The boundary between print orchestration and a printing device.
 *
 * Everything above this line — the job ledger, the session state machine, the
 * refund policy — is device-agnostic. An adapter is handed an operation
 * identifier, an immutable manifest, and local artifact paths, and it answers
 * with a state and how confident it is in that state. It never sees a customer
 * filename, a session token, or an amount of money.
 *
 * Two rules shape this contract:
 *
 * 1. Acceptance by a queue is not proof that paper left the printer. Every
 *    answer therefore carries a `confidence`, and `UNCONFIRMED` is a real
 *    answer that must never be rounded up to success.
 * 2. A submission whose outcome is unknown must never be blindly resubmitted.
 *    `getOperationStatus` exists so a caller that crashed mid-submission can
 *    ask the device what it already knows instead of printing twice.
 */

export const PRINT_MANIFEST_VERSION = 1;

/** A validated document as the print job froze it. */
export interface PrintJobDocument {
  documentId: string;
  position: number;
  /** sha256 of the normalized print-ready PDF. */
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  pageRanges: number[][];
  selectedPages: number;
}

/**
 * The immutable description of one print job. It is written once, hashed, and
 * never edited: the device, the ledger, and any later audit all read the same
 * bytes. Nothing here identifies a customer or their filenames.
 */
export interface PrintJobManifest {
  manifestVersion: number;
  printJobId: string;
  sessionId: string;
  settingsRevision: number;
  /** The Phase 6 settings manifest hash the quote and payment were bound to. */
  settingsManifestHash: string;
  quoteId: string;
  paymentId: string;
  copies: number;
  duplex: string;
  paperSize: string;
  orientation: string;
  scaling: string;
  collate: boolean;
  colorMode: string;
  selectedPages: number;
  printedSides: number;
  physicalSheets: number;
  documents: PrintJobDocument[];
}

/** One spooled artifact, already verified against the manifest by the caller. */
export interface PrintOperationArtifact {
  documentId: string;
  position: number;
  /** An absolute local path the adapter may read. Never a customer filename. */
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface PrintSubmission {
  /** Unique per attempt. The adapter uses it as its own operation key. */
  operationId: string;
  manifest: PrintJobManifest;
  artifacts: PrintOperationArtifact[];
  /**
   * A deterministic behaviour a simulated device may honour, so failure paths
   * can be exercised without hardware. A real adapter ignores it, and the
   * control plane only ever sets it where configuration has explicitly enabled
   * the development scenarios outside production.
   */
  deviceScenario?: string | null;
}

export type PrintOperationState =
  /** The device holds no evidence that this operation ever reached it. */
  | "NOT_SUBMITTED"
  | "SUBMITTED"
  | "PRINTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  /** The device cannot say. The caller must not guess on its behalf. */
  | "UNKNOWN";

/**
 * How much the device is willing to promise. `CONFIRMED` means the device
 * knows what happened to the paper; `UNCONFIRMED` means it only knows what it
 * accepted.
 */
export type PrintResultConfidence = "CONFIRMED" | "UNCONFIRMED";

export type PrintFailureCode =
  | "PRINTER_OFFLINE"
  | "PAPER_JAM"
  | "OUT_OF_PAPER"
  | "COVER_OPEN"
  | "DEVICE_TIMEOUT"
  | "CANCELED_AT_DEVICE"
  | "CANCELED_BEFORE_SUBMIT"
  | "SUBMISSION_UNCONFIRMED"
  | "OUTPUT_WRITE_FAILED"
  | "ARTIFACT_UNAVAILABLE"
  | "DEVICE_ERROR";

export type PrintWarningCode = "TONER_LOW" | "PAPER_LOW" | "OUTPUT_TRAY_FULL";

export interface PrintOperationStatus {
  operationId: string;
  state: PrintOperationState;
  confidence: PrintResultConfidence;
  failureCode: PrintFailureCode | null;
  warningCode: PrintWarningCode | null;
  /** Physical sheets the device believes it produced, when it can say. */
  sheetsProduced: number | null;
}

export type PrinterHealthState = "READY" | "WARNING" | "OFFLINE";

export interface PrinterHealth {
  state: PrinterHealthState;
  warningCode: PrintWarningCode | null;
}

export interface PrinterCapabilitiesSnapshot {
  version: number;
  paperSizes: readonly string[];
  duplexModes: readonly string[];
  colorModes: readonly string[];
  maxCopies: number;
}

export interface PrinterAdapter {
  readonly name: string;
  getHealth(): Promise<PrinterHealth>;
  getCapabilities(): Promise<PrinterCapabilitiesSnapshot>;
  /**
   * Hand one operation to the device. Called at most once per operation
   * identifier by a caller that has already recorded its intent to submit.
   */
  submit(submission: PrintSubmission): Promise<PrintOperationStatus>;
  /**
   * What the device knows about an operation now. This is the only safe way to
   * resolve an interrupted submission: it reports `UNKNOWN` rather than
   * inventing an outcome, and the caller keeps the ambiguity.
   */
  getOperationStatus(operationId: string): Promise<PrintOperationStatus>;
  cancel(operationId: string): Promise<PrintOperationStatus>;
}

export type PrinterAdapterErrorCode =
  | "PRINTER_OFFLINE"
  | "OPERATION_ID_INVALID"
  | "MANIFEST_INVALID"
  | "ARTIFACT_UNAVAILABLE"
  | "OUTPUT_WRITE_FAILED"
  | "SUBMISSION_UNCONFIRMED"
  | "DEVICE_ERROR";

export class PrinterAdapterError extends Error {
  public constructor(
    public readonly code: PrinterAdapterErrorCode,
    /**
     * Whether the device may already have started printing. A caller must not
     * resubmit an operation whose submission is ambiguous.
     */
    public readonly submissionAmbiguous = false
  ) {
    super(code);
    this.name = "PrinterAdapterError";
  }
}

/**
 * Key-sorted JSON so the manifest hash does not depend on how the object was
 * built. The control plane hashes this string and the device stores it.
 */
export function canonicalPrintManifestJson(manifest: PrintJobManifest): string {
  return canonicalJson(manifest);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new PrinterAdapterError("MANIFEST_INVALID");
}
