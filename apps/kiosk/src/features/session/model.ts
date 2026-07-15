export type Orientation = "PORTRAIT" | "LANDSCAPE";
export type PrototypeOutcome = "SUCCESS" | "PAYMENT_DECLINED" | "PRINTER_ERROR";

export interface PrototypeSession {
  id: string;
  publicId: string;
  version: number;
  shortCode: string;
  uploadUrl: string;
  expiresAt: string;
  hardExpiresAt: string;
}

export interface PrototypeFile {
  id: string;
  name: string;
  mimeType: "application/pdf";
  pageCount: number;
  sizeBytes: number;
}

export interface PrintSettings {
  orientation: Orientation;
  pageStart: number;
  pageEnd: number | null;
  copies: number;
  duplex: boolean;
}

export interface PrototypeState {
  session: PrototypeSession | null;
  files: PrototypeFile[];
  settings: PrintSettings;
  outcome: PrototypeOutcome;
}

export type PrototypeAction =
  | { type: "SESSION_CREATED"; session: PrototypeSession }
  | { type: "FILE_UPLOADED"; file: PrototypeFile }
  | { type: "FILE_REMOVED"; fileId: string }
  | { type: "SETTINGS_CHANGED"; settings: Partial<PrintSettings> }
  | { type: "OUTCOME_CHANGED"; outcome: PrototypeOutcome }
  | { type: "RESET" };

export const defaultPrintSettings: PrintSettings = {
  orientation: "PORTRAIT",
  pageStart: 1,
  pageEnd: null,
  copies: 1,
  duplex: false
};

export const initialPrototypeState: PrototypeState = {
  session: null,
  files: [],
  settings: defaultPrintSettings,
  outcome: "SUCCESS"
};

export function prototypeReducer(state: PrototypeState, action: PrototypeAction): PrototypeState {
  switch (action.type) {
    case "SESSION_CREATED":
      return { ...initialPrototypeState, session: action.session };
    case "FILE_UPLOADED":
      return {
        ...state,
        files: [...state.files.filter((file) => file.id !== action.file.id), action.file]
      };
    case "FILE_REMOVED":
      return { ...state, files: state.files.filter((file) => file.id !== action.fileId) };
    case "SETTINGS_CHANGED":
      return { ...state, settings: { ...state.settings, ...action.settings } };
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
  priceCents: number;
}

export function calculatePrintSummary(
  files: PrototypeFile[],
  settings: PrintSettings
): PrintSummary {
  const availablePages = files.reduce((total, file) => total + file.pageCount, 0);
  const pageStart = availablePages === 0 ? 0 : clampPage(settings.pageStart, 1, availablePages);
  const requestedEnd = settings.pageEnd ?? availablePages;
  const pageEnd = availablePages === 0 ? 0 : clampPage(requestedEnd, pageStart, availablePages);
  const selectedPages = availablePages === 0 ? 0 : pageEnd - pageStart + 1;
  const sidesPerCopy = selectedPages;
  const sheetsPerCopy = settings.duplex ? Math.ceil(sidesPerCopy / 2) : sidesPerCopy;
  const totalSides = sidesPerCopy * settings.copies;
  const totalSheets = sheetsPerCopy * settings.copies;

  return {
    pageStart,
    pageEnd,
    selectedPages,
    totalSides,
    totalSheets,
    priceCents: selectedPages === 0 ? 0 : Math.max(100, totalSides * 15)
  };
}

function clampPage(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

export function formatPrice(priceCents: number, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
    priceCents / 100
  );
}

export function formatFileSize(sizeBytes: number, locale = "en-US", unit = "MB"): string {
  const size = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(sizeBytes / 1_000_000);

  return `${size} ${unit}`;
}
