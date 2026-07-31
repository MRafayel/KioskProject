import {
  DUPLEX_MODES,
  ORIENTATIONS,
  PAPER_SIZES,
  PRINT_COLOR_MODE,
  SCALING_MODES,
  type ColorMode,
  type DuplexMode,
  type Orientation,
  type PaperSize,
  type PrinterCapabilities,
  type PrintSettingsLimits,
  type ScalingMode
} from "@printing-kiosk/domain";

export interface KioskCapabilityRow {
  capabilities: unknown;
  capabilitiesVersion: number;
}

/**
 * Read a kiosk capability snapshot defensively.
 *
 * The row is operational data that predates Phase 6 on existing kiosks and
 * that a fleet tool will later write. Unknown or missing fields fall back to
 * the conservative pilot defaults instead of failing a customer's session, and
 * anything the snapshot does not clearly support is simply not offered.
 */
export function readPrinterCapabilities(
  kiosk: KioskCapabilityRow,
  limits: PrintSettingsLimits
): PrinterCapabilities {
  const snapshot = asRecord(kiosk.capabilities);
  const declaredDuplex = readEnumList(snapshot.duplexModes, DUPLEX_MODES);
  const duplexModes: DuplexMode[] =
    declaredDuplex.length > 0
      ? declaredDuplex
      : snapshot.duplex === true
        ? ["SIMPLEX", "LONG_EDGE"]
        : ["SIMPLEX"];

  const paperSizes = readEnumList(snapshot.paperSizes, PAPER_SIZES);
  const orientations = readEnumList(snapshot.orientations, ORIENTATIONS);
  const scalingModes = readEnumList(snapshot.scalingModes, SCALING_MODES);
  const declaredColorModes = readEnumList(snapshot.colorModes, [PRINT_COLOR_MODE] as const);
  const colorModes: ColorMode[] =
    declaredColorModes.length > 0
      ? declaredColorModes
      : snapshot.outputMode === PRINT_COLOR_MODE
        ? [PRINT_COLOR_MODE]
        : [];

  const declaredMaxCopies = readPositiveInteger(snapshot.maxCopies);

  return {
    version: kiosk.capabilitiesVersion,
    paperSizes: paperSizes.length > 0 ? paperSizes : ["A4"],
    colorModes,
    duplexModes,
    orientations: orientations.length > 0 ? orientations : [...ORIENTATIONS],
    scalingModes: scalingModes.length > 0 ? scalingModes : [...SCALING_MODES],
    maxCopies: Math.min(declaredMaxCopies ?? limits.maxCopies, limits.maxCopies)
  };
}

export type SupportedPaperSize = PaperSize;
export type SupportedOrientation = Orientation;
export type SupportedScalingMode = ScalingMode;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readEnumList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  const selected = allowed.filter((option) => value.includes(option));
  return selected;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
