import { startRegistration } from "@simplewebauthn/browser";
import { useRef, useState, type FormEvent } from "react";

import type { InvitationPreviewResponse } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { AdminApiError, adminApi } from "../features/auth/api.js";

/**
 * Sign in: username and password for everybody, then a security-key prompt for
 * the roles that carry one. Below the form, the three code-driven ways in — an
 * invitation for a new account, a password reset, and sealed break-glass
 * recovery for a privileged account that lost its keys.
 *
 * Nothing on this page can be used to find out whether a given person has an
 * account: every failure is one generic refusal.
 */
export function SignInScreen() {
  const session = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [openPanel, setOpenPanel] = useState<"none" | "invitation" | "reset" | "recovery">("none");

  const busy = session.activity !== "idle";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !username.trim() || !password) return;
    const submittedPassword = password;
    // The password leaves component state the moment it is submitted.
    setPassword("");
    void session.signIn(username.trim(), submittedPassword);
  };

  const togglePanel = (panel: "invitation" | "reset" | "recovery") => {
    setOpenPanel((current) => (current === panel ? "none" : panel));
  };

  return (
    <main className="signin">
      <h1>Printing Kiosk — Control Plane</h1>
      <p>Sign in with your username and password.</p>

      <form className="recovery__form signin__form" onSubmit={submit}>
        <label htmlFor="signin-username">Username</label>
        <input
          id="signin-username"
          value={username}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          disabled={busy}
          onChange={(event) => setUsername(event.target.value)}
        />

        <label htmlFor="signin-password">Password</label>
        <input
          id="signin-password"
          type="password"
          value={password}
          autoComplete="current-password"
          maxLength={128}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />

        <button
          type="submit"
          className="signin__action"
          disabled={busy || !username.trim() || !password}
        >
          {session.activity === "signing-in" ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="signin__note">
        Admin and Technical Admin accounts confirm with their security key after the password.
      </p>

      {session.error ? (
        <p role="alert" className="signin__error">
          {session.error}
        </p>
      ) : null}

      {session.errorCanRetry ? (
        <button
          type="button"
          className="button-link"
          disabled={busy}
          onClick={() => void session.refresh()}
        >
          Retry session check
        </button>
      ) : null}

      <div className="signin__links">
        <button
          type="button"
          className="button-link"
          aria-expanded={openPanel === "invitation"}
          disabled={busy}
          onClick={() => togglePanel("invitation")}
        >
          {openPanel === "invitation" ? "Close invitation" : "I have an invitation code"}
        </button>
        <button
          type="button"
          className="button-link"
          aria-expanded={openPanel === "reset"}
          disabled={busy}
          onClick={() => togglePanel("reset")}
        >
          {openPanel === "reset" ? "Close reset" : "I have a password reset code"}
        </button>
        <button
          type="button"
          className="button-link"
          aria-expanded={openPanel === "recovery"}
          disabled={busy}
          onClick={() => togglePanel("recovery")}
        >
          {openPanel === "recovery" ? "Close recovery" : "Recover a lost security key"}
        </button>
      </div>

      {openPanel === "invitation" ? <InvitationPanel /> : null}
      {openPanel === "reset" ? <ResetPanel /> : null}
      {openPanel === "recovery" ? <RecoveryPanel /> : null}
    </main>
  );
}

/**
 * Accepting an invitation: prove the code, set a password, and — when the role
 * requires one — enrol a security key. The code stays valid until the account
 * activates, so a fumbled key prompt costs a retry rather than a fresh code.
 */
