import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalPrintManifestJson, type PrintJobManifest } from "./types.js";

/**
 * The kiosk agent re-derives the manifest hash with this function and refuses
 * to print when it does not match the hash the control plane issued. The
 * control plane produces that hash with its own canonicalizer in
 * `services/api/src/modules/print-jobs/service.ts`, which pins this same
 * manifest to this same digest.
 *
 * Two independent implementations of one hash is the hazard: a change to
 * either alone would not look wrong locally, and would make every print fail
 * as a tampered manifest and every capture owe a refund. That is what this
 * constant exists to catch.
 */
const GOLDEN_MANIFEST_SHA256 = "dfb56399a6eeb5f019694a87f21d033d1b99b1888a87384dce69262690d8c1e7";

const goldenManifest: PrintJobManifest = {
  manifestVersion: 2,
  printJobId: "01900000-0000-7000-8000-000000000901",
  sessionId: "01900000-0000-7000-8000-000000000902",
  settingsRevision: 3,
  settingsManifestHash: "c".repeat(64),
  quoteId: "01900000-0000-7000-8000-000000000903",
  paymentId: "01900000-0000-7000-8000-000000000904",
  paperSize: "A4",
  scaling: "FIT",
  collate: true,
  colorMode: "MONOCHROME",
  selectedPages: 5,
  printedSides: 8,
  physicalSheets: 6,
  documents: [
    {
      documentId: "01900000-0000-7000-8000-000000000905",
      position: 0,
      sha256: "d".repeat(64),
      sizeBytes: 2048,
      pageCount: 3,
      pageRanges: [[1, 3]],
      selectedPages: 3,
      copies: 2,
      duplex: "LONG_EDGE",
      orientation: "PORTRAIT",
      printedSides: 6,
      physicalSheets: 4
    },
    {
      documentId: "01900000-0000-7000-8000-000000000906",
      position: 1,
      sha256: "e".repeat(64),
      sizeBytes: 4096,
      pageCount: 4,
      pageRanges: [
        [2, 2],
        [4, 4]
      ],
      selectedPages: 2,
      copies: 1,
      duplex: "SIMPLEX",
      orientation: "LANDSCAPE",
      printedSides: 2,
      physicalSheets: 2
    }
  ]
};

function digest(manifest: PrintJobManifest): string {
  return createHash("sha256").update(canonicalPrintManifestJson(manifest), "utf8").digest("hex");
}

describe("canonicalPrintManifestJson", () => {
  it("hashes the shared manifest to the digest the control plane issues", () => {
    expect(digest(goldenManifest)).toBe(GOLDEN_MANIFEST_SHA256);
  });

  it("does not depend on the order the manifest object was built in", () => {
    const reordered = Object.fromEntries(
      Object.entries(goldenManifest).reverse()
    ) as unknown as PrintJobManifest;

    expect(digest(reordered)).toBe(GOLDEN_MANIFEST_SHA256);
  });
});
