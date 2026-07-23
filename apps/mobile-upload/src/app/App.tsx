import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Route, Routes, useParams } from "react-router-dom";

import type {
  MobileContextResponse,
  UploadedFileSnapshot,
  UploadedFileStatus
} from "@printing-kiosk/contracts";

import { LanguageProvider, useLanguage } from "../features/i18n/LanguageProvider.js";
import { LanguageSelector } from "../features/i18n/LanguageSelector.js";
import { interpolate, type Locale } from "../features/i18n/messages.js";
import { MobileRequestError, type MobileBootstrapController } from "../features/join/bootstrap.js";
import { subscribeToMobileSessionEvents } from "../features/session/sessionEvents.js";
import {
  checkMobileSession,
  deleteUploadedFile,
  listUploadedFiles,
  uploadFile
} from "../features/upload/api.js";

export interface AppProps {
  bootstrap: MobileBootstrapController | null;
}

export function App({ bootstrap }: AppProps) {
  return (
    <LanguageProvider>
      <Routes>
        <Route path="/s/:publicSessionId" element={<SessionRoute bootstrap={bootstrap} />} />
        <Route path="*" element={<LinkError code="INVALID_UPLOAD_LINK" />} />
      </Routes>
    </LanguageProvider>
  );
}

function SessionRoute({ bootstrap }: AppProps) {
  const { publicSessionId } = useParams();
  const { setLocale } = useLanguage();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | Readonly<{ kind: "loading" }>
    | Readonly<{ kind: "ready"; context: MobileContextResponse }>
    | Readonly<{ kind: "error"; code: string; status: number | null }>
  >({ kind: "loading" });

  useEffect(() => {
    if (!bootstrap) {
      setState({ kind: "error", code: "INVALID_UPLOAD_LINK", status: null });
      return;
    }

    let active = true;
    setState({ kind: "loading" });
    void bootstrap.run().then(
      (context) => {
        if (!active) return;
        if (context.session.publicId !== publicSessionId) {
          setState({ kind: "error", code: "INVALID_UPLOAD_LINK", status: null });
          return;
        }
        setLocale(context.session.locale);
        setState({ kind: "ready", context });
      },
      (error: unknown) => {
        if (!active) return;
        setState({
          kind: "error",
          code: error instanceof MobileRequestError ? error.code : "REQUEST_FAILED",
          status: error instanceof MobileRequestError ? error.status : null
        });
      }
    );

    return () => {
      active = false;
    };
  }, [attempt, bootstrap, publicSessionId, setLocale]);

  if (state.kind === "loading") return <LoadingScreen />;
  if (state.kind === "error") {
    return (
      <LinkError
        code={state.code}
        status={state.status}
        onRetry={
          isRetryableBootstrapError(state.code, state.status)
            ? () => setAttempt((value) => value + 1)
            : undefined
        }
      />
    );
  }
  return <UploadScreen context={state.context} />;
}

function PageShell({ children }: { children: ReactNode }) {
  const { text } = useLanguage();
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span>
            <strong>{text.brand}</strong>
            <small>{text.brandNote}</small>
          </span>
        </div>
        <LanguageSelector />
      </header>
      {children}
      <footer className="site-footer">{text.footer}</footer>
    </div>
  );
}

function LoadingScreen() {
  const { text } = useLanguage();
  return (
    <PageShell>
      <main className="center-card" id="main" aria-live="polite" aria-busy="true">
        <span className="spinner" aria-hidden="true" />
        <h1>{text.loadingTitle}</h1>
        <p>{text.loadingText}</p>
      </main>
    </PageShell>
  );
}

function LinkError({
  code,
  status = null,
  onRetry
}: {
  code: string;
  status?: number | null;
  onRetry?: (() => void) | undefined;
}) {
  const { text } = useLanguage();
  const message = getErrorMessage(code, status, text, "bootstrap");
  return (
    <PageShell>
      <main className="center-card error-card" id="main" role="alert">
        <span className="error-symbol" aria-hidden="true">
          !
        </span>
        <h1>{text.invalidTitle}</h1>
        <p>{message}</p>
        {onRetry ? (
          <button className="primary-button center-card__action" onClick={onRetry} type="button">
            {text.retry}
          </button>
        ) : null}
      </main>
    </PageShell>
  );
}

