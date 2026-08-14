import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildSettingsManifest,
  calculateSheetUsage,
  canonicalManifestJson,
  countSelectedPages,
  formatPageRanges,
  normalizePrintSettings,
  parsePageRangeText,
  type DuplexMode,
  type NormalizePrintSettingsContext,
  type Orientation,
  type PrintSettingsError,
  type PrintSettingsInput
} from "./print-settings.js";

const capabilities = {
  version: 2,
  paperSizes: ["A4"],
  colorModes: ["MONOCHROME"],
  duplexModes: ["SIMPLEX", "LONG_EDGE"],
  orientations: ["AUTO", "PORTRAIT", "LANDSCAPE"],
  scalingModes: ["FIT", "ACTUAL_SIZE"],
  maxCopies: 20
} as const;

const limits = { maxCopies: 20, maxSelectedPages: 200, maxPrintedSides: 1_000 };

function context(pageCount = 8): NormalizePrintSettingsContext {
  return {
    files: [
      {
        id: "0190efb7-0000-7000-8000-000000000001",
        pageCount,
        processingRevision: 1,
        contentSha256: "a".repeat(64)
      }
    ],
    capabilities,
    limits
  };
}

/**
 * Copies, duplex and orientation belong to a document, so the shorthand here
 * applies them to the single default document. A test that needs them to
 * differ between documents passes `fileSelections` itself.
 */
function settings(
  overrides: Partial<PrintSettingsInput> & {
    copies?: number;
    duplex?: DuplexMode;
    orientation?: Orientation;
  } = {}
): PrintSettingsInput {
  const { copies, duplex, orientation, ...rest } = overrides;
  return {
    fileOrder: ["0190efb7-0000-7000-8000-000000000001"],
    fileSelections: [
      {
        fileId: "0190efb7-0000-7000-8000-000000000001",
        pageRanges: null,
        copies: copies ?? 1,
        duplex: duplex ?? "SIMPLEX",
        orientation: orientation ?? "PORTRAIT"
      }
    ],
    paperSize: "A4",
    scaling: "FIT",
    collate: true,
    ...rest
  };
}

describe("page range normalization", () => {
  it("treats an empty selection as the whole document", () => {
    expect(parsePageRangeText(null, 5)).toEqual([[1, 5]]);
    expect(parsePageRangeText("  ", 5)).toEqual([[1, 5]]);
  });

  it("orders, merges, and deduplicates overlapping and adjacent ranges", () => {
    expect(parsePageRangeText("5,1-2,3,2-4", 10)).toEqual([[1, 5]]);
    expect(parsePageRangeText("7, 1-2", 10)).toEqual([
      [1, 2],
      [7, 7]
    ]);
    expect(formatPageRanges(parsePageRangeText("7, 1-2", 10))).toBe("1-2,7");
  });

  it("refuses malformed, reversed, and out-of-bounds selections", () => {
    const codes = ["1-", "a", "0", "1..3", "1,,2", "-2", "1-2-3"].map(
      (text) => attemptRangeError(text, 10).code
    );
    expect(codes).toEqual(Array.from({ length: 7 }, () => "PAGE_RANGE_INVALID"));
    expect(attemptRangeError("4-2", 10).code).toBe("PAGE_RANGE_INVALID");
    expect(attemptRangeError("9-11", 10).code).toBe("PAGE_RANGE_OUT_OF_BOUNDS");
    expect(attemptRangeError("11", 10).code).toBe("PAGE_RANGE_OUT_OF_BOUNDS");
  });

  it("bounds the accepted input length and segment count", () => {
    const manySegments = Array.from({ length: 51 }, (_, index) => index + 1).join(",");
    expect(attemptRangeError(manySegments, 200).code).toBe("PAGE_RANGE_INVALID");
    expect(attemptRangeError("1".repeat(201), 200).code).toBe("PAGE_RANGE_INVALID");
  });

  it("always produces ordered, disjoint, in-bounds ranges", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }).chain((pageCount) =>
          fc.tuple(
            fc.constant(pageCount),
            fc.array(
              fc
                .tuple(
                  fc.integer({ min: 1, max: pageCount }),
                  fc.integer({ min: 1, max: pageCount })
                )
                .map(([left, right]) => (left <= right ? `${left}-${right}` : `${right}-${left}`)),
              { minLength: 1, maxLength: 12 }
            )
          )
        ),
        ([pageCount, segments]) => {
          const ranges = parsePageRangeText(segments.join(","), pageCount);
          expect(ranges.length).toBeGreaterThan(0);
          let previousEnd: number | null = null;
          for (const [start, end] of ranges) {
            expect(start).toBeGreaterThanOrEqual(1);
            expect(start).toBeLessThanOrEqual(end);
            expect(end).toBeLessThanOrEqual(pageCount);
            // Merged output leaves a real gap between ranges, so a following
            // range never touches or continues the previous one.
            if (previousEnd !== null) expect(start).toBeGreaterThan(previousEnd + 1);
            previousEnd = end;
          }
          expect(countSelectedPages(ranges)).toBeLessThanOrEqual(pageCount);
          // Re-parsing the canonical text must be a fixed point.
          expect(parsePageRangeText(formatPageRanges(ranges), pageCount)).toEqual(ranges);
        }
      )
    );
  });
});

