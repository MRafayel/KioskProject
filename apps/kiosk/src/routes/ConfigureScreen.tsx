import { Navigate, useNavigate } from "react-router-dom";

import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  fileExtension,
  formatFileSize,
  formatPrice,
  isReadyFile,
  type Orientation,
  type PrintSettings
} from "../features/session/model.js";

export function ConfigureScreen() {
  const { messages, numberLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useNavigate();
  const file = state.files[0];

  if (!isReadyFile(file)) return <Navigate to="/upload" replace />;

  const summary = calculatePrintSummary(state.files, state.settings);
  const update = (settings: Partial<PrintSettings>) =>
    dispatch({ type: "SETTINGS_CHANGED", settings });
  const pageEnd = state.settings.pageEnd ?? file.pageCount;

  const setPageStart = (value: number) => {
    const nextPage = clamp(value, 1, file.pageCount);
    const nextEnd = Math.max(pageEnd, nextPage);
    update({
      pageStart: nextPage,
      pageEnd: nextEnd === file.pageCount ? null : nextEnd
    });
  };

  const setPageEnd = (value: number) => {
    const nextPage = clamp(value, 1, file.pageCount);
    update({
      pageStart: Math.min(state.settings.pageStart, nextPage),
      pageEnd: nextPage === file.pageCount ? null : nextPage
    });
  };

  return (
    <div className="configuration-page">
      <header className="screen-heading">
        <div>
          <p className="eyebrow">{messages.configure.step}</p>
          <h1>{messages.configure.title}</h1>
          <p>{messages.configure.description}</p>
        </div>
        <article className="file-card file-card--compact">
          <div className="file-card__icon" aria-hidden="true">
            PDF
          </div>
          <div>
            <strong>
              {file.name ?? messages.upload.fileName(file.ordinal + 1, fileExtension(file.kind))}
            </strong>
            <span>
              {messages.upload.fileMeta(
                file.pageCount,
                formatFileSize(file.sizeBytes, numberLocale, messages.units.megabytes)
              )}
            </span>
          </div>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              dispatch({ type: "FILE_REMOVED", fileId: file.id });
              void navigate("/upload");
            }}
          >
            {messages.configure.remove}
          </button>
        </article>
      </header>

      <div className="configuration-grid">
        <section className="settings-card" aria-labelledby="settings-title">
          <h2 id="settings-title">{messages.configure.settingsTitle}</h2>
          <div className="settings-grid">
            <fieldset className="page-range-field">
              <div className="page-range-field__heading">
                <legend>{messages.configure.pages}</legend>
                <button
                  className="text-button"
                  type="button"
                  disabled={state.settings.pageStart === 1 && pageEnd === file.pageCount}
                  onClick={() => update({ pageStart: 1, pageEnd: null })}
                >
                  {messages.configure.allPages(file.pageCount)}
                </button>
              </div>
              <div className="page-range-controls">
                <PageNumberControl
                  label={messages.configure.fromPage}
                  value={state.settings.pageStart}
                  minimum={1}
                  maximum={file.pageCount}
                  decreaseLabel={messages.configure.decreaseFromPage}
                  increaseLabel={messages.configure.increaseFromPage}
                  onChange={setPageStart}
                />
                <span className="page-range-controls__separator" aria-hidden="true">
                  —
                </span>
                <PageNumberControl
                  label={messages.configure.toPage}
                  value={pageEnd}
                  minimum={1}
                  maximum={file.pageCount}
                  decreaseLabel={messages.configure.decreaseToPage}
                  increaseLabel={messages.configure.increaseToPage}
                  onChange={setPageEnd}
                />
              </div>
            </fieldset>

            <label className="field">
              <span>{messages.configure.orientation}</span>
              <select
                value={state.settings.orientation}
                onChange={(event) => update({ orientation: event.target.value as Orientation })}
              >
                <option value="PORTRAIT">{messages.configure.portrait}</option>
                <option value="LANDSCAPE">{messages.configure.landscape}</option>
              </select>
            </label>
          </div>

          <div className="settings-row">
            <fieldset className="segmented-field">
              <legend>{messages.configure.paperSides}</legend>
              <div className="segmented-control">
                <label>
                  <input
                    type="radio"
                    name="sides"
                    checked={!state.settings.duplex}
                    onChange={() => update({ duplex: false })}
                  />
                  <span>{messages.configure.singleSided}</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="sides"
                    checked={state.settings.duplex}
                    onChange={() => update({ duplex: true })}
                  />
                  <span>{messages.configure.doubleSided}</span>
                </label>
              </div>
            </fieldset>

            <div className="counter-field">
              <span>{messages.configure.copies}</span>
              <div className="counter" aria-label={messages.configure.copiesAria}>
                <button
                  type="button"
                  aria-label={messages.configure.decreaseCopies}
                  disabled={state.settings.copies <= 1}
                  onClick={() => update({ copies: state.settings.copies - 1 })}
                >
                  −
                </button>
                <output aria-live="polite">{state.settings.copies}</output>
                <button
                  type="button"
                  aria-label={messages.configure.increaseCopies}
                  disabled={state.settings.copies >= 10}
                  onClick={() => update({ copies: state.settings.copies + 1 })}
                >
                  +
                </button>
              </div>
            </div>
          </div>
        </section>

        <aside className="summary-card" aria-labelledby="summary-title">
          <div className="paper-preview" aria-hidden="true">
            <div
              className={
                state.settings.orientation === "LANDSCAPE" ? "paper paper--landscape" : "paper"
              }
            >
              <span /> <span /> <span /> <span />
            </div>
          </div>
          <h2 id="summary-title">{messages.configure.summaryTitle}</h2>
          <dl className="summary-list">
            <div>
              <dt>{messages.configure.selectedPages}</dt>
              <dd>{summary.selectedPages}</dd>
            </div>
            <div>
              <dt>{messages.configure.printedSides}</dt>
              <dd>{summary.totalSides}</dd>
            </div>
            <div>
              <dt>{messages.configure.paperSheets}</dt>
              <dd>{summary.totalSheets}</dd>
            </div>
            <div>
              <dt>{messages.configure.output}</dt>
              <dd>{messages.common.monochrome}</dd>
            </div>
          </dl>
          <div className="price-total">
            <span>{messages.configure.estimatedTotal}</span>
            <strong>{formatPrice(summary.priceCents, numberLocale)}</strong>
          </div>
          <button
            className="button button--primary button--wide"
            type="button"
            onClick={() => void navigate("/checkout")}
          >
            {messages.configure.reviewAndPay} <span aria-hidden="true">→</span>
          </button>
          <button
            className="button button--quiet button--wide"
            type="button"
            onClick={() => void navigate("/upload")}
          >
            {messages.configure.backToUpload}
          </button>
        </aside>
      </div>
    </div>
  );
}

function PageNumberControl({
  label,
  value,
  minimum,
  maximum,
  decreaseLabel,
  increaseLabel,
  onChange
}: {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  decreaseLabel: string;
  increaseLabel: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="page-number-control">
      <span>{label}</span>
      <span className="page-number-control__input">
        <button
          type="button"
          aria-label={decreaseLabel}
          disabled={value <= minimum}
          onClick={() => onChange(value - 1)}
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={minimum}
          max={maximum}
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            const nextValue = Number(event.target.value);
            if (Number.isInteger(nextValue)) onChange(nextValue);
          }}
        />
        <button
          type="button"
          aria-label={increaseLabel}
          disabled={value >= maximum}
          onClick={() => onChange(value + 1)}
        >
          +
        </button>
      </span>
    </div>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
