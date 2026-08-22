import { useEffect, useRef } from "react";

import { useLanguage } from "../features/i18n/LanguageProvider.js";

/**
 * The screen a kiosk shows when its printer cannot finish a job.
 *
 * Deliberately not dismissible, and that is the whole point of it rather than an
 * oversight. Every other dialog in this app closes because the customer has a
 * choice to make; here there is no choice to offer. The machine cannot print,
 * and a dialog that could be waved away would leave somebody looking at a Start
 * button that only ever refuses — which is exactly the experience this exists to
 * remove. So there is no close control, no backdrop dismissal and no Escape
 * handler, and the only thing that takes it away is the printer being fixed.
 *
 * It disappears on its own. The welcome screen re-asks the control plane every
 * few seconds, so refilling the tray reopens the kiosk without anybody touching
 * it and without a reload.
 */
export function PrinterUnavailableModal({ outOfPaper }: { outOfPaper: boolean }) {
  const { messages } = useLanguage();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Focus moves to the message so a screen reader announces the closure and
    // so no keyboard focus is left sitting on the disabled controls behind it.
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    // A kiosk has a physical keyboard on it more often than anybody intends.
    // Escape closes every other dialog here; it must not close this one.
    const swallowEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.stopPropagation();
    };
    document.addEventListener("keydown", swallowEscape, true);
    return () => document.removeEventListener("keydown", swallowEscape, true);
  }, []);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      // No dismissal. The pointer handlers exist to stop a press reaching the
      // screen underneath, not to offer a way out.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <section
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="printer-unavailable-title"
        aria-describedby="printer-unavailable-body"
      >
        <div className="status-mark status-mark--small" aria-hidden="true">
          !
        </div>
        <h2 id="printer-unavailable-title" ref={headingRef} tabIndex={-1}>
          {messages.welcome.printerUnavailableTitle}
        </h2>
        <p id="printer-unavailable-body">
          {/* Only one cause is ever named. `PRINTER_OUT_OF_PAPER` comes from the
              printer's own tray level, so it is worth telling somebody; every
              other reason takes the general wording rather than a guess that
              would send staff to the wrong problem. */}
          {outOfPaper
            ? messages.welcome.printerOutOfPaperError
            : messages.welcome.printerUnavailableError}
        </p>
      </section>
    </div>
  );
}