function InvitationPanel() {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<InvitationPreviewResponse | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [passwordDone, setPasswordDone] = useState(false);
  const [activated, setActivated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const inFlight = useRef(false);

  const guard = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage({ kind: "error", text: describeFailure(error) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const lookUp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void guard(async () => {
      const found = await adminApi.previewInvitation(code.trim());
      setPreview(found);
      setPasswordDone(found.passwordSet);
    });
  };

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword.length < 12) {
      setMessage({ kind: "error", text: "The password must be at least 12 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage({ kind: "error", text: "The two passwords do not match." });
      return;
    }
    void guard(async () => {
      const progress = await adminApi.setInvitationPassword(code.trim(), newPassword);
      setNewPassword("");
      setConfirmPassword("");
      setPasswordDone(true);
      setActivated(progress.activated);
      setMessage({
        kind: "success",
        text: progress.activated
          ? "Your account is ready. Sign in above with your username and new password."
          : "Password set. Enrol your security key below to finish."
      });
    });
  };

  const enrolKey = () => {
    const label = keyLabel.trim();
    if (!label) {
      setMessage({ kind: "error", text: "Give the key a name so it can be identified later." });
      return;
    }
    void guard(async () => {
      const ceremony = await adminApi.beginInvitationEnrolment(code.trim());
      const credential = await startRegistration({ optionsJSON: ceremony.options as never });
      const result = await adminApi.completeInvitationEnrolment(
        code.trim(),
        ceremony.ceremonyId,
        credential,
        label
      );
      setActivated(result.activated);
      setMessage({
        kind: "success",
        text: result.activated
          ? "Security key enrolled and your account is ready. Sign in above."
          : "Security key enrolled."
      });
    });
  };

  return (
    <section className="recovery" aria-labelledby="invitation-title">
      <h2 id="invitation-title">Set up your account</h2>
      <p className="recovery__warning">
        Use the invitation code you were given. It works until your account is fully set up or the
        code expires; if something goes wrong mid-way, you can retry with the same code.
      </p>

      {!preview ? (
        <form className="recovery__form" autoComplete="off" onSubmit={lookUp}>
          <label htmlFor="invitation-code">Invitation code</label>
          <input
            id="invitation-code"
            type="password"
            value={code}
            minLength={32}
            maxLength={200}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
          />
          <button
            type="submit"
            className="recovery__submit"
            disabled={busy || code.trim().length < 32}
          >
            {busy ? "Checking…" : "Continue"}
          </button>
        </form>
      ) : (
        <>
          <p className="panel__status">
            {preview.displayName} — signs in as <strong>{preview.username}</strong> ({preview.role})
          </p>

          {!activated ? (
            <form className="recovery__form" autoComplete="off" onSubmit={submitPassword}>
              <label htmlFor="invitation-password">
                {passwordDone ? "Replace your password (optional)" : "Choose a password"}
              </label>
              <input
                id="invitation-password"
                type="password"
                value={newPassword}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                disabled={busy}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <label htmlFor="invitation-password-confirm">Repeat the password</label>
              <input
                id="invitation-password-confirm"
                type="password"
                value={confirmPassword}
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                disabled={busy}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              <button
                type="submit"
                className="recovery__submit"
                disabled={busy || newPassword.length < 12}
              >
                {busy ? "Saving…" : "Set password"}
              </button>
            </form>
          ) : null}

          {preview.webAuthnRequired && passwordDone && !activated ? (
            <div className="recovery__form">
              <label htmlFor="invitation-key-label">Name your security key</label>
              <input
                id="invitation-key-label"
                value={keyLabel}
                maxLength={80}
                placeholder="Touch ID on this Mac, or a hardware key"
                disabled={busy}
                onChange={(event) => setKeyLabel(event.target.value)}
              />
              <button
                type="button"
                className="recovery__submit"
                disabled={busy || !keyLabel.trim()}
                onClick={enrolKey}
              >
                {busy ? "Waiting for the key…" : "Enrol security key"}
              </button>
            </div>
          ) : null}
        </>
      )}

      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={message.kind === "error" ? "signin__error" : "panel__status"}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

/** Completing an administrator-issued password reset. */
function ResetPanel() {
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const inFlight = useRef(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (newPassword.length < 12) {
      setMessage({ kind: "error", text: "The password must be at least 12 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage({ kind: "error", text: "The two passwords do not match." });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const submittedCode = code.trim();
    // The one-time code leaves component state on submission.
    setCode("");
    void (async () => {
      try {
        await adminApi.completePasswordReset(submittedCode, newPassword);
        setNewPassword("");
        setConfirmPassword("");
        setMessage({
          kind: "success",
          text: "Password changed, and every session was signed out. Sign in above with the new password."
        });
      } catch (error) {
        setMessage({ kind: "error", text: describeFailure(error) });
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    })();
  };

  return (
    <section className="recovery" aria-labelledby="reset-title">
      <h2 id="reset-title">Set a new password</h2>
      <p className="recovery__warning">
        Use the reset code an administrator issued for you. It works once and expires quickly.
        Completing it signs your account out of every browser; your security keys are untouched.
      </p>

      <form className="recovery__form" autoComplete="off" onSubmit={submit}>
        <label htmlFor="reset-code">Reset code</label>
        <input
          id="reset-code"
          type="password"
          value={code}
          minLength={32}
          maxLength={200}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
        />
        <label htmlFor="reset-password">New password</label>
        <input
          id="reset-password"
          type="password"
          value={newPassword}
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          disabled={busy}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <label htmlFor="reset-password-confirm">Repeat the new password</label>
        <input
          id="reset-password-confirm"
          type="password"
          value={confirmPassword}
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          disabled={busy}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
        <button
          type="submit"
          className="recovery__submit"
          disabled={busy || code.trim().length < 32 || newPassword.length < 12}
        >
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>

      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={message.kind === "error" ? "signin__error" : "panel__status"}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Sealed break-glass recovery: enrols a replacement key on an account that
 * lost every key it had. Unchanged in spirit from the first design — the code
 * is burned the moment the ceremony opens, whatever happens after.
 */
function RecoveryPanel() {
  const session = useSession();
  const [recoveryCode, setRecoveryCode] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const inFlight = useRef(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;

    const code = recoveryCode.trim();
    const label = keyLabel.trim();
    if (code.length < 32 || code.length > 200) {
      setMessage({ kind: "error", text: "Enter the complete sealed recovery code." });
      return;
    }
    if (!label) {
      setMessage({
        kind: "error",
        text: "Give the replacement key a name so it can be identified later."
      });
      return;
    }
    if (!acknowledged) {
      setMessage({
        kind: "error",
        text: "Confirm that you understand the recovery code is consumed when recovery starts."
      });
      return;
    }

    inFlight.current = true;
    setRecovering(true);
    setMessage(null);
    // Do not keep the sealed credential in component state after submission.
    setRecoveryCode("");
    void (async () => {
      try {
        await session.recoverAuthenticator(code, label);
        setKeyLabel("");
        setAcknowledged(false);
        setMessage({
          kind: "success",
          text: "Security key enrolled. Recovery does not sign you in — sign in above with your username, password and the new key. Replace the consumed recovery envelope."
        });
      } catch (error) {
        setAcknowledged(false);
        setMessage({ kind: "error", text: describeRecoveryFailure(error) });
      } finally {
        inFlight.current = false;
        setRecovering(false);
      }
    })();
  };

  return (
    <section className="recovery" aria-labelledby="recovery-title">
      <h2 id="recovery-title">Enrol a replacement key</h2>
      <p id="recovery-warning" className="recovery__warning">
        Starting recovery permanently consumes one sealed code, even if the security-key prompt is
        cancelled or enrolment fails. Each code enrols only one key. If you only forgot your
        password, ask an administrator for a reset code instead.
      </p>

      <form className="recovery__form" autoComplete="off" onSubmit={submit}>
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

        <button type="submit" className="recovery__submit" disabled={recovering || !acknowledged}>
          {recovering ? "Recovery in progress…" : "Consume code and enrol key"}
        </button>
      </form>

      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={message.kind === "error" ? "signin__error" : "panel__status"}
        >
          {message.text}
        </p>
      ) : null}
    </section>
  );
}

function describeFailure(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && error.name === "NotAllowedError") {
    return "The security key prompt was dismissed. Try again.";
  }
  if (error instanceof AdminApiError) return error.message;
  return "The request could not be completed.";
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
