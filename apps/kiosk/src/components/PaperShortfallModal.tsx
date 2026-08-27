import { useEffect, useRef } from "react";

import { useLanguage } from "../features/i18n/LanguageProvider.js";

/**
 * What a customer is told when the job asks for more sheets than the kiosk has.
 *
 * Dismissible, unlike the printer-unavailable dialog it stands beside, and the
 * difference is the point. That one covers a machine that cannot print at all,
 * where there is no choice to offer; this one covers a job that does not fit,
 * where there is: fewer copies, fewer pages, or both. So it closes on the
 * button, on the backdrop and on Escape, and it closes onto the settings the
 * customer needs to reach.
 *
 * It does not have to be the only thing standing between them and a checkout —
 * the pay button is disabled for as long as the job is too big, and says why —
 * because a dialog that had to be caught to matter would be a poor gate.
 */
export function PaperShortfallModal({
  availableSheets,
  requiredSheets,
  onDismiss
}: {
  availableSheets: number;
  requiredSheets: number;
  onDismiss: () => void;
}) {
  const { messages } = useLanguage();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Announced to a screen reader, and takes keyboard focus off the controls
    // underneath rather than leaving it on a stepper behind an overlay.
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onDismiss]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <section
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="paper-shortfall-title"
        aria-describedby="paper-shortfall-body"
      >
        <div className="status-mark status-mark--small" aria-hidden="true">
          !
        </div>
        <h2 id="paper-shortfall-title" ref={headingRef} tabIndex={-1}>
          {messages.configure.paperShortTitle}
        </h2>
        <p id="paper-shortfall-body">
          {messages.configure.paperShortBody(availableSheets, requiredSheets)}{" "}
          {messages.configure.paperShortAdvice}
        </p>
        <div className="button-row">
          <button className="button button--primary" type="button" onClick={onDismiss}>
            {messages.configure.paperShortDismiss}
          </button>
        </div>
      </section>
    </div>
  );
}