describe("sheet arithmetic", () => {
  it("matches the documented worked example", () => {
    // Five pages, duplex: five sides per copy on three sheets.
    expect(calculateSheetUsage({ selectedPages: 5, duplex: "LONG_EDGE" })).toEqual({
      printedSidesPerCopy: 5,
      physicalSheetsPerCopy: 3
    });
    expect(calculateSheetUsage({ selectedPages: 5, duplex: "SIMPLEX" })).toEqual({
      printedSidesPerCopy: 5,
      physicalSheetsPerCopy: 5
    });
  });

  it("rounds an odd duplex job up to a whole sheet", () => {
    const normalized = normalizePrintSettings(
      settings({ duplex: "LONG_EDGE", copies: 2 }),
      context(5)
    );
    expect(normalized.files[0]?.printedSidesPerCopy).toBe(5);
    expect(normalized.printedSides).toBe(10);
    expect(normalized.physicalSheets).toBe(6);
  });

  it("never claims fewer sides than sheets or more sheets than sides", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.constantFrom("SIMPLEX" as const, "LONG_EDGE" as const, "SHORT_EDGE" as const),
        (selectedPages, duplex) => {
          const usage = calculateSheetUsage({ selectedPages, duplex });
          expect(usage.printedSidesPerCopy).toBeGreaterThan(0);
          expect(usage.physicalSheetsPerCopy).toBeGreaterThan(0);
          expect(usage.physicalSheetsPerCopy).toBeLessThanOrEqual(usage.printedSidesPerCopy);
          expect(usage.printedSidesPerCopy).toBe(selectedPages);
        }
      )
    );
  });
});

