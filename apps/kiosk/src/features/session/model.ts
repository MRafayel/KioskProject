import type {
  PaymentSnapshot,
  PriceQuote,
  PrintCapabilitiesResponse,
  PrintJobSnapshot,
  PrintSettingsSnapshot,
  SimulatedPrintOutcome,
  UploadedFileKind,
  UploadedFileRejectionCode,
  UploadedFileStatus
} from "@printing-kiosk/contracts";
import {
  formatPageRanges,
  MAX_PAGE_RANGE_SEGMENTS,
  MAX_PAGE_RANGE_TEXT_LENGTH,
  type PageRange
} from "@printing-kiosk/domain";

export type Orientation = "PORTRAIT" | "LANDSCAPE";
/**
 * Which deterministic scenario the touchscreen asks the simulated hardware
 * for. It exists because the pilot has no card terminal and no printer; a
 * deployment that has not enabled the scenarios prints and charges normally
 * whatever is selected here.
 */
export type PrototypeOutcome =
  "SUCCESS" | "PAYMENT_DECLINED" | "PRINTER_ERROR" | "PRINTER_UNCONFIRMED";

/** The device behaviour each touchscreen scenario stands in for. */
export const simulatedPrintOutcomeFor: Readonly<
  Record<PrototypeOutcome, SimulatedPrintOutcome | undefined>
> = {
  SUCCESS: undefined,
  PAYMENT_DECLINED: undefined,
  // A definite failure with nothing produced: the capture is owed back.
  PRINTER_ERROR: "OUT_OF_PAPER",
  // Output was written but never acknowledged, so nobody may claim to know.
  PRINTER_UNCONFIRMED: "UNKNOWN_AFTER_SUBMIT"
};

export interface PrototypeSession {
  id: string;
  publicId: string;
  version: number;
  uploadUrl: string;
  expiresAt: string;
  hardExpiresAt: string;
}

export interface PrototypeFile {
  id: string;
  ordinal: number;
  name: string | null;
  kind: UploadedFileKind | null;
  status: UploadedFileStatus;
  pageCount: number | null;
  processingRevision: number;
  rejectionCode: UploadedFileRejectionCode | null;
  sizeBytes: number | null;
}

export type ReadyPrototypeFile = PrototypeFile & {
  status: "READY";
  pageCount: number;
  processingRevision: number;
  sizeBytes: number;
};

/**
 * What one document is printed as.
 *
 * Every choice here belongs to the document rather than to the job: a page
 * range means nothing without the document it counts pages in, and copies,
 * sides and orientation are what that one document is printed as. The control
 * plane models it the same way — one `fileSelections` entry per file.
 */
export interface FileSelection {
  pageStart: number;
  pageEnd: number | null;
  /**
   * Pages the customer took out of the print job from the preview, held sorted
   * and without duplicates. They are subtracted from the chosen range rather
   * than replacing it, and one outside the range is kept but has no effect, so
   * narrowing and widening the range again returns the customer's exclusions
   * instead of silently reinstating pages they removed.
   */
  excludedPages: number[];
  copies: number;
  duplex: boolean;
  orientation: Orientation;
}

/**
 * What the customer chose, document by document.
 *
 * Everything a customer picks belongs to a document: pages, copies, sides and
 * orientation all mean something only against the document they apply to. Paper
 * size, scaling and collation are the job's, and the kiosk does not offer them,
 * so this holds nothing but the per-document choices.
 */
export interface PrintSettings {
  /** Every choice, keyed by file id. */
  selections: Readonly<Record<string, FileSelection>>;
}

/**
 * What the backend last said about this configuration.
 *
 * The kiosk never invents a price. `quote` is the only payable total, and it is
 * discarded the moment the customer changes anything the server priced.
 */
export type PricingStatus = "IDLE" | "PENDING" | "READY" | "FAILED";

export interface PricingState {
  status: PricingStatus;
  settings: PrintSettingsSnapshot | null;
  quote: PriceQuote | null;
  errorCode: string | null;
}

/**
 * What the control plane last said about collecting the money.
 *
 * The kiosk never decides that a payment succeeded. `payment` is the stored
 * record the control plane returned, and `attempt` is what earns a genuinely
 * new payment after one was declined rather than replaying the first.
 */
