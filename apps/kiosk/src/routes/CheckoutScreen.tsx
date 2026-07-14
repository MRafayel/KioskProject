import { Navigate, useNavigate } from "react-router-dom";

import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  formatPrice,
  type PrototypeOutcome
} from "../features/session/model.js";

const outcomes: PrototypeOutcome[] = ["SUCCESS", "PAYMENT_DECLINED", "PRINTER_ERROR"];

export function CheckoutScreen() {
  const { messages, numberLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useNavigate();

  if (state.files.length === 0) return <Navigate to="/upload" replace />;

  const summary = calculatePrintSummary(state.files, state.settings);

  return (
    <div className="checkout-grid">
      <section className="screen-copy" aria-labelledby="checkout-title">
        <p className="eyebrow">{messages.checkout.step}</p>
        <h1 id="checkout-title">{messages.checkout.title}</h1>
        <p>{messages.checkout.description}</p>

        <article className="receipt-card">
          <div className="receipt-card__heading">
            <div>
              <strong>{state.files[0]?.name}</strong>
              <span>{messages.checkout.selectedPages(summary.selectedPages)}</span>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={() => void navigate("/configure")}
            >
              {messages.checkout.edit}
            </button>
          </div>
          <dl className="receipt-list">
            <div>
              <dt>{messages.checkout.copies}</dt>
              <dd>{state.settings.copies}</dd>
            </div>
            <div>
              <dt>{messages.checkout.sides}</dt>
              <dd>
                {state.settings.duplex
                  ? messages.configure.doubleSided
                  : messages.configure.singleSided}
              </dd>
            </div>
            <div>
              <dt>{messages.checkout.output}</dt>
              <dd>{messages.common.monochrome}</dd>
            </div>
          </dl>
        </article>

        <fieldset className="prototype-outcomes">
          <legend>{messages.checkout.prototypeOutcome}</legend>
          <p>{messages.checkout.prototypeDescription}</p>
          <div>
            {outcomes.map((outcome) => (
              <label key={outcome}>
                <input
                  type="radio"
                  name="prototype-outcome"
                  value={outcome}
                  checked={state.outcome === outcome}
                  onChange={() => dispatch({ type: "OUTCOME_CHANGED", outcome })}
                />
                <span>{outcomeLabel(outcome, messages.checkout)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <aside className="payment-card" aria-labelledby="payment-summary-title">
        <div className="lock-mark" aria-hidden="true">
          ⌁
        </div>
        <h2 id="payment-summary-title">{messages.checkout.paymentSummary}</h2>
        <dl className="summary-list">
          <div>
            <dt>{messages.checkout.monochromeSides(summary.totalSides)}</dt>
            <dd>{formatPrice(summary.totalSides * 15, numberLocale)}</dd>
          </div>
          <div>
            <dt>{messages.checkout.minimumTransaction}</dt>
            <dd>{summary.totalSides * 15 < 100 ? messages.checkout.applied : "—"}</dd>
          </div>
        </dl>
        <div className="price-total price-total--large">
          <span>{messages.checkout.totalDue}</span>
          <strong>{formatPrice(summary.priceCents, numberLocale)}</strong>
        </div>
        <button
          className="button button--primary button--wide"
          type="button"
          onClick={() => void navigate("/payment")}
        >
          {messages.checkout.pay(formatPrice(summary.priceCents, numberLocale))}{" "}
          <span aria-hidden="true">→</span>
        </button>
        <p className="payment-card__note">{messages.checkout.demoNotice}</p>
      </aside>
    </div>
  );
}

function outcomeLabel(
  outcome: PrototypeOutcome,
  messages: {
    outcomeSuccess: string;
    outcomePaymentDeclined: string;
    outcomePrinterError: string;
  }
): string {
  if (outcome === "PAYMENT_DECLINED") return messages.outcomePaymentDeclined;
  if (outcome === "PRINTER_ERROR") return messages.outcomePrinterError;
  return messages.outcomeSuccess;
}
