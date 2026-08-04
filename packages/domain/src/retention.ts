/**
 * When a finished session's documents may be removed, in what order, and what
 * happens when a step fails.
 *
 * This module is pure: no clock, no randomness, no database, no object store.
 * The API schedules cleanup from it at the moment a session ends, the worker
 * drives its checkpoints, and the storage reconciler decides from it which
 * stray objects are old enough to be nobody's. Keeping the policy in one place
 * is what stops those three from disagreeing about whether a customer's
 * document is still allowed to exist.
 *
 * Two rules shape everything here. Deletion is a workflow, not a row update: it
 * repeats from a checkpoint until every copy is gone, so it must be safe to run
 * three times as it is to run once. And the bytes go first — a database row is
 * scrubbed only after the object it points at has been deleted, because a
 * forgotten key with no row left to find it is a document nobody can delete.
 */

/**
 * The terminal session states retention acts on. A session in any other state
 * is still live and its documents are still needed.
 */
export type TerminalSessionState =
  "COMPLETED" | "CANCELED" | "EXPIRED" | "FAILED" | "RECOVERY_REQUIRED";

const TERMINAL_SESSION_STATES: readonly TerminalSessionState[] = [
  "COMPLETED",
  "CANCELED",
  "EXPIRED",
  "FAILED",
  "RECOVERY_REQUIRED"
];

export function isTerminalSessionState(state: string): state is TerminalSessionState {
  return (TERMINAL_SESSION_STATES as readonly string[]).includes(state);
}

/**
 * The ordered checkpoints of one session's cleanup.
 *
 * A run records the last checkpoint it passed, so an interrupted cleanup
 * resumes rather than restarting. The order is deliberate: access is revoked
 * before anything is deleted so no new copy can be created behind the run;
 * known artifacts are deleted before the storage prefix is swept so the sweep
 * only has to find what the ledger missed; and relational metadata is scrubbed
 * last, because a scrubbed row can no longer tell anyone which object to
 * delete.
 */
export const CLEANUP_CHECKPOINTS = [
  "SCHEDULED",
  "ACCESS_REVOKED",
  "ARTIFACTS_DELETED",
  "STORAGE_RECONCILED",
  "METADATA_SCRUBBED",
  "COMPLETED"
] as const;

export type CleanupCheckpoint = (typeof CLEANUP_CHECKPOINTS)[number];

export type CleanupRunStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "DEAD_LETTER";

/** Mirrors the run's progress onto the session so operators can query one row. */
export type SessionCleanupStatus = "NOT_DUE" | CleanupRunStatus;

export function checkpointRank(checkpoint: CleanupCheckpoint): number {
  return CLEANUP_CHECKPOINTS.indexOf(checkpoint);
}

export function isCheckpointAtLeast(
  checkpoint: CleanupCheckpoint,
  required: CleanupCheckpoint
): boolean {
  return checkpointRank(checkpoint) >= checkpointRank(required);
}

/** The checkpoint after this one, or null when the run is finished. */
export function nextCheckpoint(checkpoint: CleanupCheckpoint): CleanupCheckpoint | null {
  return CLEANUP_CHECKPOINTS[checkpointRank(checkpoint) + 1] ?? null;
}

/**
 * Checkpoints only ever move forwards. A worker that read a stale row and tried
 * to write an earlier checkpoint would repeat deletions that already succeeded;
 * harmless in itself, but it would also let a run loop instead of finishing.
 */
export function advanceCheckpoint(
  current: CleanupCheckpoint,
  candidate: CleanupCheckpoint
): CleanupCheckpoint {
  return checkpointRank(candidate) > checkpointRank(current) ? candidate : current;
}

export interface RetentionPolicy {
  /**
   * How long a finished print's documents survive so the customer can read the
   * receipt screen and an attendant can answer a question about the output.
   */
  settledGraceMilliseconds: number;
  /**
   * A result no device could confirm needs a person. The documents themselves
   * are not what recovers it, so this is a short review window rather than a
   * hold: the money is already recorded as owed or not.
   */
  recoveryGraceMilliseconds: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  settledGraceMilliseconds: 300_000,
  recoveryGraceMilliseconds: 900_000
};

/**
 * A session that never reached a device keeps nothing waiting: a cancellation
 * or an expiry means the customer has walked away, so their documents are
 * deletable immediately. Only an outcome somebody may still ask about gets a
 * grace, and even then it is minutes.
 */
