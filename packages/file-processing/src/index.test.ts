import { describe, expect, it } from "vitest";

import {
  DocumentLimitError,
  PreliminaryFileValidationError,
  toPublicDocumentRejectionCode,
  validateDeepDocumentMetadata,
  validatePreliminaryFile
} from "./index.js";

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

describe("validateDeepDocumentMetadata", () => {
  const limits = {
    maxPages: 200,
    maxImageDimensionPixels: 20_000,
    maxImagePixels: 40_000_000,
    maxNormalizedBytes: 104_857_600,
    maxPreviewBytesPerPage: 2_097_152
  };

  it("accepts bounded page, image and derivative metadata", () => {
    expect(() =>
      validateDeepDocumentMetadata(
        {
          pageCount: 2,
          images: [
            { widthPixels: 2_000, heightPixels: 3_000 },
            { widthPixels: 1_200, heightPixels: 1_600 }
          ],
          normalizedSizeBytes: 10_000,
          previewSizeBytes: [1_000, 1_200]
        },
        limits
      )
    ).not.toThrow();
  });

  it.each([
    [
      {
        pageCount: 201,
        images: []
      },
      "PAGE_LIMIT_EXCEEDED"
    ],
    [
      {
        pageCount: 1,
        images: [{ widthPixels: 20_001, heightPixels: 1 }]
      },
      "IMAGE_DIMENSION_LIMIT_EXCEEDED"
    ],
    [
      {
        pageCount: 1,
        images: [{ widthPixels: 10_000, heightPixels: 10_000 }]
      },
      "IMAGE_PIXEL_LIMIT_EXCEEDED"
    ],
    [
      {
        pageCount: 1,
        images: [],
        normalizedSizeBytes: 104_857_601
      },
      "OUTPUT_SIZE_LIMIT_EXCEEDED"
    ]
  ] as const)("rejects metadata outside resource limits", (metadata, expectedCode) => {
    try {
      validateDeepDocumentMetadata(metadata, limits);
      throw new Error("EXPECTED_VALIDATION_ERROR");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentLimitError);
      expect((error as DocumentLimitError).code).toBe(expectedCode);
    }
  });
});

describe("toPublicDocumentRejectionCode", () => {
  it("maps known private errors and fails closed for unknown details", () => {
    expect(toPublicDocumentRejectionCode("PDF_PASSWORD_REQUIRED")).toBe("DOCUMENT_ENCRYPTED");
    expect(toPublicDocumentRejectionCode("PROCESSOR_TIMEOUT")).toBe("PROCESSING_TIMEOUT");
    expect(toPublicDocumentRejectionCode("qpdf exited 139 at /private/customer.pdf")).toBe(
      "PROCESSING_FAILED"
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
