export const ALLOWED_UPLOAD_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];
export type PreliminaryFileKind = "PDF" | "JPEG" | "PNG";
export type FileValidationCode =
  | "EMPTY_FILE"
  | "UNSUPPORTED_FILE_EXTENSION"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "FILE_SIGNATURE_MISMATCH";

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
