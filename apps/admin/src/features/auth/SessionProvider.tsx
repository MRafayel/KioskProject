import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import type {
  AdminCapability,
  AdminIdentityResponse,
  AdminLockedIdentityResponse
} from "@printing-kiosk/admin-access";

import { AdminApiError, adminApi } from "./api.js";

/**
 * Who is signed in, and what the page is allowed to draw for them.
 *
 * Four states rather than three: a session can be locked — idle window passed,
 * absolute window not — and a locked session is not a signed-out one. The lock
 * screen keeps the person's place; reauthenticating reopens the same session.
 *
 * `can()` decides visibility only. Every capability it reports is checked again
 * on the server for the request it guards, so hiding a control is a courtesy to
 * the operator rather than a security boundary.
 */

interface SessionState {
  identity: AdminIdentityResponse | null;
  locked: AdminLockedIdentityResponse | null;
  status: "loading" | "signed-out" | "signed-in" | "locked";
  error: string | null;
  errorCanRetry: boolean;
}

interface SessionContextValue extends SessionState {
  activity: "idle" | "refreshing" | "signing-in" | "signing-out" | "unlocking";
  can: (capability: AdminCapability) => boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Reopen a locked session: one key touch, or the password. */
  unlock: (password?: string) => Promise<void>;
  /** Abort if another tab replaced this page's account cookie. */
  confirmCurrentIdentity: () => Promise<boolean>;
  /**
   * Prove presence again. A security key for privileged roles; the password,
   * collected by the dialog this provider renders, for Operators. Returns
   * false when the person cancelled.
   */
  stepUp: () => Promise<boolean>;
  /** Returns false when the required security-key prompt did not complete. */
  enrolAuthenticator: (label: string) => Promise<boolean>;
  recoverAuthenticator: (recoveryCode: string, label: string) => Promise<void>;
  /** Move back to sign-in when any child request discovers the session is gone. */
  handleAuthenticationError: (error: unknown) => boolean;
  clearError: () => void;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    identity: null,
    locked: null,
    status: "loading",
    error: null,
    errorCanRetry: false
  });
  const [activity, setActivity] = useState<SessionContextValue["activity"]>("idle");
  /** Non-null while the step-up dialog is collecting an Operator's password. */
  const [passwordPrompt, setPasswordPrompt] = useState<{
    resolve: (password: string | null) => void;
  } | null>(null);
  const generation = useRef(0);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const signInInFlight = useRef<Promise<void> | null>(null);
  const signOutInFlight = useRef<Promise<void> | null>(null);
  const stepUpInFlight = useRef<Promise<boolean> | null>(null);

  const applyMe = useCallback((me: AdminIdentityResponse | AdminLockedIdentityResponse) => {
    if (me.state === "LOCKED") {
      setState({ identity: null, locked: me, status: "locked", error: null, errorCanRetry: false });
    } else {
      setState({
        identity: me,
        locked: null,
        status: "signed-in",
        error: null,
        errorCanRetry: false
      });
    }
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;

    const requestGeneration = generation.current;
    setActivity("refreshing");
    setState((current) => ({
      ...current,
      ...(current.identity || current.locked ? {} : { status: "loading" as const }),
      error: null,
      errorCanRetry: false
    }));

    const attempt = (async () => {
      try {
        const me = await adminApi.me();
        if (generation.current === requestGeneration) applyMe(me);
      } catch (error) {
        if (generation.current !== requestGeneration) return;
        if (error instanceof AdminApiError && error.requiresSignIn) {
          setState(signedOut());
          return;
        }
        setState((current) =>
          current.identity || current.locked
            ? { ...current, error: describe(error), errorCanRetry: true }
            : signedOut(describe(error), true)
        );
      } finally {
        refreshInFlight.current = null;
        if (generation.current === requestGeneration) {
          setActivity((current) => (current === "refreshing" ? "idle" : current));
        }
      }
    })();
    refreshInFlight.current = attempt;
    return attempt;
  }, [applyMe]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    (username: string, password: string): Promise<void> => {
      if (signInInFlight.current) return signInInFlight.current;

      const requestGeneration = ++generation.current;
      setActivity("signing-in");
      setState((current) => ({ ...current, error: null, errorCanRetry: false }));

      const attempt = (async () => {
        try {
          const result = await adminApi.login(username, password);
          if (result.state === "AUTHENTICATED") {
            if (generation.current === requestGeneration) applyMe(result.identity);
            return;
          }
          // The password verified; the role owes a key. The ceremony is bound
          // server-side to the account the password proved.
          const credential = await startAuthentication({
            optionsJSON: result.options as never
          });
          const identity = await adminApi.completeLoginWebAuthn(result.ceremonyId, credential);
          if (generation.current === requestGeneration) applyMe(identity);
        } catch (error) {
          if (generation.current === requestGeneration) {
            setState(signedOut(describe(error)));
          }
        } finally {
          signInInFlight.current = null;
          if (generation.current === requestGeneration) {
            setActivity((current) => (current === "signing-in" ? "idle" : current));
          }
        }
      })();
      signInInFlight.current = attempt;
      return attempt;
    },
    [applyMe]
  );

  const unlock = useCallback(
    async (password?: string): Promise<void> => {
      const requestGeneration = generation.current;
      setActivity("unlocking");
      setState((current) => ({ ...current, error: null, errorCanRetry: false }));
      try {
        let identity: AdminIdentityResponse;
        if (password !== undefined) {
          identity = await adminApi.unlockWithPassword(password);
        } else {
          const ceremony = await adminApi.beginUnlock();
          const credential = await startAuthentication({ optionsJSON: ceremony.options as never });
          identity = await adminApi.completeUnlock(ceremony.ceremonyId, credential);
        }
        if (generation.current === requestGeneration) applyMe(identity);
      } catch (error) {
        if (generation.current !== requestGeneration) return;
        if (error instanceof AdminApiError && error.requiresSignIn) {
          setState(signedOut());
          return;
        }
        setState((current) => ({ ...current, error: describe(error), errorCanRetry: false }));
      } finally {
        if (generation.current === requestGeneration) {
          setActivity((current) => (current === "unlocking" ? "idle" : current));
        }
      }
    },
    [applyMe]
  );

  const confirmCurrentIdentity = useCallback(async (): Promise<boolean> => {
    const expected = state.identity;
    if (!expected) return false;

    const requestGeneration = generation.current;
    try {
      const me = await adminApi.me();
      if (generation.current !== requestGeneration) return false;

      if (me.state === "LOCKED") {
        applyMe(me);
        return false;
      }

      if (me.adminUserId !== expected.adminUserId) {
        // Cookies are shared by every tab in a browser profile. Never let a tab
        // that still displays Alice perform a self-management action after a
        // different tab replaced the cookie with Bob's session.
        generation.current += 1;
        setActivity("idle");
        setState({
          identity: me,
          locked: null,
          status: "signed-in",
          error:
            "Your browser session changed to a different admin account. Review the account shown, then retry.",
          errorCanRetry: false
        });
        return false;
      }

      // Role, capabilities, scopes and expiry may have changed even when the
      // account did not. Keep the page's view aligned with the server's view.
      applyMe(me);
      return true;
    } catch (error) {
      if (generation.current !== requestGeneration) return false;
      if (error instanceof AdminApiError && error.requiresSignIn) {
        generation.current += 1;
        setActivity("idle");
        setState(signedOut());
        return false;
      }
      setState((current) => ({
        ...current,
        error: "Could not verify which admin session is active. No changes were made.",
        errorCanRetry: true
      }));
      return false;
    }
  }, [applyMe, state.identity]);

  const signOut = useCallback((): Promise<void> => {
    if (signOutInFlight.current) return signOutInFlight.current;

    setActivity("signing-out");

    const attempt = (async () => {
      // A locked session may sign out directly; an active one first confirms
      // no other tab swapped the account underneath this page.
      if (state.status === "signed-in" && !(await confirmCurrentIdentity())) return;

      const requestGeneration = ++generation.current;
      setState((current) => ({ ...current, error: null, errorCanRetry: false }));
      try {
        await adminApi.logout();
        if (generation.current === requestGeneration) setState(signedOut());
      } catch (error) {
        if (generation.current !== requestGeneration) return;
        if (error instanceof AdminApiError && error.requiresSignIn) {
          setState(signedOut());
          return;
        }
        // Do not pretend logout succeeded: the HttpOnly cookie can only be
        // revoked by the server and may still represent a live session.
        setState((current) => ({
          ...current,
          error: "Could not sign out. Your session may still be active; try again.",
          errorCanRetry: false
        }));
      }
    })().finally(() => {
      signOutInFlight.current = null;
      setActivity((current) => (current === "signing-out" ? "idle" : current));
    });
    signOutInFlight.current = attempt;
    return attempt;
  }, [confirmCurrentIdentity, state.status]);

  /** Ask the person for their password through the provider's own dialog. */
  const collectPassword = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      setPasswordPrompt({
        resolve: (password) => {
          setPasswordPrompt(null);
          resolve(password);
        }
      });
    });
  }, []);

  const stepUp = useCallback((): Promise<boolean> => {
    if (stepUpInFlight.current) return stepUpInFlight.current;

    const attempt = (async () => {
      const expected = state.identity;
      if (!expected) return false;
      if (!(await confirmCurrentIdentity())) return false;

      const requestGeneration = ++generation.current;
      setState((current) => ({ ...current, error: null, errorCanRetry: false }));
      try {
        let identity: AdminIdentityResponse;
        if (expected.strongAuthMethod === "PASSWORD") {
          const password = await collectPassword();
          if (password === null) return false;
          identity = await adminApi.stepUpWithPassword(password);
        } else {
          const ceremony = await adminApi.beginStepUp();
          if (ceremony.adminUserId !== expected.adminUserId) {
            // A different tab replaced the cookie after the `/me` check. Do not
            // ask the operator to touch a key for the account this stale tab
            // was not displaying.
            await confirmCurrentIdentity();
            return false;
          }
          const credential = await startAuthentication({
            optionsJSON: ceremony.options as never
          });
          identity = await adminApi.completeStepUp(ceremony.ceremonyId, credential);
        }
        if (generation.current === requestGeneration) applyMe(identity);
        return true;
      } catch (error) {
        if (generation.current !== requestGeneration) return false;
        if (error instanceof AdminApiError && error.requiresSignIn) {
          setState(signedOut());
          return false;
        }
        if (error instanceof AdminApiError && error.requiresUnlock) {
          void refresh();
          return false;
        }
        setState((current) => ({
          ...current,
          error: describe(error),
          errorCanRetry: false
        }));
        return false;
      } finally {
        stepUpInFlight.current = null;
      }
    })();
    stepUpInFlight.current = attempt;
    return attempt;
  }, [applyMe, collectPassword, confirmCurrentIdentity, refresh, state.identity]);

  const enrolAuthenticator = useCallback(
    async (label: string): Promise<boolean> => {
      const expectedAdminUserId = state.identity?.adminUserId;
      if (!expectedAdminUserId) return false;
      if (!(await confirmCurrentIdentity())) return false;

      const begin = async () => adminApi.beginEnrolment();
      let ceremony;
      try {
        ceremony = await begin();
      } catch (error) {
        // Enrolment is a sensitive action, so the first attempt may be refused
        // pending a fresh reauthentication. Ask for it, then continue.
        if (!(error instanceof AdminApiError) || !error.requiresStepUp) throw error;
        if (!(await stepUp())) return false;
        ceremony = await begin();
      }

      if (ceremony.adminUserId !== expectedAdminUserId) {
        // Registration options contain the account handle that the new key
        // will belong to. Refuse a cross-tab cookie switch before handing those
        // options to the browser. The server also binds verification to this
        // owner, which closes a later cookie switch after this comparison.
        await confirmCurrentIdentity();
        return false;
      }

      const credential = await startRegistration({ optionsJSON: ceremony.options as never });
      try {
        await adminApi.completeEnrolment(ceremony.ceremonyId, credential, label);
      } catch (error) {
        if (!(error instanceof AdminApiError) || !error.requiresStepUp) throw error;
        // Authorization happens before the server consumes the registration
        // challenge. Re-prove presence and submit the already-created browser
        // credential again instead of creating a duplicate credential.
        if (!(await stepUp())) return false;
        await adminApi.completeEnrolment(ceremony.ceremonyId, credential, label);
      }
      return true;
    },
    [confirmCurrentIdentity, state.identity?.adminUserId, stepUp]
  );

  const recoverAuthenticator = useCallback(async (recoveryCode: string, label: string) => {
    const ceremony = await adminApi.beginBreakGlassEnrolment(recoveryCode);
    const credential = await startRegistration({ optionsJSON: ceremony.options as never });
    await adminApi.completeBreakGlassEnrolment(ceremony.ceremonyId, credential, label);
  }, []);

  const handleAuthenticationError = useCallback(
    (error: unknown): boolean => {
      if (!(error instanceof AdminApiError)) return false;
      if (error.requiresUnlock) {
        // The session locked while this page was open. Fetch who is locked so
        // the lock screen can say so, rather than guessing from stale state.
        generation.current += 1;
        setActivity("idle");
        void refresh();
        return true;
      }
      if (!error.requiresSignIn) return false;
      generation.current += 1;
      setActivity("idle");
      setState(signedOut());
      return true;
    },
    [refresh]
  );

  const clearError = useCallback(() => {
    setState((current) => ({ ...current, error: null, errorCanRetry: false }));
  }, []);

  const hardExpiresAt = state.identity?.session.hardExpiresAt;
  useEffect(() => {
    if (!hardExpiresAt) return;
    const delay = new Date(hardExpiresAt).getTime() - Date.now();
    if (!Number.isFinite(delay)) return;

    const expire = () => {
      generation.current += 1;
      setActivity("idle");
      setState(signedOut("Your session expired. Sign in again."));
    };
    if (delay <= 0) {
      expire();
      return;
    }

    // setTimeout clamps beyond ~24.8 days; re-check daily until inside range.
    const timeout = window.setTimeout(
      () => {
        if (new Date(hardExpiresAt).getTime() - Date.now() <= 0) expire();
      },
      Math.min(delay, 24 * 60 * 60 * 1000)
    );
    return () => window.clearTimeout(timeout);
  }, [hardExpiresAt]);

  const value = useMemo<SessionContextValue>(
    () => ({
      ...state,
      activity,
      can: (capability) => state.identity?.capabilities.includes(capability) ?? false,
      signIn,
      signOut,
      unlock,
      confirmCurrentIdentity,
      stepUp,
      enrolAuthenticator,
      recoverAuthenticator,
      handleAuthenticationError,
      clearError,
      refresh
    }),
    [
      state,
      activity,
      signIn,
      signOut,
      unlock,
      confirmCurrentIdentity,
      stepUp,
      enrolAuthenticator,
      recoverAuthenticator,
      handleAuthenticationError,
      clearError,
      refresh
    ]
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      {passwordPrompt ? (
        <PasswordPromptDialog
          onSubmit={(password) => passwordPrompt.resolve(password)}
          onCancel={() => passwordPrompt.resolve(null)}
        />
      ) : null}
    </SessionContext.Provider>
  );
}