function UploadScreen({ context }: { context: MobileContextResponse }) {
  const { locale, text } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<UploadedFileSnapshot[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [uploadSucceeded, setUploadSucceeded] = useState(false);
  const [error, setError] = useState<UploadErrorState | null>(null);
  const [sessionAvailable, setSessionAvailable] = useState(() =>
    isMobileUploadState(context.session.state)
  );
  const uploadAbortRef = useRef<AbortController | null>(null);
  const visibleFiles = files.filter((file) => file.status !== "DELETED");
  const capacityFiles = files.filter((file) =>
    ["UPLOADING", "QUARANTINED", "DELETING", "DELETE_PENDING"].includes(file.status)
  );
  const acceptsUploads = sessionAvailable && isMobileUploadState(context.session.state);
  const currentBytes = capacityFiles.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  const atFileLimit = capacityFiles.length >= context.limits.maxFiles;
  const busy = progress !== null || deletingId !== null;
  const closeSession = useCallback((requestError: unknown) => {
    const error =
      requestError instanceof MobileRequestError
        ? requestError
        : new MobileRequestError("UPLOAD_SESSION_NOT_EDITABLE", 409);
    setSessionAvailable(false);
    setUploadSucceeded(false);
    setError(null);
    if (uploadAbortRef.current && !uploadAbortRef.current.signal.aborted) {
      uploadAbortRef.current.abort(error);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void listUploadedFiles(context.session.id).then(
      (result) => {
        if (!active) return;
        setFiles(result.items);
        setLoadingFiles(false);
      },
      (requestError: unknown) => {
        if (!active) return;
        if (isTerminalMobileSessionError(requestError)) {
          closeSession(requestError);
        } else {
          setError(toRequestErrorState(requestError, "list"));
        }
        setLoadingFiles(false);
      }
    );
    return () => {
      active = false;
    };
  }, [closeSession, context.session.id]);

  useEffect(() => {
    if (!sessionAvailable) return;

    let active = true;
    let checking = false;
    let checkRequested = false;
    const verifyAuthoritativeState = () => {
      checkRequested = true;
      if (checking) return;
      checking = true;
      void (async () => {
        try {
          while (active && checkRequested) {
            checkRequested = false;
            try {
              const latest = await checkMobileSession(context.session.publicId);
              if (active && !isMobileUploadState(latest.session.state)) {
                closeSession(new MobileRequestError("UPLOAD_SESSION_NOT_EDITABLE", 409));
                return;
              }
            } catch (requestError) {
              if (active && isTerminalMobileSessionError(requestError)) {
                closeSession(requestError);
                return;
              }
            }
          }
        } finally {
          checking = false;
          // A trigger can arrive after the loop observes an empty queue but
          // before this request releases the in-flight flag.
          if (active && checkRequested) verifyAuthoritativeState();
        }
      })();
    };
    const reconciliationTimer = window.setInterval(
      verifyAuthoritativeState,
      MOBILE_SESSION_RECONCILIATION_MS
    );
    const unsubscribe = subscribeToMobileSessionEvents(
      context.session.publicId,
      context.session.id,
      {
        // Re-check after every connection so a terminal event that happened
        // between authentication and subscription cannot leave stale UI.
        onConnected: verifyAuthoritativeState,
        // EventSource reconnects automatically. A single authoritative check
        // distinguishes a revoked session from a transient network break.
        onDisconnected: verifyAuthoritativeState,
        onDesynchronized: verifyAuthoritativeState,
        onTerminal: (event) => {
          closeSession(
            new MobileRequestError(
              event.type === "session.expired"
                ? "UPLOAD_SESSION_EXPIRED"
                : "UPLOAD_SESSION_NOT_EDITABLE",
              event.type === "session.expired" ? 410 : 409
            )
          );
        }
      }
    );

    return () => {
      active = false;
      window.clearInterval(reconciliationTimer);
      unsubscribe();
    };
  }, [closeSession, context.session.id, context.session.publicId, sessionAvailable]);

  useEffect(
    () => () => {
      uploadAbortRef.current?.abort(new MobileRequestError("UPLOAD_CANCELED"));
    },
    []
  );

  async function refreshFiles(): Promise<void> {
    const result = await listUploadedFiles(context.session.id);
    setFiles(result.items);
  }

  async function onFileSelected(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || busy || !sessionAvailable) return;

    setError(null);
    setUploadSucceeded(false);
    const localError = validateLocalFile(
      file,
      context.limits.maxFileBytes,
      context.limits.maxTotalBytes - currentBytes
    );
    if (localError) {
      setError({
        kind: "message",
        key:
          localError === "EMPTY_FILE"
            ? "emptyFile"
            : localError === "FILE_TOO_LARGE"
              ? "fileTooLarge"
              : "unsupportedFile"
      });
      return;
    }
    if (atFileLimit) {
      setError({ kind: "message", key: "fileLimit" });
      return;
    }

    const uploadAbort = new AbortController();
    uploadAbortRef.current = uploadAbort;
    setProgress(0);
    try {
      const latest = await checkMobileSession(context.session.publicId);
      if (!isMobileUploadState(latest.session.state)) {
        throw new MobileRequestError("UPLOAD_SESSION_NOT_EDITABLE", 409);
      }
      uploadAbort.signal.throwIfAborted();
      await uploadFile(context.session.id, file, context.csrfToken, setProgress, {
        signal: uploadAbort.signal
      });
      await refreshFiles();
      setUploadSucceeded(true);
    } catch (requestError) {
      if (isTerminalMobileSessionError(requestError)) {
        closeSession(requestError);
      } else {
        setError(toRequestErrorState(requestError, "upload"));
        try {
          await refreshFiles();
        } catch {
          // Keep the original, more useful upload error.
        }
      }
    } finally {
      if (uploadAbortRef.current === uploadAbort) uploadAbortRef.current = null;
      setProgress(null);
    }
  }

  async function removeFile(fileId: string): Promise<void> {
    if (busy) return;
    setDeletingId(fileId);
    setError(null);
    setUploadSucceeded(false);
    try {
      await deleteUploadedFile(context.session.id, fileId, context.csrfToken);
      await refreshFiles();
    } catch (requestError) {
      if (isTerminalMobileSessionError(requestError)) {
        closeSession(requestError);
      } else {
        setError(toRequestErrorState(requestError, "delete"));
      }
    } finally {
      setDeletingId(null);
    }
  }

  const fileInputDisabled = busy || atFileLimit || !acceptsUploads;
  const expiration = formatTime(context.session.expiresAt, locale);

  return (
    <PageShell>
      <main className="upload-layout" id="main">
        <section className="intro-panel" aria-labelledby="upload-title">
          <p className="eyebrow">{text.eyebrow}</p>
          <h1 id="upload-title">{text.title}</h1>
          <p className="intro-copy">{text.intro}</p>
          <div className={`connected-pill${sessionAvailable ? "" : " connected-pill--closed"}`}>
            <span aria-hidden="true" />
            {sessionAvailable ? text.sessionReady : text.sessionClosed}
          </div>
          {sessionAvailable ? (
            <p className="session-detail">{interpolate(text.expires, { time: expiration })}</p>
          ) : (
            <p className="session-detail session-detail--closed" role="alert">
              {text.sessionUnavailable}
            </p>
          )}
          <div className="privacy-note">
            <ShieldIcon />
            <p>{text.privacy}</p>
          </div>
        </section>

        <section className="transfer-card" aria-labelledby="files-title">
          <div className="file-picker">
            <input
              accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
              aria-hidden="true"
              disabled={fileInputDisabled}
              hidden
              id="file-upload"
              onChange={(event) => void onFileSelected(event)}
              ref={inputRef}
              type="file"
            />
            <button
              className="primary-button"
              disabled={fileInputDisabled}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              <UploadIcon />
              {capacityFiles.length > 0 ? text.chooseAnother : text.chooseFile}
            </button>
            <p>
              {interpolate(text.fileHint, {
                size: formatBytes(context.limits.maxFileBytes, locale)
              })}
            </p>
          </div>

          {progress !== null ? (
            <div className="progress-panel" aria-live="polite">
              <div>
                <strong>{text.uploading}</strong>
                <span>
                  {interpolate(text.uploadProgress, { percent: Math.round(progress * 100) })}
                </span>
              </div>
              <progress
                className="progress-track"
                aria-label={text.uploading}
                max={100}
                value={Math.round(progress * 100)}
              />
            </div>
          ) : null}

          {uploadSucceeded ? (
            <p className="notice success-notice" role="status">
              {text.uploadSuccess}
            </p>
          ) : null}
          {error ? (
            <p className="notice error-notice" role="alert">
              {getUploadErrorMessage(error, text)}
            </p>
          ) : null}

          <div className="files-heading">
            <h2 id="files-title">{text.filesTitle}</h2>
            <span>{visibleFiles.length}</span>
          </div>
          {loadingFiles ? (
            <div
              className="files-loading"
              aria-label={text.loadingText}
              aria-live="polite"
              role="status"
            />
          ) : visibleFiles.length === 0 ? (
            <div className="empty-files">
              <DocumentIcon />
              <p>{text.filesEmpty}</p>
            </div>
          ) : (
            <ul className="file-list">
              {visibleFiles.map((file) => (
                <FileRow
                  file={file}
                  key={file.id}
                  locale={locale}
                  deleting={deletingId === file.id}
                  disabled={busy || !acceptsUploads}
                  onRemove={() => void removeFile(file.id)}
                />
              ))}
            </ul>
          )}
        </section>
      </main>
    </PageShell>
  );
}

function FileRow({
  file,
  locale,
  deleting,
  disabled,
  onRemove
}: {
  file: UploadedFileSnapshot;
  locale: Locale;
  deleting: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  const { text } = useLanguage();
  const number = file.ordinal + 1;
  const isDocument = file.kind === "PDF" || file.kind === null;
  const title = interpolate(isDocument ? text.document : text.image, { number });
  return (
    <li>
      <span className={`file-kind file-kind-${file.kind?.toLowerCase() ?? "unknown"}`}>
        {file.kind ?? "FILE"}
      </span>
      <span className="file-details">
        <strong>{title}</strong>
        <small>
          {statusLabel(file.status, text)}
          {file.sizeBytes
            ? ` · ${interpolate(text.fileSize, { size: formatBytes(file.sizeBytes, locale) })}`
            : ""}
        </small>
      </span>
      <button disabled={disabled} onClick={onRemove} type="button">
        {deleting ? text.removing : text.remove}
      </button>
    </li>
  );
}

function statusLabel(
  status: UploadedFileStatus,
  text: ReturnType<typeof useLanguage>["text"]
): string {
  const labels: Record<UploadedFileStatus, string> = {
    UPLOADING: text.statusUploading,
    QUARANTINED: text.statusQuarantined,
    REJECTED: text.statusRejected,
    DELETING: text.statusDeleting,
    DELETE_PENDING: text.statusDeleting,
    DELETED: text.statusDeleted
  };
  return labels[status];
}

function validateLocalFile(
  file: File,
  maxFileBytes: number,
  remainingBytes: number
): string | null {
  if (file.size <= 0) return "EMPTY_FILE";
  if (file.size > maxFileBytes || file.size > remainingBytes) {
    return "FILE_TOO_LARGE";
  }

  const extension = file.name.toLowerCase().split(".").pop();
  const allowed =
    (file.type === "application/pdf" && extension === "pdf") ||
    (file.type === "image/jpeg" && (extension === "jpg" || extension === "jpeg")) ||
    (file.type === "image/png" && extension === "png");
  return allowed ? null : "UNSUPPORTED_FILE_TYPE";
}

function isMobileUploadState(state: string): boolean {
  return state === "WAITING_FOR_UPLOAD" || state === "FILES_UPLOADED";
}

function isTerminalMobileSessionError(error: unknown): boolean {
  if (!(error instanceof MobileRequestError)) return false;
  return TERMINAL_MOBILE_SESSION_CODES.has(error.code);
}

const TERMINAL_MOBILE_SESSION_CODES = new Set([
  "INVALID_MOBILE_SESSION",
  "SESSION_NOT_FOUND",
  "UPLOAD_SESSION_EXPIRED",
  "UPLOAD_SESSION_NOT_EDITABLE"
]);
const MOBILE_SESSION_RECONCILIATION_MS = 30_000;

type Operation = "bootstrap" | "list" | "upload" | "delete";
type LocalizedErrorKey = "emptyFile" | "fileTooLarge" | "unsupportedFile" | "fileLimit";
type UploadErrorState =
  | Readonly<{ kind: "message"; key: LocalizedErrorKey }>
  | Readonly<{
      kind: "request";
      code: string;
      status: number | null;
      operation: Exclude<Operation, "bootstrap">;
    }>;

function toRequestErrorState(
  error: unknown,
  operation: Exclude<Operation, "bootstrap">
): UploadErrorState {
  return {
    kind: "request",
    code: error instanceof MobileRequestError ? error.code : "REQUEST_FAILED",
    status: error instanceof MobileRequestError ? error.status : null,
    operation
  };
}

function getUploadErrorMessage(
  error: UploadErrorState,
  text: ReturnType<typeof useLanguage>["text"]
): string {
  if (error.kind === "message") return text[error.key];
  return getErrorMessage(error.code, error.status, text, error.operation);
}

function getErrorMessage(
  code: string,
  status: number | null,
  text: ReturnType<typeof useLanguage>["text"],
  operation: Operation
): string {
  if (code === "INVALID_UPLOAD_LINK" || code === "INVALID_UPLOAD_GRANT") return text.invalidLink;
  if (code === "UPLOAD_GRANT_MISSING" || (operation === "bootstrap" && status === 401)) {
    return text.missingGrant;
  }
  if (code.includes("CLAIMED")) return text.claimed;
  if (status === 410 || code.includes("EXPIRED")) return text.expired;
  if (TERMINAL_MOBILE_SESSION_CODES.has(code)) return text.sessionUnavailable;
  if (status === 413 || code.includes("TOO_LARGE") || code.includes("BYTE_LIMIT")) {
    return text.fileTooLarge;
  }
  if (status === 415 || code.includes("UNSUPPORTED") || code.includes("FILE_TYPE")) {
    return text.unsupportedFile;
  }
  if (code === "EMPTY_FILE") return text.emptyFile;
  if (code.includes("FILE_LIMIT") || code.includes("MAX_FILES")) return text.fileLimit;
  if (code === "CONCURRENT_FILE_UPLOAD") return text.uploadFailed;
  if (operation !== "bootstrap" && (status === 401 || status === 404)) {
    return text.sessionUnavailable;
  }
  if (status === 409 || status === 423) {
    return operation === "upload" ? text.uploadFailed : text.genericError;
  }
  if (code === "NETWORK_UNAVAILABLE" || code === "REQUEST_TIMEOUT" || code === "UPLOAD_TIMEOUT") {
    return operation === "bootstrap" || operation === "list"
      ? text.connectionError
      : text.uploadFailed;
  }
  if (operation === "list") return text.connectionError;
  if (operation === "upload") return text.uploadFailed;
  if (operation === "delete") return text.deleteFailed;
  return text.genericError;
}

function isRetryableBootstrapError(code: string, status: number | null): boolean {
  return (
    code === "NETWORK_UNAVAILABLE" ||
    code === "REQUEST_TIMEOUT" ||
    code === "REQUEST_FAILED" ||
    code === "INVALID_SERVER_RESPONSE" ||
    code === "CONCURRENT_UPLOAD_CLAIM" ||
    status === 408 ||
    status === 429 ||
    (status !== null && status >= 500)
  );
}

function formatBytes(bytes: number, locale: Locale): string {
  const megabytes = bytes / (1024 * 1024);
  const value = new Intl.NumberFormat(localeTag(locale), {
    maximumFractionDigits: megabytes >= 10 ? 0 : 1
  }).format(megabytes);
  const unit: Record<Locale, string> = { hy: "ՄԲ", ru: "МБ", en: "MB" };
  return `${value} ${unit[locale]}`;
}

function formatTime(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function localeTag(locale: Locale): string {
  return { hy: "hy-AM", ru: "ru-RU", en: "en-US" }[locale];
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 3 19 6v5c0 4.6-2.8 8.2-7 10-4.2-1.8-7-5.4-7-10V6l7-3Z" />
      <path d="m9 12 2 2 4-5" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 16V4m0 0L7 9m5-5 5 5M5 15v4h14v-4" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M6 2h8l4 4v16H6V2Z" />
      <path d="M14 2v5h5M9 12h6M9 16h6" />
    </svg>
  );
}
