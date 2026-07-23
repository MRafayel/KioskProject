import { useQuery } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useEffect } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";

import type { KioskOutletContext } from "../components/KioskLayout.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { useSessionTimer } from "../features/session/SessionTimerProvider.js";
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
  const { recordActivity } = useSessionTimer();
  const navigate = useNavigate();
  const { realtimeConnected } = useOutletContext<KioskOutletContext>();
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
    if (filesQuery.data.some((file) => file.status === "UPLOADING")) recordActivity();
  }, [dispatch, filesQuery.data, filesQuery.dataUpdatedAt, recordActivity]);

  const file = state.files[0];
  const readyFile = isReadyFile(file);

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
            className={`status-pill status-pill--${file && statusTone(file) === "danger" ? "danger" : "waiting"}`}
          >
            <span aria-hidden="true">●</span>{" "}
            {file ? fileStatusLabel(file, messages.upload) : messages.upload.waitingForPhone}
          </span>
        </div>

        {file ? (
          <article className="file-card" aria-label={messages.upload.uploadedDocument}>
            <div className="file-card__icon" aria-hidden="true">
              {file.kind ?? "FILE"}
            </div>
            <div>
              <strong>
                {file.name ?? messages.upload.fileName(file.ordinal + 1, fileExtension(file.kind))}
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
        ) : (
          <div className="upload-placeholder" aria-live="polite">
            <span className="pulse" aria-hidden="true" />
            {messages.upload.placeholder}
          </div>
        )}

        <button
          className="button button--primary button--wide"
          type="button"
          disabled={!readyFile}
          onClick={() => void navigate("/configure")}
        >
          {messages.upload.continue} <span aria-hidden="true">→</span>
        </button>
        {file && !readyFile ? (
          <p className="upload-panel__pending" role="status">
            {file.status === "REJECTED"
              ? messages.upload.rejectedHelp
              : messages.upload.continueUnavailable}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function fileStatusLabel(
  file: PrototypeFile,
  messages: {
    uploadComplete: string;
    fileUploading: string;
    fileChecking: string;
    fileRejected: string;
    fileDeleting: string;
    fileDeleted: string;
  }
): string {
  if (file.status === "READY") return messages.uploadComplete;
  if (file.status === "UPLOADING") return messages.fileUploading;
  if (file.status === "QUARANTINED") return messages.fileChecking;
  if (file.status === "REJECTED") return messages.fileRejected;
  if (file.status === "DELETED") return messages.fileDeleted;
  return messages.fileDeleting;
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
