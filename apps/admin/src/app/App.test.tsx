// @vitest-environment jsdom

import { fireEvent, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  vi.spyOn(adminApi, "login").mockResolvedValue({
    state: "AUTHENTICATED",
    identity: identity()
  });
  vi.spyOn(adminApi, "completeLoginWebAuthn").mockResolvedValue(identity());
  vi.spyOn(adminApi, "ownSessions").mockResolvedValue({ items: [] });
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
 * The keys panel is one part of the Security section now. Every test that
 * manages a key has to get there first, exactly as an operator does.
 */
/**
 * People and Security are no longer rail entries: both live in the account
 * area, which is reached by pressing your own name at the foot of the rail.
 * Every test that manages a key or reads the roster now walks the route an
 * operator walks.
 */
async function openAccount(user: ReturnType<typeof userEvent.setup>, tab: string) {
  await user.click(await screen.findByRole("button", { name: /Ada Admin/ }));
  await user.click(await screen.findByRole("button", { name: tab }));
}

async function openSecurityKeys(user: ReturnType<typeof userEvent.setup>) {
  await openAccount(user, "Security");
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
    await user.click(screen.getByRole("button", { name: "Retry sign-in check" }));

    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    expect(adminApi.me).toHaveBeenCalledTimes(2);
  });

  it("keeps the signed-in shell visible when server logout cannot be confirmed", async () => {
    vi.mocked(adminApi.logout).mockRejectedValue(new TypeError("offline"));
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Overview", level: 1 });
    // Signing out lives in the account area now, beside the expiry it ends.
    await openAccount(user, "My profile");
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your sign-in may still be active");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("returns to sign-in when a child request discovers an expired session", async () => {
    vi.mocked(observabilityApi.overview).mockRejectedValue(authenticationRequired());

    render(<App />);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
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
      "browser sign-in changed to a different admin account"
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
      "browser sign-in changed to a different admin account"
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
      "browser sign-in changed to a different admin account"
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
    await user.click(await screen.findByRole("button", { name: "Recover a lost security key" }));
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

    expect(await screen.findByText(/Replace the consumed recovery envelope/)).toBeVisible();
    expect(adminApi.completeBreakGlassEnrolment).toHaveBeenCalledWith(
      ceremony("recovery").ceremonyId,
      registrationCredential,
      "Safe replacement"
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  it("coalesces same-tick duplicate sign-in requests", async () => {
    vi.mocked(adminApi.me).mockRejectedValue(authenticationRequired());
    let resolveLogin:
      ((value: { state: "AUTHENTICATED"; identity: AdminIdentityResponse }) => void) | undefined;
    vi.mocked(adminApi.login).mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      })
    );
    const user = userEvent.setup();

    render(<App />);
    await user.type(await screen.findByLabelText("Username"), "ada");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    const signIn = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(signIn);
    fireEvent.click(signIn);

    expect(adminApi.login).toHaveBeenCalledOnce();
    resolveLogin?.({ state: "AUTHENTICATED", identity: identity() });
    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  });

  it("finishes a privileged sign-in with the security key the password earned", async () => {
    vi.mocked(adminApi.me).mockRejectedValue(authenticationRequired());
    vi.mocked(adminApi.login).mockResolvedValue({
      state: "WEBAUTHN_REQUIRED",
      ceremonyId: ceremony("sign-in").ceremonyId,
      options: { challenge: "sign-in-challenge" }
    });
    const user = userEvent.setup();

    render(<App />);
    await user.type(await screen.findByLabelText("Username"), "ada");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    expect(adminApi.completeLoginWebAuthn).toHaveBeenCalledWith(
      ceremony("sign-in").ceremonyId,
      authenticationCredential
    );
  });

  it("locks rather than signs out when the idle window has passed, and reopens the same session", async () => {
    // The whole point of the rework: a lock screen keeps the person's place,
    // and one reauthentication puts them back where they were.
    vi.mocked(adminApi.me).mockResolvedValue({
      state: "LOCKED",
      displayName: "Ada Admin",
      strongAuthMethod: "WEBAUTHN"
    });
    vi.spyOn(adminApi, "beginUnlock").mockResolvedValue(
      accountBoundCeremony("unlock", identity().adminUserId)
    );
    vi.spyOn(adminApi, "completeUnlock").mockResolvedValue(identity());
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Control plane locked" })).toBeVisible();
    // Not the sign-in screen: the session still stands.
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Unlock with security key" }));

    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    expect(adminApi.completeUnlock).toHaveBeenCalledWith(
      accountBoundCeremony("unlock", identity().adminUserId).ceremonyId,
      authenticationCredential
    );
  });
});

