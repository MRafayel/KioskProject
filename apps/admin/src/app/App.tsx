import { useCallback, useState } from "react";

import { SessionProvider, useSession } from "../features/auth/SessionProvider.js";
import {
  canOpenSection,
  destinationKey,
  NavigationContext,
  type AdminDestination,
  type AdminSectionId
} from "../features/navigation.js";
import { AccountScreen, roleLabel } from "../routes/AccountScreen.js";
import { AuditPanel } from "../routes/AuditPanel.js";
import { ChangesPanel } from "../routes/ChangesPanel.js";
import { ErrorsPanel } from "../routes/ErrorsPanel.js";
import { KiosksPanel } from "../routes/KiosksPanel.js";
import { MoneyPanel } from "../routes/MoneyPanel.js";
import { OverviewScreen } from "../routes/OverviewScreen.js";
import { PrintingPanel } from "../routes/PrintingPanel.js";
import { RetentionPanel } from "../routes/RetentionPanel.js";
import { SessionsPanel } from "../routes/SessionsPanel.js";
import { SignInScreen } from "../routes/SignInScreen.js";

/**
 * The control plane shell.
 *
 * Sections are hidden when the signed-in role lacks the capability behind them.
 * That is a courtesy, not a boundary: the server refuses the request whatever
 * this file draws, and every one of those refusals is covered by test.
 */

/** The three ids that resolve into the account area rather than the rail. */
const ACCOUNT_SECTIONS = new Set<AdminSectionId>(["people", "security-keys", "account"]);

interface Section {
  id: AdminSectionId;
  label: string;
  /** Draws the panel, given whatever brought the operator here. */
  render: (destination: AdminDestination) => React.ReactNode;
}

const SECTIONS: readonly Section[] = [
  { id: "overview", label: "Overview", render: () => <OverviewScreen /> },
  {
    id: "kiosks",
    label: "Kiosks",
    render: (destination) => <KiosksPanel initialFilter={destination.kioskFilter} />
  },
  {
    id: "sessions",
    label: "Print sessions",
    render: (destination) => <SessionsPanel initialState={destination.sessionState} />
  },
  {
    id: "printing",
    label: "Printing",
    render: (destination) => (
      <PrintingPanel
        initialStatus={destination.printStatus}
        initialUnresolved={destination.printUnresolvedOnly}
      />
    )
  },
  {
    id: "money",
    label: "Money",
    render: (destination) => <MoneyPanel focus={destination.moneyFocus} />
  },
  {
    id: "retention",
    label: "Retention",
    render: (destination) => <RetentionPanel initialFilter={destination.retentionFilter} />
  },
  { id: "errors", label: "Errors", render: () => <ErrorsPanel /> },
  { id: "audit", label: "Audit", render: () => <AuditPanel /> },
  { id: "changes", label: "Pricing", render: () => <ChangesPanel /> },
  // Reached from the account area rather than the rail. They stay in this list
  // because they are still real destinations — an overview link or a deep link
  // resolves to them — but `RAIL_SECTIONS` below is what the rail draws.
  {
    id: "people",
    label: "People",
    render: () => <AccountScreen initialTab="people" />
  },
  {
    id: "security-keys",
    label: "Security",
    render: () => <AccountScreen initialTab="security" />
  },
  {
    id: "account",
    label: "Account settings",
    render: (destination) => <AccountScreen initialTab={destination.accountTab} />
  }
];

/**
 * What the rail draws, which is no longer everything reachable.
 *
 * People, Security and the account area are all one place now, and that place
 * is reached by pressing your own name at the foot of the rail. Listing them
 * here as well would put the same destination on screen twice and leave the
 * rail as long as it was, which was the thing worth fixing.
 */
