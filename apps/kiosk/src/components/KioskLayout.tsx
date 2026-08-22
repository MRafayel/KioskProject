import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { KioskRedirect, useKioskLocation, useKioskNavigate } from "../app/router.js";
import { LanguageSelector } from "../features/i18n/LanguageSelector.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { subscribeToSessionEvents } from "../features/session/sessionEvents.js";
import {
  clearStoredSessionKeys,
  closeKioskSession,
  listKioskSessionFiles
} from "../features/session/sessionService.js";

type CancelStatus = "closed" | "confirming" | "closing" | "failed";

export interface KioskOutletContext {
  realtimeConnected: boolean;
}

const KioskOutletContextValue = createContext<KioskOutletContext | null>(null);

export function useKioskOutletContext(): KioskOutletContext {
  const context = useContext(KioskOutletContextValue);
  if (!context) throw new Error("KIOSK_OUTLET_CONTEXT_MISSING");
  return context;
}

const steps = [
  { path: "/upload" },
  { path: "/configure" },
  { path: "/checkout" },
  { path: "/printing" }
] as const;

export function KioskLayout({ children }: { children: ReactNode }) {
  const { messages, resetLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const location = useKioskLocation();
  const navigate = useKioskNavigate();
  const queryClient = useQueryClient();
  const [cancelStatus, setCancelStatus] = useState<CancelStatus>("closed");
  const [connectedSessionId, setConnectedSessionId] = useState<string | null>(null);
  const terminalSessionRef = useRef<string | null>(null);
  const sessionId = state.session?.id;
  const realtimeConnected = connectedSessionId === sessionId;

  useEffect(() => {
    if (!sessionId) return;
    terminalSessionRef.current = null;
    let active = true;
    let refreshingFiles = false;
    let fileRefreshRequested = false;

    const refreshFileSnapshot = () => {
      fileRefreshRequested = true;
      if (refreshingFiles) return;
      refreshingFiles = true;
      void (async () => {
        try {
          while (active && fileRefreshRequested) {
            fileRefreshRequested = false;
            try {
              const files = await queryClient.fetchQuery({
                queryKey: ["kiosk-session-files", sessionId],
                queryFn: () => listKioskSessionFiles(sessionId),
                staleTime: 0
              });
              if (active && terminalSessionRef.current !== sessionId) {
                dispatch({ type: "FILES_SYNCED", files });
              }
            } catch {
              // Slow polling remains the reconciliation fallback.
            }
          }
        } finally {
          refreshingFiles = false;
          if (active && fileRefreshRequested) refreshFileSnapshot();
        }
      })();
    };

    const unsubscribe = subscribeToSessionEvents(sessionId, {
      onConnected: () => {
        setConnectedSessionId(sessionId);
        refreshFileSnapshot();
      },
      onDisconnected: () =>
        setConnectedSessionId((current) => (current === sessionId ? null : current)),
      onEvent: (event) => {
        if (
          event.type === "upload.started" ||
          event.type === "file.uploaded" ||
          event.type === "file.ready" ||
          event.type === "file.rejected" ||
          event.type === "file.deleted"
        ) {
          refreshFileSnapshot();
          return;
        }
        if (event.type !== "session.canceled" && event.type !== "session.expired") return;
        if (terminalSessionRef.current === sessionId) return;

        terminalSessionRef.current = sessionId;
        clearStoredSessionKeys(sessionId);
        queryClient.removeQueries({ queryKey: ["kiosk-session-files", sessionId], exact: true });
        setConnectedSessionId((current) => (current === sessionId ? null : current));
        setCancelStatus("closed");
        dispatch({ type: "RESET" });
        resetLocale();
        void navigate("/", { replace: true });
      },
      onDesynchronized: refreshFileSnapshot
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [dispatch, navigate, queryClient, resetLocale, sessionId]);

  if (!state.session) return <KioskRedirect to="/" />;

  const currentStep = stepIndex(location.pathname);
  const paymentStatus = state.payment.payment?.status;
  // Browser history can return to checkout after payment has started. The
  // pre-payment cancel copy promises that no charge was made, so it must not be
  // shown while an intent can still capture or after any kind of capture.
  const paymentMakesCancellationUnsafe =
    paymentStatus === "PENDING" || paymentStatus === "AUTHORIZED" || paymentStatus === "CAPTURED";
  const canCancel =
    ["/upload", "/configure", "/checkout"].includes(location.pathname) &&
    !paymentMakesCancellationUnsafe;
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
        <KioskOutletContextValue.Provider value={{ realtimeConnected }}>
          {children}
        </KioskOutletContextValue.Provider>
      </main>

      <footer className="session-footer">
        <LanguageSelector />
        <div className="privacy-strip">
          <span aria-hidden="true">●</span> {messages.common.privacyNotice}
        </div>
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
