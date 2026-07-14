import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { usePrototypeSession } from "../features/session/PrototypeSessionProvider.js";

const WARNING_AFTER_MS = 60_000;
const RESET_AFTER_MS = 90_000;

export function IdleGuard() {
  const { dispatch } = usePrototypeSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [warningOpen, setWarningOpen] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(30);

  const active = location.pathname !== "/";

  const returnHome = useCallback(() => {
    dispatch({ type: "RESET" });
    setWarningOpen(false);
    void navigate("/", { replace: true });
  }, [dispatch, navigate]);

  const continueSession = useCallback(() => {
    setWarningOpen(false);
    setRemainingSeconds(30);
    window.dispatchEvent(new Event("kiosk-activity"));
  }, []);

  useEffect(() => {
    if (!active) return;

    let warningTimer = 0;
    let resetTimer = 0;
    let countdownTimer = 0;

    const schedule = () => {
      window.clearTimeout(warningTimer);
      window.clearTimeout(resetTimer);
      window.clearInterval(countdownTimer);
      setWarningOpen(false);
      setRemainingSeconds(30);

      warningTimer = window.setTimeout(() => {
        setWarningOpen(true);
        countdownTimer = window.setInterval(() => {
          setRemainingSeconds((seconds) => Math.max(0, seconds - 1));
        }, 1000);
      }, WARNING_AFTER_MS);

      resetTimer = window.setTimeout(returnHome, RESET_AFTER_MS);
    };

    const activityEvents = ["pointerdown", "keydown", "kiosk-activity"] as const;
    activityEvents.forEach((eventName) => window.addEventListener(eventName, schedule));
    schedule();

    return () => {
      window.clearTimeout(warningTimer);
      window.clearTimeout(resetTimer);
      window.clearInterval(countdownTimer);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, schedule));
    };
  }, [active, returnHome]);

  if (!warningOpen) return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="idle-title">
        <div className="countdown" aria-label={`${remainingSeconds} seconds remaining`}>
          {remainingSeconds}
        </div>
        <h2 id="idle-title">Do you need more time?</h2>
        <p>
          For your privacy, this session will close and remove its files when the timer reaches
          zero.
        </p>
        <div className="button-row">
          <button className="button button--secondary" type="button" onClick={returnHome}>
            End session
          </button>
          <button
            className="button button--primary"
            type="button"
            onClick={continueSession}
            autoFocus
          >
            Continue printing
          </button>
        </div>
      </section>
    </div>
  );
}
