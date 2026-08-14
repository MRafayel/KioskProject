import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { KioskRedirect, useKioskNavigate } from "../app/router.js";
import { DocumentCard, pageButtonKey, type EnlargedPage } from "../components/DocumentCard.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  calculatePrintSummary,
  fileExtension,
  fileSelection,
  formatMinorAmount,
  isQuotePayable,
  pageExclusionRefusal,
  pagePrintState,
  pageRangeBounds,
  readyFiles,
  type FileSelection,
  type PagePrintState,
  type ReadyPrototypeFile
} from "../features/session/model.js";
import {
  readKioskPrintCapabilities,
  readKioskSessionVersion
} from "../features/session/pricingService.js";
import { usePricing } from "../features/session/usePricing.js";
import { deleteKioskSessionFile, kioskPagePreviewUrl } from "../features/session/sessionService.js";

const FALLBACK_MAX_COPIES = 20;

export function ConfigureScreen() {
  const { messages, numberLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();
  const queryClient = useQueryClient();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [enlarged, setEnlarged] = useState<EnlargedPage | null>(null);
  const pageButtons = useRef(new Map<string, HTMLButtonElement>());
  const sessionId = state.session?.id;

  // Print order is upload order, and it is the order the control plane is told
  // about, so the screen shows the documents in the order they will print.
  const documents = readyFiles(state.files);

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

  // A reprocessed, replaced or removed document renumbers the pages underneath
  // the enlarged view, so it closes rather than keeping a page from the old one.
  const documentKey = documents
    .map((file) => `${file.id}:${file.processingRevision}:${file.pageCount}`)
    .join("|");
  useEffect(() => {
    setEnlarged(null);
  }, [documentKey]);

  // Closing hands the touch back to the page that was tapped, so the customer
  // returns to where they were in a preview strip that may be scrolled well
  // past its first page — and, with several documents, well down the screen.
  const closeEnlarged = useCallback(() => {
    setEnlarged((current) => {
      if (current) {
        pageButtons.current.get(pageButtonKey(current.file.id, current.page.pageNumber))?.focus();
      }
      return null;
    });
  }, []);

  const registerPageButton = useCallback((key: string, node: HTMLButtonElement | null) => {
    if (node) pageButtons.current.set(key, node);
    else pageButtons.current.delete(key);
  }, []);

  useEffect(() => {
    if (!enlarged) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEnlarged();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeEnlarged, enlarged]);

  const pricing = usePricing({
    sessionId: sessionId ?? null,
    sessionVersion: state.session?.version ?? 1,
    files: documents,
    settings: state.settings,
    pricing: state.pricing,
    dispatch
  });

  if (documents.length === 0 || !sessionId) return <KioskRedirect to="/upload" />;

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
  const removeFile = async (file: ReadyPrototypeFile) => {
    if (removingId) return;
    setRemovingId(file.id);
    setRemoveFailed(false);
    try {
      await deleteKioskSessionFile(sessionId, file.id);
      dispatch({ type: "FILE_REMOVED", fileId: file.id });
      await queryClient.invalidateQueries({
        queryKey: ["kiosk-session-files", sessionId],
        exact: true
      });
      // Removing the last document leaves nothing to configure, so the customer
      // goes back to add one rather than sitting on an empty screen. With
      // documents left the screen simply reprices what remains.
      if (documents.length <= 1) void navigate("/upload");
    } catch {
      // Keep the authoritative file and settings on screen. The stable
      // idempotency key is retained so the customer can safely retry.
      setRemoveFailed(true);
    } finally {
      setRemovingId(null);
    }
  };

  const enlargedSelection = enlarged ? fileSelection(state.settings, enlarged.file.id) : null;
  const enlargedState =
    enlarged && enlargedSelection
      ? pagePrintState(enlargedSelection, enlarged.file.pageCount, enlarged.page.pageNumber)
      : null;
  const enlargedRefusal =
    enlarged && enlargedSelection && enlargedState === "PRINTED"
      ? pageExclusionRefusal(enlargedSelection, enlarged.file.pageCount, enlarged.page.pageNumber)
      : null;
  // The range the customer set for this document, resolved against its own page
  // count, so the notice names the pages that are actually printing.
  const enlargedBounds =
    enlarged && enlargedSelection
      ? pageRangeBounds(enlargedSelection, enlarged.file.pageCount)
      : null;
  const enlargedNotice =
    enlargedState === "OUT_OF_RANGE" && enlargedBounds
      ? messages.configure.previewSkippedNotice(enlargedBounds.pageStart, enlargedBounds.pageEnd)
      : enlargedState === "EXCLUDED"
        ? messages.configure.previewExcludedNotice
        : enlargedRefusal === "LAST_SELECTED_PAGE"
          ? messages.configure.previewLastPageNotice
          : enlargedRefusal === "SELECTION_TOO_COMPLEX"
            ? messages.configure.previewTooComplexNotice
            : messages.configure.previewPrintedNotice;

  const choosePage = (excludedPage: boolean) => {
    if (!enlarged) return;
    dispatch({
      type: "PAGE_EXCLUSION_CHANGED",
      fileId: enlarged.file.id,
      pageNumber: enlarged.page.pageNumber,
      excluded: excludedPage
    });
    closeEnlarged();
  };

  const enlargedName = enlarged
    ? (enlarged.file.name ??
      messages.upload.fileName(enlarged.file.ordinal + 1, fileExtension(enlarged.file.kind)))
    : "";

  return (
    <div className="configuration-page">
      <header className="screen-heading">
        <div>
          <p className="eyebrow">{messages.configure.step}</p>
          <h1>{messages.configure.title}</h1>
          <p>
            {documents.length > 1
              ? messages.configure.descriptionMany(documents.length)
              : messages.configure.description}
          </p>
        </div>
        <button
          className="button button--quiet"
          type="button"
          onClick={() => void navigate("/upload")}
        >
          {messages.configure.addDocument}
        </button>
      </header>
      {removeFailed ? (
        <p className="configuration-error" role="alert">
          {messages.configure.removeFailed}
        </p>
      ) : null}

      <div className="configuration-grid">
        <section className="settings-card" aria-labelledby="documents-title">
          <section className="document-list" aria-labelledby="documents-title">
            <h2 id="documents-title">{messages.configure.documentsTitle(documents.length)}</h2>
            <p className="document-list__hint">{messages.configure.documentsHint}</p>
            {documents.map((file, position) => (
              <DocumentCard
                key={file.id}
                file={file}
                position={position}
                total={documents.length}
                sessionId={sessionId}
                selection={fileSelection(state.settings, file.id)}
                duplexAvailable={duplexAvailable}
                maxCopies={maxCopies}
                removing={removingId === file.id}
                onSelectionChange={(selection: Partial<FileSelection>) =>
                  dispatch({ type: "FILE_SELECTION_CHANGED", fileId: file.id, selection })
                }
                onEnlarge={setEnlarged}
                onRegisterPage={registerPageButton}
                onRemove={() => void removeFile(file)}
              />
            ))}
          </section>
        </section>

        <aside className="summary-card" aria-labelledby="summary-title">
          <div className="paper-preview" aria-hidden="true">
            {/* The first document's orientation. Each document sets its own,
                so this is an illustration of the job's first sheet rather than
                a statement about all of them. */}
            <div
              className={
                fileSelection(state.settings, documents[0]?.id ?? "").orientation === "LANDSCAPE"
                  ? "paper paper--landscape"
                  : "paper"
              }
            >
              <span /> <span /> <span /> <span />
            </div>
          </div>
          <h2 id="summary-title">{messages.configure.summaryTitle}</h2>
          <dl className="summary-list">
            <div>
              <dt>{messages.configure.documents}</dt>
              <dd>{documents.length}</dd>
            </div>
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
            if (event.target === event.currentTarget) closeEnlarged();
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
              onClick={closeEnlarged}
              autoFocus
            >
              <span aria-hidden="true">×</span>
            </button>
            <h2 id="page-preview-title">
              {messages.configure.previewPage(enlarged.page.pageNumber)}
            </h2>
            {/* Which document this page belongs to. With several on screen the
                page number alone does not say. */}
            <p className="page-preview__document">{enlargedName}</p>
            <div className={pagePreviewClassName(enlargedState)}>
              {enlarged.page.previewAvailable ? (
                <img
                  alt={messages.configure.previewPage(enlarged.page.pageNumber)}
                  decoding="async"
                  height={enlarged.page.heightPixels}
                  src={kioskPagePreviewUrl(
                    sessionId,
                    enlarged.file.id,
                    enlarged.page.pageNumber,
                    enlarged.file.processingRevision
                  )}
                  width={enlarged.page.widthPixels}
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
                  onClick={() => choosePage(true)}
                >
                  {messages.configure.previewDontPrint}
                </button>
              </div>
            ) : enlargedState === "EXCLUDED" ? (
              <div className="button-row">
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => choosePage(false)}
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

function pagePreviewClassName(printState: PagePrintState | null): string {
  if (printState === "EXCLUDED") return "page-preview page-preview--excluded";
  if (printState === "OUT_OF_RANGE") return "page-preview page-preview--skipped";
  return "page-preview";
}
