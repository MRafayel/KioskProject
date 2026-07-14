import { Navigate, useNavigate } from "react-router-dom";

import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  formatPrice,
  type PrototypeOutcome
} from "../features/session/model.js";

const outcomes: Array<{ value: PrototypeOutcome; label: string }> = [
  { value: "SUCCESS", label: "Successful print" },
  { value: "PAYMENT_DECLINED", label: "Payment declined" },
  { value: "PRINTER_ERROR", label: "Printer error" }
];

export function CheckoutScreen() {
  const { state, dispatch } = usePrototypeSession();
  const navigate = useNavigate();

  if (state.files.length === 0) return <Navigate to="/upload" replace />;

  const summary = calculatePrintSummary(state.files, state.settings);

  return (
    <div className="checkout-grid">
      <section className="screen-copy" aria-labelledby="checkout-title">
        <p className="eyebrow">Step 3 of 4</p>
        <h1 id="checkout-title">Review and pay</h1>
        <p>Check your print details. The prototype will simulate payment at this kiosk.</p>

        <article className="receipt-card">
          <div className="receipt-card__heading">
            <div>
              <strong>{state.files[0]?.name}</strong>
              <span>{summary.selectedPages} selected pages</span>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={() => void navigate("/configure")}
            >
              Edit
            </button>
          </div>
          <dl className="receipt-list">
            <div>
              <dt>Copies</dt>
              <dd>{state.settings.copies}</dd>
            </div>
            <div>
              <dt>Paper</dt>
              <dd>{state.settings.paperSize}</dd>
            </div>
            <div>
              <dt>Sides</dt>
              <dd>{state.settings.duplex ? "Double-sided" : "Single-sided"}</dd>
            </div>
            <div>
              <dt>Layout</dt>
              <dd>
                {state.settings.pagesPerSheet} page{state.settings.pagesPerSheet === 1 ? "" : "s"}{" "}
                per side
              </dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>Monochrome</dd>
            </div>
          </dl>
        </article>

        <fieldset className="prototype-outcomes">
          <legend>Prototype outcome</legend>
          <p>Choose a result to verify the kiosk recovery screens.</p>
          <div>
            {outcomes.map((outcome) => (
              <label key={outcome.value}>
                <input
                  type="radio"
                  name="prototype-outcome"
                  value={outcome.value}
                  checked={state.outcome === outcome.value}
                  onChange={() => dispatch({ type: "OUTCOME_CHANGED", outcome: outcome.value })}
                />
                <span>{outcome.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <aside className="payment-card" aria-labelledby="payment-summary-title">
        <div className="lock-mark" aria-hidden="true">
          ⌁
        </div>
        <h2 id="payment-summary-title">Payment summary</h2>
        <dl className="summary-list">
          <div>
            <dt>{summary.totalSides} monochrome sides</dt>
            <dd>{formatPrice(summary.totalSides * 15)}</dd>
          </div>
          <div>
            <dt>Minimum transaction</dt>
            <dd>{summary.totalSides * 15 < 100 ? "Applied" : "—"}</dd>
          </div>
        </dl>
        <div className="price-total price-total--large">
          <span>Total due</span>
          <strong>{formatPrice(summary.priceCents)}</strong>
        </div>
        <button
          className="button button--primary button--wide"
          type="button"
          onClick={() => void navigate("/payment")}
        >
          Pay {formatPrice(summary.priceCents)} <span aria-hidden="true">→</span>
        </button>
        <p className="payment-card__note">Demo only. No card data or real charge is involved.</p>
      </aside>
    </div>
  );
}
