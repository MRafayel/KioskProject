import { useCallback, useEffect, useRef } from "react";

import type { PaymentSnapshot, PrintJobSnapshot } from "@printing-kiosk/contracts";

import { KioskRedirect, useKioskNavigate } from "../app/router.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { clearFulfillmentState } from "../features/session/fulfillmentPersistence.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  fileExtension,
  formatMinorAmount,
  readyFiles,
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
  FINISHING_HOLD_MS,
  usePrintStage,
  type PrintStage
} from "../features/session/printProgress.js";
import {
  isPrintJobSettled,
  isPrintJobSuccessful,
  isPrintRecoveryRequired,
  isRetryablePrintFailure,
  PrintRequestError,
  readKioskPrintJob,
  startKioskPrintJob
} from "../features/session/printService.js";
import { clearStoredSessionKeys } from "../features/session/sessionService.js";

const PAYMENT_POLL_INTERVAL_MS = 1_500;
const PRINT_POLL_INTERVAL_MS = 1_500;
/** Consecutive unreadable statuses before the screen stops waiting. */
const PAYMENT_READ_FAILURE_LIMIT = 5;
const PRINT_READ_FAILURE_LIMIT = 5;
const COMPLETE_SCREEN_HOLD_MS = 5_000;

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

  if (readyFiles(state.files).length === 0) return <KioskRedirect to="/upload" />;
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
  const observedPrintJob = state.print.job;
  const observedPrintJobId =
    observedPrintJob?.sessionId === sessionId && observedPrintJob.paymentId === paymentId
      ? observedPrintJob.id
      : null;
  const observedPrintJobSettled = observedPrintJob ? isPrintJobSettled(observedPrintJob) : false;
  const observedPrintJobSuccessful = observedPrintJob
    ? isPrintJobSuccessful(observedPrintJob)
    : false;
  // Presentation only. It reads the job this screen already polls and cannot
  // reach the device, so it can neither delay a print nor change its outcome.
  const stage = usePrintStage(observedPrintJob);

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
      if (isPrintJobSuccessful(printJob)) {
        // The receipt waits for the confirmation beat to be readable. Nothing
        // is being decided in this pause — the outcome is already settled and
        // the device has long since finished — so it can only ever delay a
        // screen, never a print. A failure is never held back like this: it
        // needs to reach the customer at once.
        timer = window.setTimeout(() => leave("/complete"), FINISHING_HOLD_MS);
        return true;
      }
      leave("/failure/printer");
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
            const retryable = isRetryablePrintFailure(error);
            readFailures += 1;
            // An ambiguous outage says nothing about the job, so retry it a
            // bounded number of times. A deterministic client refusal cannot
            // improve by polling and is escalated to an operator immediately.
            if (retryable && readFailures < PRINT_READ_FAILURE_LIMIT) {
              poll(printJobId);
              return;
            }
            dispatch({
              type: "PRINT_FAILED",
              errorCode: error instanceof PrintRequestError ? error.code : "PRINT_READ_FAILED",
              failureDisposition: retryable ? "RETRYABLE" : "OPERATOR_REQUIRED"
            });
            leave("/failure/printer");
          }
        })();
      }, PRINT_POLL_INTERVAL_MS);
    };

    // A read outage can leave a known job in local state. Resume observing that
    // job instead of asking to start it again. If the start response itself was
    // lost there is no job identifier yet, so replay the POST with the stable
    // idempotency key retained by startKioskPrintJob.
    if (observedPrintJobId) {
      if (observedPrintJobSettled) {
        leave(observedPrintJobSuccessful ? "/complete" : "/failure/printer");
      } else {
        poll(observedPrintJobId);
      }
    } else {
      void (async () => {
        try {
          const started = await startKioskPrintJob(sessionId, paymentId, requestedScenario);
          if (observe(started)) return;
          poll(started.id);
        } catch (error) {
          if (!active) return;
          dispatch({
            type: "PRINT_FAILED",
            errorCode: error instanceof PrintRequestError ? error.code : "PRINT_START_FAILED",
            failureDisposition: isRetryablePrintFailure(error) ? "RETRYABLE" : "OPERATOR_REQUIRED"
          });
          leave("/failure/printer");
        }
      })();
    }

    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    dispatch,
    navigate,
    observedPrintJobId,
    observedPrintJobSettled,
    observedPrintJobSuccessful,
    paymentId,
    requestedScenario,
    sessionId
  ]);

  if (readyFiles(state.files).length === 0) return <KioskRedirect to="/upload" />;
  // Printing is only ever watched, never invented: without a capture the
  // control plane applied to this session, this screen has nothing to show.
  if (!paymentId) return <KioskRedirect to="/checkout" />;

  return (
    <TerminalProgress
      eyebrow={messages.status.printingEyebrow}
      title={messages.status.printingTitle}
      description={messages.status.printingDescription}
      detail={messages.status.printingStages[stage]}
      stage={stage}
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
  const settledPrintFailure =
    !paymentFailure &&
    state.print.job !== null &&
    isPrintJobSettled(state.print.job) &&
    !isPrintJobSuccessful(state.print.job);
  // A POST or GET transport failure says nothing about what the printer did.
  // Keep the paid session and replay keys until the control plane reports a
  // terminal failure or recovery outcome.
  const printStatusUnavailable = !paymentFailure && !settledPrintFailure;
  const printOperatorRequired =
    printStatusUnavailable && state.print.failureDisposition === "OPERATOR_REQUIRED";

  if (readyFiles(state.files).length === 0) return <KioskRedirect to="/upload" />;

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
          : printStatusUnavailable
            ? printOperatorRequired
              ? messages.status.printerOperatorRequiredTitle
              : messages.status.printerStatusUnavailableTitle
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
          : printStatusUnavailable
            ? printOperatorRequired
              ? messages.status.printerOperatorRequiredDescription
              : messages.status.printerStatusUnavailableDescription
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
            : printStatusUnavailable
              ? printOperatorRequired
                ? messages.status.printerOperatorRequiredCode
                : messages.status.printerStatusUnavailableCode
              : printRecovery
                ? messages.status.printerRecoveryCode
                : messages.status.printerErrorCode}
        </strong>
        <span>
          {paymentFailure
            ? messages.status.failureDetail
            : printStatusUnavailable
              ? printOperatorRequired
                ? messages.status.printerOperatorRequiredDetail
                : messages.status.printerStatusUnavailableDetail
              : printRecovery
                ? messages.status.printerRecoveryDetail
                : messages.status.printerRefundNotice}
        </span>
      </div>
      {printOperatorRequired ? null : (
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
                if (printStatusUnavailable) {
                  // No terminal result was observed, so keep both the fulfillment
                  // snapshot and replay keys and resume the same paid workflow.
                  void navigate("/printing");
                  return;
                }
                // A settled print job is final: the session is already closed and
                // its documents are already scheduled for deletion. There is
                // nothing to retry here, only a screen to hand to the next
                // customer.
                clearStoredSessionKeys(state.session?.id);
                clearFulfillmentState();
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
            {paymentFailure
              ? messages.status.retryPayment
              : printStatusUnavailable
                ? messages.status.retryPrinting
                : messages.status.finish}
          </button>
        </div>
      )}
    </div>
  );
}