/**
 * The password prompt an Operator's step-up uses. Minimal by design — the UI
 * is temporary — but a real dialog with a masked input, because the one thing
 * a password prompt may never do is show the password.
 */
function PasswordPromptDialog({
  onSubmit,
  onCancel
}: {
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Confirm password">
      <form
        className="modal"
        onSubmit={(event) => {
          event.preventDefault();
          if (password.length > 0) onSubmit(password);
        }}
      >
        <h2>Confirm it is you</h2>
        <p>This action needs your password again.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-label="Password"
        />
        <div className="modal__actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={password.length === 0}>
            Confirm
          </button>
        </div>
      </form>
    </div>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside a SessionProvider");
  return value;
}

/**
 * Turns anything thrown into something safe to display. Server messages are
 * already generic by design; a browser exception (a cancelled prompt, no
 * authenticator) is replaced rather than shown, because its text is not ours.
 */
function describe(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (hasErrorName(error, "NotAllowedError")) {
    return "The security key prompt was dismissed.";
  }
  return "Could not reach the control plane.";
}

function hasErrorName(error: unknown, name: string): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === name);
}

function signedOut(error: string | null = null, errorCanRetry = false): SessionState {
  return { identity: null, locked: null, status: "signed-out", error, errorCanRetry };
}
