import { describe, expect, it } from "vitest";

import { printJobManifestSchema } from "@printing-kiosk/contracts";

import { hashPrintManifest } from "./service.js";

/**
 * The manifest hash is agreed between two independently written
 * canonicalizers: this one, and `canonicalPrintManifestJson` in
 * `@printing-kiosk/printer-adapters`, which the kiosk agent uses to re-derive
 * the hash before it will print anything. If they ever disagree, every print
 * would be refused locally as a tampered manifest and every capture would be
 * refunded — a total outage that no other test would catch, because neither
 * side is wrong on its own.
 *
 * Both packages therefore pin this same manifest to this same digest. The
 * constant is not a formatting detail: changing it on one side alone is the
 * failure being guarded against.
 */
const GOLDEN_MANIFEST_SHA256 = "49c78dadaaacf437254477f6c1aa788311616595eb38fd270ac37fef32095e85";

const goldenManifest = {
  manifestVersion: 1,
  printJobId: "01900000-0000-7000-8000-000000000901",
  sessionId: "01900000-0000-7000-8000-000000000902",
  settingsRevision: 3,
  settingsManifestHash: "c".repeat(64),
  quoteId: "01900000-0000-7000-8000-000000000903",
  paymentId: "01900000-0000-7000-8000-000000000904",
  copies: 2,
  duplex: "LONG_EDGE",
  paperSize: "A4",
  orientation: "AUTO",
  scaling: "FIT",
  collate: true,
  colorMode: "MONOCHROME",
  selectedPages: 5,
  printedSides: 10,
  physicalSheets: 6,
  documents: [
    {
      documentId: "01900000-0000-7000-8000-000000000905",
      position: 0,
      sha256: "d".repeat(64),
      sizeBytes: 2048,
      pageCount: 3,
      pageRanges: [[1, 3]],
      selectedPages: 3
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
      selectedPages: 2
    }
  ]
};

describe("hashPrintManifest", () => {
  it("hashes the shared manifest to the digest the kiosk agent expects", () => {
    const manifest = printJobManifestSchema.parse(goldenManifest);

    expect(hashPrintManifest(manifest)).toBe(GOLDEN_MANIFEST_SHA256);
  });

  it("does not depend on the order the manifest object was built in", () => {
    const manifest = printJobManifestSchema.parse(goldenManifest);
    const reordered = printJobManifestSchema.parse(
      Object.fromEntries(Object.entries(goldenManifest).reverse())
    );

    expect(hashPrintManifest(reordered)).toBe(hashPrintManifest(manifest));
  });

  it("changes when anything the device would print changes", () => {
    const manifest = printJobManifestSchema.parse(goldenManifest);
    const extraCopy = printJobManifestSchema.parse({
      ...goldenManifest,
      copies: 3,
      printedSides: 15
    });

    expect(hashPrintManifest(extraCopy)).not.toBe(hashPrintManifest(manifest));
  });
});
