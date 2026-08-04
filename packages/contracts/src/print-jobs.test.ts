import { describe, expect, it } from "vitest";

import {
  printJobManifestSchema,
  reportAgentCommandProgressBodySchema,
  reportAgentCommandResultBodySchema
} from "./print-jobs.js";

const id = (suffix: string) => `01900000-0000-7000-8000-${suffix.padStart(12, "0")}`;

function manifest() {
  return {
    manifestVersion: 1,
    printJobId: id("1"),
    sessionId: id("2"),
    settingsRevision: 1,
    settingsManifestHash: "a".repeat(64),
    quoteId: id("3"),
    paymentId: id("4"),
    copies: 2,
    duplex: "SIMPLEX",
    paperSize: "A4",
    orientation: "AUTO",
    scaling: "FIT",
    collate: true,
    colorMode: "MONOCHROME",
    selectedPages: 3,
    printedSides: 6,
    physicalSheets: 6,
    documents: [
      {
        documentId: id("5"),
        position: 0,
        sha256: "b".repeat(64),
        sizeBytes: 100,
        pageCount: 3,
        pageRanges: [[1, 3]],
        selectedPages: 3
      }
    ]
  };
}

describe("print job contracts", () => {
  it("accepts a preparation heartbeat without treating it as submission", () => {
    expect(
      reportAgentCommandProgressBodySchema.safeParse({ claimToken: id("6"), state: "PREPARING" })
        .success
    ).toBe(true);
  });

  it("rejects internally inconsistent manifests", () => {
    const duplicate = manifest();
    duplicate.documents.push({ ...duplicate.documents[0]!, position: 0 });

    expect(printJobManifestSchema.safeParse(duplicate).success).toBe(false);
    expect(printJobManifestSchema.safeParse({ ...manifest(), selectedPages: 2 }).success).toBe(
      false
    );
    expect(printJobManifestSchema.safeParse({ ...manifest(), printedSides: 5 }).success).toBe(
      false
    );
  });

  it("rejects result combinations that could create an unsafe settlement", () => {
    const base = {
      claimToken: id("6"),
      failureCode: null,
      warningCode: null
    };
    expect(
      reportAgentCommandResultBodySchema.safeParse({
        ...base,
        state: "NOT_SUBMITTED",
        confidence: "UNCONFIRMED",
        sheetsProduced: null
      }).success
    ).toBe(false);
    expect(
      reportAgentCommandResultBodySchema.safeParse({
        ...base,
        state: "CANCELED",
        confidence: "CONFIRMED",
        sheetsProduced: 1
      }).success
    ).toBe(false);
    expect(
      reportAgentCommandResultBodySchema.safeParse({
        ...base,
        state: "FAILED",
        confidence: "UNCONFIRMED",
        sheetsProduced: 0
      }).success
    ).toBe(false);
    expect(
      reportAgentCommandResultBodySchema.safeParse({
        ...base,
        state: "COMPLETED",
        confidence: "CONFIRMED",
        sheetsProduced: 0
      }).success
    ).toBe(false);
    expect(
      reportAgentCommandResultBodySchema.safeParse({
        ...base,
        state: "COMPLETED",
        confidence: "CONFIRMED",
        failureCode: "DEVICE_ERROR",
        sheetsProduced: 1
      }).success
    ).toBe(false);
  });
});
