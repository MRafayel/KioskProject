// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { AdminSessionSummary, AdminSessionsResponse } from "@printing-kiosk/admin-access";

import { SessionsPanel } from "./SessionsPanel.js";
import { observabilityApi } from "../features/observability/api.js";

/**
 * The Sessions page, exercised as an operator uses it.
 *
 * These cover the three things the redesign moved and one it fixed, all of them
 * behaviour rather than appearance: the identifier is no longer a column, the
 * summary tiles are the filter, choosing a row opens a dialog rather than
 * appending a panel below the fold, and closing it returns focus to the row so
 * a keyboard user does not restart at the top of the page.
 */

vi.mock("../features/auth/SessionProvider.js", () => {
  // Production memoizes this callback. Keeping it stable here ensures filter
  // changes have to invalidate the data loader itself rather than accidentally
  // retriggering it through an unrelated effect dependency.
  const handleAuthenticationError = () => false;
  return {
    useSession: () => ({
      can: () => true,
      handleAuthenticationError
    })
  };
});

beforeEach(() => {
  vi.spyOn(observabilityApi, "sessions").mockImplementation((filters = {}) => {
    const result = listing();
    return Promise.resolve({
      ...result,
      items: filters.state
        ? result.items.filter((item) => item.state === filters.state)
        : result.items
    });
  });
  vi.spyOn(observabilityApi, "session").mockResolvedValue(detail());
  vi.spyOn(observabilityApi, "timeline").mockResolvedValue({
    sessionId: sessionId(1),
    items: [],
    nextCursor: null
  });
  vi.spyOn(observabilityApi, "documents").mockResolvedValue({
    sessionId: sessionId(1),
    items: [],
    filesDeletedAt: null
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the sessions table", () => {
  it("leads with when the session started and keeps the identifier out of the columns", async () => {
    render(<SessionsPanel />);

    const header = await screen.findByRole("row", { name: /started/i });
    const columns = within(header)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);

    expect(columns).toEqual(["Started", "Kiosk", "State", "Files", "Payment", "Print", "Deletion"]);
    expect(columns).not.toContain("Session");
    // The full identifier is not truncated into a cell anywhere on the page.
    expect(screen.queryByText(sessionId(1))).not.toBeInTheDocument();
  });

  it("opens the session in a dialog carrying its identifier, and returns focus on close", async () => {
    const user = userEvent.setup();
    render(<SessionsPanel />);

    const open = await screen.findByRole("button", { name: /Completed, started/ });
    await user.click(open);

    const sheet = await screen.findByRole("dialog", { name: "Session detail" });
    expect(within(sheet).getByText(sessionId(1))).toBeInTheDocument();
    expect(within(sheet).getByText("kiosk-handoff-1")).toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Back on the row that was opened, not at the top of the document.
    expect(document.activeElement).toBe(open);
  });

  it("closes the sheet on Escape", async () => {
    const user = userEvent.setup();
    render(<SessionsPanel />);

    await user.click(await screen.findByRole("button", { name: /Completed, started/ }));
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("the summary tiles", () => {
  it("keeps every card, the returned rows, and the state dropdown synchronized", async () => {
    const user = userEvent.setup();
    render(<SessionsPanel />);

    const failed = await screen.findByRole("button", { name: /^Failed: 1\./ });
    expect(failed).toHaveAttribute("aria-pressed", "false");

    await user.click(failed);

    // The state filter is the server's, so the tile asks the server for it.
    await waitFor(() =>
      expect(observabilityApi.sessions).toHaveBeenCalledWith(
        expect.objectContaining({ state: "FAILED" })
      )
    );
    const activeFailed = await screen.findByRole("button", { name: /^Failed:/ });
    expect(activeFailed).toHaveAttribute("aria-pressed", "true");
    expect(activeFailed.closest(".kpi")).toHaveClass("is-pressed");
    expect(screen.getByLabelText("State")).toHaveValue("FAILED");
    expect(sessionRows()).toHaveLength(1);
    expect(sessionRows()[0]).toHaveAccessibleName(/Failed, started/);

    await user.click(screen.getByRole("button", { name: /^Recovery required:/ }));
    await waitFor(() => expect(screen.getByLabelText("State")).toHaveValue("RECOVERY_REQUIRED"));
    expect(screen.getByRole("button", { name: /^Recovery required:/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(sessionRows()).toHaveLength(1);
    expect(sessionRows()[0]).toHaveAccessibleName(/Recovery required, started/);

    await user.click(screen.getByRole("button", { name: /^Completed:/ }));
    await waitFor(() => expect(screen.getByLabelText("State")).toHaveValue("COMPLETED"));
    expect(screen.getByRole("button", { name: /^Completed:/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(sessionRows()).toHaveLength(1);
    expect(sessionRows()[0]).toHaveAccessibleName(/Completed, started/);

    await user.click(screen.getByRole("button", { name: "Show all" }));
    await waitFor(() => expect(screen.getByLabelText("State")).toHaveValue(""));
    expect(sessionRows()).toHaveLength(3);
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(document.querySelector(".kpi.is-pressed")).not.toBeInTheDocument();
  });

  it("filters to charged-but-unprinted sessions without asking the server for a state", async () => {
    const user = userEvent.setup();
    render(<SessionsPanel />);

    await user.click(await screen.findByRole("button", { name: /^Charged, not printed: 1\./ }));

    // One row survives: the charged one. The header row is always present.
    await waitFor(() => expect(sessionRows()).toHaveLength(1));
    expect(sessionRows()[0]).toHaveAccessibleName(/Recovery required, started/);
    expect(screen.getByLabelText("State")).toHaveValue("");
    expect(screen.getByRole("button", { name: /^Charged, not printed:/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(observabilityApi.sessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "CHARGED" })
    );
  });

  it("lets the state dropdown replace a card filter instead of combining with it", async () => {
    const user = userEvent.setup();
    render(<SessionsPanel />);

    await user.click(await screen.findByRole("button", { name: /^Charged, not printed:/ }));
    await waitFor(() => expect(sessionRows()).toHaveLength(1));

    await user.selectOptions(screen.getByLabelText("State"), "FAILED");
    await waitFor(() =>
      expect(observabilityApi.sessions).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: "FAILED" })
      )
    );
    await waitFor(() => expect(sessionRows()).toHaveLength(1));
    expect(sessionRows()[0]).toHaveAccessibleName(/Failed, started/);
    expect(screen.getByRole("button", { name: /^Failed:/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: /^Charged, not printed:/ })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });
});

function sessionRows(): HTMLButtonElement[] {
  return screen.getAllByRole("button", { name: /^Session on / });
}

function sessionId(ordinal: number): string {
  return `0000000${ordinal}-0000-4000-8000-000000000000`;
}

function summary(overrides: Partial<AdminSessionSummary> = {}): AdminSessionSummary {
  return {
    id: sessionId(1),
    publicId: "kiosk-handoff-1",
    kioskId: "kiosk_dev_001",
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
    paymentStatus: "CAPTURED",
    ...overrides
  };
}

function listing(): AdminSessionsResponse {
  return {
    items: [
      summary(),
      summary({ id: sessionId(2), state: "FAILED", printJobStatus: null, paymentStatus: null }),
      // Paid, and the print did not land: the cross-state verdict.
      summary({
        id: sessionId(3),
        state: "RECOVERY_REQUIRED",
        printJobStatus: "FAILED",
        paymentStatus: "CAPTURED"
      })
    ],
    nextCursor: null,
    scoped: false
  };
}

function detail() {
  return {
    session: summary(),
    settings: null,
    money: null,
    documents: { total: 0, ready: 0, rejected: 0, deleted: 0, totalBytes: 0, totalPages: 0 },
    printJob: null
  };
}
