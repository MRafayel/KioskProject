import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { describe, expect, it } from "vitest";

import { InputInspectionTransform, hasExpectedSignature } from "./streams.js";

describe("bounded input inspection", () => {
  it("counts and hashes an exact fixed-size body", async () => {
    const input = Buffer.from("%PDF-1.7", "utf8");
    const inspection = new InputInspectionTransform(input.byteLength, 100);
    await pipeline(Readable.from(input), inspection, sink());

    expect(inspection.result()).toMatchObject({
      sizeBytes: input.byteLength,
      sha256: "86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b"
    });
    expect(hasExpectedSignature("PDF", inspection.result().firstBytes)).toBe(true);
  });

  it("rejects a body larger than its declared length", async () => {
    const inspection = new InputInspectionTransform(4, 100);
    await expect(
      pipeline(Readable.from(Buffer.from("12345")), inspection, sink())
    ).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
  });

  it("distinguishes all supported signatures", () => {
    expect(hasExpectedSignature("JPEG", Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))).toBe(true);
    expect(
      hasExpectedSignature("PNG", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ).toBe(true);
    expect(hasExpectedSignature("PDF", Uint8Array.from([0xff, 0xd8, 0xff]))).toBe(false);
  });
});

function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
}
