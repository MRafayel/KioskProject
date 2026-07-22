import { useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";

import { LanguageSelector } from "../features/i18n/LanguageSelector.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { formatSessionTime, useSessionTimer } from "../features/session/SessionTimerProvider.js";
import { closeKioskSession } from "../features/session/sessionService.js";

type CancelStatus = "closed" | "confirming" | "closing" | "failed";

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
  const [cancelStatus, setCancelStatus] = useState<CancelStatus>("closed");

  if (!state.session) return <Navigate to="/" replace />;

  const currentStep = stepIndex(location.pathname);
  const canCancel = ["/upload", "/configure", "/checkout"].includes(location.pathname);
  const showSessionTimer = location.pathname !== "/printing";

  const cancelSession = async () => {
    const session = state.session;
    if (!session || cancelStatus === "closing") return;

    setCancelStatus("closing");
    try {
      await closeKioskSession(session);
    } catch {
      setCancelStatus("failed");
      return;
    }

    dispatch({ type: "RESET" });
    resetLocale();
    setCancelStatus("closed");
    void navigate("/", { replace: true });
  };

  const cancelRecovery = cancelStatus === "closing" || cancelStatus === "failed";
  const cancelTitle = cancelRecovery
    ? cancelStatus === "failed"
      ? messages.common.cleanupPendingTitle
      : messages.common.cleanupInProgress
    : messages.common.cancelTitle;
  const cancelDescription = cancelRecovery
    ? cancelStatus === "failed"
      ? messages.common.cleanupPendingDescription
      : messages.common.cleanupInProgressDescription
    : messages.common.cancelDescription;

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
              onClick={() => setCancelStatus("confirming")}
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
        {showSessionTimer ? (
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
        ) : null}
      </footer>

      {cancelStatus !== "closed" ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
            <div className="status-mark status-mark--small" aria-hidden="true">
              {cancelStatus === "failed" ? "!" : cancelStatus === "closing" ? "…" : "?"}
            </div>
            <h2 id="cancel-title">{cancelTitle}</h2>
            <p>{cancelDescription}</p>
            <div className="button-row">
              {cancelStatus === "failed" ? (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => void cancelSession()}
                  autoFocus
                >
                  {messages.common.retryCleanup}
                </button>
              ) : cancelStatus === "closing" ? (
                <button className="button button--primary" type="button" disabled>
                  {messages.common.cleanupInProgress}
                </button>
              ) : (
                <>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => setCancelStatus("closed")}
                    autoFocus
                  >
                    {messages.common.keepSession}
                  </button>
                  <button
                    className="button button--danger"
                    type="button"
                    onClick={() => void cancelSession()}
                  >
                    {messages.common.cancelSession}
                  </button>
                </>
              )}
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
