import type {
  PriceQuote,
  PrintCapabilitiesResponse,
  PrintSettingsSnapshot,
  UploadedFileKind,
  UploadedFileRejectionCode,
  UploadedFileStatus
} from "@printing-kiosk/contracts";

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

export interface PrototypeState {
  session: PrototypeSession | null;
  files: PrototypeFile[];
  settings: PrintSettings;
  capabilities: PrintCapabilitiesResponse | null;
  pricing: PricingState;
  outcome: PrototypeOutcome;
}

export type PrototypeAction =
  | { type: "SESSION_CREATED"; session: PrototypeSession }
  | { type: "SESSION_VERSION_OBSERVED"; version: number }
  | { type: "FILES_SYNCED"; files: PrototypeFile[] }
  | { type: "FILE_REMOVED"; fileId: string }
  | { type: "SETTINGS_CHANGED"; settings: Partial<PrintSettings> }
  | { type: "CAPABILITIES_LOADED"; capabilities: PrintCapabilitiesResponse }
  | { type: "PRICING_PENDING" }
  | { type: "PRICING_RESOLVED"; settings: PrintSettingsSnapshot; quote: PriceQuote }
  | { type: "PRICING_FAILED"; errorCode: string }
  | { type: "PRICING_CLEARED" }
  | { type: "OUTCOME_CHANGED"; outcome: PrototypeOutcome }
  | { type: "RESET" };

export const defaultPrintSettings: PrintSettings = {
  orientation: "PORTRAIT",
  pageStart: 1,
  pageEnd: null,
  copies: 1,
  duplex: false
};

export const idlePricingState: PricingState = {
  status: "IDLE",
  settings: null,
  quote: null,
  errorCode: null
};

export const initialPrototypeState: PrototypeState = {
  session: null,
  files: [],
  settings: defaultPrintSettings,
  capabilities: null,
  pricing: idlePricingState,
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
      return {
        ...state,
        files,
        pricing:
          readyFileFingerprint(files) === readyFileFingerprint(state.files)
            ? state.pricing
            : idlePricingState
      };
    }
    case "FILE_REMOVED":
      return {
        ...state,
        files: state.files.filter((file) => file.id !== action.fileId),
        pricing: idlePricingState
      };
    case "SETTINGS_CHANGED":
      return {
        ...state,
        settings: { ...state.settings, ...action.settings },
        pricing: idlePricingState
      };
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
      return { ...state, pricing: idlePricingState };
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
  const pageStart = availablePages === 0 ? 0 : clampPage(settings.pageStart, 1, availablePages);
  const requestedEnd = settings.pageEnd ?? availablePages;
  const pageEnd = availablePages === 0 ? 0 : clampPage(requestedEnd, pageStart, availablePages);
  const selectedPages = availablePages === 0 ? 0 : pageEnd - pageStart + 1;
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

export function isReadyFile(file: PrototypeFile | undefined): file is ReadyPrototypeFile {
  return file?.status === "READY" && file.pageCount !== null && file.sizeBytes !== null;
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
