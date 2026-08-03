import { useEffect, useState } from "react";

import type { PaymentSnapshot, PrintJobSnapshot } from "@printing-kiosk/contracts";

import { KioskRedirect, useKioskNavigate } from "../app/router.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  fileExtension,
  formatMinorAmount,
  isReadyFile,
  simulatedPrintOutcomeFor
} from "../features/session/model.js";
import {
  confirmKioskPayment,
  isPaymentSettled,
  isPaymentSuccessful,
  PaymentRequestError,
  readKioskPayment,
  requestSimulatedOutcome
} from "../features/session/paymentService.js";
import {
  isPrintJobSettled,
  isPrintJobSuccessful,
  isPrintRecoveryRequired,
  PrintRequestError,
  readKioskPrintJob,
  startKioskPrintJob
} from "../features/session/printService.js";
import { closeKioskSession } from "../features/session/sessionService.js";

const PAYMENT_POLL_INTERVAL_MS = 1_500;
const PRINT_POLL_INTERVAL_MS = 1_500;
/** Consecutive unreadable statuses before the screen stops waiting. */
const PAYMENT_READ_FAILURE_LIMIT = 5;
const PRINT_READ_FAILURE_LIMIT = 5;

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
      leave(isPaymentSuccessful(snapshot) ? "/printing" : "/failure/payment");
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

/**
 * Watches one print job the control plane owns.
 *
 * Nothing here prints, and nothing here decides an outcome. The screen asks the
 * control plane to start the job that the capture already paid for, then reads
 * it back until it settles. Only a confirmed completion reaches the receipt;
 * anything the device could not confirm goes to the recovery screen instead of
 * being called a success or a failure.
 */
