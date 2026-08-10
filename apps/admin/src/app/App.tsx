import { SessionProvider, useSession } from "../features/auth/SessionProvider.js";
import { SecurityKeysPanel } from "../routes/SecurityKeysPanel.js";
import { SignInScreen } from "../routes/SignInScreen.js";
import { OverviewScreen } from "../routes/OverviewScreen.js";

/**
 * The control plane shell.
 *
 * Phase 1 has two screens: sign in, and a signed-in shell that proves
 * enforcement works end to end and lets an operator manage their own security
 * keys. The operational sections arrive in Phase 2; the navigation deliberately
 * does not pretend they exist yet.
 */

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const session = useSession();

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

  return (
    <div className="shell">
      <header className="shell__header">
        <div>
          <h1>Printing Kiosk — Control Plane</h1>
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
        <OverviewScreen />
        <SecurityKeysPanel />
      </main>

      <footer className="shell__footer">
        <p>
          Session ends{" "}
          <time dateTime={session.identity.session.hardExpiresAt}>
            {new Date(session.identity.session.hardExpiresAt).toLocaleTimeString()}
          </time>{" "}
          at the latest.
        </p>
      </footer>
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