function identity(steppedUp = false): AdminIdentityResponse {
  const now = Date.now();
  return {
    state: "ACTIVE",
    adminUserId: "01900000-0000-7000-8000-000000000101",
    username: "ada",
    displayName: "Ada Admin",
    role: "ADMIN",
    capabilities: ["dashboard.read", "authenticator.manage.self", "account.sessions.read"],
    kioskScopes: [],
    strongAuthMethod: "WEBAUTHN",
    session: {
      idleExpiresAt: new Date(now + 15 * 60_000).toISOString(),
      hardExpiresAt: new Date(now + 4 * 60 * 60_000).toISOString(),
      stepUpFreshUntil: steppedUp ? new Date(now + 5 * 60_000).toISOString() : null
    }
  };
}

describe("admin Phase 2 operational sections", () => {
  it("distinguishes print sessions and pricing from the current account sign-in", async () => {
    vi.mocked(adminApi.me).mockResolvedValue({
      ...identity(),
      capabilities: [...identity().capabilities, "session.read", "change.read", "pricing.publish"]
    });
    vi.spyOn(observabilityApi, "sessions").mockResolvedValue({
      items: [],
      nextCursor: null,
      scoped: false
    });
    vi.spyOn(observabilityApi, "changes").mockResolvedValue({
      changes: [],
      current: {
        version: "2026-08",
        currency: "AMD",
        currencyExponent: 0,
        unitAmountMinor: 50,
        duplexAdjustmentBasisPoints: 0,
        serviceFeeMinor: 100,
        minimumAmountMinor: 100,
        taxBasisPoints: 0,
        publishedAt: "2026-08-01T08:00:00.000Z",
        baselineDigest: "a".repeat(64)
      }
    });
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole("heading", { name: "Overview", level: 1 });
    expect(screen.getByRole("button", { name: "Print sessions" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sessions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pricing" })).toBeVisible();
    // The sign-in expiry and the scope disclaimer are no longer drawn under
    // every panel; both moved into the account area.
    expect(screen.queryByText(/Signed in until/)).not.toBeInTheDocument();
    expect(screen.queryByText(/This sign-in expires at/)).not.toBeInTheDocument();
    expect(screen.queryByText(/records observations and acknowledgements/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Print sessions" }));
    expect(await screen.findByRole("heading", { name: "Print sessions", level: 1 })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Pricing" }));
    expect(await screen.findByRole("heading", { name: "Pricing", level: 1 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Current pricing", level: 2 })).toBeVisible();
    expect(screen.getByText(/Enter every proposed value/)).toBeVisible();
    expect(screen.getByLabelText("Per printed side (minor units)")).not.toHaveAttribute(
      "placeholder"
    );
  });

  it("puts the worklist first and names what each number means", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    // A count with no explanation is a number nobody acts on. Awaited rather
    // than read straight after the heading: the shell renders before the
    // overview resolves, so the two are not in the same tick.
    const entry = (await screen.findByText("Document deletions that gave up")).closest("li");
    expect(entry).toHaveTextContent("2");
    expect(entry).toHaveClass("attention__item--critical");
  });

  it("says so plainly when nothing is waiting on a person", async () => {
    vi.mocked(observabilityApi.overview).mockResolvedValue({ ...overview(), attention: [] });

    render(<App />);

    expect(await screen.findByText(/No tracked issue type needs attention/)).toBeVisible();
  });

  it("shows the Windows agent and approved USB printer readiness", async () => {
    vi.mocked(adminApi.me).mockResolvedValue({
      ...identity(),
      capabilities: ["dashboard.read", "kiosk.read", "authenticator.manage.self"]
    });
    vi.spyOn(observabilityApi, "kiosks").mockResolvedValue({
      scoped: false,
      items: [
        {
          id: "kiosk-001",
          publicCode: "KIOSK-001",
          name: "Development kiosk",
          status: "ACTIVE",
          timezone: "Asia/Yerevan",
          lastSeenAt: new Date().toISOString(),
          liveness: "ONLINE",
          agent: {
            liveness: "ONLINE",
            version: "0.0.0",
            platform: "win32",
            platformRelease: "10.0",
            adapter: "WINDOWS",
            queueName: "CanonLBP361_UFR_II",
            printerHealth: "READY",
            activeOperations: 0,
            lastHeartbeatAt: new Date().toISOString()
          },
          printer: {
            queueName: "CanonLBP361_UFR_II",
            approval: "APPROVED",
            queueState: "READY",
            health: "READY",
            warningCode: null,
            driverName: "Canon Generic Plus UFR II",
            portName: "USB001",
            shared: false,
            lastSeenAt: new Date().toISOString()
          },
          liveSessions: 0,
          openPrintJobs: 0,
          recoveryRequiredJobs: 0,
          paper: {
            estimatedSheets: null,
            status: "UNAVAILABLE",
            gettingLowAtSheets: 100,
            refillSoonAtSheets: 25,
            lastRefill: null
          }
        }
      ]
    });
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Kiosks" }));

    expect(await screen.findByText("CanonLBP361_UFR_II")).toBeVisible();
    expect(screen.getByText(/USB001 · Canon Generic Plus UFR II/)).toBeVisible();
    expect(screen.getByText(/win32 10.0 · v0.0.0/)).toBeVisible();
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

  it("draws the people section from the looser capability and its controls from the stricter", async () => {
    // The authorization split, as the screen expresses it. A Technical Admin
    // holds `invitation.manage` and not `operator.manage`, so it can reach the
    // section, can hand out a new invitation code, and is not offered a
    // suspension. The server refuses all three regardless — the integration
    // suite covers that; this covers the door not opening onto a refusal.
    const roster = people();
    vi.spyOn(observabilityApi, "people").mockResolvedValue({
      ...roster,
      items: roster.items.map((person) => ({
        ...person,
        usableAuthenticators: 1,
        authenticators: [
          {
            id: keyId(7),
            label: "Counter key",
            attachment: "cross-platform" as const,
            backupEligible: false,
            createdAt: "2026-07-01T08:00:00.000Z",
            lastUsedAt: null
          }
        ]
      }))
    });
    vi.mocked(adminApi.me).mockResolvedValue({
      ...identity(),
      role: "TECHNICAL_ADMIN",
      capabilities: [
        "dashboard.read",
        "authenticator.manage.self",
        "account.sessions.read",
        "operator.read",
        "authenticator.manage.operator",
        "invitation.manage",
        "recovery.manage"
      ]
    });
    const user = userEvent.setup();

    render(<App />);
    await openAccount(user, "People");

    expect(await screen.findByRole("heading", { name: "Operators", level: 2 })).toBeVisible();
    expect(screen.getByText(/This roster contains Operator accounts only/)).toBeVisible();
    expect(await screen.findByText("Sam Operator")).toBeVisible();
    expect(screen.getByText(/No active sign-ins/)).toBeVisible();
    expect(screen.getByRole("button", { name: "New invitation code" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Change status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kiosks" })).not.toBeInTheDocument();
    const keys = screen.getByRole("button", { name: "Security keys (1)" });
    expect(keys).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Counter key")).not.toBeInTheDocument();
    await user.click(keys);
    expect(screen.getByText("Counter key")).toBeVisible();
  });

  it("hides the people section entirely from an Operator", async () => {
    vi.mocked(adminApi.me).mockResolvedValue({
      ...identity(),
      role: "OPERATOR",
      capabilities: ["dashboard.read", "audit.read.self", "authenticator.manage.self"]
    });

    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Overview", level: 1 });
    // Gone from the rail for everybody now, so the meaningful assertion is that
    // the tab inside the account area is absent for a role without the grant.
    await user.click(screen.getByRole("button", { name: /Ada Admin/ }));
    await screen.findByRole("heading", { name: "Account settings", level: 1 });
    expect(screen.queryByRole("button", { name: "People" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My profile" })).toBeVisible();
  });

  it("moves People and Security under the account area and off the rail", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Overview", level: 1 });

    // Neither is a rail entry any more. The only "Security"/"People" controls
    // that exist are the tabs inside the account area, which is not open yet.
    const rail = screen.getByRole("navigation", { name: "Sections" });
    expect(within(rail).queryByRole("button", { name: "People" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Security" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Ada Admin/ }));

    expect(
      await screen.findByRole("heading", { name: "Account settings", level: 1 })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "My profile" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("button", { name: "Security" })).toBeVisible();

    // The expiry the page footer used to repeat under every panel.
    expect(screen.getByText(/This sign-in expires at/)).toBeVisible();
    expect(screen.queryByText(/records observations and acknowledgements/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Security" }));
    expect(await screen.findByRole("heading", { name: "Your security keys" })).toBeVisible();
  });

  it("keeps a failed panel recoverable without losing the session", async () => {
    vi.mocked(observabilityApi.overview).mockRejectedValueOnce(new TypeError("offline"));
    vi.mocked(observabilityApi.overview).mockResolvedValue(overview());
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the control plane."
    );
    // Still signed in: a panel failing is not a session failing. The rail's
    // identity button is what proves it now that sign-out has moved inside.
    expect(screen.getByRole("button", { name: /Ada Admin/ })).toBeVisible();
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
      recoveryUnresolved: 0,
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

function people() {
  return {
    items: [
      {
        adminUserId: "01900000-0000-7000-8000-0000000002a1",
        username: "sam",
        displayName: "Sam Operator",
        role: "OPERATOR" as const,
        status: "PROVISIONING" as const,
        createdAt: new Date().toISOString(),
        activatedAt: null,
        suspendedAt: null,
        disabledAt: null,
        lastLoginAt: null,
        passwordSet: false,
        usableAuthenticators: 0,
        minimumAuthenticators: 0,
        authenticators: [],
        activeSessions: 0,
        kioskIds: [],
        pendingInvitationExpiresAt: null,
        pendingPasswordResetExpiresAt: null
      }
    ],
    kiosks: [{ id: "kiosk-central-01", name: "Central" }]
  };
}

function authenticatorListing(): AdminAuthenticatorsResponse {
  return {
    usableCount: 3,
    minimumRequired: 1,
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
