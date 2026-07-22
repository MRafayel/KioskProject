import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  fileExtension,
  formatPrice,
  isReadyFile
} from "../features/session/model.js";
import { closeKioskSession } from "../features/session/sessionService.js";

const PROTOTYPE_STEP_DELAY_MS = 1_200;

export function PaymentScreen() {
  const { messages } = useLanguage();
  const { state } = usePrototypeSession();
  const navigate = useNavigate();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void navigate(state.outcome === "PAYMENT_DECLINED" ? "/failure/payment" : "/printing", {
        replace: true
      });
    }, PROTOTYPE_STEP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [navigate, state.outcome]);

  if (!isReadyFile(state.files[0])) return <Navigate to="/upload" replace />;

  return (
    <TerminalProgress
      eyebrow={messages.status.paymentEyebrow}
      title={messages.status.paymentTitle}
      description={messages.status.paymentDescription}
      detail={messages.status.paymentDetail}
    />
  );
}

export function PrintingScreen() {
  const { messages } = useLanguage();
  const { state } = usePrototypeSession();
  const navigate = useNavigate();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void navigate(state.outcome === "PRINTER_ERROR" ? "/failure/printer" : "/complete", {
        replace: true
      });
    }, PROTOTYPE_STEP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [navigate, state.outcome]);

  if (!isReadyFile(state.files[0])) return <Navigate to="/upload" replace />;

  return (
    <TerminalProgress
      eyebrow={messages.status.printingEyebrow}
      title={messages.status.printingTitle}
      description={messages.status.printingDescription}
      detail={messages.status.printingDetail}
      printAnimation
    />
  );
}

export function FailureScreen() {
  const { messages } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useNavigate();
  const { failureType } = useParams();
  const paymentFailure = failureType === "payment";

  if (!isReadyFile(state.files[0])) return <Navigate to="/upload" replace />;

  return (
    <div className="terminal-state terminal-state--error">
      <div className="status-mark" aria-hidden="true">
        !
      </div>
      <p className="eyebrow">{messages.status.actionNeeded}</p>
      <h1>
        {paymentFailure ? messages.status.paymentDeclinedTitle : messages.status.printerErrorTitle}
      </h1>
      <p>
        {paymentFailure
          ? messages.status.paymentDeclinedDescription
          : messages.status.printerErrorDescription}
      </p>
      <div className="failure-detail" role="status">
        <strong>
          {paymentFailure ? messages.status.paymentDeclinedCode : messages.status.printerErrorCode}
        </strong>
        <span>{messages.status.failureDetail}</span>
      </div>
      <div className="button-row button-row--center">
        <button
          className="button button--secondary"
          type="button"
          onClick={() => void navigate(paymentFailure ? "/checkout" : "/configure")}
        >
          {messages.status.reviewSettings}
        </button>
        <button
          className="button button--primary"
          type="button"
          onClick={() => {
            dispatch({ type: "OUTCOME_CHANGED", outcome: "SUCCESS" });
            void navigate(paymentFailure ? "/payment" : "/printing");
          }}
        >
          {paymentFailure ? messages.status.retryPayment : messages.status.retryPrinting}
        </button>
      </div>
    </div>
  );
}

export function CompleteScreen() {
  const { messages, numberLocale, resetLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useNavigate();
  const [cleanupStatus, setCleanupStatus] = useState<"idle" | "closing" | "failed">("idle");

  const file = state.files[0];
  if (!isReadyFile(file)) return <Navigate to="/" replace />;

  const summary = calculatePrintSummary(state.files, state.settings);

  const finish = async () => {
    const session = state.session;
    if (!session || cleanupStatus === "closing") return;

    setCleanupStatus("closing");
    try {
      await closeKioskSession(session);
    } catch {
      setCleanupStatus("failed");
      return;
    }

    dispatch({ type: "RESET" });
    resetLocale();
    void navigate("/", { replace: true });
  };

  return (
    <div className="terminal-state terminal-state--success">
      <div className="status-mark status-mark--success" aria-hidden="true">
        ✓
      </div>
      <p className="eyebrow">{messages.status.completeEyebrow}</p>
      <h1>{messages.status.completeTitle}</h1>
      <p>{messages.status.collectSheets(summary.totalSheets)}</p>
      <dl className="completion-summary">
        <div>
          <dt>{messages.status.printed}</dt>
          <dd>
            {file.name ?? messages.upload.fileName(file.ordinal + 1, fileExtension(file.kind))}
          </dd>
        </div>
        <div>
          <dt>{messages.status.paid}</dt>
          <dd>{formatPrice(summary.priceCents, numberLocale)}</dd>
        </div>
        <div>
          <dt>{messages.status.files}</dt>
          <dd>{messages.status.deletionScheduled}</dd>
        </div>
      </dl>
      {cleanupStatus === "failed" ? (
        <div className="cleanup-recovery" role="alert">
          <strong>{messages.common.cleanupPendingTitle}</strong>
          <span>{messages.common.cleanupPendingDescription}</span>
        </div>
      ) : null}
      <button
        className="button button--primary"
        type="button"
        onClick={() => void finish()}
        disabled={cleanupStatus === "closing"}
      >
        {cleanupStatus === "failed"
          ? messages.common.retryCleanup
          : cleanupStatus === "closing"
            ? messages.common.cleanupInProgress
            : messages.status.finish}
      </button>
    </div>
  );
}

function TerminalProgress({
  eyebrow,
  title,
  description,
  detail,
  printAnimation = false
}: {
  eyebrow: string;
  title: string;
  description: string;
  detail: string;
  printAnimation?: boolean;
}) {
  return (
    <div className="terminal-state" aria-live="polite">
      {printAnimation ? (
        <div className="printer-animation" aria-hidden="true">
          <div className="printer-animation__paper" />
          <div className="printer-animation__body">▤</div>
        </div>
      ) : (
        <div className="spinner" aria-hidden="true" />
      )}
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{description}</p>
      <span className="progress-detail">{detail}</span>
      <div className="progress-bar" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}
