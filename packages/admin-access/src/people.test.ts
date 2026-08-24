import { describe, expect, it } from "vitest";

import {
  ADMIN_STATUS_ACTIONS,
  changeAdminStatusBodySchema,
  evaluateStatusTransition,
  kioskAssignmentBodySchema,
  revokesSessions
} from "./people.js";

const ACTIVATED = new Date("2026-08-01T00:00:00.000Z");

describe("account status transitions", () => {
  it("never offers PROVISIONING as something a person can ask for", () => {
    // An account leaves PROVISIONING by enrolling keys. Nothing puts it back
    // into the one state where it holds fewer than its role requires.
    expect(ADMIN_STATUS_ACTIONS).toEqual(["SUSPENDED", "ACTIVE", "DISABLED"]);
    expect(ADMIN_STATUS_ACTIONS as readonly string[]).not.toContain("PROVISIONING");
  });

  it("suspends and resumes an active account", () => {
    expect(evaluateStatusTransition("ACTIVE", "SUSPENDED", ACTIVATED)).toEqual({ allowed: true });
    expect(evaluateStatusTransition("SUSPENDED", "ACTIVE", ACTIVATED)).toEqual({ allowed: true });
  });

  it("treats DISABLED as terminal", () => {
    for (const requested of ADMIN_STATUS_ACTIONS) {
      const result = evaluateStatusTransition("DISABLED", requested, ACTIVATED);
      expect(result.allowed).toBe(false);
    }
    expect(evaluateStatusTransition("DISABLED", "ACTIVE", ACTIVATED)).toEqual({
      allowed: false,
      reason: "TRANSITION_NOT_PERMITTED"
    });
  });

  it("lets a provisioning account be abandoned but never resumed into ACTIVE", () => {
    expect(evaluateStatusTransition("PROVISIONING", "DISABLED", null)).toEqual({ allowed: true });
    expect(evaluateStatusTransition("PROVISIONING", "ACTIVE", null)).toEqual({
      allowed: false,
      reason: "TRANSITION_NOT_PERMITTED"
    });
    expect(evaluateStatusTransition("PROVISIONING", "SUSPENDED", null)).toEqual({
      allowed: false,
      reason: "TRANSITION_NOT_PERMITTED"
    });
  });

  it("refuses to resume an account that never completed activation", () => {
    expect(evaluateStatusTransition("SUSPENDED", "ACTIVE", null)).toEqual({
      allowed: false,
      reason: "NEVER_ACTIVATED"
    });
  });

  it("reports a no-op rather than pretending something changed", () => {
    expect(evaluateStatusTransition("ACTIVE", "ACTIVE", ACTIVATED)).toEqual({
      allowed: false,
      reason: "ALREADY_IN_STATE"
    });
  });

  it("ends every session except when access is being given back", () => {
    expect(revokesSessions("SUSPENDED")).toBe(true);
    expect(revokesSessions("DISABLED")).toBe(true);
    expect(revokesSessions("ACTIVE")).toBe(false);
  });
});

describe("request bodies", () => {
  it("requires a real reason for a status change", () => {
    expect(changeAdminStatusBodySchema.safeParse({ status: "SUSPENDED" }).success).toBe(false);
    expect(
      changeAdminStatusBodySchema.safeParse({ status: "SUSPENDED", reason: "nope" }).success
    ).toBe(false);
    expect(
      changeAdminStatusBodySchema.safeParse({
        status: "SUSPENDED",
        reason: "Left the company on Friday."
      }).success
    ).toBe(true);
  });

  it("refuses a status change that names a role", () => {
    // Nothing in the control plane promotes anybody, and the strict object is
    // what makes an extra field a rejection rather than a silently ignored one.
    const result = changeAdminStatusBodySchema.safeParse({
      status: "ACTIVE",
      reason: "Back from leave this morning.",
      role: "ADMIN"
    });
    expect(result.success).toBe(false);
  });

  it("bounds a kiosk id to this system's own identifier shape", () => {
    expect(
      kioskAssignmentBodySchema.safeParse({
        kioskId: "kiosk-central-01",
        granted: true,
        reason: "Covering the central branch from Monday."
      }).success
    ).toBe(true);
    expect(
      kioskAssignmentBodySchema.safeParse({
        kioskId: "kiosk 01; drop",
        granted: true,
        reason: "Covering the central branch from Monday."
      }).success
    ).toBe(false);
  });
});
