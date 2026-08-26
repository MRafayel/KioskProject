// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { AdminSessionSummary, AdminSessionsResponse } from "@printing-kiosk/admin-access";

import { SessionsPanel } from "./SessionsPanel.js";
import { observabilityApi } from "../features/observability/api.js";

/**
 * Numbered pagination over a cursor API.
 *
 * The behaviour worth pinning is the part that distinguishes this from the
 * Previous/Next pair it replaced: pages already visited stay one click away in
 * both directions, and the forward arrow tracks the server's own cursor rather
 * than a page count nothing computed.
 */

vi.mock("../features/auth/SessionProvider.js", () => {
  const handleAuthenticationError = () => false;
  return { useSession: () => ({ can: () => true, handleAuthenticationError }) };
});

/** Three pages of one row each, keyed by the cursor that reaches them. */
const PAGES: Readonly<Record<string, { row: number; next: string | null }>> = {
  start: { row: 1, next: "cursor-2" },
  "cursor-2": { row: 2, next: "cursor-3" },
  "cursor-3": { row: 3, next: null }
};

beforeEach(() => {
  vi.spyOn(observabilityApi, "sessions").mockImplementation((filters = {}) => {
    const page = PAGES[filters.cursor ?? "start"];
    if (!page) throw new Error(`no page for cursor ${String(filters.cursor)}`);
    return Promise.resolve(listing(page.row, page.next));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function pagination() {
  return screen.getByRole("navigation", { name: "Session pages" });
}

function currentPage() {
  return within(pagination()).getByRole("button", { current: "page" }).textContent;
}

describe("numbered pagination", () => {
  it("grows the numbered trail as pages are discovered, and disables the arrows at each end", async () => {
    const user = userEvent.setup();
    render(<SessionsPanel />);

    await screen.findByText("kiosk-1");
    // One page known and more to come: no numbers worth drawing beyond the
    // first, but forward is live because the server handed over a cursor.
    expect(currentPage()).toBe("1");
    expect(within(pagination()).getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(within(pagination()).getByRole("button", { name: "Next page" })).toBeEnabled();

    await user.click(within(pagination()).getByRole("button", { name: "Next page" }));
    await screen.findByText("kiosk-2");
    expect(currentPage()).toBe("2");

    await user.click(within(pagination()).getByRole("button", { name: "Next page" }));
    await screen.findByText("kiosk-3");
    expect(currentPage()).toBe("3");

    // The last page: the server offered no further cursor, so forward stops.
    await waitFor(() =>
      expect(within(pagination()).getByRole("button", { name: "Next page" })).toBeDisabled()
    );
    expect(within(pagination()).getByRole("button", { name: "Page 1" })).toBeEnabled();
    expect(within(pagination()).getByRole("button", { name: "Page 2" })).toBeEnabled();
  });

  it("keeps visited pages reachable in one click after paging back", async () => {
    const user = userEvent.setup();
    render(<SessionsPanel />);

    await screen.findByText("kiosk-1");
    await user.click(within(pagination()).getByRole("button", { name: "Next page" }));
    await screen.findByText("kiosk-2");
    await user.click(within(pagination()).getByRole("button", { name: "Next page" }));
    await screen.findByText("kiosk-3");

    // Jump straight back to the first page by number, not by three arrow taps.
    await user.click(within(pagination()).getByRole("button", { name: "Page 1" }));
    await screen.findByText("kiosk-1");
    expect(currentPage()).toBe("1");

    // The trail survived: page 3 is still one click away rather than forgotten.
    expect(within(pagination()).getByRole("button", { name: "Page 3" })).toBeEnabled();
    await user.click(within(pagination()).getByRole("button", { name: "Page 3" }));
    await screen.findByText("kiosk-3");
    expect(currentPage()).toBe("3");
  });

  it("starts over when the filter changes", async () => {
    const user = userEvent.setup();
    render(<SessionsPanel />);

    await screen.findByText("kiosk-1");
    await user.click(within(pagination()).getByRole("button", { name: "Next page" }));
    await screen.findByText("kiosk-2");
    expect(currentPage()).toBe("2");

    await user.selectOptions(screen.getByLabelText("State"), "FAILED");

    // A different set of rows is a different set of pages; keeping page 2 would
    // show the second page of the old query under the new filter's heading.
    await waitFor(() =>
      expect(observabilityApi.sessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: "FAILED", cursor: undefined })
      )
    );
  });
});

function listing(row: number, nextCursor: string | null): AdminSessionsResponse {
  return { items: [summary(row)], nextCursor, scoped: false };
}

function summary(row: number): AdminSessionSummary {
  return {
    id: `0000000${row}-0000-4000-8000-000000000000`,
    publicId: `handoff-${row}`,
    kioskId: `kiosk-${row}`,
    state: "COMPLETED",
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:05:00.000Z",
    idleExpiresAt: "2026-08-23T12:30:00.000Z",
    hardExpiresAt: "2026-08-23T13:00:00.000Z",
    terminalReason: null,
    cleanupStatus: "DONE",
    cleanupDueAt: null,
    filesDeletedAt: null,
    documentCount: 1,
    printJobStatus: "COMPLETED",
    paymentStatus: "CAPTURED"
  };
}