export interface PaymentState {
  payment: PaymentSnapshot | null;
  attempt: number;
  errorCode: string | null;
}

/**
 * What the control plane last said about the print itself.
 *
 * The kiosk never decides that a job printed. `job` is the stored record the
 * control plane returned, and a job it could not confirm stays unconfirmed on
 * screen rather than becoming a success or a failure.
 */
export interface PrintState {
  job: PrintJobSnapshot | null;
  errorCode: string | null;
  failureDisposition: PrintFailureDisposition | null;
}

export type PrintFailureDisposition = "RETRYABLE" | "OPERATOR_REQUIRED";

export interface PrototypeState {
  session: PrototypeSession | null;
  files: PrototypeFile[];
  settings: PrintSettings;
  capabilities: PrintCapabilitiesResponse | null;
  pricing: PricingState;
  payment: PaymentState;
  print: PrintState;
  outcome: PrototypeOutcome;
}

export type PrototypeAction =
  | { type: "SESSION_CREATED"; session: PrototypeSession }
  | { type: "SESSION_VERSION_OBSERVED"; version: number }
  | { type: "FILES_SYNCED"; files: PrototypeFile[] }
  | { type: "FILE_REMOVED"; fileId: string }
  | { type: "FILE_SELECTION_CHANGED"; fileId: string; selection: Partial<FileSelection> }
  | { type: "PAGE_EXCLUSION_CHANGED"; fileId: string; pageNumber: number; excluded: boolean }
  | { type: "CAPABILITIES_LOADED"; capabilities: PrintCapabilitiesResponse }
  | { type: "PRICING_PENDING" }
  | { type: "PRICING_RESOLVED"; settings: PrintSettingsSnapshot; quote: PriceQuote }
  | { type: "PRICING_FAILED"; errorCode: string }
  | { type: "PRICING_CLEARED" }
  | { type: "PAYMENT_STARTED"; payment: PaymentSnapshot }
  | { type: "PAYMENT_OBSERVED"; payment: PaymentSnapshot }
  | { type: "PAYMENT_FAILED"; errorCode: string }
  | { type: "PAYMENT_CLEARED" }
  | { type: "PRINT_OBSERVED"; printJob: PrintJobSnapshot }
  | {
      type: "PRINT_FAILED";
      errorCode: string;
      failureDisposition: PrintFailureDisposition;
    }
  | { type: "OUTCOME_CHANGED"; outcome: PrototypeOutcome }
  | { type: "RESET" };

export const defaultFileSelection: FileSelection = {
  pageStart: 1,
  pageEnd: null,
  excludedPages: [],
  copies: 1,
  duplex: false,
  orientation: "PORTRAIT"
};

export const defaultPrintSettings: PrintSettings = { selections: {} };

/**
 * The selection for one document, or the untouched default for a document the
 * customer has not configured yet. Reading through this rather than indexing
 * the record keeps "not configured" and "every page" the same thing, which is
 * what a customer who never opens the page controls expects.
 */
export function fileSelection(settings: PrintSettings, fileId: string): FileSelection {
  return settings.selections[fileId] ?? defaultFileSelection;
}

export const idlePricingState: PricingState = {
  status: "IDLE",
  settings: null,
  quote: null,
  errorCode: null
};

export const idlePaymentState: PaymentState = { payment: null, attempt: 1, errorCode: null };

export const idlePrintState: PrintState = {
  job: null,
  errorCode: null,
  failureDisposition: null
};

export const initialPrototypeState: PrototypeState = {
  session: null,
  files: [],
  settings: defaultPrintSettings,
  capabilities: null,
  pricing: idlePricingState,
  payment: idlePaymentState,
  print: idlePrintState,
  outcome: "SUCCESS"
};

