// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyPrintedSheets,
  exceedsPaperEstimate,
  readKioskPaper,
  KIOSK_PAPER_QUERY_KEY,
  PaperReadError,
  UNKNOWN_PAPER
} from "./paper.js";

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

describe("taking a finished print out of the estimate", () => {
  function clientHolding(estimatedSheets: number | null): QueryClient {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(KIOSK_PAPER_QUERY_KEY, { estimatedSheets });
    return queryClient;
  }

  function held(queryClient: QueryClient): unknown {
    return queryClient.getQueryData(KIOSK_PAPER_QUERY_KEY);
  }

  it("subtracts the sheets the device reported producing", async () => {
    // The same subtraction the control plane already made when it confirmed the
    // completion, applied locally so the next customer inside the freshness
    // window is not offered paper the kiosk no longer has.
    const queryClient = clientHolding(40);

    await applyPrintedSheets(queryClient, 6);

    expect(held(queryClient)).toEqual({ estimatedSheets: 34 });
  });

  it("stops at zero rather than going into debt", async () => {
    // The ledger keeps the same floor, so drifting apart here would make the
    // next read look like a correction nobody made.
    const queryClient = clientHolding(4);

    await applyPrintedSheets(queryClient, 10);

    expect(held(queryClient)).toEqual({ estimatedSheets: 0 });
  });

  it("leaves a kiosk nobody tracks untracked", async () => {
    // The completion is recorded there as history with a zero delta. Inventing
    // a number here would be inventing the tracking with it.
    const queryClient = clientHolding(null);

    await applyPrintedSheets(queryClient, 6);

    expect(held(queryClient)).toEqual({ estimatedSheets: null });
  });

  it("does nothing for a job that produced nothing", async () => {
    const queryClient = clientHolding(40);

    await applyPrintedSheets(queryClient, 0);

    expect(held(queryClient)).toEqual({ estimatedSheets: 40 });
  });

  it("is the next read's to overwrite, not the other way round", async () => {
    // The event-driven update is a head start, never a second source of truth.
    // Whatever the kiosk answers next is what stands.
    const queryClient = clientHolding(40);
    await applyPrintedSheets(queryClient, 6);

    queryClient.setQueryData(KIOSK_PAPER_QUERY_KEY, { estimatedSheets: 31 });

    expect(held(queryClient)).toEqual({ estimatedSheets: 31 });
  });
});
