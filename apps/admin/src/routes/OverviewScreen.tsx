import { useCallback, useEffect, useRef, useState } from "react";

import { useSession } from "../features/auth/SessionProvider.js";
import { adminApi } from "../features/auth/api.js";

/**
 * The Phase 1 overview.
 *
 * It deliberately shows nothing about kiosks, sessions, documents, payments or
 * printing: none of that is readable yet, and a panel full of placeholder
 * numbers would be worse than an honest empty state. What it does show is the
 * authorization boundary itself, which is the thing Phase 1 actually built.
 */
export function OverviewScreen() {
  const session = useSession();
  const [reachable, setReachable] = useState<"checking" | "ok" | "failed">("checking");
  const checkInFlight = useRef<Promise<void> | null>(null);

  const check = useCallback((): Promise<void> => {
    if (checkInFlight.current) return checkInFlight.current;
    setReachable("checking");

    const attempt = adminApi
      .health()
      .then(() => setReachable("ok"))
      .catch((error: unknown) => {
        if (!session.handleAuthenticationError(error)) setReachable("failed");
      })
      .finally(() => {
        checkInFlight.current = null;
      });
    checkInFlight.current = attempt;
    return attempt;
  }, [session.handleAuthenticationError]);

  useEffect(() => {
    void check();
  }, [check]);

  const identity = session.identity;
  if (!identity) return null;

  return (
    <section className="panel">
      <h2>Overview</h2>

      <p className="panel__status" role="status">
        {reachable === "checking"
          ? "Checking the control plane…"
          : reachable === "ok"
            ? "Control plane reachable. Authorization is enforced on every request."
            : "Control plane unreachable."}
      </p>
      {reachable === "failed" ? (
        <button type="button" onClick={() => void check()}>
          Try again
        </button>
      ) : null}

      <h3>What your role can do</h3>
      <p className="panel__hint">
        These are enforced on the server. Hiding a control here is a convenience, never the
        boundary.
      </p>
      <ul className="capability-list">
        {identity.capabilities.map((capability) => (
          <li key={capability}>
            <code>{capability}</code>
          </li>
        ))}
      </ul>

      {identity.kioskScopes.length > 0 ? (
        <>
          <h3>Kiosks you may act on</h3>
          <ul className="capability-list">
            {identity.kioskScopes.map((kioskId) => (
              <li key={kioskId}>
                <code>{kioskId}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="panel__hint">
        Operational views — kiosks, sessions, printing, payments, retention — arrive in Phase 2.
      </p>
    </section>
  );
}
