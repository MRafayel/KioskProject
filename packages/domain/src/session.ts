export const SESSION_STATES = [
  "CREATED",
  "WAITING_FOR_UPLOAD",
  "FILES_UPLOADED",
  "CONFIGURING",
  "AWAITING_PAYMENT",
  "PAID",
  "PRINTING",
  "COMPLETED",
  "FAILED",
  "RECOVERY_REQUIRED",
  "EXPIRED",
  "CANCELED"
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/**
 * The states in which a session still accepts documents.
 *
 * A session carries several documents, so the phone stays useful after the
 * first one is validated: the customer may send another while the kiosk sits on
 * `FILES_UPLOADED`, or after they have started choosing settings. The boundary
 * is payment — once a price is being paid, the set of documents it was quoted
 * for is fixed, and every later state is either paid, terminal or expired.
 *
 * Both the upload path and the phone's own session check read this, so the two
 * cannot drift into a phone that is told it may upload by one and refused by
 * the other.
 */
export const UPLOADABLE_SESSION_STATES: readonly SessionState[] = [
  "WAITING_FOR_UPLOAD",
  "FILES_UPLOADED",
  "CONFIGURING"
];

export function isUploadableSessionState(state: string): state is SessionState {
  return (UPLOADABLE_SESSION_STATES as readonly string[]).includes(state);
}

export interface VersionedSessionState {
  state: SessionState;
  version: number;
}

export type SessionErrorCode =
  "INVALID_SESSION_TRANSITION" | "STALE_SESSION_VERSION" | "SESSION_EXPIRED";

export class SessionDomainError extends Error {
  public constructor(
    public readonly code: SessionErrorCode,
    public readonly details: Readonly<Record<string, string | number>> = {}
  ) {
    super(code);
    this.name = "SessionDomainError";
  }
}

const allowedTransitions: Readonly<Record<SessionState, readonly SessionState[]>> = {
  CREATED: ["WAITING_FOR_UPLOAD", "CANCELED", "EXPIRED"],
  WAITING_FOR_UPLOAD: ["FILES_UPLOADED", "CANCELED", "EXPIRED"],
  FILES_UPLOADED: ["WAITING_FOR_UPLOAD", "CONFIGURING", "AWAITING_PAYMENT", "CANCELED", "EXPIRED"],
  CONFIGURING: ["FILES_UPLOADED", "WAITING_FOR_UPLOAD", "AWAITING_PAYMENT", "CANCELED", "EXPIRED"],
  AWAITING_PAYMENT: ["CONFIGURING", "PAID", "CANCELED", "EXPIRED"],
  PAID: ["PRINTING"],
  PRINTING: ["COMPLETED", "FAILED", "RECOVERY_REQUIRED"],
  COMPLETED: [],
  FAILED: [],
  RECOVERY_REQUIRED: [],
  EXPIRED: [],
  CANCELED: []
};

export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionSession(
  current: VersionedSessionState,
  target: SessionState,
  expectedVersion: number
): VersionedSessionState {
  if (current.version !== expectedVersion) {
    throw new SessionDomainError("STALE_SESSION_VERSION", {
      expectedVersion,
      currentVersion: current.version
    });
  }

  if (!canTransitionSession(current.state, target)) {
    throw new SessionDomainError("INVALID_SESSION_TRANSITION", {
      currentState: current.state,
      targetState: target
    });
  }

  return { state: target, version: current.version + 1 };
}

export function isSessionExpired(now: Date, idleExpiresAt: Date, hardExpiresAt: Date): boolean {
  const expiration = Math.min(idleExpiresAt.getTime(), hardExpiresAt.getTime());
  return now.getTime() >= expiration;
}
