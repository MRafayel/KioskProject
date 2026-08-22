import { useMutation } from "@tanstack/react-query";

import { useKioskNavigate } from "../app/router.js";
import { LanguageSelector } from "../features/i18n/LanguageSelector.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { createKioskSession, SessionRequestError } from "../features/session/sessionService.js";

/**
 * What to tell somebody standing at the machine.
 *
 * The printer cases are the reason this exists: a kiosk whose printer cannot
 * finish a job says so here, before the customer photographs a QR code, uploads
 * their documents and reaches a checkout — all of which used to end in the same
 * refusal, several minutes later, with their files already on the machine.
 *
 * Only one cause is named. `PRINTER_OUT_OF_PAPER` is set from the printer's own
 * tray level, so it is worth telling somebody; every other reason gets the
 * general wording rather than a guess that sends staff to the wrong problem.
 */
function describeStartFailure(
  error: unknown,
  copy: { startError: string; paidSessionError: string; printerUnavailableError: string; printerOutOfPaperError: string }
): string {
  if (!(error instanceof SessionRequestError)) return copy.startError;
  if (error.code === "PAID_SESSION_REQUIRES_FULFILLMENT") return copy.paidSessionError;
  if (error.code !== "PRINTER_UNAVAILABLE") return copy.startError;
  return error.reason === "PRINTER_OUT_OF_PAPER"
    ? copy.printerOutOfPaperError
    : copy.printerUnavailableError;
}

export function WelcomeScreen() {
  const { locale, messages } = useLanguage();
  const { dispatch } = usePrototypeSession();
  const navigate = useKioskNavigate();
  const createSession = useMutation({
    mutationFn: () => createKioskSession(locale),
    onSuccess: (session) => {
      dispatch({ type: "SESSION_CREATED", session });
      void navigate("/upload");
    }
  });
  const startError = describeStartFailure(createSession.error, messages.welcome);

  return (
    <main className="welcome">
      <header className="welcome__header">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true">
            P
          </span>
          <span>
            <strong>{messages.brand.name}</strong>
            <small>{messages.brand.welcomeSubtitle}</small>
          </span>
        </div>
        <div className="welcome__actions">
          <span className="status-pill">
            <span aria-hidden="true">●</span> {messages.common.ready}
          </span>
        </div>
      </header>

      <section className="welcome__content" aria-labelledby="welcome-title">
        <div>
          <p className="eyebrow">{messages.welcome.eyebrow}</p>
          <h1 id="welcome-title">{messages.welcome.title}</h1>
          <p className="welcome__lead">{messages.welcome.lead}</p>
        </div>

        <article className="service-card">
          <div className="service-card__icon" aria-hidden="true">
            ▤
          </div>
          <div>
            <p className="eyebrow">{messages.welcome.availableService}</p>
            <h2>{messages.welcome.serviceTitle}</h2>
            <p>{messages.welcome.serviceDescription}</p>
          </div>
          <button
            className="button button--primary button--wide"
            type="button"
            onClick={() => createSession.mutate()}
            disabled={createSession.isPending}
          >
            {createSession.isPending ? messages.welcome.starting : messages.welcome.start}
            <span aria-hidden="true">→</span>
          </button>
          {createSession.isError ? <p className="inline-error">{startError}</p> : null}
        </article>
      </section>

      <footer className="welcome__footer">
        <LanguageSelector />
        <div className="welcome__footer-notes">
          <span>{messages.welcome.footerSecure}</span>
          <span>{messages.welcome.footerNoAccount}</span>
          <span>{messages.welcome.footerTouchscreen}</span>
        </div>
      </footer>
    </main>
  );
}