const RAIL_SECTIONS = SECTIONS.filter((section) => !ACCOUNT_SECTIONS.has(section.id));

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const session = useSession();
  const [destination, setDestination] = useState<AdminDestination>({ section: "overview" });

  // Identity is settled before any of this renders, so `can` is safe to consult
  // here; the guard below returns early while it is not.
  const canOpen = session.can;
  const navigate = useCallback(
    (target: AdminDestination) => {
      // A link the operator cannot follow should not move them somewhere they
      // will only be refused. The overview already hides these, so reaching
      // this means the capability changed under them mid-session.
      if (!canOpenSection(target.section, canOpen)) return;
      setDestination(target);
    },
    [canOpen]
  );

  if (session.status === "loading") {
    return (
      <main className="shell">
        <p role="status">Checking your sign-in…</p>
      </main>
    );
  }

  if (session.status === "locked" && session.locked) {
    return <LockScreen />;
  }

  if (session.status === "signed-out" || !session.identity) {
    return <SignInScreen />;
  }

  const railSections = RAIL_SECTIONS.filter((section) => canOpenSection(section.id, session.can));
  const reachable = SECTIONS.filter((section) => canOpenSection(section.id, session.can));
  const current =
    reachable.find((section) => section.id === destination.section) ?? railSections[0];
  const inAccount = current ? ACCOUNT_SECTIONS.has(current.id) : false;

  return (
    <NavigationContext value={navigate}>
      <div className="shell">
        {/* The rail owns navigation and the signed-in identity together. Who you
          are is a property of the whole sign-in rather than of the screen you
          happen to be on, so repeating it above every panel spent the most
          valuable strip of the page on something that never changes. */}
        <div className="shell__rail">
          <p className="shell__rail-title">Control plane</p>

          <nav className="shell__nav" aria-label="Sections">
            {railSections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={section.id === current?.id ? "nav-tab is-active" : "nav-tab"}
                aria-current={section.id === current?.id ? "page" : undefined}
                onClick={() => setDestination({ section: section.id })}
              >
                {section.label}
              </button>
            ))}
          </nav>

          {/* Your own name is the door to everything about your account: the
              sign-in, your keys, and — where the role holds it — the roster of
              people. It is a real button rather than a tile with a handler, so
              it is one `Tab` stop and announces where it goes.

              Signing out used to sit directly beneath it and has moved inside,
              next to the expiry it ends. It is an authentication action, it
              belongs with the other ones, and a destructive control permanently
              parked one pixel below a navigation control is a misclick waiting
              for a tired evening. */}
          <div className="shell__account">
            <button
              type="button"
              className={inAccount ? "shell__identity is-active" : "shell__identity"}
              aria-current={inAccount ? "page" : undefined}
              onClick={() => setDestination({ section: "account" })}
            >
              <span className="shell__avatar" aria-hidden="true">
                {initials(session.identity.displayName)}
              </span>
              <span className="shell__identity-text">
                <span className="shell__account-name">{session.identity.displayName}</span>
                <span className="shell__account-role">{roleLabel(session.identity.role)}</span>
              </span>
              <span className="shell__identity-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          </div>
        </div>

        <div className="shell__body">
          <header className="shell__header">
            <h1>{current?.label ?? "Control Plane"}</h1>
          </header>

          <main className="shell__main">
            {session.error ? (
              <div role="alert" className="shell__alert">
                <span>{session.error}</span>
                <div className="panel__actions">
                  {session.errorCanRetry ? (
                    <button
                      type="button"
                      disabled={session.activity === "refreshing"}
                      onClick={() => void session.refresh()}
                    >
                      Retry sign-in check
                    </button>
                  ) : null}
                  <button type="button" onClick={session.clearError}>
                    Dismiss
                  </button>
                </div>
              </div>
            ) : null}
            {/* Keyed by the destination so arriving at a panel for a new reason
              re-opens it with that filter. Without the key, a second visit
              would keep the first filter and show the wrong rows under a
              heading that looked right. */}
            {current ? (
              <div className="shell__section" key={destinationKey(destination)}>
                {current.render(destination)}
              </div>
            ) : (
              <p>Your role has no sections available.</p>
            )}
          </main>
        </div>
      </div>
    </NavigationContext>
  );
}

/**
 * The lock screen: the sign-in paused, not ended.
 *
 * A privileged role reopens with one key touch; the password works for
 * everybody. "Not me" signs the account out properly. Nothing else renders —
 * the sign-in behind this screen still holds a place in whatever the person
 * was doing, and drawing any of it would defeat the lock.
 */
function LockScreen() {
  const session = useSession();
  const [password, setPassword] = useState("");
  const locked = session.locked;
  if (!locked) return null;

  const busy = session.activity !== "idle";
  const submitPassword = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !password) return;
    const submitted = password;
    setPassword("");
    void session.unlock(submitted);
  };

  return (
    <main className="signin" aria-labelledby="lock-title">
      <h1 id="lock-title">Control plane locked</h1>
      <p>
        {locked.displayName} — you have been away for a while. Confirm it is you to continue where
        you left off.
      </p>

      {locked.strongAuthMethod === "WEBAUTHN" ? (
        <button
          type="button"
          className="signin__action"
          disabled={busy}
          onClick={() => void session.unlock()}
        >
          {session.activity === "unlocking"
            ? "Waiting for security key…"
            : "Unlock with security key"}
        </button>
      ) : null}

      <form className="recovery__form signin__form" onSubmit={submitPassword}>
        <label htmlFor="lock-password">
          {locked.strongAuthMethod === "WEBAUTHN" ? "Or unlock with your password" : "Password"}
        </label>
        <input
          id="lock-password"
          type="password"
          value={password}
          autoComplete="current-password"
          maxLength={128}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="submit" className="recovery__submit" disabled={busy || !password}>
          {session.activity === "unlocking" ? "Unlocking…" : "Unlock"}
        </button>
      </form>

      {locked.strongAuthMethod === "WEBAUTHN" ? (
        <p className="signin__note">
          A password unlock reopens the dashboard; sensitive actions will still ask for your key.
        </p>
      ) : null}

      {session.error ? (
        <p role="alert" className="signin__error">
          {session.error}
        </p>
      ) : null}

      <button
        type="button"
        className="button-link"
        disabled={session.activity === "signing-out"}
        onClick={() => void session.signOut()}
      >
        Not {locked.displayName}? Sign out
      </button>
    </main>
  );
}

/**
 * Two letters standing in for a face, matching the account area's avatar.
 *
 * Kept here rather than imported so the rail does not depend on a route module
 * for one string operation; the rule is four lines and identical in both.
 */
function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}
