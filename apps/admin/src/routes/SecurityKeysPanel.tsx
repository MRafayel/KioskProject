import { useCallback, useEffect, useState } from "react";

import type { AdminAuthenticatorsResponse } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { AdminApiError, adminApi } from "../features/auth/api.js";

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
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setListing(await adminApi.authenticators());
    } catch {
      setMessage("Could not load your security keys.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enrol = async () => {
    if (!label.trim()) {
      setMessage("Give the key a name so you can tell it apart later.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await session.enrolAuthenticator(label.trim());
      setLabel("");
      await load();
      setMessage("Security key enrolled.");
    } catch (error) {
      setMessage(error instanceof AdminApiError ? error.message : "Enrolment failed.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (authenticatorId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await adminApi.revokeAuthenticator(authenticatorId, "OPERATOR_RETIRED");
      await load();
      setMessage("Security key retired.");
    } catch (error) {
      if (error instanceof AdminApiError && error.requiresStepUp) {
        if (await session.stepUp()) return revoke(authenticatorId);
        return;
      }
      setMessage(error instanceof AdminApiError ? error.message : "Could not retire that key.");
    } finally {
      setBusy(false);
    }
  };

  const atMinimum = listing !== null && listing.usableCount <= listing.minimumRequired;

  return (
    <section className="panel">
      <h2>Your security keys</h2>

      {listing ? (
        <p className="panel__status">
          {listing.usableCount} enrolled · {listing.minimumRequired} required
        </p>
      ) : null}

      <ul className="key-list">
        {listing?.items.map((item) => (
          <li key={item.id} className="key-list__item">
            <div>
              <strong>{item.label}</strong>
              <span className="key-list__meta">
                {item.attachment === "cross-platform" ? "Hardware key" : "This device"}
                {item.backupEligible ? " · synchronised" : " · device-bound"}
                {item.lastUsedAt
                  ? ` · last used ${new Date(item.lastUsedAt).toLocaleDateString()}`
                  : " · never used"}
              </span>
            </div>
            <button
              type="button"
              disabled={busy || atMinimum}
              onClick={() => void revoke(item.id)}
              title={
                atMinimum
                  ? "Enrol a replacement first — your account must keep a spare."
                  : undefined
              }
            >
              Retire
            </button>
          </li>
        ))}
      </ul>

      {atMinimum ? (
        <p className="panel__hint">
          You are at the minimum. Enrol a replacement before retiring a key, so losing one never
          locks you out.
        </p>
      ) : null}

      <div className="panel__form">
        <label htmlFor="key-label">Name a new key</label>
        <input
          id="key-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          maxLength={80}
          placeholder="Yubikey — desk drawer"
        />
        <button type="button" disabled={busy} onClick={() => void enrol()}>
          Enrol security key
        </button>
      </div>

      {message ? (
        <p role="status" className="panel__status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