export function CompleteScreen() {
  const { messages, numberLocale, resetLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();
  const finishStartedRef = useRef(false);

  const documents = readyFiles(state.files);
  const completedSuccessfully = state.print.job !== null && isPrintJobSuccessful(state.print.job);
  const sessionId = state.session?.id;
  const finish = useCallback(() => {
    if (finishStartedRef.current) return;
    finishStartedRef.current = true;
    clearStoredSessionKeys(sessionId);
    clearFulfillmentState();
    dispatch({ type: "RESET" });
    resetLocale();
    void navigate("/", { replace: true });
  }, [dispatch, navigate, resetLocale, sessionId]);

  useEffect(() => {
    if (documents.length === 0 || !completedSuccessfully) return;
    // Only the success route mounts this timer. It reuses the same reset action
    // and local cleanup as the former Finish action, and the ref keeps cleanup
    // idempotent if another customer interaction races the timeout.
    const timer = window.setTimeout(finish, COMPLETE_SCREEN_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [completedSuccessfully, documents.length, finish]);

  if (documents.length === 0) return <KioskRedirect to="/" />;

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
          {/* Every document the customer paid for is named, so the receipt
              accounts for the whole job rather than only its first document. */}
          <dd>
            {documents
              .map(
                (document) =>
                  document.name ??
                  messages.upload.fileName(document.ordinal + 1, fileExtension(document.kind))
              )
              .join(", ")}
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
      <p className="completion-auto-close">{messages.status.completeAutoClose}</p>
    </div>
  );
}

/**
 * The illustration for a stage.
 *
 * Every one of these is CSS on a handful of elements: no images, no timers of
 * its own and nothing to load, so the animation cannot become the next source
 * of latency on a machine that is already busy rasterising a PDF. All of it is
 * `aria-hidden`, because the stage is announced as text by the live region
 * around it, and the whole set stops moving under `prefers-reduced-motion`.
 */
function StageArt({ stage }: { stage: PrintStage }) {
  if (stage === "FINISHING") {
    return (
      <div className="stage-art stage-art--done" aria-hidden="true">
        <div className="stage-art__check">✓</div>
      </div>
    );
  }
  if (stage === "PREPARING_FILES") {
    return (
      <div className="stage-art stage-art--files" aria-hidden="true">
        <span className="stage-art__sheet" />
        <span className="stage-art__sheet" />
        <span className="stage-art__sheet" />
      </div>
    );
  }
  if (stage === "PREPARING_PAGES") {
    return (
      <div className="stage-art stage-art--pages" aria-hidden="true">
        <div className="stage-art__page">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }
  // Checking, sending and printing all show the device, so the object on screen
  // stays put across three stages instead of being swapped twice.
  return (
    <div
      className={`stage-art stage-art--printer stage-art--${stage.toLowerCase()}`}
      aria-hidden="true"
    >
      <span className="stage-art__paper" />
      <span className="stage-art__body" />
    </div>
  );
}

function TerminalProgress({
  eyebrow,
  title,
  description,
  detail,
  stage
}: {
  eyebrow: string;
  title: string;
  description: string;
  detail: string;
  stage?: PrintStage;
}) {
  return (
    <div className="terminal-state" aria-live="polite">
      {stage ? <StageArt stage={stage} /> : <div className="spinner" aria-hidden="true" />}
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{description}</p>
      {/* Keyed so each stage's text fades in as its own element rather than
          the previous sentence mutating in place. */}
      <span className="progress-detail progress-detail--stage" key={stage ?? "static"}>
        {detail}
      </span>
      <div className="progress-bar" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}
