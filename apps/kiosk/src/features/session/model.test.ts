import { describe, expect, it } from "vitest";

import {
  calculatePrintSummary,
  defaultPrintSettings,
  initialPrototypeState,
  pageExclusionRefusal,
  pagePrintState,
  prototypeReducer,
  selectedPageRanges,
  type PrintSettings,
  type PrototypeFile,
  type PrototypeSession
} from "./model.js";

const session: PrototypeSession = {
  id: "session-test",
  publicId: "ps_session-test",
  version: 1,
  uploadUrl: "https://upload.example.test/session-test?token=prototype",
  expiresAt: "2030-01-01T00:00:00.000Z",
  hardExpiresAt: "2030-01-01T00:30:00.000Z"
};

const file: PrototypeFile = {
  id: "file-test",
  ordinal: 0,
  name: "safe-fixture.pdf",
  kind: "PDF",
  status: "READY",
  pageCount: 8,
  processingRevision: 1,
  rejectionCode: null,
  sizeBytes: 2_000_000
};

describe("prototype session model", () => {
  it("resets all customer state when a new session starts", () => {
    const dirtyState = {
      ...initialPrototypeState,
      files: [file],
      settings: { ...defaultPrintSettings, copies: 4 },
      outcome: "PRINTER_ERROR" as const
    };

    expect(prototypeReducer(dirtyState, { type: "SESSION_CREATED", session })).toEqual({
      ...initialPrototypeState,
      session
    });
  });

  it("previews pages, sides and sheets without producing a price", () => {
    const summary = calculatePrintSummary([file], defaultPrintSettings);

    expect(summary).toEqual({
      pageStart: 1,
      pageEnd: 8,
      selectedPages: 8,
      totalSides: 8,
      totalSheets: 8
    });
    // The kiosk has no opinion about money. Only a server quote carries one.
    expect(Object.keys(summary)).not.toContain("priceCents");

    expect(
      calculatePrintSummary([file], {
        ...defaultPrintSettings,
        pageStart: 3,
        pageEnd: 7,
        duplex: true,
        copies: 2
      })
    ).toEqual({
      pageStart: 3,
      pageEnd: 7,
      selectedPages: 5,
      totalSides: 10,
      totalSheets: 6
    });

    expect(calculatePrintSummary([file], { ...defaultPrintSettings, duplex: true })).toMatchObject({
      selectedPages: 8,
      totalSides: 8,
      totalSheets: 4
    });
  });

  it("discards a stored price whenever the priced material changes", () => {
    const quote = {
      id: "01900000-0000-7000-8000-0000000000aa",
      sessionId: session.id,
      settingsRevision: 1,
      pricingVersion: "price-v1",
      status: "ACTIVE" as const,
      currency: "AMD",
      currencyExponent: 2,
      selectedPages: 8,
      printedSides: 8,
      physicalSheets: 8,
      breakdown: {
        printAmountMinor: 40_000,
        duplexAdjustmentMinor: 0,
        serviceFeeMinor: 0,
        minimumAdjustmentMinor: 0
      },
      subtotalMinor: 40_000,
      taxMinor: 8_000,
      totalMinor: 48_000,
      createdAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:05:00.000Z"
    };
    const settingsSnapshot = {
      revision: 1,
      copies: 1,
      duplex: "SIMPLEX" as const,
      paperSize: "A4" as const,
      orientation: "PORTRAIT" as const,
      scaling: "FIT" as const,
      collate: true,
      colorMode: "MONOCHROME" as const,
      files: [
        {
          fileId: file.id,
          position: 0,
          pageCount: 8,
          pageRanges: [[1, 8] as [number, number]],
          pageRangeText: "1-8",
          selectedPages: 8
        }
      ],
      selectedPages: 8,
      printedSides: 8,
      physicalSheets: 8,
      createdAt: "2030-01-01T00:00:00.000Z"
    };
    const priced = prototypeReducer(
      { ...initialPrototypeState, session, files: [file] },
      { type: "PRICING_RESOLVED", settings: settingsSnapshot, quote }
    );
    expect(priced.pricing.quote).toEqual(quote);

    const afterSettingsChange = prototypeReducer(priced, {
      type: "SETTINGS_CHANGED",
      settings: { copies: 2 }
    });
    expect(afterSettingsChange.pricing.quote).toBeNull();

    const reprocessed: PrototypeFile = { ...file, processingRevision: 2 };
    const afterDocumentChange = prototypeReducer(priced, {
      type: "FILES_SYNCED",
      files: [reprocessed]
    });
    expect(afterDocumentChange.pricing.quote).toBeNull();

    // An unchanged document list must not throw the price away.
    const afterHarmlessSync = prototypeReducer(priced, { type: "FILES_SYNCED", files: [file] });
    expect(afterHarmlessSync.pricing.quote).toEqual(quote);
  });

  it("replaces the kiosk file snapshot in server order", () => {
    const quarantinedFile: PrototypeFile = {
      ...file,
      id: "quarantined-file",
      ordinal: 1,
      name: null,
      status: "QUARANTINED",
      pageCount: null,
      processingRevision: 1
    };

    expect(
      prototypeReducer(
        { ...initialPrototypeState, files: [file] },
        { type: "FILES_SYNCED", files: [quarantinedFile, file] }
      ).files
    ).toEqual([file, quarantinedFile]);
  });

  it("keeps a replacement ahead of an older rejection tombstone", () => {
    const rejectedFile: PrototypeFile = {
      ...file,
      status: "REJECTED",
      pageCount: null,
      processingRevision: 1,
      rejectionCode: "DOCUMENT_MALFORMED"
    };
    const replacement: PrototypeFile = {
      ...file,
      id: "replacement-file",
      ordinal: 1,
      name: null,
      status: "QUARANTINED",
      pageCount: null,
      processingRevision: 1
    };

    expect(
      prototypeReducer(initialPrototypeState, {
        type: "FILES_SYNCED",
        files: [rejectedFile, replacement]
      }).files
    ).toEqual([replacement, rejectedFile]);
  });
});

