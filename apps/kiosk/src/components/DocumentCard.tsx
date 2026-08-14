import { useQuery } from "@tanstack/react-query";

import type { FilePage } from "@printing-kiosk/contracts";

import { useLanguage } from "../features/i18n/LanguageProvider.js";
import type { MessageCatalog } from "../features/i18n/messages.js";
import {
  fileExtension,
  formatFileSize,
  pageRangeBounds,
  pagePrintState,
  selectedPageRanges,
  countPagesInRanges,
  type FileSelection,
  type Orientation,
  type PagePrintState,
  type ReadyPrototypeFile
} from "../features/session/model.js";
import { kioskPagePreviewUrl, listKioskFilePages } from "../features/session/sessionService.js";

/**
 * A page the customer tapped, carried with the document it came from so the
 * enlarged view can be owned by the screen while the previews stay per card.
 */
export interface EnlargedPage {
  file: ReadyPrototypeFile;
  page: FilePage;
}

/** Page buttons are pooled across documents, so the key carries both. */
export function pageButtonKey(fileId: string, pageNumber: number): string {
  return `${fileId}:${pageNumber}`;
}

/**
 * One document and the settings that belong to it.
 *
 * Page selection is per document, so the controls that change it live inside
 * the document's own card rather than in the shared settings below: a range
 * means nothing without the document it counts pages in, and a customer with
 * several documents on screen has to be able to see which one a range applies
 * to without reading a label twice.
 *
 * Each card runs its own preview query. That keeps one slow or failed document
 * from blanking the previews of the others, and it means adding a document
 * costs exactly one more request rather than re-fetching the whole set.
 */
