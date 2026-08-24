import { describe, expect, it } from "vitest";

import { canPerform, evaluateSession, hasFreshStepUp, nextIdleExpiry } from "./sessions.js";

const now = new Date("2026-08-10T12:00:00.000Z");
const STEP_UP_TTL = 5 * 60_000;

function session(overrides: Partial<Parameters<typeof evaluateSession>[0]> = {}) {
  return {
    idleExpiresAt: new Date(now.getTime() + 60_000),
    hardExpiresAt: new Date(now.getTime() + 3_600_000),
    revokedAt: null,
    lastStepUpAt: null,
    ...overrides
  };
}

describe("session validity", () => {
  it("accepts a live session", () => {
    expect(evaluateSession(session(), now)).toEqual({ state: "ACTIVE" });
  });

  it("rejects a revoked session immediately", () => {
    expect(evaluateSession(session({ revokedAt: new Date(now.getTime() - 1) }), now)).toEqual({
      state: "INVALID",
      reason: "REVOKED"
    });
  });

  it("locks — not destroys — an idle-expired session", () => {
    expect(evaluateSession(session({ idleExpiresAt: new Date(now.getTime() - 1) }), now)).toEqual({
      state: "LOCKED"
    });
  });

  it("rejects a session past its absolute limit even if recently used", () => {
    expect(
      evaluateSession(
        session({
          idleExpiresAt: new Date(now.getTime() + 60_000),
          hardExpiresAt: new Date(now.getTime() - 1)
        }),
        now
      )
    ).toEqual({ state: "INVALID", reason: "ABSOLUTE_EXPIRED" });
  });

  it("reports the absolute limit when both windows have closed", () => {
    // A locked session past its hard limit is gone: the unlock ceremony must
    // not be offered for a session no reauthentication can save.
    expect(
      evaluateSession(
        session({
          idleExpiresAt: new Date(now.getTime() - 10_000),
          hardExpiresAt: new Date(now.getTime() - 1)
        }),
        now
      )
    ).toEqual({ state: "INVALID", reason: "ABSOLUTE_EXPIRED" });
  });

  it("treats the idle expiry instant as locked", () => {
    expect(evaluateSession(session({ idleExpiresAt: now }), now)).toEqual({ state: "LOCKED" });
  });

  it("revocation beats the lock: a revoked idle session is invalid", () => {
    expect(
      evaluateSession(session({ revokedAt: now, idleExpiresAt: new Date(now.getTime() - 1) }), now)
    ).toEqual({ state: "INVALID", reason: "REVOKED" });
  });
});

describe("step-up freshness", () => {
  it("is false when the session has never stepped up", () => {
    expect(hasFreshStepUp(session(), now, STEP_UP_TTL)).toBe(false);
  });

  it("is true within the window", () => {
    const recent = session({ lastStepUpAt: new Date(now.getTime() - 60_000) });
    expect(hasFreshStepUp(recent, now, STEP_UP_TTL)).toBe(true);
  });

  it("is false once the window has passed", () => {
    const stale = session({ lastStepUpAt: new Date(now.getTime() - STEP_UP_TTL) });
    expect(hasFreshStepUp(stale, now, STEP_UP_TTL)).toBe(false);
  });

  it("fails closed when the recorded assertion is in the future", () => {
    const future = session({ lastStepUpAt: new Date(now.getTime() + 1) });
    expect(hasFreshStepUp(future, now, STEP_UP_TTL)).toBe(false);
  });

  it("rejects a nonsensical window rather than defaulting to permissive", () => {
    expect(() => hasFreshStepUp(session(), now, -1)).toThrow("ADMIN_STEP_UP_TTL_INVALID");
    expect(() => hasFreshStepUp(session(), now, 1.5)).toThrow("ADMIN_STEP_UP_TTL_INVALID");
  });
});

describe("what a session may perform", () => {
  it("allows R0 and R1 on a live session without step-up", () => {
    expect(canPerform(session(), "R0", now, STEP_UP_TTL)).toBe(true);
    expect(canPerform(session(), "R1", now, STEP_UP_TTL)).toBe(true);
  });

  it("refuses R2 without a fresh assertion", () => {
    expect(canPerform(session(), "R2", now, STEP_UP_TTL)).toBe(false);
  });

  it("allows R2 with a fresh assertion", () => {
    const stepped = session({ lastStepUpAt: new Date(now.getTime() - 1_000) });
    expect(canPerform(stepped, "R2", now, STEP_UP_TTL)).toBe(true);
  });

  it("refuses R2 once the assertion has gone stale", () => {
    const stale = session({ lastStepUpAt: new Date(now.getTime() - STEP_UP_TTL - 1) });
    expect(canPerform(stale, "R2", now, STEP_UP_TTL)).toBe(false);
  });

  it("never authorises R3 from a session alone, however fresh", () => {
    // R3 needs a second Technical Admin and an Admin. No single request can
    // prove that, so this must stay false even for a just-asserted session.
    const stepped = session({ lastStepUpAt: now });
    expect(canPerform(stepped, "R3", now, STEP_UP_TTL)).toBe(false);
  });

  it("refuses everything on a revoked session, including R0", () => {
    const revoked = session({ revokedAt: now, lastStepUpAt: now });
    for (const risk of ["R0", "R1", "R2", "R3"] as const) {
      expect(canPerform(revoked, risk, now, STEP_UP_TTL)).toBe(false);
    }
  });

  it("refuses everything on a locked session: unlocking is the only way on", () => {
    const locked = session({
      idleExpiresAt: new Date(now.getTime() - 1),
      lastStepUpAt: now
    });
    for (const risk of ["R0", "R1", "R2", "R3"] as const) {
      expect(canPerform(locked, risk, now, STEP_UP_TTL)).toBe(false);
    }
  });
});

describe("idle window", () => {
  it("rolls forward from now", () => {
    expect(nextIdleExpiry(now, 60_000)).toEqual(new Date(now.getTime() + 60_000));
  });

  it("rejects an invalid window", () => {
    expect(() => nextIdleExpiry(now, 0)).toThrow("ADMIN_SESSION_IDLE_TTL_INVALID");
  });
});
