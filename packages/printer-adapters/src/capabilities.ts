import { createHash } from "node:crypto";

import { PRINT_CAPABILITY_SNAPSHOT_VERSION, type PrinterCapabilitiesSnapshot } from "./types.js";

/**
 * Turning what a device says it can do into what a customer may be offered.
 *
 * Two devices describe the same tray in different words — an IPP printer says
 * `iso_a4_210x297mm`, a Windows driver says `A4` — and neither vocabulary is
 * closed: a queue can advertise a media name nobody here has seen. So the
 * mapping is an allowlist in both directions. A term this module recognises
 * becomes an option; anything else is simply not offered, because a capability
 * guessed at is one a paid quote can promise and the hardware can refuse.
 *
 * Orientation and scaling are not asked of the device at all. The document
 * processor bakes both into the print-ready PDF before a queue ever sees it, so
 * they are host capabilities and are reported as fully supported.
 */

/** What a device declared, in whatever vocabulary it used. */
export interface DeviceCapabilityDeclaration {
  /** `media-supported`, or the Windows PageMediaSize option names. */
  mediaSizes?: readonly string[];
  /** `sides-supported`, or the Windows Duplexing option names. */
  sides?: readonly string[];
  /** `print-color-mode-supported`, or the Windows OutputColor option names. */
  colorModes?: readonly string[];
  /** The upper bound of `copies-supported`, or the driver's maximum. */
  maxCopies?: number | null;
  /**
   * A device that says nothing about `sides` but does report a duplex unit.
   * Used only when the vocabulary above yielded nothing.
   */
  duplexSupported?: boolean;
}

export interface CapabilityMappingLimits {
  /** The deployment's own ceiling. A device may never raise it. */
  maxCopies: number;
}

const PAPER_SIZE_TERMS: Record<string, string> = {
  a4: "A4",
  isoa4: "A4",
  isoa4210x297mm: "A4",
  a4210x297mm: "A4",
  iso_a4: "A4"
};

const DUPLEX_TERMS: Record<string, string> = {
  onesided: "SIMPLEX",
  simplex: "SIMPLEX",
  twosidedlongedge: "LONG_EDGE",
  duplextumblelong: "LONG_EDGE",
  longedgebinding: "LONG_EDGE"
};

const COLOR_TERMS: Record<string, string> = {
  monochrome: "MONOCHROME",
  automonochrome: "MONOCHROME",
  processmonochrome: "MONOCHROME",
  bilevel: "MONOCHROME",
  processbilevel: "MONOCHROME",
  grayscale: "MONOCHROME",
  greyscale: "MONOCHROME"
};

/** Product policy: the normalized A4 PDF decides orientation and is fitted safely. */
const HOST_ORIENTATIONS = ["AUTO"] as const;
const HOST_SCALING_MODES = ["FIT"] as const;

/** The order options are reported in, so an unchanged device hashes the same. */
const PAPER_SIZE_ORDER = ["A4"];
const DUPLEX_ORDER = ["SIMPLEX", "LONG_EDGE"];
const COLOR_ORDER = ["MONOCHROME"];

export function mapDeviceCapabilities(
  declaration: DeviceCapabilityDeclaration,
  limits: CapabilityMappingLimits
): PrinterCapabilitiesSnapshot {
  const paperSizes = mapTerms(declaration.mediaSizes, PAPER_SIZE_TERMS, PAPER_SIZE_ORDER);
  const colorModes = mapTerms(declaration.colorModes, COLOR_TERMS, COLOR_ORDER);

  const declaredDuplex = mapTerms(declaration.sides, DUPLEX_TERMS, DUPLEX_ORDER);
  // A device that names no sides vocabulary at all still prints one-sided; the
  // duplex flag is the only thing that may add the two-sided options, and it
  // adds the conservative one.
  const duplexModes =
    declaredDuplex.length > 0
      ? declaredDuplex
      : declaration.duplexSupported === true
        ? ["SIMPLEX", "LONG_EDGE"]
        : ["SIMPLEX"];

  const declaredCopies =
    typeof declaration.maxCopies === "number" &&
    Number.isSafeInteger(declaration.maxCopies) &&
    declaration.maxCopies > 0
      ? declaration.maxCopies
      : limits.maxCopies;

  return {
    version: PRINT_CAPABILITY_SNAPSHOT_VERSION,
    paperSizes,
    duplexModes,
    colorModes,
    orientations: [...HOST_ORIENTATIONS],
    scalingModes: [...HOST_SCALING_MODES],
    maxCopies: Math.min(declaredCopies, limits.maxCopies)
  };
}

/**
 * A stable digest of one snapshot.
 *
 * The agent re-reads capabilities on a schedule and the control plane bumps the
 * kiosk's capability version when they change — which invalidates open quotes.
 * Comparing digests rather than objects is what keeps a device that answered in
 * a different attribute order from looking like a device that was replaced.
 */
export function capabilitySnapshotHash(snapshot: PrinterCapabilitiesSnapshot): string {
  const canonical = JSON.stringify([
    snapshot.version,
    [...snapshot.paperSizes].sort(),
    [...snapshot.duplexModes].sort(),
    [...snapshot.colorModes].sort(),
    [...snapshot.orientations].sort(),
    [...snapshot.scalingModes].sort(),
    snapshot.maxCopies
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Compare terms with separators and case removed. `two-sided-long-edge`,
 * `TwoSidedLongEdge` and `two sided long edge` are one option, and a device is
 * not penalised for its punctuation.
 */
function normalizeTerm(value: string): string {
  return value.replace(/[\s._-]/gu, "").toLocaleLowerCase("en-US");
}

function mapTerms(
  declared: readonly string[] | undefined,
  vocabulary: Record<string, string>,
  order: readonly string[]
): string[] {
  if (!Array.isArray(declared)) return [];
  const mapped = new Set<string>();
  for (const entry of declared) {
    if (typeof entry !== "string") continue;
    const known = vocabulary[normalizeTerm(entry)];
    if (known) mapped.add(known);
  }
  return order.filter((option) => mapped.has(option));
}

/** The device vocabulary a manifest value is submitted as. */
export const IPP_SIDES_BY_DUPLEX_MODE: Readonly<Record<string, string>> = {
  SIMPLEX: "one-sided",
  LONG_EDGE: "two-sided-long-edge",
  SHORT_EDGE: "two-sided-short-edge"
};

export const IPP_MEDIA_BY_PAPER_SIZE: Readonly<Record<string, string>> = {
  A4: "iso_a4_210x297mm"
};

export const IPP_COLOR_MODE_BY_COLOR_MODE: Readonly<Record<string, string>> = {
  MONOCHROME: "monochrome"
};
