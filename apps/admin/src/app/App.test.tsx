// @vitest-environment jsdom

import { fireEvent, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type {
  AdminAuthenticatorsResponse,
  AdminIdentityResponse
} from "@printing-kiosk/admin-access";

import { App } from "./App.js";
import { AdminApiError, adminApi } from "../features/auth/api.js";
import { observabilityApi } from "../features/observability/api.js";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn()
}));

const authenticationCredential = { id: "authentication-credential" };
const registrationCredential = { id: "registration-credential" };

beforeEach(() => {
  vi.mocked(startAuthentication).mockResolvedValue(authenticationCredential as never);
  vi.mocked(startRegistration).mockResolvedValue(registrationCredential as never);
  vi.spyOn(adminApi, "me").mockResolvedValue(identity());
  vi.spyOn(observabilityApi, "overview").mockResolvedValue(overview());
  vi.spyOn(adminApi, "authenticators").mockResolvedValue(authenticatorListing());
  vi.spyOn(adminApi, "logout").mockResolvedValue(undefined);
  vi.spyOn(adminApi, "beginEnrolment").mockResolvedValue(
    accountBoundCeremony("enrolment", identity().adminUserId)
  );
  vi.spyOn(adminApi, "completeEnrolment").mockResolvedValue({ authenticatorId: keyId(9) });
  vi.spyOn(adminApi, "beginStepUp").mockResolvedValue(
    accountBoundCeremony("step-up", identity().adminUserId)
  );
  vi.spyOn(adminApi, "completeStepUp").mockResolvedValue(identity(true));
  vi.spyOn(adminApi, "revokeAuthenticator").mockResolvedValue(undefined);
  vi.spyOn(adminApi, "beginSignIn").mockResolvedValue(ceremony("sign-in"));
  vi.spyOn(adminApi, "completeSignIn").mockResolvedValue(identity());
  vi.spyOn(adminApi, "beginBreakGlassEnrolment").mockResolvedValue(ceremony("recovery"));
  vi.spyOn(adminApi, "completeBreakGlassEnrolment").mockResolvedValue({
    authenticatorId: keyId(8)
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/**
 * The security keys panel is one section among several now. Every test that
 * manages a key has to get there first, exactly as an operator does.
 */
async function openSecurityKeys(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Security keys" }));
}

describe("admin Phase 1 workflows", () => {
  it("offers a session-check retry after a transient bootstrap failure", async () => {
    vi.mocked(adminApi.me)
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(identity());
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the control plane."
    );
    await user.click(screen.getByRole("button", { name: "Retry session check" }));

    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    expect(adminApi.me).toHaveBeenCalledTimes(2);
  });

  it("keeps the signed-in shell visible when server logout cannot be confirmed", async () => {
    vi.mocked(adminApi.logout).mockRejectedValue(new TypeError("offline"));
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Overview", level: 1 });
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your session may still be active");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Use security key" })).not.toBeInTheDocument();
  });

  it("returns to sign-in when a child request discovers an expired session", async () => {
    vi.mocked(observabilityApi.overview).mockRejectedValue(authenticationRequired());

    render(<App />);

    expect(await screen.findByRole("button", { name: "Use security key" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Overview", level: 1 })).not.toBeInTheDocument();
  });

  it("does not report enrolment success when the required step-up is cancelled", async () => {
    vi.mocked(adminApi.beginEnrolment).mockRejectedValue(stepUpRequired());
    vi.mocked(startAuthentication).mockRejectedValue(
      new DOMException("Prompt dismissed", "NotAllowedError")
    );
    const user = userEvent.setup();

    render(<App />);
    await openSecurityKeys(user);
    await screen.findByText("Desk key");
    await user.type(screen.getByLabelText("Name a new key"), "Replacement key");
    await user.click(screen.getByRole("button", { name: "Enrol security key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The security key prompt was dismissed."
    );
    expect(screen.queryByText("Security key enrolled.")).not.toBeInTheDocument();
    expect(adminApi.completeEnrolment).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name a new key")).toHaveValue("Replacement key");
  });

  it("aborts enrolment when another tab replaced the displayed account's session", async () => {
    vi.mocked(adminApi.me)
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(identityFor("Grace Operator", "01900000-0000-7000-8000-000000000102"));
    const user = userEvent.setup();

    render(<App />);
    await openSecurityKeys(user);
    await screen.findByText("Desk key");
    await user.type(screen.getByLabelText("Name a new key"), "Replacement key");
    await user.click(screen.getByRole("button", { name: "Enrol security key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "browser session changed to a different admin account"
    );
    expect(screen.getByText(/Grace Operator/)).toBeVisible();
    expect(adminApi.beginEnrolment).not.toHaveBeenCalled();
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it("aborts enrolment when the cookie changes after the identity check", async () => {
    const otherAdmin = identityFor("Grace Operator", "01900000-0000-7000-8000-000000000102");
    vi.mocked(adminApi.me)
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(otherAdmin);
    vi.mocked(adminApi.beginEnrolment).mockResolvedValue(
      accountBoundCeremony("enrolment", otherAdmin.adminUserId)
    );
    const user = userEvent.setup();

    render(<App />);
    await openSecurityKeys(user);
    await screen.findByText("Desk key");
    await user.type(screen.getByLabelText("Name a new key"), "Replacement key");
    await user.click(screen.getByRole("button", { name: "Enrol security key" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "browser session changed to a different admin account"
    );
    expect(screen.getByText(/Grace Operator/)).toBeVisible();
    expect(adminApi.beginEnrolment).toHaveBeenCalledOnce();
    expect(startRegistration).not.toHaveBeenCalled();
    expect(adminApi.completeEnrolment).not.toHaveBeenCalled();
  });

  it("steps up and resubmits the same credential when freshness expires before verify", async () => {
    vi.mocked(adminApi.completeEnrolment)
      .mockRejectedValueOnce(stepUpRequired())
      .mockResolvedValueOnce({ authenticatorId: keyId(9) });
    const user = userEvent.setup();

    render(<App />);
    await openSecurityKeys(user);
    await screen.findByText("Desk key");
    await user.type(screen.getByLabelText("Name a new key"), "Slow hardware key");
    await user.click(screen.getByRole("button", { name: "Enrol security key" }));

    expect(await screen.findByText("Security key enrolled.")).toBeVisible();
    expect(startRegistration).toHaveBeenCalledOnce();
    expect(startAuthentication).toHaveBeenCalledOnce();
    expect(adminApi.completeEnrolment).toHaveBeenCalledTimes(2);
    expect(adminApi.completeEnrolment).toHaveBeenNthCalledWith(
      1,
      accountBoundCeremony("enrolment", identity().adminUserId).ceremonyId,
      registrationCredential,
      "Slow hardware key"
    );
    expect(adminApi.completeEnrolment).toHaveBeenNthCalledWith(
      2,
      accountBoundCeremony("enrolment", identity().adminUserId).ceremonyId,
      registrationCredential,
      "Slow hardware key"
    );
  });

  it("requires confirmation and forwards the operator's bounded retirement reason", async () => {
    const user = userEvent.setup();

    render(<App />);
    await openSecurityKeys(user);
    const retireButton = await screen.findByRole("button", {
      name: /Retire Desk key, enrolled/
    });
    await user.click(retireButton);

    expect(screen.getByRole("heading", { name: "Retire Desk key?" })).toBeVisible();
    expect(adminApi.revokeAuthenticator).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(adminApi.revokeAuthenticator).not.toHaveBeenCalled();

    await user.click(retireButton);
    await user.type(screen.getByLabelText("Retirement reason"), "Lost during office move");
    await user.click(screen.getByRole("button", { name: "Confirm retirement" }));

    await waitFor(() =>
      expect(adminApi.revokeAuthenticator).toHaveBeenCalledWith(keyId(1), "Lost during office move")
    );
    expect(await screen.findByText("Security key retired.")).toBeVisible();
  });

  it("aborts retirement when another tab replaced the displayed account's session", async () => {
    vi.mocked(adminApi.me)
      .mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(identityFor("Grace Operator", "01900000-0000-7000-8000-000000000102"));
    const user = userEvent.setup();

    render(<App />);
    await openSecurityKeys(user);
    await user.click(
      await screen.findByRole("button", {
        name: /Retire Desk key, enrolled/
      })
    );
    await user.type(screen.getByLabelText("Retirement reason"), "Lost during office move");
    await user.click(screen.getByRole("button", { name: "Confirm retirement" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "browser session changed to a different admin account"
    );
    expect(screen.getByText(/Grace Operator/)).toBeVisible();
    expect(adminApi.revokeAuthenticator).not.toHaveBeenCalled();
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("runs recovery once, clears the code, and explains the two-key follow-up", async () => {
    vi.mocked(adminApi.me).mockRejectedValue(authenticationRequired());
    let resolveBegin: ((value: ReturnType<typeof ceremony>) => void) | undefined;
    vi.mocked(adminApi.beginBreakGlassEnrolment).mockReturnValue(
      new Promise((resolve) => {
        resolveBegin = resolve;
      })
    );
    const user = userEvent.setup();
    const recoveryCode = "R".repeat(43);

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Recover access" }));
    await user.type(screen.getByLabelText("Sealed recovery code"), recoveryCode);
    await user.type(screen.getByLabelText("Name this replacement key"), "Safe replacement");
    await user.click(
      screen.getByRole("checkbox", {
        name: "I understand this code is spent as soon as recovery starts."
      })
    );

    const submit = screen.getByRole("button", { name: "Consume code and enrol key" });
    fireEvent.click(submit);
    fireEvent.submit(submit.closest("form")!);

    expect(adminApi.beginBreakGlassEnrolment).toHaveBeenCalledOnce();
    expect(adminApi.beginBreakGlassEnrolment).toHaveBeenCalledWith(recoveryCode);
    expect(screen.getByLabelText("Sealed recovery code")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Recovery in progress…" })).toBeDisabled();

    resolveBegin?.(ceremony("recovery"));

    expect(
      await screen.findByText(/Use a different sealed code and a different key/)
    ).toBeVisible();
    expect(adminApi.completeBreakGlassEnrolment).toHaveBeenCalledWith(
      ceremony("recovery").ceremonyId,
      registrationCredential,
      "Safe replacement"
    );
    expect(screen.getByRole("button", { name: "Use security key" })).toBeVisible();
  });

  it("coalesces same-tick duplicate sign-in requests", async () => {
    vi.mocked(adminApi.me).mockRejectedValue(authenticationRequired());
    let resolveBegin: ((value: ReturnType<typeof ceremony>) => void) | undefined;
    vi.mocked(adminApi.beginSignIn).mockReturnValue(
      new Promise((resolve) => {
        resolveBegin = resolve;
      })
    );

    render(<App />);
    const signIn = await screen.findByRole("button", { name: "Use security key" });
    fireEvent.click(signIn);
    fireEvent.click(signIn);

    expect(adminApi.beginSignIn).toHaveBeenCalledOnce();
    resolveBegin?.(ceremony("sign-in"));
    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  });
});

function identity(steppedUp = false): AdminIdentityResponse {
  const now = Date.now();
  return {
    adminUserId: "01900000-0000-7000-8000-000000000101",
    displayName: "Ada Admin",
    role: "ADMIN",
    capabilities: ["dashboard.read", "authenticator.manage.self"],
    kioskScopes: [],
    session: {
      idleExpiresAt: new Date(now + 15 * 60_000).toISOString(),
      hardExpiresAt: new Date(now + 4 * 60 * 60_000).toISOString(),
      stepUpFreshUntil: steppedUp ? new Date(now + 5 * 60_000).toISOString() : null
    }
  };
}

describe("admin Phase 2 operational sections", () => {
  it("puts the worklist first and names what each number means", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    // A count with no explanation is a number nobody acts on.
    const entry = screen.getByText("Document deletions that gave up").closest("li");
    expect(entry).toHaveTextContent("2");
    expect(entry).toHaveClass("attention__item--critical");
  });

  it("says so plainly when nothing is waiting on a person", async () => {
    vi.mocked(observabilityApi.overview).mockResolvedValue({ ...overview(), attention: [] });

    render(<App />);

    expect(await screen.findByText(/Nothing is waiting on a person/)).toBeVisible();
  });

  it("hides a section the signed-in role has no capability for", async () => {
    // Visibility only — the server refuses the request regardless, which is
    // covered by the API's own boundary tests.
    vi.mocked(adminApi.me).mockResolvedValue({
      ...identity(),
      role: "OPERATOR",
      capabilities: ["dashboard.read", "kiosk.read", "audit.read.self", "authenticator.manage.self"]
    });

    render(<App />);

    expect(await screen.findByRole("button", { name: "Kiosks" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retention" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Money" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Printing" })).not.toBeInTheDocument();
  });

  it("keeps a failed panel recoverable without losing the session", async () => {
    vi.mocked(observabilityApi.overview).mockRejectedValueOnce(new TypeError("offline"));
    vi.mocked(observabilityApi.overview).mockResolvedValue(overview());
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the control plane."
    );
    // Still signed in: a panel failing is not a session failing.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Document deletions that gave up")).toBeVisible();
  });
});

function overview() {
  return {
    generatedAt: new Date().toISOString(),
    snapshotAgeMilliseconds: 0,
    scoped: false,
    attention: [
      { code: "RETENTION_DEAD_LETTERED" as const, severity: "CRITICAL" as const, count: 2 }
    ],
    kiosks: { total: 3, online: 2, degraded: 0, offline: 1, notActive: 0 },
    sessions: { live: 4, awaitingPayment: 1, printing: 1, recoveryRequired: 0 },
    printing: {
      open: 1,
      overdue: 0,
      recoveryRequired: 0,
      failedRecently: 0,
      unconfirmedRecently: 0
    },
    documents: { processing: 0, failed: 0, awaitingScan: 0 },
    retention: { pending: 1, overdue: 0, deadLettered: 2 },
    money: { openPayments: 1, expiredPayments: 0, unsettledRefunds: 0 }
  };
}

function identityFor(displayName: string, adminUserId: string): AdminIdentityResponse {
  return { ...identity(), displayName, adminUserId };
}

function authenticatorListing(): AdminAuthenticatorsResponse {
  return {
    usableCount: 3,
    minimumRequired: 2,
    items: [
      {
        id: keyId(1),
        label: "Desk key",
        attachment: "cross-platform",
        backupEligible: false,
        createdAt: "2026-07-01T08:00:00.000Z",
        lastUsedAt: "2026-08-09T08:00:00.000Z"
      },
      {
        id: keyId(2),
        label: "Safe key",
        attachment: "cross-platform",
        backupEligible: false,
        createdAt: "2026-07-02T08:00:00.000Z",
        lastUsedAt: null
      },
      {
        id: keyId(3),
        label: "Travel key",
        attachment: "cross-platform",
        backupEligible: false,
        createdAt: "2026-07-03T08:00:00.000Z",
        lastUsedAt: null
      }
    ]
  };
}

function ceremony(seed: string) {
  const suffix = seed === "enrolment" ? "201" : seed === "step-up" ? "202" : "203";
  return {
    ceremonyId: `01900000-0000-7000-8000-000000000${suffix}`,
    options: { challenge: `${seed}-challenge` }
  };
}

function accountBoundCeremony(seed: string, adminUserId: string) {
  return { ...ceremony(seed), adminUserId };
}

function keyId(index: number): string {
  return `01900000-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function authenticationRequired(): AdminApiError {
  return new AdminApiError(401, "ADMIN_AUTHENTICATION_REQUIRED", "Sign in to continue.");
}

function stepUpRequired(): AdminApiError {
  return new AdminApiError(401, "ADMIN_STEP_UP_REQUIRED", "Confirm with your security key.");
}