export function prototypeReducer(state: PrototypeState, action: PrototypeAction): PrototypeState {
  switch (action.type) {
    case "SESSION_CREATED":
      return { ...initialPrototypeState, session: action.session };
    case "SESSION_VERSION_OBSERVED":
      return state.session
        ? { ...state, session: { ...state.session, version: action.version } }
        : state;
    case "FILES_SYNCED": {
      const files = [...action.files].sort(
        (a, b) => fileDisplayPriority(a) - fileDisplayPriority(b) || a.ordinal - b.ordinal
      );
      // A changed document set retires the stored price with the same finality
      // the server applies to it.
      const sameMaterial = readyFileFingerprint(files) === readyFileFingerprint(state.files);
      // Selections are pruned per document rather than wholesale: adding a
      // second document must not throw away the pages the customer already
      // chose in the first, but a document that was reprocessed or removed
      // takes its own page numbers with it, because they described a document
      // that is no longer the one on screen.
      const selections = retainSelections(state.settings.selections, state.files, files);
      return {
        ...state,
        files,
        settings: { ...state.settings, selections },
        pricing: sameMaterial ? state.pricing : idlePricingState,
        // A price that no longer applies cannot be the one being paid, so the
        // payment on screen goes with it. The control plane holds the same
        // rule: a settled payment is a row it will not let this screen edit.
        payment: sameMaterial ? state.payment : nextPaymentAttempt(state.payment)
      };
    }
    case "FILE_REMOVED": {
      const files = state.files.filter((file) => file.id !== action.fileId);
      return {
        ...state,
        files,
        settings: {
          ...state.settings,
          selections: retainSelections(state.settings.selections, state.files, files)
        },
        pricing: idlePricingState,
        payment: nextPaymentAttempt(state.payment)
      };
    }
    case "FILE_SELECTION_CHANGED": {
      const current = fileSelection(state.settings, action.fileId);
      const next = { ...current, ...action.selection };
      if (sameSelection(current, next)) return state;
      return {
        ...state,
        settings: {
          ...state.settings,
          selections: { ...state.settings.selections, [action.fileId]: next }
        },
        pricing: idlePricingState,
        payment: nextPaymentAttempt(state.payment)
      };
    }
    case "PAGE_EXCLUSION_CHANGED": {
      const current = fileSelection(state.settings, action.fileId);
      const excludedPages = action.excluded
        ? [...new Set([...current.excludedPages, action.pageNumber])].sort(
            (left, right) => left - right
          )
        : current.excludedPages.filter((page) => page !== action.pageNumber);
      // Asking for the state a page is already in changes nothing, and must not
      // throw away a live price to say so.
      if (excludedPages.length === current.excludedPages.length) return state;
      return {
        ...state,
        settings: {
          ...state.settings,
          selections: {
            ...state.settings.selections,
            [action.fileId]: { ...current, excludedPages }
          }
        },
        pricing: idlePricingState,
        payment: nextPaymentAttempt(state.payment)
      };
    }
    case "CAPABILITIES_LOADED":
      return { ...state, capabilities: action.capabilities };
    case "PRICING_PENDING":
      return { ...state, pricing: { ...state.pricing, status: "PENDING", errorCode: null } };
    case "PRICING_RESOLVED":
      return {
        ...state,
        pricing: {
          status: "READY",
          settings: action.settings,
          quote: action.quote,
          errorCode: null
        }
      };
    case "PRICING_FAILED":
      return {
        ...state,
        pricing: { status: "FAILED", settings: null, quote: null, errorCode: action.errorCode }
      };
    case "PRICING_CLEARED":
      return { ...state, pricing: idlePricingState, payment: nextPaymentAttempt(state.payment) };
    case "PAYMENT_STARTED":
    case "PAYMENT_OBSERVED":
      return { ...state, payment: { ...state.payment, payment: action.payment, errorCode: null } };
    case "PAYMENT_FAILED":
      return { ...state, payment: { ...state.payment, errorCode: action.errorCode } };
    case "PAYMENT_CLEARED":
      return { ...state, payment: nextPaymentAttempt(state.payment) };
    case "PRINT_OBSERVED":
      return {
        ...state,
        print: { job: action.printJob, errorCode: null, failureDisposition: null }
      };
    case "PRINT_FAILED":
      return {
        ...state,
        print: {
          ...state.print,
          errorCode: action.errorCode,
          failureDisposition: action.failureDisposition
        }
      };
    case "OUTCOME_CHANGED":
      return { ...state, outcome: action.outcome };
    case "RESET":
      return initialPrototypeState;
  }
}

/**
 * The job totals across every document.
 *
 * There is deliberately no aggregate page range here: a range belongs to one
 * document, and "pages 2-5" spanning a set of documents would describe nothing
 * the customer chose. Per-document bounds come from {@link pageRangeBounds}.
 */
