import { useEffect, useState } from "react";

import type { PaymentSnapshot } from "@printing-kiosk/contracts";

import { KioskRedirect, useKioskNavigate } from "../app/router.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  fileExtension,
  formatMinorAmount,
  isReadyFile
} from "../features/session/model.js";
import {
  confirmKioskPayment,
  isPaymentSettled,
  PaymentRequestError,
  readKioskPayment,
  requestSimulatedOutcome
} from "../features/session/paymentService.js";
import { closeKioskSession } from "../features/session/sessionService.js";

const PROTOTYPE_STEP_DELAY_MS = 1_200;
const PAYMENT_POLL_INTERVAL_MS = 1_500;
/** Consecutive unreadable statuses before the screen stops waiting. */
const PAYMENT_READ_FAILURE_LIMIT = 5;

/**
 * Watches one payment the control plane already created.
 *
 * Nothing here decides an outcome. The screen confirms the payment, stands in
 * for the terminal this pilot does not have by asking the deterministic
 * provider for the chosen result, and then reads the payment back until the
 * control plane reports it settled. Only a capture leads to printing.
 */
export function PaymentScreen() {
  const { messages } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();
  const paymentId = state.payment.payment?.id ?? null;
  const declineRequested = state.outcome === "PAYMENT_DECLINED";

  useEffect(() => {
    if (!paymentId) return;
    let active = true;
    let timer: number | undefined;
    let readFailures = 0;

    const leave = (path: string) => {
      if (!active) return;
      active = false;
      void navigate(path, { replace: true });
    };

    const observe = (snapshot: PaymentSnapshot): boolean => {
      if (!active) return true;
      dispatch({ type: "PAYMENT_OBSERVED", payment: snapshot });
      if (!isPaymentSettled(snapshot)) return false;
      leave(snapshot.status === "CAPTURED" ? "/printing" : "/failure/payment");
      return true;
    };

    const poll = () => {
      timer = window.setTimeout(() => {
        void (async () => {
          if (!active) return;
          try {
            const snapshot = await readKioskPayment(paymentId);
            readFailures = 0;
            if (!observe(snapshot)) poll();
          } catch (error) {
            if (!active) return;
            readFailures += 1;
            // A payment nobody can read is not a payment that failed. The
            // screen keeps asking, and gives up only after several refusals so
            // a customer is never left watching a spinner forever.
            if (readFailures < PAYMENT_READ_FAILURE_LIMIT) {
              poll();
              return;
            }
            dispatch({
              type: "PAYMENT_FAILED",
              errorCode: error instanceof PaymentRequestError ? error.code : "PAYMENT_READ_FAILED"
            });
            leave("/failure/payment");
          }
        })();
      }, PAYMENT_POLL_INTERVAL_MS);
    };

    void (async () => {
      try {
        const confirmed = await confirmKioskPayment(paymentId);
        if (observe(confirmed)) return;
      } catch (error) {
        if (!active) return;
        dispatch({
          type: "PAYMENT_FAILED",
          errorCode: error instanceof PaymentRequestError ? error.code : "PAYMENT_CONFIRM_FAILED"
        });
        leave("/failure/payment");
        return;
      }

      await requestSimulatedOutcome(paymentId, declineRequested ? "DECLINED" : "SUCCEEDED");
      if (!active) return;
      poll();
    })();

    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [declineRequested, dispatch, navigate, paymentId]);

  if (!isReadyFile(state.files[0])) return <KioskRedirect to="/upload" />;
  // Payment is only ever watched, never invented: without a payment the
  // control plane created, this screen has nothing to show.
  if (!paymentId) return <KioskRedirect to="/checkout" />;

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
  const navigate = useKioskNavigate();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void navigate(state.outcome === "PRINTER_ERROR" ? "/failure/printer" : "/complete", {
        replace: true
      });
    }, PROTOTYPE_STEP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [navigate, state.outcome]);

  if (!isReadyFile(state.files[0])) return <KioskRedirect to="/upload" />;

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

export function FailureScreen({ failureType }: { failureType: "payment" | "printer" }) {
  const { messages } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();
  const paymentFailure = failureType === "payment";

  if (!isReadyFile(state.files[0])) return <KioskRedirect to="/upload" />;

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
            // A declined payment is settled and final. Retrying means asking
            // the control plane for a new one, which starts at the checkout.
            if (paymentFailure) dispatch({ type: "PAYMENT_CLEARED" });
            void navigate(paymentFailure ? "/checkout" : "/printing");
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
  const navigate = useKioskNavigate();
  const [cleanupStatus, setCleanupStatus] = useState<"idle" | "closing" | "failed">("idle");

  const file = state.files[0];
  if (!isReadyFile(file)) return <KioskRedirect to="/" />;

  const quote = state.pricing.quote;
  const localSummary = calculatePrintSummary(state.files, state.settings);
  const collectedSheets = quote?.physicalSheets ?? localSummary.totalSheets;
  // What was actually captured, when a capture happened. The quote is the
  // fallback for a receipt shown before a payment exists.
  const captured = state.payment.payment;
  const paid = captured?.status === "CAPTURED" ? captured : quote;

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
      <p>{messages.status.collectSheets(collectedSheets)}</p>
      <dl className="completion-summary">
        <div>
          <dt>{messages.status.printed}</dt>
          <dd>
            {file.name ?? messages.upload.fileName(file.ordinal + 1, fileExtension(file.kind))}
          </dd>
        </div>
        {/* The receipt shows the amount the control plane quoted, never a
            figure this screen worked out for itself. */}
        {paid ? (
          <div>
            <dt>{messages.status.paid}</dt>
            <dd>
              {formatMinorAmount(
                "amountMinor" in paid ? paid.amountMinor : paid.totalMinor,
                paid.currency,
                paid.currencyExponent,
                numberLocale
              )}
            </dd>
          </div>
        ) : null}
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
