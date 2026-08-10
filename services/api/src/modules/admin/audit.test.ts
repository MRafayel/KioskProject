import { describe, expect, it } from "vitest";

import { sanitizeMetadata } from "./audit.js";

describe("admin audit metadata privacy boundary", () => {
  it("drops unexpected sensitive keys and bounds every allowed string", () => {
    const oversized = "x".repeat(300);
    const result = sanitizeMetadata({
      role: oversized,
      reason: oversized,
      filename: "customer-passport.pdf",
      documentId: "00000000-0000-7000-8000-000000000099",
      errorMessage: "upstream included a bearer token",
      secret: "do-not-store",
      paymentData: "4111111111111111"
    });

    expect(result).toEqual({ role: "x".repeat(200), reason: "x".repeat(200) });
    expect(JSON.stringify(result)).not.toContain("customer-passport");
    expect(JSON.stringify(result)).not.toContain("bearer token");
    expect(JSON.stringify(result)).not.toContain("4111111111111111");
  });
});
