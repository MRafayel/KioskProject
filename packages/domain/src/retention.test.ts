import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  advanceCheckpoint,
  checkpointRank,
  cleanupDueAt,
  cleanupRetryDelayMilliseconds,
  CLEANUP_CHECKPOINTS,
  CLEANUP_RETRY_MAX_MILLISECONDS,
  isCheckpointAtLeast,
  isCleanupDeadLettered,
  isTerminalSessionState,
  nextCheckpoint,
  nextCleanupAttemptAt,
  retentionGraceMilliseconds,
  sessionIdFromObjectKey,
  sessionObjectPrefixes,
  type CleanupCheckpoint,
  type TerminalSessionState
} from "./retention.js";

const SESSION_ID = "01900000-0000-7000-8000-0000000000a1";
const POLICY = { settledGraceMilliseconds: 300_000, recoveryGraceMilliseconds: 900_000 };
const NOW = new Date("2026-08-04T10:00:00.000Z");

describe("retention grace", () => {
  it("deletes an abandoned session's documents immediately", () => {
    expect(retentionGraceMilliseconds("CANCELED", POLICY)).toBe(0);
    expect(retentionGraceMilliseconds("EXPIRED", POLICY)).toBe(0);
    expect(cleanupDueAt("CANCELED", NOW, POLICY)).toEqual(NOW);
  });

  it("gives a settled print a receipt window and an ambiguous one a review window", () => {
    expect(retentionGraceMilliseconds("COMPLETED", POLICY)).toBe(300_000);
    expect(retentionGraceMilliseconds("FAILED", POLICY)).toBe(300_000);
    expect(retentionGraceMilliseconds("RECOVERY_REQUIRED", POLICY)).toBe(900_000);
    expect(cleanupDueAt("RECOVERY_REQUIRED", NOW, POLICY).toISOString()).toBe(
      "2026-08-04T10:15:00.000Z"
    );
  });

  it("refuses a negative or non-integer policy", () => {
    expect(() =>
      retentionGraceMilliseconds("COMPLETED", {
        settledGraceMilliseconds: -1,
        recoveryGraceMilliseconds: 0
      })
    ).toThrow("RETENTION_POLICY_INVALID");
    expect(() =>
      retentionGraceMilliseconds("COMPLETED", {
        settledGraceMilliseconds: 1.5,
        recoveryGraceMilliseconds: 0
      })
    ).toThrow("RETENTION_POLICY_INVALID");
  });

  it("recognises only terminal session states", () => {
    expect(isTerminalSessionState("COMPLETED")).toBe(true);
    expect(isTerminalSessionState("RECOVERY_REQUIRED")).toBe(true);
    expect(isTerminalSessionState("AWAITING_PAYMENT")).toBe(false);
    expect(isTerminalSessionState("PRINTING")).toBe(false);
  });

  it("never schedules a live session's documents for deletion", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TerminalSessionState>(
          "COMPLETED",
          "CANCELED",
          "EXPIRED",
          "FAILED",
          "RECOVERY_REQUIRED"
        ),
        (state) => {
          expect(cleanupDueAt(state, NOW, POLICY).getTime()).toBeGreaterThanOrEqual(NOW.getTime());
        }
      )
    );
  });
});

describe("cleanup checkpoints", () => {
  it("revokes access before deleting and scrubs metadata last", () => {
    expect(CLEANUP_CHECKPOINTS).toEqual([
      "SCHEDULED",
      "ACCESS_REVOKED",
      "ARTIFACTS_DELETED",
      "STORAGE_RECONCILED",
      "METADATA_SCRUBBED",
      "COMPLETED"
    ]);
  });

  it("walks forwards and stops at the end", () => {
    let checkpoint: CleanupCheckpoint | null = "SCHEDULED";
    const visited: CleanupCheckpoint[] = [];
    while (checkpoint) {
      visited.push(checkpoint);
      checkpoint = nextCheckpoint(checkpoint);
    }
    expect(visited).toEqual([...CLEANUP_CHECKPOINTS]);
  });

  it("never lets a stale worker move a run backwards", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CLEANUP_CHECKPOINTS),
        fc.constantFrom(...CLEANUP_CHECKPOINTS),
        (current, candidate) => {
          const advanced = advanceCheckpoint(current, candidate);
          expect(checkpointRank(advanced)).toBeGreaterThanOrEqual(checkpointRank(current));
          expect(isCheckpointAtLeast(advanced, current)).toBe(true);
        }
      )
    );
  });
});

