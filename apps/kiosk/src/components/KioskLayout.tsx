import { useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";

import { LanguageSelector } from "../features/i18n/LanguageSelector.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { formatSessionTime, useSessionTimer } from "../features/session/SessionTimerProvider.js";

const steps = [
  { path: "/upload" },
  { path: "/configure" },
  { path: "/checkout" },
  { path: "/printing" }
] as const;

export function KioskLayout() {
  const { messages, resetLocale } = useLanguage();
  const { remainingSeconds } = useSessionTimer();
  const { state, dispatch } = usePrototypeSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [cancelOpen, setCancelOpen] = useState(false);

  if (!state.session) return <Navigate to="/" replace />;

  const currentStep = stepIndex(location.pathname);
  const canCancel = ["/upload", "/configure", "/checkout"].includes(location.pathname);

  const cancelSession = () => {
    dispatch({ type: "RESET" });
    resetLocale();
    setCancelOpen(false);
    void navigate("/", { replace: true });
  };

  return (
    <div className="kiosk-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            P
          </span>
          <span>
            <strong>{messages.brand.name}</strong>
            <small>{messages.brand.activeSubtitle}</small>
          </span>
        </div>

        <ol className="stepper" aria-label={messages.common.printProgress}>
          {steps.map((step, index) => (
            <li
              key={step.path}
              className={
                index <= currentStep ? "stepper__item stepper__item--active" : "stepper__item"
              }
              aria-current={index === currentStep ? "step" : undefined}
            >
              <span>{index + 1}</span>
              {messages.common.steps[index]}
            </li>
          ))}
        </ol>

        <div className="topbar__actions">
          {canCancel ? (
            <button
              className="button button--quiet topbar__cancel"
              type="button"
              onClick={() => setCancelOpen(true)}
            >
              {messages.common.cancel}
            </button>
          ) : null}
        </div>
      </header>

      <main className="screen" id="main-content">
        <Outlet />
      </main>

      <footer className="session-footer">
        <LanguageSelector />
        <div className="privacy-strip">
          <span aria-hidden="true">●</span> {messages.common.privacyNotice}
        </div>
        <div
          className={
            remainingSeconds <= 30 ? "session-timer session-timer--warning" : "session-timer"
          }
          role="timer"
          aria-label={messages.idle.countdown(remainingSeconds)}
        >
          <span aria-hidden="true">◷</span>
          <span>{messages.idle.timeRemaining}</span>
          <strong>{formatSessionTime(remainingSeconds)}</strong>
        </div>
      </footer>

      {cancelOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
            <div className="status-mark status-mark--small" aria-hidden="true">
              ?
            </div>
            <h2 id="cancel-title">{messages.common.cancelTitle}</h2>
            <p>{messages.common.cancelDescription}</p>
            <div className="button-row">
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setCancelOpen(false)}
                autoFocus
              >
                {messages.common.keepSession}
              </button>
              <button className="button button--danger" type="button" onClick={cancelSession}>
                {messages.common.cancelSession}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function stepIndex(pathname: string): number {
  if (pathname.startsWith("/configure")) return 1;
  if (pathname.startsWith("/checkout") || pathname.startsWith("/payment")) return 2;
  if (
    pathname.startsWith("/printing") ||
    pathname.startsWith("/complete") ||
    pathname.startsWith("/failure")
  )
    return 3;
  return 0;
}
