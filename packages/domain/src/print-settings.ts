/**
 * Canonical print settings.
 *
 * This module is pure: it has no clock, randomness, database, or input/output.
 * The API calls it to turn a customer request into one deterministic settings
 * revision, and the same revision must always produce the same page counts and
 * the same manifest string so a stored quote can be rechecked later.
 *
 * Colour is not a setting. The product prints monochrome only, so the colour
 * mode is a constant that the manifest records rather than an option a client
 * can influence.
 */

export const PAPER_SIZES = ["A4"] as const;
export const DUPLEX_MODES = ["SIMPLEX", "LONG_EDGE", "SHORT_EDGE"] as const;
export const ORIENTATIONS = ["AUTO", "PORTRAIT", "LANDSCAPE"] as const;
export const SCALING_MODES = ["FIT", "ACTUAL_SIZE"] as const;
export const PAGES_PER_SHEET_OPTIONS = [1, 2] as const;
export const COLOR_MODES = ["MONOCHROME"] as const;

export const PRINT_COLOR_MODE = "MONOCHROME";
export const SETTINGS_MANIFEST_VERSION = 1;

/** A page-range text longer than this is refused before parsing. */
export const MAX_PAGE_RANGE_TEXT_LENGTH = 200;
/** Bounds the parser, the canonical text, and the stored revision row. */
export const MAX_PAGE_RANGE_SEGMENTS = 50;

export type PaperSize = (typeof PAPER_SIZES)[number];
export type DuplexMode = (typeof DUPLEX_MODES)[number];
export type Orientation = (typeof ORIENTATIONS)[number];
export type ScalingMode = (typeof SCALING_MODES)[number];
export type ColorMode = (typeof COLOR_MODES)[number];

export type PageRange = readonly [number, number];

export interface PrintSettingsInput {
  fileOrder: readonly string[];
  fileSelections: readonly { fileId: string; pageRanges: string | null }[];
  copies: number;
  duplex: DuplexMode;
  paperSize: PaperSize;
  orientation: Orientation;
  pagesPerSheet: number;
  scaling: ScalingMode;
  collate: boolean;
}

/** One validated, printable document as the database knows it. */
export interface SelectableFile {
  id: string;
  pageCount: number;
  processingRevision: number;
  contentSha256: string;
}

/**
 * What the device can actually do. The MVP reads this from the kiosk row so a
 * settings revision can never promise output the pilot hardware cannot make.
 */
export interface PrinterCapabilities {
  version: number;
  paperSizes: readonly PaperSize[];
  colorModes: readonly ColorMode[];
  duplexModes: readonly DuplexMode[];
  pagesPerSheetOptions: readonly number[];
  scalingModes: readonly ScalingMode[];
  orientations: readonly Orientation[];
  maxCopies: number;
}

/** Deployment ceilings that protect cost and print time, not correctness. */
export interface PrintSettingsLimits {
  maxCopies: number;
  maxSelectedPages: number;
  maxPrintedSides: number;
}

export interface NormalizePrintSettingsContext {
  files: readonly SelectableFile[];
  capabilities: PrinterCapabilities;
  limits: PrintSettingsLimits;
}

export interface NormalizedFileSelection {
  fileId: string;
  position: number;
  pageCount: number;
  processingRevision: number;
  contentSha256: string;
  pageRanges: PageRange[];
  pageRangeText: string;
  selectedPages: number;
  printedSidesPerCopy: number;
  physicalSheetsPerCopy: number;
}

export interface NormalizedPrintSettings {
  copies: number;
  duplex: DuplexMode;
  paperSize: PaperSize;
  orientation: Orientation;
  pagesPerSheet: number;
  scaling: ScalingMode;
  collate: boolean;
  colorMode: ColorMode;
  capabilityVersion: number;
  files: NormalizedFileSelection[];
  selectedPages: number;
  printedSidesPerCopy: number;
  printedSides: number;
  physicalSheets: number;
}

export interface SettingsManifest {
  manifestVersion: number;
  colorMode: ColorMode;
  paperSize: PaperSize;
  orientation: Orientation;
  duplex: DuplexMode;
  pagesPerSheet: number;
  scaling: ScalingMode;
  collate: boolean;
  copies: number;
  capabilityVersion: number;
  files: Array<{
    fileId: string;
    position: number;
    processingRevision: number;
    contentSha256: string;
    pageCount: number;
    pageRanges: number[][];
    selectedPages: number;
  }>;
}

export type PrintSettingsErrorCode =
  | "FILE_ORDER_INVALID"
  | "FILE_SELECTION_INVALID"
  | "PAGE_RANGE_INVALID"
  | "PAGE_RANGE_OUT_OF_BOUNDS"
  | "NO_SELECTED_PAGES"
  | "COPIES_OUT_OF_RANGE"
  | "SELECTED_PAGE_LIMIT_EXCEEDED"
  | "PRINTED_SIDE_LIMIT_EXCEEDED"
  | "UNSUPPORTED_PRINT_SETTING";