describe("cleanup retries", () => {
  it("backs off exponentially and stays inside the cap", () => {
    expect(cleanupRetryDelayMilliseconds(1, 0)).toBe(2_500);
    expect(cleanupRetryDelayMilliseconds(1, 1)).toBe(5_000);
    expect(cleanupRetryDelayMilliseconds(4, 1)).toBe(40_000);
  });

  it("stays finite and bounded for any attempt count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (attempts, jitter) => {
          const delay = cleanupRetryDelayMilliseconds(attempts, jitter);
          expect(Number.isFinite(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(CLEANUP_RETRY_MAX_MILLISECONDS / 2 / 2 ** 30);
          expect(delay).toBeLessThanOrEqual(CLEANUP_RETRY_MAX_MILLISECONDS);
        }
      )
    );
  });

  it("refuses an invalid attempt count or jitter", () => {
    expect(() => cleanupRetryDelayMilliseconds(0)).toThrow("RETENTION_ATTEMPTS_INVALID");
    expect(() => cleanupRetryDelayMilliseconds(1, 1.5)).toThrow("RETENTION_JITTER_INVALID");
    expect(() => cleanupRetryDelayMilliseconds(1, Number.NaN)).toThrow("RETENTION_JITTER_INVALID");
  });

  it("schedules the next attempt after now", () => {
    expect(nextCleanupAttemptAt(NOW, 1, 1).toISOString()).toBe("2026-08-04T10:00:05.000Z");
  });

  it("dead-letters only once the attempt budget is spent", () => {
    expect(isCleanupDeadLettered(4, 5)).toBe(false);
    expect(isCleanupDeadLettered(5, 5)).toBe(true);
    expect(() => isCleanupDeadLettered(1, 0)).toThrow("RETENTION_MAX_ATTEMPTS_INVALID");
  });
});

describe("session object prefixes", () => {
  it("covers every root a customer's bytes can reach", () => {
    expect(sessionObjectPrefixes(SESSION_ID)).toEqual([
      `quarantine/v1/${SESSION_ID}/`,
      `normalized/v1/${SESSION_ID}/`,
      `previews/v1/${SESSION_ID}/`
    ]);
  });

  it("refuses an identifier that would widen the sweep", () => {
    for (const candidate of ["", "..", "*", "all", `${SESSION_ID}/x`, `${SESSION_ID} `]) {
      expect(() => sessionObjectPrefixes(candidate)).toThrow("RETENTION_SESSION_ID_INVALID");
    }
  });

  it("reads the owning session back out of a key", () => {
    expect(sessionIdFromObjectKey(`quarantine/v1/${SESSION_ID}/file/token`)).toBe(SESSION_ID);
    expect(sessionIdFromObjectKey(`previews/v1/${SESSION_ID}/f/r1/g1/page-1.webp`)).toBe(
      SESSION_ID
    );
  });

  it("leaves a key it does not recognise alone", () => {
    expect(sessionIdFromObjectKey("other/v1/x/y")).toBeNull();
    expect(sessionIdFromObjectKey("quarantine/v1/not-a-session/file")).toBeNull();
    expect(sessionIdFromObjectKey("quarantine/v1/")).toBeNull();
  });

  it("round-trips every prefix it produces", () => {
    for (const prefix of sessionObjectPrefixes(SESSION_ID)) {
      expect(sessionIdFromObjectKey(`${prefix}object`)).toBe(SESSION_ID);
    }
  });
});
