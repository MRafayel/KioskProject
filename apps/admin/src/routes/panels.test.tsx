// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type {
  AdminErrorsResponse,
  AdminKiosksResponse,
  AdminPrintJobsResponse,
  AdminRetentionResponse
} from "@printing-kiosk/admin-access";

import { AuditPanel } from "./AuditPanel.js";
import { ErrorsPanel } from "./ErrorsPanel.js";
import { KiosksPanel } from "./KiosksPanel.js";
import { PrintingPanel } from "./PrintingPanel.js";
import { RetentionPanel } from "./RetentionPanel.js";
import { observabilityApi } from "../features/observability/api.js";

/**
 * The Sessions patterns, on the pages that adopted them.
 *
 * One assertion per page for the thing that page gained, because the point of
 * sharing `FilterKpi`, `Sheet` and the data table was that these four screens
 * stop being four different answers to the same question. A regression that
 * breaks the pattern on one page and not the others is exactly what this is
 * here to catch.
 */

vi.mock("../features/auth/SessionProvider.js", () => {
  const handleAuthenticationError = () => false;
  return {
    useSession: () => ({
      can: () => true,
      handleAuthenticationError,
      confirmCurrentIdentity: () => Promise.resolve(true),
      stepUp: () => Promise.resolve(true)
    })
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Every table on these pages leads with a timestamp and offers filter tiles. */
function tileNamed(pattern: RegExp) {
  return screen.findByRole("button", { name: pattern });
}

function bodyRows() {
  // The header row is a row too; the data rows are the ones with cells.
  return screen.getAllByRole("row").slice(1);
}

describe("Printing", () => {
  beforeEach(() => {
    vi.spyOn(observabilityApi, "printJobs").mockImplementation((filters = {}) => {
      const all = printJobs();
      return Promise.resolve({
        ...all,
        items: filters.status ? all.items.filter((job) => job.status === filters.status) : all.items
      });
    });
    vi.spyOn(observabilityApi, "printJob").mockResolvedValue({
      job: printJobs().items[0]!,
      ledger: [],
      command: null,
      resolution: null,
      corrections: []
    });
  });

  it("leads with when the job was created and keeps the identifier out of the columns", async () => {
    render(<PrintingPanel />);

    const header = await screen.findByRole("row", { name: /created/i });
    const columns = within(header)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);

    expect(columns).toEqual(["Created", "Kiosk", "Status", "Result", "Sheets", "Attempts"]);
    expect(columns).not.toContain("Job");
  });

  it("opens a job in a sheet carrying its identifiers, and returns focus on close", async () => {
    const user = userEvent.setup();
    render(<PrintingPanel />);

    const open = await screen.findByRole("button", { name: /Completed, created/ });
    await user.click(open);

    const sheet = await screen.findByRole("dialog", { name: "Print job detail" });
    expect(within(sheet).getByText(JOB_ID)).toBeInTheDocument();
    expect(within(sheet).getByText(SESSION_ID)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(open);
  });

  it("filters to unresolved recoveries on the server and keeps the dropdown synchronized", async () => {
    const user = userEvent.setup();
    render(<PrintingPanel />);

    await user.click(await tileNamed(/^Unresolved recovery: 1\./));

    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(
      within(bodyRows()[0]!).getByRole("button", { name: /Recovery required, created/ })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveValue("UNRESOLVED");
    expect(observabilityApi.printJobs).toHaveBeenLastCalledWith({
      status: "RECOVERY_REQUIRED",
      recoveryResolved: "false"
    });
  });

  it("sends a status tile to the server and syncs the dropdown", async () => {
    const user = userEvent.setup();
    render(<PrintingPanel />);

    await user.click(await tileNamed(/^Failed print jobs: 1\./));

    await waitFor(() =>
      expect(observabilityApi.printJobs).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" })
      )
    );
    expect(screen.getByLabelText("Status")).toHaveValue("FAILED");
  });
});

describe("Kiosks", () => {
  beforeEach(() => {
    vi.spyOn(observabilityApi, "kiosks").mockResolvedValue(kiosks());
    vi.spyOn(observabilityApi, "kioskPaper").mockResolvedValue({
      kioskId: "k1",
      paper: kiosks().items[0]!.paper,
      items: [],
      nextCursor: null
    });
  });

  it("filters to offline kiosks and exposes degraded heartbeat state separately", async () => {
    const user = userEvent.setup();
    render(<KiosksPanel />);

    await user.click(await tileNamed(/^Offline or never seen: 1\./));

    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(screen.getByText("Back office")).toBeInTheDocument();
    expect(screen.queryByText("Front counter")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all" }));
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
  });

  it("filters low estimates and records refills and corrections in the kiosk sheet", async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(observabilityApi, "addKioskPaper").mockResolvedValue({
      event: paperEvent("REFILL", 500, 500),
      estimatedSheets: 520,
      status: "HEALTHY",
      replayed: false
    });
    const correct = vi.spyOn(observabilityApi, "correctKioskPaper").mockResolvedValue({
      event: paperEvent("CORRECTION", 200, 180),
      estimatedSheets: 200,
      status: "HEALTHY",
      replayed: false
    });
    render(<KiosksPanel />);

    const lowCard = await tileNamed(/^Low paper estimate: 1\./);
    await user.click(lowCard);
    expect(lowCard).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(screen.getByText("Front counter")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Open Front counter/ }));
    const sheet = await screen.findByRole("dialog", { name: "Front counter" });
    expect(within(sheet).getByText("~20 sheets remaining")).toBeVisible();
    expect(within(sheet).getByText(/Software estimate only/)).toBeVisible();

    await user.click(within(sheet).getByRole("button", { name: "Add paper" }));
    await user.type(within(sheet).getByLabelText("Physical sheets loaded"), "500");
    await user.click(within(sheet).getByRole("button", { name: "Add to estimate" }));
    await waitFor(() => expect(add).toHaveBeenCalledOnce());
    const refillCall = add.mock.calls[0];
    expect(refillCall?.[0]).toBe("k1");
    expect(refillCall?.[1].sheetsAdded).toBe(500);
    expect(refillCall?.[1].requestKey).toMatch(/^[0-9a-f-]{36}$/u);

    await user.click(within(sheet).getByRole("button", { name: "Correct estimate" }));
    const estimate = within(sheet).getByLabelText("Estimated sheets remaining");
    await user.clear(estimate);
    await user.type(estimate, "200");
    await user.type(within(sheet).getByLabelText("Reason for correction"), "Tray counted");
    await user.click(within(sheet).getByRole("button", { name: "Correct estimate" }));
    await waitFor(() => expect(correct).toHaveBeenCalledOnce());
    const correctionCall = correct.mock.calls[0];
    expect(correctionCall?.[0]).toBe("k1");
    expect(correctionCall?.[1].estimatedSheets).toBe(200);
    expect(correctionCall?.[1].reason).toBe("Tray counted");
    expect(correctionCall?.[1].requestKey).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe("Retention", () => {
  beforeEach(() => {
    vi.spyOn(observabilityApi, "retention").mockImplementation((problemsOnly: boolean) => {
      const all = retention();
      return Promise.resolve({
        ...all,
        items: problemsOnly
          ? all.items.filter((run) => run.overdue || run.status === "DEAD_LETTER")
          : all.items
      });
    });
  });

  it("opens on distinct problems, filters overdue strictly, and can show all runs", async () => {
    const user = userEvent.setup();
    render(<RetentionPanel />);

    // Opens problems-only, which is the point of the page.
    await waitFor(() => expect(observabilityApi.retention).toHaveBeenCalledWith(true, undefined));
    expect(await tileNamed(/^Problems: 2\./)).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(bodyRows()).toHaveLength(2));

    // One run is both overdue and dead-lettered. Problems counts that union once,
    // while Overdue shows only rows carrying the overdue flag.
    await user.click(screen.getByRole("button", { name: /^Overdue:/ }));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Show all" }));
    await waitFor(() =>
      expect(observabilityApi.retention).toHaveBeenLastCalledWith(false, undefined)
    );
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
  });

  it("says how far a stuck run got rather than only naming its checkpoint", async () => {
    render(<RetentionPanel />);
    expect(await screen.findByText("Access closed, files still there")).toBeInTheDocument();
  });

  it("opens a category drilldown with the matching card and rows selected", async () => {
    render(<RetentionPanel initialFilter="GAVE_UP" />);

    expect(await tileNamed(/^Gave up: 2\./)).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(screen.getByText(/in a stopped-retry state/)).toBeVisible();
  });
});

describe("Errors", () => {
  beforeEach(() => {
    vi.spyOn(observabilityApi, "errors").mockResolvedValue(errors());
  });

  it("filters to the groups nobody has claimed", async () => {
    const user = userEvent.setup();
    render(<ErrorsPanel />);

    await user.click(await tileNamed(/^Nobody on it: 1\./));

    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(screen.getByText("PRINTER_OFFLINE")).toBeInTheDocument();
    expect(screen.queryByText("UPLOAD_REJECTED")).not.toBeInTheDocument();
  });

  it("narrows by subsystem alongside a tile", async () => {
    const user = userEvent.setup();
    render(<ErrorsPanel />);

    await screen.findByText("PRINTER_OFFLINE");
    await user.selectOptions(screen.getByLabelText("Subsystem"), "UPLOAD");

    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(screen.getByText("UPLOAD_REJECTED")).toBeInTheDocument();
  });
});

describe("Audit", () => {
  beforeEach(() => {
    vi.spyOn(observabilityApi, "audit").mockResolvedValue({
      scope: "ALL",
      nextCursor: null,
      items: [
        auditEntry({
          id: uuid(1),
          action: "admin.session.read",
          outcome: "SUCCESS",
          actorDisplayName: "Sam",
          actorId: "admin-1"
        }),
        auditEntry({
          id: uuid(2),
          action: "admin.refund.authorize",
          outcome: "REFUSED",
          actorDisplayName: "Sam",
          actorId: "admin-2"
        })
      ]
    });
  });

  it("filters the page by outcome and says so", async () => {
    const user = userEvent.setup();
    render(<AuditPanel />);

    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    await user.selectOptions(screen.getByLabelText("Outcome"), "REFUSED");

    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(screen.getByText("admin.refund.authorize")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all" }));
    await waitFor(() => expect(bodyRows()).toHaveLength(2));

    const header = screen.getAllByRole("row")[0]!;
    expect(within(header).getByRole("columnheader", { name: "Print session" })).toBeVisible();
  });

  it("shows a single shared load error and retry action", async () => {
    vi.mocked(observabilityApi.audit).mockRejectedValueOnce(new Error("offline"));
    render(<AuditPanel />);

    expect(await screen.findAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("keeps people with the same display name distinct in the actor filter", async () => {
    const user = userEvent.setup();
    render(<AuditPanel />);

    await user.selectOptions(await screen.findByLabelText("Actor"), "admin-2");
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(screen.getByText("admin.refund.authorize")).toBeVisible();
    expect(screen.queryByText("admin.session.read")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function uuid(ordinal: number): string {
  return `0000000${ordinal}-0000-4000-8000-000000000000`;
}

const JOB_ID = uuid(1);
const SESSION_ID = uuid(9);

function printJobs(): AdminPrintJobsResponse {
  const base = {
    sessionId: SESSION_ID,
    kioskId: "kiosk_dev_001",
    resultConfidence: "CONFIRMED",
    failureCode: null,
    warningCode: null,
    copies: 1,
    printedSides: 2,
    physicalSheets: 1,
    sheetsProduced: 1,
    dispatchAttempts: 1,
    deadlineAt: "2026-08-23T13:00:00.000Z",
    createdAt: "2026-08-23T12:00:00.000Z",
    dispatchedAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    manifestRedactedAt: null,
    overdue: false,
    recoveryResolved: true
  };
  return {
    nextCursor: null,
    scoped: false,
    items: [
      { ...base, id: JOB_ID, status: "COMPLETED" },
      { ...base, id: uuid(2), status: "FAILED", resultConfidence: "UNCONFIRMED" },
      {
        ...base,
        id: uuid(3),
        status: "RECOVERY_REQUIRED",
        recoveryResolved: false,
        sheetsProduced: null
      }
    ]
  };
}

function kiosks(): AdminKiosksResponse {
  const base = {
    status: "ACTIVE",
    timezone: "UTC",
    lastSeenAt: "2026-08-23T12:00:00.000Z",
    agent: null,
    printer: null,
    liveSessions: 0,
    openPrintJobs: 0,
    recoveryRequiredJobs: 0,
    paper: {
      estimatedSheets: null,
      status: "UNAVAILABLE" as const,
      gettingLowAtSheets: 100 as const,
      refillSoonAtSheets: 25 as const,
      lastRefill: null
    }
  };
  return {
    scoped: false,
    items: [
      {
        ...base,
        id: "k1",
        publicCode: "K-1",
        name: "Front counter",
        liveness: "ONLINE",
        paper: {
          estimatedSheets: 20,
          status: "REFILL_SOON",
          gettingLowAtSheets: 100,
          refillSoonAtSheets: 25,
          lastRefill: {
            sheetsAdded: 500,
            note: "New ream",
            recordedByAdminUserId: uuid(8),
            recordedByDisplayName: "Operator One",
            recordedAt: "2026-08-23T12:00:00.000Z"
          }
        }
      },
      { ...base, id: "k2", publicCode: "K-2", name: "Back office", liveness: "OFFLINE" }
    ]
  };
}

function paperEvent(type: "REFILL" | "CORRECTION", quantitySheets: number, deltaSheets: number) {
  return {
    id: uuid(type === "REFILL" ? 9 : 10),
    type,
    quantitySheets,
    deltaSheets,
    estimateAffected: true,
    reason: type === "CORRECTION" ? "Tray counted" : null,
    printJobId: null,
    recordedByAdminUserId: uuid(8),
    recordedByDisplayName: "Operator One",
    recordedByRole: "OPERATOR",
    createdAt: "2026-08-23T12:00:00.000Z"
  } as const;
}

function retention(): AdminRetentionResponse {
  const base = {
    kioskId: "kiosk_dev_001",
    sessionState: "COMPLETED" as const,
    reason: "SESSION_TERMINAL",
    attempts: 1,
    lastErrorCode: null,
    objectsDeleted: 0,
    orphanObjectsDeleted: 0,
    availableAt: "2026-08-23T12:00:00.000Z",
    dueAt: "2026-08-23T12:00:00.000Z",
    createdAt: "2026-08-23T11:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
    completedAt: null,
    deadLetteredAt: null
  };
  return {
    nextCursor: null,
    scoped: false,
    totals: { pending: 1, overdue: 1, deadLettered: 2 },
    items: [
      {
        ...base,
        sessionId: uuid(1),
        status: "DEAD_LETTER",
        checkpoint: "ACCESS_REVOKED",
        overdue: true,
        deadLetteredAt: "2026-08-23T12:30:00.000Z"
      },
      {
        ...base,
        sessionId: uuid(2),
        status: "DEAD_LETTER",
        checkpoint: "SCHEDULED",
        overdue: false,
        deadLetteredAt: "2026-08-23T12:20:00.000Z"
      },
      {
        ...base,
        sessionId: uuid(3),
        status: "DONE",
        checkpoint: "COMPLETED",
        overdue: false,
        completedAt: "2026-08-23T12:10:00.000Z"
      }
    ]
  };
}

function errors(): AdminErrorsResponse {
  return {
    windowHours: 24,
    truncated: false,
    scoped: false,
    groups: [
      {
        subsystem: "PRINTING",
        code: "PRINTER_OFFLINE",
        kioskId: "kiosk_dev_001",
        count: 6,
        lastSeenAt: "2026-08-23T12:00:00.000Z",
        acknowledgedAt: null,
        acknowledgedBy: null,
        recurredSinceAcknowledgement: false
      },
      {
        subsystem: "UPLOAD",
        code: "UPLOAD_REJECTED",
        kioskId: null,
        count: 2,
        lastSeenAt: "2026-08-23T11:00:00.000Z",
        acknowledgedAt: "2026-08-23T11:30:00.000Z",
        acknowledgedBy: "Sam",
        recurredSinceAcknowledgement: false
      }
    ]
  };
}

function auditEntry(overrides: {
  id: string;
  action: string;
  outcome: string;
  actorDisplayName?: string;
  actorId?: string;
}) {
  return {
    occurredAt: "2026-08-23T12:00:00.000Z",
    actorType: "ADMIN",
    actorId: "admin-1",
    actorDisplayName: null,
    kioskId: null,
    sessionId: null,
    requestId: null,
    metadata: {},
    redactedKeys: [],
    ...overrides
  };
}
