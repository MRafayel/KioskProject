import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exceedsPaperEstimate, readKioskPaper, PaperReadError, UNKNOWN_PAPER } from "./paper.js";

/**
 * The rule that decides whether a job may be paid for, and the one thing it
 * must never do: refuse a customer over an answer nobody gave.
 */

describe("comparing a job against the paper estimate", () => {
  it("refuses a job that needs more sheets than the kiosk has", () => {
    expect(exceedsPaperEstimate(24, 18)).toBe(true);
  });

  it("allows a job that fits exactly", () => {
    // The last sheet in the tray is a sheet like any other.
    expect(exceedsPaperEstimate(18, 18)).toBe(false);
  });

  it("refuses everything once the estimate has reached zero", () => {
    // Zero is a tracked kiosk that has run out, not an untracked one.
    expect(exceedsPaperEstimate(1, 0)).toBe(true);
  });

  it("never refuses when the kiosk keeps no estimate", () => {
    // An unknown estimate is not evidence of an empty tray, and a wrong
    // pessimistic answer closes a machine that could have printed.
    expect(exceedsPaperEstimate(2_000, null)).toBe(false);
  });

  it("has no opinion about a job of no sheets", () => {
    // A customer who has excluded every page is already held by the pricing
    // gate and does not need a second explanation about paper.
    expect(exceedsPaperEstimate(0, 0)).toBe(false);
  });
});

describe("reading the estimate", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports the count the kiosk answered with", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ paper: { estimatedSheets: 120 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(readKioskPaper()).resolves.toEqual({ estimatedSheets: 120 });
  });

  it("raises rather than reporting unknown when the kiosk refuses", async () => {
    // Unknown would erase a shortfall the screen had already established. The
    // caller keeps the last answer that arrived instead.
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 503 }));

    await expect(readKioskPaper()).rejects.toBeInstanceOf(PaperReadError);
  });

  it("raises when the kiosk answers with something that is not a sheet count", async () => {
    // A proxy error page, an unexpected shape: neither is a sheet count, and
    // neither may be turned into one.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ session: { id: "not-a-paper-answer" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(readKioskPaper()).rejects.toBeInstanceOf(PaperReadError);
  });

  it("starts from unknown, so a kiosk that has never answered still sells", () => {
    expect(UNKNOWN_PAPER.estimatedSheets).toBeNull();
    expect(exceedsPaperEstimate(2_000, UNKNOWN_PAPER.estimatedSheets)).toBe(false);
  });
});
