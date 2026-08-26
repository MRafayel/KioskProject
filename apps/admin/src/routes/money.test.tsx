// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type {
  AdminOverviewResponse,
  AdminPaymentsResponse,
  AdminRefundQueueResponse,
  AdminRefundsResponse
} from "@printing-kiosk/admin-access";

import { MoneyPanel } from "./MoneyPanel.js";
import { observabilityApi } from "../features/observability/api.js";

/**
 * Money, which holds three things that must not be confused with each other.
 *
 * A decision is undecided work, a payment is something that already happened,
 * and an owed refund is an obligation this panel created and cannot discharge.
 * The tests below are mostly about keeping those three apart, and about the one
 * property that matters more than any layout here: authorizing records an
 * obligation and does not pay anybody.
 */

const CAPABILITIES = new Set([
  "dashboard.read",
  "payment.read",
  "refund.obligation.read",
  "refund.authorize",
  "payment.reconcile.read"
]);

let granted = new Set(CAPABILITIES);

vi.mock("../features/auth/SessionProvider.js", () => {
  const handleAuthenticationError = () => false;
  return {
    useSession: () => ({
      can: (capability: string) => granted.has(capability),
      handleAuthenticationError
    })
  };
});

beforeEach(() => {
  granted = new Set(CAPABILITIES);
  vi.spyOn(observabilityApi, "payments").mockImplementation((filters = {}) => {
    const all = payments();
    return Promise.resolve({
      ...all,
      items: filters.status
        ? all.items.filter((payment) => payment.status === filters.status)
        : all.items
    });
  });
  vi.spyOn(observabilityApi, "refunds").mockImplementation((unsettledOnly: boolean) => {
    const all = refunds();
    return Promise.resolve({
      ...all,
      items: unsettledOnly ? all.items.filter((r) => r.completedAt === null) : all.items
    });
  });
  vi.spyOn(observabilityApi, "refundQueue").mockResolvedValue(queue());
  vi.spyOn(observabilityApi, "overview").mockResolvedValue(overview());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the money page", () => {
  it("opens on the work, not on the history", async () => {
    render(<MoneyPanel />);

    // The decision queue is the only thing here anybody has to act on.
    expect(await screen.findByRole("heading", { name: "Needs decision" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Payments" })).not.toBeInTheDocument();
    // The dot before the sentence splits the text node, so match the element.
    await waitFor(() =>
      expect(
        screen.getByText((_, element) => element?.textContent === "1 print needs a money decision")
      ).toBeInTheDocument()
    );
  });

  it("keeps the three lifecycle stages in separate views", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);
    await screen.findByRole("heading", { name: "Needs decision" });

    const views = screen.getByRole("group", { name: "Money views" });
    await user.click(within(views).getByRole("button", { name: /Payments/ }));
    expect(await screen.findByRole("heading", { name: "Payments" })).toBeVisible();
    // The ledger no longer renders underneath the decision it would distract from.
    expect(screen.queryByRole("heading", { name: "Needs decision" })).not.toBeInTheDocument();

    await user.click(within(views).getByRole("button", { name: /Unsettled refunds/ }));
    expect(await screen.findByRole("heading", { name: "Unsettled refunds" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Payments" })).not.toBeInTheDocument();
  });

  it("lands a summary card on the view its own number came from", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);
    await screen.findByRole("heading", { name: "Needs decision" });

    // The failed card is scoped to failed payments, so it opens exactly those.
    await user.click(screen.getByRole("button", { name: /^Failed payments: 1\./ }));

    expect(await screen.findByRole("heading", { name: "Payments" })).toBeVisible();
    await waitFor(() =>
      expect(observabilityApi.payments).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" })
      )
    );
    expect(screen.getByLabelText("Status")).toHaveValue("FAILED");
  });

  it("distinguishes a total that covers everything from one counted off the page", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);
    await screen.findByRole("heading", { name: "Needs decision" });

    // `unsettledCount` is the server's own figure for every unsettled refund,
    // and the snapshot's open payments cover every payment rather than a page.
    expect(screen.getByRole("button", { name: /^Unsettled refunds: 3\./ })).toBeVisible();
    expect(await screen.findByText("Open payments")).toBeVisible();
    expect(screen.getByText("Started, not finished yet")).toBeVisible();

    // The one tile counted off the page below says so where it is read.
    expect(screen.getByText("On this page of the ledger")).toBeVisible();

    // And so does the reading over the ledger: both the rate and the shares
    // name the rows they were counted from, in words.
    const views = screen.getByRole("group", { name: "Money views" });
    await user.click(within(views).getByRole("button", { name: /Payments/ }));
    expect(
      await screen.findByText(/1 of 2 finished payments on this page went through/)
    ).toBeVisible();
    expect(screen.getByText(/Share of the 2 payments on this page/)).toBeVisible();
  });

  it("makes a share of the payments on this page a way into those rows", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);
    await screen.findByRole("heading", { name: "Needs decision" });

    const views = screen.getByRole("group", { name: "Money views" });
    await user.click(within(views).getByRole("button", { name: /Payments/ }));

    // 1 captured and 1 failed out of the 2 that loaded.
    const failed = await screen.findByRole("button", { name: /^Failed: 1, 50% of 2\./ });
    expect(failed).toHaveAttribute("aria-pressed", "false");
    await user.click(failed);

    await waitFor(() =>
      expect(observabilityApi.payments).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" })
      )
    );
    // One status loaded is not a mix, and the card stops claiming a rate.
    expect(
      await screen.findByText(/Only failed payments are loaded, so there is no mix to compare/)
    ).toBeVisible();
    expect(screen.queryByText(/finished payments on this page went through/)).toBeNull();
  });

  it("says what is owed on this page without implying it is everything owed", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);
    await screen.findByRole("heading", { name: "Needs decision" });

    await user.click(screen.getByRole("button", { name: /^Unsettled refunds:/ }));
    await screen.findByRole("heading", { name: "Unsettled refunds" });

    // The amount is this page's; the count beside it is the server's.
    const label = await screen.findByText("Amount owed");
    expect(label.parentElement).toHaveTextContent("200 AMD");
    expect(
      screen.getByText(/Across the 1 unreturned refund on this page, of 3 owed in total\./)
    ).toBeVisible();
    // Thirty hours outstanding is over the day this panel calls unusual.
    const longest = screen.getByText("Waiting longest");
    expect(longest.parentElement).toHaveTextContent("1 day");
    expect(screen.getByText("1 over a day")).toBeVisible();
  });

  it("shows when a refund was returned once the owed-only filter is lifted", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);
    await screen.findByRole("heading", { name: "Needs decision" });

    await user.click(screen.getByRole("button", { name: /^Unsettled refunds:/ }));
    await screen.findByRole("heading", { name: "Unsettled refunds" });
    expect(await screen.findAllByText("Not yet")).toHaveLength(1);

    await user.selectOptions(screen.getByLabelText("Show"), "all");
    await waitFor(() =>
      expect(observabilityApi.refunds).toHaveBeenLastCalledWith(false, undefined)
    );
  });

  it("still says that authorizing does not pay anybody", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);
    await screen.findByRole("heading", { name: "Needs decision" });

    await user.click(screen.getByRole("button", { name: "Authorize a refund" }));

    // The safety text sits with the action, which is the whole point of it.
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("It does not pay anybody.");
    expect(note).toHaveTextContent(/cannot be withdrawn from this panel/);
    // And the ceiling the server enforces is on the input, not just in prose.
    expect(screen.getByLabelText(/Amount, in minor units/)).toHaveAttribute("max", "500");
  });

  it("hides everything refund-shaped from a role without the grant", async () => {
    granted = new Set(["payment.read"]);
    render(<MoneyPanel />);

    expect(await screen.findByRole("heading", { name: "Payments" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Money views" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Needs decision:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Unsettled refunds:/ })).not.toBeInTheDocument();
    expect(observabilityApi.refundQueue).not.toHaveBeenCalled();
    // The snapshot is a separate grant. Without it the whole-system tile is not
    // drawn as a dash or a zero — it is not drawn, and nothing asks for it.
    expect(screen.queryByText("Open payments")).not.toBeInTheDocument();
    expect(observabilityApi.overview).not.toHaveBeenCalled();
  });

  it("withholds provider references from a role that does not reconcile", async () => {
    granted = new Set(["payment.read"]);
    render(<MoneyPanel />);

    await screen.findByRole("heading", { name: "Payments" });
    expect(screen.getByText(/Provider references are withheld/)).toBeVisible();
    const header = screen.getByRole("row", { name: /Created/ });
    expect(
      within(header)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent)
    ).not.toContain("Provider reference");
  });
});

