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

export const PRINT_MANIFEST_VERSION = 2;

/**
 * The shape of a capability snapshot. Version 3 added the host-side options —
 * orientation and scaling — that a device never sees because the print-ready
 * PDF already carries them.
 */
export const PRINT_CAPABILITY_SNAPSHOT_VERSION = 3;

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
  /**
   * How the device prints this document. Copies, sides and orientation belong
   * to a document, so one job may print two double-sided copies of one and a
   * single landscape copy of the next.
   */
  copies: number;
  duplex: string;
  orientation: string;
  printedSides: number;
  physicalSheets: number;
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
  paperSize: string;
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
  /**
   * What the device saw, for the record the control plane keeps.
   *
   * It never changes the outcome — the state, the confidence and the sheet
   * count above are the whole decision. This is the evidence behind it, so an
   * operator can tell a printer that jammed from one that was never asked,
   * without standing in front of the kiosk.
   */
  deviceDiagnostics?: PrintDeviceDiagnostics | null;
}

/** Operational detail only: identifiers, raw device status, counts, timings. */
export interface PrintDeviceDiagnostics {
  queueName?: string | null;
  /** Where the device refused, when it named a stage. */
  stage?: string | null;
  /** How long the device host process took to reach its first instruction. */
  processStartMs?: number | null;
  /** How many times the device was polled before it answered. */
  pollCount?: number | null;
  /** Elapsed milliseconds at each device-side phase. */
  phaseMs?: Record<string, number>;
  jobs?: PrintDeviceJobEvidence[];
  /** How long the device was watched after its queue emptied. */
  settleMs?: number | null;
  /** The distinct printer-level status words seen during that watch. */
  printerStatuses?: string[];
  /** The fault that watch attributed to this operation, if any. */
  deviceFaultCode?: string | null;
}

export interface PrintDeviceJobEvidence {
  position: number;
  /** The operating system's own job identifier for this document. */
  jobId: number;
  present: boolean;
  observed: boolean;
  completed: boolean;
  faulted: boolean;
  status: string | null;
  pagesPrinted: number;
  expectedPages: number;
  expectedSheets: number;
}

export type PrinterHealthState = "READY" | "WARNING" | "OFFLINE";

export interface PrinterHealth {
  state: PrinterHealthState;
  warningCode: PrintWarningCode | null;
}

/**
 * What the control plane may offer a customer.
 *
 * Paper, duplex, colour and copy count are the device's answer. Orientation and
 * scaling are not: the document processor bakes both into the print-ready PDF
 * long before a queue sees it, so they are reported as host capabilities rather
 * than asked of hardware that would only be guessed at.
 */
export interface PrinterCapabilitiesSnapshot {
  version: number;
  paperSizes: readonly string[];
  duplexModes: readonly string[];
  colorModes: readonly string[];
  orientations: readonly string[];
  scalingModes: readonly string[];
  maxCopies: number;
}

export type PrinterQueueState = "READY" | "PAUSED" | "OFFLINE" | "ERROR";

/**
 * One print queue as the operating system's print subsystem describes it.
 *
 * This is discovery output, not an approval. A kiosk prints only to a queue an
 * operator certified by name; everything else here exists so that refusal can be
 * explained and so a swapped printer is visible rather than silent.
 */
export interface PrinterQueueDescriptor {
  queueName: string;
  /** Where the queue sends work — a device URI, never a customer string. */
  deviceUri: string | null;
  driverName: string | null;
  portName: string | null;
  state: PrinterQueueState;
  /** True when the operating system treats this queue as the machine default. */
  isDefault: boolean;
  /** True when the queue is published to other machines on the network. */
  shared: boolean;
}

/**
 * The identity of the device an adapter is bound to.
 *
 * A pilot fleet is certified per printer, driver and firmware combination, so
 * these fields are the record that says which combination actually printed. All
 * of them are nullable: a device that will not say is reported as not saying.
 */
export interface PrinterBinding {
  adapter: string;
  queueName: string | null;
  /** A stable device identity, so a swapped printer is detectable. */
  deviceId: string | null;
  /** The physical printer, not the driver that happens to drive it. */
  makeAndModel: string | null;
  driverName: string | null;
  /** The installed driver's version, which used to be reported as firmware. */
  driverVersion: string | null;
  firmware: string | null;
}

export interface PrinterAdapter {
  readonly name: string;
  /** Which device this adapter speaks to, for the fleet and certification record. */
  describe(): Promise<PrinterBinding>;
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
  /**
   * Discard whatever the device still holds for operations last touched before
   * a cutoff, and answer how many were discarded.
   *
   * Output a device retains is a copy of the customer's document, and it must
   * not outlive the job that produced it. It cannot be discarded at the end of
   * a print either: it is the evidence `getOperationStatus` reads so that a
   * redelivered operation is resolved rather than printed a second time. The
   * cutoff is what separates the two — past the job's own deadline nothing can
   * be redelivered, so nothing is still needed.
   *
   * A device with no retrievable storage answers `0`.
   */
  discardOutputsBefore(cutoff: Date): Promise<number>;
}

/**
 * Enumerating the print queues this machine can see.
 *
 * It is deliberately separate from `PrinterAdapter`: discovery is what an
 * operator uses to certify a queue, and an adapter already bound to one has no
 * reason to be able to look at the others.
 */
export interface PrinterQueueDiscovery {
  listQueues(): Promise<readonly PrinterQueueDescriptor[]>;
}

export function supportsQueueDiscovery(
  adapter: PrinterAdapter
): adapter is PrinterAdapter & PrinterQueueDiscovery {
  return typeof (adapter as Partial<PrinterQueueDiscovery>).listQueues === "function";
}

export type PrinterAdapterErrorCode =
  | "PRINTER_OFFLINE"
  | "OPERATION_ID_INVALID"
  | "MANIFEST_INVALID"
  | "ARTIFACT_UNAVAILABLE"
  | "OUTPUT_WRITE_FAILED"
  | "SUBMISSION_UNCONFIRMED"
  /** The queue named in configuration is not one this machine offers. */
  | "QUEUE_NOT_FOUND"
  /** The queue exists but no operator certified it for this kiosk. */
  | "QUEUE_NOT_APPROVED"
  /** The device host or the device itself could not be reached at all. */
  | "DEVICE_UNREACHABLE"
  | "DEVICE_ERROR";

export class PrinterAdapterError extends Error {
  public constructor(
    public readonly code: PrinterAdapterErrorCode,
    /**
     * Whether the device may already have started printing. A caller must not
     * resubmit an operation whose submission is ambiguous.
     */
    public readonly submissionAmbiguous = false,
    /**
     * Where the device refused, when it said. A fixed identifier from the
     * device side — never a path or anything a customer supplied — kept so a
     * generic device error can still be told apart from a queue that was busy
     * or a document that would not render.
     */
    public readonly deviceStage: string | null = null
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
