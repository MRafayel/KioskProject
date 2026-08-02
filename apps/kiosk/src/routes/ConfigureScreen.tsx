import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { KioskRedirect, useKioskNavigate } from "../app/router.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import type { MessageCatalog } from "../features/i18n/messages.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  fileExtension,
  formatFileSize,
  formatMinorAmount,
  isQuotePayable,
  isReadyFile,
  pageExclusionRefusal,
  pagePrintState,
  type Orientation,
  type PagePrintState,
  type PrintSettings
} from "../features/session/model.js";
import {
  readKioskPrintCapabilities,
  readKioskSessionVersion
} from "../features/session/pricingService.js";
import { usePricing } from "../features/session/usePricing.js";
import {
  deleteKioskSessionFile,
  kioskPagePreviewUrl,
  listKioskFilePages
} from "../features/session/sessionService.js";

const FALLBACK_MAX_COPIES = 20;

export function ConfigureScreen() {
  const { messages, numberLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [enlargedPage, setEnlargedPage] = useState<number | null>(null);
  const pageButtons = useRef(new Map<number, HTMLButtonElement>());
  const file = state.files[0];
  const sessionId = state.session?.id;
  const readyFile = isReadyFile(file) ? file : null;
  const pagesQuery = useQuery({
    queryKey: ["kiosk-file-pages", sessionId, readyFile?.id, readyFile?.processingRevision ?? null],
    queryFn: () => {
      if (!sessionId || !readyFile) throw new Error("READY_FILE_REQUIRED");
      return listKioskFilePages(sessionId, readyFile.id);
    },
    enabled: Boolean(sessionId && readyFile),
    staleTime: 30_000,
    retry: false
  });

  const capabilitiesQuery = useQuery({
    queryKey: ["kiosk-print-capabilities", sessionId],
    queryFn: () => {
      if (!sessionId) throw new Error("SESSION_REQUIRED");
      return readKioskPrintCapabilities(sessionId);
    },
    enabled: Boolean(sessionId),
    staleTime: 300_000,
    retry: false
  });

  useEffect(() => {
    if (!capabilitiesQuery.data) return;
    dispatch({ type: "CAPABILITIES_LOADED", capabilities: capabilitiesQuery.data });
  }, [capabilitiesQuery.data, dispatch]);

  // Validating a document advances the session by itself, so the version the
  // kiosk has held since it created the session is already behind. Reading the
  // authoritative one here spares the first save a refused round-trip; the
  // retry inside the save remains the correctness guarantee.
  const sessionVersionQuery = useQuery({
    queryKey: ["kiosk-session-version", sessionId],
    queryFn: () => {
      if (!sessionId) throw new Error("SESSION_REQUIRED");
      return readKioskSessionVersion(sessionId);
    },
    enabled: Boolean(sessionId),
    staleTime: 30_000,
    retry: false
  });

  useEffect(() => {
    if (sessionVersionQuery.data === undefined) return;
    dispatch({ type: "SESSION_VERSION_OBSERVED", version: sessionVersionQuery.data });
  }, [dispatch, sessionVersionQuery.data]);

  // A reprocessed or replaced document renumbers the pages underneath the
  // enlarged view, so it closes rather than keeping a page from the old one.
  const previewKey = readyFile ? `${readyFile.id}:${readyFile.processingRevision}` : null;
  useEffect(() => {
    setEnlargedPage(null);
  }, [previewKey]);

  // Closing hands the touch back to the page that was tapped, so the customer
  // returns to where they were in a preview strip that may be scrolled well
  // past its first page.
  const closeEnlarged = useCallback((pageNumber: number) => {
    pageButtons.current.get(pageNumber)?.focus();
    setEnlargedPage(null);
  }, []);

  useEffect(() => {
    if (enlargedPage === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEnlarged(enlargedPage);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeEnlarged, enlargedPage]);

  const pricing = usePricing({
    sessionId: sessionId ?? null,
    sessionVersion: state.session?.version ?? 1,
    file: readyFile,
    settings: state.settings,
    pricing: state.pricing,
    dispatch
  });

  if (!readyFile || !sessionId) return <KioskRedirect to="/upload" />;

  const capabilities = state.capabilities;
  const duplexAvailable =
    capabilities === null || capabilities.duplexModes.some((mode) => mode !== "SIMPLEX");
  const maxCopies = capabilities?.maxCopies ?? FALLBACK_MAX_COPIES;
  const localSummary = calculatePrintSummary(state.files, state.settings);
  const priced = state.pricing.settings;
  const quote = state.pricing.quote;
  const payable = isQuotePayable(quote, new Date());
  // Server counts win whenever they exist; the local arithmetic only fills the
  // moment between a touch and the control plane's answer.
  const summary = priced
    ? {
        selectedPages: priced.selectedPages,
        totalSides: priced.printedSides,
        totalSheets: priced.physicalSheets
      }
    : {
        selectedPages: localSummary.selectedPages,
        totalSides: localSummary.totalSides,
        totalSheets: localSummary.totalSheets
      };
  const update = (settings: Partial<PrintSettings>) =>
    dispatch({ type: "SETTINGS_CHANGED", settings });
  const pageEnd = state.settings.pageEnd ?? readyFile.pageCount;

  const setPageStart = (value: number) => {
    const nextPage = clamp(value, 1, readyFile.pageCount);
    const nextEnd = Math.max(pageEnd, nextPage);
    update({
      pageStart: nextPage,
      pageEnd: nextEnd === readyFile.pageCount ? null : nextEnd
    });
  };

  const setPageEnd = (value: number) => {
    const nextPage = clamp(value, 1, readyFile.pageCount);
    update({
      pageStart: Math.min(state.settings.pageStart, nextPage),
      pageEnd: nextPage === readyFile.pageCount ? null : nextPage
    });
  };

  const removeFile = async () => {
    if (removing) return;
    setRemoving(true);
    setRemoveFailed(false);
    try {
      await deleteKioskSessionFile(sessionId, readyFile.id);
      await queryClient.invalidateQueries({
        queryKey: ["kiosk-session-files", sessionId],
        exact: true
      });
      void navigate("/upload");
    } catch {
      // Keep the authoritative file and settings on screen. The stable
      // idempotency key is retained so the customer can safely retry.
      setRemoveFailed(true);
    } finally {
      setRemoving(false);
    }
  };

  const preview =
    pagesQuery.data?.fileId === readyFile.id &&
    pagesQuery.data.processingRevision === readyFile.processingRevision &&
    pagesQuery.data.pageCount === readyFile.pageCount
      ? pagesQuery.data
      : null;

  const pageState = (pageNumber: number) =>
    pagePrintState(state.settings, readyFile.pageCount, pageNumber);
  const excludedCount = state.settings.excludedPages.filter(
    (page) => pageState(page) === "EXCLUDED"
  ).length;

  const choosePage = (pageNumber: number, excluded: boolean) => {
    dispatch({ type: "PAGE_EXCLUSION_CHANGED", pageNumber, excluded });
    closeEnlarged(pageNumber);
  };

  // The enlarged view only ever shows a page the authoritative preview still
  // lists, so a document that changed underneath it closes it instead.
  const enlarged = preview?.items.find((page) => page.pageNumber === enlargedPage) ?? null;
  const enlargedState = enlarged ? pageState(enlarged.pageNumber) : null;
  const enlargedRefusal =
    enlarged && enlargedState === "PRINTED"
      ? pageExclusionRefusal(state.settings, readyFile.pageCount, enlarged.pageNumber)
      : null;
  const enlargedNotice =
    enlargedState === "OUT_OF_RANGE"
      ? messages.configure.previewSkippedNotice(localSummary.pageStart, localSummary.pageEnd)
      : enlargedState === "EXCLUDED"
        ? messages.configure.previewExcludedNotice
        : enlargedRefusal === "LAST_SELECTED_PAGE"
          ? messages.configure.previewLastPageNotice
          : enlargedRefusal === "SELECTION_TOO_COMPLEX"
            ? messages.configure.previewTooComplexNotice
            : messages.configure.previewPrintedNotice;

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
            {readyFile.kind ?? "FILE"}
          </div>
          <div>
            <strong>
              {readyFile.name ??
                messages.upload.fileName(readyFile.ordinal + 1, fileExtension(readyFile.kind))}
            </strong>
            <span>
              {messages.upload.fileMeta(
                readyFile.pageCount,
                formatFileSize(readyFile.sizeBytes, numberLocale, messages.units.megabytes)
              )}
            </span>
          </div>
          <button
            className="text-button"
            type="button"
            disabled={removing}
            onClick={() => void removeFile()}
          >
            {removing ? messages.configure.removing : messages.configure.remove}
          </button>
        </article>
      </header>
      {removeFailed ? (
        <p className="configuration-error" role="alert">
          {messages.configure.removeFailed}
        </p>
      ) : null}

      <div className="configuration-grid">
        <section className="settings-card" aria-labelledby="settings-title">
          <section className="document-preview" aria-labelledby="preview-title">
            <h2 id="preview-title">{messages.configure.previewTitle}</h2>
            {pagesQuery.isPending ? (
              <p className="document-preview__status" role="status">
                {messages.configure.previewLoading}
              </p>
            ) : pagesQuery.isError || !preview ? (
              <p className="document-preview__status document-preview__status--error" role="alert">
                {messages.configure.previewUnavailable}
              </p>
            ) : (
              <>
                <p className="document-preview__hint">{messages.configure.previewHint}</p>
                <div className="document-preview__grid">
                  {preview.items.map((page) => {
                    const printState = pageState(page.pageNumber);
                    return (
                      <button
                        className={pageClassName(printState)}
                        key={page.pageNumber}
                        type="button"
                        aria-label={pageLabel(messages.configure, printState, page.pageNumber)}
                        ref={(node) => {
                          if (node) pageButtons.current.set(page.pageNumber, node);
                          else pageButtons.current.delete(page.pageNumber);
                        }}
                        onClick={() => setEnlargedPage(page.pageNumber)}
                      >
                        <span className="document-preview__thumb">
                          {page.previewAvailable ? (
                            <img
                              alt={messages.configure.previewPage(page.pageNumber)}
                              decoding="async"
                              height={page.heightPixels}
                              loading="lazy"
                              src={kioskPagePreviewUrl(
                                sessionId,
                                readyFile.id,
                                page.pageNumber,
                                readyFile.processingRevision
                              )}
                              width={page.widthPixels}
                            />
                          ) : (
                            <span className="document-preview__missing" aria-hidden="true" />
                          )}
                          {printState === "PRINTED" ? null : (
                            <span className="document-preview__badge" aria-hidden="true">
                              {printState === "EXCLUDED"
                                ? messages.configure.previewExcludedBadge
                                : messages.configure.previewSkippedBadge}
                            </span>
                          )}
                        </span>
                        <span className="document-preview__caption" aria-hidden="true">
                          {messages.configure.previewPage(page.pageNumber)}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {excludedCount > 0 ? (
                  <p className="document-preview__excluded-note" role="status">
                    {messages.configure.previewExcludedCount(excludedCount)}
                  </p>
                ) : null}
              </>
            )}
          </section>

          <h2 id="settings-title">{messages.configure.settingsTitle}</h2>
          <div className="settings-grid">
            <fieldset className="page-range-field">
              <div className="page-range-field__heading">
                <legend>{messages.configure.pages}</legend>
                <button
                  className="text-button"
                  type="button"
                  disabled={
                    state.settings.pageStart === 1 &&
                    pageEnd === readyFile.pageCount &&
                    state.settings.excludedPages.length === 0
                  }
                  onClick={() => update({ pageStart: 1, pageEnd: null, excludedPages: [] })}
                >
                  {messages.configure.allPages(readyFile.pageCount)}
                </button>
              </div>
              <div className="page-range-controls">
                <PageNumberControl
                  label={messages.configure.fromPage}
                  value={state.settings.pageStart}
                  minimum={1}
                  maximum={readyFile.pageCount}
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
                  maximum={readyFile.pageCount}
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
                    disabled={!duplexAvailable}
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
                  disabled={state.settings.copies >= maxCopies}
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
            <span>{messages.configure.total}</span>
            <strong aria-live="polite">
              {payable && quote
                ? formatMinorAmount(
                    quote.totalMinor,
                    quote.currency,
                    quote.currencyExponent,
                    numberLocale
                  )
                : messages.configure.priceCalculating}
            </strong>
          </div>
          {state.pricing.status === "FAILED" ? (
            <p className="configuration-error" role="alert">
              {messages.configure.priceUnavailable}{" "}
              <button className="text-button" type="button" onClick={pricing.retry}>
                {messages.configure.priceRetry}
              </button>
            </p>
          ) : null}
          <button
            className="button button--primary button--wide"
            type="button"
            disabled={!payable}
            onClick={() => void navigate("/checkout")}
          >
            {messages.configure.reviewAndPay} <span aria-hidden="true">→</span>
          </button>
          {payable ? null : (
            <p className="upload-panel__pending" role="status">
              {state.pricing.status === "FAILED"
                ? messages.configure.priceUnavailableHelp
                : messages.configure.priceCalculatingHelp}
            </p>
          )}
          <button
            className="button button--quiet button--wide"
            type="button"
            onClick={() => void navigate("/upload")}
          >
            {messages.configure.backToUpload}
          </button>
        </aside>
      </div>

      {enlarged ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeEnlarged(enlarged.pageNumber);
          }}
        >
          <section
            className="modal modal--page"
            role="dialog"
            aria-modal="true"
            aria-labelledby="page-preview-title"
          >
            <button
              className="page-preview__close"
              type="button"
              aria-label={messages.configure.previewClose}
              onClick={() => closeEnlarged(enlarged.pageNumber)}
              autoFocus
            >
              <span aria-hidden="true">×</span>
            </button>
            <h2 id="page-preview-title">{messages.configure.previewPage(enlarged.pageNumber)}</h2>
            <div className={pagePreviewClassName(enlargedState)}>
              {enlarged.previewAvailable ? (
                <img
                  alt={messages.configure.previewPage(enlarged.pageNumber)}
                  decoding="async"
                  height={enlarged.heightPixels}
                  src={kioskPagePreviewUrl(
                    sessionId,
                    readyFile.id,
                    enlarged.pageNumber,
                    readyFile.processingRevision
                  )}
                  width={enlarged.widthPixels}
                />
              ) : (
                <p
                  className="document-preview__status document-preview__status--error"
                  role="alert"
                >
                  {messages.configure.previewUnavailable}
                </p>
              )}
            </div>
            <p
              className={
                enlargedState === "EXCLUDED"
                  ? "page-preview__notice page-preview__notice--excluded"
                  : "page-preview__notice"
              }
            >
              {enlargedNotice}
            </p>
            {/* Only the answer that would change something: the line above
                states where the page stands, so the button is the way out of
                that state rather than a choice between one live option and one
                that does nothing. A page the range already leaves out has no
                answer to give, so it gets no button at all. */}
            {enlargedState === "PRINTED" ? (
              <div className="button-row">
                <button
                  className="button button--danger"
                  type="button"
                  disabled={enlargedRefusal !== null}
                  onClick={() => choosePage(enlarged.pageNumber, true)}
                >
                  {messages.configure.previewDontPrint}
                </button>
              </div>
            ) : enlargedState === "EXCLUDED" ? (
              <div className="button-row">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => choosePage(enlarged.pageNumber, false)}
                >
                  {messages.configure.previewPrint}
                </button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function pageClassName(printState: PagePrintState): string {
  if (printState === "EXCLUDED") return "document-preview__page document-preview__page--excluded";
  if (printState === "OUT_OF_RANGE") {
    return "document-preview__page document-preview__page--skipped";
  }
  return "document-preview__page";
}

function pagePreviewClassName(printState: PagePrintState | null): string {
  if (printState === "EXCLUDED") return "page-preview page-preview--excluded";
  if (printState === "OUT_OF_RANGE") return "page-preview page-preview--skipped";
  return "page-preview";
}

function pageLabel(
  configure: MessageCatalog["configure"],
  printState: PagePrintState,
  pageNumber: number
): string {
  if (printState === "EXCLUDED") return configure.previewExcludedPage(pageNumber);
  if (printState === "OUT_OF_RANGE") return configure.previewSkippedPage(pageNumber);
  return configure.previewPage(pageNumber);
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
