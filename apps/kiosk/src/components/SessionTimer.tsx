import type { CSSProperties } from "react";

import { useLanguage } from "../features/i18n/LanguageProvider.js";
import { useSessionTimer } from "../features/session/SessionTimerProvider.js";

/**
 * The single visual representation of the existing session timer.
 *
 * Routes place it in their own available space, while the provider remains the
 * sole owner of deadlines, activity resets, warnings, and session cleanup.
 */
export function SessionTimer({ compact = false }: { compact?: boolean }) {
  const { messages } = useLanguage();
  const { durationSeconds, isRunning, remainingSeconds } = useSessionTimer();

  if (!isRunning) return null;

  const progress = `${Math.max(0, Math.min(360, (remainingSeconds / durationSeconds) * 360))}deg`;

  return (
    <div
      className={compact ? "session-timer session-timer--compact" : "session-timer"}
      role="timer"
      aria-label={messages.idle.countdown(remainingSeconds)}
      aria-atomic="true"
      style={{ "--session-timer-progress": progress } as CSSProperties}
    >
      <span className="session-timer__dial" aria-hidden="true">
        <strong>{remainingSeconds}</strong>
        <small>{messages.idle.seconds}</small>
      </span>
      <span className="session-timer__label">{messages.idle.timeRemaining}</span>
    </div>
  );
}
