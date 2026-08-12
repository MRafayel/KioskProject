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

import type { AdminCapability, AdminIdentityResponse } from "@printing-kiosk/admin-access";

import { AdminApiError, adminApi } from "./api.js";

/**
 * Who is signed in, and what the page is allowed to draw for them.
 *
 * `can()` decides visibility only. Every capability it reports is checked again
 * on the server for the request it guards, so hiding a control is a courtesy to
 * the operator rather than a security boundary.
 */

interface SessionState {
  identity: AdminIdentityResponse | null;
  status: "loading" | "signed-out" | "signed-in";
  error: string | null;
  errorCanRetry: boolean;
}

interface SessionContextValue extends SessionState {
  activity: "idle" | "refreshing" | "signing-in" | "signing-out";
  can: (capability: AdminCapability) => boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Abort if another tab replaced this page's account cookie. */
  confirmCurrentIdentity: () => Promise<boolean>;
  /** Prove presence again. Returns false when the operator cancelled. */
  stepUp: () => Promise<boolean>;
  /** Returns false when the required security-key prompt did not complete. */
  enrolAuthenticator: (label: string) => Promise<boolean>;
  recoverAuthenticator: (recoveryCode: string, label: string) => Promise<void>;
  /** Enrol a first key against a ticket an Admin issued. Signs nobody in. */
  redeemEnrollmentTicket: (enrollmentCode: string, label: string) => Promise<void>;
  /** Move back to sign-in when any child request discovers the session is gone. */
  handleAuthenticationError: (error: unknown) => boolean;
  clearError: () => void;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    identity: null,
    status: "loading",
    error: null,
    errorCanRetry: false
  });
  const [activity, setActivity] = useState<SessionContextValue["activity"]>("idle");
  const generation = useRef(0);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const signInInFlight = useRef<Promise<void> | null>(null);
  const signOutInFlight = useRef<Promise<void> | null>(null);
  const stepUpInFlight = useRef<Promise<boolean> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;

    const requestGeneration = generation.current;
    setActivity("refreshing");
    setState((current) => ({
      ...current,
      ...(current.identity ? {} : { status: "loading" as const }),
      error: null,
      errorCanRetry: false
    }));

    const attempt = (async () => {
      try {
        const identity = await adminApi.me();
        if (generation.current === requestGeneration) {
          setState({
            identity,
            status: "signed-in",
            error: null,
            errorCanRetry: false
          });
        }
      } catch (error) {
        if (generation.current !== requestGeneration) return;
        if (error instanceof AdminApiError && error.requiresSignIn) {
          setState(signedOut());
          return;
        }
        setState((current) =>
          current.identity
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
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback((): Promise<void> => {
    if (signInInFlight.current) return signInInFlight.current;

    const requestGeneration = ++generation.current;
    setActivity("signing-in");
    setState((current) => ({ ...current, error: null, errorCanRetry: false }));

    const attempt = (async () => {
      try {
        const ceremony = await adminApi.beginSignIn();
        // No username is collected anywhere: the credential is discoverable, so
        // the authenticator decides which account it asserts.
        const credential = await startAuthentication({
          optionsJSON: ceremony.options as never
        });
        const identity = await adminApi.completeSignIn(ceremony.ceremonyId, credential);
        if (generation.current === requestGeneration) {
          setState({
            identity,
            status: "signed-in",
            error: null,
            errorCanRetry: false
          });
        }
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
  }, []);

  const confirmCurrentIdentity = useCallback(async (): Promise<boolean> => {
    const expected = state.identity;
    if (!expected) return false;

    const requestGeneration = generation.current;
    try {
      const identity = await adminApi.me();
      if (generation.current !== requestGeneration) return false;

      if (identity.adminUserId !== expected.adminUserId) {
        // Cookies are shared by every tab in a browser profile. Never let a tab
        // that still displays Alice perform a self-management action after a
        // different tab replaced the cookie with Bob's session.
        generation.current += 1;
        setActivity("idle");
        setState({
          identity,
          status: "signed-in",
          error:
            "Your browser session changed to a different admin account. Review the account shown, then retry.",
          errorCanRetry: false
        });
        return false;
      }

      // Role, capabilities, scopes and expiry may have changed even when the
      // account did not. Keep the page's view aligned with the server's view.
      setState({
        identity,
        status: "signed-in",
        error: null,
        errorCanRetry: false
      });
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
  }, [state.identity]);

  const signOut = useCallback((): Promise<void> => {
    if (signOutInFlight.current) return signOutInFlight.current;

    setActivity("signing-out");

    const attempt = (async () => {
      if (!(await confirmCurrentIdentity())) return;

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
  }, [confirmCurrentIdentity]);

  const stepUp = useCallback((): Promise<boolean> => {
    if (stepUpInFlight.current) return stepUpInFlight.current;

    const attempt = (async () => {
      const expectedAdminUserId = state.identity?.adminUserId;
      if (!expectedAdminUserId) return false;
      if (!(await confirmCurrentIdentity())) return false;

      const requestGeneration = ++generation.current;
      setState((current) => ({ ...current, error: null, errorCanRetry: false }));
      try {
        const ceremony = await adminApi.beginStepUp();
        if (ceremony.adminUserId !== expectedAdminUserId) {
          // A different tab replaced the cookie after the `/me` check. Do not
          // ask the operator to touch a key for the account this stale tab was
          // not displaying.
          await confirmCurrentIdentity();
          return false;
        }
        const credential = await startAuthentication({
          optionsJSON: ceremony.options as never
        });
        const identity = await adminApi.completeStepUp(ceremony.ceremonyId, credential);
        if (generation.current === requestGeneration) {
          setState({
            identity,
            status: "signed-in",
            error: null,
            errorCanRetry: false
          });
        }
        return true;
      } catch (error) {
        if (generation.current !== requestGeneration) return false;
        if (error instanceof AdminApiError && error.requiresSignIn) {
          setState(signedOut());
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
  }, [confirmCurrentIdentity, state.identity?.adminUserId]);

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
        // pending a fresh assertion. Ask for it, then continue.
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

  const redeemEnrollmentTicket = useCallback(async (enrollmentCode: string, label: string) => {
    const ceremony = await adminApi.beginTicketEnrolment(enrollmentCode);
    const credential = await startRegistration({ optionsJSON: ceremony.options as never });
    await adminApi.completeTicketEnrolment(ceremony.ceremonyId, credential, label);
  }, []);

  const handleAuthenticationError = useCallback((error: unknown): boolean => {
    if (!(error instanceof AdminApiError) || !error.requiresSignIn) return false;
    generation.current += 1;
    setActivity("idle");
    setState(signedOut());
    return true;
  }, []);

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

    const timeout = window.setTimeout(expire, delay);
    return () => window.clearTimeout(timeout);
  }, [hardExpiresAt]);

  const value = useMemo<SessionContextValue>(
    () => ({
      ...state,
      activity,
      can: (capability) => state.identity?.capabilities.includes(capability) ?? false,
      signIn,
      signOut,
      confirmCurrentIdentity,
      stepUp,
      enrolAuthenticator,
      recoverAuthenticator,
      redeemEnrollmentTicket,
      handleAuthenticationError,
      clearError,
      refresh
    }),
    [
      state,
      activity,
      signIn,
      signOut,
      confirmCurrentIdentity,
      stepUp,
      enrolAuthenticator,
      recoverAuthenticator,
      redeemEnrollmentTicket,
      handleAuthenticationError,
      clearError,
      refresh
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
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
  return { identity: null, status: "signed-out", error, errorCanRetry };
}
