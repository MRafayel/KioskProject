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
  shortCode: "123 456",
  uploadUrl: "https://upload.example.test/session-test?token=prototype",
  expiresAt: "2030-01-01T00:00:00.000Z",
  hardExpiresAt: "2030-01-01T00:30:00.000Z"
};

const file: PrototypeFile = {
  id: "file-test",
  name: "safe-fixture.pdf",
  mimeType: "application/pdf",
  pageCount: 8,
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
});
