import { Navigate, useNavigate } from "react-router-dom";

import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  formatFileSize,
  formatPrice,
  type Orientation,
  type PageRange,
  type PaperSize
} from "../features/session/model.js";

export function ConfigureScreen() {
  const { state, dispatch } = usePrototypeSession();
  const navigate = useNavigate();
  const file = state.files[0];

  if (!file) return <Navigate to="/upload" replace />;

  const summary = calculatePrintSummary(state.files, state.settings);
  const update = (settings: Parameters<typeof dispatch>[0] & { type: "SETTINGS_CHANGED" }) =>
    dispatch(settings);

  return (
    <div className="configuration-page">
      <header className="screen-heading">
        <div>
          <p className="eyebrow">Step 2 of 4</p>
          <h1>Choose print settings</h1>
          <p>Review each option before payment. Output is monochrome.</p>
        </div>
        <article className="file-card file-card--compact">
          <div className="file-card__icon" aria-hidden="true">
            PDF
          </div>
          <div>
            <strong>{file.name}</strong>
            <span>
              {file.pageCount} pages · {formatFileSize(file.sizeBytes)}
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
            Remove
          </button>
        </article>
      </header>

      <div className="configuration-grid">
        <section className="settings-card" aria-labelledby="settings-title">
          <h2 id="settings-title">Document settings</h2>
          <div className="settings-grid">
            <label className="field">
              <span>Pages</span>
              <select
                value={state.settings.pageRange}
                onChange={(event) =>
                  update({
                    type: "SETTINGS_CHANGED",
                    settings: { pageRange: event.target.value as PageRange }
                  })
                }
              >
                <option value="ALL">All pages (1–{file.pageCount})</option>
                <option value="FIRST_FOUR">Pages 1–4</option>
              </select>
            </label>

            <label className="field">
              <span>Paper size</span>
              <select
                value={state.settings.paperSize}
                onChange={(event) =>
                  update({
                    type: "SETTINGS_CHANGED",
                    settings: { paperSize: event.target.value as PaperSize }
                  })
                }
              >
                <option value="A4">A4</option>
                <option value="LETTER">US Letter</option>
              </select>
            </label>

            <label className="field">
              <span>Orientation</span>
              <select
                value={state.settings.orientation}
                onChange={(event) =>
                  update({
                    type: "SETTINGS_CHANGED",
                    settings: { orientation: event.target.value as Orientation }
                  })
                }
              >
                <option value="PORTRAIT">Portrait</option>
                <option value="LANDSCAPE">Landscape</option>
              </select>
            </label>

            <label className="field">
              <span>Pages per side</span>
              <select
                value={state.settings.pagesPerSheet}
                onChange={(event) =>
                  update({
                    type: "SETTINGS_CHANGED",
                    settings: { pagesPerSheet: Number(event.target.value) as 1 | 2 }
                  })
                }
              >
                <option value={1}>1 page</option>
                <option value={2}>2 pages</option>
              </select>
            </label>
          </div>

          <div className="settings-row">
            <fieldset className="segmented-field">
              <legend>Paper sides</legend>
              <div className="segmented-control">
                <label>
                  <input
                    type="radio"
                    name="sides"
                    checked={!state.settings.duplex}
                    onChange={() =>
                      update({ type: "SETTINGS_CHANGED", settings: { duplex: false } })
                    }
                  />
                  <span>Single-sided</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="sides"
                    checked={state.settings.duplex}
                    onChange={() =>
                      update({ type: "SETTINGS_CHANGED", settings: { duplex: true } })
                    }
                  />
                  <span>Double-sided</span>
                </label>
              </div>
            </fieldset>

            <div className="counter-field">
              <span>Copies</span>
              <div className="counter" aria-label="Number of copies">
                <button
                  type="button"
                  aria-label="Decrease copies"
                  disabled={state.settings.copies <= 1}
                  onClick={() =>
                    update({
                      type: "SETTINGS_CHANGED",
                      settings: { copies: state.settings.copies - 1 }
                    })
                  }
                >
                  −
                </button>
                <output aria-live="polite">{state.settings.copies}</output>
                <button
                  type="button"
                  aria-label="Increase copies"
                  disabled={state.settings.copies >= 10}
                  onClick={() =>
                    update({
                      type: "SETTINGS_CHANGED",
                      settings: { copies: state.settings.copies + 1 }
                    })
                  }
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
          <h2 id="summary-title">Print summary</h2>
          <dl className="summary-list">
            <div>
              <dt>Selected pages</dt>
              <dd>{summary.selectedPages}</dd>
            </div>
            <div>
              <dt>Printed sides</dt>
              <dd>{summary.totalSides}</dd>
            </div>
            <div>
              <dt>Paper sheets</dt>
              <dd>{summary.totalSheets}</dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>Monochrome</dd>
            </div>
          </dl>
          <div className="price-total">
            <span>Estimated total</span>
            <strong>{formatPrice(summary.priceCents)}</strong>
          </div>
          <button
            className="button button--primary button--wide"
            type="button"
            onClick={() => void navigate("/checkout")}
          >
            Review and pay <span aria-hidden="true">→</span>
          </button>
          <button
            className="button button--quiet button--wide"
            type="button"
            onClick={() => void navigate("/upload")}
          >
            Back to upload
          </button>
        </aside>
      </div>
    </div>
  );
}
