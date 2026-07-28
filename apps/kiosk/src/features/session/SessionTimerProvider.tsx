import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { useKioskLocation, useKioskNavigate } from "../../app/router.js";
import { useLanguage } from "../i18n/LanguageProvider.js";
import { usePrototypeSession } from "./PrototypeSessionProvider.js";
import { closeKioskSession } from "./sessionService.js";

const SESSION_DURATION_SECONDS = 120;
const WARNING_AT_SECONDS = 30;

interface SessionTimerContextValue {
  remainingSeconds: number;
  recordActivity: () => void;
}

type ClosureStatus = "idle" | "closing" | "failed";

const SessionTimerContext = createContext<SessionTimerContextValue | null>(null);

export function SessionTimerProvider({ children }: { children: ReactNode }) {
  const { messages, resetLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const location = useKioskLocation();
  const navigate = useKioskNavigate();
  const deadlineRef = useRef(0);
  const closureStatusRef = useRef<ClosureStatus>("idle");
  const [remainingSeconds, setRemainingSeconds] = useState(SESSION_DURATION_SECONDS);
  const [warningOpen, setWarningOpen] = useState(false);
  const [closureStatus, setClosureStatus] = useState<ClosureStatus>("idle");

  const active = Boolean(state.session) && location.pathname !== "/";

  const updateClosureStatus = useCallback((status: ClosureStatus) => {
    closureStatusRef.current = status;
    setClosureStatus(status);
  }, []);

  const closePrivateSession = useCallback(async () => {
    const session = state.session;
    if (!session || closureStatusRef.current === "closing") return;

    updateClosureStatus("closing");
    setWarningOpen(true);
    try {
      await closeKioskSession(session);
    } catch {
      updateClosureStatus("failed");
      return;
    }

    updateClosureStatus("idle");
    dispatch({ type: "RESET" });
    resetLocale();
    setWarningOpen(false);
    void navigate("/", { replace: true });
  }, [dispatch, navigate, resetLocale, state.session, updateClosureStatus]);
  const closePrivateSessionRef = useRef(closePrivateSession);
  closePrivateSessionRef.current = closePrivateSession;

  const recordActivity = useCallback(() => {
    if (!active || closureStatusRef.current !== "idle") return;
    deadlineRef.current = Date.now() + SESSION_DURATION_SECONDS * 1000;
    setRemainingSeconds(SESSION_DURATION_SECONDS);
    setWarningOpen(false);
  }, [active]);

  const continueSession = useCallback(() => {
    setWarningOpen(false);
    recordActivity();
  }, [recordActivity]);

  useEffect(() => {
    if (!active) {
      deadlineRef.current = 0;
      closureStatusRef.current = "idle";
      setClosureStatus("idle");
      setRemainingSeconds(SESSION_DURATION_SECONDS);
      setWarningOpen(false);
      return;
    }

    setWarningOpen(false);
    recordActivity();

    const tick = () => {
      const seconds = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setRemainingSeconds(seconds);

      if (seconds > 0 && seconds <= WARNING_AT_SECONDS) setWarningOpen(true);
      if (seconds === 0 && closureStatusRef.current === "idle") {
        void closePrivateSessionRef.current();
      }
    };

    // Only direct customer input extends the deadline. Route changes reset it
    // through this effect, while polling, validation, and realtime events do not.
    const activityEvents = ["pointerdown", "keydown"] as const;
    activityEvents.forEach((eventName) => window.addEventListener(eventName, recordActivity));
    const timer = window.setInterval(tick, 250);

    return () => {
      window.clearInterval(timer);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
    };
  }, [active, location.pathname, recordActivity]);

  const value = useMemo(
    () => ({ remainingSeconds, recordActivity }),
    [recordActivity, remainingSeconds]
  );

  const recoveryMode = closureStatus !== "idle";
  const modalTitle =
    closureStatus === "failed"
      ? messages.common.cleanupPendingTitle
      : closureStatus === "closing"
        ? messages.common.cleanupInProgress
        : messages.idle.title;
  const modalDescription = recoveryMode
    ? closureStatus === "failed"
      ? messages.common.cleanupPendingDescription
      : messages.common.cleanupInProgressDescription
    : messages.idle.description;

  return (
    <SessionTimerContext.Provider value={value}>
      {children}
      {warningOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <section
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="idle-title"
          >
            {recoveryMode ? (
              <div className="status-mark status-mark--small" aria-hidden="true">
                {closureStatus === "failed" ? "!" : "…"}
              </div>
            ) : (
              <div className="countdown" aria-label={messages.idle.countdown(remainingSeconds)}>
                {remainingSeconds}
              </div>
            )}
            <h2 id="idle-title">{modalTitle}</h2>
            <p>{modalDescription}</p>
            <div className="button-row">
              {closureStatus === "failed" ? (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => void closePrivateSession()}
                  autoFocus
                >
                  {messages.common.retryCleanup}
                </button>
              ) : closureStatus === "closing" ? (
                <button className="button button--primary" type="button" disabled>
                  {messages.common.cleanupInProgress}
                </button>
              ) : (
                <>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => void closePrivateSession()}
                  >
                    {messages.idle.endSession}
                  </button>
                  <button
                    className="button button--primary"
                    type="button"
                    onClick={continueSession}
                    autoFocus
                  >
                    {messages.idle.continue}
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </SessionTimerContext.Provider>
  );
}

export function useSessionTimer(): SessionTimerContextValue {
  const context = useContext(SessionTimerContext);
  if (!context) throw new Error("SESSION_TIMER_CONTEXT_MISSING");
  return context;
}

export function formatSessionTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
