import { describe, expect, it } from "vitest";

import {
  MINIMUM_PRIVILEGED_AUTHENTICATORS,
  canAuthenticate,
  canRevokeAuthenticator,
  evaluateActivation,
  evaluateAuthenticatorPolicy,
  isAdminUserStatus,
  minimumAuthenticators,
  type AuthenticatorProperties
} from "./authenticators.js";

const hardwareKey: AuthenticatorProperties = {
  attachment: "cross-platform",
  backupEligible: false,
  backedUp: false
};

const syncedPasskey: AuthenticatorProperties = {
  attachment: "platform",
  backupEligible: true,
  backedUp: true
};

describe("account status", () => {
  it("only lets an ACTIVE account authenticate", () => {
    expect(canAuthenticate("ACTIVE")).toBe(true);
    expect(canAuthenticate("PROVISIONING")).toBe(false);
    expect(canAuthenticate("SUSPENDED")).toBe(false);
    expect(canAuthenticate("DISABLED")).toBe(false);
  });

  it("recognises only declared statuses", () => {
    expect(isAdminUserStatus("ACTIVE")).toBe(true);
    expect(isAdminUserStatus("active")).toBe(false);
    expect(isAdminUserStatus("ENABLED")).toBe(false);
  });
});

describe("device-bound requirement for Technical Admins", () => {
  it("accepts a roaming hardware key", () => {
    expect(evaluateAuthenticatorPolicy("TECHNICAL_ADMIN", hardwareKey)).toEqual({ allowed: true });
  });

  it("refuses a synchronised passkey", () => {
    expect(evaluateAuthenticatorPolicy("TECHNICAL_ADMIN", syncedPasskey)).toEqual({
      allowed: false,
      reason: "BACKUP_ELIGIBLE_NOT_ALLOWED"
    });
  });

  it("refuses a credential that is merely eligible for backup, even if not yet synced", () => {
    // Eligibility is what matters: the credential can leave the device later.
    expect(
      evaluateAuthenticatorPolicy("TECHNICAL_ADMIN", {
        attachment: "cross-platform",
        backupEligible: true,
        backedUp: false
      })
    ).toEqual({ allowed: false, reason: "BACKUP_ELIGIBLE_NOT_ALLOWED" });
  });

  it("refuses a platform authenticator", () => {
    expect(
      evaluateAuthenticatorPolicy("TECHNICAL_ADMIN", {
        attachment: "platform",
        backupEligible: false,
        backedUp: false
      })
    ).toEqual({ allowed: false, reason: "CROSS_PLATFORM_REQUIRED" });
  });

  it("refuses an authenticator that declined to identify its attachment", () => {
    expect(
      evaluateAuthenticatorPolicy("TECHNICAL_ADMIN", {
        attachment: null,
        backupEligible: false,
        backedUp: false
      })
    ).toEqual({ allowed: false, reason: "CROSS_PLATFORM_REQUIRED" });
  });

  it("allows Admin and Operator to use a platform authenticator", () => {
    expect(evaluateAuthenticatorPolicy("ADMIN", syncedPasskey)).toEqual({ allowed: true });
    expect(evaluateAuthenticatorPolicy("OPERATOR", syncedPasskey)).toEqual({ allowed: true });
  });
});

describe("activation requires a spare authenticator", () => {
  it("requires two for every role", () => {
    expect(minimumAuthenticators("OPERATOR")).toBe(2);
    expect(minimumAuthenticators("ADMIN")).toBe(MINIMUM_PRIVILEGED_AUTHENTICATORS);
    expect(minimumAuthenticators("TECHNICAL_ADMIN")).toBe(MINIMUM_PRIVILEGED_AUTHENTICATORS);
  });

  it("refuses activation with a single authenticator", () => {
    expect(evaluateActivation("TECHNICAL_ADMIN", "PROVISIONING", 1)).toEqual({
      allowed: false,
      reason: "NOT_ENOUGH_AUTHENTICATORS",
      required: 2,
      present: 1
    });
  });

  it("allows activation once the minimum is enrolled", () => {
    expect(evaluateActivation("TECHNICAL_ADMIN", "PROVISIONING", 2)).toEqual({ allowed: true });
  });

  it("refuses to re-activate an account that is not provisioning", () => {
    expect(evaluateActivation("ADMIN", "ACTIVE", 5).allowed).toBe(false);
    expect(evaluateActivation("ADMIN", "DISABLED", 5).allowed).toBe(false);
  });
});

describe("revocation cannot lock an operator out", () => {
  it("refuses a revocation that would take an active account below the minimum", () => {
    expect(canRevokeAuthenticator("TECHNICAL_ADMIN", "ACTIVE", 2)).toBe(false);
  });

  it("allows revocation once a replacement has been enrolled", () => {
    expect(canRevokeAuthenticator("TECHNICAL_ADMIN", "ACTIVE", 3)).toBe(true);
  });

  it("allows cleanup of a suspended or disabled account", () => {
    expect(canRevokeAuthenticator("ADMIN", "SUSPENDED", 2)).toBe(true);
    expect(canRevokeAuthenticator("ADMIN", "DISABLED", 1)).toBe(true);
  });
});