export class PrintSettingsError extends Error {
  public constructor(
    public readonly code: PrintSettingsErrorCode,
    public readonly details: Readonly<Record<string, string | number>> = {}
  ) {
    super(code);
    this.name = "PrintSettingsError";
  }
}

/**
 * Parse customer page-range text into ordered, merged, in-bounds ranges.
 * `null` and an empty selection both mean the whole document.
 */
export function parsePageRangeText(text: string | null, pageCount: number): PageRange[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new PrintSettingsError("PAGE_RANGE_OUT_OF_BOUNDS", { pageCount });
  }

  const trimmed = (text ?? "").trim();
  if (trimmed.length === 0) return [[1, pageCount]];
  if (trimmed.length > MAX_PAGE_RANGE_TEXT_LENGTH) {
    throw new PrintSettingsError("PAGE_RANGE_INVALID", { length: trimmed.length });
  }

  const segments = trimmed.split(",");
  if (segments.length > MAX_PAGE_RANGE_SEGMENTS) {
    throw new PrintSettingsError("PAGE_RANGE_INVALID", { segments: segments.length });
  }

  const parsed: PageRange[] = [];
  for (const segment of segments) {
    const match = /^\s*(\d{1,6})\s*(?:-\s*(\d{1,6})\s*)?$/.exec(segment);
    if (!match) throw new PrintSettingsError("PAGE_RANGE_INVALID");

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new PrintSettingsError("PAGE_RANGE_INVALID");
    }
    if (start < 1 || end < start) {
      throw new PrintSettingsError("PAGE_RANGE_INVALID", { start, end });
    }
    if (end > pageCount) {
      throw new PrintSettingsError("PAGE_RANGE_OUT_OF_BOUNDS", { end, pageCount });
    }
    parsed.push([start, end]);
  }

  return mergePageRanges(parsed);
}

/** Sort, merge overlapping or adjacent ranges, and drop duplicates. */
export function mergePageRanges(ranges: readonly PageRange[]): PageRange[] {
  const ordered = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ordered) {
    const last = merged.at(-1);
    // Adjacency merges too: "1-2,3" and "1-3" must not price differently.
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
      continue;
    }
    merged.push([start, end]);
  }
  return merged;
}

export function formatPageRanges(ranges: readonly PageRange[]): string {
  return ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(",");
}

export function countSelectedPages(ranges: readonly PageRange[]): number {
  return ranges.reduce((total, [start, end]) => total + (end - start + 1), 0);
}

/**
 * Printed sides and physical sheets for one document in one copy.
 * Every document starts on a fresh sheet, so files never share a sheet.
 */
export function calculateSheetUsage(input: {
  selectedPages: number;
  pagesPerSheet: number;
  duplex: DuplexMode;
}): { printedSidesPerCopy: number; physicalSheetsPerCopy: number } {
  const printedSidesPerCopy = Math.ceil(input.selectedPages / input.pagesPerSheet);
  const physicalSheetsPerCopy =
    input.duplex === "SIMPLEX" ? printedSidesPerCopy : Math.ceil(printedSidesPerCopy / 2);
  return { printedSidesPerCopy, physicalSheetsPerCopy };
}

