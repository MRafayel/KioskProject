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
import { useLocation, useNavigate } from "react-router-dom";

import { useLanguage } from "../i18n/LanguageProvider.js";
import { usePrototypeSession } from "./PrototypeSessionProvider.js";

const SESSION_DURATION_SECONDS = 120;
const WARNING_AT_SECONDS = 30;

interface SessionTimerContextValue {
  remainingSeconds: number;
}

const SessionTimerContext = createContext<SessionTimerContextValue | null>(null);

export function SessionTimerProvider({ children }: { children: ReactNode }) {
  const { messages, resetLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const location = useLocation();
  const navigate = useNavigate();
  const deadlineRef = useRef(0);
  const [remainingSeconds, setRemainingSeconds] = useState(SESSION_DURATION_SECONDS);
  const [warningOpen, setWarningOpen] = useState(false);

  const active = Boolean(state.session) && location.pathname !== "/";

  const returnHome = useCallback(() => {
    dispatch({ type: "RESET" });
    resetLocale();
    setWarningOpen(false);
    void navigate("/", { replace: true });
  }, [dispatch, navigate, resetLocale]);

  const resetActivity = useCallback(() => {
    if (!active) return;
    deadlineRef.current = Date.now() + SESSION_DURATION_SECONDS * 1000;
    setRemainingSeconds(SESSION_DURATION_SECONDS);
  }, [active]);

  const continueSession = useCallback(() => {
    setWarningOpen(false);
    resetActivity();
  }, [resetActivity]);

  useEffect(() => {
    if (!active) {
      deadlineRef.current = 0;
      setRemainingSeconds(SESSION_DURATION_SECONDS);
      setWarningOpen(false);
      return;
    }

    let expired = false;
    setWarningOpen(false);
    resetActivity();

    const tick = () => {
      const seconds = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setRemainingSeconds(seconds);

      if (seconds > 0 && seconds <= WARNING_AT_SECONDS) setWarningOpen(true);
      if (seconds === 0 && !expired) {
        expired = true;
        returnHome();
      }
    };

    const activityEvents = ["pointerdown", "keydown", "kiosk-activity"] as const;
    activityEvents.forEach((eventName) => window.addEventListener(eventName, resetActivity));
    const timer = window.setInterval(tick, 250);

    return () => {
      window.clearInterval(timer);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, resetActivity));
    };
  }, [active, location.pathname, resetActivity, returnHome]);

  const value = useMemo(() => ({ remainingSeconds }), [remainingSeconds]);

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
            <div className="countdown" aria-label={messages.idle.countdown(remainingSeconds)}>
              {remainingSeconds}
            </div>
            <h2 id="idle-title">{messages.idle.title}</h2>
            <p>{messages.idle.description}</p>
            <div className="button-row">
              <button className="button button--secondary" type="button" onClick={returnHome}>
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