function uuid(n: number): string {
  return `0000000${n}-0000-4000-8000-000000000000`;
}

function payments(): AdminPaymentsResponse {
  const base = {
    sessionId: uuid(9),
    kioskId: "kiosk_dev_001",
    provider: "STRIPE",
    providerIntentId: "pi_123",
    appliedToSession: true,
    amountMinor: 500,
    currency: "AMD",
    currencyExponent: 0,
    failureCode: null,
    attempts: 1,
    expiresAt: "2026-08-23T13:00:00.000Z",
    createdAt: "2026-08-23T12:00:00.000Z",
    authorizedAt: "2026-08-23T12:00:05.000Z",
    capturedAt: "2026-08-23T12:00:09.000Z",
    failedAt: null
  };
  return {
    nextCursor: null,
    scoped: false,
    items: [
      { ...base, id: uuid(1), status: "CAPTURED" },
      {
        ...base,
        id: uuid(2),
        status: "FAILED",
        appliedToSession: false,
        failureCode: "CARD_DECLINED",
        capturedAt: null,
        failedAt: "2026-08-23T12:00:09.000Z"
      }
    ]
  };
}

function refunds(): AdminRefundsResponse {
  const base = {
    paymentId: uuid(1),
    sessionId: uuid(9),
    provider: "STRIPE",
    reason: "MISSING_PAGES",
    amountMinor: 200,
    currency: "AMD",
    currencyExponent: 0,
    createdAt: "2026-08-23T12:00:00.000Z",
    authorizedByDisplayName: "Ada Admin",
    authorizationReason: "Four sheets were unusable."
  };
  return {
    nextCursor: null,
    // The server's own count of everything unsettled, not just what loaded.
    unsettledCount: 3,
    items: [
      { ...base, id: uuid(1), status: "PENDING", completedAt: null, outstandingHours: 30 },
      {
        ...base,
        id: uuid(2),
        status: "DONE",
        completedAt: "2026-08-23T13:00:00.000Z",
        outstandingHours: null
      }
    ]
  };
}