export function normalizePrintSettings(
  input: PrintSettingsInput,
  context: NormalizePrintSettingsContext
): NormalizedPrintSettings {
  assertSupported(context.capabilities.paperSizes.includes(input.paperSize), "paperSize");
  assertSupported(context.capabilities.duplexModes.includes(input.duplex), "duplex");
  assertSupported(context.capabilities.orientations.includes(input.orientation), "orientation");
  assertSupported(context.capabilities.scalingModes.includes(input.scaling), "scaling");
  assertSupported(
    context.capabilities.pagesPerSheetOptions.includes(input.pagesPerSheet),
    "pagesPerSheet"
  );
  // Monochrome is the only output this product sells. A device that cannot
  // promise it must not receive a settings revision at all.
  assertSupported(context.capabilities.colorModes.includes(PRINT_COLOR_MODE), "colorMode");

  const maxCopies = Math.min(context.limits.maxCopies, context.capabilities.maxCopies);
  if (!Number.isSafeInteger(input.copies) || input.copies < 1 || input.copies > maxCopies) {
    throw new PrintSettingsError("COPIES_OUT_OF_RANGE", { copies: input.copies, maxCopies });
  }

  const available = new Map(context.files.map((file) => [file.id, file]));
  if (input.fileOrder.length !== available.size) {
    throw new PrintSettingsError("FILE_ORDER_INVALID", {
      expected: available.size,
      received: input.fileOrder.length
    });
  }
  if (new Set(input.fileOrder).size !== input.fileOrder.length) {
    throw new PrintSettingsError("FILE_ORDER_INVALID", { reason: "DUPLICATE_FILE" });
  }
  if (input.fileSelections.length !== input.fileOrder.length) {
    throw new PrintSettingsError("FILE_SELECTION_INVALID", {
      expected: input.fileOrder.length,
      received: input.fileSelections.length
    });
  }

  const selectionByFile = new Map<string, string | null>();
  for (const selection of input.fileSelections) {
    if (selectionByFile.has(selection.fileId)) {
      throw new PrintSettingsError("FILE_SELECTION_INVALID", { reason: "DUPLICATE_SELECTION" });
    }
    selectionByFile.set(selection.fileId, selection.pageRanges);
  }

  const files: NormalizedFileSelection[] = input.fileOrder.map((fileId, index) => {
    const file = available.get(fileId);
    if (!file) throw new PrintSettingsError("FILE_ORDER_INVALID", { reason: "UNKNOWN_FILE" });
    if (!selectionByFile.has(fileId)) {
      throw new PrintSettingsError("FILE_SELECTION_INVALID", { reason: "MISSING_SELECTION" });
    }

    const pageRanges = parsePageRangeText(selectionByFile.get(fileId) ?? null, file.pageCount);
    const selectedPages = countSelectedPages(pageRanges);
    const usage = calculateSheetUsage({
      selectedPages,
      pagesPerSheet: input.pagesPerSheet,
      duplex: input.duplex
    });

    return {
      fileId,
      position: index,
      pageCount: file.pageCount,
      processingRevision: file.processingRevision,
      contentSha256: file.contentSha256,
      pageRanges,
      pageRangeText: formatPageRanges(pageRanges),
      selectedPages,
      ...usage
    };
  });

  const selectedPages = sum(files.map((file) => file.selectedPages));
  if (selectedPages < 1) throw new PrintSettingsError("NO_SELECTED_PAGES");
  if (selectedPages > context.limits.maxSelectedPages) {
    throw new PrintSettingsError("SELECTED_PAGE_LIMIT_EXCEEDED", {
      selectedPages,
      maxSelectedPages: context.limits.maxSelectedPages
    });
  }

  const printedSidesPerCopy = sum(files.map((file) => file.printedSidesPerCopy));
  const printedSides = printedSidesPerCopy * input.copies;
  const physicalSheets = sum(files.map((file) => file.physicalSheetsPerCopy)) * input.copies;
  if (printedSides > context.limits.maxPrintedSides) {
    throw new PrintSettingsError("PRINTED_SIDE_LIMIT_EXCEEDED", {
      printedSides,
      maxPrintedSides: context.limits.maxPrintedSides
    });
  }

  return {
    copies: input.copies,
    duplex: input.duplex,
    paperSize: input.paperSize,
    orientation: input.orientation,
    pagesPerSheet: input.pagesPerSheet,
    scaling: input.scaling,
    collate: input.collate,
    colorMode: PRINT_COLOR_MODE,
    capabilityVersion: context.capabilities.version,
    files,
    selectedPages,
    printedSidesPerCopy,
    printedSides,
    physicalSheets
  };
}

/**
 * The immutable description a quote, a payment, and later a print job all
 * agree on. It binds the exact document bytes, not just the file identifiers,
 * so a replaced or reprocessed document can never inherit an old price.
 */
export function buildSettingsManifest(settings: NormalizedPrintSettings): SettingsManifest {
  return {
    manifestVersion: SETTINGS_MANIFEST_VERSION,
    colorMode: settings.colorMode,
    paperSize: settings.paperSize,
    orientation: settings.orientation,
    duplex: settings.duplex,
    pagesPerSheet: settings.pagesPerSheet,
    scaling: settings.scaling,
    collate: settings.collate,
    copies: settings.copies,
    capabilityVersion: settings.capabilityVersion,
    files: settings.files.map((file) => ({
      fileId: file.fileId,
      position: file.position,
      processingRevision: file.processingRevision,
      contentSha256: file.contentSha256,
      pageCount: file.pageCount,
      pageRanges: file.pageRanges.map(([start, end]) => [start, end]),
      selectedPages: file.selectedPages
    }))
  };
}

/**
 * Key-sorted JSON. The caller hashes this string, so the ordering must not
 * depend on how the manifest object happened to be constructed.
 */
export function canonicalManifestJson(manifest: SettingsManifest): string {
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
  throw new PrintSettingsError("UNSUPPORTED_PRINT_SETTING", { reason: "UNSERIALIZABLE_MANIFEST" });
}

function assertSupported(supported: boolean, setting: string): void {
  if (!supported) throw new PrintSettingsError("UNSUPPORTED_PRINT_SETTING", { setting });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
