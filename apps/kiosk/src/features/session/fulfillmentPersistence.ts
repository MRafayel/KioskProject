import {
  paymentSnapshotSchema,
  printJobSnapshotSchema,
  type PaymentSnapshot,
  type PrintJobSnapshot
} from "@printing-kiosk/contracts";

import {
  initialPrototypeState,
  type PrototypeFile,
  type PrintFailureDisposition,
  type PrototypeOutcome,
  type PrototypeState
} from "./model.js";

const STORAGE_KEY = "printing-kiosk.fulfillment-state.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PUBLIC_ID_PATTERN = /^ps_[A-Za-z0-9_-]{16,64}$/u;
const OUTCOMES = new Set<PrototypeOutcome>([
  "SUCCESS",
  "PAYMENT_DECLINED",
  "PRINTER_ERROR",
  "PRINTER_UNCONFIRMED"
]);
const FILE_KINDS = new Set(["PDF", "JPEG", "PNG"]);

interface StoredFulfillment {
  version: 1;
  session: {
    id: string;
    publicId: string;
    version: number;
    expiresAt: string;
    hardExpiresAt: string;
  };
  files: PrototypeFile[];
  payment: PaymentSnapshot;
  printJob: PrintJobSnapshot | null;
  printFailureDisposition: PrintFailureDisposition | null;
  outcome: PrototypeOutcome;
}

/**
 * Keep a paid/in-flight fulfillment resumable across a browser refresh.
 *
 * The QR URL is intentionally absent because it contains the upload bearer
 * token, and filenames are replaced with null. The stored payment and print
 * snapshots and recovery disposition contain only the same closed, non-card
 * fields already used by the kiosk. PostgreSQL remains authoritative: restored
 * identifiers are used only to read or idempotently resume the owning kiosk's
 * workflow.
 */
export function persistFulfillmentState(state: PrototypeState): void {
  if (typeof window === "undefined") return;
  const payment = state.payment.payment;
  if (!state.session || !payment || payment.sessionId !== state.session.id) {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return;
  }

  const stored: StoredFulfillment = {
    version: 1,
    session: {
      id: state.session.id,
      publicId: state.session.publicId,
      version: state.session.version,
      expiresAt: state.session.expiresAt,
      hardExpiresAt: state.session.hardExpiresAt
    },
    files: state.files
      .filter((file) => file.status === "READY")
      .map((file) => ({ ...file, name: null })),
    payment,
    printJob: state.print.job,
    printFailureDisposition: state.print.failureDisposition,
    outcome: state.outcome
  };
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

export function restoreFulfillmentState(): PrototypeState | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const candidate = JSON.parse(raw) as unknown;
    const stored = parseStoredFulfillment(candidate);
    if (!stored) throw new Error("FULFILLMENT_STATE_INVALID");

    return {
      ...initialPrototypeState,
      session: { ...stored.session, uploadUrl: "" },
      files: stored.files,
      payment: { payment: stored.payment, attempt: 1, errorCode: null },
      print: {
        job: stored.printJob,
        errorCode: null,
        failureDisposition: stored.printFailureDisposition
      },
      outcome: stored.outcome
    };
  } catch {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/** Remove a paid-workflow snapshot synchronously when its terminal screen ends. */
export function clearFulfillmentState(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}

function parseStoredFulfillment(value: unknown): StoredFulfillment | null {
  if (!record(value) || value.version !== 1 || !record(value.session)) return null;
  const session = value.session;
  if (
    typeof session.id !== "string" ||
    !UUID_PATTERN.test(session.id) ||
    typeof session.publicId !== "string" ||
    !PUBLIC_ID_PATTERN.test(session.publicId) ||
    !positiveInteger(session.version) ||
    !dateTime(session.expiresAt) ||
    !dateTime(session.hardExpiresAt) ||
    !Array.isArray(value.files) ||
    !OUTCOMES.has(value.outcome as PrototypeOutcome)
  ) {
    return null;
  }

  const payment = paymentSnapshotSchema.safeParse(value.payment);
  const printJob =
    value.printJob === null ? null : printJobSnapshotSchema.safeParse(value.printJob);
  const printFailureDisposition = parsePrintFailureDisposition(value.printFailureDisposition);
  const files = value.files.map(parseStoredFile);
  if (
    !payment.success ||
    (printJob !== null && !printJob.success) ||
    files.some((file) => file === null) ||
    payment.data.sessionId !== session.id ||
    (printJob !== null &&
      (printJob.data.sessionId !== session.id || printJob.data.paymentId !== payment.data.id))
  ) {
    return null;
  }

  return {
    version: 1,
    session: {
      id: session.id,
      publicId: session.publicId,
      version: session.version,
      expiresAt: session.expiresAt,
      hardExpiresAt: session.hardExpiresAt
    },
    files: files as PrototypeFile[],
    payment: payment.data,
    printJob: printJob?.data ?? null,
    printFailureDisposition,
    outcome: value.outcome as PrototypeOutcome
  };
}

function parsePrintFailureDisposition(value: unknown): PrintFailureDisposition | null {
  return value === "RETRYABLE" || value === "OPERATOR_REQUIRED" ? value : null;
}

function parseStoredFile(value: unknown): PrototypeFile | null {
  if (!record(value)) return null;
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !Number.isSafeInteger(value.ordinal) ||
    (value.ordinal as number) < 0 ||
    value.status !== "READY" ||
    typeof value.kind !== "string" ||
    !FILE_KINDS.has(value.kind) ||
    !positiveInteger(value.pageCount) ||
    !positiveInteger(value.processingRevision) ||
    !positiveInteger(value.sizeBytes)
  ) {
    return null;
  }
  return {
    id: value.id,
    ordinal: value.ordinal as number,
    name: null,
    kind: value.kind as PrototypeFile["kind"],
    status: "READY",
    pageCount: value.pageCount,
    processingRevision: value.processingRevision,
    rejectionCode: null,
    sizeBytes: value.sizeBytes
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function dateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
