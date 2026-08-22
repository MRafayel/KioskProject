import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";

import type { UploadedFileRejectionCode } from "@printing-kiosk/contracts";

import { useKioskNavigate } from "../app/router.js";
import { useKioskOutletContext } from "../components/KioskLayout.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  fileExtension,
  formatFileSize,
  isReadyFile,
  type PrototypeFile
} from "../features/session/model.js";
import { listKioskSessionFiles } from "../features/session/sessionService.js";

export function UploadScreen() {
  const { messages, numberLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();
  const { realtimeConnected } = useKioskOutletContext();
  const sessionId = state.session?.id;
  const filesQuery = useQuery({
    queryKey: ["kiosk-session-files", sessionId],
    queryFn: () => {
      if (!sessionId) throw new Error("SESSION_REQUIRED");
      return listKioskSessionFiles(sessionId);
    },
    enabled: Boolean(sessionId),
    // The event stream is the fast path. A slow snapshot reconciliation keeps
    // the screen correct if a browser, agent, or network event is interrupted.
    refetchInterval: realtimeConnected ? 15_000 : 2_000,
    refetchIntervalInBackground: false,
    gcTime: 0,
    retry: false
  });

  useEffect(() => {
    if (!filesQuery.data) return;
    dispatch({ type: "FILES_SYNCED", files: filesQuery.data });
  }, [dispatch, filesQuery.data]);

  const visibleFiles = state.files.filter((file) => file.status !== "DELETED");
  const readyCount = state.files.filter(isReadyFile).length;
  // Any validated document is enough to continue. The rest may still be
  // uploading, and the customer can come back and add more.
  const canContinue = readyCount > 0;
  // What the status pill reports: the first thing that still needs attention,
  // otherwise the set as a whole.
  const pending = visibleFiles.find((file) => file.status !== "READY");
  // A rejection is the one thing worth explaining in full, so the first one
  // gets the explanation even while other documents are still arriving.
  const firstRejected = visibleFiles.find((file) => file.status === "REJECTED");
  // These messages deliberately describe general preparation rather than
  // backend milestones. Authoritative errors and rejections always replace
  // this presentational activity treatment.
  const showProcessingActivity =
    !filesQuery.isError && !firstRejected && visibleFiles.some((file) => isFileBeingPrepared(file));

  if (!state.session) return null;

  return (
    <div className="screen-grid screen-grid--upload">
      <section className="screen-copy" aria-labelledby="upload-title">
        <p className="eyebrow">{messages.upload.step}</p>
        <h1 id="upload-title">{messages.upload.title}</h1>
        <p>{messages.upload.description}</p>

        <ol className="instruction-list">
          <li>
            <span>1</span> {messages.upload.instructionCamera}
          </li>
          <li>
            <span>2</span> {messages.upload.instructionQr}
          </li>
          <li>
            <span>3</span> {messages.upload.instructionFile}
          </li>
        </ol>

        {filesQuery.isError ? (
          <p className="upload-refresh-error" role="status">
            {messages.upload.refreshError}
          </p>
        ) : null}
      </section>

      <section className="upload-panel" aria-label={messages.upload.sessionLabel}>
        <div className="qr-card">
          <QRCodeSVG
            value={state.session.uploadUrl}
            size={220}
            level="M"
            marginSize={2}
            title={messages.upload.qrTitle}
          />
          <span
            className={`status-pill status-pill--${pending && statusTone(pending) === "danger" ? "danger" : "waiting"}`}
          >
            <span aria-hidden="true">●</span>{" "}
            {visibleFiles.length === 0
              ? messages.upload.waitingForPhone
              : pending
                ? fileStatusLabel(pending, messages.upload)
                : messages.upload.documentsReady(readyCount)}
          </span>
        </div>

        {visibleFiles.length > 0 ? (
          <ul className="file-card-list" aria-label={messages.upload.uploadedDocuments}>
            {visibleFiles.map((file) => (
              <li key={file.id}>
                <article className="file-card" aria-label={messages.upload.uploadedDocument}>
                  <div className="file-card__icon" aria-hidden="true">
                    {file.kind ?? "FILE"}
                  </div>
                  <div>
                    <strong>
                      {file.name ??
                        messages.upload.fileName(file.ordinal + 1, fileExtension(file.kind))}
                    </strong>
                    <span>
                      {fileStatusLabel(file, messages.upload)}
                      {file.sizeBytes === null
                        ? ""
                        : ` · ${formatFileSize(file.sizeBytes, numberLocale, messages.units.megabytes)}`}
                    </span>
                  </div>
                  <span
                    className={`file-card__check file-card__check--${statusTone(file)}`}
                    aria-label={fileStatusLabel(file, messages.upload)}
                  >
                    {statusMark(file)}
                  </span>
                </article>
              </li>
            ))}
          </ul>
        ) : (
          <div className="upload-placeholder" aria-live="polite">
            <span className="pulse" aria-hidden="true" />
            {messages.upload.placeholder}
          </div>
        )}

        {showProcessingActivity ? (
          <ProcessingActivity messages={messages.upload.processingMessages} />
        ) : null}

        {/* The phone can keep sending while this screen is open, so the hint
            stays up as long as there is room for another document. */}
        {visibleFiles.length > 0 ? (
          <p className="upload-panel__more" role="status">
            {messages.upload.addMoreHint}
          </p>
        ) : null}

        <button
          className="button button--primary button--wide"
          type="button"
          disabled={!canContinue}
          onClick={() => void navigate("/configure")}
        >
          {canContinue && readyCount > 1
            ? messages.upload.continueWithCount(readyCount)
            : messages.upload.continue}{" "}
          <span aria-hidden="true">→</span>
        </button>
        {firstRejected ? (
          <p className="upload-panel__pending" role="status">
            {`${rejectionExplanation(firstRejected.rejectionCode, messages.upload)} ${messages.upload.rejectedHelp}`}
          </p>
        ) : !canContinue && visibleFiles.length > 0 ? (
          <p className="upload-panel__pending" role="status">
            {messages.upload.continueUnavailable}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ProcessingActivity({ messages }: { messages: readonly [string, string, string] }) {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    setMessageIndex(0);
    const timer = window.setInterval(
      () => setMessageIndex((current) => (current + 1) % messages.length),
      2_600
    );
    return () => window.clearInterval(timer);
  }, [messages]);

  const currentMessage = messages[messageIndex] ?? messages[0];
  return (
    <div
      className="processing-activity"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={currentMessage}
    >
      <div className="processing-activity__art" aria-hidden="true">
        <span className="processing-activity__orbit" />
        <span className="processing-activity__document">
          <i />
          <i />
          <i />
        </span>
      </div>
      <span className="processing-activity__message" key={messageIndex}>
        {currentMessage}
      </span>
    </div>
  );
}

function isFileBeingPrepared(file: PrototypeFile): boolean {
  return (
    file.status === "UPLOADING" || file.status === "QUARANTINED" || file.status === "VALIDATING"
  );
}

function fileStatusLabel(
  file: PrototypeFile,
  messages: {
    uploadComplete: string;
    fileUploading: string;
    fileQuarantined: string;
    fileChecking: string;
    fileRejected: string;
    fileDeleting: string;
    fileDeleted: string;
  }
): string {
  switch (file.status) {
    case "READY":
      return messages.uploadComplete;
    case "UPLOADING":
      return messages.fileUploading;
    case "QUARANTINED":
      return messages.fileQuarantined;
    case "VALIDATING":
      return messages.fileChecking;
    case "REJECTED":
      return messages.fileRejected;
    case "DELETING":
    case "DELETE_PENDING":
      return messages.fileDeleting;
    case "DELETED":
      return messages.fileDeleted;
    default:
      return unreachableStatus(file.status);
  }
}

function statusMark(file: PrototypeFile): string {
  if (file.status === "READY") return "✓";
  if (file.status === "REJECTED") return "!";
  if (file.status === "DELETED") return "×";
  return "…";
}

function statusTone(file: PrototypeFile): "success" | "danger" | "pending" {
  if (file.status === "READY") return "success";
  if (file.status === "REJECTED" || file.status === "DELETED") return "danger";
  return "pending";
}

function rejectionExplanation(
  rejectionCode: UploadedFileRejectionCode | null,
  messages: {
    rejectionMalware: string;
    rejectionScanner: string;
    rejectionEncrypted: string;
    rejectionInvalid: string;
    rejectionPageLimit: string;
    rejectionLimits: string;
    rejectionTimeout: string;
    rejectionGeneric: string;
  }
): string {
  if (!rejectionCode) return messages.rejectionGeneric;
  switch (rejectionCode) {
    case "MALWARE_DETECTED":
      return messages.rejectionMalware;
    case "MALWARE_SCAN_UNAVAILABLE":
      return messages.rejectionScanner;
    case "DOCUMENT_ENCRYPTED":
      return messages.rejectionEncrypted;
    case "DOCUMENT_MALFORMED":
    case "UNSUPPORTED_DOCUMENT_CONTENT":
      return messages.rejectionInvalid;
    case "PAGE_LIMIT_EXCEEDED":
      return messages.rejectionPageLimit;
    case "IMAGE_DIMENSION_LIMIT_EXCEEDED":
    case "IMAGE_PIXEL_LIMIT_EXCEEDED":
    case "OUTPUT_SIZE_LIMIT_EXCEEDED":
      return messages.rejectionLimits;
    case "PROCESSING_TIMEOUT":
      return messages.rejectionTimeout;
    case "UPLOAD_FAILED":
    case "PROCESSING_FAILED":
      return messages.rejectionGeneric;
    default:
      return unreachableStatus(rejectionCode);
  }
}

function unreachableStatus(status: never): never {
  throw new Error(`UNSUPPORTED_FILE_STATUS:${String(status)}`);
}
