import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PaymentSnapshot, PrintJobSnapshot } from "@printing-kiosk/contracts";

import { KioskRedirect, useKioskNavigate } from "../app/router.js";
import { SessionTimer } from "../components/SessionTimer.js";
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
import { applyPrintedSheets } from "../features/session/paper.js";
import { usePrintStage, type PrintStage } from "../features/session/printProgress.js";
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
type ActivePrintStage = Exclude<PrintStage, "FINISHING">;

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
  const printCompleted = observedPrintJobId !== null && observedPrintJobSuccessful;
  // Presentation only. It reads the job this screen already polls and cannot
  // reach the device, so it can neither delay a print nor change its outcome.
  const stage = usePrintStage(observedPrintJob);

  // The sheets this job produced have already left the tray, and the control
  // plane already took them out of the ledger when it confirmed the completion.
  // Taking them out of the screen's copy here is what stops the next customer
  // being offered a count the kiosk stopped having twenty seconds ago.
  //
  // Once per job. This effect re-runs on every poll and again if the screen
  // resumes a job it had already seen settle, and a deduction applied twice
  // would understate the paper until the next poll corrected it.
  const queryClient = useQueryClient();
  const deductedPrintJobId = useRef<string | null>(null);
  useEffect(() => {
    if (!observedPrintJob || !observedPrintJobSuccessful) return;
    if (deductedPrintJobId.current === observedPrintJob.id) return;
    deductedPrintJobId.current = observedPrintJob.id;
    void applyPrintedSheets(queryClient, observedPrintJob.sheetsProduced ?? 0);
  }, [observedPrintJob, observedPrintJobSuccessful, queryClient]);

  // Straight to the receipt. There used to be a success animation between the
  // two, and the wait for it to play was the only reason this was ever delayed:
  // a customer whose documents are already in the tray is standing there
  // waiting to be told to take them, not watching a check mark being drawn.
  useEffect(() => {
    if (!printCompleted) return;
    void navigate("/complete", { replace: true });
  }, [navigate, printCompleted]);

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
      if (isPrintJobSuccessful(printJob)) return true;
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
        if (!observedPrintJobSuccessful) leave("/failure/printer");
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
  // `FINISHING` is only ever a ceiling now — the effect above leaves for the
  // receipt the moment it is reached — but the last frame before that
  // navigation still has to say something, and it says what it was saying.
  const activeStage: ActivePrintStage = stage === "FINISHING" ? "PRINTING" : stage;

  return (
    <TerminalProgress
      // The rotating stage now carries the eyebrow. "Step 4 of 4" was true and
      // useless: it never changed, so the only moving text on a screen somebody
      // waits at was one line near the bottom.
      eyebrow={messages.status.printingStages[activeStage]}
      title={messages.status.printingTitle}
      description={messages.status.printingDescription}
      stage={activeStage}
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
      <SessionTimer />
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
  const autoCloseTimerRef = useRef<number | undefined>(undefined);

  const documents = readyFiles(state.files);
  const completedSuccessfully = state.print.job !== null && isPrintJobSuccessful(state.print.job);
  const sessionId = state.session?.id;
  /**
   * Ending the session, whoever asked for it.
   *
   * The button and the timer are two ways of reaching one action rather than
   * two implementations of it, which is what keeps them from doing the cleanup
   * twice or navigating over each other. The ref closes the door on the second
   * caller; cancelling the timer here means a customer who presses the button
   * is not followed a moment later by a timeout that fires into an unmounted
   * screen. A customer who presses nothing still gets the timer.
   */
  const finish = useCallback(() => {
    if (finishStartedRef.current) return;
    finishStartedRef.current = true;
    if (autoCloseTimerRef.current !== undefined) {
      window.clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = undefined;
    }
    clearStoredSessionKeys(sessionId);
    clearFulfillmentState();
    dispatch({ type: "RESET" });
    resetLocale();
    void navigate("/", { replace: true });
  }, [dispatch, navigate, resetLocale, sessionId]);

  useEffect(() => {
    if (documents.length === 0 || !completedSuccessfully) return;
    // Only the success route mounts this timer.
    autoCloseTimerRef.current = window.setTimeout(finish, COMPLETE_SCREEN_HOLD_MS);
    return () => {
      if (autoCloseTimerRef.current !== undefined) {
        window.clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = undefined;
      }
    };
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
      {/* The completion animation lives in the success mark itself rather than
          on a screen of its own. The mark it settles on is the same one this
          element renders without the modifier, so the motion is an approach to
          the receipt's own icon and not a second thing shown before it. Only a
          confirmed print earns it: a receipt reached any other way opens on the
          finished mark. */}
      <div
        className={`status-mark status-mark--success${
          completedSuccessfully ? " status-mark--settle" : ""
        }`}
        aria-hidden="true"
      >
        <span className="status-mark__ring" />
        <span className="status-mark__glyph">✓</span>
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
      <button className="button button--primary" type="button" onClick={finish}>
        {messages.status.finish}
      </button>
    </div>
  );
}

const PRINT_MESSAGE_TRANSITION_MS = 220;

function PrintStagePill({ stage, message }: { stage: ActivePrintStage; message: string }) {
  const currentRef = useRef({ stage, message });
  const [transition, setTransition] = useState<{
    current: { stage: ActivePrintStage; message: string };
    previous: { stage: ActivePrintStage; message: string } | null;
  }>({ current: currentRef.current, previous: null });

  useEffect(() => {
    const previous = currentRef.current;
    if (previous.stage === stage && previous.message === message) return;

    const current = { stage, message };
    currentRef.current = current;
    setTransition({ current, previous });

    const timer = window.setTimeout(() => {
      setTransition(({ current: latest }) => ({ current: latest, previous: null }));
    }, PRINT_MESSAGE_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [message, stage]);

  return (
    <p
      className="status-pill status-pill--waiting print-stage-pill"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="pulse" aria-hidden="true" />
      <span className="print-stage-pill__messages">
        {transition.previous ? (
          <span
            className="print-stage-pill__message print-stage-pill__message--outgoing"
            aria-hidden="true"
          >
            {transition.previous.message}
          </span>
        ) : null}
        <span
          className={
            transition.previous
              ? "print-stage-pill__message print-stage-pill__message--incoming"
              : "print-stage-pill__message"
          }
        >
          {transition.current.message}
        </span>
      </span>
    </p>
  );
}

function StageArt({ stage }: { stage: ActivePrintStage }) {
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
  detail?: string;
  stage?: ActivePrintStage;
}) {
  return (
    <div className="terminal-state" aria-live="polite">
      {stage ? <StageArt stage={stage} /> : <div className="spinner" aria-hidden="true" />}
      {stage ? (
        <PrintStagePill stage={stage} message={eyebrow} />
      ) : (
        <p className="eyebrow">{eyebrow}</p>
      )}
      <h1 className={stage ? "terminal-state__headline" : undefined}>{title}</h1>
      <p>{description}</p>
      {detail ? <span className="progress-detail">{detail}</span> : null}
    </div>
  );
}
