// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type {
  AdminMoneySummaryResponse,
  AdminPaymentsResponse,
  AdminRefundQueueResponse,
  AdminRefundsResponse
} from "@printing-kiosk/admin-access";

import { MoneyPanel } from "./MoneyPanel.js";
import { observabilityApi } from "../features/observability/api.js";

/**
 * Money, which is a dashboard on top of three things that must not be confused.
 *
 * A decision is undecided work, a payment is something that already happened,
 * and an owed refund is an obligation this panel created and cannot discharge.
 * The tests below are about keeping those apart, about the one property that
 * matters more than any layout here — authorizing records an obligation and does
 * not pay anybody — and about the property the dashboard rests on: every figure
 * above the ledger is the server's count over a window, and no percentage is
 * drawn without two server totals behind it.
 */

const CAPABILITIES = new Set([
  "dashboard.read",
  "payment.read",
  "refund.obligation.read",
  "refund.authorize",
  "payment.reconcile.read"
]);

let granted = new Set(CAPABILITIES);
let report: AdminMoneySummaryResponse;

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
  report = summary();
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
  vi.spyOn(observabilityApi, "moneySummary").mockImplementation((window) =>
    Promise.resolve({ ...report, window })
  );
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

  it("reads the business from the server's window, not from the page of rows", async () => {
    render(<MoneyPanel />);

    // Two payments loaded in the ledger below; the dashboard says forty, because
    // forty is what the database counted over the window.
    expect(await screen.findByText("128,400 AMD")).toBeVisible();
    expect(screen.getByText("last 7 days")).toBeVisible();

    const payments = screen.getByText("Payments started").closest(".fact") as HTMLElement;
    expect(payments).toHaveTextContent("40");

    // 34 captured of the 38 that finished. The two still in flight are excluded
    // rather than counted as failures.
    const rate = screen.getByText("Success rate").closest(".fact") as HTMLElement;
    expect(rate).toHaveTextContent("89.5%");
    expect(screen.getByText(/2 of these are still in flight/)).toBeVisible();
  });

  it("states every change against the period the server measured beside it", async () => {
    render(<MoneyPanel />);

    // 128,400 against 118,000 is 8.8% more; 40 payments against 32 is 25% more.
    expect(await screen.findByText(/8\.8% more than the previous 7 days/)).toBeVisible();
    expect(screen.getByText(/25\.0% more than the previous 7 days/)).toBeVisible();
    // A rate is compared in points, never in percent: 89.5 against 93.8.
    expect(screen.getByText(/4\.3 points lower than the previous 7 days/)).toBeVisible();
  });

  it("refuses to state a change when the previous period held nothing", async () => {
    report = summary({
      previous: {
        from: "2026-08-14T20:00:00.000Z",
        to: "2026-08-20T20:00:00.000Z",
        started: 0,
        byStatus: [],
        capturedAmounts: []
      }
    });
    render(<MoneyPanel />);

    // No percentage against an empty period — "up from nothing" is not a
    // percentage, and the card says what it actually knows instead.
    const takings = (await screen.findByRole("heading", { name: "Money taken" })).closest(
      ".module"
    ) as HTMLElement;
    expect(within(takings).getAllByText(/Nothing in the previous 7 days/).length).toBeGreaterThan(
      0
    );
    expect(within(takings).queryByText(/% more than/)).toBeNull();
  });

  it("asks the server again when the window changes", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);
    await screen.findByText("128,400 AMD");

    const windows = screen.getByRole("group", { name: "Time window" });
    await user.click(within(windows).getByRole("button", { name: /last 30 days/i }));

    await waitFor(() => expect(observabilityApi.moneySummary).toHaveBeenCalledWith("MONTH"));
  });

  it("makes a status in the window a way into those rows in the ledger", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);

    // 3 of the 40 payments the server counted, not 1 of the 2 that loaded below.
    const failed = await screen.findByRole("button", { name: /^Failed: 3, 8% of 40\./ });
    expect(failed).toHaveAttribute("aria-pressed", "false");
    await user.click(failed);

    expect(await screen.findByRole("heading", { name: "Payments" })).toBeVisible();
    await waitFor(() =>
      expect(observabilityApi.payments).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" })
      )
    );
    expect(screen.getByLabelText("Status")).toHaveValue("FAILED");
    // The ledger is not window-scoped, and does not pretend to be.
    expect(screen.getByText(/not limited to the window above/)).toBeVisible();
  });

  it("puts what needs a person in a strip that is absent when nothing does", async () => {
    render(<MoneyPanel />);

    const strip = await screen.findByRole("region", { name: "Needs attention" });
    // The liability is the server's whole outstanding figure, in money.
    expect(strip).toHaveTextContent("4,300 AMD owed");
    expect(strip).toHaveTextContent("oldest waiting 1 day");
    expect(strip).toHaveTextContent("1 ran out of time");
    // The decision count arrives from its own read, so it appears when it does
    // rather than being drawn as a zero while the answer is still outstanding.
    expect(await within(strip).findByRole("button", { name: /1 prints? need/ })).toBeVisible();

    cleanup();
    report = summary({
      now: { open: 0, expired: 0 },
      liability: { unsettled: 0, amounts: [], oldestOutstandingHours: null }
    });
    vi.mocked(observabilityApi.refundQueue).mockResolvedValue({
      ...queue(),
      items: [],
      totals: { suggested: 0, unresolvable: 0 }
    });

    render(<MoneyPanel />);
    await screen.findByRole("heading", { name: "Needs decision" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull()
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

  it("shows when a refund was returned once the owed-only filter is lifted", async () => {
    const user = userEvent.setup();
    render(<MoneyPanel />);
    await screen.findByRole("heading", { name: "Needs decision" });

    const views = screen.getByRole("group", { name: "Money views" });
    await user.click(within(views).getByRole("button", { name: /Unsettled refunds/ }));
    await screen.findByRole("heading", { name: "Unsettled refunds" });
    expect(await screen.findAllByText("Not yet")).toHaveLength(1);

    await user.selectOptions(screen.getByLabelText("Show"), "all");
    await waitFor(() =>
      expect(observabilityApi.refunds).toHaveBeenLastCalledWith(false, undefined)
    );
  });

  it("hides everything refund-shaped from a role without the grant", async () => {
    granted = new Set(["payment.read"]);
    // The server withholds the refund halves from such a role; so must the page.
    report = summary({ liability: null, refunds: null });
    render(<MoneyPanel />);

    expect(await screen.findByRole("heading", { name: "Payments" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Money views" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Refunds" })).not.toBeInTheDocument();
    expect(observabilityApi.refundQueue).not.toHaveBeenCalled();
    // The payment half of the dashboard is still theirs to read.
    expect(screen.getByText("128,400 AMD")).toBeVisible();
  });

  it("withholds provider references from a role that does not reconcile", async () => {
    granted = new Set(["payment.read"]);
    report = summary({ liability: null, refunds: null });
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

  it("draws no chart it cannot draw honestly", async () => {
    report = summary({ trend: [], trendTruncated: true });
    render(<MoneyPanel />);

    expect(await screen.findByText(/Too many payments in this window to chart/)).toBeVisible();
    // The totals are counted by the database and are unaffected by the ceiling.
    expect(screen.getByText("128,400 AMD")).toBeVisible();
  });
});

function uuid(n: number): string {
  return `0000000${n}-0000-4000-8000-000000000000`;
}

const AMD = { currency: "AMD", currencyExponent: 0 } as const;

function summary(overrides: Partial<AdminMoneySummaryResponse> = {}): AdminMoneySummaryResponse {
  return {
    generatedAt: "2026-08-26T17:45:00.000Z",
    scoped: false,
    window: "WEEK",
    utcOffsetMinutes: 240,
    interval: "DAY",
    current: {
      from: "2026-08-20T20:00:00.000Z",
      to: "2026-08-26T17:45:00.000Z",
      started: 40,
      byStatus: [
        { status: "CAPTURED", count: 34 },
        { status: "FAILED", count: 3 },
        { status: "PENDING", count: 2 },
        { status: "EXPIRED", count: 1 }
      ],
      capturedAmounts: [{ ...AMD, amountMinor: 128_400 }]
    },
    previous: {
      from: "2026-08-14T22:15:00.000Z",
      to: "2026-08-20T20:00:00.000Z",
      started: 32,
      byStatus: [
        { status: "CAPTURED", count: 30 },
        { status: "FAILED", count: 2 }
      ],
      capturedAmounts: [{ ...AMD, amountMinor: 118_000 }]
    },
    trend: Array.from({ length: 7 }, (_unused, index) => ({
      startsAt: `2026-08-${20 + index}T20:00:00.000Z`,
      endsAt: `2026-08-${21 + index}T20:00:00.000Z`,
      partial: index === 0 || index === 6,
      started: 4 + index,
      captured: 3 + index,
      failed: index === 3 ? 2 : 0,
      capturedAmounts: [{ ...AMD, amountMinor: 12_000 + index * 2_400 }]
    })),
    trendTruncated: false,
    now: { open: 2, expired: 1 },
    liability: {
      unsettled: 6,
      amounts: [{ ...AMD, amountMinor: 4_300 }],
      oldestOutstandingHours: 41
    },
    refunds: {
      current: {
        raised: 5,
        raisedAmounts: [{ ...AMD, amountMinor: 6_100 }],
        returned: 3,
        returnedAmounts: [{ ...AMD, amountMinor: 3_200 }]
      },
      previous: {
        raised: 2,
        raisedAmounts: [{ ...AMD, amountMinor: 2_400 }],
        returned: 4,
        returnedAmounts: [{ ...AMD, amountMinor: 4_800 }]
      }
    },
    ...overrides
  };
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