describe("settings normalization", () => {
  it("fixes monochrome output regardless of the request", () => {
    const normalized = normalizePrintSettings(settings(), context());
    expect(normalized.colorMode).toBe("MONOCHROME");
    expect(buildSettingsManifest(normalized).colorMode).toBe("MONOCHROME");
  });

  it("refuses a setting the device does not declare", () => {
    const simplexOnly: NormalizePrintSettingsContext = {
      ...context(),
      capabilities: { ...capabilities, duplexModes: ["SIMPLEX"] }
    };
    expect(attemptError(settings({ duplex: "LONG_EDGE" }), simplexOnly)).toMatchObject({
      code: "UNSUPPORTED_PRINT_SETTING",
      details: { setting: "duplex" }
    });

    const monoIncapable: NormalizePrintSettingsContext = {
      ...context(),
      capabilities: { ...capabilities, colorModes: [] }
    };
    expect(attemptError(settings(), monoIncapable)).toMatchObject({
      code: "UNSUPPORTED_PRINT_SETTING",
      details: { setting: "colorMode" }
    });
  });

  it("bounds copies by the stricter of the deployment limit and the device", () => {
    expect(attemptError(settings({ copies: 0 }), context()).code).toBe("COPIES_OUT_OF_RANGE");
    expect(attemptError(settings({ copies: 21 }), context()).code).toBe("COPIES_OUT_OF_RANGE");

    const modestDevice: NormalizePrintSettingsContext = {
      ...context(),
      capabilities: { ...capabilities, maxCopies: 3 }
    };
    expect(attemptError(settings({ copies: 4 }), modestDevice)).toMatchObject({
      code: "COPIES_OUT_OF_RANGE",
      details: { maxCopies: 3 }
    });
  });

  it("enforces the selected page and printed side ceilings", () => {
    const large = { ...context(200), limits: { ...limits, maxSelectedPages: 100 } };
    expect(attemptError(settings(), large).code).toBe("SELECTED_PAGE_LIMIT_EXCEEDED");

    const sideBound = { ...context(200), limits: { ...limits, maxPrintedSides: 300 } };
    expect(attemptError(settings({ copies: 2 }), sideBound).code).toBe(
      "PRINTED_SIDE_LIMIT_EXCEEDED"
    );
  });

  it("requires the order to name every validated document exactly once", () => {
    expect(attemptError(settings({ fileOrder: [] }), context()).code).toBe("FILE_ORDER_INVALID");
    expect(
      attemptError(
        settings({
          fileOrder: [
            "0190efb7-0000-7000-8000-000000000001",
            "0190efb7-0000-7000-8000-000000000002"
          ]
        }),
        context()
      ).code
    ).toBe("FILE_ORDER_INVALID");
    expect(
      attemptError(
        settings({
          fileSelections: [
            {
              fileId: "0190efb7-0000-7000-8000-000000000002",
              pageRanges: null,
              copies: 1,
              duplex: "SIMPLEX",
              orientation: "PORTRAIT"
            }
          ]
        }),
        context()
      ).code
    ).toBe("FILE_SELECTION_INVALID");
  });
});

describe("settings manifest", () => {
  it("is stable across key ordering and binds the exact document bytes", () => {
    const normalized = normalizePrintSettings(settings(), context());
    const manifest = buildSettingsManifest(normalized);
    const reordered = {
      ...manifest,
      files: manifest.files.map((file) => ({
        orientation: file.orientation,
        duplex: file.duplex,
        copies: file.copies,
        selectedPages: file.selectedPages,
        pageRanges: file.pageRanges,
        pageCount: file.pageCount,
        contentSha256: file.contentSha256,
        processingRevision: file.processingRevision,
        position: file.position,
        fileId: file.fileId
      }))
    };

    expect(canonicalManifestJson(reordered)).toBe(canonicalManifestJson(manifest));
    expect(canonicalManifestJson(manifest)).toContain("a".repeat(64));
  });

  it("changes when the document content, order, or any setting changes", () => {
    const base = canonicalManifestJson(
      buildSettingsManifest(normalizePrintSettings(settings(), context()))
    );
    const differentCopies = canonicalManifestJson(
      buildSettingsManifest(normalizePrintSettings(settings({ copies: 2 }), context()))
    );
    const differentPages = canonicalManifestJson(
      buildSettingsManifest(
        normalizePrintSettings(
          settings({
            fileSelections: [
              {
                fileId: "0190efb7-0000-7000-8000-000000000001",
                pageRanges: "1-2",
                copies: 1,
                duplex: "SIMPLEX",
                orientation: "PORTRAIT"
              }
            ]
          }),
          context()
        )
      )
    );
    const reprocessed = canonicalManifestJson(
      buildSettingsManifest(
        normalizePrintSettings(settings(), {
          ...context(),
          files: [
            {
              id: "0190efb7-0000-7000-8000-000000000001",
              pageCount: 8,
              processingRevision: 2,
              contentSha256: "b".repeat(64)
            }
          ]
        })
      )
    );

    expect(new Set([base, differentCopies, differentPages, reprocessed]).size).toBe(4);
  });
});

function attemptError(
  input: PrintSettingsInput,
  settingsContext: NormalizePrintSettingsContext
): PrintSettingsError {
  try {
    normalizePrintSettings(input, settingsContext);
  } catch (error) {
    return error as PrintSettingsError;
  }
  throw new Error("EXPECTED_PRINT_SETTINGS_ERROR");
}

function attemptRangeError(text: string, pageCount: number): PrintSettingsError {
  try {
    parsePageRangeText(text, pageCount);
  } catch (error) {
    return error as PrintSettingsError;
  }
  throw new Error("EXPECTED_PAGE_RANGE_ERROR");
}
