export type PaperSize = "A4" | "LETTER";
export type Orientation = "PORTRAIT" | "LANDSCAPE";
export type PageRange = "ALL" | "FIRST_FOUR";
export type PrototypeOutcome = "SUCCESS" | "PAYMENT_DECLINED" | "PRINTER_ERROR";

export interface PrototypeSession {
  id: string;
  shortCode: string;
  uploadUrl: string;
  expiresAt: string;
}

export interface PrototypeFile {
  id: string;
  name: string;
  mimeType: "application/pdf";
  pageCount: number;
  sizeBytes: number;
}

export interface PrintSettings {
  paperSize: PaperSize;
  orientation: Orientation;
  pageRange: PageRange;
  copies: number;
  duplex: boolean;
  pagesPerSheet: 1 | 2;
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
  paperSize: "A4",
  orientation: "PORTRAIT",
  pageRange: "ALL",
  copies: 1,
  duplex: false,
  pagesPerSheet: 1
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
  const selectedPages =
    settings.pageRange === "FIRST_FOUR" ? Math.min(4, availablePages) : availablePages;
  const sidesPerCopy = Math.ceil(selectedPages / settings.pagesPerSheet);
  const sheetsPerCopy = settings.duplex ? Math.ceil(sidesPerCopy / 2) : sidesPerCopy;
  const totalSides = sidesPerCopy * settings.copies;
  const totalSheets = sheetsPerCopy * settings.copies;

  return {
    selectedPages,
    totalSides,
    totalSheets,
    priceCents: selectedPages === 0 ? 0 : Math.max(100, totalSides * 15)
  };
}

export function formatPrice(priceCents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    priceCents / 100
  );
}

export function formatFileSize(sizeBytes: number): string {
  return `${(sizeBytes / 1_000_000).toFixed(1)} MB`;
}