describe("pages excluded from the print job", () => {
  const settingsWith = (excludedPages: number[], overrides: Partial<PrintSettings> = {}) => ({
    ...defaultPrintSettings,
    excludedPages,
    ...overrides
  });

  it("prints the chosen range with the excluded pages cut out of it", () => {
    expect(selectedPageRanges(settingsWith([]), 8)).toEqual([[1, 8]]);
    expect(selectedPageRanges(settingsWith([4]), 8)).toEqual([
      [1, 3],
      [5, 8]
    ]);
    expect(selectedPageRanges(settingsWith([1, 2, 4, 6, 7, 8]), 8)).toEqual([
      [3, 3],
      [5, 5]
    ]);
    expect(selectedPageRanges(settingsWith([1, 2, 3, 4, 5, 6, 7, 8]), 8)).toEqual([]);
  });

  it("keeps an exclusion outside the chosen range without letting it print", () => {
    const settings = settingsWith([2], { pageStart: 4, pageEnd: 6 });

    expect(selectedPageRanges(settings, 8)).toEqual([[4, 6]]);
    expect(pagePrintState(settings, 8, 2)).toBe("OUT_OF_RANGE");
    // Widening the range again returns the page the customer removed rather
    // than quietly printing it.
    expect(selectedPageRanges({ ...settings, pageStart: 1, pageEnd: null }, 8)).toEqual([
      [1, 1],
      [3, 8]
    ]);
  });

  it("counts pages, sides and sheets without the excluded pages", () => {
    expect(calculatePrintSummary([file], settingsWith([2, 5]))).toEqual({
      pageStart: 1,
      pageEnd: 8,
      selectedPages: 6,
      totalSides: 6,
      totalSheets: 6
    });

    expect(
      calculatePrintSummary([file], settingsWith([4], { duplex: true, copies: 2 }))
    ).toMatchObject({
      selectedPages: 7,
      totalSides: 14,
      totalSheets: 8
    });
  });

  it("reports how each page of the document is treated", () => {
    const settings = settingsWith([2], { pageStart: 1, pageEnd: 3 });

    expect(pagePrintState(settings, 8, 1)).toBe("PRINTED");
    expect(pagePrintState(settings, 8, 2)).toBe("EXCLUDED");
    expect(pagePrintState(settings, 8, 4)).toBe("OUT_OF_RANGE");
  });

  it("refuses an exclusion that would leave nothing to print", () => {
    expect(pageExclusionRefusal(settingsWith([]), 8, 3)).toBeNull();
    expect(pageExclusionRefusal(settingsWith([1, 2, 3, 4, 5, 6, 7]), 8, 8)).toBe(
      "LAST_SELECTED_PAGE"
    );
  });

  it("refuses an exclusion the control plane could not accept as a page range", () => {
    // Excluding every even page leaves each surviving odd page as a group of
    // its own, and a settings revision may describe only fifty of them.
    const evenPagesUpTo = (last: number) =>
      Array.from({ length: last / 2 }, (_, index) => (index + 1) * 2);

    // Pages 1..97 odd plus 99-200: the fiftieth group, and still allowed.
    expect(pageExclusionRefusal(settingsWith(evenPagesUpTo(96)), 200, 98)).toBeNull();
    expect(pageExclusionRefusal(settingsWith(evenPagesUpTo(98)), 200, 100)).toBe(
      "SELECTION_TOO_COMPLEX"
    );
  });

  it("adds and removes exclusions without repeating one or losing their order", () => {
    const start = { ...initialPrototypeState, session, files: [file] };

    const excluded = prototypeReducer(
      prototypeReducer(start, { type: "PAGE_EXCLUSION_CHANGED", pageNumber: 5, excluded: true }),
      { type: "PAGE_EXCLUSION_CHANGED", pageNumber: 2, excluded: true }
    );
    expect(excluded.settings.excludedPages).toEqual([2, 5]);

    const restored = prototypeReducer(excluded, {
      type: "PAGE_EXCLUSION_CHANGED",
      pageNumber: 2,
      excluded: false
    });
    expect(restored.settings.excludedPages).toEqual([5]);

    // Asking for the state a page already has changes nothing at all, so a
    // live price survives it.
    expect(
      prototypeReducer(restored, { type: "PAGE_EXCLUSION_CHANGED", pageNumber: 5, excluded: true })
    ).toBe(restored);
    expect(
      prototypeReducer(restored, { type: "PAGE_EXCLUSION_CHANGED", pageNumber: 4, excluded: false })
    ).toBe(restored);
  });

  it("drops exclusions that described a document the customer no longer has", () => {
    const excluded = prototypeReducer(
      { ...initialPrototypeState, session, files: [file] },
      { type: "PAGE_EXCLUSION_CHANGED", pageNumber: 3, excluded: true }
    );
    expect(excluded.settings.excludedPages).toEqual([3]);

    expect(
      prototypeReducer(excluded, { type: "FILES_SYNCED", files: [file] }).settings.excludedPages
    ).toEqual([3]);
    expect(
      prototypeReducer(excluded, {
        type: "FILES_SYNCED",
        files: [{ ...file, processingRevision: 2 }]
      }).settings.excludedPages
    ).toEqual([]);
    expect(
      prototypeReducer(excluded, { type: "FILE_REMOVED", fileId: file.id }).settings.excludedPages
    ).toEqual([]);
  });
});
