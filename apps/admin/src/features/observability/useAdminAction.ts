import { useCallback, useRef, useState } from "react";

import { AdminApiError } from "../auth/api.js";
import { useSession } from "../auth/SessionProvider.js";

/**
 * Running one operator action, with everything that has to happen around it.
 *
 * Doing this once rather than in each panel matters more than it looks. Every
 * admin action shares four behaviours, and each of them is a real defect if a
 * panel forgets it:
 *
 *   - **Step up and retry.** A sensitive action is refused until the operator
 *     touches their key. Asking, then submitting the *same* request, is the
 *     difference between one recorded observation and two.
 *   - **Never submit twice.** These actions are typed by somebody standing at a
 *     kiosk, and a double-clicked button must not become a second request. The
 *     server is idempotent per job as well; this stops the request being made
 *     at all.
 *   - **Confirm which account is signed in.** Cookies are shared by every tab
 *     in a browser profile, so a page still displaying one operator can be
 *     carrying another one's session. An action attributed to the wrong person
 *     is a permanent, append-only record of the wrong person.
 *   - **Report a refusal as itself.** A 409 means somebody else already
 *     answered this, which is information — not a failure to retry past.
 */

export interface AdminActionState {
  running: boolean;
  error: string | null;
  /** Cleared by the next attempt, so a stale success cannot linger on screen. */
  succeeded: boolean;
}

export interface AdminAction<TInput> {
  state: AdminActionState;
  /** Resolves true when the action was recorded, false when it was not. */
  run: (input: TInput) => Promise<boolean>;
  reset: () => void;
}

export function useAdminAction<TInput>(
  perform: (input: TInput) => Promise<unknown>
): AdminAction<TInput> {
  const session = useSession();
  const [state, setState] = useState<AdminActionState>({
    running: false,
    error: null,
    succeeded: false
  });
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    setState({ running: false, error: null, succeeded: false });
  }, []);

  const run = useCallback(
    async (input: TInput): Promise<boolean> => {
      if (inFlight.current) return false;
      inFlight.current = true;
      setState({ running: true, error: null, succeeded: false });

      try {
        // The account this page is displaying must still be the account the
        // cookie names. An operator observation is permanent and attributed.
        if (!(await session.confirmCurrentIdentity())) {
          setState({
            running: false,
            error: "Your signed-in account changed. Nothing was recorded — review and retry.",
            succeeded: false
          });
          return false;
        }

        try {
          await perform(input);
        } catch (error) {
          if (!(error instanceof AdminApiError) || !error.requiresStepUp) throw error;
          // Authorization happens before anything is written, so the same
          // request can simply be made again once presence is proved.
          if (!(await session.stepUp())) {
            setState({
              running: false,
              error: "Confirm with your security key to record this.",
              succeeded: false
            });
            return false;
          }
          await perform(input);
        }

        setState({ running: false, error: null, succeeded: true });
        return true;
      } catch (error) {
        if (session.handleAuthenticationError(error)) return false;
        setState({ running: false, error: describe(error), succeeded: false });
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [perform, session]
  );

  return { state, run, reset };
}

/**
 * Anything thrown, turned into something safe to show.
 *
 * The server's messages are written to be shown and are already generic. A
 * browser exception — a dismissed key prompt, a dropped connection — is
 * replaced rather than displayed, because its text is not ours to put on a
 * screen.
 */
function describe(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error && typeof error === "object" && "name" in error && error.name === "NotAllowedError") {
    return "The security key prompt was dismissed. Nothing was recorded.";
  }
  return "Could not reach the control plane. Nothing was recorded.";
}
