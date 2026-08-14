import { describe, expect, it } from "vitest";

import { capabilitySnapshotHash, mapDeviceCapabilities } from "./capabilities.js";
import { PRINT_CAPABILITY_SNAPSHOT_VERSION } from "./types.js";

const limits = { maxCopies: 20 };

describe("mapDeviceCapabilities", () => {
  it("reads the IPP vocabulary a network printer answers with", () => {
    const snapshot = mapDeviceCapabilities(
      {
        mediaSizes: ["iso_a4_210x297mm", "na_letter_8.5x11in"],
        sides: ["one-sided", "two-sided-long-edge", "two-sided-short-edge"],
        colorModes: ["monochrome", "color"],
        maxCopies: 99
      },
      limits
    );

    expect(snapshot).toEqual({
      version: PRINT_CAPABILITY_SNAPSHOT_VERSION,
      paperSizes: ["A4"],
      duplexModes: ["SIMPLEX", "LONG_EDGE", "SHORT_EDGE"],
      colorModes: ["MONOCHROME"],
      orientations: ["AUTO", "PORTRAIT", "LANDSCAPE"],
      scalingModes: ["FIT", "ACTUAL_SIZE"],
      maxCopies: 20
    });
  });

  it("reads the Windows driver vocabulary for the same device", () => {
    const snapshot = mapDeviceCapabilities(
      {
        mediaSizes: ["A4", "Letter"],
        sides: ["OneSided", "TwoSidedLongEdge"],
        colorModes: ["Grayscale"],
        maxCopies: 10
      },
      limits
    );

    expect(snapshot.paperSizes).toEqual(["A4"]);
    expect(snapshot.duplexModes).toEqual(["SIMPLEX", "LONG_EDGE"]);
    expect(snapshot.colorModes).toEqual(["MONOCHROME"]);
    expect(snapshot.maxCopies).toBe(10);
  });

  /**
   * A capability that is not recognised is not offered. Anything else lets a
   * media name nobody has seen become an option a customer pays for and the
   * hardware then refuses.
   */
  it("offers nothing it does not recognise", () => {
    const snapshot = mapDeviceCapabilities(
      { mediaSizes: ["custom_tray_1"], colorModes: ["color", "auto"], sides: ["four-sided"] },
      limits
    );

    expect(snapshot.paperSizes).toEqual([]);
    expect(snapshot.colorModes).toEqual([]);
    // A device that names no sides vocabulary still prints one-sided.
    expect(snapshot.duplexModes).toEqual(["SIMPLEX"]);
  });

  it("adds the conservative duplex option when only a duplex unit is reported", () => {
    expect(mapDeviceCapabilities({ duplexSupported: true }, limits).duplexModes).toEqual([
      "SIMPLEX",
      "LONG_EDGE"
    ]);
    expect(mapDeviceCapabilities({ duplexSupported: false }, limits).duplexModes).toEqual([
      "SIMPLEX"
    ]);
  });

  it("never lets a device raise the deployment copy ceiling", () => {
    expect(mapDeviceCapabilities({ maxCopies: 5_000 }, limits).maxCopies).toBe(20);
    expect(mapDeviceCapabilities({ maxCopies: 0 }, limits).maxCopies).toBe(20);
    expect(mapDeviceCapabilities({ maxCopies: null }, limits).maxCopies).toBe(20);
  });

  /**
   * Orientation and scaling are already baked into the print-ready PDF by the
   * document processor, so they are host capabilities. Asking hardware about
   * them would only produce a guess that could narrow what a customer is
   * offered for no reason.
   */
  it("reports orientation and scaling as host capabilities", () => {
    const snapshot = mapDeviceCapabilities({}, limits);

    expect(snapshot.orientations).toEqual(["AUTO", "PORTRAIT", "LANDSCAPE"]);
    expect(snapshot.scalingModes).toEqual(["FIT", "ACTUAL_SIZE"]);
  });
});

describe("capabilitySnapshotHash", () => {
  /**
   * The control plane bumps the kiosk capability version when this digest
   * changes, and a version bump invalidates open quotes. A device that answered
   * in a different attribute order must therefore not look like a device that
   * was replaced.
   */
  it("ignores the order a device listed its options in", () => {
    const first = mapDeviceCapabilities(
      { mediaSizes: ["iso_a4_210x297mm"], sides: ["two-sided-long-edge", "one-sided"] },
      limits
    );
    const second = mapDeviceCapabilities(
      { mediaSizes: ["iso_a4_210x297mm"], sides: ["one-sided", "two-sided-long-edge"] },
      limits
    );

    expect(capabilitySnapshotHash(first)).toBe(capabilitySnapshotHash(second));
  });

  it("changes when the device changes", () => {
    const duplex = mapDeviceCapabilities({ sides: ["one-sided", "two-sided-long-edge"] }, limits);
    const simplexOnly = mapDeviceCapabilities({ sides: ["one-sided"] }, limits);

    expect(capabilitySnapshotHash(duplex)).not.toBe(capabilitySnapshotHash(simplexOnly));
  });
});
