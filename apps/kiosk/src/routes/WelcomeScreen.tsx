import { useMutation } from "@tanstack/react-query";

import { useKioskNavigate } from "../app/router.js";
import { LanguageSelector } from "../features/i18n/LanguageSelector.js";
import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";
import { createKioskSession, SessionRequestError } from "../features/session/sessionService.js";

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
  const startError =
    createSession.error instanceof SessionRequestError &&
    createSession.error.code === "PAID_SESSION_REQUIRES_FULFILLMENT"
      ? messages.welcome.paidSessionError
      : messages.welcome.startError;

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
