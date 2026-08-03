import type {
  PaymentSnapshot,
  PriceQuote,
  PrintCapabilitiesResponse,
  PrintSettingsSnapshot,
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
export type PrototypeOutcome = "SUCCESS" | "PAYMENT_DECLINED" | "PRINTER_ERROR";

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

export interface PrintSettings {
  orientation: Orientation;
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

export interface PrototypeState {
  session: PrototypeSession | null;
  files: PrototypeFile[];
  settings: PrintSettings;
  capabilities: PrintCapabilitiesResponse | null;
  pricing: PricingState;
  payment: PaymentState;
  outcome: PrototypeOutcome;
}

export type PrototypeAction =
  | { type: "SESSION_CREATED"; session: PrototypeSession }
  | { type: "SESSION_VERSION_OBSERVED"; version: number }
  | { type: "FILES_SYNCED"; files: PrototypeFile[] }
  | { type: "FILE_REMOVED"; fileId: string }
  | { type: "SETTINGS_CHANGED"; settings: Partial<PrintSettings> }
  | { type: "PAGE_EXCLUSION_CHANGED"; pageNumber: number; excluded: boolean }
  | { type: "CAPABILITIES_LOADED"; capabilities: PrintCapabilitiesResponse }
  | { type: "PRICING_PENDING" }
  | { type: "PRICING_RESOLVED"; settings: PrintSettingsSnapshot; quote: PriceQuote }
  | { type: "PRICING_FAILED"; errorCode: string }
  | { type: "PRICING_CLEARED" }
  | { type: "PAYMENT_STARTED"; payment: PaymentSnapshot }
  | { type: "PAYMENT_OBSERVED"; payment: PaymentSnapshot }
  | { type: "PAYMENT_FAILED"; errorCode: string }
  | { type: "PAYMENT_CLEARED" }
  | { type: "OUTCOME_CHANGED"; outcome: PrototypeOutcome }
  | { type: "RESET" };

export const defaultPrintSettings: PrintSettings = {
  orientation: "PORTRAIT",
  pageStart: 1,
  pageEnd: null,
  excludedPages: [],
  copies: 1,
  duplex: false
};

export const idlePricingState: PricingState = {
  status: "IDLE",
  settings: null,
  quote: null,
  errorCode: null
};

export const idlePaymentState: PaymentState = { payment: null, attempt: 1, errorCode: null };

export const initialPrototypeState: PrototypeState = {
  session: null,
  files: [],
  settings: defaultPrintSettings,
  capabilities: null,
  pricing: idlePricingState,
  payment: idlePaymentState,
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
      // the server applies to it, and takes the page exclusions with it: those
      // page numbers described a document that is no longer the one on screen.
      const sameMaterial = readyFileFingerprint(files) === readyFileFingerprint(state.files);
      return {
        ...state,
        files,
        settings: sameMaterial ? state.settings : { ...state.settings, excludedPages: [] },
        pricing: sameMaterial ? state.pricing : idlePricingState,
        // A price that no longer applies cannot be the one being paid, so the
        // payment on screen goes with it. The control plane holds the same
        // rule: a settled payment is a row it will not let this screen edit.
        payment: sameMaterial ? state.payment : nextPaymentAttempt(state.payment)
      };
    }
    case "FILE_REMOVED":
      return {
        ...state,
        files: state.files.filter((file) => file.id !== action.fileId),
        settings: { ...state.settings, excludedPages: [] },
        pricing: idlePricingState,
        payment: nextPaymentAttempt(state.payment)
      };
    case "SETTINGS_CHANGED":
      return {
        ...state,
        settings: { ...state.settings, ...action.settings },
        pricing: idlePricingState,
        payment: nextPaymentAttempt(state.payment)
      };
    case "PAGE_EXCLUSION_CHANGED": {
      const excludedPages = action.excluded
        ? [...new Set([...state.settings.excludedPages, action.pageNumber])].sort(
            (left, right) => left - right
          )
        : state.settings.excludedPages.filter((page) => page !== action.pageNumber);
      // Asking for the state a page is already in changes nothing, and must not
      // throw away a live price to say so.
      if (excludedPages.length === state.settings.excludedPages.length) return state;
      return {
        ...state,
        settings: { ...state.settings, excludedPages },
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
    case "OUTCOME_CHANGED":
      return { ...state, outcome: action.outcome };
    case "RESET":
      return initialPrototypeState;
  }
}

export interface PrintSummary {
  pageStart: number;
  pageEnd: number;
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
  const availablePages = files.reduce((total, file) => total + (file.pageCount ?? 0), 0);
  if (availablePages === 0) {
    return { pageStart: 0, pageEnd: 0, selectedPages: 0, totalSides: 0, totalSheets: 0 };
  }

  const { pageStart, pageEnd } = pageRangeBounds(settings, availablePages);
  const selectedPages = countPagesInRanges(selectedPageRanges(settings, availablePages));
  const sidesPerCopy = selectedPages;
  const sheetsPerCopy = settings.duplex ? Math.ceil(sidesPerCopy / 2) : sidesPerCopy;

  return {
    pageStart,
    pageEnd,
    selectedPages,
    totalSides: sidesPerCopy * settings.copies,
    totalSheets: sheetsPerCopy * settings.copies
  };
}

/** Where the customer's chosen range actually falls in a document this long. */
export function pageRangeBounds(
  settings: PrintSettings,
  pageCount: number
): { pageStart: number; pageEnd: number } {
  const pageStart = clampPage(settings.pageStart, 1, pageCount);
  const pageEnd = clampPage(settings.pageEnd ?? pageCount, pageStart, pageCount);
  return { pageStart, pageEnd };
}

/**
 * The pages this configuration prints: the chosen range with every excluded
 * page taken out, as the contiguous groups the control plane is told about.
 * An empty result means the customer has excluded everything they selected.
 */
export function selectedPageRanges(settings: PrintSettings, pageCount: number): PageRange[] {
  const { pageStart, pageEnd } = pageRangeBounds(settings, pageCount);
  const excluded = new Set(settings.excludedPages);
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
  settings: PrintSettings,
  pageCount: number,
  pageNumber: number
): PagePrintState {
  const { pageStart, pageEnd } = pageRangeBounds(settings, pageCount);
  if (pageNumber < pageStart || pageNumber > pageEnd) return "OUT_OF_RANGE";
  return settings.excludedPages.includes(pageNumber) ? "EXCLUDED" : "PRINTED";
}

/**
 * Why a printed page cannot be excluded, or `null` when it can be.
 *
 * The kiosk refuses these two before they are dispatched rather than letting
 * the control plane refuse the settings afterwards: both would leave the
 * customer looking at a configuration that cannot be priced, with nothing on
 * screen explaining which tap caused it.
 */
export type PageExclusionRefusal = "LAST_SELECTED_PAGE" | "SELECTION_TOO_COMPLEX";

export function pageExclusionRefusal(
  settings: PrintSettings,
  pageCount: number,
  pageNumber: number
): PageExclusionRefusal | null {
  const ranges = selectedPageRanges(
    { ...settings, excludedPages: [...settings.excludedPages, pageNumber] },
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
