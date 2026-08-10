import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { AdminAuthenticatorsResponse } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { AdminApiError, adminApi } from "../features/auth/api.js";

type Authenticator = AdminAuthenticatorsResponse["items"][number];

/**
 * Managing your own security keys.
 *
 * The important behaviour here is the ordering the server enforces and this
 * panel makes visible: a replacement is enrolled *before* a lost key is
 * retired. Doing it the other way round is how somebody ends up locked out of
 * the control plane during the incident they needed it for, so when the account
 * is at its minimum the retire buttons are disabled and say why.
 */
export function SecurityKeysPanel() {
  const session = useSession();
  const [listing, setListing] = useState<AdminAuthenticatorsResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "refreshing" | "ready" | "failed">(
    "loading"
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [retirementReason, setRetirementReason] = useState("");
  const loadSequence = useRef(0);
  const loadInFlight = useRef<Promise<boolean> | null>(null);
  const operationInFlight = useRef(false);
  const handleAuthenticationError = session.handleAuthenticationError;

  const load = useCallback(
    (force = false): Promise<boolean> => {
      if (!force && loadInFlight.current) return loadInFlight.current;

      const sequence = ++loadSequence.current;
      setLoadState((current) => (current === "ready" ? "refreshing" : "loading"));
      setLoadError(null);

      const attempt = (async () => {
        try {
          const next = await adminApi.authenticators();
          if (loadSequence.current === sequence) {
            setListing(next);
            setLoadState("ready");
            setRetiringId((current) =>
              current && next.items.some((item) => item.id === current) ? current : null
            );
          }
          return true;
        } catch (error) {
          if (handleAuthenticationError(error)) return false;
          if (loadSequence.current === sequence) {
            setLoadState("failed");
            setLoadError("Could not load your security keys.");
          }
          return false;
        } finally {
          if (loadSequence.current === sequence) loadInFlight.current = null;
        }
      })();
      loadInFlight.current = attempt;
      return attempt;
    },
    [handleAuthenticationError]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const enrol = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (operationInFlight.current) return;

    const requestedLabel = label.trim();
    if (!requestedLabel) {
      setMessage({
        kind: "error",
        text: "Give the key a name so you can tell it apart later."
      });
      return;
    }

    operationInFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const enrolled = await session.enrolAuthenticator(requestedLabel);
      if (!enrolled) return;

      setLabel("");
      const refreshed = await load(true);
      setMessage({
        kind: "success",
        text: refreshed
          ? "Security key enrolled."
          : "Security key enrolled, but the updated list could not be loaded. Refresh before making another change."
      });
    } catch (error) {
      if (handleAuthenticationError(error)) return;
      const refreshed = await load(true);
      setMessage({
        kind: "error",
        text: `${describeOperationFailure(error, "Enrolment could not be confirmed.")} ${
          refreshed
            ? "Check the updated list before trying again."
            : "Refresh the list before trying again."
        }`
      });
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  };

  const revoke = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!retiringId || operationInFlight.current) return;

    const reason = retirementReason.trim();
    if (reason.length < 3 || reason.length > 48) {
      setMessage({
        kind: "error",
        text: "Give a retirement reason between 3 and 48 characters for the audit trail."
      });
      return;
    }

    operationInFlight.current = true;
    setBusy(true);
    setMessage(null);
    const authenticatorId = retiringId;
    try {
      if (!(await session.confirmCurrentIdentity())) return;

      try {
        await adminApi.revokeAuthenticator(authenticatorId, reason);
      } catch (error) {
        if (!(error instanceof AdminApiError) || !error.requiresStepUp) throw error;
        if (!(await session.stepUp())) return;
        await adminApi.revokeAuthenticator(authenticatorId, reason);
      }

      setRetiringId(null);
      setRetirementReason("");
      const refreshed = await load(true);
      setMessage({
        kind: "success",
        text: refreshed
          ? "Security key retired."
          : "Security key retired, but the updated list could not be loaded. Refresh before making another change."
      });
    } catch (error) {
      if (handleAuthenticationError(error)) return;
      const refreshed = await load(true);
      setMessage({
        kind: "error",
        text: `${describeOperationFailure(error, "Retirement could not be confirmed.")} ${
          refreshed
            ? "Check the updated list before trying again."
            : "Refresh the list before trying again."
        }`
      });
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  };

  const atMinimum = listing !== null && listing.usableCount <= listing.minimumRequired;
  const canManage = session.can("authenticator.manage.self");
  const retiring = listing?.items.find((item) => item.id === retiringId) ?? null;

  return (
    <section className="panel" aria-labelledby="security-keys-title">
      <div className="panel__heading">
        <h2 id="security-keys-title">Your security keys</h2>
        <button
          type="button"
          className="button-link"
          disabled={busy || loadState === "loading" || loadState === "refreshing"}
          onClick={() => void load(true)}
        >
          {loadState === "refreshing" ? "Refreshing…" : "Refresh list"}
        </button>
      </div>

      {listing ? (
        <p className="panel__status">
          {listing.usableCount} enrolled · {listing.minimumRequired} required
        </p>
      ) : null}

      {loadState === "loading" ? <p role="status">Loading your security keys…</p> : null}
      {loadError ? (
        <div className="panel__error">
          <p role="alert">{loadError}</p>
          <button type="button" disabled={busy} onClick={() => void load(true)}>
            Try again
          </button>
        </div>
      ) : null}

      {listing && listing.items.length === 0 ? (
        <p className="panel__hint">No usable security keys were returned.</p>
      ) : null}

      {listing && listing.items.length > 0 ? (
        <ul className="key-list">
          {listing.items.map((item) => (
            <li key={item.id} className="key-list__item">
              <div>
                <strong>{item.label}</strong>
                <span className="key-list__meta">
                  {describeAuthenticator(item)} · enrolled {formatDate(item.createdAt)}
                  {item.lastUsedAt
                    ? ` · last used ${formatDate(item.lastUsedAt)}`
                    : " · never used"}
                </span>
              </div>
              {canManage ? (
                <button
                  type="button"
                  disabled={busy || atMinimum}
                  aria-label={`Retire ${item.label}, enrolled ${formatDate(item.createdAt)}`}
                  onClick={() => {
                    setRetiringId(item.id);
                    setRetirementReason("");
                    setMessage(null);
                  }}
                  title={
                    atMinimum
                      ? "Enrol a replacement first — your account must keep a spare."
                      : undefined
                  }
                >
                  Retire
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {atMinimum ? (
        <p className="panel__hint">
          You are at the minimum. Enrol a replacement before retiring a key, so losing one never
          locks you out.
        </p>
      ) : null}

      {retiring && canManage ? (
        <form className="panel__retirement" onSubmit={(event) => void revoke(event)}>
          <h3>Retire {retiring.label}?</h3>
          <p className="panel__hint">
            Enrolled {formatDate(retiring.createdAt)}. This cannot be undone. Record why the key is
            being retired for the audit trail. Do not include customer, document, payment, or
            credential data.
          </p>
          <label htmlFor="retirement-reason">Retirement reason</label>
          <input
            id="retirement-reason"
            value={retirementReason}
            minLength={3}
            maxLength={48}
            placeholder="Lost key or scheduled rotation"
            disabled={busy}
            onChange={(event) => setRetirementReason(event.target.value)}
          />
          <div className="panel__actions">
            <button type="submit" disabled={busy || atMinimum}>
              {busy ? "Confirming…" : "Confirm retirement"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRetiringId(null);
                setRetirementReason("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {canManage ? (
        <form className="panel__form" onSubmit={(event) => void enrol(event)}>
          <label htmlFor="key-label">Name a new key</label>
          <input
            id="key-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={80}
            placeholder="YubiKey — desk drawer"
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            {busy ? "Security-key action in progress…" : "Enrol security key"}
          </button>
        </form>
      ) : (
        <p className="panel__hint">Your role cannot manage security keys.</p>
      )}

      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={message.kind === "error" ? "panel__error-text" : "panel__status"}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

function describeAuthenticator(item: Authenticator): string {
  const location =
    item.attachment === "cross-platform"
      ? "Hardware key"
      : item.attachment === "platform"
        ? "This device"
        : "Security key";
  return `${location}${item.backupEligible ? " · synchronised" : " · device-bound"}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function describeOperationFailure(error: unknown, fallback: string): string {
  if (error instanceof AdminApiError) return error.message;
  if (error && typeof error === "object" && "name" in error && error.name === "NotAllowedError") {
    return "The security key prompt was dismissed.";
  }
  return fallback;
}
