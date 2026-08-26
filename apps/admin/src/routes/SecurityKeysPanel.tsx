import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type {
  AdminAuthenticatorsResponse,
  AdminOwnSessionsResponse
} from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { AdminApiError, adminApi } from "../features/auth/api.js";

type Authenticator = AdminAuthenticatorsResponse["items"][number];

/**
 * The Security section: your password, your sign-ins, your keys. Everything on
 * this page is about the signed-in account and nothing else's.
 */
export function SecurityPanel() {
  return (
    <>
      <OwnSessionsPanel />
      <PasswordPanel />
      <SecurityKeysPanel />
    </>
  );
}

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

/**
 * Where you are signed in.
 *
 * The address and browser strings are context for "is this mine", nothing
 * more: the page never claims they identify a device, and neither does the
 * server. The one sign-in that cannot be revoked from here is the one being
 * used — that is what "Sign out" is for.
 */
function OwnSessionsPanel() {
  const session = useSession();
  const [listing, setListing] = useState<AdminOwnSessionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const inFlight = useRef(false);
  const handleAuthenticationError = session.handleAuthenticationError;

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setListing(await adminApi.ownSessions());
    } catch (error) {
      if (handleAuthenticationError(error)) return;
      setLoadError("Could not load where you are signed in.");
    }
  }, [handleAuthenticationError]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (work: () => Promise<void>, success: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await load();
      setMessage({ kind: "success", text: success });
    } catch (error) {
      if (handleAuthenticationError(error)) return;
      setMessage({
        kind: "error",
        text: error instanceof AdminApiError ? error.message : "The request could not be completed."
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const others = listing?.items.filter((item) => !item.current) ?? [];

  return (
    <section className="panel" aria-labelledby="own-sessions-title">
      <div className="panel__heading">
        <h2 id="own-sessions-title">Where you are signed in</h2>
        <button type="button" className="button-link" disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {loadError ? (
        <p role="alert" className="panel__error-text">
          {loadError}
        </p>
      ) : null}

      {listing ? (
        <ul className="key-list">
          {listing.items.map((item) => (
            <li key={item.sessionId} className="key-list__item">
              <div>
                <strong>
                  {item.current ? "This browser" : (describeUserAgent(item.userAgent) ?? "Browser")}
                  {item.state === "LOCKED" ? " · locked" : ""}
                </strong>
                <span className="key-list__meta">
                  signed in {formatDateTime(item.createdAt)}
                  {item.lastSeenAt ? ` · last active ${formatDateTime(item.lastSeenAt)}` : ""}
                  {item.ipAddress ? ` · from ${item.ipAddress}` : ""}
                </span>
              </div>
              {!item.current ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => adminApi.revokeOwnSession(item.sessionId),
                      "Signed out from that browser."
                    )
                  }
                >
                  Sign out
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p role="status">Loading where you are signed in…</p>
      )}

      {others.length > 0 ? (
        <div className="panel__actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await adminApi.revokeOtherSessions();
              }, "Signed out everywhere else.")
            }
          >
            Sign out everywhere else
          </button>
        </div>
      ) : null}

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

/**
 * Changing your own password. The server demands the current password and a
 * fresh strong reauthentication, and ends every other sign-in when it
 * succeeds — so the panel says all three before the person starts.
 */
function PasswordPanel() {
  const session = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const inFlight = useRef(false);
  const handleAuthenticationError = session.handleAuthenticationError;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (newPassword.length < 12) {
      setMessage({ kind: "error", text: "The new password must be at least 12 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage({ kind: "error", text: "The two new passwords do not match." });
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        if (!(await session.confirmCurrentIdentity())) return;
        const change = () => adminApi.changePassword(currentPassword, newPassword);
        let result;
        try {
          result = await change();
        } catch (error) {
          if (!(error instanceof AdminApiError) || !error.requiresStepUp) throw error;
          if (!(await session.stepUp())) return;
          result = await change();
        }
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setMessage({
          kind: "success",
          text:
            result.revokedSessions > 0
              ? `Password changed. Signed out ${result.revokedSessions} other sign-in${
                  result.revokedSessions === 1 ? "" : "s"
                }.`
              : "Password changed."
        });
      } catch (error) {
        if (handleAuthenticationError(error)) return;
        setMessage({
          kind: "error",
          text:
            error instanceof AdminApiError ? error.message : "The password could not be changed."
        });
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };

  return (
    <section className="panel" aria-labelledby="password-title">
      <h2 id="password-title">Your password</h2>
      <p className="panel__hint">
        Changing it asks you to confirm it is you, and signs you out everywhere else.
      </p>

      <form className="panel__form" onSubmit={submit}>
        <label htmlFor="password-current">Current password</label>
        <input
          id="password-current"
          type="password"
          value={currentPassword}
          autoComplete="current-password"
          maxLength={128}
          disabled={busy}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <label htmlFor="password-new">New password (at least 12 characters)</label>
        <input
          id="password-new"
          type="password"
          value={newPassword}
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          disabled={busy}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <label htmlFor="password-confirm">Repeat the new password</label>
        <input
          id="password-confirm"
          type="password"
          value={confirmPassword}
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          disabled={busy}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
        <button type="submit" disabled={busy || !currentPassword || newPassword.length < 12}>
          {busy ? "Changing…" : "Change password"}
        </button>
      </form>

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

function describeUserAgent(userAgent: string | null): string | null {
  if (!userAgent) return null;
  // A rough family name is all the page needs; the full string is noise.
  if (userAgent.includes("Firefox/")) return "Firefox";
  if (userAgent.includes("Edg/")) return "Edge";
  if (userAgent.includes("Chrome/")) return "Chrome";
  if (userAgent.includes("Safari/")) return "Safari";
  return userAgent.slice(0, 40);
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
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
