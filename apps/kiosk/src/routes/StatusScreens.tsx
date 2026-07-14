import { useEffect } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { calculatePrintSummary, formatPrice } from "../features/session/model.js";

const PROTOTYPE_STEP_DELAY_MS = 1_200;

export function PaymentScreen() {
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

  if (state.files.length === 0) return <Navigate to="/upload" replace />;

  return (
    <TerminalProgress
      eyebrow="Secure demo payment"
      title="Processing payment"
      description="Please wait. Do not close or leave this screen."
      detail="No real charge is made in this prototype."
    />
  );
}

export function PrintingScreen() {
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

  if (state.files.length === 0) return <Navigate to="/upload" replace />;

  return (
    <TerminalProgress
      eyebrow="Step 4 of 4"
      title="Printing your document"
      description="Your payment was approved. Please wait for every sheet."
      detail="Preparing · Sending · Printing"
      printAnimation
    />
  );
}

export function FailureScreen() {
  const { state, dispatch } = usePrototypeSession();
  const navigate = useNavigate();
  const { failureType } = useParams();
  const paymentFailure = failureType === "payment";

  if (state.files.length === 0) return <Navigate to="/upload" replace />;

  return (
    <div className="terminal-state terminal-state--error">
      <div className="status-mark" aria-hidden="true">
        !
      </div>
      <p className="eyebrow">Action needed</p>
      <h1>{paymentFailure ? "Payment was declined" : "The printer needs attention"}</h1>
      <p>
        {paymentFailure
          ? "Nothing was charged. You can retry the demo payment or return to your settings."
          : "Printing stopped before completion. Keep this session open while you retry."}
      </p>
      <div className="failure-detail" role="status">
        <strong>{paymentFailure ? "PAYMENT_DECLINED" : "PRINTER_UNAVAILABLE"}</strong>
        <span>Prototype failure · Your file is still available in this session.</span>
      </div>
      <div className="button-row button-row--center">
        <button
          className="button button--secondary"
          type="button"
          onClick={() => void navigate(paymentFailure ? "/checkout" : "/configure")}
        >
          Review settings
        </button>
        <button
          className="button button--primary"
          type="button"
          onClick={() => {
            dispatch({ type: "OUTCOME_CHANGED", outcome: "SUCCESS" });
            void navigate(paymentFailure ? "/payment" : "/printing");
          }}
        >
          Retry {paymentFailure ? "payment" : "printing"}
        </button>
      </div>
    </div>
  );
}

export function CompleteScreen() {
  const { state, dispatch } = usePrototypeSession();
  const navigate = useNavigate();

  if (state.files.length === 0) return <Navigate to="/" replace />;

  const summary = calculatePrintSummary(state.files, state.settings);

  const finish = () => {
    dispatch({ type: "RESET" });
    void navigate("/", { replace: true });
  };

  return (
    <div className="terminal-state terminal-state--success">
      <div className="status-mark status-mark--success" aria-hidden="true">
        ✓
      </div>
      <p className="eyebrow">Print complete</p>
      <h1>Your documents are ready</h1>
      <p>
        Collect all {summary.totalSheets} sheet{summary.totalSheets === 1 ? "" : "s"} from the
        output area below.
      </p>
      <dl className="completion-summary">
        <div>
          <dt>Printed</dt>
          <dd>{state.files[0]?.name}</dd>
        </div>
        <div>
          <dt>Paid</dt>
          <dd>{formatPrice(summary.priceCents)}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>Deletion scheduled</dd>
        </div>
      </dl>
      <button className="button button--primary" type="button" onClick={finish}>
        Finish and delete files
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
