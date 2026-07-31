import { describe, expect, it } from "vitest";

import {
  calculatePrintSummary,
  defaultPrintSettings,
  initialPrototypeState,
  prototypeReducer,
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

    expect(
      calculatePrintSummary([file], { ...defaultPrintSettings, pagesPerSheet: 2, duplex: true })
    ).toMatchObject({ selectedPages: 8, totalSides: 4, totalSheets: 2 });
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
      pagesPerSheet: 1 as const,
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
