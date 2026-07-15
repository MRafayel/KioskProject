import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  SESSION_STATES,
  canTransitionSession,
  isSessionExpired,
  transitionSession,
  type SessionDomainError,
  type SessionState
} from "./session.js";

describe("session state machine", () => {
  it("implements the guarded transition table", () => {
    expect(canTransitionSession("CREATED", "WAITING_FOR_UPLOAD")).toBe(true);
    expect(canTransitionSession("WAITING_FOR_UPLOAD", "PAID")).toBe(false);
    expect(canTransitionSession("COMPLETED", "PRINTING")).toBe(false);
  });

  it("rejects stale versions before evaluating the transition", () => {
    expect(() =>
      transitionSession({ state: "WAITING_FOR_UPLOAD", version: 4 }, "CANCELED", 3)
    ).toThrowError(
      expect.objectContaining<Partial<SessionDomainError>>({ code: "STALE_SESSION_VERSION" })
    );
  });

  it("increments every allowed transition exactly once", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SessionState>(...SESSION_STATES),
        fc.integer({ min: 1, max: 1_000_000 }),
        (state, version) => {
          const target = SESSION_STATES.find((candidate) => canTransitionSession(state, candidate));
          if (!target) return;

          expect(transitionSession({ state, version }, target, version)).toEqual({
            state: target,
            version: version + 1
          });
        }
      )
    );
  });

  it("treats the exact expiry boundary as expired", () => {
    const expiry = new Date("2030-01-01T00:02:00.000Z");
    const hardExpiry = new Date("2030-01-01T00:30:00.000Z");

    expect(isSessionExpired(new Date("2030-01-01T00:01:59.999Z"), expiry, hardExpiry)).toBe(false);
    expect(isSessionExpired(expiry, expiry, hardExpiry)).toBe(true);
  });
});
