import { KioskRedirect, useKioskNavigate } from "../app/router.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  fileExtension,
  formatMinorAmount,
  isQuotePayable,
  isReadyFile,
  type PrototypeOutcome
} from "../features/session/model.js";

const outcomes: PrototypeOutcome[] = ["SUCCESS", "PAYMENT_DECLINED", "PRINTER_ERROR"];

export function CheckoutScreen() {
  const { messages, numberLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();

  const file = state.files[0];
  const quote = state.pricing.quote;
  const settings = state.pricing.settings;
  // Payment may only ever be offered against a live server quote. A price that
  // expired or was invalidated sends the customer back to reconfigure rather
  // than letting a stale total reach the payment step.
  if (!isReadyFile(file)) return <KioskRedirect to="/upload" />;
  if (!settings || !isQuotePayable(quote, new Date())) return <KioskRedirect to="/configure" />;

  const money = (amountMinor: number) =>
    formatMinorAmount(amountMinor, quote.currency, quote.currencyExponent, numberLocale);

  return (
    <div className="checkout-grid">
      <section className="screen-copy" aria-labelledby="checkout-title">
        <p className="eyebrow">{messages.checkout.step}</p>
        <h1 id="checkout-title">{messages.checkout.title}</h1>
        <p>{messages.checkout.description}</p>

        <article className="receipt-card">
          <div className="receipt-card__heading">
            <div>
              <strong>
                {file.name ?? messages.upload.fileName(file.ordinal + 1, fileExtension(file.kind))}
              </strong>
              <span>{messages.checkout.selectedPages(quote.selectedPages)}</span>
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
              <dd>{settings.copies}</dd>
            </div>
            <div>
              <dt>{messages.checkout.sides}</dt>
              <dd>
                {settings.duplex === "SIMPLEX"
                  ? messages.configure.singleSided
                  : messages.configure.doubleSided}
              </dd>
            </div>
            <div>
              <dt>{messages.checkout.paperSheets}</dt>
              <dd>{quote.physicalSheets}</dd>
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
            <dt>{messages.checkout.monochromeSides(quote.printedSides)}</dt>
            <dd>{money(quote.breakdown.printAmountMinor)}</dd>
          </div>
          {quote.breakdown.serviceFeeMinor > 0 ? (
            <div>
              <dt>{messages.checkout.serviceFee}</dt>
              <dd>{money(quote.breakdown.serviceFeeMinor)}</dd>
            </div>
          ) : null}
          <div>
            <dt>{messages.checkout.minimumTransaction}</dt>
            <dd>
              {quote.breakdown.minimumAdjustmentMinor > 0
                ? money(quote.breakdown.minimumAdjustmentMinor)
                : "—"}
            </dd>
          </div>
          {quote.taxMinor > 0 ? (
            <div>
              <dt>{messages.checkout.tax}</dt>
              <dd>{money(quote.taxMinor)}</dd>
            </div>
          ) : null}
        </dl>
        <div className="price-total price-total--large">
          <span>{messages.checkout.totalDue}</span>
          <strong>{money(quote.totalMinor)}</strong>
        </div>
        <button
          className="button button--primary button--wide"
          type="button"
          onClick={() => void navigate("/payment")}
        >
          {messages.checkout.pay(money(quote.totalMinor))} <span aria-hidden="true">→</span>
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
