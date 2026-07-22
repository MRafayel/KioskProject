import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { describe, expect, it } from "vitest";

import { UploadInspectionTransform, UploadSizeLimitError } from "./upload-inspection.js";

describe("UploadInspectionTransform", () => {
  it("streams bytes while calculating size and SHA-256", async () => {
    const inspection = new UploadInspectionTransform({ maxBytes: 64, captureBytes: 8 });
    const received: Buffer[] = [];

    await pipeline(
      Readable.from([Buffer.from("private"), Buffer.from(" document")]),
      inspection,
      collectingSink(received)
    );

    const expected = Buffer.from("private document");
    const result = inspection.getResult();
    expect(Buffer.concat(received)).toEqual(expected);
    expect(result.sizeBytes).toBe(expected.byteLength);
    expect(result.sha256Digest).toEqual(createHash("sha256").update(expected).digest());
  });

  it("captures a bounded prefix even when the signature spans chunks", async () => {
    const inspection = new UploadInspectionTransform({ maxBytes: 64, captureBytes: 8 });

    await pipeline(
      Readable.from([
        Buffer.from([0x89, 0x50]),
        Buffer.from([0x4e, 0x47, 0x0d]),
        Buffer.from([0x0a, 0x1a, 0x0a, 0x01, 0x02])
      ]),
      inspection,
      collectingSink([])
    );

    expect(Array.from(inspection.getResult().firstBytes)).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]);
  });

  it("fails before forwarding a chunk that crosses the hard limit", async () => {
    const inspection = new UploadInspectionTransform({ maxBytes: 5, captureBytes: 8 });
    const received: Buffer[] = [];

    await expect(
      pipeline(
        Readable.from([Buffer.from("123"), Buffer.from("456")]),
        inspection,
        collectingSink(received)
      )
    ).rejects.toBeInstanceOf(UploadSizeLimitError);

    expect(Buffer.concat(received).toString("utf8")).toBe("123");
    expect(() => inspection.getResult()).toThrow("Upload inspection is not complete.");
  });

  it("propagates an interrupted source and never exposes a partial digest", async () => {
    const interruption = new Error("synthetic upload connection closed");
    const inspection = new UploadInspectionTransform({ maxBytes: 64, captureBytes: 8 });
    const source = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(interruption);
      }
    });

    await expect(pipeline(source, inspection, collectingSink([]))).rejects.toBe(interruption);

    expect(source.destroyed).toBe(true);
    expect(inspection.destroyed).toBe(true);
    expect(() => inspection.getResult()).toThrow("Upload inspection is not complete.");
  });

  it("rejects invalid limits at construction time", () => {
    expect(() => new UploadInspectionTransform({ maxBytes: 0 })).toThrow(TypeError);
    expect(() => new UploadInspectionTransform({ maxBytes: 1, captureBytes: Number.NaN })).toThrow(
      TypeError
    );
  });
});

function collectingSink(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
}
