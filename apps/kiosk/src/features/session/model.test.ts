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
  shortCode: "123 456",
  uploadUrl: "https://upload.example.test/session-test?token=prototype",
  expiresAt: "2030-01-01T00:00:00.000Z"
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
      selectedPages: 8,
      totalSides: 8,
      totalSheets: 8,
      priceCents: 120
    });

    expect(
      calculatePrintSummary([file], {
        ...defaultPrintSettings,
        pageRange: "FIRST_FOUR",
        duplex: true,
        pagesPerSheet: 2,
        copies: 2
      })
    ).toEqual({
      selectedPages: 4,
      totalSides: 4,
      totalSheets: 2,
      priceCents: 100
    });
  });
});
