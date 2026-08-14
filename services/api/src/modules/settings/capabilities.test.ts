import { describe, expect, it } from "vitest";

import { readPrinterCapabilities } from "./capabilities.js";

const limits = { maxCopies: 10, maxSelectedPages: 200, maxPrintedSides: 1_000 };

describe("printer capability snapshots", () => {
  it("narrows a legacy snapshot to the fixed product policy", () => {
    const capabilities = readPrinterCapabilities(
      {
        capabilitiesVersion: 2,
        capabilities: {
          paperSizes: ["A4"],
          colorModes: ["MONOCHROME"],
          duplexModes: ["SIMPLEX", "LONG_EDGE", "SHORT_EDGE"],
          orientations: ["AUTO", "PORTRAIT"],
          scalingModes: ["FIT", "ACTUAL_SIZE"],
          maxCopies: 5
        }
      },
      limits
    );

    expect(capabilities).toEqual({
      version: 2,
      paperSizes: ["A4"],
      colorModes: ["MONOCHROME"],
      duplexModes: ["SIMPLEX", "LONG_EDGE"],
      orientations: ["AUTO"],
      scalingModes: ["FIT"],
      maxCopies: 5
    });
  });

  it("gives a pre-Phase-6 kiosk conservative defaults instead of failing", () => {
    const capabilities = readPrinterCapabilities(
      {
        capabilitiesVersion: 1,
        capabilities: {
          service: "PRINT_ONLY",
          outputMode: "MONOCHROME",
          paperSizes: ["A4"],
          duplex: true
        }
      },
      limits
    );

    expect(capabilities.colorModes).toEqual(["MONOCHROME"]);
    expect(capabilities.duplexModes).toEqual(["SIMPLEX", "LONG_EDGE"]);
    expect(capabilities.maxCopies).toBe(limits.maxCopies);
  });

  it("offers no duplex when the snapshot does not claim it", () => {
    const capabilities = readPrinterCapabilities(
      { capabilitiesVersion: 1, capabilities: { outputMode: "MONOCHROME", duplex: false } },
      limits
    );
    expect(capabilities.duplexModes).toEqual(["SIMPLEX"]);
  });

  it("never lets a snapshot claim more than the deployment allows", () => {
    const capabilities = readPrinterCapabilities(
      { capabilitiesVersion: 3, capabilities: { maxCopies: 10_000 } },
      limits
    );
    expect(capabilities.maxCopies).toBe(limits.maxCopies);
  });

  it("ignores unknown, malformed, or colour claims", () => {
    const capabilities = readPrinterCapabilities(
      {
        capabilitiesVersion: 4,
        capabilities: {
          paperSizes: ["A3", "LETTER"],
          colorModes: ["COLOR"],
          duplexModes: "yes",
          maxCopies: "many"
        }
      },
      limits
    );

    expect(capabilities.paperSizes).toEqual(["A4"]);
    expect(capabilities.colorModes).toEqual([]);
    expect(capabilities.duplexModes).toEqual(["SIMPLEX"]);
    expect(capabilities.maxCopies).toBe(limits.maxCopies);
  });

  it("treats a missing snapshot as an unusable device rather than a permissive one", () => {
    const capabilities = readPrinterCapabilities(
      { capabilitiesVersion: 1, capabilities: null },
      limits
    );
    expect(capabilities.colorModes).toEqual([]);
    expect(capabilities.duplexModes).toEqual(["SIMPLEX"]);
  });
});
