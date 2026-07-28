import { createHash, timingSafeEqual } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

import { ProcessorError } from "./errors.js";

export class InputInspectionTransform extends Transform {
  private readonly hash = createHash("sha256");
  private readonly captured = Buffer.alloc(8);
  private capturedBytes = 0;
  private receivedBytes = 0;
  private digest: string | undefined;

  public constructor(
    private readonly expectedBytes: number,
    private readonly maximumBytes: number
  ) {
    super();
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    const nextBytes = this.receivedBytes + chunk.byteLength;
    if (nextBytes > this.maximumBytes || nextBytes > this.expectedBytes) {
      callback(new ProcessorError("REQUEST_TOO_LARGE", 413));
      return;
    }
    this.receivedBytes = nextBytes;
    this.hash.update(chunk);

    const remaining = this.captured.byteLength - this.capturedBytes;
    if (remaining > 0) {
      const bytesToCopy = Math.min(remaining, chunk.byteLength);
      chunk.copy(this.captured, this.capturedBytes, 0, bytesToCopy);
      this.capturedBytes += bytesToCopy;
    }
    callback(undefined, chunk);
  }

  public override _flush(callback: TransformCallback): void {
    if (this.receivedBytes !== this.expectedBytes) {
      callback(new ProcessorError("INVALID_CONTENT_LENGTH", 400));
      return;
    }
    this.digest = this.hash.digest("hex");
    callback();
  }

  public result(): { sizeBytes: number; sha256: string; firstBytes: Uint8Array } {
    if (!this.digest) throw new ProcessorError("INTERNAL_ERROR", 500, true);
    return {
      sizeBytes: this.receivedBytes,
      sha256: this.digest,
      firstBytes: Buffer.from(this.captured.subarray(0, this.capturedBytes))
    };
  }
}

export class OutputLimitTransform extends Transform {
  private emittedBytes = 0;

  public constructor(private readonly maximumBytes: number) {
    super();
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.emittedBytes += chunk.byteLength;
    if (this.emittedBytes > this.maximumBytes) {
      callback(new ProcessorError("OUTPUT_SIZE_LIMIT_EXCEEDED", 422));
      return;
    }
    callback(undefined, chunk);
  }
}

export function equalSha256(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.byteLength === 32 &&
    rightBytes.byteLength === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function hasExpectedSignature(kind: "PDF" | "JPEG" | "PNG", bytes: Uint8Array): boolean {
  const signature =
    kind === "PDF"
      ? [0x25, 0x50, 0x44, 0x46, 0x2d]
      : kind === "JPEG"
        ? [0xff, 0xd8, 0xff]
        : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => bytes[index] === byte);
}
