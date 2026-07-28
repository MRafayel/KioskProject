export const ALLOWED_UPLOAD_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];
export type PreliminaryFileKind = "PDF" | "JPEG" | "PNG";
export type FileValidationCode =
  | "EMPTY_FILE"
  | "UNSUPPORTED_FILE_EXTENSION"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "FILE_SIGNATURE_MISMATCH";

/**
 * Stable, customer-safe rejection codes. Parser stderr, executable names,
 * object keys and local paths must never be used as rejection codes.
 */
export type PublicDocumentRejectionCode =
  | "UPLOAD_FAILED"
  | "MALWARE_DETECTED"
  | "MALWARE_SCAN_UNAVAILABLE"
  | "DOCUMENT_ENCRYPTED"
  | "DOCUMENT_MALFORMED"
  | "PAGE_LIMIT_EXCEEDED"
  | "IMAGE_DIMENSION_LIMIT_EXCEEDED"
  | "IMAGE_PIXEL_LIMIT_EXCEEDED"
  | "OUTPUT_SIZE_LIMIT_EXCEEDED"
  | "UNSUPPORTED_DOCUMENT_CONTENT"
  | "PROCESSING_TIMEOUT"
  | "PROCESSING_FAILED";

export type DocumentLimitRejectionCode =
  | "PAGE_LIMIT_EXCEEDED"
  | "IMAGE_DIMENSION_LIMIT_EXCEEDED"
  | "IMAGE_PIXEL_LIMIT_EXCEEDED"
  | "OUTPUT_SIZE_LIMIT_EXCEEDED"
  | "PROCESSING_FAILED";

export interface DocumentProcessingLimits {
  maxPages: number;
  maxImageDimensionPixels: number;
  maxImagePixels: number;
  maxNormalizedBytes: number;
  maxPreviewBytesPerPage: number;
}

export interface DeepDocumentMetadata {
  pageCount: number;
  images: ReadonlyArray<{
    widthPixels: number;
    heightPixels: number;
  }>;
  normalizedSizeBytes?: number;
  previewSizeBytes?: ReadonlyArray<number>;
}

export interface PreliminaryFileInput {
  declaredMime: string;
  filename: string;
  firstBytes: Uint8Array;
  sizeBytes: number;
}

export interface PreliminaryFileResult {
  kind: PreliminaryFileKind;
  detectedMime: AllowedUploadMimeType;
  extension: "pdf" | "jpg" | "png";
}

export class PreliminaryFileValidationError extends Error {
  public constructor(public readonly code: FileValidationCode) {
    super(code);
    this.name = "PreliminaryFileValidationError";
  }
}

export class DocumentLimitError extends Error {
  public constructor(public readonly code: DocumentLimitRejectionCode) {
    super(code);
    this.name = "DocumentLimitError";
  }
}

const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdfSignature = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const jpegSignature = Uint8Array.from([0xff, 0xd8, 0xff]);

export function validatePreliminaryFile(input: PreliminaryFileInput): PreliminaryFileResult {
  if (input.sizeBytes === 0) throw new PreliminaryFileValidationError("EMPTY_FILE");

  const declared = byDeclaredType(input.declaredMime, input.filename);
  if (!declared) {
    const extension = readExtension(input.filename);
    throw new PreliminaryFileValidationError(
      extension ? "UNSUPPORTED_MEDIA_TYPE" : "UNSUPPORTED_FILE_EXTENSION"
    );
  }

  if (!startsWithBytes(input.firstBytes, declared.signature)) {
    throw new PreliminaryFileValidationError("FILE_SIGNATURE_MISMATCH");
  }

  return {
    kind: declared.kind,
    detectedMime: declared.mime,
    extension: declared.canonicalExtension
  };
}

/**
 * Validates metadata returned by an isolated decoder before it can be committed
 * as READY. The decoder itself must still enforce memory, CPU, disk and time
 * limits while discovering this metadata.
 */
