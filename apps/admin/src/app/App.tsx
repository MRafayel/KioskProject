import { useState } from "react";

import type { AdminCapability } from "@printing-kiosk/admin-access";

import { SessionProvider, useSession } from "../features/auth/SessionProvider.js";
import { AuditPanel } from "../routes/AuditPanel.js";
import { ErrorsPanel } from "../routes/ErrorsPanel.js";
import { KiosksPanel } from "../routes/KiosksPanel.js";
import { MoneyPanel } from "../routes/MoneyPanel.js";
import { OverviewScreen } from "../routes/OverviewScreen.js";
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
  id: string;
  label: string;
  capability: AdminCapability;
  render: () => React.ReactNode;
}

const SECTIONS: readonly Section[] = [
  {
    id: "overview",
    label: "Overview",
    capability: "dashboard.read",
    render: () => <OverviewScreen />
  },
  { id: "kiosks", label: "Kiosks", capability: "kiosk.read", render: () => <KiosksPanel /> },
  {
    id: "sessions",
    label: "Sessions",
    capability: "session.read",
    render: () => <SessionsPanel />
  },
  { id: "printing", label: "Printing", capability: "print.read", render: () => <PrintingPanel /> },
  { id: "money", label: "Money", capability: "payment.read", render: () => <MoneyPanel /> },
  {
    id: "retention",
    label: "Retention",
    capability: "document.retention.read",
    render: () => <RetentionPanel />
  },
  { id: "errors", label: "Errors", capability: "error.read", render: () => <ErrorsPanel /> },
  { id: "audit", label: "Audit", capability: "audit.read.self", render: () => <AuditPanel /> },
  {
    id: "security-keys",
    label: "Security keys",
    capability: "authenticator.manage.self",
    render: () => <SecurityKeysPanel />
  }
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
  const [active, setActive] = useState("overview");

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

  const visible = SECTIONS.filter((section) => session.can(section.capability));
  const current = visible.find((section) => section.id === active) ?? visible[0];

  return (
    <div className="shell">
      <nav className="shell__nav" aria-label="Sections">
        <p className="shell__nav-title">Control plane</p>
        {visible.map((section) => (
          <button
            key={section.id}
            type="button"
            className={section.id === current?.id ? "nav-tab is-active" : "nav-tab"}
            aria-current={section.id === current?.id ? "page" : undefined}
            onClick={() => setActive(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <div className="shell__body">
        <header className="shell__header">
          <div>
            <h1>{current?.label ?? "Control Plane"}</h1>
            <p className="shell__identity">
              {session.identity.displayName} · <RoleBadge role={session.identity.role} />
            </p>
          </div>
          <button
            type="button"
            disabled={session.activity === "signing-out"}
            onClick={() => void session.signOut()}
          >
            {session.activity === "signing-out" ? "Signing out…" : "Sign out"}
          </button>
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
          {current ? current.render() : <p>Your role has no sections available.</p>}
        </main>

        <footer className="shell__footer">
          <p>
            Session ends{" "}
            <time dateTime={session.identity.session.hardExpiresAt}>
              {new Date(session.identity.session.hardExpiresAt).toLocaleTimeString()}
            </time>{" "}
            at the latest. This panel reads operational state; it cannot change anything, and it
            holds no credential for document storage.
          </p>
        </footer>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const label = {
    OPERATOR: "Operator",
    ADMIN: "Admin",
    TECHNICAL_ADMIN: "Technical Admin"
  }[role];
  return <span className="role-badge">{label ?? role}</span>;
}
