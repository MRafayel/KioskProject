import { describe, expect, it } from "vitest";

import {
  invitableRoles,
  mayInviteRole,
  mayResetPassword,
  passwordSchema,
  requiresWebAuthn,
  strongAuthMethodForRole,
  usernameSchema,
  webAuthnPolicyMatchesPrivilege
} from "./authentication.js";
import { ADMIN_ROLES } from "./capabilities.js";

describe("which roles need a security key", () => {
  it("requires WebAuthn for both privileged roles and not for Operators", () => {
    expect(requiresWebAuthn("OPERATOR")).toBe(false);
    expect(requiresWebAuthn("ADMIN")).toBe(true);
    expect(requiresWebAuthn("TECHNICAL_ADMIN")).toBe(true);
  });

  it("pins the WebAuthn list to the privileged list until somebody decides otherwise", () => {
    for (const role of ADMIN_ROLES) {
      expect(webAuthnPolicyMatchesPrivilege(role)).toBe(true);
    }
  });

  it("keys strong reauthentication to the factor the role actually holds", () => {
    expect(strongAuthMethodForRole("OPERATOR")).toBe("PASSWORD");
    expect(strongAuthMethodForRole("ADMIN")).toBe("WEBAUTHN");
    expect(strongAuthMethodForRole("TECHNICAL_ADMIN")).toBe("WEBAUTHN");
  });
});

describe("who may invite whom", () => {
  it("lets an Admin invite Operators and nothing above", () => {
    expect(mayInviteRole("ADMIN", "OPERATOR")).toBe(true);
    expect(mayInviteRole("ADMIN", "ADMIN")).toBe(false);
    expect(mayInviteRole("ADMIN", "TECHNICAL_ADMIN")).toBe(false);
  });

  it("lets only a Technical Admin mint privileged accounts", () => {
    expect(mayInviteRole("TECHNICAL_ADMIN", "OPERATOR")).toBe(true);
    expect(mayInviteRole("TECHNICAL_ADMIN", "ADMIN")).toBe(true);
    expect(mayInviteRole("TECHNICAL_ADMIN", "TECHNICAL_ADMIN")).toBe(true);
  });

  it("lets an Operator invite nobody", () => {
    for (const role of ADMIN_ROLES) {
      expect(mayInviteRole("OPERATOR", role)).toBe(false);
    }
    expect(invitableRoles("OPERATOR")).toEqual([]);
  });
});

describe("who may reset whose password", () => {
  it("follows the invitation asymmetry but never reaches a Technical Admin", () => {
    expect(mayResetPassword("ADMIN", "OPERATOR")).toBe(true);
    expect(mayResetPassword("ADMIN", "ADMIN")).toBe(false);
    expect(mayResetPassword("ADMIN", "TECHNICAL_ADMIN")).toBe(false);
    expect(mayResetPassword("TECHNICAL_ADMIN", "OPERATOR")).toBe(true);
    expect(mayResetPassword("TECHNICAL_ADMIN", "ADMIN")).toBe(true);
    // A Technical Admin's password is reset from the CLI or not at all: the
    // accounts that could authorise it from a browser are the ones an attacker
    // would be holding.
    expect(mayResetPassword("TECHNICAL_ADMIN", "TECHNICAL_ADMIN")).toBe(false);
  });

  it("lets an Operator reset nobody", () => {
    for (const role of ADMIN_ROLES) {
      expect(mayResetPassword("OPERATOR", role)).toBe(false);
    }
  });
});

describe("username shape", () => {
  it("lowercases and accepts ordinary handles", () => {
    expect(usernameSchema.parse("  Raf  ")).toBe("raf");
    expect(usernameSchema.parse("ada.lovelace")).toBe("ada.lovelace");
    expect(usernameSchema.parse("op-7")).toBe("op-7");
  });

  it("refuses spaces, leading punctuation and over-long names", () => {
    expect(usernameSchema.safeParse("a b").success).toBe(false);
    expect(usernameSchema.safeParse(".ada").success).toBe(false);
    expect(usernameSchema.safeParse("ab").success).toBe(false);
    expect(usernameSchema.safeParse("x".repeat(33)).success).toBe(false);
  });
});

describe("password shape", () => {
  it("enforces length as the only rule", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("a".repeat(12)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(129)).success).toBe(false);
  });
});
