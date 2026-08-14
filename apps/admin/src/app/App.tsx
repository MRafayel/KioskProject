import { useCallback, useState } from "react";

import { SessionProvider, useSession } from "../features/auth/SessionProvider.js";
import {
  destinationKey,
  NavigationContext,
  SECTION_CAPABILITY,
  type AdminDestination,
  type AdminSectionId
} from "../features/navigation.js";
import { AuditPanel } from "../routes/AuditPanel.js";
import { ChangesPanel } from "../routes/ChangesPanel.js";
import { ErrorsPanel } from "../routes/ErrorsPanel.js";
import { KiosksPanel } from "../routes/KiosksPanel.js";
import { MoneyPanel } from "../routes/MoneyPanel.js";
import { OverviewScreen } from "../routes/OverviewScreen.js";
import { PeoplePanel } from "../routes/PeoplePanel.js";
import { PrintingPanel } from "../routes/PrintingPanel.js";
import { RetentionPanel } from "../routes/RetentionPanel.js";
import { SecurityKeysPanel } from "../routes/SecurityKeysPanel.js";
import { SessionsPanel } from "../routes/SessionsPanel.js";
import { SignInScreen } from "../routes/SignInScreen.js";

/**
 * The control plane shell.
 *
 * Sections are hidden when the signed-in role lacks the capability behind them.
 * That is a courtesy, not a boundary: the server refuses the request whatever
 * this file draws, and every one of those refusals is covered by test.
 */

interface Section {
  id: AdminSectionId;
  label: string;
  /** Draws the panel, given whatever brought the operator here. */
  render: (destination: AdminDestination) => React.ReactNode;
}

const SECTIONS: readonly Section[] = [
  { id: "overview", label: "Overview", render: () => <OverviewScreen /> },
  { id: "kiosks", label: "Kiosks", render: () => <KiosksPanel /> },
  {
    id: "sessions",
    label: "Sessions",
    render: (destination) => <SessionsPanel initialState={destination.sessionState} />
  },
  {
    id: "printing",
    label: "Printing",
    render: (destination) => <PrintingPanel initialStatus={destination.printStatus} />
  },
  {
    id: "money",
    label: "Money",
    render: (destination) => <MoneyPanel focus={destination.moneyFocus} />
  },
  {
    id: "retention",
    label: "Retention",
    render: (destination) => (
      <RetentionPanel initialProblemsOnly={destination.retentionProblemsOnly} />
    )
  },
  { id: "errors", label: "Errors", render: () => <ErrorsPanel /> },
  { id: "audit", label: "Audit", render: () => <AuditPanel /> },
  { id: "changes", label: "Changes", render: () => <ChangesPanel /> },
  { id: "people", label: "People", render: () => <PeoplePanel /> },
  { id: "security-keys", label: "Security keys", render: () => <SecurityKeysPanel /> }
];

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
      if (!canOpen(SECTION_CAPABILITY[target.section])) return;
      setDestination(target);
    },
    [canOpen]
  );

  if (session.status === "loading") {
    return (
      <main className="shell">
        <p role="status">Checking your session…</p>
      </main>
    );
  }

  if (session.status === "signed-out" || !session.identity) {
    return <SignInScreen />;
  }

  const visible = SECTIONS.filter((section) => session.can(SECTION_CAPABILITY[section.id]));
  const current = visible.find((section) => section.id === destination.section) ?? visible[0];

  return (
    <NavigationContext value={navigate}>
      <div className="shell">
        {/* The rail owns navigation and the signed-in identity together. Who you
          are is a property of the whole session rather than of the screen you
          happen to be on, so repeating it above every panel spent the most
          valuable strip of the page on something that never changes. */}
        <div className="shell__rail">
          <p className="shell__rail-title">Control plane</p>

          <nav className="shell__nav" aria-label="Sections">
            {visible.map((section) => (
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

          <div className="shell__account">
            <p className="shell__account-name">{session.identity.displayName}</p>
            <p className="shell__account-role">{roleLabel(session.identity.role)}</p>
            <button
              type="button"
              className="shell__signout"
              disabled={session.activity === "signing-out"}
              onClick={() => void session.signOut()}
            >
              {session.activity === "signing-out" ? "Signing out…" : "Sign out"}
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
                      Retry session check
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

          <footer className="shell__footer">
            <p>
              Session ends{" "}
              <time dateTime={session.identity.session.hardExpiresAt}>
                {new Date(session.identity.session.hardExpiresAt).toLocaleTimeString()}
              </time>{" "}
              at the latest. This panel records observations and acknowledgements; it cannot move
              money, change a kiosk, or reach document contents.
            </p>
          </footer>
        </div>
      </div>
    </NavigationContext>
  );
}

/**
 * On the rail this is plain text rather than a badge.
 *
 * The status tones are reserved for "somebody has to do something", and a role
 * is a standing fact, not a task. Tinting it would put a second coloured thing
 * beside the active section and teach the eye to stop trusting the tone.
 */
function roleLabel(role: string): string {
  return (
    {
      OPERATOR: "Operator",
      ADMIN: "Admin",
      TECHNICAL_ADMIN: "Technical Admin"
    }[role] ?? role
  );
}
