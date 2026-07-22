import { describe, expect, it } from "vitest";

import { PreliminaryFileValidationError, validatePreliminaryFile } from "./index.js";

describe("validatePreliminaryFile", () => {
  it.each([
    ["application/pdf", "private-name.pdf", [0x25, 0x50, 0x44, 0x46, 0x2d], "PDF"],
    ["image/jpeg", "photo.JPEG", [0xff, 0xd8, 0xff], "JPEG"],
    ["image/png", "scan.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG"]
  ] as const)("accepts a bounded %s signature", (declaredMime, filename, firstBytes, kind) => {
    expect(
      validatePreliminaryFile({
        declaredMime,
        filename,
        firstBytes: Uint8Array.from(firstBytes),
        sizeBytes: firstBytes.length
      })
    ).toMatchObject({ kind });
  });

  it("rejects an empty file", () => {
    expectValidationCode(
      () =>
        validatePreliminaryFile({
          declaredMime: "application/pdf",
          filename: "empty.pdf",
          firstBytes: new Uint8Array(),
          sizeBytes: 0
        }),
      "EMPTY_FILE"
    );
  });

  it.each([
    ["application/pdf", "spoof.pdf", [0xff, 0xd8, 0xff]],
    ["image/png", "spoof.png", [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ["image/jpeg", "spoof.jpg", [0x89, 0x50, 0x4e, 0x47]]
  ] as const)("rejects a spoofed %s signature", (declaredMime, filename, firstBytes) => {
    expectValidationCode(
      () =>
        validatePreliminaryFile({
          declaredMime,
          filename,
          firstBytes: Uint8Array.from(firstBytes),
          sizeBytes: firstBytes.length
        }),
      "FILE_SIGNATURE_MISMATCH"
    );
  });

  it("requires the extension and MIME type to agree", () => {
    expectValidationCode(
      () =>
        validatePreliminaryFile({
          declaredMime: "image/png",
          filename: "wrong.pdf",
          firstBytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          sizeBytes: 8
        }),
      "UNSUPPORTED_MEDIA_TYPE"
    );
  });
});

function expectValidationCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("EXPECTED_VALIDATION_ERROR");
  } catch (error) {
    expect(error).toBeInstanceOf(PreliminaryFileValidationError);
    expect((error as PreliminaryFileValidationError).code).toBe(code);
  }
}