export interface PrintSummary {
  selectedPages: number;
  totalSides: number;
  totalSheets: number;
}

/**
 * A local preview of the page arithmetic so the screen responds instantly to a
 * touch. It deliberately produces no money: the total on screen always comes
 * from the server quote.
 */
export function calculatePrintSummary(
  files: PrototypeFile[],
  settings: PrintSettings
): PrintSummary {
  const ready = files.filter(isReadyFile);
  if (ready.length === 0) return { selectedPages: 0, totalSides: 0, totalSheets: 0 };

  // Each document contributes the pages its own selection prints. Sheets are
  // counted per document rather than from the job total because a duplex sheet
  // never carries two different documents: an odd document leaves the back of
  // its last sheet blank, exactly as the control plane prices it.
  let selectedPages = 0;
  let totalSides = 0;
  let totalSheets = 0;
  for (const file of ready) {
    const selection = fileSelection(settings, file.id);
    const pages = countPagesInRanges(selectedPageRanges(selection, file.pageCount));
    const sheetsPerCopy = selection.duplex ? Math.ceil(pages / 2) : pages;
    selectedPages += pages;
    totalSides += pages * selection.copies;
    totalSheets += sheetsPerCopy * selection.copies;
  }

  return { selectedPages, totalSides, totalSheets };
}

/** Where the customer's chosen range actually falls in a document this long. */
export function pageRangeBounds(
  selection: FileSelection,
  pageCount: number
): { pageStart: number; pageEnd: number } {
  const pageStart = clampPage(selection.pageStart, 1, pageCount);
  const pageEnd = clampPage(selection.pageEnd ?? pageCount, pageStart, pageCount);
  return { pageStart, pageEnd };
}

/**
 * The pages this configuration prints: the chosen range with every excluded
 * page taken out, as the contiguous groups the control plane is told about.
 * An empty result means the customer has excluded everything they selected.
 */
export function selectedPageRanges(selection: FileSelection, pageCount: number): PageRange[] {
  const { pageStart, pageEnd } = pageRangeBounds(selection, pageCount);
  const excluded = new Set(selection.excludedPages);
  const ranges: Array<[number, number]> = [];

  for (let page = pageStart; page <= pageEnd; page += 1) {
    if (excluded.has(page)) continue;
    const last = ranges.at(-1);
    if (last && last[1] === page - 1) last[1] = page;
    else ranges.push([page, page]);
  }

  return ranges;
}

export function countPagesInRanges(ranges: readonly PageRange[]): number {
  return ranges.reduce((total, [start, end]) => total + (end - start + 1), 0);
}

/** How a single page of the document is treated by the current settings. */
export type PagePrintState = "PRINTED" | "EXCLUDED" | "OUT_OF_RANGE";

export function pagePrintState(
  selection: FileSelection,
  pageCount: number,
  pageNumber: number
): PagePrintState {
  const { pageStart, pageEnd } = pageRangeBounds(selection, pageCount);
  if (pageNumber < pageStart || pageNumber > pageEnd) return "OUT_OF_RANGE";
  return selection.excludedPages.includes(pageNumber) ? "EXCLUDED" : "PRINTED";
}

/**
 * Why a printed page cannot be excluded, or `null` when it can be.
 *
 * The kiosk refuses these two before they are dispatched rather than letting
 * the control plane refuse the settings afterwards: both would leave the
 * customer looking at a configuration that cannot be priced, with nothing on
 * screen explaining which tap caused it.
 *
 * Both are per document. The control plane requires every document in the job
 * to select at least one page, so emptying one document's selection is refused
 * here even when other documents still print; removing the document is the way
 * to print none of it.
 */
export type PageExclusionRefusal = "LAST_SELECTED_PAGE" | "SELECTION_TOO_COMPLEX";

export function pageExclusionRefusal(
  selection: FileSelection,
  pageCount: number,
  pageNumber: number
): PageExclusionRefusal | null {
  const ranges = selectedPageRanges(
    { ...selection, excludedPages: [...selection.excludedPages, pageNumber] },
    pageCount
  );
  if (ranges.length === 0) return "LAST_SELECTED_PAGE";
  if (
    ranges.length > MAX_PAGE_RANGE_SEGMENTS ||
    formatPageRanges(ranges).length > MAX_PAGE_RANGE_TEXT_LENGTH
  ) {
    return "SELECTION_TOO_COMPLEX";
  }
  return null;
}