export function DocumentCard({
  file,
  position,
  total,
  sessionId,
  selection,
  duplexAvailable,
  maxCopies,
  removing,
  onSelectionChange,
  onEnlarge,
  onRegisterPage,
  onRemove
}: {
  file: ReadyPrototypeFile;
  position: number;
  total: number;
  sessionId: string;
  selection: FileSelection;
  /** What the device can do. Every document is offered the same choices. */
  duplexAvailable: boolean;
  maxCopies: number;
  removing: boolean;
  onSelectionChange: (selection: Partial<FileSelection>) => void;
  onEnlarge: (enlarged: EnlargedPage) => void;
  /**
   * Hands each page button to the screen. The enlarged view is owned there —
   * one dialog for the whole job — so closing it can only return the touch to
   * the page it came from if the screen can reach that button.
   */
  onRegisterPage: (key: string, node: HTMLButtonElement | null) => void;
  onRemove: () => void;
}) {
  const { messages, numberLocale } = useLanguage();

  const pagesQuery = useQuery({
    queryKey: ["kiosk-file-pages", sessionId, file.id, file.processingRevision],
    queryFn: () => listKioskFilePages(sessionId, file.id),
    staleTime: 30_000,
    retry: false
  });

  const preview =
    pagesQuery.data?.fileId === file.id &&
    pagesQuery.data.processingRevision === file.processingRevision &&
    pagesQuery.data.pageCount === file.pageCount
      ? pagesQuery.data
      : null;

  const bounds = pageRangeBounds(selection, file.pageCount);
  const pageEnd = selection.pageEnd ?? file.pageCount;
  const selectedPages = countPagesInRanges(selectedPageRanges(selection, file.pageCount));
  const pageState = (pageNumber: number) => pagePrintState(selection, file.pageCount, pageNumber);
  const excludedCount = selection.excludedPages.filter(
    (page) => pageState(page) === "EXCLUDED"
  ).length;
  const wholeDocument =
    selection.pageStart === 1 && pageEnd === file.pageCount && selection.excludedPages.length === 0;

  const setPageStart = (value: number) => {
    const nextPage = clamp(value, 1, file.pageCount);
    const nextEnd = Math.max(pageEnd, nextPage);
    onSelectionChange({
      pageStart: nextPage,
      pageEnd: nextEnd === file.pageCount ? null : nextEnd
    });
  };

  const setPageEnd = (value: number) => {
    const nextPage = clamp(value, 1, file.pageCount);
    onSelectionChange({
      pageStart: Math.min(selection.pageStart, nextPage),
      pageEnd: nextPage === file.pageCount ? null : nextPage
    });
  };

  const name = file.name ?? messages.upload.fileName(file.ordinal + 1, fileExtension(file.kind));

  return (
    <article className="document-card" aria-label={messages.configure.documentLabel(name)}>
      <header className="document-card__heading">
        {/* The same kind badge the upload screen shows, so a document is
            recognisable by the same mark everywhere it appears. */}
        <div className="file-card__icon" aria-hidden="true">
          {file.kind ?? "FILE"}
        </div>
        <div className="document-card__identity">
          <strong>{name}</strong>
          <span>
            {messages.configure.documentPosition(position + 1, total)} ·{" "}
            {messages.upload.fileMeta(
              file.pageCount,
              formatFileSize(file.sizeBytes, numberLocale, messages.units.megabytes)
            )}
          </span>
        </div>
        <button
          className="text-button"
          type="button"
          disabled={removing}
          aria-label={messages.configure.removeDocument(name)}
          onClick={onRemove}
        >
          {removing ? messages.configure.removing : messages.configure.remove}
        </button>
      </header>

      <div className="document-card__preview">
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
                    ref={(node) => onRegisterPage(pageButtonKey(file.id, page.pageNumber), node)}
                    onClick={() => onEnlarge({ file, page })}
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
                            file.id,
                            page.pageNumber,
                            file.processingRevision
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
      </div>

      <fieldset className="page-range-field">
        <div className="page-range-field__heading">
          <legend>{messages.configure.pages}</legend>
          <button
            className="text-button"
            type="button"
            disabled={wholeDocument}
            onClick={() => onSelectionChange({ pageStart: 1, pageEnd: null, excludedPages: [] })}
          >
            {messages.configure.allPages(file.pageCount)}
          </button>
        </div>
        <div className="page-range-controls">
          <PageNumberControl
            label={messages.configure.fromPage}
            value={bounds.pageStart}
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
        <p className="document-card__selected" aria-live="polite">
          {messages.configure.documentSelectedPages(selectedPages, file.pageCount)}
        </p>
      </fieldset>

      {/* Orientation, sides and copies belong to this document, so they sit
          inside its card next to the pages they apply to. Nothing here is
          shared with the other documents in the job. */}
      <div className="settings-grid">
        <label className="field">
          <span>{messages.configure.orientation}</span>
          <select
            value={selection.orientation}
            onChange={(event) =>
              onSelectionChange({ orientation: event.target.value as Orientation })
            }
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
                name={`sides-${file.id}`}
                checked={!selection.duplex}
                onChange={() => onSelectionChange({ duplex: false })}
              />
              <span>{messages.configure.singleSided}</span>
            </label>
            <label>
              <input
                type="radio"
                name={`sides-${file.id}`}
                checked={selection.duplex}
                disabled={!duplexAvailable}
                onChange={() => onSelectionChange({ duplex: true })}
              />
              <span>{messages.configure.doubleSided}</span>
            </label>
          </div>
        </fieldset>

        <div className="counter-field">
          <span>{messages.configure.copies}</span>
          <div className="counter" aria-label={messages.configure.copiesAriaFor(name)}>
            <button
              type="button"
              aria-label={messages.configure.decreaseCopiesFor(name)}
              disabled={selection.copies <= 1}
              onClick={() => onSelectionChange({ copies: selection.copies - 1 })}
            >
              −
            </button>
            <output aria-live="polite">{selection.copies}</output>
            <button
              type="button"
              aria-label={messages.configure.increaseCopiesFor(name)}
              disabled={selection.copies >= maxCopies}
              onClick={() => onSelectionChange({ copies: selection.copies + 1 })}
            >
              +
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export function pageClassName(printState: PagePrintState): string {
  if (printState === "EXCLUDED") return "document-preview__page document-preview__page--excluded";
  if (printState === "OUT_OF_RANGE") {
    return "document-preview__page document-preview__page--skipped";
  }
  return "document-preview__page";
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
