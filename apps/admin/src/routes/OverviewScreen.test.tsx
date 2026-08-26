// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { AdminOverviewResponse } from "@printing-kiosk/admin-access";

import { NavigationContext } from "../features/navigation.js";
import { observabilityApi } from "../features/observability/api.js";
import { OverviewScreen } from "./OverviewScreen.js";

vi.mock("../features/auth/SessionProvider.js", () => {
  const can = () => true;
  const handleAuthenticationError = () => false;
  return {
    useSession: () => ({
      can,
      handleAuthenticationError,
      identity: { kioskScopes: ["kiosk-001"] }
    })
  };
});

beforeEach(() => {
  vi.spyOn(observabilityApi, "overview").mockResolvedValue(overview());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Overview wording and hierarchy", () => {
  it("names issue types accurately and keeps repeated refund counts out of the snapshot", async () => {
    const user = userEvent.setup();
    vi.mocked(observabilityApi.overview).mockResolvedValue(
      overview({
        attention: [
          { code: "PRINT_RECOVERY_REQUIRED", severity: "CRITICAL", count: 1 },
          { code: "REFUND_UNSETTLED", severity: "WARNING", count: 2 },
          { code: "RETENTION_OVERDUE", severity: "WARNING", count: 3 }
        ],
        sessions: { live: 4, awaitingPayment: 1, printing: 1, recoveryRequired: 2 },
        printing: {
          open: 3,
          overdue: 1,
          recoveryRequired: 2,
          recoveryUnresolved: 1,
          failedRecently: 0,
          unconfirmedRecently: 0
        },
        documents: { processing: 2, failed: 1, awaitingScan: 4 },
        retention: { pending: 1, overdue: 3, deadLettered: 1 },
        money: { openPayments: 1, expiredPayments: 0, unsettledRefunds: 2 }
      })
    );

    renderOverview();

    expect(await screen.findByText("3 issue types need attention")).toBeVisible();
    expect(screen.getByText("Active print sessions")).toBeVisible();
    expect(screen.getByText("Sessions ended in recovery")).not.toBeVisible();
    await user.click(screen.getByText("Show status by area"));
    expect(screen.getAllByText("Unsettled refunds")).toHaveLength(2);
    expect(screen.getAllByText("Unresolved print recoveries")).toHaveLength(2);
    expect(screen.getByText("Sessions ended in recovery")).toBeVisible();
    expect(screen.getByText("Recovery-state print jobs")).toBeVisible();
    expect(
      screen.getByText("Upload processing and document deletions both need attention.")
    ).toBeVisible();

    const snapshot = screen
      .getByRole("heading", { name: "Operational snapshot" })
      .closest("section");
    expect(snapshot).not.toBeNull();
    expect(within(snapshot!).queryByText("Unsettled refunds")).not.toBeInTheDocument();
    expect(screen.queryByText(/Counts are cached/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/deletions need attention/i)).not.toBeInTheDocument();
  });

  it("treats answered recovery-state records as context, not unresolved work", async () => {
    const user = userEvent.setup();
    vi.mocked(observabilityApi.overview).mockResolvedValue(
      overview({
        attention: [],
        sessions: { live: 0, awaitingPayment: 0, printing: 0, recoveryRequired: 2 },
        printing: {
          open: 2,
          overdue: 0,
          recoveryRequired: 2,
          recoveryUnresolved: 0,
          failedRecently: 0,
          unconfirmedRecently: 0
        }
      })
    );

    renderOverview();

    expect(await screen.findByText("No tracked issue type needs attention.")).toBeVisible();
    await user.click(screen.getByText("Show status by area"));
    expect(screen.getByText("No print jobs need attention.")).toBeVisible();
    expect(screen.getByText("Sessions ended in recovery").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Recovery-state print jobs").parentElement).toHaveTextContent("2");
    expect(screen.queryByText(/needing recovery|waiting for a person/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Recovery")).not.toBeInTheDocument();
  });

  it("opens the exact unresolved-recovery worklist", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    vi.mocked(observabilityApi.overview).mockResolvedValue(
      overview({
        attention: [{ code: "PRINT_RECOVERY_REQUIRED", severity: "CRITICAL", count: 1 }],
        printing: {
          open: 1,
          overdue: 0,
          recoveryRequired: 2,
          recoveryUnresolved: 1,
          failedRecently: 0,
          unconfirmedRecently: 0
        }
      })
    );

    renderOverview(navigate);
    await user.click(
      await screen.findByRole("button", {
        name: "Critical. Unresolved print recoveries: 1. Show unresolved print recoveries."
      })
    );

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        section: "printing",
        printUnresolvedOnly: true
      })
    );
  });

  it("routes each retention warning to its matching filter", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    vi.mocked(observabilityApi.overview).mockResolvedValue(
      overview({
        attention: [
          { code: "RETENTION_DEAD_LETTERED", severity: "CRITICAL", count: 1 },
          { code: "RETENTION_OVERDUE", severity: "WARNING", count: 2 }
        ]
      })
    );

    renderOverview(navigate);
    await user.click(
      await screen.findByRole("button", {
        name: "Critical. Document deletions that gave up: 1. Show retention runs that gave up."
      })
    );
    await user.click(
      screen.getByRole("button", {
        name: "Warning. Sessions past their deletion deadline: 2. Show overdue retention runs."
      })
    );

    expect(navigate).toHaveBeenNthCalledWith(1, {
      section: "retention",
      retentionFilter: "GAVE_UP"
    });
    expect(navigate).toHaveBeenNthCalledWith(2, {
      section: "retention",
      retentionFilter: "OVERDUE"
    });
  });
});

function renderOverview(navigate = vi.fn()) {
  render(
    <NavigationContext value={navigate}>
      <OverviewScreen />
    </NavigationContext>
  );
  return navigate;
}

function overview(overrides: Partial<AdminOverviewResponse> = {}): AdminOverviewResponse {
  return {
    generatedAt: "2026-08-26T08:00:00.000Z",
    snapshotAgeMilliseconds: 0,
    scoped: false,
    attention: [],
    kiosks: { total: 3, online: 2, degraded: 0, offline: 1, notActive: 0 },
    sessions: { live: 4, awaitingPayment: 1, printing: 1, recoveryRequired: 0 },
    printing: {
      open: 1,
      overdue: 0,
      recoveryRequired: 0,
      recoveryUnresolved: 0,
      failedRecently: 0,
      unconfirmedRecently: 0
    },
    documents: { processing: 0, failed: 0, awaitingScan: 0 },
    retention: { pending: 1, overdue: 0, deadLettered: 0 },
    money: { openPayments: 1, expiredPayments: 0, unsettledRefunds: 0 },
    ...overrides
  };
}
