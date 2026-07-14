import { useMutation } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useNavigate } from "react-router-dom";

import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { formatFileSize } from "../features/session/model.js";
import { simulatePhoneUpload } from "../mocks/prototypeService.js";

export function UploadScreen() {
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
        <p className="eyebrow">Step 1 of 4</p>
        <h1 id="upload-title">Upload your document</h1>
        <p>Scan this QR code with your phone. No account or app is needed.</p>

        <ol className="instruction-list">
          <li>
            <span>1</span> Open your phone camera
          </li>
          <li>
            <span>2</span> Scan the QR code
          </li>
          <li>
            <span>3</span> Choose a PDF, JPEG, or PNG
          </li>
        </ol>

        <div className="prototype-note">
          <strong>Prototype control</strong>
          <span>Phase 1 has no backend, so this button simulates a secure phone upload.</span>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => upload.mutate()}
            disabled={upload.isPending || Boolean(file)}
          >
            {file
              ? "Demo file received"
              : upload.isPending
                ? "Receiving…"
                : "Simulate phone upload"}
          </button>
        </div>
      </section>

      <section className="upload-panel" aria-label="Upload session">
        <div className="qr-card">
          <QRCodeSVG
            value={state.session.uploadUrl}
            size={220}
            level="M"
            marginSize={2}
            title="Prototype mobile upload QR code"
          />
          <div className="session-code">
            <span>Or enter code</span>
            <strong>{state.session.shortCode}</strong>
          </div>
          <span className="status-pill status-pill--waiting">
            <span aria-hidden="true">●</span> {file ? "File received" : "Waiting for your phone"}
          </span>
        </div>

        {file ? (
          <article className="file-card" aria-label="Uploaded document">
            <div className="file-card__icon" aria-hidden="true">
              PDF
            </div>
            <div>
              <strong>{file.name}</strong>
              <span>
                {file.pageCount} pages · {formatFileSize(file.sizeBytes)}
              </span>
            </div>
            <span className="file-card__check" aria-label="Upload complete">
              ✓
            </span>
          </article>
        ) : (
          <div className="upload-placeholder" aria-live="polite">
            <span className="pulse" aria-hidden="true" />
            Your uploaded files will appear here automatically.
          </div>
        )}

        <button
          className="button button--primary button--wide"
          type="button"
          disabled={!file}
          onClick={() => void navigate("/configure")}
        >
          Continue to print settings <span aria-hidden="true">→</span>
        </button>
      </section>
    </div>
  );
}
