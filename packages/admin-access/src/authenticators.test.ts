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

describe("authenticator quality policy", () => {
  it("accepts a platform authenticator for every role, Technical Admin included", () => {
    // The device-bound rule was retired when the password became the first
    // factor: a persistent platform authenticator as a second factor beats a
    // browser-lifetime virtual key that satisfied the letter of the old rule.
    expect(evaluateAuthenticatorPolicy("TECHNICAL_ADMIN", syncedPasskey)).toEqual({
      allowed: true
    });
    expect(evaluateAuthenticatorPolicy("ADMIN", syncedPasskey)).toEqual({ allowed: true });
    expect(evaluateAuthenticatorPolicy("OPERATOR", syncedPasskey)).toEqual({ allowed: true });
  });

  it("still accepts a roaming hardware key everywhere", () => {
    expect(evaluateAuthenticatorPolicy("TECHNICAL_ADMIN", hardwareKey)).toEqual({ allowed: true });
  });
});

describe("activation requires every factor the role signs in with", () => {
  it("requires one key for privileged roles and none for Operators", () => {
    expect(minimumAuthenticators("OPERATOR")).toBe(0);
    expect(minimumAuthenticators("ADMIN")).toBe(MINIMUM_PRIVILEGED_AUTHENTICATORS);
    expect(minimumAuthenticators("TECHNICAL_ADMIN")).toBe(MINIMUM_PRIVILEGED_AUTHENTICATORS);
  });

  it("refuses activation without a password, whatever the keys say", () => {
    expect(evaluateActivation("TECHNICAL_ADMIN", "PROVISIONING", 2, false)).toEqual({
      allowed: false,
      reason: "PASSWORD_NOT_SET",
      required: 1,
      present: 2
    });
    expect(evaluateActivation("OPERATOR", "PROVISIONING", 0, false).allowed).toBe(false);
  });

  it("refuses a privileged activation with a password but no key", () => {
    expect(evaluateActivation("TECHNICAL_ADMIN", "PROVISIONING", 0, true)).toEqual({
      allowed: false,
      reason: "NOT_ENOUGH_AUTHENTICATORS",
      required: 1,
      present: 0
    });
  });

  it("activates a privileged account with a password and one key", () => {
    expect(evaluateActivation("TECHNICAL_ADMIN", "PROVISIONING", 1, true)).toEqual({
      allowed: true
    });
    expect(evaluateActivation("ADMIN", "PROVISIONING", 1, true)).toEqual({ allowed: true });
  });

  it("activates an Operator with a password alone", () => {
    expect(evaluateActivation("OPERATOR", "PROVISIONING", 0, true)).toEqual({ allowed: true });
  });

  it("refuses to re-activate an account that is not provisioning", () => {
    expect(evaluateActivation("ADMIN", "ACTIVE", 5, true).allowed).toBe(false);
    expect(evaluateActivation("ADMIN", "DISABLED", 5, true).allowed).toBe(false);
  });
});

describe("revocation cannot strip a privileged account of its second factor", () => {
  it("refuses revoking the last usable key on an active privileged account", () => {
    expect(canRevokeAuthenticator("TECHNICAL_ADMIN", "ACTIVE", 1)).toBe(false);
    expect(canRevokeAuthenticator("ADMIN", "ACTIVE", 1)).toBe(false);
  });

  it("allows revocation once a replacement has been enrolled", () => {
    expect(canRevokeAuthenticator("TECHNICAL_ADMIN", "ACTIVE", 2)).toBe(true);
  });

  it("lets an Operator retire their only optional key", () => {
    expect(canRevokeAuthenticator("OPERATOR", "ACTIVE", 1)).toBe(true);
  });

  it("allows cleanup of a suspended or disabled account", () => {
    expect(canRevokeAuthenticator("ADMIN", "SUSPENDED", 1)).toBe(true);
    expect(canRevokeAuthenticator("ADMIN", "DISABLED", 1)).toBe(true);
  });
});
