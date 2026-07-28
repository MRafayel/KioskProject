export type ProcessorErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_AUTHENTICATION"
  | "INVALID_CONTENT_LENGTH"
  | "INVALID_CONTENT_TYPE"
  | "INVALID_DOCUMENT_KIND"
  | "INVALID_PROTOCOL_VERSION"
  | "INVALID_REQUEST"
  | "CONTENT_HASH_MISMATCH"
  | "EMPTY_FILE"
  | "REQUEST_TOO_LARGE"
  | "PROCESSOR_BUSY"
  | "PROCESSOR_CAPACITY_EXHAUSTED"
  | "PROCESSING_TIMEOUT"
  | "OUTPUT_SIZE_LIMIT_EXCEEDED"
  | "MALWARE_DETECTED"
  | "MALWARE_SCANNER_STALE"
  | "MALWARE_SCANNER_UNAVAILABLE"
  | "PASSWORD_PROTECTED_PDF"
  | "MALFORMED_DOCUMENT"
  | "PAGE_LIMIT_EXCEEDED"
  | "IMAGE_DIMENSION_LIMIT_EXCEEDED"
  | "IMAGE_PIXEL_LIMIT_EXCEEDED"
  | "UNSUPPORTED_DOCUMENT_CONTENT"
  | "NATIVE_TOOL_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class ProcessorError extends Error {
  public constructor(
    public readonly code: ProcessorErrorCode,
    public readonly statusCode: number,
    public readonly retryable = false
  ) {
    super(code);
    this.name = "ProcessorError";
  }
}

export function safeProcessorError(error: unknown): ProcessorError {
  if (error instanceof ProcessorError) return error;
  if (isAbortError(error)) {
    return new ProcessorError("PROCESSING_TIMEOUT", 422);
  }
  if (isResourceCapacityError(error)) {
    return new ProcessorError("PROCESSOR_CAPACITY_EXHAUSTED", 503, true);
  }
  return new ProcessorError("INTERNAL_ERROR", 500, true);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error !== null &&
      typeof error === "object" &&
      "code" in error &&
      Reflect.get(error, "code") === "ABORT_ERR")
  );
}

export function isResourceCapacityError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = Reflect.get(error, "code");
  return code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG";
}
