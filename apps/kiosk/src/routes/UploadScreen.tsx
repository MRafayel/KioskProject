import { useMutation } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useNavigate } from "react-router-dom";

import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { formatFileSize } from "../features/session/model.js";
import { simulatePhoneUpload } from "../mocks/prototypeService.js";

export function UploadScreen() {
  const { messages, numberLocale } = useLanguage();
  const { state, dispatch } = usePrototypeSession();
  const navigate = useNavigate();
  const upload = useMutation({
    mutationFn: simulatePhoneUpload,
    onSuccess: (file) => dispatch({ type: "FILE_UPLOADED", file })
  });
  const file = state.files[0];

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

        <div className="prototype-note">
          <strong>{messages.upload.prototypeControl}</strong>
          <span>{messages.upload.prototypeDescription}</span>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => upload.mutate()}
            disabled={upload.isPending || Boolean(file)}
          >
            {file
              ? messages.upload.demoReceived
              : upload.isPending
                ? messages.upload.receiving
                : messages.upload.simulate}
          </button>
        </div>
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
          <div className="session-code">
            <span>{messages.upload.enterCode}</span>
            <strong>{state.session.shortCode}</strong>
          </div>
          <span className="status-pill status-pill--waiting">
            <span aria-hidden="true">●</span>{" "}
            {file ? messages.upload.fileReceived : messages.upload.waitingForPhone}
          </span>
        </div>

        {file ? (
          <article className="file-card" aria-label={messages.upload.uploadedDocument}>
            <div className="file-card__icon" aria-hidden="true">
              PDF
            </div>
            <div>
              <strong>{file.name}</strong>
              <span>
                {messages.upload.fileMeta(
                  file.pageCount,
                  formatFileSize(file.sizeBytes, numberLocale, messages.units.megabytes)
                )}
              </span>
            </div>
            <span className="file-card__check" aria-label={messages.upload.uploadComplete}>
              ✓
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
          disabled={!file}
          onClick={() => void navigate("/configure")}
        >
          {messages.upload.continue} <span aria-hidden="true">→</span>
        </button>
      </section>
    </div>
  );
}
