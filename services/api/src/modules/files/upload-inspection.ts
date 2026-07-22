import { createHash, type Hash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

export const PRELIMINARY_FILE_CAPTURE_BYTES = 8 * 1024;

export interface UploadInspectionOptions {
  maxBytes: number;
  captureBytes?: number;
}

export interface UploadInspectionResult {
  sizeBytes: number;
  sha256Digest: Uint8Array;
  firstBytes: Uint8Array;
}

export class UploadSizeLimitError extends Error {
  public readonly code = "FILE_TOO_LARGE";

  public constructor(public readonly maxBytes: number) {
    super("The upload exceeds the configured file-size limit.");
    this.name = "UploadSizeLimitError";
  }
}

export class UploadInspectionTransform extends Transform {
  private readonly maxBytes: number;
  private readonly captured: Buffer;
  private readonly hash: Hash = createHash("sha256");
  private capturedBytes = 0;
  private sizeBytes = 0;
  private digest: Buffer | undefined;

  public constructor(options: UploadInspectionOptions) {
    super();
    assertPositiveInteger(options.maxBytes, "maxBytes");
    const captureBytes = options.captureBytes ?? PRELIMINARY_FILE_CAPTURE_BYTES;
    assertPositiveInteger(captureBytes, "captureBytes");

    this.maxBytes = options.maxBytes;
    this.captured = Buffer.allocUnsafe(captureBytes);
  }

  public getResult(): UploadInspectionResult {
    if (!this.digest) {
      throw new Error("Upload inspection is not complete.");
    }

    return {
      sizeBytes: this.sizeBytes,
      sha256Digest: Buffer.from(this.digest),
      firstBytes: Buffer.from(this.captured.subarray(0, this.capturedBytes))
    };
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    const nextSize = this.sizeBytes + chunk.byteLength;
    if (nextSize > this.maxBytes) {
      callback(new UploadSizeLimitError(this.maxBytes));
      return;
    }

    this.sizeBytes = nextSize;
    this.hash.update(chunk);

    const remainingCaptureBytes = this.captured.byteLength - this.capturedBytes;
    if (remainingCaptureBytes > 0) {
      const bytesToCopy = Math.min(chunk.byteLength, remainingCaptureBytes);
      chunk.copy(this.captured, this.capturedBytes, 0, bytesToCopy);
      this.capturedBytes += bytesToCopy;
    }

    callback(undefined, chunk);
  }

  public override _flush(callback: TransformCallback): void {
    this.digest = this.hash.digest();
    callback();
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}
