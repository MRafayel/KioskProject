import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";

import type { UploadedFileRejectionCode } from "@printing-kiosk/contracts";

import { useKioskNavigate } from "../app/router.js";
import { useKioskOutletContext } from "../components/KioskLayout.js";
import { SessionTimer } from "../components/SessionTimer.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import {
  canLeaveUpload,
  fileExtension,
  formatFileSize,
  isFileValidating,
  isReadyFile,
  type PrototypeFile
} from "../features/session/model.js";
import { kioskPaperQueryOptions, UNKNOWN_PAPER } from "../features/session/paper.js";
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

  // Opening this screen is what asks. Nothing polls behind it, so the count a
  // customer is shown here is read as they arrive and the configure screen
  // re-reads it when they move on — see `kioskPaperQueryOptions`.
  const paperQuery = useQuery(kioskPaperQueryOptions());
  const paper = paperQuery.data ?? UNKNOWN_PAPER;

  useEffect(() => {
    if (!filesQuery.data) return;
    dispatch({ type: "FILES_SYNCED", files: filesQuery.data });
  }, [dispatch, filesQuery.data]);

  const visibleFiles = state.files.filter((file) => file.status !== "DELETED");
  const readyCount = state.files.filter(isReadyFile).length;
  // Every document that is still going to print has to have finished being
  // checked. One ready file used to be enough, which meant adding a second one
  // left the button live over a job whose contents were not settled yet.
  const canContinue = canLeaveUpload(state.files);
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
    !filesQuery.isError && !firstRejected && visibleFiles.some((file) => isFileValidating(file));
  const statusMessage =
    visibleFiles.length === 0
      ? messages.upload.waitingForPhone
      : pending
        ? fileStatusLabel(pending, messages.upload)
        : messages.upload.documentsReady(readyCount);

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
          {/* What this kiosk can print now, directly under the code the
              customer is about to photograph. A count when one is being kept,
              and an honest absence when one is not: a kiosk nobody has recorded
              paper for is not a kiosk with no paper, and showing "0 sheets"
              would say the wrong thing about a full tray. */}
          <p className="qr-card__paper" role="status">
            {paper.estimatedSheets === null
              ? messages.upload.paperUnavailable
              : messages.upload.paperAvailable(paper.estimatedSheets)}
          </p>
          <div className="qr-card__timer">
            <SessionTimer compact />
          </div>
          <UploadStatusPill
            danger={Boolean(pending && statusTone(pending) === "danger")}
            message={statusMessage}
            processing={showProcessingActivity}
            processingMessages={messages.upload.processingMessages}
          />
        </div>

        {visibleFiles.length > 0 ? (
          <ul className="file-card-list" aria-label={messages.upload.uploadedDocuments}>
            {visibleFiles.map((file) => (
              <li key={file.id}>
                <article className="file-card" aria-label={messages.upload.uploadedDocument}>
                  <div className="file-card__icon" aria-hidden="true">
                    {file.kind ?? "FILE"}
                  </div>
                  <div className="file-card__details">
                    <div className="file-card__identity">
                      <strong>
                        {file.name ??
                          messages.upload.fileName(file.ordinal + 1, fileExtension(file.kind))}
                      </strong>
                      {file.sizeBytes === null ? null : (
                        <span className="file-card__meta">
                          {formatFileSize(file.sizeBytes, numberLocale, messages.units.megabytes)}
                        </span>
                      )}
                    </div>
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
            <span>{messages.upload.placeholder}</span>
          </div>
        )}

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
          // Guarded here as well as on the attribute. A document can finish
          // arriving between the render that drew this button and the press
          // that reaches it, and a disabled attribute is not a decision — it is
          // a description of one made a moment ago.
          onClick={() => {
            if (!canLeaveUpload(state.files)) return;
            void navigate("/configure");
          }}
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

function UploadStatusPill({
  danger,
  message,
  processing,
  processingMessages
}: {
  danger: boolean;
  message: string;
  processing: boolean;
  processingMessages: readonly [string, string, string];
}) {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    setMessageIndex(0);
    if (!processing) return;
    const timer = window.setInterval(
      () => setMessageIndex((current) => (current + 1) % processingMessages.length),
      2_600
    );
    return () => window.clearInterval(timer);
  }, [processing, processingMessages]);

  const currentMessage = processing
    ? (processingMessages[messageIndex] ?? processingMessages[0])
    : message;
  return (
    <span
      className={`status-pill status-pill--${danger ? "danger" : "waiting"}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={currentMessage}
    >
      {processing ? (
        <span className="status-pill__spinner" aria-hidden="true" />
      ) : (
        <span aria-hidden="true">●</span>
      )}
      <span
        className={
          processing
            ? "status-pill__message status-pill__message--processing"
            : "status-pill__message"
        }
        key={processing ? messageIndex : currentMessage}
      >
        {currentMessage}
      </span>
    </span>
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