/** Only the money block is read here; the rest is what the schema requires. */
function overview(): AdminOverviewResponse {
  return {
    generatedAt: "2026-08-23T13:00:00.000Z",
    snapshotAgeMilliseconds: 0,
    scoped: false,
    attention: [],
    kiosks: { total: 1, online: 1, degraded: 0, offline: 0, notActive: 0 },
    sessions: { live: 0, awaitingPayment: 0, printing: 0, recoveryRequired: 0 },
    printing: {
      open: 0,
      overdue: 0,
      recoveryRequired: 1,
      recoveryUnresolved: 0,
      failedRecently: 0,
      unconfirmedRecently: 0
    },
    documents: { processing: 0, failed: 0, awaitingScan: 0 },
    retention: { pending: 0, overdue: 0, deadLettered: 0 },
    money: { openPayments: 4, expiredPayments: 0, unsettledRefunds: 3 }
  };
}

function queue(): AdminRefundQueueResponse {
  return {
    nextCursor: null,
    totals: { suggested: 1, unresolvable: 0 },
    items: [
      {
        printJobId: uuid(3),
        sessionId: uuid(9),
        kioskId: "kiosk_dev_001",
        queueReason: "REFUND_SUGGESTED",
        outcome: "PARTIALLY_DELIVERED",
        reason: "Four of the ten sheets came out blank.",
        observedSheets: 6,
        sheetsProduced: 10,
        physicalSheets: 10,
        observedByDisplayName: "Sam Operator",
        observedAt: "2026-08-23T12:30:00.000Z",
        corrected: false,
        paymentId: uuid(1),
        capturedAmountMinor: 500,
        refundedAmountMinor: 0,
        authorizableAmountMinor: 500,
        currency: "AMD",
        currencyExponent: 0
      }
    ]
  };
}
