import { useRef, useState, type FormEvent } from "react";

import { useSession } from "../features/auth/SessionProvider.js";
import { AdminApiError } from "../features/auth/api.js";

/**
 * Sign in.
 *
 * There is no username field and no password field, and that is not a
 * simplification — it is the design. The credential is discoverable, so the
 * security key names the account. Nothing on this page can be used to find out
 * whether a given person has an account.
 */
export function SignInScreen() {
  const session = useSession();
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const recoveryInFlight = useRef(false);

  const submitRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (recoveryInFlight.current) return;

    const code = recoveryCode.trim();
    const label = keyLabel.trim();
    if (code.length < 32 || code.length > 200) {
      setRecoveryMessage({ kind: "error", text: "Enter the complete sealed recovery code." });
      return;
    }
    if (!label) {
      setRecoveryMessage({
        kind: "error",
        text: "Give the replacement key a name so it can be identified later."
      });
      return;
    }
    if (!acknowledged) {
      setRecoveryMessage({
        kind: "error",
        text: "Confirm that you understand the recovery code is consumed when recovery starts."
      });
      return;
    }

    recoveryInFlight.current = true;
    setRecovering(true);
    setRecoveryMessage(null);
    // Do not keep the sealed credential in component state after submission.
    setRecoveryCode("");
    try {
      await session.recoverAuthenticator(code, label);
      setKeyLabel("");
      setAcknowledged(false);
      setRecoveryMessage({
        kind: "success",
        text: "Security key enrolled. Recovery does not sign you in. Use a different sealed code and a different key if a second key is still required, then sign in. Replace every consumed recovery envelope."
      });
    } catch (error) {
      setAcknowledged(false);
      setRecoveryMessage({ kind: "error", text: describeRecoveryFailure(error) });
    } finally {
      recoveryInFlight.current = false;
      setRecovering(false);
    }
  };

  const toggleRecovery = () => {
    if (recovering) return;
    setShowRecovery((current) => !current);
    setRecoveryCode("");
    setKeyLabel("");
    setAcknowledged(false);
    setRecoveryMessage(null);
  };

  const authenticationBusy = session.activity !== "idle" || recovering;

  return (
    <main className="signin">
      <h1>Printing Kiosk — Control Plane</h1>
      <p>Sign in with your registered security key.</p>

      <button
        type="button"
        className="signin__action"
        disabled={authenticationBusy}
        onClick={() => void session.signIn()}
      >
        {session.activity === "signing-in" ? "Waiting for security key…" : "Use security key"}
      </button>

      {session.error ? (
        <p role="alert" className="signin__error">
          {session.error}
        </p>
      ) : null}

      {session.errorCanRetry ? (
        <button
          type="button"
          className="button-link"
          disabled={authenticationBusy}
          onClick={() => void session.refresh()}
        >
          Retry session check
        </button>
      ) : null}

      <p className="signin__note">
        Lost every key for your account? Recovery needs the sealed offline code and enrols a
        replacement — it does not sign you in.
      </p>

      <button
        type="button"
        className="button-link"
        aria-expanded={showRecovery}
        aria-controls="recovery-panel"
        disabled={authenticationBusy}
        onClick={toggleRecovery}
      >
        {showRecovery ? "Close recovery" : "Recover access"}
      </button>

      {showRecovery ? (
        <section id="recovery-panel" className="recovery" aria-labelledby="recovery-title">
          <h2 id="recovery-title">Enrol a replacement key</h2>
          <p id="recovery-warning" className="recovery__warning">
            Starting recovery permanently consumes one sealed code, even if the security-key prompt
            is cancelled or enrolment fails. Each code enrols only one key.
          </p>

          <form
            className="recovery__form"
            autoComplete="off"
            onSubmit={(event) => void submitRecovery(event)}
          >
            <label htmlFor="recovery-code">Sealed recovery code</label>
            <input
              id="recovery-code"
              type="password"
              value={recoveryCode}
              minLength={32}
              maxLength={200}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={recovering}
              aria-describedby="recovery-warning"
              onChange={(event) => setRecoveryCode(event.target.value)}
            />

            <label htmlFor="recovery-key-label">Name this replacement key</label>
            <input
              id="recovery-key-label"
              value={keyLabel}
              maxLength={80}
              placeholder="YubiKey — desk drawer"
              disabled={recovering}
              onChange={(event) => setKeyLabel(event.target.value)}
            />

            <label className="recovery__acknowledgement">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={recovering}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              I understand this code is spent as soon as recovery starts.
            </label>

            <button type="submit" disabled={recovering || !acknowledged}>
              {recovering ? "Recovery in progress…" : "Consume code and enrol key"}
            </button>
          </form>

          {recoveryMessage ? (
            <p
              role={recoveryMessage.kind === "error" ? "alert" : "status"}
              className={recoveryMessage.kind === "error" ? "signin__error" : "panel__status"}
            >
              {recoveryMessage.text}
            </p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

function describeRecoveryFailure(error: unknown): string {
  const instruction =
    "Treat the recovery code as spent, use a different sealed code for the next attempt, and replace the consumed envelope.";
  if (error && typeof error === "object" && "name" in error && error.name === "NotAllowedError") {
    return `The security key prompt was dismissed. ${instruction}`;
  }
  if (error instanceof AdminApiError) return `${error.message} ${instruction}`;
  return `Recovery could not be confirmed. ${instruction}`;
}
