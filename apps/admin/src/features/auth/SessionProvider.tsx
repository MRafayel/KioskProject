import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
}

interface SessionContextValue extends SessionState {
  can(capability: AdminCapability): boolean;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Prove presence again. Returns false when the operator cancelled. */
  stepUp(): Promise<boolean>;
  enrolAuthenticator(label: string): Promise<void>;
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    identity: null,
    status: "loading",
    error: null
  });

  const refresh = useCallback(async () => {
    try {
      const identity = await adminApi.me();
      setState({ identity, status: "signed-in", error: null });
    } catch (error) {
      if (error instanceof AdminApiError && error.requiresSignIn) {
        setState({ identity: null, status: "signed-out", error: null });
        return;
      }
      setState({ identity: null, status: "signed-out", error: describe(error) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async () => {
    setState((current) => ({ ...current, error: null }));
    try {
      const ceremony = await adminApi.beginSignIn();
      // No username is collected anywhere: the credential is discoverable, so
      // the authenticator decides which account it asserts.
      const credential = await startAuthentication({
        optionsJSON: ceremony.options as never
      });
      const identity = await adminApi.completeSignIn(ceremony.ceremonyId, credential);
      setState({ identity, status: "signed-in", error: null });
    } catch (error) {
      setState({ identity: null, status: "signed-out", error: describe(error) });
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await adminApi.logout();
    } finally {
      setState({ identity: null, status: "signed-out", error: null });
    }
  }, []);

  const stepUp = useCallback(async () => {
    try {
      const ceremony = await adminApi.beginStepUp();
      const credential = await startAuthentication({
        optionsJSON: ceremony.options as never
      });
      const identity = await adminApi.completeStepUp(ceremony.ceremonyId, credential);
      setState({ identity, status: "signed-in", error: null });
      return true;
    } catch (error) {
      if (error instanceof AdminApiError && error.requiresSignIn) {
        setState({ identity: null, status: "signed-out", error: null });
        return false;
      }
      setState((current) => ({ ...current, error: describe(error) }));
      return false;
    }
  }, []);

  const enrolAuthenticator = useCallback(
    async (label: string) => {
      const begin = async () => adminApi.beginEnrolment();
      let ceremony;
      try {
        ceremony = await begin();
      } catch (error) {
        // Enrolment is a sensitive action, so the first attempt may be refused
        // pending a fresh assertion. Ask for it, then continue.
        if (!(error instanceof AdminApiError) || !error.requiresStepUp) throw error;
        if (!(await stepUp())) return;
        ceremony = await begin();
      }

      const credential = await startRegistration({ optionsJSON: ceremony.options as never });
      await adminApi.completeEnrolment(ceremony.ceremonyId, credential, label);
      await refresh();
    },
    [refresh, stepUp]
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      ...state,
      can: (capability) => state.identity?.capabilities.includes(capability) ?? false,
      signIn,
      signOut,
      stepUp,
      enrolAuthenticator,
      refresh
    }),
    [state, signIn, signOut, stepUp, enrolAuthenticator, refresh]
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
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "The security key prompt was dismissed.";
  }
  return "Could not reach the control plane.";
}
