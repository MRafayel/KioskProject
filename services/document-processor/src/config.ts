import { resolve } from "node:path";

import { RASTER_FORMATS, type RasterFormat } from "./types.js";

export interface ProcessorConfig {
  host: string;
  port: number;
  authToken: string;
  scratchDirectory: string;
  maxInputBytes: number;
  maxResponseBytes: number;
  maxNormalizedBytes: number;
  maxPreviewBytes: number;
  maxPages: number;
  maxImagePixels: number;
  maxImageDimension: number;
  maximumRasterDimension: number;
  /** Encoding of the scratch page raster handed from Poppler to Sharp. */
  rasterFormat: RasterFormat;
  /** zlib effort for the canonical page PNG embedded in the normalized PDF. */
  canonicalPngCompressionLevel: number;
  canonicalPngAdaptiveFiltering: boolean;
  /** libwebp search effort for page previews. */
  previewWebpEffort: number;
  previewWidth: number;
  previewHeight: number;
  processTimeoutMilliseconds: number;
  toolTimeoutMilliseconds: number;
  scannerTimeoutMilliseconds: number;
  scannerDefinitionMaxAgeMilliseconds: number;
  /** Emit one per-request stage-timing line. Off unless explicitly enabled. */
  timingLog: boolean;
  /** Additionally retain per-page samples. Implies `timingLog`. */
  timingDetail: boolean;
  clamavSocketPath?: string;
  clamavHost?: string;
  clamavPort?: number;
}

const MEBIBYTE = 1024 * 1024;

