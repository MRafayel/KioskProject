import { describe, expect, it } from "vitest";

import { revokeAuthenticatorBodySchema, verifyRegistrationBodySchema } from "./contracts.js";

const credential = {
  id: "credential-id",
  rawId: "credential-id",
  type: "public-key" as const,
  response: {}
};

describe("admin mutation input normalization", () => {
  it("trims authenticator labels before they reach storage and audit", () => {
    expect(
      verifyRegistrationBodySchema.parse({
        ceremonyId: "00000000-0000-4000-8000-000000000001",
        credential,
        label: "  safe A  "
      }).label
    ).toBe("safe A");
  });

  it("rejects labels that contain only whitespace", () => {
    expect(() =>
      verifyRegistrationBodySchema.parse({
        ceremonyId: "00000000-0000-4000-8000-000000000001",
        credential,
        label: "   "
      })
    ).toThrow();
  });

  it("trims revocation reasons and rejects whitespace-only explanations", () => {
    expect(revokeAuthenticatorBodySchema.parse({ reason: "  key lost  " }).reason).toBe("key lost");
    expect(() => revokeAuthenticatorBodySchema.parse({ reason: "   " })).toThrow();
  });
});
