import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { PRODUCT_SCOPE } from "@printing-kiosk/contracts";

import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { createPrototypeSession } from "../mocks/prototypeService.js";

export function WelcomeScreen() {
  const { dispatch } = usePrototypeSession();
  const navigate = useNavigate();
  const createSession = useMutation({
    mutationFn: createPrototypeSession,
    onSuccess: (session) => {
      dispatch({ type: "SESSION_CREATED", session });
      void navigate("/upload");
    }
  });

  return (
    <main className="welcome">
      <header className="welcome__header">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true">
            P
          </span>
          <span>
            <strong>Print kiosk</strong>
            <small>Private self-service printing</small>
          </span>
        </div>
        <span className="status-pill">
          <span aria-hidden="true">●</span> Ready
        </span>
      </header>

      <section className="welcome__content" aria-labelledby="welcome-title">
        <div>
          <p className="eyebrow">Fast · private · self-service</p>
          <h1 id="welcome-title">Print from your phone in a few simple steps.</h1>
          <p className="welcome__lead">
            Scan a QR code, upload your document, choose settings, and pay at this screen.
          </p>
          <ul className="feature-list" aria-label="Supported printing features">
            <li>PDF, JPEG, and PNG</li>
            <li>
              {PRODUCT_SCOPE.outputMode.charAt(0) + PRODUCT_SCOPE.outputMode.slice(1).toLowerCase()}
            </li>
            <li>Files deleted automatically</li>
          </ul>
        </div>

        <article className="service-card">
          <div className="service-card__icon" aria-hidden="true">
            ▤
          </div>
          <div>
            <p className="eyebrow">Available service</p>
            <h2>Print documents</h2>
            <p>Upload from your phone. No account or app required.</p>
          </div>
          <button
            className="button button--primary button--wide"
            type="button"
            onClick={() => createSession.mutate()}
            disabled={createSession.isPending}
          >
            {createSession.isPending ? "Starting…" : "Start printing"}
            <span aria-hidden="true">→</span>
          </button>
          {createSession.isError ? (
            <p className="inline-error">Could not start. Please try again.</p>
          ) : null}
        </article>
      </section>

      <footer className="welcome__footer">
        <span>Secure session</span>
        <span>No account needed</span>
        <span>Touchscreen prototype</span>
      </footer>
    </main>
  );
}
