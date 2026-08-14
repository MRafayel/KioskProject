import { describe, expect, it } from "vitest";

import {
  calculatePrintSummary,
  defaultFileSelection,
  defaultPrintSettings,
  fileSelection,
  initialPrototypeState,
  pageExclusionRefusal,
  pagePrintState,
  prototypeReducer,
  readyFiles,
  selectedPageRanges,
  type FileSelection,
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

/** A second validated document, uploaded after the first. */
const secondFile: PrototypeFile = {
  ...file,
  id: "file-second",
  ordinal: 1,
  name: "receipt.pdf",
  pageCount: 3
};

const selectionWith = (
  excludedPages: number[],
  overrides: Partial<FileSelection> = {}
): FileSelection => ({ ...defaultFileSelection, excludedPages, ...overrides });

const settingsFor = (
  fileId: string,
  selection: FileSelection,
  overrides: Partial<FileSelection> = {}
): PrintSettings => ({ selections: { [fileId]: { ...selection, ...overrides } } });

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

    expect(summary).toEqual({ selectedPages: 8, totalSides: 8, totalSheets: 8 });
    // The kiosk has no opinion about money. Only a server quote carries one.
    expect(Object.keys(summary)).not.toContain("priceCents");

    expect(
      calculatePrintSummary(
        [file],
        settingsFor(file.id, selectionWith([], { pageStart: 3, pageEnd: 7 }), {
          duplex: true,
          copies: 2
        })
      )
    ).toEqual({ selectedPages: 5, totalSides: 10, totalSheets: 6 });

    expect(
      calculatePrintSummary([file], settingsFor(file.id, selectionWith([], { duplex: true })))
    ).toMatchObject({
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
      paperSize: "A4" as const,
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
          selectedPages: 8,
          copies: 1,
          duplex: "SIMPLEX" as const,
          orientation: "AUTO" as const,
          printedSides: 8,
          physicalSheets: 8
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
      type: "FILE_SELECTION_CHANGED",
      fileId: file.id,
      selection: { copies: 2 }
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
  const exclusionsOf = (settings: PrintSettings, fileId = file.id) =>
    fileSelection(settings, fileId).excludedPages;

  it("prints the chosen range with the excluded pages cut out of it", () => {
    expect(selectedPageRanges(selectionWith([]), 8)).toEqual([[1, 8]]);
    expect(selectedPageRanges(selectionWith([4]), 8)).toEqual([
      [1, 3],
      [5, 8]
    ]);
    expect(selectedPageRanges(selectionWith([1, 2, 4, 6, 7, 8]), 8)).toEqual([
      [3, 3],
      [5, 5]
    ]);
    expect(selectedPageRanges(selectionWith([1, 2, 3, 4, 5, 6, 7, 8]), 8)).toEqual([]);
  });

  it("keeps an exclusion outside the chosen range without letting it print", () => {
    const selection = selectionWith([2], { pageStart: 4, pageEnd: 6 });

    expect(selectedPageRanges(selection, 8)).toEqual([[4, 6]]);
    expect(pagePrintState(selection, 8, 2)).toBe("OUT_OF_RANGE");
    // Widening the range again returns the page the customer removed rather
    // than quietly printing it.
    expect(selectedPageRanges({ ...selection, pageStart: 1, pageEnd: null }, 8)).toEqual([
      [1, 1],
      [3, 8]
    ]);
  });

  it("counts pages, sides and sheets without the excluded pages", () => {
    expect(calculatePrintSummary([file], settingsFor(file.id, selectionWith([2, 5])))).toEqual({
      selectedPages: 6,
      totalSides: 6,
      totalSheets: 6
    });

    expect(
      calculatePrintSummary(
        [file],
        settingsFor(file.id, selectionWith([4]), { duplex: true, copies: 2 })
      )
    ).toEqual({ selectedPages: 7, totalSides: 14, totalSheets: 8 });
  });

  it("reports how each page of the document is treated", () => {
    const selection = selectionWith([2], { pageStart: 1, pageEnd: 3 });

    expect(pagePrintState(selection, 8, 1)).toBe("PRINTED");
    expect(pagePrintState(selection, 8, 2)).toBe("EXCLUDED");
    expect(pagePrintState(selection, 8, 4)).toBe("OUT_OF_RANGE");
  });

  it("refuses an exclusion that would leave nothing to print", () => {
    expect(pageExclusionRefusal(selectionWith([]), 8, 3)).toBeNull();
    expect(pageExclusionRefusal(selectionWith([1, 2, 3, 4, 5, 6, 7]), 8, 8)).toBe(
      "LAST_SELECTED_PAGE"
    );
  });

  it("refuses an exclusion the control plane could not accept as a page range", () => {
    // Excluding every even page leaves each surviving odd page as a group of
    // its own, and a settings revision may describe only fifty of them.
    const evenPagesUpTo = (last: number) =>
      Array.from({ length: last / 2 }, (_, index) => (index + 1) * 2);

    // Pages 1..97 odd plus 99-200: the fiftieth group, and still allowed.
    expect(pageExclusionRefusal(selectionWith(evenPagesUpTo(96)), 200, 98)).toBeNull();
    expect(pageExclusionRefusal(selectionWith(evenPagesUpTo(98)), 200, 100)).toBe(
      "SELECTION_TOO_COMPLEX"
    );
  });

  it("adds and removes exclusions without repeating one or losing their order", () => {
    const start = { ...initialPrototypeState, session, files: [file] };
    const exclude = (pageNumber: number, excluded: boolean) =>
      ({ type: "PAGE_EXCLUSION_CHANGED", fileId: file.id, pageNumber, excluded }) as const;

    const excluded = prototypeReducer(prototypeReducer(start, exclude(5, true)), exclude(2, true));
    expect(exclusionsOf(excluded.settings)).toEqual([2, 5]);

    const restored = prototypeReducer(excluded, exclude(2, false));
    expect(exclusionsOf(restored.settings)).toEqual([5]);

    // Asking for the state a page already has changes nothing at all, so a
    // live price survives it.
    expect(prototypeReducer(restored, exclude(5, true))).toBe(restored);
    expect(prototypeReducer(restored, exclude(4, false))).toBe(restored);
  });

  it("drops exclusions that described a document the customer no longer has", () => {
    const excluded = prototypeReducer(
      { ...initialPrototypeState, session, files: [file] },
      { type: "PAGE_EXCLUSION_CHANGED", fileId: file.id, pageNumber: 3, excluded: true }
    );
    expect(exclusionsOf(excluded.settings)).toEqual([3]);

    expect(
      exclusionsOf(prototypeReducer(excluded, { type: "FILES_SYNCED", files: [file] }).settings)
    ).toEqual([3]);
    expect(
      exclusionsOf(
        prototypeReducer(excluded, {
          type: "FILES_SYNCED",
          files: [{ ...file, processingRevision: 2 }]
        }).settings
      )
    ).toEqual([]);
    expect(
      exclusionsOf(prototypeReducer(excluded, { type: "FILE_REMOVED", fileId: file.id }).settings)
    ).toEqual([]);
  });
});

describe("several documents in one print job", () => {
  const twoDocuments = { ...initialPrototypeState, session, files: [file, secondFile] };

  it("totals every document's own selection", () => {
    // Eight pages from the first document and three from the second, with one
    // page taken out of each.
    const settings: PrintSettings = {
      selections: {
        [file.id]: selectionWith([4]),
        [secondFile.id]: selectionWith([2])
      }
    };

    expect(calculatePrintSummary([file, secondFile], settings)).toEqual({
      selectedPages: 9,
      totalSides: 9,
      totalSheets: 9
    });
  });

  it("counts duplex sheets per document rather than across the job", () => {
    // Seven pages and three pages duplex: four sheets plus two, never five.
    // A sheet is never shared between two documents.
    const settings: PrintSettings = {
      selections: {
        [file.id]: selectionWith([4], { duplex: true }),
        [secondFile.id]: selectionWith([], { duplex: true })
      }
    };

    expect(calculatePrintSummary([file, secondFile], settings)).toEqual({
      selectedPages: 10,
      totalSides: 10,
      totalSheets: 6
    });
  });

  it("keeps one document's pages when another is added or removed", () => {
    const excluded = prototypeReducer(twoDocuments, {
      type: "PAGE_EXCLUSION_CHANGED",
      fileId: file.id,
      pageNumber: 3,
      excluded: true
    });
    expect(fileSelection(excluded.settings, file.id).excludedPages).toEqual([3]);

    // A third document arriving must not disturb the first document's pages.
    const third: PrototypeFile = { ...file, id: "file-third", ordinal: 2, pageCount: 2 };
    const added = prototypeReducer(excluded, {
      type: "FILES_SYNCED",
      files: [file, secondFile, third]
    });
    expect(fileSelection(added.settings, file.id).excludedPages).toEqual([3]);

    // Neither must removing the other document.
    const removed = prototypeReducer(excluded, {
      type: "FILE_REMOVED",
      fileId: secondFile.id
    });
    expect(fileSelection(removed.settings, file.id).excludedPages).toEqual([3]);
    expect(removed.settings.selections[secondFile.id]).toBeUndefined();
  });

  it("changes one document's range without touching another's", () => {
    const narrowed = prototypeReducer(twoDocuments, {
      type: "FILE_SELECTION_CHANGED",
      fileId: secondFile.id,
      selection: { pageStart: 2, pageEnd: 3 }
    });

    expect(fileSelection(narrowed.settings, secondFile.id)).toMatchObject({
      pageStart: 2,
      pageEnd: 3
    });
    expect(fileSelection(narrowed.settings, file.id)).toEqual(defaultFileSelection);
    // A changed selection is a changed price.
    expect(narrowed.pricing.status).toBe("IDLE");

    // Asking for the selection a document already has changes nothing.
    expect(
      prototypeReducer(narrowed, {
        type: "FILE_SELECTION_CHANGED",
        fileId: secondFile.id,
        selection: { pageStart: 2, pageEnd: 3 }
      })
    ).toBe(narrowed);
  });

  it("lists validated documents in the order they print", () => {
    const pending: PrototypeFile = {
      ...file,
      id: "file-pending",
      ordinal: 2,
      status: "QUARANTINED",
      pageCount: null
    };

    expect(readyFiles([secondFile, pending, file]).map((document) => document.id)).toEqual([
      file.id,
      secondFile.id
    ]);
  });
});