export function retentionGraceMilliseconds(
  state: TerminalSessionState,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY
): number {
  assertPolicy(policy);
  switch (state) {
    case "CANCELED":
    case "EXPIRED":
      return 0;
    case "COMPLETED":
    case "FAILED":
      return policy.settledGraceMilliseconds;
    case "RECOVERY_REQUIRED":
      return policy.recoveryGraceMilliseconds;
  }
}

export function cleanupDueAt(
  state: TerminalSessionState,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY
): Date {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("RETENTION_CLOCK_INVALID");
  return new Date(milliseconds + retentionGraceMilliseconds(state, policy));
}

/** The first retry waits this long; each further attempt doubles it. */
export const CLEANUP_RETRY_BASE_MILLISECONDS = 5_000;
export const CLEANUP_RETRY_MAX_MILLISECONDS = 900_000;

/**
 * Back off after a failed attempt, spreading retries so a recovering object
 * store is not hit by every stalled run at the same instant.
 *
 * `jitter` is supplied by the caller rather than drawn here: the policy stays
 * pure and testable, and the worker keeps its single injected random source.
 */
export function cleanupRetryDelayMilliseconds(attempts: number, jitter = 0.5): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("RETENTION_ATTEMPTS_INVALID");
  }
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new Error("RETENTION_JITTER_INVALID");
  }

  // 2 ** 30 already saturates the cap; clamping the exponent keeps a runaway
  // attempt counter from producing Infinity.
  const exponential = CLEANUP_RETRY_BASE_MILLISECONDS * 2 ** Math.min(attempts - 1, 30);
  const capped = Math.min(exponential, CLEANUP_RETRY_MAX_MILLISECONDS);
  // Full jitter over the lower half of the window: never shorter than half the
  // backoff, never longer than the backoff itself.
  return Math.round(capped * (0.5 + jitter * 0.5));
}

export function nextCleanupAttemptAt(now: Date, attempts: number, jitter = 0.5): Date {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("RETENTION_CLOCK_INVALID");
  return new Date(milliseconds + cleanupRetryDelayMilliseconds(attempts, jitter));
}

/**
 * A run that has failed this many times stops retrying and is dead-lettered for
 * a person to look at. It is never treated as finished: the documents are still
 * there, and the object-storage lifecycle rule is the only thing left holding
 * the line, so this must raise an alert rather than close quietly.
 */
export function isCleanupDeadLettered(attempts: number, maximumAttempts: number): boolean {
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
    throw new Error("RETENTION_MAX_ATTEMPTS_INVALID");
  }
  return attempts >= maximumAttempts;
}

/**
 * The object-storage roots that can hold a customer's bytes. Every key under
 * them begins with the owning session identifier, which is what makes a
 * deterministic per-session sweep possible without a filename ever appearing in
 * a path.
 */
export const SESSION_OBJECT_ROOTS = ["quarantine/v1/", "normalized/v1/", "previews/v1/"] as const;

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * The deterministic prefixes holding one session's objects.
 *
 * The identifier is validated rather than trusted. A prefix is handed straight
 * to a bulk delete, so a malformed or empty value would widen the sweep to
 * objects belonging to other customers.
 */
export function sessionObjectPrefixes(sessionId: string): string[] {
  if (!SESSION_ID_PATTERN.test(sessionId.toLowerCase())) {
    throw new Error("RETENTION_SESSION_ID_INVALID");
  }
  return SESSION_OBJECT_ROOTS.map((root) => `${root}${sessionId.toLowerCase()}/`);
}

/**
 * The session an object belongs to, or null when the key is not one this
 * system writes. The reconciler uses it to group stray objects before asking
 * the database about them, so an unrecognised key is left alone rather than
 * guessed at.
 */
export function sessionIdFromObjectKey(key: string): string | null {
  const root = SESSION_OBJECT_ROOTS.find((candidate) => key.startsWith(candidate));
  if (!root) return null;
  const sessionId = key.slice(root.length).split("/", 1)[0] ?? "";
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
}

function assertPolicy(policy: RetentionPolicy): void {
  if (
    !Number.isSafeInteger(policy.settledGraceMilliseconds) ||
    policy.settledGraceMilliseconds < 0 ||
    !Number.isSafeInteger(policy.recoveryGraceMilliseconds) ||
    policy.recoveryGraceMilliseconds < 0
  ) {
    throw new Error("RETENTION_POLICY_INVALID");
  }
}