export function loadProcessorConfig(source: NodeJS.ProcessEnv = process.env): ProcessorConfig {
  const authToken = requiredString(
    source.PROCESSOR_AUTH_TOKEN ?? source.DOCUMENT_PROCESSOR_AUTH_TOKEN,
    "PROCESSOR_AUTH_TOKEN"
  );
  if (Buffer.byteLength(authToken, "utf8") < 32) {
    throw new Error("PROCESSOR_AUTH_TOKEN_TOO_SHORT");
  }

  const timingDetail = boolean(source.PROCESSOR_TIMING_DETAIL, false, "PROCESSOR_TIMING_DETAIL");
  const timingLog =
    timingDetail || boolean(source.PROCESSOR_TIMING_LOG, false, "PROCESSOR_TIMING_LOG");

  const clamavSocketPath = optionalString(source.CLAMAV_SOCKET_PATH);
  const clamavHost = optionalString(source.CLAMAV_HOST);
  if (!clamavSocketPath && !clamavHost) {
    throw new Error("CLAMAV_ENDPOINT_REQUIRED");
  }
  if (clamavSocketPath && clamavHost) {
    throw new Error("CLAMAV_ENDPOINT_AMBIGUOUS");
  }

  const config: ProcessorConfig = {
    host: source.PROCESSOR_HOST ?? "127.0.0.1",
    port: integer(source.PROCESSOR_PORT, 3200, 1, 65_535, "PROCESSOR_PORT"),
    authToken,
    scratchDirectory: resolve(source.PROCESSOR_SCRATCH_DIR ?? "./var/document-processor"),
    maxInputBytes: integer(
      source.PROCESSOR_MAX_INPUT_BYTES ?? source.MAX_FILE_BYTES,
      50 * MEBIBYTE,
      1_024,
      100 * MEBIBYTE,
      "PROCESSOR_MAX_INPUT_BYTES"
    ),
    maxResponseBytes: integer(
      source.PROCESSOR_MAX_RESPONSE_BYTES,
      512 * MEBIBYTE,
      1 * MEBIBYTE,
      2_147_000_000,
      "PROCESSOR_MAX_RESPONSE_BYTES"
    ),
    maxNormalizedBytes: integer(
      source.PROCESSOR_MAX_NORMALIZED_BYTES ?? source.MAX_NORMALIZED_FILE_BYTES,
      100 * MEBIBYTE,
      1_024,
      500 * MEBIBYTE,
      "PROCESSOR_MAX_NORMALIZED_BYTES"
    ),
    maxPreviewBytes: integer(
      source.PROCESSOR_MAX_PREVIEW_BYTES ?? source.MAX_PREVIEW_FILE_BYTES,
      2 * MEBIBYTE,
      1_024,
      20 * MEBIBYTE,
      "PROCESSOR_MAX_PREVIEW_BYTES"
    ),
    maxPages: integer(
      source.PROCESSOR_MAX_PAGES ?? source.MAX_DOCUMENT_PAGES,
      200,
      1,
      1_000,
      "PROCESSOR_MAX_PAGES"
    ),
    maxImagePixels: integer(
      source.PROCESSOR_MAX_IMAGE_PIXELS ?? source.MAX_IMAGE_PIXELS,
      40_000_000,
      1_000_000,
      200_000_000,
      "PROCESSOR_MAX_IMAGE_PIXELS"
    ),
    maxImageDimension: integer(
      source.PROCESSOR_MAX_IMAGE_DIMENSION ?? source.MAX_IMAGE_DIMENSION_PIXELS,
      20_000,
      1_000,
      100_000,
      "PROCESSOR_MAX_IMAGE_DIMENSION"
    ),
    maximumRasterDimension: integer(
      source.PROCESSOR_MAX_RASTER_DIMENSION,
      3_508,
      1_000,
      10_000,
      "PROCESSOR_MAX_RASTER_DIMENSION"
    ),
    rasterFormat: enumeration(
      source.PROCESSOR_RASTER_FORMAT,
      "tiff",
      RASTER_FORMATS,
      "PROCESSOR_RASTER_FORMAT"
    ),
    // PNG is lossless, so these settings change only how many bytes encode the
    // page, never which pixels. Measured on a dense 80-page document, level 9
    // with adaptive filtering cost 82 ms per page against 10 ms for level 6
    // without it, for a 1.1% difference in size (355 KB against 359 KB).
    // Set both to the previous 9 / true to restore the old output byte-for-byte.
    canonicalPngCompressionLevel: integer(
      source.PROCESSOR_CANONICAL_PNG_COMPRESSION_LEVEL,
      6,
      0,
      9,
      "PROCESSOR_CANONICAL_PNG_COMPRESSION_LEVEL"
    ),
    canonicalPngAdaptiveFiltering: boolean(
      source.PROCESSOR_CANONICAL_PNG_ADAPTIVE_FILTERING,
      false,
      "PROCESSOR_CANONICAL_PNG_ADAPTIVE_FILTERING"
    ),
    // Unlike the canonical page, WebP is lossy: effort changes the encoder's
    // search, so lowering it alters the preview bytes. Left at the original 4.
    previewWebpEffort: integer(
      source.PROCESSOR_PREVIEW_WEBP_EFFORT,
      4,
      0,
      6,
      "PROCESSOR_PREVIEW_WEBP_EFFORT"
    ),
    previewWidth: integer(
      source.PROCESSOR_PREVIEW_WIDTH ?? source.PREVIEW_MAX_WIDTH_PIXELS,
      1_600,
      160,
      10_000,
      "PROCESSOR_PREVIEW_WIDTH"
    ),
    previewHeight: integer(
      source.PROCESSOR_PREVIEW_HEIGHT ?? source.PREVIEW_MAX_HEIGHT_PIXELS,
      2_200,
      160,
      10_000,
      "PROCESSOR_PREVIEW_HEIGHT"
    ),
    processTimeoutMilliseconds: secondsAsMilliseconds(
      source.PROCESSOR_TIMEOUT_SECONDS ?? source.DOCUMENT_PROCESSOR_TIMEOUT_SECONDS,
      120,
      10,
      600,
      "PROCESSOR_TIMEOUT_SECONDS"
    ),
    toolTimeoutMilliseconds: secondsAsMilliseconds(
      source.PROCESSOR_TOOL_TIMEOUT_SECONDS,
      20,
      1,
      120,
      "PROCESSOR_TOOL_TIMEOUT_SECONDS"
    ),
    scannerTimeoutMilliseconds: secondsAsMilliseconds(
      source.CLAMAV_TIMEOUT_SECONDS,
      30,
      1,
      120,
      "CLAMAV_TIMEOUT_SECONDS"
    ),
    scannerDefinitionMaxAgeMilliseconds:
      integer(
        source.CLAMAV_DEFINITION_MAX_AGE_HOURS,
        36,
        1,
        168,
        "CLAMAV_DEFINITION_MAX_AGE_HOURS"
      ) *
      60 *
      60 *
      1_000,
    timingLog,
    timingDetail,
    ...(clamavSocketPath ? { clamavSocketPath: resolve(clamavSocketPath) } : {}),
    ...(clamavHost
      ? {
          clamavHost,
          clamavPort: integer(source.CLAMAV_PORT, 3310, 1, 65_535, "CLAMAV_PORT")
        }
      : {})
  };

  if (config.maximumRasterDimension > config.maxImageDimension) {
    throw new Error("PROCESSOR_RASTER_DIMENSION_EXCEEDS_IMAGE_LIMIT");
  }
  if (
    config.previewWidth > config.maxImageDimension ||
    config.previewHeight > config.maxImageDimension
  ) {
    throw new Error("PROCESSOR_PREVIEW_DIMENSION_EXCEEDS_IMAGE_LIMIT");
  }
  if (config.maxNormalizedBytes >= config.maxResponseBytes) {
    throw new Error("PROCESSOR_NORMALIZED_LIMIT_EXCEEDS_RESPONSE_LIMIT");
  }
  return config;
}

function requiredString(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function enumeration<T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
  name: string
): T {
  if (value === undefined || value === "") return fallback;
  if (!allowed.includes(value as T)) throw new Error(`${name}_INVALID`);
  return value as T;
}

function boolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name}_INVALID`);
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  // An unset Compose variable arrives as an empty string, and Number("") is 0.
  // Without this an omitted setting would silently become zero rather than the
  // documented default.
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
}

function secondsAsMilliseconds(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  return integer(value, fallback, minimum, maximum, name) * 1_000;
}