export function isReadyFile(file: PrototypeFile | undefined): file is ReadyPrototypeFile {
  return file?.status === "READY" && file.pageCount !== null && file.sizeBytes !== null;
}

/**
 * Every validated document, in the order it prints.
 *
 * Upload order is print order, and it is the order `fileOrder` is sent in, so
 * sorting here keeps what the customer sees and what the control plane is told
 * about the same sequence.
 */
export function readyFiles(files: readonly PrototypeFile[]): ReadyPrototypeFile[] {
  return files.filter(isReadyFile).sort((left, right) => left.ordinal - right.ordinal);
}

/**
 * Forget the payment on screen and move to the next attempt number, so the
 * request that follows asks for a new payment instead of replaying the old one.
 */
function nextPaymentAttempt(payment: PaymentState): PaymentState {
  if (!payment.payment && payment.errorCode === null) return payment;
  return { payment: null, attempt: payment.attempt + 1, errorCode: null };
}

export function isQuotePayable(quote: PriceQuote | null, now: Date): quote is PriceQuote {
  return (
    quote !== null &&
    quote.status === "ACTIVE" &&
    now.getTime() < new Date(quote.expiresAt).getTime()
  );
}

export function fileExtension(kind: UploadedFileKind | null): string {
  if (kind === "PDF") return "pdf";
  if (kind === "JPEG") return "jpg";
  if (kind === "PNG") return "png";
  return "file";
}

function clampPage(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function fileDisplayPriority(file: PrototypeFile): number {
  return file.status === "REJECTED" || file.status === "DELETED" ? 1 : 0;
}

function readyFileFingerprint(files: PrototypeFile[]): string {
  return files
    .filter(isReadyFile)
    .map((file) => `${file.id}:${file.processingRevision}:${file.pageCount}`)
    .join("|");
}

/** What each ready document is, so a change to one can be told from a change to the set. */
function fileMaterial(files: PrototypeFile[]): Map<string, string> {
  return new Map(
    files
      .filter(isReadyFile)
      .map((file) => [file.id, `${file.processingRevision}:${file.pageCount}`])
  );
}

/**
 * Carry page selections across a change to the document set.
 *
 * A selection survives only while the document it counts pages in is still
 * there and still the same document. One that was removed, or reprocessed into
 * a different page count, drops its selection rather than applying page numbers
 * to content the customer never saw.
 */
function retainSelections(
  selections: Readonly<Record<string, FileSelection>>,
  previousFiles: PrototypeFile[],
  nextFiles: PrototypeFile[]
): Readonly<Record<string, FileSelection>> {
  const previous = fileMaterial(previousFiles);
  const next = fileMaterial(nextFiles);
  const retained: Record<string, FileSelection> = {};

  for (const [fileId, selection] of Object.entries(selections)) {
    const material = next.get(fileId);
    if (material === undefined || material !== previous.get(fileId)) continue;
    retained[fileId] = selection;
  }

  return retained;
}

function sameSelection(left: FileSelection, right: FileSelection): boolean {
  return (
    left.pageStart === right.pageStart &&
    left.pageEnd === right.pageEnd &&
    left.copies === right.copies &&
    left.duplex === right.duplex &&
    left.orientation === right.orientation &&
    left.excludedPages.length === right.excludedPages.length &&
    left.excludedPages.every((page, index) => page === right.excludedPages[index])
  );
}

/**
 * Money arrives as an integer count of minor units plus its currency and
 * exponent, and is converted only here, only for display.
 */
export function formatMinorAmount(
  amountMinor: number,
  currency: string,
  currencyExponent: number,
  locale = "en-US"
): string {
  const scale = 10 ** currencyExponent;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: currencyExponent,
    maximumFractionDigits: currencyExponent
  }).format(amountMinor / scale);
}

export function formatFileSize(sizeBytes: number, locale = "en-US", unit = "MB"): string {
  const size = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(sizeBytes / 1_000_000);

  return `${size} ${unit}`;
}