export function validateDeepDocumentMetadata(
  metadata: DeepDocumentMetadata,
  limits: DocumentProcessingLimits
): void {
  assertPositiveSafeInteger(metadata.pageCount);
  assertPositiveSafeInteger(limits.maxPages);
  assertPositiveSafeInteger(limits.maxImageDimensionPixels);
  assertPositiveSafeInteger(limits.maxImagePixels);
  assertPositiveSafeInteger(limits.maxNormalizedBytes);
  assertPositiveSafeInteger(limits.maxPreviewBytesPerPage);

  if (metadata.pageCount > limits.maxPages) {
    throw new DocumentLimitError("PAGE_LIMIT_EXCEEDED");
  }

  for (const image of metadata.images) {
    assertPositiveSafeInteger(image.widthPixels);
    assertPositiveSafeInteger(image.heightPixels);
    if (
      image.widthPixels > limits.maxImageDimensionPixels ||
      image.heightPixels > limits.maxImageDimensionPixels
    ) {
      throw new DocumentLimitError("IMAGE_DIMENSION_LIMIT_EXCEEDED");
    }
    // Division avoids an overflowing multiplication in runtimes with bounded
    // numeric integer types and makes the intended limit explicit.
    if (image.widthPixels > Math.floor(limits.maxImagePixels / image.heightPixels)) {
      throw new DocumentLimitError("IMAGE_PIXEL_LIMIT_EXCEEDED");
    }
  }

  if (
    metadata.normalizedSizeBytes !== undefined &&
    (!Number.isSafeInteger(metadata.normalizedSizeBytes) ||
      metadata.normalizedSizeBytes <= 0 ||
      metadata.normalizedSizeBytes > limits.maxNormalizedBytes)
  ) {
    throw new DocumentLimitError("OUTPUT_SIZE_LIMIT_EXCEEDED");
  }

  if (
    metadata.previewSizeBytes?.some(
      (sizeBytes) =>
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes <= 0 ||
        sizeBytes > limits.maxPreviewBytesPerPage
    )
  ) {
    throw new DocumentLimitError("OUTPUT_SIZE_LIMIT_EXCEEDED");
  }
}

/**
 * Converts private implementation failures into the deliberately small public
 * vocabulary. Unknown values fail closed without leaking processor details.
 */
export function toPublicDocumentRejectionCode(privateCode: string): PublicDocumentRejectionCode {
  switch (privateCode) {
    case "EMPTY_FILE":
    case "UPLOAD_BODY_ABORTED":
    case "UPLOAD_STREAM_FAILED":
      return "UPLOAD_FAILED";
    case "CLAMAV_SIGNATURE_FOUND":
      return "MALWARE_DETECTED";
    case "MALWARE_SCANNER_STALE":
    case "MALWARE_SCANNER_UNAVAILABLE":
      return "MALWARE_SCAN_UNAVAILABLE";
    case "PDF_PASSWORD_REQUIRED":
    case "PDF_ENCRYPTED":
      return "DOCUMENT_ENCRYPTED";
    case "PDF_PARSE_FAILED":
    case "IMAGE_DECODE_FAILED":
    case "DOCUMENT_TRUNCATED":
      return "DOCUMENT_MALFORMED";
    case "PAGE_LIMIT_EXCEEDED":
    case "IMAGE_DIMENSION_LIMIT_EXCEEDED":
    case "IMAGE_PIXEL_LIMIT_EXCEEDED":
    case "OUTPUT_SIZE_LIMIT_EXCEEDED":
      return privateCode;
    case "UNSUPPORTED_DOCUMENT_CONTENT":
      return "UNSUPPORTED_DOCUMENT_CONTENT";
    case "PROCESSOR_TIMEOUT":
      return "PROCESSING_TIMEOUT";
    default:
      return "PROCESSING_FAILED";
  }
}

function byDeclaredType(declaredMime: string, filename: string) {
  const extension = readExtension(filename);
  if (!extension) return undefined;

  if (declaredMime === "application/pdf" && extension === "pdf") {
    return {
      kind: "PDF" as const,
      mime: "application/pdf" as const,
      canonicalExtension: "pdf" as const,
      signature: pdfSignature
    };
  }
  if (declaredMime === "image/jpeg" && (extension === "jpg" || extension === "jpeg")) {
    return {
      kind: "JPEG" as const,
      mime: "image/jpeg" as const,
      canonicalExtension: "jpg" as const,
      signature: jpegSignature
    };
  }
  if (declaredMime === "image/png" && extension === "png") {
    return {
      kind: "PNG" as const,
      mime: "image/png" as const,
      canonicalExtension: "png" as const,
      signature: pngSignature
    };
  }
  return undefined;
}

function readExtension(filename: string): string | undefined {
  const match = filename.match(/\.([A-Za-z0-9]{1,5})$/);
  return match?.[1]?.toLowerCase();
}

function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.byteLength < prefix.byteLength) return false;
  return prefix.every((byte, index) => value[index] === byte);
}

function assertPositiveSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DocumentLimitError("PROCESSING_FAILED");
  }
}