export function PrintingScreen() {
  const { messages } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();
  const sessionId = state.session?.id ?? null;
  const captured = state.payment.payment;
  const paymentId = captured && isPaymentSuccessful(captured) ? captured.id : null;
  const requestedScenario = simulatedPrintOutcomeFor[state.outcome];

  useEffect(() => {
    if (!sessionId || !paymentId) return;
    let active = true;
    let timer: number | undefined;
    let readFailures = 0;

    const leave = (path: string) => {
      if (!active) return;
      active = false;
      void navigate(path, { replace: true });
    };

    const observe = (printJob: PrintJobSnapshot): boolean => {
      if (!active) return true;
      dispatch({ type: "PRINT_OBSERVED", printJob });
      if (!isPrintJobSettled(printJob)) return false;
      leave(isPrintJobSuccessful(printJob) ? "/complete" : "/failure/printer");
      return true;
    };

    const poll = (printJobId: string) => {
      timer = window.setTimeout(() => {
        void (async () => {
          if (!active) return;
          try {
            const printJob = await readKioskPrintJob(printJobId);
            readFailures = 0;
            if (!observe(printJob)) poll(printJobId);
          } catch (error) {
            if (!active) return;
            readFailures += 1;
            // A job nobody can read is not a job that failed. The screen keeps
            // asking, and gives up only after several refusals so a customer is
            // never left watching a spinner forever.
            if (readFailures < PRINT_READ_FAILURE_LIMIT) {
              poll(printJobId);
              return;
            }
            dispatch({
              type: "PRINT_FAILED",
              errorCode: error instanceof PrintRequestError ? error.code : "PRINT_READ_FAILED"
            });
            leave("/failure/printer");
          }
        })();
      }, PRINT_POLL_INTERVAL_MS);
    };

    void (async () => {
      try {
        const started = await startKioskPrintJob(sessionId, paymentId, requestedScenario);
        if (observe(started)) return;
        poll(started.id);
      } catch (error) {
        if (!active) return;
        dispatch({
          type: "PRINT_FAILED",
          errorCode: error instanceof PrintRequestError ? error.code : "PRINT_START_FAILED"
        });
        leave("/failure/printer");
      }
    })();

    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [dispatch, navigate, paymentId, requestedScenario, sessionId]);

  if (!isReadyFile(state.files[0])) return <KioskRedirect to="/upload" />;
  // Printing is only ever watched, never invented: without a capture the
  // control plane applied to this session, this screen has nothing to show.
  if (!paymentId) return <KioskRedirect to="/checkout" />;

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
  const { messages, resetLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();
  const paymentFailure = failureType === "payment";
  const pendingPayment =
    paymentFailure && state.payment.payment && !isPaymentSettled(state.payment.payment)
      ? state.payment.payment
      : null;
  const compensatedCapture =
    paymentFailure &&
    state.payment.payment?.status === "CAPTURED" &&
    !state.payment.payment.appliedToSession;
  // A print the device could not confirm is neither a success nor a failure.
  // The customer is told exactly that, and no refund is promised on screen
  // because whether paper emerged is an operator's decision.
  const printRecovery =
    !paymentFailure && state.print.job !== null && isPrintRecoveryRequired(state.print.job);

  if (!isReadyFile(state.files[0])) return <KioskRedirect to="/upload" />;

  return (
    <div className="terminal-state terminal-state--error">
      <div className="status-mark" aria-hidden="true">
        !
      </div>
      <p className="eyebrow">{messages.status.actionNeeded}</p>
      <h1>
        {paymentFailure
          ? pendingPayment
            ? messages.status.paymentStatusUnavailableTitle
            : compensatedCapture
              ? messages.status.paymentCompensatedTitle
              : messages.status.paymentDeclinedTitle
          : printRecovery
            ? messages.status.printerRecoveryTitle
            : messages.status.printerErrorTitle}
      </h1>
      <p>
        {paymentFailure
          ? pendingPayment
            ? messages.status.paymentStatusUnavailableDescription
            : compensatedCapture
              ? messages.status.paymentCompensatedDescription
              : messages.status.paymentDeclinedDescription
          : printRecovery
            ? messages.status.printerRecoveryDescription
            : messages.status.printerErrorDescription}
      </p>
      <div className="failure-detail" role="status">
        <strong>
          {paymentFailure
            ? pendingPayment
              ? messages.status.paymentStatusUnavailableCode
              : compensatedCapture
                ? messages.status.paymentCompensatedCode
                : messages.status.paymentDeclinedCode
            : printRecovery
              ? messages.status.printerRecoveryCode
              : messages.status.printerErrorCode}
        </strong>
        <span>
          {paymentFailure
            ? messages.status.failureDetail
            : printRecovery
              ? messages.status.printerRecoveryDetail
              : messages.status.printerRefundNotice}
        </span>
      </div>
      <div className="button-row button-row--center">
        {paymentFailure && !pendingPayment ? (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => void navigate("/checkout")}
          >
            {messages.status.reviewSettings}
          </button>
        ) : null}
        <button
          className="button button--primary"
          type="button"
          onClick={() => {
            if (!paymentFailure) {
              // A settled print job is final: the session is already closed and
              // its documents are already scheduled for deletion. There is
              // nothing to retry here, only a screen to hand to the next
              // customer.
              dispatch({ type: "RESET" });
              resetLocale();
              void navigate("/", { replace: true });
              return;
            }

            dispatch({ type: "OUTCOME_CHANGED", outcome: "SUCCESS" });
            // A declined payment is settled and final. Retrying means asking
            // the control plane for a new one. A transient confirm/read failure
            // keeps its pending payment identifier and resumes watching it,
            // so the retry cannot collide with PAYMENT_IN_PROGRESS.
            if (!pendingPayment) dispatch({ type: "PAYMENT_CLEARED" });
            void navigate(pendingPayment ? "/payment" : "/checkout");
          }}
        >
          {paymentFailure ? messages.status.retryPayment : messages.status.finish}
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
  // What the device says it produced, then what was paid for, then the local
  // arithmetic. The screen never counts sheets the printer did not report.
  const collectedSheets =
    state.print.job?.sheetsProduced ?? quote?.physicalSheets ?? localSummary.totalSheets;
  // What was actually captured, when a capture happened. The quote is the
  // fallback for a receipt shown before a payment exists.
  const captured = state.payment.payment;
  const paid = captured ? (isPaymentSuccessful(captured) ? captured : null) : quote;

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
