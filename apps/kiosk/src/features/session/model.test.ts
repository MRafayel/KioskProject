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

  it("calculates pages, sides, sheets, copies, and the minimum charge", () => {
    expect(calculatePrintSummary([file], defaultPrintSettings)).toEqual({
      pageStart: 1,
      pageEnd: 8,
      selectedPages: 8,
      totalSides: 8,
      totalSheets: 8,
      priceCents: 120
    });

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
      totalSheets: 6,
      priceCents: 150
    });
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
